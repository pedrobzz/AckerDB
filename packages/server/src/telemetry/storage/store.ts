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
 * **Time is the control; bytes are the guard; whichever fires first.** Each class
 * of data has a clock, and that is what an operator sets and reads. The byte
 * ceiling exists so a burst cannot fill a disk, not as the way retention is
 * expressed — Netdata, the closest single-node analog, runs both and calls its
 * byte limit a soft target. Over the ceiling, maintenance escalates from expiring
 * what the clocks say is old to evicting oldest-first, shortest clock first, so
 * runaway logging spends the space of the data that matters least.
 *
 * **The guard counts everything on disk, including the write-ahead log.** Pages
 * before a checkpoint are counted in both the database and the log, so this
 * over-reports — deliberately. A guard that over-reports fires early; a guard
 * that under-reports lets the volume fill while its own arithmetic says there is
 * room, which is VictoriaLogs#841 exactly: ingestion stopped on a full disk while
 * the computed size sat under the limit, because the accounting covered rows and
 * not the scratch beside them.
 *
 * **The ceiling is a target; the free-space floor is the guard.** Netdata's own
 * documentation says its size cap is soft, that it does not block or reject
 * writes as the cap approaches, and that no mechanism enforces a true hard cap.
 * What the industry actually trusts is a floor that REFUSES: Elasticsearch's
 * flood-stage read-only block at 95%, VictoriaMetrics and VictoriaLogs going
 * read-only below `minFreeDiskSpaceBytes`, Datadog's daily quota stopping
 * indexing. So eviction chases `maxStoredBytes`, and admission is what the free
 * space governs.
 *
 * **A minimum-data floor stops eviction taking the most recent window**, whatever
 * the ceiling says: the incident that blew the budget is exactly when the last
 * two days matter, so the store goes over and DISCLOSES it rather than erasing
 * the evidence.
 *
 * **Pressure is one number and it drives admission.** journald multiplies its
 * effective rate by a factor derived from remaining free space; the same shape
 * here means the budget and the limiter are one mechanism instead of two that
 * can disagree. What that protects against is specific and measured: retaining
 * every error as a full exemplar is correct at a 1% error rate and catastrophic
 * at 100%, and a flood makes it 100% — 2,099 bytes an exemplar against 316 a log
 * row, so the store fills about seven times faster precisely when the
 * application is under attack. Under pressure the exemplars stop and the
 * aggregate keeps counting, because the aggregate is bounded by CARDINALITY and
 * no amount of traffic makes it grow. Nothing about the incident's shape is lost;
 * only the individual specimens are.
 *
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
 * runtime unhealthy. The probe is a committed WRITE, not a read: a full disk
 * leaves SQLite perfectly readable, so a read probe would classify disk
 * exhaustion — the failure this rule exists for — as one row's bad luck. The
 * probe deliberately crosses the boundary that failed.
 */
import { Database, type Statement } from "bun:sqlite";
import { rmSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_MIN_RETAINED_MS,
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
export const TELEMETRY_STORE_SCHEMA_VERSION = 2;

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
  /**
   * The oldest and newest timestamps still stored, or `undefined` on an empty
   * set. Two numbers, not an accounting subsystem: they are what makes the
   * EFFECTIVE window observable to an operator who configured seven days and is
   * being given two by eviction.
   */
  span(): { readonly oldestMs?: number; readonly newestMs?: number };
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
   * The disk guard over the whole sidecar — database plus write-ahead log. It is
   * a convergence target, not an instantaneous ceiling: a burst may cross it and
   * the next passes evict back under.
   */
  readonly maxStoredBytes: number;
  /** The most recent window eviction may never take, whatever the guard says. */
  readonly minRetainedMs: number;
  /**
   * Share of the filesystem the sidecar refuses to consume the last of. Below
   * it, eviction runs whether or not the byte ceiling was reached, because a
   * telemetry file is never worth a full volume.
   */
  readonly keepFreeRatio: number;
}

export interface TelemetryStoreOptions {
  readonly path: string;
  readonly retention?: Readonly<Record<string, number>>;
  readonly limits?: Partial<TelemetryStoreLimits>;
  readonly now?: () => number;
}

/**
 * The two timestamps a reader needs to know what retention a signal is ACTUALLY
 * getting: the oldest row still stored and the newest. The configured window is
 * already in `retention`, so the effective one is a subtraction the caller does.
 *
 * Deliberately two gauges and not an accounting subsystem. VictoriaLogs exposes
 * exactly this as `vl_storage_log_min_timestamp_seconds` and its max, and Netdata
 * ships per-tier space and time retention; the shape is validated and it is
 * cheap. What it buys is the thing configuration alone cannot say — an operator
 * who set seven days and is being given two by eviction has no other way to
 * learn it, and a green "7 days" that eviction quietly made two hours is the
 * failure being avoided.
 */
export interface TelemetryRetentionSpan {
  readonly retention: TelemetryRetentionClass;
  readonly configuredMs: number;
  readonly oldestMs: number | null;
  readonly newestMs: number | null;
}

export interface TelemetryStoreSnapshot {
  readonly state: "ready" | "failed" | "stopped";
  readonly path: string;
  readonly retention: TelemetryRetentionTtls;
  readonly maxStoredBytes: number;
  /**
   * Everything the sidecar occupies: the database's pages plus the write-ahead
   * log beside it. Pre-checkpoint pages appear in both, so this over-reports on
   * purpose — a guard that over-reports fires early, and one that under-reports
   * fills the volume while its own arithmetic says there is room.
   */
  readonly storedBytes: number;
  readonly databaseBytes: number;
  readonly walBytes: number;
  /** Free space on the sidecar's filesystem, as of the last maintenance pass. */
  readonly freeBytes: number;
  readonly overBudget: boolean;
  /** True when the byte guard wants to evict and the minimum window forbids it. */
  readonly floorHeld: boolean;
  /**
   * What the free-space floor and the byte target jointly say about headroom,
   * from 0 (ample) to 1 (out). This is the number admission is scaled by.
   */
  readonly pressure: number;
  /** Below the free-space floor the sidecar refuses every write, and says so. */
  readonly readOnly: boolean;
  /** Per signal: configured window, and the span actually retained. */
  readonly spans: readonly TelemetryRetentionSpan[];
  readonly expiredRecords: Readonly<Record<TelemetryRetentionClass, number>>;
  readonly evictedRecords: Readonly<Record<TelemetryRetentionClass, number>>;
  /** Failures a probe proved the connection survived — contained to one kind. */
  readonly containedFailures: number;
  readonly failure?: unknown;
}

const DEFAULT_LIMITS: TelemetryStoreLimits = Object.freeze({
  maxExpiredRowsPerPass: 256,
  // Generous, because the clocks are the control and this only has to stop a
  // burst from filling a volume. A budget small enough to bind in ordinary use
  // would promise a week of logs and deliver hours of them.
  maxStoredBytes: 8 * 1_024 * 1_024 * 1_024,
  minRetainedMs: DEFAULT_MIN_RETAINED_MS,
  // journald's SystemKeepFree, which is the same job on the same kind of file.
  keepFreeRatio: 0.15,
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

/** The write-ahead log's size, for the snapshot; a missing file is zero bytes. */
function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Free bytes on the filesystem holding `path`, and its total size. */
function volume(path: string): { readonly freeBytes: number; readonly totalBytes: number } {
  try {
    const stats = statfsSync(dirname(path));
    return {
      freeBytes: Number(stats.bsize) * Number(stats.bavail),
      totalBytes: Number(stats.bsize) * Number(stats.blocks),
    };
  } catch {
    // An unreadable filesystem must not be read as an empty one: a floor that
    // fires because it could not measure would refuse every write on a healthy
    // disk. Unknown free space is treated as ample and the byte target alone
    // governs, which is the failure that loses telemetry rather than service.
    return { freeBytes: Number.POSITIVE_INFINITY, totalBytes: Number.POSITIVE_INFINITY };
  }
}

/** Where one expirable slice lives: a table, its key, and the clock column. */
export interface TelemetrySource {
  readonly table: string;
  /** The column the delete selects on — `rowid` where there is no better one. */
  readonly key: string;
  readonly timestamp: string;
  /** An extra predicate narrowing the table to this slice, bound before the cutoff. */
  readonly filter?: string;
  readonly bind?: readonly (string | number)[];
}

/**
 * Build one expirable set from a table and its clock column.
 *
 * Every kind needs the same two statements — delete the oldest rows before a
 * cutoff, and read the extremes still stored — and writing them per kind is one
 * chance per kind to order a delete by the wrong column or to forget the second
 * statement entirely. Both go through an index the kind's DDL declares.
 */
export function expirableSet(
  store: TelemetryStore,
  retention: TelemetryRetentionClass,
  source: TelemetrySource,
  onDeleted?: (removed: number) => void,
): TelemetryExpirableSet {
  const where = source.filter === undefined ? "" : `${source.filter} AND `;
  const bind = source.bind ?? [];
  const remove = store.prepare(`
    DELETE FROM ${source.table}
    WHERE ${source.key} IN (
      SELECT ${source.key} FROM ${source.table}
      WHERE ${where}${source.timestamp} < ?
      ORDER BY ${source.timestamp}
      LIMIT ?
    )
    RETURNING ${source.key}
  `);
  const extremes = store.prepare(`
    SELECT MIN(${source.timestamp}) AS oldest, MAX(${source.timestamp}) AS newest
    FROM ${source.table}${source.filter === undefined ? "" : ` WHERE ${source.filter}`}
  `);
  return Object.freeze({
    retention,
    deleteExpired: (cutoffMs: number, limit: number): number => {
      const removed = remove.all(...bind, cutoffMs, limit).length;
      onDeleted?.(removed);
      return removed;
    },
    span: () => {
      const row = extremes.get(...bind) as {
        readonly oldest: number | bigint | null;
        readonly newest: number | bigint | null;
      };
      return Object.freeze({
        ...(row.oldest === null ? {} : { oldestMs: Number(row.oldest) }),
        ...(row.newest === null ? {} : { newestMs: Number(row.newest) }),
      });
    },
  });
}

/**
 * The free-space share must leave room to write. At 1 the sidecar would demand
 * the whole volume be free and refuse every write on an empty disk, which is a
 * configuration that can only be a mistake.
 */
function keepFreeRatio(value: number): number {
  if (!(value >= 0 && value < 1)) {
    throw new RangeError("telemetry store keepFreeRatio must be at least 0 and below 1");
  }
  return value;
}

const NO_SPANS: readonly TelemetryRetentionSpan[] = Object.freeze([]);

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
  private readonly statements = new Map<string, Statement>();
  private readonly sampleBytes: Statement;
  private readonly probeWrite: Statement;
  private cursor = 0;
  private storedBytes = 0;
  private databaseBytes = 0;
  private walBytes = 0;
  private freeBytes = Number.POSITIVE_INFINITY;
  private minFreeBytes = 0;
  private floorHeld = false;
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
      minRetainedMs: positiveInteger(
        options.limits?.minRetainedMs ?? DEFAULT_LIMITS.minRetainedMs,
        "telemetry store minRetainedMs",
      ),
      keepFreeRatio: keepFreeRatio(
        options.limits?.keepFreeRatio ?? DEFAULT_LIMITS.keepFreeRatio,
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
    // Prepared once: a maintenance pass samples on every batch, so re-preparing
    // the pragma read would cost more than the read it performs.
    this.sampleBytes = this.prepare(
      "SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS bytes",
    );
    this.probeWrite = this.prepare(
      "UPDATE _ackerdb_telemetry_health SET probes = probes + 1 WHERE singleton = 1",
    );
    this.sampleUsage();
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
   * clocks first, then — only while the sidecar is over its byte target —
   * evicts oldest-first from the shortest clock outward, down to but never
   * inside the minimum retained window. Returns the rows it removed.
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
    // Every pass samples. The reads are a database header SQLite already holds
    // and one filesystem stat, so sampling on a schedule would trade a
    // negligible cost for a window in which the store is over budget, reports
    // that it is not, and — if writes then stop — stays there.
    this.sampleUsage();
    // Either way of running out triggers eviction. Evicting only over the byte
    // target would leave the sidecar read-only on a volume the application's own
    // database filled, refusing every signal while old telemetry above the
    // minimum window sat there evictable.
    if (!this.needsEviction) {
      this.overBudgetPasses = 0;
      this.floorHeld = false;
      return removed;
    }
    const budget = this.limits.maxExpiredRowsPerPass *
      2 ** Math.min(this.overBudgetPasses, MAX_EVICTION_ESCALATION);
    this.overBudgetPasses++;
    // Eviction is expiry with a shorter clock, and the minimum retained window
    // IS that clock. Nothing newer than it is ever taken, so the store goes over
    // its target and discloses it rather than deleting the hour an operator is
    // looking at during the incident that caused the overrun.
    const evicted = this.evict(budget, nowMs - this.limits.minRetainedMs);
    this.floorHeld = evicted === 0 && this.needsEviction;
    return removed + evicted;
  }

  /** True while either way of running out of room is unsatisfied. */
  private get needsEviction(): boolean {
    return this.storedBytes > this.limits.maxStoredBytes ||
      (this.minFreeBytes > 0 && this.freeBytes < this.minFreeBytes);
  }

  /** Oldest-first across every clock, shortest clock first, up to `budget` rows. */
  private evict(budget: number, cutoffMs: number): number {
    let evicted = 0;
    for (const set of this.evictionOrder) {
      while (evicted < budget && this.needsEviction) {
        const chunk = Math.min(budget - evicted, this.limits.maxExpiredRowsPerPass);
        const deleted = set.deleteExpired(cutoffMs, chunk);
        if (deleted === 0) break;
        evicted += deleted;
        this.evictedRecords[set.retention] += deleted;
        // Deleting rows only lengthens the freelist; returning those pages is
        // what makes the next sample tell the truth about the file on disk.
        this.database.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES_PER_ROUND})`);
        this.sampleUsage();
      }
      if (evicted >= budget || !this.needsEviction) break;
    }
    return evicted;
  }

  /**
   * Everything the sidecar occupies, and how close the volume is to the floor.
   *
   * The write-ahead log is added rather than reported beside: before a
   * checkpoint the same pages appear in both, so this over-reports — which is
   * the safe direction for a guard. Under-reporting is VictoriaLogs#841, where
   * ingestion stopped on a full disk while the computed size sat under the
   * limit because the accounting covered rows and not the scratch beside them.
   */
  private sampleUsage(): void {
    const page = this.sampleBytes.get() as { readonly bytes: bigint | number };
    this.databaseBytes = Number(page.bytes);
    this.walBytes = this.path === ":memory:" ? 0 : fileBytes(`${this.path}-wal`);
    this.storedBytes = this.databaseBytes + this.walBytes;
    if (this.path === ":memory:") {
      this.freeBytes = Number.POSITIVE_INFINITY;
      this.minFreeBytes = 0;
      return;
    }
    const disk = volume(this.path);
    this.freeBytes = disk.freeBytes;
    this.minFreeBytes = Number.isFinite(disk.totalBytes)
      ? disk.totalBytes * this.limits.keepFreeRatio
      : 0;
  }

  /**
   * How close the sidecar is to being unable to write, from 0 to 1. The byte
   * target and the free-space floor are two ways of running out, so pressure is
   * whichever is nearer: the target scales linearly to 1 at `maxStoredBytes`,
   * and the floor starts counting when free space falls to twice it and reaches
   * 1 at the floor itself.
   */
  get pressure(): number {
    const budget = this.limits.maxStoredBytes <= 0
      ? 1
      : this.storedBytes / this.limits.maxStoredBytes;
    const disk = this.minFreeBytes <= 0 || !Number.isFinite(this.freeBytes)
      ? 0
      : (2 * this.minFreeBytes - this.freeBytes) / this.minFreeBytes;
    return Math.min(1, Math.max(0, budget, disk));
  }

  /** Below the free-space floor nothing may be written. Elasticsearch flood stage. */
  get readOnly(): boolean {
    return this.minFreeBytes > 0 && this.freeBytes < this.minFreeBytes;
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
   * and only one of them means the file is gone. The probe therefore commits a
   * write — a full disk answers reads perfectly well, so a read probe would
   * call disk exhaustion a contained row failure and keep serving an
   * application whose telemetry has silently stopped. One throw observed by two
   * frames is one event, so the same error object is judged once.
   */
  observeFailure(error: unknown): boolean {
    if (this.state !== "ready") return false;
    const repeat = error !== undefined && error === this.lastObserved;
    this.lastObserved = error;
    if (!repeat) this.containedFailures++;
    try {
      this.probeWrite.run();
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
      databaseBytes: this.databaseBytes,
      walBytes: this.walBytes,
      freeBytes: this.freeBytes,
      overBudget: this.storedBytes > this.limits.maxStoredBytes,
      floorHeld: this.floorHeld,
      pressure: this.pressure,
      readOnly: this.readOnly,
      // Reading the file is only possible while the connection is open, and a
      // snapshot has to keep answering after close — the drain takes one.
      spans: this.state === "ready" ? this.retentionSpans() : NO_SPANS,
      expiredRecords: Object.freeze({ ...this.expiredRecords }),
      evictedRecords: Object.freeze({ ...this.evictedRecords }),
      containedFailures: this.containedFailures,
      ...(this.failure === undefined ? {} : { failure: this.failure }),
    });
  }

  /**
   * The oldest and newest row per clock. Two gauges, read on a status call and
   * never on the write path, from which a caller subtracts the window it is
   * actually being given and compares it against the one it configured.
   */
  private retentionSpans(): readonly TelemetryRetentionSpan[] {
    const spans = new Map<TelemetryRetentionClass, { oldest: number | null; newest: number | null }>();
    for (const set of this.sets) {
      const observed = set.span();
      const merged = spans.get(set.retention) ?? { oldest: null, newest: null };
      if (observed.oldestMs !== undefined) {
        merged.oldest = merged.oldest === null
          ? observed.oldestMs
          : Math.min(merged.oldest, observed.oldestMs);
      }
      if (observed.newestMs !== undefined) {
        merged.newest = merged.newest === null
          ? observed.newestMs
          : Math.max(merged.newest, observed.newestMs);
      }
      spans.set(set.retention, merged);
    }
    return Object.freeze([...spans].map(([retention, observed]) => Object.freeze({
      retention,
      configuredMs: this.retention[retention],
      oldestMs: observed.oldest,
      newestMs: observed.newest,
    })));
  }

  /**
   * Prepare a statement this store will finalize when it closes.
   *
   * SQLite will not release a connection while a statement prepared on it is
   * still live, and `close(false)` swallows that refusal silently — so a sidecar
   * whose kinds prepared their own statements stays locked for the life of the
   * process, its write-ahead log never goes away, and the next store to open the
   * same file gets SQLITE_BUSY. Every kind prepares through here so that closing
   * actually closes. Repeated SQL returns the same statement, so callers may
   * prepare freely.
   */
  prepare(sql: string): Statement {
    const existing = this.statements.get(sql);
    if (existing !== undefined) return existing;
    const prepared = this.database.query(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  close(): void {
    if (this.state === "stopped") return;
    if (this.state === "ready") this.state = "stopped";
    for (const statement of this.statements.values()) {
      try {
        statement.finalize();
      } catch {
        // A statement that cannot be finalized must not stop the others.
      }
    }
    this.statements.clear();
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
  // The store's own row, so the failure probe has a write to commit that
  // belongs to no kind and disturbs no kind's accounting.
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_health (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      probes INTEGER NOT NULL
    )
  `);
  database.query(
    "INSERT OR IGNORE INTO _ackerdb_telemetry_health (singleton, probes) VALUES (1, 0)",
  ).run();
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
