import type { Database, Statement } from "bun:sqlite";
import type { TelemetrySpanRecord } from "../contracts/types.ts";
import type { TelemetryStore } from "./store.ts";

export interface TelemetrySpanStoreLimits {
  readonly maxQueuedRecords: number;
  readonly maxBatchRecords: number;
  /** Hard oldest-first bound on durably stored spans — the disk guard. */
  readonly maxStoredRecords: number;
}

export interface TelemetrySpanStoreOptions {
  /** The shared telemetry sidecar this kind homes its tables in. */
  readonly store: TelemetryStore;
  readonly limits?: Partial<TelemetrySpanStoreLimits>;
}

export interface TelemetrySpanStoreSnapshot {
  readonly state: "ready" | "draining" | "stopped" | "failed";
  readonly queuedRecords: number;
  readonly persistedSpans: number;
  readonly storedSpans: number;
  readonly droppedRecords: number;
  readonly evictedRecords: number;
  readonly failure?: unknown;
}

const DEFAULT_LIMITS: TelemetrySpanStoreLimits = Object.freeze({
  maxQueuedRecords: 8_192,
  maxBatchRecords: 512,
  maxStoredRecords: 500_000,
});

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

const HOUR_MS = 3_600_000;

function spanPayload(record: TelemetrySpanRecord): string {
  const payload: Record<string, unknown> = {};
  if (record.statement !== undefined) payload.statement = record.statement;
  if (record.resource !== undefined) payload.resource = record.resource;
  if (record.sizeBytes !== undefined) payload.sizeBytes = record.sizeBytes;
  if (record.rowCount !== undefined) payload.rowCount = record.rowCount;
  if (record.resultCount !== undefined) payload.resultCount = record.resultCount;
  if (record.replayed !== undefined) payload.replayed = record.replayed;
  if (record.dependencyCount !== undefined) payload.dependencyCount = record.dependencyCount;
  if (record.postCommit !== undefined) payload.postCommit = record.postCommit;
  if (record.requestId !== undefined) payload.requestId = record.requestId;
  if (record.connectionId !== undefined) payload.connectionId = record.connectionId;
  if (record.mutationId !== undefined) payload.mutationId = record.mutationId;
  if (record.commitId !== undefined) payload.commitId = record.commitId;
  if (record.subscriptionId !== undefined) payload.subscriptionId = record.subscriptionId;
  if (record.links !== undefined) payload.links = record.links;
  return JSON.stringify(payload);
}

/**
 * Durable home of every span — no sampling, the trace you are looking for is
 * always there. Spans queue off the recording hot path and land in bounded
 * batches that also write-maintain the per-trace summary and upsert the
 * hourly `(hour, operation, function, outcome)` rollup that outlives raw
 * spans. Handler-stage spans feed the rollup so its count means calls.
 */
export class TelemetrySpanStore {
  readonly store: TelemetryStore;
  readonly limits: TelemetrySpanStoreLimits;
  private readonly database: Database;
  private readonly insertSpan: Statement;
  private readonly upsertRootTrace: Statement;
  private readonly upsertChildTrace: Statement;
  private readonly upsertRollup: Statement;
  private readonly queue: TelemetrySpanRecord[] = [];
  private storedSpans = 0;
  private persistedSpans = 0;
  private droppedRecords = 0;
  private evictedRecords = 0;
  private readonly persistListeners = new Set<() => void>();
  private pumpScheduled = false;
  private pumpHandle?: ReturnType<typeof setImmediate>;
  private tail: Promise<void> = Promise.resolve();
  private state: TelemetrySpanStoreSnapshot["state"] = "ready";
  private failure: unknown;

  constructor(options: TelemetrySpanStoreOptions) {
    this.store = options.store;
    this.limits = Object.freeze({
      maxQueuedRecords: positiveInteger(
        options.limits?.maxQueuedRecords ?? DEFAULT_LIMITS.maxQueuedRecords,
        "telemetry span store maxQueuedRecords",
      ),
      maxBatchRecords: positiveInteger(
        options.limits?.maxBatchRecords ?? DEFAULT_LIMITS.maxBatchRecords,
        "telemetry span store maxBatchRecords",
      ),
      maxStoredRecords: positiveInteger(
        options.limits?.maxStoredRecords ?? DEFAULT_LIMITS.maxStoredRecords,
        "telemetry span store maxStoredRecords",
      ),
    });
    this.database = this.store.database;
    this.store.register({
      name: "traces",
      initialize: (database) => {
        createSpanSchema(database);
        return [
          Object.freeze({
            retention: "spans" as const,
            deleteExpired: (cutoffMs: number, limit: number) => {
              const deleted = this.database.query(`
                DELETE FROM _ackerdb_telemetry_spans
                WHERE id IN (
                  SELECT id FROM _ackerdb_telemetry_spans
                  WHERE timestamp < ?
                  ORDER BY timestamp
                  LIMIT ?
                )
                RETURNING id
              `).all(cutoffMs, limit).length;
              this.storedSpans -= deleted;
              return deleted;
            },
          }),
          Object.freeze({
            retention: "spans" as const,
            deleteExpired: (cutoffMs: number, limit: number) => this.database.query(`
              DELETE FROM _ackerdb_telemetry_traces
              WHERE trace_id IN (
                SELECT trace_id FROM _ackerdb_telemetry_traces
                WHERE started_at < ?
                ORDER BY started_at
                LIMIT ?
              )
              RETURNING trace_id
            `).all(cutoffMs, limit).length,
          }),
          Object.freeze({
            retention: "rollups" as const,
            deleteExpired: (cutoffMs: number, limit: number) => this.database.query(`
              DELETE FROM _ackerdb_telemetry_span_rollup
              WHERE rowid IN (
                SELECT rowid FROM _ackerdb_telemetry_span_rollup
                WHERE hour < ?
                LIMIT ?
              )
              RETURNING rowid
            `).all(cutoffMs, limit).length,
          }),
        ];
      },
    });
    this.insertSpan = this.database.query(`
      INSERT INTO _ackerdb_telemetry_spans (
        timestamp, trace_id, span_id, parent_span_id, function_address,
        operation, stage, outcome, duration_ms, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertRootTrace = this.database.query(`
      INSERT INTO _ackerdb_telemetry_traces (
        trace_id, root_function, operation, started_at, duration_ms, span_count, error_count
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(trace_id) DO UPDATE SET
        root_function = COALESCE(excluded.root_function, root_function),
        operation = COALESCE(excluded.operation, operation),
        started_at = MIN(started_at, excluded.started_at),
        duration_ms = MAX(duration_ms, excluded.duration_ms),
        span_count = span_count + 1,
        error_count = error_count + excluded.error_count
    `);
    this.upsertChildTrace = this.database.query(`
      INSERT INTO _ackerdb_telemetry_traces (
        trace_id, root_function, operation, started_at, duration_ms, span_count, error_count
      ) VALUES (?, NULL, NULL, ?, 0, 1, ?)
      ON CONFLICT(trace_id) DO UPDATE SET
        started_at = MIN(started_at, excluded.started_at),
        span_count = span_count + 1,
        error_count = error_count + excluded.error_count
    `);
    this.upsertRollup = this.database.query(`
      INSERT INTO _ackerdb_telemetry_span_rollup (
        hour, operation, function_address, outcome, count, total_ms, min_ms, max_ms
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(hour, operation, function_address, outcome) DO UPDATE SET
        count = count + 1,
        total_ms = total_ms + excluded.total_ms,
        min_ms = MIN(min_ms, excluded.min_ms),
        max_ms = MAX(max_ms, excluded.max_ms)
    `);
    const retained = this.database.query(
      "SELECT COUNT(*) AS spans FROM _ackerdb_telemetry_spans",
    ).get() as { readonly spans: bigint };
    this.storedSpans = Number(retained.spans);
  }

  append(record: TelemetrySpanRecord): boolean {
    if (this.state !== "ready" || this.queue.length >= this.limits.maxQueuedRecords) {
      this.droppedRecords++;
      return false;
    }
    this.queue.push(record);
    this.schedulePump();
    return true;
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

  async drain(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "ready") this.state = "draining";
    await this.flush();
    this.state = "stopped";
  }

  onPersist(listener: () => void): () => void {
    this.persistListeners.add(listener);
    return () => this.persistListeners.delete(listener);
  }

  snapshot(): TelemetrySpanStoreSnapshot {
    return Object.freeze({
      state: this.state,
      queuedRecords: this.queue.length,
      persistedSpans: this.persistedSpans,
      storedSpans: this.storedSpans,
      droppedRecords: this.droppedRecords,
      evictedRecords: this.evictedRecords,
      ...(this.failure === undefined ? {} : { failure: this.failure }),
    });
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
    this.tail = this.tail.then(() => this.persist(batch)).catch((error) => {
      this.markFailed(error, batch.length);
    });
    if (this.queue.length > 0) this.schedulePump();
  }

  private persist(batch: readonly TelemetrySpanRecord[]): void {
    const before = {
      storedSpans: this.storedSpans,
      evictedRecords: this.evictedRecords,
    };
    try {
      this.database.transaction(() => {
        for (const record of batch) {
          this.insertSpan.run(
            record.timestampMs,
            record.traceId ?? null,
            record.spanId ?? null,
            record.parentSpanId ?? null,
            record.function ?? null,
            record.operation,
            record.stage,
            record.outcome,
            record.durationMs,
            spanPayload(record),
          );
          this.storedSpans++;
          const errors = record.outcome === "ok" ? 0 : 1;
          if (record.traceId !== undefined) {
            if (record.parentSpanId === undefined) {
              this.upsertRootTrace.run(
                record.traceId,
                record.function ?? null,
                record.operation,
                record.timestampMs,
                record.durationMs,
                errors,
              );
            } else {
              this.upsertChildTrace.run(record.traceId, record.timestampMs, errors);
            }
          }
          if (record.stage === "handler") {
            this.upsertRollup.run(
              Math.floor(record.timestampMs / HOUR_MS) * HOUR_MS,
              record.operation,
              record.function ?? "",
              record.outcome,
              record.durationMs,
              record.durationMs,
              record.durationMs,
            );
          }
        }
        this.enforceStoredBound();
        this.store.maintain();
      })();
    } catch (error) {
      this.storedSpans = before.storedSpans;
      this.evictedRecords = before.evictedRecords;
      throw error;
    }
    this.persistedSpans += batch.length;
    for (const listener of this.persistListeners) {
      try {
        listener();
      } catch {
        // Invalidation scheduling is downstream of durable local persistence.
      }
    }
  }

  private enforceStoredBound(): void {
    while (this.storedSpans > this.limits.maxStoredRecords) {
      const evicted = this.database.query(`
        DELETE FROM _ackerdb_telemetry_spans
        WHERE id IN (
          SELECT id FROM _ackerdb_telemetry_spans ORDER BY id LIMIT ?
        )
        RETURNING id
      `).all(
        Math.min(this.storedSpans - this.limits.maxStoredRecords, this.limits.maxBatchRecords),
      ).length;
      if (evicted === 0) break;
      this.storedSpans -= evicted;
      this.evictedRecords += evicted;
    }
  }

  private markFailed(error: unknown, lostRecords: number): void {
    this.droppedRecords += lostRecords;
    if (this.state === "failed" || this.state === "stopped") return;
    this.failure = error;
    this.state = "failed";
    if (this.pumpHandle !== undefined) clearImmediate(this.pumpHandle);
    this.pumpHandle = undefined;
    this.pumpScheduled = false;
    this.droppedRecords += this.queue.length;
    this.queue.length = 0;
  }
}

function createSpanSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp REAL NOT NULL,
      trace_id TEXT,
      span_id TEXT,
      parent_span_id TEXT,
      function_address TEXT,
      operation TEXT NOT NULL,
      stage TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_spans_trace
    ON _ackerdb_telemetry_spans (trace_id, id) WHERE trace_id IS NOT NULL
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_spans_function
    ON _ackerdb_telemetry_spans (function_address, timestamp)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_spans_timestamp
    ON _ackerdb_telemetry_spans (timestamp)
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_traces (
      trace_id TEXT PRIMARY KEY,
      root_function TEXT,
      operation TEXT,
      started_at REAL NOT NULL,
      duration_ms REAL NOT NULL,
      span_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_traces_started
    ON _ackerdb_telemetry_traces (started_at)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_traces_duration
    ON _ackerdb_telemetry_traces (duration_ms)
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_span_rollup (
      hour INTEGER NOT NULL,
      operation TEXT NOT NULL,
      function_address TEXT NOT NULL,
      outcome TEXT NOT NULL,
      count INTEGER NOT NULL,
      total_ms REAL NOT NULL,
      min_ms REAL NOT NULL,
      max_ms REAL NOT NULL,
      PRIMARY KEY (hour, operation, function_address, outcome)
    )
  `);
}
