/**
 * The single `<db>.telemetry` SQLite home for everything observable — logs,
 * analytics events, spans, trace summaries, error groups and rollups. The
 * application database never carries telemetry, so an application backup never
 * drags it and telemetry loss is never business-data loss (ADR-0017).
 *
 * **One connection, many kinds.** Every kind registers against the connection
 * this store owns rather than opening its own handle: two WAL writers on one
 * file would contend on locks and, worse, would make the disk budget below
 * unaccountable — three per-kind caps each guessing at a share of one disk
 * cannot in aggregate bound that disk.
 *
 * **The budget is a property of the store.** `maxStoredBytes` bounds the
 * sidecar's database, sampled from the open connection as `page_count *
 * page_size` — a header read, free enough to take on the write path. That is
 * the logical size, which is what eviction shrinks and what a checkpoint writes
 * out; the write-ahead log is bounded separately by `journal_size_limit` and
 * SQLite's own auto-checkpoint rather than added to this number, because before
 * a checkpoint the same pages are counted in both and a budget that
 * double-counts is not a measurement. Over budget, maintenance escalates from
 * expiring what the clocks say is old to evicting oldest-first, shortest clock
 * first — so runaway logging spends the space of the data that matters least.
 * `auto_vacuum = INCREMENTAL` is what makes eviction actually return pages:
 * deleting rows alone only lengthens the freelist, and a budget measured
 * against a size that never falls is not a budget. A sidecar that cannot
 * provide it is discarded and recreated.
 *
 * **Maintenance is bounded and lives on the write path.** Each pass expires a
 * bounded number of rows, round-robining the budget across registered sets so
 * one hot kind cannot starve the others. No timers, no background sweeps, zero
 * idle cost.
 *
 * **Failure is a property of the store too.** One kind's write failing is an
 * accounted drop; only a shared connection that cannot answer a probe makes the
 * runtime unhealthy. That is decided by evidence — the probe — rather than by
 * matching driver error strings.
 */
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import {
  resolveTelemetryRetention,
  TELEMETRY_RETENTION_CLASSES,
  type TelemetryRetentionClass,
  type TelemetryRetentionTtls,
} from "./retention.ts";

/**
 * The shape every kind's DDL adds up to. A sidecar stamped with a different
 * version is discarded and recreated rather than altered: the file is
 * framework-owned, excluded from backup and restore, and holds only disposable
 * telemetry, so migrating it would buy nothing and cost a compatibility path.
 * Bump this in the same change that changes any stored telemetry shape.
 */
export const TELEMETRY_STORE_SCHEMA_VERSION = 1;

/**
 * One deletable slice of a stored kind, bound to the clock its rows expire on.
 * `deleteExpired` deletes at most `limit` rows whose timestamp is strictly
 * older than `cutoffMs`, oldest first and through an index, and reports how
 * many it removed. Oldest-first eviction is the same call with a cutoff in the
 * far future, which is why the disk guard needs no second entry point.
 */
export interface TelemetryExpirableSet {
  readonly retention: TelemetryRetentionClass;
  deleteExpired(cutoffMs: number, limit: number): number;
}

/**
 * A kind of observable data homed in the telemetry store. `initialize` runs
 * idempotent DDL for the kind's tables and timestamp indexes on the shared
 * connection and returns the sets maintenance visits. A kind whose rows never
 * expire (error groups) returns none.
 */
export interface TelemetryStoredKind {
  readonly name: string;
  initialize(database: Database): readonly TelemetryExpirableSet[];
}

export interface TelemetryStoreLimits {
  /** Bound on rows one maintenance pass expires by the clocks. */
  readonly maxExpiredRowsPerPass: number;
  /**
   * The hard disk guard over the `<db>.telemetry` database. It is a convergence
   * target, not an instantaneous ceiling: a burst may cross it and the next
   * passes evict back under.
   */
  readonly maxStoredBytes: number;
  /**
   * Maintenance passes between two size samples while the store is comfortably
   * under budget. Over budget, every pass samples — the loop must terminate on
   * measurement, not on hope.
   */
  readonly bytesSampleInterval: number;
}

export interface TelemetryStoreOptions {
  readonly path: string;
  readonly retention?: Readonly<Record<string, number>>;
  readonly limits?: Partial<TelemetryStoreLimits>;
  readonly now?: () => number;
}

export interface TelemetryStoreSnapshot {
  readonly state: "ready" | "failed" | "stopped";
  readonly path: string;
  readonly retention: TelemetryRetentionTtls;
  readonly maxStoredBytes: number;
  /** The sidecar database's logical size, as of the last sample. */
  readonly storedBytes: number;
  readonly overBudget: boolean;
  readonly expiredRecords: Readonly<Record<TelemetryRetentionClass, number>>;
  readonly evictedRecords: Readonly<Record<TelemetryRetentionClass, number>>;
  /** Failures a probe proved the connection survived — contained to one kind. */
  readonly containedFailures: number;
  readonly failure?: unknown;
}

const DEFAULT_LIMITS: TelemetryStoreLimits = Object.freeze({
  maxExpiredRowsPerPass: 256,
  maxStoredBytes: 512 * 1_024 * 1_024,
  bytesSampleInterval: 64,
});

/**
 * How far a pass may escalate its eviction budget while the store stays over
 * its byte budget. Rows are individually bounded but not equal, so evicting a
 * fixed row count per pass converges slowly when the rows being evicted are
 * much smaller than the rows being written; doubling per consecutive
 * over-budget pass makes convergence a property rather than a hope, and the cap
 * keeps any single pass finite.
 */
const MAX_EVICTION_ESCALATION = 6;

/** Pages one incremental vacuum returns to the filesystem per eviction round. */
const VACUUM_PAGES_PER_ROUND = 1_024;

/**
 * What a checkpointed write-ahead log is truncated back to. SQLite's own
 * auto-checkpoint keeps the live log near a thousand pages, so this is the bound
 * on the high-water mark a burst leaves behind rather than on ordinary use.
 */
const WAL_BYTES_LIMIT = 32 * 1_024 * 1_024;

/** A cutoff every stored row is older than: eviction is expiry with no clock. */
const EVICT_EVERYTHING_CUTOFF = Number.MAX_SAFE_INTEGER;

/** Guard for the storage substrate's limit and budget options. */
export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export class TelemetryStore {
  readonly path: string;
  readonly database: Database;
  readonly retention: TelemetryRetentionTtls;
  readonly limits: TelemetryStoreLimits;
  private readonly now: () => number;
  private readonly kinds = new Set<string>();
  /** Round-robin order for expiry; the cursor below walks it. */
  private readonly sets: TelemetryExpirableSet[] = [];
  /** Eviction order: shortest clock first, so the least durable data goes first. */
  private evictionOrder: TelemetryExpirableSet[] = [];
  private readonly expiredRecords: Record<TelemetryRetentionClass, number>;
  private readonly evictedRecords: Record<TelemetryRetentionClass, number>;
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private cursor = 0;
  private passes = 0;
  private storedBytes = 0;
  private overBudgetPasses = 0;
  private containedFailures = 0;
  /** The last failure already judged; the same throw reaching two frames is one event. */
  private lastObserved: unknown;
  private state: TelemetryStoreSnapshot["state"] = "ready";
  private failure: unknown;

  constructor(options: TelemetryStoreOptions) {
    this.path = options.path;
    this.retention = resolveTelemetryRetention(options.retention);
    this.limits = Object.freeze({
      maxExpiredRowsPerPass: positiveInteger(
        options.limits?.maxExpiredRowsPerPass ?? DEFAULT_LIMITS.maxExpiredRowsPerPass,
        "telemetry store maxExpiredRowsPerPass",
      ),
      maxStoredBytes: positiveInteger(
        options.limits?.maxStoredBytes ?? DEFAULT_LIMITS.maxStoredBytes,
        "telemetry store maxStoredBytes",
      ),
      bytesSampleInterval: positiveInteger(
        options.limits?.bytesSampleInterval ?? DEFAULT_LIMITS.bytesSampleInterval,
        "telemetry store bytesSampleInterval",
      ),
    });
    this.now = options.now ?? Date.now;
    const expired = {} as Record<TelemetryRetentionClass, number>;
    const evicted = {} as Record<TelemetryRetentionClass, number>;
    for (const retentionClass of TELEMETRY_RETENTION_CLASSES) {
      expired[retentionClass] = 0;
      evicted[retentionClass] = 0;
    }
    this.expiredRecords = expired;
    this.evictedRecords = evicted;
    this.database = openSidecar(this.path, this.limits.maxStoredBytes);
    this.sampleStoredBytes();
  }

  register(kind: TelemetryStoredKind): void {
    if (this.kinds.has(kind.name)) {
      throw new TypeError(`telemetry kind "${kind.name}" is already registered`);
    }
    const sets = kind.initialize(this.database);
    for (const set of sets) {
      if (this.retention[set.retention] === undefined) {
        throw new TypeError(
          `telemetry kind "${kind.name}" expires on unknown retention class ${
            JSON.stringify(set.retention)
          }`,
        );
      }
    }
    this.kinds.add(kind.name);
    this.sets.push(...sets);
    this.evictionOrder = [...this.sets].sort(
      (left, right) => this.retention[left.retention] - this.retention[right.retention],
    );
  }

  /**
   * One bounded write-path pass, run inside the caller's transaction so its
   * deletions are durable with the writes that provoked them. Expires by the
   * clocks first, then — only while the sidecar is over its byte budget —
   * evicts oldest-first from the shortest clock outward. Returns the rows it
   * removed.
   */
  maintain(nowMs = this.now()): number {
    if (this.sets.length === 0) return 0;
    let removed = 0;
    let remaining = this.limits.maxExpiredRowsPerPass;
    for (let probes = 0; probes < this.sets.length && remaining > 0; probes++) {
      const set = this.sets[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.sets.length;
      const deleted = set.deleteExpired(nowMs - this.retention[set.retention], remaining);
      remaining -= deleted;
      removed += deleted;
      this.expiredRecords[set.retention] += deleted;
    }
    this.passes++;
    // Sampling is a header read plus one stat; spending it every pass would be
    // pure overhead while the store sits comfortably under budget, and skipping
    // it while over budget would let the eviction loop run on a stale number.
    if (this.overBudgetPasses > 0 || this.passes % this.limits.bytesSampleInterval === 0) {
      this.sampleStoredBytes();
    }
    if (this.storedBytes <= this.limits.maxStoredBytes) {
      this.overBudgetPasses = 0;
      return removed;
    }
    const budget = this.limits.maxExpiredRowsPerPass *
      2 ** Math.min(this.overBudgetPasses, MAX_EVICTION_ESCALATION);
    this.overBudgetPasses++;
    return removed + this.evict(budget);
  }

  /** Oldest-first across every clock, shortest clock first, up to `budget` rows. */
  private evict(budget: number): number {
    let evicted = 0;
    for (const set of this.evictionOrder) {
      while (evicted < budget && this.storedBytes > this.limits.maxStoredBytes) {
        const chunk = Math.min(budget - evicted, this.limits.maxExpiredRowsPerPass);
        const deleted = set.deleteExpired(EVICT_EVERYTHING_CUTOFF, chunk);
        if (deleted === 0) break;
        evicted += deleted;
        this.evictedRecords[set.retention] += deleted;
        // Deleting rows only lengthens the freelist; returning those pages is
        // what makes the next sample tell the truth about the file on disk.
        this.database.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES_PER_ROUND})`);
        this.sampleStoredBytes();
      }
      if (evicted >= budget || this.storedBytes <= this.limits.maxStoredBytes) break;
    }
    return evicted;
  }

  private sampleStoredBytes(): void {
    const page = this.database.query(
      "SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS bytes",
    ).get() as { readonly bytes: bigint | number };
    this.storedBytes = Number(page.bytes);
  }

  /**
   * A kind reports an operation that failed. The connection is probed: if it
   * still answers, the loss belongs to that kind, is an accounted drop, and this
   * returns true so the kind stays open. If the probe throws, the shared
   * connection is unusable — every kind is finished, the runtime is unhealthy,
   * and this returns false.
   *
   * Classification is by evidence rather than by matching driver error text: a
   * constraint violation and a full disk arrive as the same kind of exception,
   * and only one of them means the file is gone. One throw observed by two
   * frames is one event, so the same error object is judged once.
   */
  observeFailure(error: unknown): boolean {
    if (this.state !== "ready") return false;
    const repeat = error !== undefined && error === this.lastObserved;
    this.lastObserved = error;
    if (!repeat) this.containedFailures++;
    try {
      this.database.query("SELECT 1").get();
      return true;
    } catch (probeError) {
      if (!repeat) this.containedFailures--;
      this.markFailed(probeError ?? error);
      return false;
    }
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  /** Fires once, when the shared connection is proven unusable. */
  onFailure(listener: (error: unknown) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  private markFailed(error: unknown): void {
    if (this.state !== "ready") return;
    this.failure = error;
    this.state = "failed";
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch {
        // A health observer cannot replace the store's original failure.
      }
    }
  }

  snapshot(): TelemetryStoreSnapshot {
    return Object.freeze({
      state: this.state,
      path: this.path,
      retention: this.retention,
      maxStoredBytes: this.limits.maxStoredBytes,
      storedBytes: this.storedBytes,
      overBudget: this.storedBytes > this.limits.maxStoredBytes,
      expiredRecords: Object.freeze({ ...this.expiredRecords }),
      evictedRecords: Object.freeze({ ...this.evictedRecords }),
      containedFailures: this.containedFailures,
      ...(this.failure === undefined ? {} : { failure: this.failure }),
    });
  }

  close(): void {
    if (this.state === "stopped") return;
    if (this.state === "ready") this.state = "stopped";
    this.database.close(false);
  }
}

/**
 * Open the sidecar in the exact shape this version stores. A file stamped with
 * another version — or one whose auto-vacuum mode cannot return evicted bytes —
 * is deleted and recreated rather than migrated: it is framework-owned, outside
 * backup and restore, and every row in it is disposable diagnostic data.
 */
function openSidecar(path: string, maxStoredBytes: number): Database {
  let database = new Database(path, { create: true, safeIntegers: true, strict: true });
  if (path !== ":memory:" && !storedShapeIsCurrent(database)) {
    database.close(false);
    for (const artifact of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      rmSync(artifact, { force: true });
    }
    database = new Database(path, { create: true, safeIntegers: true, strict: true });
  }
  // Both pragmas must precede the first table: auto-vacuum mode is fixed when
  // the database is first written, and only a full VACUUM can change it after.
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  // A checkpointed write-ahead log is truncated back to this bound instead of
  // staying at its high-water mark, so the log holds a bounded share of the disk
  // beside the database the budget above measures.
  database.exec(
    `PRAGMA journal_size_limit = ${Math.min(WAL_BYTES_LIMIT, Math.max(1, maxStoredBytes))}`,
  );
  database.exec(`PRAGMA user_version = ${TELEMETRY_STORE_SCHEMA_VERSION}`);
  return database;
}

function storedShapeIsCurrent(database: Database): boolean {
  const tables = database.query(
    "SELECT COUNT(*) AS present FROM sqlite_master WHERE type = 'table'",
  ).get() as { readonly present: bigint | number };
  if (Number(tables.present) === 0) return true;
  const version = database.query("SELECT * FROM pragma_user_version() AS version")
    .get() as { readonly user_version: bigint | number };
  const vacuum = database.query("SELECT * FROM pragma_auto_vacuum() AS mode")
    .get() as { readonly auto_vacuum: bigint | number };
  return Number(version.user_version) === TELEMETRY_STORE_SCHEMA_VERSION &&
    Number(vacuum.auto_vacuum) === 2;
}
