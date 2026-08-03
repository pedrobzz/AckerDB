import { Database } from "bun:sqlite";
import { decode, encode } from "@ackerdb/core";
import type { TelemetryJournalEntry, TelemetryJournalRecord } from "./types.ts";

export interface TelemetryJournalLimits {
  readonly maxQueuedRecords: number;
  readonly maxQueuedBytes: number;
  readonly maxBatchRecords: number;
  readonly maxRecordBytes: number;
  readonly maxStoredRecords: number;
  readonly maxStoredBytes: number;
}

export interface TelemetryJournalOptions {
  readonly path: string;
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export class TelemetryJournal {
  readonly path: string;
  readonly limits: TelemetryJournalLimits;
  private readonly database: Database;
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
    this.path = options.path;
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
    this.database = new Database(options.path, {
      create: true,
      safeIntegers: true,
      strict: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_generation TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp REAL NOT NULL,
        kind TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(process_generation, sequence)
      )
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        stored_records INTEGER NOT NULL,
        stored_bytes INTEGER NOT NULL,
        evicted_records INTEGER NOT NULL,
        last_record_id INTEGER NOT NULL
      )
    `);
    this.database.query(`
      INSERT OR IGNORE INTO _ackerdb_telemetry_state (
        singleton, stored_records, stored_bytes, evicted_records, last_record_id
      ) VALUES (1, 0, 0, 0, 0)
    `).run();
    this.database.exec(`
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
    this.enforceRetention();
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
    const insert = this.database.query(`
      INSERT INTO _ackerdb_telemetry_journal (
        process_generation, sequence, timestamp, kind, payload_bytes, payload
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const before = {
      storedRecords: this.storedRecords,
      storedBytes: this.storedBytes,
      evictedRecords: this.evictedRecords,
      lastRecordId: this.lastRecordId,
    };
    try {
      this.database.transaction(() => {
        for (const item of batch) {
          const inserted = insert.run(
            item.record.processGeneration,
            item.record.sequence,
            item.record.timestamp,
            item.record.kind,
            item.bytes,
            item.encoded,
          );
          this.lastRecordId = inserted.lastInsertRowid as bigint;
          this.storedRecords++;
          this.storedBytes += item.bytes;
        }
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
      this.database.query(`
        UPDATE _ackerdb_telemetry_consumers
        SET cursor = ?,
            exported_records = exported_records + ?,
            skipped_unsupported = skipped_unsupported + ?,
            skipped_identity = skipped_identity + ?
        WHERE name = ?
      `).run(
        cursor,
        advance.exportedRecords ?? 0,
        advance.skippedUnsupported ?? 0,
        advance.skippedIdentity ?? 0,
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
    try {
      await this.flush();
    } finally {
      try {
        this.database.close(false);
      } catch (error) {
        if (this.failure === undefined) throw error;
      }
    }
    this.state = "stopped";
  }
}

function validateConsumerName(name: string): void {
  if (name.length === 0 || name.length > 128) {
    throw new TypeError("telemetry consumer name must contain 1 to 128 characters");
  }
}
