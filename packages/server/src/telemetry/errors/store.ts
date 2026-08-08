/**
 * Error groups are the index of every unhandled failure the application has
 * ever seen. They deliberately have no retention clock — an index that forgets
 * is not one — and each keeps its latest sanitized sample so an old group still
 * shows a stack after its occurrences expire on the error clock. A new
 * occurrence on a resolved group reopens it with the regressed mark, which is
 * what turns the list from a museum into an inbox.
 */
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

export class TelemetryErrorStore {
  readonly store: TelemetryStore;
  private readonly database: Database;
  private readonly upsertGroup: Statement;
  private readonly insertOccurrence: Statement;
  private readonly deleteExpiredOccurrences: Statement;
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
            deleteExpired: (cutoffMs: number, limit: number) =>
              this.deleteExpiredOccurrences.all(cutoffMs, limit).length,
          }),
        ];
      },
    });
    this.upsertGroup = this.database.query(`
      INSERT INTO _ackerdb_telemetry_error_groups (
        hash, algo_version, name, message, times_seen, first_seen, last_seen,
        status, regressed, revision, sample_stack, sample_trace_id
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 'unresolved', 0, 1, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        algo_version = excluded.algo_version,
        name = excluded.name,
        message = excluded.message,
        times_seen = times_seen + 1,
        last_seen = excluded.last_seen,
        revision = revision + 1,
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
    this.deleteExpiredOccurrences = this.database.query(`
      DELETE FROM _ackerdb_telemetry_error_occurrences
      WHERE id IN (
        SELECT id FROM _ackerdb_telemetry_error_occurrences
        WHERE timestamp < ?
        ORDER BY timestamp
        LIMIT ?
      )
      RETURNING id
    `);
  }

  /**
   * The failure funnel's ingest: fingerprint the live error, upsert its group,
   * record the occurrence. Total — a storage failure is an accounted drop and
   * never escapes into the operation that was already failing. Whether the
   * sidecar itself is finished is the store's judgement, not this kind's.
   */
  ingest(input: TelemetryErrorIngest): boolean {
    try {
      this.database.transaction(() => {
        this.ingestDirect(input);
        this.store.maintain();
      })();
      return true;
    } catch (error) {
      this.droppedErrors++;
      this.store.observeFailure(error);
      return false;
    }
  }

  /** Group one error inside a transaction the CALLER owns. */
  ingestDirect(input: TelemetryErrorIngest): void {
    const fingerprinted = fingerprintError(input.error);
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
    this.ingestedErrors++;
  }

  /**
   * Resolving clears the regressed mark; ingest reopens on the next occurrence.
   * Compare-and-set on the observed `revision` — a monotonic counter every
   * ingest advances, so even two occurrences in the same millisecond never
   * share a token: an occurrence arriving between the operator's read and their
   * resolve reopens the group, and the stale resolve surfaces as a conflict
   * instead of silently erasing that regression.
   */
  resolve(
    hash: string,
    resolved: boolean,
    observedRevision: bigint,
  ): TelemetryErrorResolveOutcome {
    const changes = this.database.query(`
      UPDATE _ackerdb_telemetry_error_groups
      SET status = ?, regressed = CASE WHEN ? THEN 0 ELSE regressed END
      WHERE hash = ? AND revision = ?
    `).run(resolved ? "resolved" : "unresolved", resolved ? 1 : 0, hash, observedRevision);
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
      revision INTEGER NOT NULL,
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
