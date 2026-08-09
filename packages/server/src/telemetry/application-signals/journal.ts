/**
 * Application logs and analytics events, homed as one kind inside the shared
 * telemetry store (ADR-0017).
 *
 * **The row is not opaque.** Level, source, function, correlation ids, event
 * name and identity are real columns written at insert from the typed record,
 * never re-parsed out of the payload. Per-level retention is the ticket's core
 * requirement and it cannot be enforced through an index that does not exist;
 * the same columns are what the Admin API reads on.
 *
 * **There is no queue here.** Every durable signal reaches the connection
 * through the sidecar writer's single bounded ring, which assigns the sequence
 * numbers a drain seals at and owns the commit boundary. A second queue in front
 * of a connection only reachable through that ring would bound nothing and would
 * add a second place a record can be lost; what is left here is the SQL, the
 * per-level expiry sets, and the export consumers' cursors.
 *
 * **Nothing is counted twice.** The store measures the file and counts what
 * expiry and eviction removed, per class. A row count mirrored in memory here
 * would be one more number for a rolled-back transaction to silently invalidate,
 * and it would answer a question the store already answers from the file itself.
 */
import type { Database, Statement } from "bun:sqlite";
import { decode, encode } from "@ackerdb/core";
import { DAY_MS } from "../storage/retention.ts";
import { expirableSet, positiveInteger, type TelemetryStore } from "../storage/store.ts";
import type {
  ApplicationLogLevel,
  TelemetryJournalEntry,
  TelemetryJournalRecord,
} from "./types.ts";

export interface TelemetryJournalOptions {
  /** The shared telemetry sidecar this journal homes its tables in. */
  readonly store: TelemetryStore;
}

export interface TelemetryConsumerSnapshot {
  readonly cursor: bigint;
  readonly exportedRecords: number;
  readonly skippedUnsupported: number;
  readonly skippedIdentity: number;
  readonly evictedRecords: number;
  readonly failures: number;
  readonly timedOut: number;
}

export interface TelemetryConsumerBatch {
  readonly records: readonly TelemetryJournalEntry[];
  readonly consumer: TelemetryConsumerSnapshot;
}

export interface TelemetryConsumerAdvance {
  readonly exportedRecords?: number;
  readonly skippedUnsupported?: number;
  readonly skippedIdentity?: number;
}

const LOG_LEVELS: readonly ApplicationLogLevel[] = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
]);

const INSERT_JOURNAL_ROW = `
  INSERT INTO _ackerdb_telemetry_journal (
    process_generation, sequence, timestamp, kind, level, source,
    function_address, trace_id, span_id, request_id, event, identity,
    payload_bytes, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function journalRowValues(
  record: TelemetryJournalRecord,
  bytes: number,
  encoded: string,
): readonly (string | number | bigint | null)[] {
  return [
    record.processGeneration,
    record.sequence,
    record.timestamp,
    record.kind,
    record.kind === "log" ? record.level : null,
    record.kind === "log" ? record.source : null,
    record.functionAddress,
    record.traceId ?? null,
    record.spanId ?? null,
    record.requestId ?? null,
    record.kind === "analytics" ? record.event : null,
    record.kind === "analytics" ? record.identity ?? null : null,
    bytes,
    encoded,
  ];
}

export class TelemetryJournal {
  readonly store: TelemetryStore;
  private readonly database: Database;
  private readonly insertRow: Statement;
  private readonly upsertAnalyticsRollup: Statement;
  private readonly highWaterMark: Statement;
  private writtenRecords = 0;

  constructor(options: TelemetryJournalOptions) {
    this.store = options.store;
    this.database = this.store.database;
    this.store.register({
      name: "application-signals",
      initialize: (database) => {
        createJournalSchema(database);
        return [
        // One set per level: the level clocks differ, and a set is exactly the
        // pairing of a deletable slice with the clock it expires on.
        ...LOG_LEVELS.map((level) => expirableSet(this.store, level, {
          table: "_ackerdb_telemetry_journal",
          key: "id",
          timestamp: "timestamp",
          filter: "kind = 'log' AND level = ?",
          bind: [level],
        })),
        expirableSet(this.store, "analytics", {
          table: "_ackerdb_telemetry_journal",
          key: "id",
          timestamp: "timestamp",
          filter: "kind = 'analytics'",
        }),
        expirableSet(this.store, "rollups", {
          table: "_ackerdb_telemetry_analytics_rollup",
          key: "rowid",
          timestamp: "day",
        }),
        ];
      },
    });
    this.insertRow = this.store.prepare(INSERT_JOURNAL_ROW);
    // The daily rollup outlives raw events by an order of magnitude, so it is
    // maintained by increment rather than recomputed: recomputing one bucket
    // from raw rows would cost a scan of that day's events on every batch,
    // which grows with the day's volume — super-linear work for a number that
    // an increment already knows exactly. The rollup doubles as the registry of
    // distinct event names.
    this.upsertAnalyticsRollup = this.store.prepare(`
      INSERT INTO _ackerdb_telemetry_analytics_rollup (day, event, count)
      VALUES (?, ?, ?)
      ON CONFLICT(day, event) DO UPDATE SET count = count + excluded.count
    `);
    // The id high-water mark, which SQLite already maintains for an AUTOINCREMENT
    // key. Reading it beats storing a copy: a copy has to be written inside every
    // transaction to stay true, and is wrong for exactly as long as it is not.
    this.highWaterMark = this.store.prepare(`
      SELECT COALESCE(
        (SELECT seq FROM sqlite_sequence WHERE name = '_ackerdb_telemetry_journal'),
        0
      ) AS seq
    `);
  }

  /**
   * Write one record inside a transaction the CALLER owns. Encoding happens
   * here because the accepting thread hands over a decoded record and this is
   * the only frame that knows the stored shape.
   */
  appendDirect(record: TelemetryJournalRecord): void {
    const encoded = encode(record);
    this.insertRow.run(...journalRowValues(record, Buffer.byteLength(encoded), encoded));
    this.writtenRecords++;
    if (record.kind === "analytics") {
      const day = Math.floor(record.timestamp / DAY_MS) * DAY_MS;
      this.upsertAnalyticsRollup.run(day, record.event, 1);
    }
  }

  /**
   * One synchronous terminal append — the structurally LAST durable record,
   * written after the ring drains and before the sidecar closes. A terminal row
   * that cannot be written fails LOUD: the error escapes so the seal reports it,
   * because a clean resolution with zero terminal rows is not a mode.
   */
  appendFinal(record: TelemetryJournalRecord): void {
    this.database.transaction(() => this.appendDirect(record))();
  }

  /** Records this process wrote; the store owns what the file holds. */
  get written(): number {
    return this.writtenRecords;
  }

  consumerBatch(name: string, limit: number): TelemetryConsumerBatch {
    validateConsumerName(name);
    positiveInteger(limit, "telemetry journal batch limit");
    return this.withStorage(() => {
      this.ensureConsumer(name);
      let consumer = this.consumerRow(name);
      const oldest = this.store.prepare(
        "SELECT MIN(id) AS id FROM _ackerdb_telemetry_journal",
      ).get() as { readonly id: bigint | null };
      const retainedFrontier = oldest.id === null ? this.lastRecordId() : oldest.id - 1n;
      if (consumer.cursor < retainedFrontier) {
        const evicted = Number(retainedFrontier - consumer.cursor);
        this.store.prepare(`
          UPDATE _ackerdb_telemetry_consumers
          SET cursor = ?, evicted_records = evicted_records + ?
          WHERE name = ?
        `).run(retainedFrontier, evicted, name);
        consumer = this.consumerRow(name);
      }
      const rows = this.store.prepare(`
        SELECT id, payload
        FROM _ackerdb_telemetry_journal
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `).all(consumer.cursor, limit) as { readonly id: bigint; readonly payload: string }[];
      return Object.freeze({
        records: Object.freeze(rows.map((row) => Object.freeze({
          ...(decode(row.payload) as TelemetryJournalRecord),
          id: row.id,
        }))),
        consumer,
      });
    });
  }

  advanceConsumer(
    name: string,
    cursor: bigint,
    advance: TelemetryConsumerAdvance,
  ): TelemetryConsumerSnapshot {
    validateConsumerName(name);
    return this.withStorage(() => {
      this.ensureConsumer(name);
      const previous = this.consumerRow(name);
      // Cursor-aware loss accounting: every id crossed by this advance was
      // exported, skipped, or no longer in storage. Per-class retention deletes
      // arbitrary rows, so holes between retained records are evictions too —
      // not only the prefix before MIN(id).
      const accounted = (advance.exportedRecords ?? 0) +
        (advance.skippedUnsupported ?? 0) +
        (advance.skippedIdentity ?? 0);
      const crossed = cursor > previous.cursor ? Number(cursor - previous.cursor) : 0;
      const evicted = Math.max(crossed - accounted, 0);
      // The cursor only ever moves forward. The export pump runs the caller's
      // closure on another thread, so an advance for a batch that timed out can
      // arrive after a later batch already committed its own; rewinding on that
      // would re-deliver everything in between.
      this.store.prepare(`
        UPDATE _ackerdb_telemetry_consumers
        SET cursor = MAX(cursor, ?),
            exported_records = exported_records + ?,
            skipped_unsupported = skipped_unsupported + ?,
            skipped_identity = skipped_identity + ?,
            evicted_records = evicted_records + ?
        WHERE name = ?
      `).run(
        cursor,
        advance.exportedRecords ?? 0,
        advance.skippedUnsupported ?? 0,
        advance.skippedIdentity ?? 0,
        evicted,
        name,
      );
      return this.consumerRow(name);
    });
  }

  recordConsumerFailure(name: string, timedOut: boolean): TelemetryConsumerSnapshot {
    validateConsumerName(name);
    return this.withStorage(() => {
      this.ensureConsumer(name);
      this.store.prepare(`
        UPDATE _ackerdb_telemetry_consumers
        SET failures = failures + 1, timed_out = timed_out + ?
        WHERE name = ?
      `).run(timedOut ? 1 : 0, name);
      return this.consumerRow(name);
    });
  }

  private lastRecordId(): bigint {
    const row = this.highWaterMark.get() as { readonly seq: bigint | number };
    return BigInt(row.seq);
  }

  private consumerRow(name: string): TelemetryConsumerSnapshot {
    const row = this.store.prepare(`
      SELECT cursor,
             exported_records AS exportedRecords,
             skipped_unsupported AS skippedUnsupported,
             skipped_identity AS skippedIdentity,
             evicted_records AS evictedRecords,
             failures,
             timed_out AS timedOut
      FROM _ackerdb_telemetry_consumers
      WHERE name = ?
    `).get(name) as {
      readonly cursor: bigint;
      readonly exportedRecords: bigint;
      readonly skippedUnsupported: bigint;
      readonly skippedIdentity: bigint;
      readonly evictedRecords: bigint;
      readonly failures: bigint;
      readonly timedOut: bigint;
    };
    return Object.freeze({
      cursor: row.cursor,
      exportedRecords: Number(row.exportedRecords),
      skippedUnsupported: Number(row.skippedUnsupported),
      skippedIdentity: Number(row.skippedIdentity),
      evictedRecords: Number(row.evictedRecords),
      failures: Number(row.failures),
      timedOut: Number(row.timedOut),
    });
  }

  /**
   * Account one storage loss and let the store decide what it meant. Whether
   * this connection is finished depends on whether it survives a probe, which is
   * the store's to run and not this kind's to guess. The error is rethrown
   * either way: a consumer operation that did not happen must never be reported
   * to the export pump as one that did.
   */
  private withStorage<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      this.store.observeFailure(error);
      throw error;
    }
  }

  private ensureConsumer(name: string): void {
    this.store.prepare(`
      INSERT OR IGNORE INTO _ackerdb_telemetry_consumers (
        name, cursor, exported_records, skipped_unsupported,
        skipped_identity, evicted_records, failures, timed_out
      ) VALUES (?, 0, 0, 0, 0, 0, 0, 0)
    `).run(name);
  }
}

function createJournalSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_generation TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      timestamp REAL NOT NULL,
      kind TEXT NOT NULL,
      level TEXT,
      source TEXT,
      function_address TEXT,
      trace_id TEXT,
      span_id TEXT,
      request_id TEXT,
      event TEXT,
      identity INTEGER,
      payload_bytes INTEGER NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(process_generation, sequence)
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_journal_retention
    ON _ackerdb_telemetry_journal (kind, level, timestamp)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_journal_trace
    ON _ackerdb_telemetry_journal (trace_id, id) WHERE trace_id IS NOT NULL
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_journal_level
    ON _ackerdb_telemetry_journal (level, id) WHERE kind = 'log'
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_journal_event
    ON _ackerdb_telemetry_journal (event, timestamp) WHERE kind = 'analytics'
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_journal_identity
    ON _ackerdb_telemetry_journal (identity, timestamp) WHERE identity IS NOT NULL
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_analytics_rollup (
      day INTEGER NOT NULL,
      event TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, event)
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_consumers (
      name TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL,
      exported_records INTEGER NOT NULL,
      skipped_unsupported INTEGER NOT NULL,
      skipped_identity INTEGER NOT NULL,
      evicted_records INTEGER NOT NULL,
      failures INTEGER NOT NULL,
      timed_out INTEGER NOT NULL
    )
  `);
}

function validateConsumerName(name: string): void {
  if (name.length === 0 || name.length > 128) {
    throw new TypeError("telemetry consumer name must contain 1 to 128 characters");
  }
}
