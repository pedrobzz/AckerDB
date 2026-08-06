import { Database } from "bun:sqlite";
import {
  resolveTelemetryRetention,
  TELEMETRY_RETENTION_CLASSES,
  type TelemetryRetentionClass,
  type TelemetryRetentionTtls,
} from "./retention.ts";

/**
 * One deletable slice of a stored kind, bound to the retention clock its
 * rows expire on. `deleteExpired` must delete at most `limit` rows whose
 * timestamp is older than `cutoffMs`, through an index, and report how many
 * it removed.
 */
export interface TelemetryExpirableSet {
  readonly retention: TelemetryRetentionClass;
  deleteExpired(cutoffMs: number, limit: number): number;
}

/**
 * A kind of observable data homed in the telemetry store. `initialize` runs
 * idempotent DDL for the kind's tables and timestamp indexes on the shared
 * sidecar database and returns the expirable sets maintenance passes visit.
 * A kind whose rows never expire (error groups) returns no sets.
 */
export interface TelemetryStoredKind {
  readonly name: string;
  initialize(database: Database): readonly TelemetryExpirableSet[];
}

export interface TelemetryStoreOptions {
  readonly path: string;
  readonly retention?: Partial<TelemetryRetentionTtls>;
  /** Hard bound on rows one maintenance pass may expire. */
  readonly maxExpiredRowsPerPass?: number;
  readonly now?: () => number;
}

export interface TelemetryStoreSnapshot {
  readonly retention: TelemetryRetentionTtls;
  readonly expiredRecords: Readonly<Record<TelemetryRetentionClass, number>>;
}

const DEFAULT_MAX_EXPIRED_ROWS_PER_PASS = 256;

/**
 * The single `<db>.telemetry` SQLite home for every observable kind — the
 * application database never carries telemetry, and telemetry loss is never
 * business-data loss. Retention is enforced only on the write path: each
 * pass expires a bounded number of rows by the current per-class clocks,
 * round-robining the budget across registered sets. No timers, no
 * background sweeps, zero idle cost.
 */
export class TelemetryStore {
  readonly path: string;
  readonly database: Database;
  readonly retention: TelemetryRetentionTtls;
  readonly maxExpiredRowsPerPass: number;
  private readonly now: () => number;
  private readonly kinds = new Set<string>();
  private readonly sets: TelemetryExpirableSet[] = [];
  private readonly expiredRecords: Record<TelemetryRetentionClass, number>;
  private cursor = 0;

  constructor(options: TelemetryStoreOptions) {
    this.path = options.path;
    this.retention = resolveTelemetryRetention(options.retention);
    const budget = options.maxExpiredRowsPerPass ?? DEFAULT_MAX_EXPIRED_ROWS_PER_PASS;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new RangeError("telemetry store maxExpiredRowsPerPass must be a positive integer");
    }
    this.maxExpiredRowsPerPass = budget;
    this.now = options.now ?? Date.now;
    const expired = {} as Record<TelemetryRetentionClass, number>;
    for (const retentionClass of TELEMETRY_RETENTION_CLASSES) expired[retentionClass] = 0;
    this.expiredRecords = expired;
    this.database = new Database(options.path, {
      create: true,
      safeIntegers: true,
      strict: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
  }

  register(kind: TelemetryStoredKind): void {
    if (this.kinds.has(kind.name)) {
      throw new TypeError(`telemetry kind "${kind.name}" is already registered`);
    }
    this.kinds.add(kind.name);
    this.sets.push(...kind.initialize(this.database));
  }

  /** One bounded write-path pass; returns how many rows it expired. */
  maintain(nowMs = this.now()): number {
    let remaining = this.maxExpiredRowsPerPass;
    let expired = 0;
    for (let probes = 0; probes < this.sets.length && remaining > 0; probes++) {
      const set = this.sets[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.sets.length;
      const deleted = set.deleteExpired(nowMs - this.retention[set.retention], remaining);
      remaining -= deleted;
      expired += deleted;
      this.expiredRecords[set.retention] += deleted;
    }
    return expired;
  }

  snapshot(): TelemetryStoreSnapshot {
    return Object.freeze({
      retention: this.retention,
      expiredRecords: Object.freeze({ ...this.expiredRecords }),
    });
  }

  close(): void {
    this.database.close(false);
  }
}
