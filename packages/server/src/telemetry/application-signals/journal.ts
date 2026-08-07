import type { Database, Statement } from "bun:sqlite";
import { decode, encode } from "@ackerdb/core";
import { DAY_MS } from "../storage/retention.ts";
import { positiveInteger, type TelemetryStore } from "../storage/store.ts";
import type {
  ApplicationLogLevel,
  TelemetryJournalEntry,
  TelemetryJournalRecord,
} from "./types.ts";

export interface TelemetryJournalLimits {
  readonly maxQueuedRecords: number;
  readonly maxQueuedBytes: number;
  readonly maxBatchRecords: number;
  readonly maxRecordBytes: number;
  readonly maxStoredRecords: number;
  readonly maxStoredBytes: number;
}

export interface TelemetryJournalOptions {
  /** The shared telemetry sidecar this journal homes its tables in. */
  readonly store: TelemetryStore;
  readonly limits?: Partial<TelemetryJournalLimits>;
}

export interface TelemetryJournalSnapshot {
  readonly state: "ready" | "draining" | "stopped" | "failed";
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly persistedRecords: number;
  readonly storedRecords: number;
  readonly storedBytes: number;
  readonly droppedRecords: number;
  readonly truncatedRecords: number;
  readonly malformedRecords: number;
  readonly oversizedRecords: number;
  readonly saturatedRecords: number;
  readonly evictedRecords: number;
  readonly failure?: unknown;
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

const DEFAULT_LIMITS: TelemetryJournalLimits = Object.freeze({
  maxQueuedRecords: 4_096,
  maxQueuedBytes: 8 * 1_024 * 1_024,
  maxBatchRecords: 256,
  maxRecordBytes: 64 * 1_024,
  maxStoredRecords: 100_000,
  maxStoredBytes: 256 * 1_024 * 1_024,
});

interface QueuedRecord {
  readonly record: TelemetryJournalRecord;
  readonly encoded: string;
  readonly bytes: number;
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
    record.kind === "log" ? record.source ?? null : null,
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
  readonly limits: TelemetryJournalLimits;
  private readonly database: Database;
  private readonly deleteExpiredLog: Statement;
  private readonly deleteExpiredAnalytics: Statement;
  private readonly deleteExpiredRollups: Statement;
  private readonly upsertAnalyticsRollup: Statement;
  private readonly queue: QueuedRecord[] = [];
  private queuedBytes = 0;
  private persistedRecords = 0;
  private storedRecords = 0;
  private storedBytes = 0;
  private droppedRecords = 0;
  private truncatedRecords = 0;
  private malformedRecords = 0;
  private oversizedRecords = 0;
  private saturatedRecords = 0;
  private evictedRecords = 0;
  private lastRecordId = 0n;
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private readonly persistListeners = new Set<() => void>();
  private pumpScheduled = false;
  private pumpHandle?: ReturnType<typeof setImmediate>;
  private tail: Promise<void> = Promise.resolve();
  private state: TelemetryJournalSnapshot["state"] = "ready";
  private failure: unknown;

  constructor(options: TelemetryJournalOptions) {
    this.store = options.store;
    this.limits = Object.freeze({
      maxQueuedRecords: positiveInteger(
        options.limits?.maxQueuedRecords ?? DEFAULT_LIMITS.maxQueuedRecords,
        "telemetry journal maxQueuedRecords",
      ),
      maxQueuedBytes: positiveInteger(
        options.limits?.maxQueuedBytes ?? DEFAULT_LIMITS.maxQueuedBytes,
        "telemetry journal maxQueuedBytes",
      ),
      maxBatchRecords: positiveInteger(
        options.limits?.maxBatchRecords ?? DEFAULT_LIMITS.maxBatchRecords,
        "telemetry journal maxBatchRecords",
      ),
      maxRecordBytes: positiveInteger(
        options.limits?.maxRecordBytes ?? DEFAULT_LIMITS.maxRecordBytes,
        "telemetry journal maxRecordBytes",
      ),
      maxStoredRecords: positiveInteger(
        options.limits?.maxStoredRecords ?? DEFAULT_LIMITS.maxStoredRecords,
        "telemetry journal maxStoredRecords",
      ),
      maxStoredBytes: positiveInteger(
        options.limits?.maxStoredBytes ?? DEFAULT_LIMITS.maxStoredBytes,
        "telemetry journal maxStoredBytes",
      ),
    });
    this.database = this.store.database;
    this.store.register({
      name: "application-signals",
      initialize: (database) => {
        createJournalSchema(database);
        return [
          ...LOG_LEVELS.map((level) => Object.freeze({
            retention: level,
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.expire(this.deleteExpiredLog, [level, cutoffMs, limit]),
          })),
          Object.freeze({
            retention: "analytics" as const,
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.expire(this.deleteExpiredAnalytics, [cutoffMs, limit]),
          }),
          Object.freeze({
            retention: "rollups" as const,
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.deleteExpiredRollups.all(cutoffMs, limit).length,
          }),
        ];
      },
    });
    this.deleteExpiredLog = this.database.query(`
      DELETE FROM _ackerdb_telemetry_journal
      WHERE id IN (
        SELECT id FROM _ackerdb_telemetry_journal
        WHERE kind = 'log' AND level = ? AND timestamp < ?
        ORDER BY timestamp
        LIMIT ?
      )
      RETURNING payload_bytes AS bytes
    `);
    this.deleteExpiredAnalytics = this.database.query(`
      DELETE FROM _ackerdb_telemetry_journal
      WHERE id IN (
        SELECT id FROM _ackerdb_telemetry_journal
        WHERE kind = 'analytics' AND level IS NULL AND timestamp < ?
        ORDER BY timestamp
        LIMIT ?
      )
      RETURNING payload_bytes AS bytes
    `);
    this.deleteExpiredRollups = this.database.query(`
      DELETE FROM _ackerdb_telemetry_analytics_rollup
      WHERE rowid IN (
        SELECT rowid FROM _ackerdb_telemetry_analytics_rollup
        WHERE day < ?
        LIMIT ?
      )
      RETURNING rowid
    `);
    // Exact recompute of one (day, event) bucket from raw rows — count and
    // count-distinct-Identity stay honest under retroactive retention and
    // eviction, and the rollup doubles as the distinct-event-name registry.
    this.upsertAnalyticsRollup = this.database.query(`
      INSERT INTO _ackerdb_telemetry_analytics_rollup (day, event, count, uniques)
      SELECT ?1, ?2, COUNT(*), COUNT(DISTINCT identity)
      FROM _ackerdb_telemetry_journal
      WHERE kind = 'analytics' AND event = ?2
        AND timestamp >= ?1 AND timestamp < ?1 + ${DAY_MS}
      ON CONFLICT(day, event) DO UPDATE SET
        count = excluded.count,
        uniques = excluded.uniques
    `);
    const retained = this.database.query(`
      SELECT COUNT(*) AS records, COALESCE(SUM(payload_bytes), 0) AS bytes
      FROM _ackerdb_telemetry_journal
    `).get() as { readonly records: bigint; readonly bytes: bigint };
    const state = this.database.query(`
      SELECT evicted_records AS evictedRecords, last_record_id AS lastRecordId
      FROM _ackerdb_telemetry_state
      WHERE singleton = 1
    `).get() as { readonly evictedRecords: bigint; readonly lastRecordId: bigint };
    this.storedRecords = Number(retained.records);
    this.storedBytes = Number(retained.bytes);
    this.evictedRecords = Number(state.evictedRecords);
    this.lastRecordId = state.lastRecordId;
    this.store.maintain();
    this.enforceRetention();
  }

  /** Bounded per-class expiry; the caller's transaction owns durability. */
  private expire(statement: Statement, parameters: readonly (string | number)[]): number {
    const rows = statement.all(...parameters) as { readonly bytes: bigint }[];
    for (const row of rows) this.storedBytes -= Number(row.bytes);
    this.storedRecords -= rows.length;
    return rows.length;
  }

  append(record: TelemetryJournalRecord): boolean {
    if (this.state !== "ready") {
      this.droppedRecords++;
      return false;
    }
    if (record.truncated) this.truncatedRecords++;
    if (record.malformed) this.malformedRecords++;
    let encoded: string;
    try {
      encoded = encode(record);
    } catch {
      this.droppedRecords++;
      return false;
    }
    const bytes = Buffer.byteLength(encoded);
    if (
      bytes > this.limits.maxRecordBytes ||
      bytes > this.limits.maxStoredBytes ||
      bytes > this.limits.maxQueuedBytes
    ) {
      this.droppedRecords++;
      this.oversizedRecords++;
      return false;
    }
    if (
      this.queue.length >= this.limits.maxQueuedRecords ||
      this.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.droppedRecords++;
      this.saturatedRecords++;
      return false;
    }
    this.queue.push({ record, encoded, bytes });
    this.queuedBytes += bytes;
    this.schedulePump();
    return true;
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.state !== "ready") return;
    this.pumpScheduled = true;
    this.pumpHandle = setImmediate(() => {
      this.pumpScheduled = false;
      this.pumpHandle = undefined;
      this.enqueueBatch();
    });
    this.pumpHandle.unref?.();
  }

  private enqueueBatch(): void {
    if (this.queue.length === 0 || this.state === "failed" || this.state === "stopped") return;
    const batch = this.queue.splice(0, this.limits.maxBatchRecords);
    const bytes = batch.reduce((total, item) => total + item.bytes, 0);
    this.queuedBytes -= bytes;
    this.tail = this.tail.then(() => this.persist(batch)).catch((error) => {
      this.markFailed(error, batch.length);
    });
    if (this.queue.length > 0) this.schedulePump();
  }

  private persist(batch: readonly QueuedRecord[]): void {
    const insert = this.database.query(INSERT_JOURNAL_ROW);
    const before = {
      storedRecords: this.storedRecords,
      storedBytes: this.storedBytes,
      evictedRecords: this.evictedRecords,
      lastRecordId: this.lastRecordId,
    };
    try {
      this.database.transaction(() => {
        const touchedBuckets = new Map<string, { readonly day: number; readonly event: string }>();
        for (const item of batch) {
          const record = item.record;
          if (record.kind === "analytics") {
            const day = Math.floor(record.timestamp / DAY_MS) * DAY_MS;
            touchedBuckets.set(`${day}\0${record.event}`, { day, event: record.event });
          }
          const inserted = insert.run(...journalRowValues(record, item.bytes, item.encoded));
          this.lastRecordId = inserted.lastInsertRowid as bigint;
          this.storedRecords++;
          this.storedBytes += item.bytes;
        }
        for (const bucket of touchedBuckets.values()) {
          this.upsertAnalyticsRollup.run(bucket.day, bucket.event);
        }
        this.store.maintain();
        this.enforceRetention();
      })();
    } catch (error) {
      this.storedRecords = before.storedRecords;
      this.storedBytes = before.storedBytes;
      this.evictedRecords = before.evictedRecords;
      this.lastRecordId = before.lastRecordId;
      throw error;
    }
    this.persistedRecords += batch.length;
    for (const listener of this.persistListeners) {
      try {
        listener();
      } catch {
        // Export scheduling is downstream of durable local persistence.
      }
    }
  }

  async flush(): Promise<void> {
    for (;;) {
      if (this.pumpScheduled) {
        if (this.pumpHandle !== undefined) clearImmediate(this.pumpHandle);
        this.pumpScheduled = false;
        this.pumpHandle = undefined;
      }
      if (this.queue.length > 0) this.enqueueBatch();
      const tail = this.tail;
      await tail;
      if (!this.pumpScheduled && this.queue.length === 0 && tail === this.tail) break;
    }
    if (this.failure !== undefined) throw this.failure;
  }

  readBatch(afterId: bigint, limit: number): readonly TelemetryJournalEntry[] {
    positiveInteger(limit, "telemetry journal batch limit");
    return this.withStorage(() => {
      const rows = this.database.query(`
        SELECT id, payload
        FROM _ackerdb_telemetry_journal
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `).all(afterId, limit) as { readonly id: bigint; readonly payload: string }[];
      return Object.freeze(rows.map((row) => Object.freeze({
        ...(decode(row.payload) as TelemetryJournalRecord),
        id: row.id,
      })));
    });
  }

  snapshot(): TelemetryJournalSnapshot {
    return Object.freeze({
      state: this.state,
      queuedRecords: this.queue.length,
      queuedBytes: this.queuedBytes,
      persistedRecords: this.persistedRecords,
      storedRecords: this.storedRecords,
      storedBytes: this.storedBytes,
      droppedRecords: this.droppedRecords,
      truncatedRecords: this.truncatedRecords,
      malformedRecords: this.malformedRecords,
      oversizedRecords: this.oversizedRecords,
      saturatedRecords: this.saturatedRecords,
      evictedRecords: this.evictedRecords,
      ...(this.failure === undefined ? {} : { failure: this.failure }),
    });
  }

  onFailure(listener: (error: unknown) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  onPersist(listener: () => void): () => void {
    this.persistListeners.add(listener);
    return () => this.persistListeners.delete(listener);
  }

  consumerBatch(name: string, limit: number): TelemetryConsumerBatch {
    validateConsumerName(name);
    positiveInteger(limit, "telemetry journal batch limit");
    return this.withStorage(() => {
      this.ensureConsumer(name);
      let consumer = this.consumerSnapshot(name);
      const oldest = this.database.query(
        "SELECT MIN(id) AS id FROM _ackerdb_telemetry_journal",
      ).get() as { readonly id: bigint | null };
      const retainedFrontier = oldest.id === null ? this.lastRecordId : oldest.id - 1n;
      if (consumer.cursor < retainedFrontier) {
        const evicted = Number(retainedFrontier - consumer.cursor);
        this.database.query(`
          UPDATE _ackerdb_telemetry_consumers
          SET cursor = ?, evicted_records = evicted_records + ?
          WHERE name = ?
        `).run(retainedFrontier, evicted, name);
        consumer = this.consumerSnapshot(name);
      }
      return Object.freeze({
        records: this.readBatch(consumer.cursor, limit),
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
      const previous = this.consumerSnapshot(name);
      const accounted = (advance.exportedRecords ?? 0) +
        (advance.skippedUnsupported ?? 0) +
        (advance.skippedIdentity ?? 0);
      // Cursor-aware loss accounting: every id crossed by this advance was
      // exported, skipped, or no longer in storage. Per-class retention
      // deletes arbitrary rows, so holes between retained records are
      // evictions too — not only the prefix before MIN(id).
      const crossed = cursor > previous.cursor ? Number(cursor - previous.cursor) : 0;
      const evicted = Math.max(crossed - accounted, 0);
      this.database.query(`
        UPDATE _ackerdb_telemetry_consumers
        SET cursor = ?,
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
      return this.consumerSnapshot(name);
    });
  }

  recordConsumerFailure(name: string, timedOut: boolean): TelemetryConsumerSnapshot {
    validateConsumerName(name);
    return this.withStorage(() => {
      this.ensureConsumer(name);
      this.database.query(`
        UPDATE _ackerdb_telemetry_consumers
        SET failures = failures + 1, timed_out = timed_out + ?
        WHERE name = ?
      `).run(timedOut ? 1 : 0, name);
      return this.consumerSnapshot(name);
    });
  }

  consumerSnapshot(name: string): TelemetryConsumerSnapshot {
    validateConsumerName(name);
    return this.withStorage(() => {
      this.ensureConsumer(name);
      const row = this.database.query(`
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
    });
  }

  private withStorage<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  private markFailed(error: unknown, lostRecords = 0): void {
    this.droppedRecords += lostRecords;
    if (this.state === "failed" || this.state === "stopped") return;
    this.failure = error;
    this.state = "failed";
    if (this.pumpHandle !== undefined) clearImmediate(this.pumpHandle);
    this.pumpHandle = undefined;
    this.pumpScheduled = false;
    this.droppedRecords += this.queue.length;
    this.queue.length = 0;
    this.queuedBytes = 0;
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch {
        // A health observer cannot replace the journal's original failure.
      }
    }
  }

  private ensureConsumer(name: string): void {
    this.database.query(`
      INSERT OR IGNORE INTO _ackerdb_telemetry_consumers (
        name, cursor, exported_records, skipped_unsupported,
        skipped_identity, evicted_records, failures, timed_out
      ) VALUES (?, 0, 0, 0, 0, 0, 0, 0)
    `).run(name);
  }

  private enforceRetention(): void {
    while (
      this.storedRecords > this.limits.maxStoredRecords ||
      this.storedBytes > this.limits.maxStoredBytes
    ) {
      const rows = this.database.query(`
        SELECT id, payload_bytes AS bytes
        FROM _ackerdb_telemetry_journal
        ORDER BY id
        LIMIT ?
      `).all(this.limits.maxBatchRecords) as {
        readonly id: bigint;
        readonly bytes: bigint;
      }[];
      if (rows.length === 0) break;
      let removedRecords = 0;
      let removedBytes = 0;
      let lastId = 0n;
      for (const row of rows) {
        removedRecords++;
        removedBytes += Number(row.bytes);
        lastId = row.id;
        if (
          this.storedRecords - removedRecords <= this.limits.maxStoredRecords &&
          this.storedBytes - removedBytes <= this.limits.maxStoredBytes
        ) break;
      }
      this.database.query(
        "DELETE FROM _ackerdb_telemetry_journal WHERE id <= ?",
      ).run(lastId);
      this.storedRecords -= removedRecords;
      this.storedBytes -= removedBytes;
      this.evictedRecords += removedRecords;
    }
    this.database.query(`
      UPDATE _ackerdb_telemetry_state
      SET stored_records = ?, stored_bytes = ?, evicted_records = ?, last_record_id = ?
      WHERE singleton = 1
    `).run(this.storedRecords, this.storedBytes, this.evictedRecords, this.lastRecordId);
  }

  async drain(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "ready") this.state = "draining";
    await this.flush();
    this.state = "stopped";
  }

  /**
   * One synchronous terminal append — the structurally LAST durable record,
   * written after the queue drains and before the sidecar closes. Bypasses
   * the queue and the ready-state gate deliberately: the drain that stopped
   * this journal is exactly what made the terminal outcome known. A terminal
   * row that cannot be written fails LOUD: accounting marks the journal
   * failed and the error escapes to reject the drain — a clean resolution
   * with zero terminal rows is not a mode.
   */
  appendFinal(record: TelemetryJournalRecord): void {
    try {
      const encoded = encode(record);
      const bytes = Buffer.byteLength(encoded);
      this.database.transaction(() => {
        const inserted = this.database
          .query(INSERT_JOURNAL_ROW)
          .run(...journalRowValues(record, bytes, encoded));
        this.lastRecordId = inserted.lastInsertRowid as bigint;
        this.storedRecords++;
        this.storedBytes += bytes;
        this.database.query(`
          UPDATE _ackerdb_telemetry_state
          SET stored_records = ?, stored_bytes = ?, last_record_id = ?
          WHERE singleton = 1
        `).run(this.storedRecords, this.storedBytes, this.lastRecordId);
      })();
      this.persistedRecords++;
    } catch (error) {
      this.droppedRecords++;
      this.failure ??= error;
      this.state = "failed";
      throw error;
    }
  }
}

function createJournalTable(database: Database): void {
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
}

function createJournalSchema(database: Database): void {
  const hasSource = database.query(`
    SELECT COUNT(*) AS present
    FROM pragma_table_info('_ackerdb_telemetry_journal')
    WHERE name = 'source'
  `).get() as { readonly present: bigint };
  const hasJournal = database.query(`
    SELECT COUNT(*) AS present FROM pragma_table_info('_ackerdb_telemetry_journal')
  `).get() as { readonly present: bigint };
  let reclaimedRecords = 0n;
  if (hasJournal.present > 0n && hasSource.present === 0n) {
    // The read-model upgrade recreates the journal with promoted columns and
    // drops the short-TTL rows it held. Record ids stay monotone so a stored
    // consumer cursor observes the drop as eviction, never as id reuse.
    const previous = database.query(`
      SELECT COUNT(*) AS records, COALESCE(MAX(id), 0) AS lastId
      FROM _ackerdb_telemetry_journal
    `).get() as { readonly records: bigint; readonly lastId: bigint };
    const hasState = database.query(`
      SELECT COUNT(*) AS present FROM pragma_table_info('_ackerdb_telemetry_state')
    `).get() as { readonly present: bigint };
    const state = hasState.present > 0n
      ? database.query(`
          SELECT last_record_id AS lastRecordId FROM _ackerdb_telemetry_state WHERE singleton = 1
        `).get() as { readonly lastRecordId: bigint } | null
      : null;
    const lastId = state !== null && state.lastRecordId > previous.lastId
      ? state.lastRecordId
      : previous.lastId;
    database.exec("DROP TABLE _ackerdb_telemetry_journal");
    createJournalTable(database);
    if (lastId > 0n) {
      database.query(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('_ackerdb_telemetry_journal', ?)",
      ).run(lastId);
    }
    reclaimedRecords = previous.records;
  } else {
    createJournalTable(database);
  }
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
      uniques INTEGER NOT NULL,
      PRIMARY KEY (day, event)
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      stored_records INTEGER NOT NULL,
      stored_bytes INTEGER NOT NULL,
      evicted_records INTEGER NOT NULL,
      last_record_id INTEGER NOT NULL
    )
  `);
  database.query(`
    INSERT OR IGNORE INTO _ackerdb_telemetry_state (
      singleton, stored_records, stored_bytes, evicted_records, last_record_id
    ) VALUES (1, 0, 0, 0, 0)
  `).run();
  if (reclaimedRecords > 0n) {
    database.query(`
      UPDATE _ackerdb_telemetry_state
      SET evicted_records = evicted_records + ?
      WHERE singleton = 1
    `).run(reclaimedRecords);
  }
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
