/**
 * Scenario 1: incident amplification.
 *
 * The question this answers is the one that decides whether the design
 * survives. Tail sampling shrinks the healthy mean, not the incident: the
 * retained fraction is `errors + slow + baseline`, so a healthy application
 * already retains a few per cent and an incident drives it toward 100%. That is
 * the load the worker exists for, and the load at which synchronous writing was
 * never survivable.
 *
 * It drives the serving thread's real path — aggregate every observation, offer
 * every span to the exemplar collector, settle each trace, hand what survives to
 * the worker — at a fixed operation rate while the failing fraction ramps.
 *
 *   bun bench/telemetry-incident-ramp.ts [opsPerSecond] [secondsPerStep]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TelemetryWorkerWriter } from "../packages/server/src/telemetry/storage/worker/writer.ts";
import { MINUTE_MS } from "../packages/server/src/telemetry/aggregation/buckets.ts";
import { Telemetry } from "../packages/server/src/telemetry/telemetry.ts";

import type { TelemetrySpanRecord } from "../packages/server/src/telemetry/contracts/types.ts";

const SPANS_PER_OPERATION = 7;
const TICK_MS = 5;
const SAMPLE_MS = 500;
/** The failing share at each step; the last is a total outage. */
const STEPS = [0, 0.01, 0.05, 0.10, 1.0];

function rssBytes(): number {
  const text = process.platform === "linux"
    ? Bun.spawnSync(["sed", "-n", "s/^VmRSS:[[:space:]]*\\([0-9]*\\).*/\\1/p", `/proc/${process.pid}/status`], { stdout: "pipe" }).stdout.toString().trim()
    : Bun.spawnSync(["ps", "-o", "rss=", "-p", String(process.pid)], { stdout: "pipe" }).stdout.toString().trim();
  return Number(text) * 1024;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function slopePerSecond(samples: readonly { readonly atMs: number; readonly value: number }[]): number {
  if (samples.length < 2) return 0;
  const meanX = samples.reduce((total, s) => total + s.atMs, 0) / samples.length;
  const meanY = samples.reduce((total, s) => total + s.value, 0) / samples.length;
  let num = 0;
  let den = 0;
  for (const sample of samples) {
    num += (sample.atMs - meanX) * (sample.value - meanY);
    den += (sample.atMs - meanX) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 1000;
}

interface StepResult {
  readonly failingShare: number;
  readonly operations: number;
  readonly achievedOpsPerSec: number;
  readonly retainedTraces: number;
  readonly retainedFraction: number;
  readonly recordsAccepted: number;
  readonly recordsDropped: number;
  readonly servingCostUsPerOp: number;
  readonly commitAck: Record<string, number>;
  readonly queue: Record<string, number>;
  readonly rssPeakMb: number;
}

async function main(): Promise<void> {
  const opsPerSecond = Number(process.argv[2] ?? 3_000);
  const secondsPerStep = Number(process.argv[3] ?? 60);
  const dir = mkdtempSync(join(tmpdir(), "ackerdb-ramp-"));
  const path = join(dir, "data.db.telemetry");
  const writer = new TelemetryWorkerWriter({
    path,
    generation: randomUUID(),
    // Retention would otherwise evict mid-run and confuse the reconciliation;
    // this scenario asks whether the pipeline holds, not whether TTLs work.
    maxStoredBytes: 32 * 1024 ** 3,
  });
  await writer.whenReady();

  // The REAL path, as scenario 6 is: one Telemetry, spans through recordSpan,
  // and the exemplar a retained trace becomes going straight to the sidecar.
  let retainedTraces = 0;
  let observations = 0;
  const telemetry = new Telemetry({
    localSink: false,
    exporter: { export: () => {} },
    exemplar: (exemplar) => {
      retainedTraces++;
      writer.accept("exemplar", exemplar);
    },
    exemplarLimits: { baselineProbability: 0.01 },
    aggregate: { warmObservations: 50, referenceWindowMs: MINUTE_MS },
    limits: { retentionMs: 1, slowOperationMs: 500 },
  });

  let traceCounter = 0;
  const results: StepResult[] = [];
  const clockBase = Date.now();
  let virtualMs = clockBase;

  for (const failingShare of STEPS) {
    const ackFrom = writer.commitAckMs.length;
    const before = writer.snapshot();
    const retainedBefore = retainedTraces;
    const samples: { atMs: number; pending: number; bytes: number; age: number }[] = [];
    let rssPeak = 0;
    let servingNs = 0;

    const startedAt = performance.now();
    const endAt = startedAt + secondsPerStep * 1_000;
    let operations = 0;
    let nextSampleAt = startedAt + SAMPLE_MS;

    while (performance.now() < endAt) {
      const tickStart = performance.now();
      const owed = Math.floor(((tickStart - startedAt) / 1_000) * opsPerSecond) - operations;
      // The virtual clock advances with produced work so minute buckets roll
      // over during the run rather than all landing in one.
      const servingStart = Bun.nanoseconds();
      for (let i = 0; i < owed; i++) {
        virtualMs = clockBase + Math.floor((operations / opsPerSecond) * 1_000);
        const failing = Math.random() < failingShare;
        const traceId = (traceCounter++).toString(16).padStart(32, "0");
        // A failing operation is both slow and errored, which is what an
        // incident looks like and what drives retention toward 100%.
        const durationMs = failing ? 200 + Math.random() * 800 : 2 + Math.random() * 8;
        telemetry.beginTrace({ traceId }, virtualMs);
        for (let position = 0; position < SPANS_PER_OPERATION; position++) {
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
        telemetry.finishTrace({ traceId }, virtualMs + durationMs);
        // Logs are never sampled: one per operation, as a real application does.
        writer.accept("log", {
          kind: "log",
          processGeneration: "ramp",
          sequence: BigInt(traceCounter),
          timestamp: virtualMs,
          level: failing ? "error" : "info",
          source: "app",
          message: failing ? "checkout failed" : "checkout ok",
          truncated: false,
          malformed: false,
          functionAddress: "api.checkout.submit",
          functionKind: "procedure",
        });
        if (failing) {
          writer.accept("error", {
            error: { name: "CheckoutError", message: "gateway timeout", stack: "at api.checkout.submit" },
            timestampMs: virtualMs,
            functionAddress: "api.checkout.submit",
            traceId,
          });
        }
        operations++;
      }
      servingNs += Bun.nanoseconds() - servingStart;
      // Closed minute buckets go to the worker like every other signal.
      for (const handoff of telemetry.drainAggregateBuckets()) {
        writer.accept("aggregate", {
          startMs: handoff.startMs,
          closed: handoff.closed,
          rows: handoff.rows,
        });
      }
      if (tickStart >= nextSampleAt) {
        nextSampleAt += SAMPLE_MS;
        const stats = await writer.stats();
        samples.push({
          atMs: tickStart,
          pending: stats.pendingRecords,
          bytes: stats.pendingBytes,
          age: stats.oldestPendingAgeMs,
        });
        rssPeak = Math.max(rssPeak, rssBytes());
      }
      const spent = performance.now() - tickStart;
      if (spent < TICK_MS) await Bun.sleep(TICK_MS - spent);
      else await Bun.sleep(0);
    }

    const elapsedMs = performance.now() - startedAt;
    const after = writer.snapshot();
    const acks = writer.commitAckMs.slice(ackFrom).sort((a, b) => a - b);
    const retained = retainedTraces - retainedBefore;
    results.push({
      failingShare,
      operations,
      achievedOpsPerSec: operations / (elapsedMs / 1_000),
      retainedTraces: retained,
      retainedFraction: operations === 0 ? 0 : retained / operations,
      recordsAccepted: after.acceptedRecords - before.acceptedRecords,
      recordsDropped: after.droppedRecords - before.droppedRecords,
      // What the request thread pays for all of this, per operation.
      servingCostUsPerOp: operations === 0 ? 0 : servingNs / operations / 1_000,
      commitAck: {
        samples: acks.length,
        p50: quantile(acks, 0.5),
        p99: quantile(acks, 0.99),
        p995: quantile(acks, 0.995),
        max: acks[acks.length - 1] ?? 0,
      },
      queue: {
        pendingMax: Math.max(0, ...samples.map((s) => s.pending)),
        pendingSlopePerSec: slopePerSecond(samples.map((s) => ({ atMs: s.atMs, value: s.pending }))),
        ageMaxMs: Math.max(0, ...samples.map((s) => s.age)),
        ageSlopePerSec: slopePerSecond(samples.map((s) => ({ atMs: s.atMs, value: s.age }))),
      },
      rssPeakMb: rssPeak / 1024 ** 2,
    });
    console.error(`  step ${(failingShare * 100).toFixed(0)}% done`);
  }

  for (const handoff of telemetry.drainAggregateBuckets(true)) {
    writer.accept("aggregate", {
      startMs: handoff.startMs,
      closed: handoff.closed,
      rows: handoff.rows,
    });
  }
  const sealStartedAt = performance.now();
  const sealed = await writer.seal(undefined, Date.now() + 30_000);
  const sealMs = performance.now() - sealStartedAt;

  const db = new Database(path, { readonly: true, safeIntegers: true, strict: true });
  const count = (sql: string) => Number((db.query(sql).get() as { n: bigint }).n);
  const onDisk = {
    exemplars: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_exemplars"),
    journal: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_journal"),
    errorGroups: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_error_groups"),
    errorOccurrences: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_error_occurrences"),
    aggregateMinutes: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_aggregate_minute"),
    aggregateHours: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_aggregate_hour"),
    coverageOpen: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_aggregate_coverage WHERE closed = 0"),
    coverageClosed: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_aggregate_coverage WHERE closed = 1"),
    oversized: count("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_exemplars WHERE oversized = 1"),
  };
  const byReason = db.query(
    "SELECT reason, COUNT(*) AS n FROM _ackerdb_telemetry_exemplars GROUP BY reason",
  ).all() as { readonly reason: string; readonly n: bigint }[];
  db.close(false);

  const snapshot = writer.snapshot();
  console.log(JSON.stringify({
    opsPerSecond,
    secondsPerStep,
    steps: results,
    seal: { ms: sealMs, timedOut: sealed.timedOut },
    totals: {
      acceptedRecords: snapshot.acceptedRecords,
      droppedRecords: snapshot.droppedRecords,
      committedRecords: sealed.snapshot.committedRecords,
      rejectedRecords: sealed.snapshot.rejectedRecords,
      sidecarMb: sealed.snapshot.storedBytes / 1024 ** 2,
      shedByReason: sealed.snapshot.shed.shedByReason,
    },
    onDisk,
    exemplarsByReason: Object.fromEntries(byReason.map((row) => [row.reason, Number(row.n)])),
    aggregate: { observations, retainedTraces },
  }, null, 2));
  rmSync(dir, { recursive: true, force: true });
}

await main();
