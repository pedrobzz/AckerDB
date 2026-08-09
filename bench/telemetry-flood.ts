/**
 * Scenario 6: the error storm, and the amplification it used to cause.
 *
 * Scenario 1 drove the retained fraction to 100% and asked whether the WORKER
 * held. It did. This asks the question that one did not: what the store does
 * about it. Tail sampling retains every error as a full exemplar, which is
 * correct at a 1% error rate and catastrophic at 100% — and a flood, a crash
 * loop, a retry storm or one misconfigured poller all make it 100%. At 2,099
 * bytes an exemplar against 316 a log row, unbounded retention fills the store
 * about seven times faster exactly when the application is under attack.
 *
 * The claim under test is that bytes written per operation does NOT multiply
 * when every operation fails. The aggregate is bounded by cardinality, so it
 * cannot grow with traffic; only the specimens can, and admission sheds those
 * as pressure rises. Nothing about the incident's shape is lost — the counts,
 * the error counts and the distributions are all in the aggregate — so the run
 * also checks that the aggregate observed every operation in both phases.
 *
 *   bun bench/telemetry-flood.ts [opsPerSecond] [secondsPerPhase]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TelemetryWorkerWriter } from "../packages/server/src/telemetry/storage/worker/writer.ts";
import { MINUTE_MS } from "../packages/server/src/telemetry/aggregation/buckets.ts";
import { Telemetry } from "../packages/server/src/telemetry/telemetry.ts";

const SPANS_PER_OPERATION = 7;

/**
 * A byte target small enough that a minute of flood traffic actually reaches
 * it. The admission gate keys on the store's own pressure, so making the store
 * small is the honest way to reach the pressure a production-sized store meets
 * after hours of the same attack — the mechanism under test is identical.
 */
const DEFAULT_MAX_STORED_BYTES = 24 * 1024 * 1024;

export interface FloodPhase {
  readonly label: string;
  readonly errorShare: number;
  readonly operations: number;
  readonly observations: number;
  readonly retainedTraces: number;
  readonly exemplarsAccepted: number;
  readonly exemplarsShed: number;
  readonly storedBytesDelta: number;
  readonly bytesPerOperation: number;
  readonly pressure: number;
}

export interface FloodResult {
  readonly phases: readonly FloodPhase[];
  readonly amplification: number;
  readonly aggregateSawEverything: boolean;
  readonly shedByReason: Readonly<Record<string, number>>;
  readonly onDisk: Readonly<Record<string, number>>;
}

export async function runFlood(
  opsPerSecond = 3_000,
  secondsPerPhase = 20,
  maxStoredBytes = DEFAULT_MAX_STORED_BYTES,
): Promise<FloodResult> {
  const dir = mkdtempSync(join(tmpdir(), "ackerdb-flood-"));
  const path = join(dir, "data.db.telemetry");
  const writer = new TelemetryWorkerWriter({
    path,
    generation: randomUUID(),
    maxStoredBytes,
  });
  await writer.whenReady();

  // The REAL path: one Telemetry, spans through recordSpan, and the exemplar a
  // retained trace becomes going straight to the sidecar. A driver that fed a
  // collector production never called is how this measurement was wrong before.
  let observations = 0;
  const telemetry = new Telemetry({
    localSink: false,
    exporter: { export: () => {} },
    exemplar: (exemplar) => void writer.accept("exemplar", exemplar),
    exemplarLimits: { baselineProbability: 0.01 },
    aggregate: { warmObservations: 50, referenceWindowMs: MINUTE_MS },
    limits: { retentionMs: 1, slowOperationMs: 500 },
  });

  const clockBase = Date.now();
  let counter = 0;
  let virtualMs = clockBase;
  const phases: FloodPhase[] = [];

  for (const [label, errorShare] of [["healthy", 0.01], ["flood", 1.0]] as const) {
    const before = writer.snapshot();
    const observationsBefore = observations;
    const startedAt = performance.now();
    const endAt = startedAt + secondsPerPhase * 1_000;
    let operations = 0;

    while (performance.now() < endAt) {
      const owed = Math.floor(((performance.now() - startedAt) / 1_000) * opsPerSecond) - operations;
      for (let index = 0; index < owed; index++) {
        virtualMs = clockBase + Math.floor((counter / opsPerSecond) * 1_000);
        const failing = Math.random() < errorShare;
        const traceId = (counter++).toString(16).padStart(32, "0");
        const durationMs = failing ? 200 + Math.random() * 800 : 2 + Math.random() * 8;
        telemetry.beginTrace({ traceId }, virtualMs);
        for (let position = 0; position < SPANS_PER_OPERATION; position++) {
          // 100% of observations reach the aggregate, before anything selects.
          telemetry.recordSpan({
            context: {
              traceId,
              spanId: `${traceId.slice(0, 24)}${position.toString(16).padStart(8, "0")}`,
            },
            timestampMs: virtualMs,
            operation: position === 0 ? "procedure" : "query",
            stage: position === 0 ? "handler" : "storage",
            outcome: failing && position === SPANS_PER_OPERATION - 1 ? "internal" : "ok",
            functionName: "api.checkout.submit",
            statement: "checkout.submit",
            resource: "operation",
            durationMs: position === 0 ? durationMs : durationMs / SPANS_PER_OPERATION,
          });
          observations++;
        }
        // Completed traces settle on the NEXT trace's lifecycle call, which
        // prunes whatever's delayed-delivery window has passed. Naming a trace
        // that does not exist would prune too, but `forContext` falls back to a
        // linear scan of both lists when the id is not indexed, and paying that
        // per operation is quadratic.
        telemetry.finishTrace({ traceId }, virtualMs + durationMs);
        writer.accept("log", {
          kind: "log",
          processGeneration: "flood",
          sequence: BigInt(counter),
          timestamp: virtualMs,
          level: failing ? "error" : "info",
          source: "app",
          message: failing ? "checkout failed" : "checkout ok",
          truncated: false,
          malformed: false,
          functionAddress: "api.checkout.submit",
          functionKind: "procedure",
          traceId,
        });
        operations++;
      }
      for (const handoff of telemetry.drainAggregateBuckets()) {
        writer.accept("aggregate", {
          startMs: handoff.startMs,
          closed: handoff.closed,
          rows: handoff.rows,
        });
      }
      await Bun.sleep(1);
    }
    // Let the sidecar commit what this phase produced before it is measured.
    await writer.stats();
    const after = writer.snapshot();
    const retained = (after.acceptedByKind.exemplar ?? 0) +
      (after.shed.shedByKind.exemplar ?? 0) -
      ((before.acceptedByKind.exemplar ?? 0) + (before.shed.shedByKind.exemplar ?? 0));
    const exemplarsAccepted = (after.acceptedByKind.exemplar ?? 0) -
      (before.acceptedByKind.exemplar ?? 0);
    phases.push({
      label,
      errorShare,
      operations,
      observations: observations - observationsBefore,
      retainedTraces: retained,
      exemplarsAccepted,
      exemplarsShed: (after.shed.shedByKind.exemplar ?? 0) -
        (before.shed.shedByKind.exemplar ?? 0),
      storedBytesDelta: after.storedBytes - before.storedBytes,
      bytesPerOperation: operations === 0
        ? 0
        : (after.storedBytes - before.storedBytes) / operations,
      pressure: after.shed.pressure,
    });
    console.error(`  phase ${label} done`);
  }

  for (const handoff of telemetry.drainAggregateBuckets(true)) {
    writer.accept("aggregate", {
      startMs: handoff.startMs,
      closed: handoff.closed,
      rows: handoff.rows,
    });
  }
  const sealed = await writer.seal(undefined, Date.now() + 30_000);

  const database = new Database(path, { readonly: true, safeIntegers: true, strict: true });
  const count = (sql: string): number => Number((database.query(sql).get() as { n: bigint }).n);
  const onDisk = {
    exemplars: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_exemplars"),
    journal: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_journal"),
    aggregateMinutes: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_aggregate_minute"),
    // The aggregate's own account of the flood: exact, and it never sheds.
    aggregateErrorCount: count(
      "SELECT COALESCE(SUM(error_count), 0) AS n FROM _ackerdb_telemetry_aggregate_minute",
    ),
    aggregateCount: count(
      "SELECT COALESCE(SUM(count), 0) AS n FROM _ackerdb_telemetry_aggregate_minute",
    ),
  };
  database.close(false);
  rmSync(dir, { recursive: true, force: true });

  const healthy = phases[0]!;
  const flood = phases[1]!;
  return {
    phases,
    amplification: healthy.bytesPerOperation <= 0
      ? 0
      : flood.bytesPerOperation / healthy.bytesPerOperation,
    // Every operation contributed SPANS_PER_OPERATION observations to the
    // aggregate in both phases, whatever admission did to the specimens.
    aggregateSawEverything: phases.every((phase) =>
      phase.observations === phase.operations * SPANS_PER_OPERATION),
    shedByReason: sealed.snapshot.shed.shedByReason,
    onDisk,
  };
}

if (import.meta.main) {
  const result = await runFlood(
    Number(process.argv[2] ?? 3_000),
    Number(process.argv[3] ?? 20),
    Number(process.argv[4] ?? DEFAULT_MAX_STORED_BYTES),
  );
  console.log(JSON.stringify(result, null, 2));
}
