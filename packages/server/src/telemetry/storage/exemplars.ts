/**
 * Where retained traces live: one row per exemplar, and nothing at all for the
 * traces the policy did not keep.
 *
 * There is no span table. Child spans earned independent rows only while
 * cross-trace percentile rank was computed by scanning them; rank now comes from
 * the aggregate, which sees 100% of traffic instead of a cohort deliberately
 * skewed toward slow and failed. No specified read needs a child span to be
 * queryable on its own, so the bounded tree rides as the row's payload and the
 * ten-million-row scan that justified the alternative does not exist.
 *
 * Every disclosure column the collector produces is stored. A reader that cannot
 * see why a trace was kept will read the table as a sample, and it is not one.
 */
import type { Database, Statement } from "bun:sqlite";
import type { TraceExemplar } from "../exemplars/collector.ts";
import type { TelemetryStore } from "./store.ts";

export interface TelemetryExemplarStoreSnapshot {
  readonly storedExemplars: number;
  readonly writtenExemplars: number;
  readonly expiredExemplars: number;
}

export class TelemetryExemplarStore {
  readonly store: TelemetryStore;
  private readonly database: Database;
  private readonly insert: Statement;
  private readonly deleteExpired: Statement;
  private storedExemplars = 0;
  private writtenExemplars = 0;
  private expiredExemplars = 0;

  constructor(store: TelemetryStore) {
    this.store = store;
    this.database = store.database;
    store.register({
      name: "exemplars",
      initialize: (database) => {
        createExemplarSchema(database);
        return [
          Object.freeze({
            retention: "traces" as const,
            deleteExpired: (cutoffMs: number, limit: number) => {
              const removed = this.deleteExpired.all(cutoffMs, limit).length;
              this.storedExemplars -= removed;
              this.expiredExemplars += removed;
              return removed;
            },
          }),
        ];
      },
    });
    this.insert = this.database.query(`
      INSERT INTO _ackerdb_telemetry_exemplars (
        trace_id, started_at, duration_ms, root_function, root_operation, outcome,
        error_count, reason, policy_version, threshold_ms, inclusion_probability,
        complete, oversized, observed_spans, omitted_spans, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id) DO NOTHING
    `);
    this.deleteExpired = this.database.query(`
      DELETE FROM _ackerdb_telemetry_exemplars
      WHERE trace_id IN (
        SELECT trace_id FROM _ackerdb_telemetry_exemplars
        WHERE started_at < ?
        ORDER BY started_at
        LIMIT ?
      )
      RETURNING trace_id
    `);
    this.storedExemplars = Number(
      (this.database.query(
        "SELECT COUNT(*) AS n FROM _ackerdb_telemetry_exemplars",
      ).get() as { readonly n: bigint }).n,
    );
  }

  /** Write one exemplar inside a transaction the caller owns. */
  writeDirect(exemplar: TraceExemplar): void {
    this.insert.run(
      exemplar.traceId,
      exemplar.startedAtMs,
      exemplar.durationMs,
      exemplar.rootFunction ?? null,
      exemplar.rootOperation ?? null,
      exemplar.outcome,
      exemplar.errorCount,
      exemplar.reason,
      exemplar.policyVersion,
      exemplar.thresholdMs ?? null,
      exemplar.inclusionProbability,
      exemplar.complete ? 1 : 0,
      exemplar.oversized ? 1 : 0,
      exemplar.observedSpans,
      exemplar.omittedSpans,
      exemplar.payload,
    );
    this.storedExemplars++;
    this.writtenExemplars++;
  }

  snapshot(): TelemetryExemplarStoreSnapshot {
    return Object.freeze({
      storedExemplars: this.storedExemplars,
      writtenExemplars: this.writtenExemplars,
      expiredExemplars: this.expiredExemplars,
    });
  }
}

function createExemplarSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _ackerdb_telemetry_exemplars (
      trace_id TEXT PRIMARY KEY,
      started_at REAL NOT NULL,
      duration_ms REAL NOT NULL,
      root_function TEXT,
      root_operation TEXT,
      outcome TEXT NOT NULL,
      error_count INTEGER NOT NULL,
      reason TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      threshold_ms REAL,
      inclusion_probability REAL NOT NULL,
      complete INTEGER NOT NULL,
      oversized INTEGER NOT NULL,
      observed_spans INTEGER NOT NULL,
      omitted_spans INTEGER NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_exemplars_started
    ON _ackerdb_telemetry_exemplars (started_at)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_exemplars_function
    ON _ackerdb_telemetry_exemplars (root_function, started_at)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_exemplars_reason
    ON _ackerdb_telemetry_exemplars (reason, started_at)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS _ackerdb_telemetry_exemplars_duration
    ON _ackerdb_telemetry_exemplars (duration_ms)
  `);
}
