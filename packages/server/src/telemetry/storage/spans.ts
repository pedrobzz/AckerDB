/**
 * The stored home of every span. No sampling: nothing decides which traces are
 * worth keeping, so the trace an operator is looking for is there. That is the
 * product decision #194 made, in exchange for a cost the recording path pays on
 * every operation whether or not anyone is reading.
 *
 * It is bounded best-effort capture, not a synchronous durability guarantee, on
 * exactly the terms ADR-0017 already sets for logs: the queue is finite and
 * drops observably when it saturates, a crash may lose the queued tail, and no
 * operation ever waits for the write.
 *
 * Spans queue off the recording hot path and land in bounded batches that also
 * write-maintain the per-trace summary and the hourly
 * `(hour, operation, function, outcome)` rollup that outlives raw spans. Only
 * handler-stage spans feed the rollup, so its count means calls rather than
 * stages. Both aggregates are maintained by increment, never recomputed from
 * raw rows: a recompute would cost a scan of the bucket on every batch.
 *
 * Size is the store's business, not this kind's. What is bounded here is this
 * kind's own memory — the queue and the batch.
 */
import type { Database, Statement } from "bun:sqlite";
import { AckerDBError } from "../../shared/errors.ts";
import type { TelemetrySpanRecord } from "../contracts/types.ts";
import { positiveInteger, type TelemetryStore } from "./store.ts";

export interface TelemetrySpanStoreLimits {
  readonly maxQueuedRecords: number;
  readonly maxBatchRecords: number;
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
  readonly failure?: unknown;
}

const DEFAULT_LIMITS: TelemetrySpanStoreLimits = Object.freeze({
  maxQueuedRecords: 8_192,
  maxBatchRecords: 512,
});

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

export class TelemetrySpanStore {
  readonly store: TelemetryStore;
  readonly limits: TelemetrySpanStoreLimits;
  private readonly database: Database;
  private readonly insertSpan: Statement;
  private readonly upsertRootTrace: Statement;
  private readonly upsertChildTrace: Statement;
  private readonly upsertRollup: Statement;
  private readonly deleteExpiredSpans: Statement;
  private readonly deleteExpiredTraces: Statement;
  private readonly deleteExpiredRollups: Statement;
  private readonly queue: TelemetrySpanRecord[] = [];
  private storedSpans = 0;
  private persistedSpans = 0;
  private droppedRecords = 0;
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
              const deleted = this.deleteExpiredSpans.all(cutoffMs, limit).length;
              this.storedSpans -= deleted;
              return deleted;
            },
          }),
          Object.freeze({
            retention: "spans" as const,
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.deleteExpiredTraces.all(cutoffMs, limit).length,
          }),
          Object.freeze({
            retention: "rollups" as const,
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.deleteExpiredRollups.all(cutoffMs, limit).length,
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
    this.deleteExpiredSpans = this.database.query(`
      DELETE FROM _ackerdb_telemetry_spans
      WHERE id IN (
        SELECT id FROM _ackerdb_telemetry_spans
        WHERE timestamp < ?
        ORDER BY timestamp
        LIMIT ?
      )
      RETURNING id
    `);
    this.deleteExpiredTraces = this.database.query(`
      DELETE FROM _ackerdb_telemetry_traces
      WHERE trace_id IN (
        SELECT trace_id FROM _ackerdb_telemetry_traces
        WHERE started_at < ?
        ORDER BY started_at
        LIMIT ?
      )
      RETURNING trace_id
    `);
    this.deleteExpiredRollups = this.database.query(`
      DELETE FROM _ackerdb_telemetry_span_rollup
      WHERE rowid IN (
        SELECT rowid FROM _ackerdb_telemetry_span_rollup
        WHERE hour < ?
        ORDER BY hour
        LIMIT ?
      )
      RETURNING rowid
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

  /**
   * Flush the queue; an optional MONOTONIC deadline (performance.now() basis)
   * makes the flush COOPERATIVE: once it passes, the unpersisted tail is
   * dropped instead of written, the in-flight batch still settles, and the
   * store is guaranteed quiescent when this resolves — reported as a deadline
   * error carrying the loss.
   */
  async flush(deadlineMonotonicMs?: number): Promise<void> {
    let deadlineDropped = 0;
    for (;;) {
      if (
        deadlineMonotonicMs !== undefined &&
        this.queue.length > 0 &&
        performance.now() >= deadlineMonotonicMs
      ) {
        deadlineDropped += this.queue.length;
        this.droppedRecords += this.queue.length;
        this.queue.length = 0;
      }
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
    if (deadlineDropped > 0) {
      throw new AckerDBError(
        "deadline_exceeded",
        `telemetry span store dropped ${deadlineDropped} queued spans at the shutdown deadline`,
        { resource: "operation" },
      );
    }
  }

  async drain(deadlineMonotonicMs?: number): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "ready") this.state = "draining";
    try {
      await this.flush(deadlineMonotonicMs);
    } finally {
      // A deadline overrun still quiesced (its loss is the thrown error); only
      // a failed store keeps its failed state.
      if (this.state === "draining") this.state = "stopped";
    }
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
      this.observeStorageFailure(error, batch.length);
    });
    if (this.queue.length > 0) this.schedulePump();
  }

  private persist(batch: readonly TelemetrySpanRecord[]): void {
    const storedBefore = this.storedSpans;
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
        this.store.maintain();
      })();
    } catch (error) {
      this.storedSpans = storedBefore;
      throw error;
    }
    this.persistedSpans += batch.length;
    for (const listener of this.persistListeners) {
      try {
        listener();
      } catch {
        // Downstream notification is downstream of durable local persistence.
      }
    }
  }

  /** One kind's loss is a drop; only a dead shared connection stops this store. */
  private observeStorageFailure(error: unknown, lostRecords: number): void {
    this.droppedRecords += lostRecords;
    if (this.state === "failed" || this.state === "stopped") return;
    if (this.store.observeFailure(error)) return;
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
