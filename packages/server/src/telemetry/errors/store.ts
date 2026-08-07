import type { Database, Statement } from "bun:sqlite";
import type { TelemetryStore } from "../storage/store.ts";
import { fingerprintError } from "./fingerprint.ts";

export interface TelemetryErrorIngest {
  readonly error: unknown;
  readonly timestampMs: number;
  readonly functionAddress?: string;
  readonly traceId?: string;
}

export interface TelemetryErrorStoreOptions {
  /** The shared telemetry sidecar this kind homes its tables in. */
  readonly store: TelemetryStore;
}

export interface TelemetryErrorStoreSnapshot {
  readonly ingestedErrors: number;
  readonly droppedErrors: number;
}

/** A stale resolve is a conflict as data — the caller re-reads and decides. */
export type TelemetryErrorResolveOutcome = "applied" | "conflict" | "not_found";

/**
 * Error groups are the index of every unhandled failure the application has
 * ever seen — deliberately not a retention class, they never expire, and each
 * keeps its latest sanitized sample so old groups still show a stack after
 * their occurrences expire on the error clock (1mo). A new occurrence on a
 * resolved group reopens it with the regressed mark — the piece that turns
 * the list from an error museum into an actionable inbox.
 */
export class TelemetryErrorStore {
  readonly store: TelemetryStore;
  private readonly database: Database;
  private readonly upsertGroup: Statement;
  private readonly insertOccurrence: Statement;
  private ingestedErrors = 0;
  private droppedErrors = 0;

  constructor(options: TelemetryErrorStoreOptions) {
    this.store = options.store;
    this.database = this.store.database;
    this.store.register({
      name: "errors",
      initialize: (database) => {
        createErrorSchema(database);
        return [
          Object.freeze({
            retention: "error" as const,
            deleteExpired: (cutoffMs: number, limit: number) => this.database.query(`
              DELETE FROM _ackerdb_telemetry_error_occurrences
              WHERE id IN (
                SELECT id FROM _ackerdb_telemetry_error_occurrences
                WHERE timestamp < ?
                ORDER BY timestamp
                LIMIT ?
              )
              RETURNING id
            `).all(cutoffMs, limit).length,
          }),
        ];
      },
    });
    this.upsertGroup = this.database.query(`
      INSERT INTO _ackerdb_telemetry_error_groups (
        hash, algo_version, name, message, times_seen, first_seen, last_seen,
        status, regressed, sample_stack, sample_trace_id
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 'unresolved', 0, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        algo_version = excluded.algo_version,
        name = excluded.name,
        message = excluded.message,
        times_seen = times_seen + 1,
        last_seen = excluded.last_seen,
        sample_stack = excluded.sample_stack,
        sample_trace_id = COALESCE(excluded.sample_trace_id, sample_trace_id),
        regressed = CASE WHEN status = 'resolved' THEN 1 ELSE regressed END,
        status = CASE WHEN status = 'resolved' THEN 'unresolved' ELSE status END
    `);
    this.insertOccurrence = this.database.query(`
      INSERT INTO _ackerdb_telemetry_error_occurrences (
        timestamp, group_hash, trace_id, function_address
      ) VALUES (?, ?, ?, ?)
    `);
  }

  /**
   * The single failure funnel's ingest: fingerprint the live error, upsert
   * its group, and record the occurrence. Total — a storage failure counts
   * as dropped and never escapes into the failing operation.
   */
  ingest(input: TelemetryErrorIngest): boolean {
    try {
      const fingerprinted = fingerprintError(input.error);
      this.database.transaction(() => {
        this.upsertGroup.run(
          fingerprinted.hash,
          fingerprinted.algoVersion,
          fingerprinted.name,
          fingerprinted.message,
          input.timestampMs,
          input.timestampMs,
          fingerprinted.stack,
          input.traceId ?? null,
        );
        this.insertOccurrence.run(
          input.timestampMs,
          fingerprinted.hash,
          input.traceId ?? null,
          input.functionAddress ?? null,
        );
        this.store.maintain();
      })();
      this.ingestedErrors++;
      return true;
    } catch {
      this.droppedErrors++;
      return false;
    }
  }

  /**
   * Resolving clears the regressed mark; ingest reopens on the next
   * occurrence. Compare-and-set on the observed `last_seen`: an occurrence
   * arriving between the operator's read and their resolve reopens the group,
   * and the stale resolve must surface as a conflict instead of silently
   * erasing that regression.
   */
  resolve(
    hash: string,
    resolved: boolean,
    observedLastSeenMs: number,
  ): TelemetryErrorResolveOutcome {
    const changes = this.database.query(`
      UPDATE _ackerdb_telemetry_error_groups
      SET status = ?, regressed = CASE WHEN ? THEN 0 ELSE regressed END
      WHERE hash = ? AND last_seen = ?
    `).run(resolved ? "resolved" : "unresolved", resolved ? 1 : 0, hash, observedLastSeenMs);
    if (changes.changes > 0) return "applied";
    const exists = this.database.query(
      "SELECT 1 FROM _ackerdb_telemetry_error_groups WHERE hash = ?",
    ).get(hash);
    return exists === null ? "not_found" : "conflict";
  }

  snapshot(): TelemetryErrorStoreSnapshot {
    return Object.freeze({
      ingestedErrors: this.ingestedErrors,
      droppedErrors: this.droppedErrors,
    });
  }
}

function createErrorSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_error_groups (
      hash TEXT PRIMARY KEY,
      algo_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      times_seen INTEGER NOT NULL,
      first_seen REAL NOT NULL,
      last_seen REAL NOT NULL,
      status TEXT NOT NULL,
      regressed INTEGER NOT NULL,
      sample_stack TEXT NOT NULL,
      sample_trace_id TEXT
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_error_groups_last_seen
    ON _ackerdb_telemetry_error_groups (last_seen)
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_error_occurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp REAL NOT NULL,
      group_hash TEXT NOT NULL,
      trace_id TEXT,
      function_address TEXT
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_error_occurrences_group
    ON _ackerdb_telemetry_error_occurrences (group_hash, id)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_error_occurrences_trace
    ON _ackerdb_telemetry_error_occurrences (trace_id)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_error_occurrences_timestamp
    ON _ackerdb_telemetry_error_occurrences (timestamp)
  `);
}
