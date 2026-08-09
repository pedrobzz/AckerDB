/**
 * Where the aggregate lands: minute rows for the windows an operator watches,
 * hourly rows merged from them for the long horizon, and a coverage row per
 * minute so a gap can be told from a quiet period.
 *
 * **Coverage is the honest half.** A minute with no row is ambiguous — no
 * traffic, or a process that died before writing it? The coverage table answers
 * that: a minute is announced when its first observation arrives and marked
 * closed only once the whole minute has been handed over. A generation that
 * crashes leaves its minute announced and unclosed, so the next one reports the
 * window as incomplete instead of presenting a smaller count as exact.
 *
 * Hourly rows are merged from minute rows rather than recomputed from anything,
 * because a sketch merge is exact: the hour's count, error count and total are
 * the minutes' sums, and its quantiles carry the same relative error as theirs.
 */
import type { Database, Statement } from "bun:sqlite";
import type { AggregateSeriesRow } from "../aggregation/buckets.ts";
import { HOUR_MS, MINUTE_MS, mergeIntoHour } from "../aggregation/buckets.ts";
import type { TelemetryStore } from "./store.ts";

export interface TelemetryAggregateStoreSnapshot {
  readonly writtenMinuteRows: number;
  readonly writtenHourRows: number;
  readonly announcedMinutes: number;
  readonly closedMinutes: number;
  readonly expiredRows: number;
}

export class TelemetryAggregateStore {
  readonly store: TelemetryStore;
  private readonly database: Database;
  private readonly upsertMinute: Statement;
  private readonly upsertHour: Statement;
  private readonly announceMinute: Statement;
  private readonly closeMinute: Statement;
  private readonly deleteExpiredMinutes: Statement;
  private readonly deleteExpiredHours: Statement;
  private readonly deleteExpiredCoverage: Statement;
  private writtenMinuteRows = 0;
  private writtenHourRows = 0;
  private announcedMinutes = 0;
  private closedMinutes = 0;
  private expiredRows = 0;

  constructor(store: TelemetryStore, private readonly generation: string) {
    this.store = store;
    this.database = store.database;
    store.register({
      name: "aggregate",
      initialize: (database) => {
        createAggregateSchema(database);
        return [
          Object.freeze({
            retention: "minutes" as const,
            deleteExpired: (cutoffMs: number, limit: number) => {
              const removed = this.deleteExpiredMinutes.all(cutoffMs, limit).length;
              this.expiredRows += removed;
              return removed;
            },
          }),
          Object.freeze({
            retention: "minutes" as const,
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.deleteExpiredCoverage.all(cutoffMs, limit).length,
          }),
          Object.freeze({
            retention: "rollups" as const,
            deleteExpired: (cutoffMs: number, limit: number) => {
              const removed = this.deleteExpiredHours.all(cutoffMs, limit).length;
              this.expiredRows += removed;
              return removed;
            },
          }),
        ];
      },
    });
    const columns = `
      bucket_start, operation, function_address, overflow, count, error_count,
      total_ms, min_ms, max_ms, collapsed, low_confidence, sketch_ok, sketch_failed
    `;
    // A minute is written once, but a forced handover at drain can revisit one
    // that already has a row; adding rather than replacing keeps the row the sum
    // of everything the generation observed in it.
    this.upsertMinute = this.database.query(`
      INSERT INTO _ackerdb_telemetry_aggregate_minute (${columns})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start, operation, function_address) DO UPDATE SET
        count = count + excluded.count,
        error_count = error_count + excluded.error_count,
        total_ms = total_ms + excluded.total_ms,
        min_ms = MIN(min_ms, excluded.min_ms),
        max_ms = MAX(max_ms, excluded.max_ms),
        collapsed = MAX(collapsed, excluded.collapsed),
        low_confidence = excluded.low_confidence,
        sketch_ok = excluded.sketch_ok,
        sketch_failed = excluded.sketch_failed
    `);
    this.upsertHour = this.database.query(`
      INSERT INTO _ackerdb_telemetry_aggregate_hour (${columns})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start, operation, function_address) DO UPDATE SET
        count = count + excluded.count,
        error_count = error_count + excluded.error_count,
        total_ms = total_ms + excluded.total_ms,
        min_ms = MIN(min_ms, excluded.min_ms),
        max_ms = MAX(max_ms, excluded.max_ms),
        collapsed = MAX(collapsed, excluded.collapsed),
        low_confidence = excluded.low_confidence,
        sketch_ok = excluded.sketch_ok,
        sketch_failed = excluded.sketch_failed
    `);
    this.announceMinute = this.database.query(`
      INSERT INTO _ackerdb_telemetry_aggregate_coverage (minute, generation, closed)
      VALUES (?, ?, 0)
      ON CONFLICT(minute) DO NOTHING
    `);
    this.closeMinute = this.database.query(`
      UPDATE _ackerdb_telemetry_aggregate_coverage SET closed = 1, generation = ?
      WHERE minute = ?
    `);
    this.deleteExpiredMinutes = this.database.query(`
      DELETE FROM _ackerdb_telemetry_aggregate_minute
      WHERE rowid IN (
        SELECT rowid FROM _ackerdb_telemetry_aggregate_minute
        WHERE bucket_start < ? ORDER BY bucket_start LIMIT ?
      ) RETURNING rowid
    `);
    this.deleteExpiredHours = this.database.query(`
      DELETE FROM _ackerdb_telemetry_aggregate_hour
      WHERE rowid IN (
        SELECT rowid FROM _ackerdb_telemetry_aggregate_hour
        WHERE bucket_start < ? ORDER BY bucket_start LIMIT ?
      ) RETURNING rowid
    `);
    this.deleteExpiredCoverage = this.database.query(`
      DELETE FROM _ackerdb_telemetry_aggregate_coverage
      WHERE minute IN (
        SELECT minute FROM _ackerdb_telemetry_aggregate_coverage
        WHERE minute < ? ORDER BY minute LIMIT ?
      ) RETURNING minute
    `);
  }

  /**
   * Persist one handed-over bucket inside a transaction the caller owns, and
   * roll it into its hour. `closed` decides whether the minute may be called
   * complete; a forced handover at drain writes the rows and leaves the coverage
   * row open, because the minute genuinely is not over.
   */
  writeDirect(startMs: number, closed: boolean, rows: readonly AggregateSeriesRow[]): void {
    this.announceMinute.run(startMs, this.generation);
    this.announcedMinutes++;
    for (const row of rows) {
      this.upsertMinute.run(...values(row));
      this.writtenMinuteRows++;
    }
    for (const hour of mergeIntoHour(rows)) {
      this.upsertHour.run(...values(hour));
      this.writtenHourRows++;
    }
    if (closed) {
      this.closeMinute.run(this.generation, startMs);
      this.closedMinutes++;
    }
  }

  /**
   * Minutes a previous generation announced and never closed. Their rows hold
   * whatever was written before the process stopped, which is a real number for
   * an unknown fraction of the minute — reported as incomplete rather than
   * silently read as the whole window.
   */
  incompleteMinutes(limit = 64): readonly number[] {
    return (this.database.query(`
      SELECT minute FROM _ackerdb_telemetry_aggregate_coverage
      WHERE closed = 0 AND generation <> ?
      ORDER BY minute DESC LIMIT ?
    `).all(this.generation, limit) as { readonly minute: bigint }[])
      .map((row) => Number(row.minute));
  }

  snapshot(): TelemetryAggregateStoreSnapshot {
    return Object.freeze({
      writtenMinuteRows: this.writtenMinuteRows,
      writtenHourRows: this.writtenHourRows,
      announcedMinutes: this.announcedMinutes,
      closedMinutes: this.closedMinutes,
      expiredRows: this.expiredRows,
    });
  }
}

function values(row: AggregateSeriesRow): readonly (string | number)[] {
  return [
    row.startMs,
    row.operation,
    row.functionAddress,
    row.overflow ? 1 : 0,
    row.count,
    row.errorCount,
    row.totalMs,
    row.minMs,
    row.maxMs,
    row.collapsed ? 1 : 0,
    JSON.stringify(row.lowConfidenceQuantiles),
    row.sketchOk,
    row.sketchFailed,
  ];
}

function createAggregateSchema(database: Database): void {
  for (const [table, width] of [
    ["_ackerdb_telemetry_aggregate_minute", MINUTE_MS],
    ["_ackerdb_telemetry_aggregate_hour", HOUR_MS],
  ] as const) {
    void width;
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        bucket_start INTEGER NOT NULL,
        operation TEXT NOT NULL,
        function_address TEXT NOT NULL,
        overflow INTEGER NOT NULL,
        count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        total_ms REAL NOT NULL,
        min_ms REAL NOT NULL,
        max_ms REAL NOT NULL,
        collapsed INTEGER NOT NULL,
        low_confidence TEXT NOT NULL,
        sketch_ok TEXT NOT NULL,
        sketch_failed TEXT NOT NULL,
        PRIMARY KEY (bucket_start, operation, function_address)
      )
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS ${table}_function
      ON ${table} (function_address, bucket_start)
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_aggregate_coverage (
      minute INTEGER PRIMARY KEY,
      generation TEXT NOT NULL,
      closed INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_aggregate_coverage_open
    ON _ackerdb_telemetry_aggregate_coverage (closed, minute)
  `);
}
