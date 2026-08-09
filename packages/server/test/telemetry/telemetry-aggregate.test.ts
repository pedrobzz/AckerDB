import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_BINS,
  Sketch,
} from "../../src/telemetry/aggregation/sketch.ts";
import {
  MINUTE_MS,
  OVERFLOW_FUNCTION,
  TelemetryAggregateBuckets,
  mergeIntoHour,
} from "../../src/telemetry/aggregation/buckets.ts";
import {
  TRACE_POLICY_VERSION,
  type TraceExemplar,
} from "../../src/telemetry/exemplars/collector.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import {
  BODY_QUANTILES,
  EXPOSED_QUANTILES,
  MIN_SAMPLES_ABOVE_QUANTILE,
  RETENTION_QUANTILE,
  TAIL_QUANTILES,
  TARGET_TAIL_RATE,
  isConfidentQuantile,
} from "../../src/telemetry/policy.ts";
import {
  bucketKey,
  DEFAULT_MAPPING_SCALE,
  scaleMultiplier,
} from "../../src/telemetry/aggregation/sketch.ts";
import type { TelemetryOutcome } from "../../src/telemetry/contracts/schema.ts";

const HOUR_ALIGNED = Math.floor(1_700_000_000_000 / 3_600_000) * 3_600_000;


describe("aggregate distribution", () => {
  test("answers quantiles inside the relative accuracy it declares", () => {
    const sketch = new Sketch();
    const values = Array.from({ length: 50_000 }, (_, index) => 0.5 + (index % 977) / 3);
    for (const value of values) sketch.add(value);
    const sorted = [...values].sort((left, right) => left - right);

    for (const q of [0.5, 0.9, 0.99, 0.995]) {
      const exact = sorted[Math.floor(q * (sorted.length - 1))]!;
      const answered = sketch.quantile(q)!;
      expect(Math.abs(answered - exact) / exact).toBeLessThanOrEqual(sketch.relativeAccuracy);
    }
    // Count and total are exact even though quantiles are not: complete
    // coverage and numerical exactness are different promises.
    expect(sketch.snapshot().count).toBe(values.length);
  });

  test("distinguishes no observations from observations of zero", () => {
    expect(new Sketch().quantile(0.5)).toBeUndefined();
    const zeros = new Sketch();
    zeros.add(0);
    expect(zeros.quantile(0.5)).toBe(0);
  });

  test("merges losslessly, which is what makes an hour a rollup of its minutes", () => {
    const buckets = new TelemetryAggregateBuckets();
    const direct = new Sketch();
    const minutes = [];
    for (let minute = 0; minute < 60; minute++) {
      for (let index = 0; index < 200; index++) {
        const durationMs = 1 + (index % 97);
        buckets.record(
          HOUR_ALIGNED + minute * MINUTE_MS,
          "procedure",
          "api.bench.compute",
          "ok",
          durationMs,
        );
        direct.add(durationMs);
      }
      minutes.push(...buckets.drain(HOUR_ALIGNED + (minute + 1) * MINUTE_MS).flatMap((h) => h.rows));
    }
    const hours = mergeIntoHour(minutes);
    expect(minutes).toHaveLength(60);
    expect(hours).toHaveLength(1);

    const merged = Sketch.decode(hours[0]!.sketchOk, DEFAULT_MAX_BINS);
    expect(merged.count).toBe(direct.count);
    expect(Math.abs(merged.sum - direct.sum)).toBeLessThan(1e-6);
    expect(merged.quantile(0.99)).toBe(direct.quantile(0.99));
  });

  test("caps cardinality, discloses the overflow, and still counts everything", () => {
    const buckets = new TelemetryAggregateBuckets({ maxSeriesPerBucket: 64 });
    for (let index = 0; index < 20_000; index++) {
      buckets.record(HOUR_ALIGNED, "query", `api.generated.fn${index}`, "ok", 1 + (index % 20));
    }
    const handoff = buckets.drain(HOUR_ALIGNED + MINUTE_MS)[0]!;
    const overflow = handoff.rows.filter((row) => row.overflow);

    expect(handoff.rows.length).toBeLessThanOrEqual(65);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.functionAddress).toBe(OVERFLOW_FUNCTION);
    // A cardinality attack costs resolution, never the count: an aggregate that
    // silently dropped observations would report a smaller total as exact.
    expect(handoff.rows.reduce((total, row) => total + row.count, 0)).toBe(20_000);
    expect(buckets.snapshot().overflowedObservations).toBeGreaterThan(0);
  });

  test("marks a minute handed over before it ended as not closed", () => {
    const buckets = new TelemetryAggregateBuckets();
    buckets.record(HOUR_ALIGNED, "query", "api.items.list", "ok", 5);

    expect(buckets.drain(HOUR_ALIGNED + 1_000)).toHaveLength(0);
    const forced = buckets.drain(HOUR_ALIGNED + 1_000, true);
    expect(forced[0]!.closed).toBe(false);
    expect(buckets.drain(HOUR_ALIGNED + MINUTE_MS, true)).toHaveLength(0);
  });

  test("refuses an observation no open bucket can honestly hold", () => {
    const buckets = new TelemetryAggregateBuckets({ maxOpenBuckets: 2 });
    for (let minute = 0; minute < 10; minute++) {
      buckets.record(HOUR_ALIGNED + minute * MINUTE_MS, "query", "api.items.list", "ok", 1);
    }
    const snapshot = buckets.snapshot();
    expect(snapshot.openBuckets).toBe(2);
    expect(snapshot.droppedObservations).toBe(8);
  });
});

/**
 * Drive the REAL path: `Telemetry` with an exemplar sink, spans through
 * `recordSpan`, and a trace that begins and finishes. These are the standing
 * guards on the retention policy, and a guard that drove a component production
 * never called is exactly how the exemplar store stayed empty.
 */
const PRUNER = "ffffffffffffffffffffffffffffffff";

interface ExemplarDriver {
  readonly exemplars: readonly TraceExemplar[];
  readonly telemetry: Telemetry;
  trace(
    traceId: string,
    spans: readonly { durationMs: number; outcome?: TelemetryOutcome; functionName?: string }[],
    atMs?: number,
  ): TraceExemplar | undefined;
}

function driver(options: {
  baselineProbability?: number;
  warmObservations?: number;
} = {}): ExemplarDriver {
  const exemplars: TraceExemplar[] = [];
  const telemetry = new Telemetry({
    localSink: false,
    exemplar: (exemplar) => exemplars.push(exemplar),
    exemplarLimits: { baselineProbability: options.baselineProbability ?? 0.01 },
    aggregate: {
      warmObservations: options.warmObservations ?? 50,
      referenceWindowMs: MINUTE_MS,
    },
    // A completed trace is held for delayed delivery spans before it settles,
    // and settling is when its exemplar is written. One millisecond here so the
    // prune below reaches it; production holds it for five minutes.
    limits: { retentionMs: 1 },
  });
  return {
    exemplars,
    telemetry,
    trace: (traceId, spans, atMs = HOUR_ALIGNED) => {
      const before = exemplars.length;
      let spanIndex = 0;
      telemetry.beginTrace({ traceId }, atMs);
      for (const one of spans) {
        telemetry.recordSpan({
          context: { traceId, spanId: `${traceId.slice(0, 24)}${(spanIndex++ % 10_000).toString(16).padStart(8, "0")}` },
          timestampMs: atMs,
          operation: "procedure",
          stage: "handler",
          outcome: one.outcome ?? "ok",
          functionName: one.functionName ?? "api.checkout.submit",
          durationMs: one.durationMs,
        });
      }
      const endedAt = atMs + Math.max(0, ...spans.map((one) => one.durationMs));
      telemetry.finishTrace({ traceId }, endedAt);
      // Settle it the way production does: any later lifecycle call prunes the
      // completed decisions whose delayed-delivery window has passed. Naming a
      // trace that does not exist prunes without opening one of its own.
      telemetry.finishTrace({ traceId: PRUNER }, endedAt + 8);
      return exemplars.length > before ? exemplars.at(-1) : undefined;
    },
  };
}

describe("trace exemplars", () => {
  const ids = Array.from(
    { length: 20_000 },
    (_, index) => index.toString(16).padStart(32, "0"),
  );

  /**
   * Warm one cohort so the policy has a quantile to measure against. The spread
   * is continuous on purpose: a constant duration puts every observation in one
   * bucket, and the boundary admission that then governs is a different property
   * with its own test.
   */
  const warm = (
    run: ExemplarDriver,
    count = 400,
    functionName = "api.checkout.submit",
  ): void => {
    for (let index = 0; index < count; index++) {
      run.trace(`warm${index.toString(16).padStart(27, "0")}`, [{
        durationMs: 8 + ((index * 2654435761) % 100_000) / 12_500,
        functionName,
      }]);
    }
  };

  /** A duration in the body of the warmed spread, well below its tail. */
  const typical = (index: number): number => 8 + (index % 40) / 20;

  test("keeps a declared share of healthy traces, decided from the trace id", () => {
    const run = driver({ baselineProbability: 0.01 });
    warm(run);
    const before = run.exemplars.length;
    ids.slice(0, 5_000).forEach((id, index) => run.trace(id, [{ durationMs: typical(index) }]));
    const kept = run.exemplars.slice(before).filter((one) => one.reason === "baseline");
    // The baseline share is what is declared and what is drawn; the tail share
    // beside it is the threshold rule, measured separately.
    expect(kept.length / 5_000).toBeGreaterThan(0.005);
    expect(kept.length / 5_000).toBeLessThan(0.02);
    expect(kept.every((one) => one.inclusionProbability === 0.01)).toBe(true);
  });

  test("forgets a healthy trace outside the baseline share", () => {
    const run = driver({ baselineProbability: 0 });
    warm(run);
    expect(run.trace(ids[7_000]!, [{ durationMs: typical(3) }])).toBeUndefined();
  });

  test("every stored trace says why it was kept and how likely that was", () => {
    const run = driver({ baselineProbability: 0 });
    warm(run);

    const errored = run.trace(ids[1]!, [
      { durationMs: typical(1) },
      { durationMs: typical(2), outcome: "internal" },
    ])!;
    expect(errored.reason).toBe("error");
    expect(errored.inclusionProbability).toBe(1);
    expect(errored.policyVersion).toBe(TRACE_POLICY_VERSION);
    expect(errored.complete).toBe(true);
    expect(errored.omittedSpans).toBe(0);
    expect(errored.errorCount).toBe(1);

    const slow = run.trace(ids[2]!, [{ durationMs: 900 }])!;
    expect(slow.reason).toBe("slow");
    expect(slow.inclusionProbability).toBe(1);

    const baselineRun = driver({ baselineProbability: 1 });
    warm(baselineRun);
    const baseline = baselineRun.trace(ids[3]!, [{ durationMs: typical(4) }])!;
    expect(baseline.reason).toBe("baseline");
    expect(baseline.inclusionProbability).toBe(1);
  });

  test("a trace past its budget is typed oversized, never quietly truncated", () => {
    const run = driver({ baselineProbability: 0 });
    warm(run);
    const spans = Array.from({ length: 5_000 }, (_, index) => ({
      durationMs: index % 50,
      outcome: (index === 4_999 ? "internal" : "ok") as TelemetryOutcome,
    }));
    const exemplar = run.trace(ids[9]!, spans)!;
    expect(exemplar.observedSpans).toBe(5_000);
    expect(exemplar.oversized).toBe(true);
    expect(exemplar.complete).toBe(false);
    // The payload plus what it admits leaving out must equal what was seen; a
    // truncated tree that still added up would be indistinguishable from a
    // genuinely small trace.
    const carried = (JSON.parse(exemplar.payload) as unknown[]).length;
    expect(carried + exemplar.omittedSpans).toBe(exemplar.observedSpans);
  });

  test("the retained cohort is not a sample, and its error rate proves it", () => {
    const run = driver({ baselineProbability: 0.01 });
    warm(run);
    const produced = 10_000;
    const before = run.exemplars.length;
    let storedErrors = 0;
    for (let index = 0; index < produced; index++) {
      const failed = index % 100 === 0;
      const exemplar = run.trace(ids[index]!, [{
        durationMs: typical(index),
        ...(failed ? { outcome: "internal" as TelemetryOutcome } : {}),
      }]);
      if (exemplar !== undefined && exemplar.errorCount > 0) storedErrors++;
    }
    const stored = run.exemplars.length - before;
    // The true error rate is 1%. Among stored traces it is far higher, because
    // the policy keeps every failure and only a sliver of the rest. Nothing may
    // derive a rate from this table; that is the aggregate's job.
    expect(storedErrors / stored).toBeGreaterThan(0.3);
    expect(stored / produced).toBeLessThan(0.10);
  });

  test("a rare healthy function may honestly have no exemplar at all", () => {
    const run = driver({ baselineProbability: 0 });
    // Warm the rare cohort, so "no exemplar" is a decision rather than coldness.
    warm(run, 400, "api.rare.call");
    const before = run.exemplars.length;
    for (let index = 0; index < 300; index++) {
      run.trace(`rare${index.toString(16).padStart(28, "0")}`, [
        { durationMs: typical(index), functionName: "api.rare.call" },
      ]);
    }
    // "Show me a normal trace" is allowed to have no answer: with no baseline
    // share configured, a healthy function in the body of its own distribution
    // stores nothing at all, and that absence is honest rather than a gap.
    expect(run.exemplars.length - before).toBe(0);
  });

  test("a trace at or above the reported p99 exists for the window the chart covers", () => {
    // The scenario an operator feels at 3 a.m.: the chart shows a p99 spike,
    // they click it, and either a trace is there or the policy was measuring
    // something unrelated to the number on screen.
    const run = driver({ baselineProbability: 0 });
    let index = 0;
    const drive = (minute: number, durations: readonly number[]) => {
      for (const durationMs of durations) {
        run.trace(
          (index++).toString(16).padStart(32, "0"),
          [{ durationMs }],
          HOUR_ALIGNED + minute * MINUTE_MS,
        );
      }
    };
    const baseline = Array.from({ length: 400 }, (_, offset) => 10 + (offset % 20));
    for (const minute of [0, 1, 2, 3]) drive(minute, baseline);
    // Then latency climbs by an order of magnitude — the spike on the chart.
    drive(4, Array.from({ length: 400 }, (_, offset) => 100 + (offset % 400)));

    const reported = run.telemetry.cohortThreshold("procedure", "api.checkout.submit");
    expect(reported.warm).toBe(true);
    // Retention follows the lowest exposed TAIL quantile, so an exemplar at or
    // above every tail quantile — p99 included — exists by construction.
    expect(run.exemplars.some((one) => one.durationMs >= reported.thresholdMs!)).toBe(true);
  });

  test("retention follows the tail set, and a body percentile cannot move it", () => {
    // A screen adding a TAIL percentile below the retention quantile has changed
    // the retention policy, and this must fail rather than silently widen it.
    expect(RETENTION_QUANTILE).toBe(Math.min(...TAIL_QUANTILES));
    for (const quantile of TAIL_QUANTILES) {
      expect(quantile).toBeGreaterThanOrEqual(RETENTION_QUANTILE);
    }
    // A screen adding a BODY percentile changes what is displayed and nothing
    // about what is stored. Were the rule "lowest exposed quantile", exposing
    // p50 would retain half of all traffic — "store everything" by the back door.
    for (const quantile of BODY_QUANTILES) {
      expect(quantile).toBeLessThan(RETENTION_QUANTILE);
      expect(TAIL_QUANTILES).not.toContain(quantile);
    }
    expect(EXPOSED_QUANTILES).toEqual(
      [...BODY_QUANTILES, ...TAIL_QUANTILES].sort((left, right) => left - right),
    );
    // Exposing p95 is the EXPENSIVE choice: retention follows the lower tail
    // number, so ~5% of traces rather than ~1%. Kept deliberately.
    expect(RETENTION_QUANTILE).toBe(0.95);
  });

  test("a window too small to speak to a quantile says so", () => {
    const buckets = new TelemetryAggregateBuckets();
    // A hundred observations put exactly one request above p99: an anecdote.
    for (let index = 0; index < 100; index++) {
      buckets.record(HOUR_ALIGNED, "query", "api.rare.call", "ok", 1 + (index % 30));
    }
    const thin = buckets.drain(HOUR_ALIGNED + MINUTE_MS)[0]!.rows[0]!;
    expect(thin.count).toBe(100);
    expect(thin.lowConfidenceQuantiles).toContain(0.99);
    expect(thin.lowConfidenceQuantiles).not.toContain(0.5);

    const busy = new TelemetryAggregateBuckets();
    for (let index = 0; index < 5_000; index++) {
      busy.record(HOUR_ALIGNED, "query", "api.busy.call", "ok", 1 + (index % 30));
    }
    const thick = busy.drain(HOUR_ALIGNED + MINUTE_MS)[0]!.rows[0]!;
    expect(thick.lowConfidenceQuantiles).toEqual([]);

    expect(isConfidentQuantile(MIN_SAMPLES_ABOVE_QUANTILE / 0.01, 0.99)).toBe(true);
    expect(isConfidentQuantile(100, 0.99)).toBe(false);
  });

  test("a healthy application retains a small minority, and this is a standing guard", () => {
    // Three defects in this component have failed OPEN — a cohort key built with
    // two separators, a cold-start rule that waited for a published window, and
    // a float bucket edge. All presented as working systems while silently
    // storing every trace. This asserts the property they violated, through the
    // path production actually uses.
    const run = driver({ baselineProbability: 0.01 });
    const operations = 20_000;
    for (let index = 0; index < operations; index++) {
      // A healthy application: no errors, and a continuous spread rather than a
      // handful of discrete values.
      run.trace(
        index.toString(16).padStart(32, "0"),
        [{ durationMs: 8 + ((index * 2654435761) % 100_000) / 12_500 }],
        HOUR_ALIGNED + Math.floor(index / 400) * MINUTE_MS,
      );
    }
    // Errors + slow + baseline on a healthy application is a few per cent. Ten
    // is generous headroom; anything near 100% means the policy has stopped
    // selecting and is storing everything again.
    expect(run.exemplars.length / operations).toBeLessThan(0.10);
    expect(run.exemplars.length).toBeGreaterThan(0);
  });

  test("realizes the target rate whatever shape the distribution has", () => {
    // The policy's contract is a RATE. Four fail-opens in this component were
    // all the same shape — a rule "retain when X" whose X stopped
    // discriminating, always failing toward retaining everything. Asserting the
    // rate rather than the threshold is what closes that class.
    const measure = (durationFor: (index: number) => number): number => {
      const run = driver({ baselineProbability: 0 });
      const operations = 40_000;
      for (let index = 0; index < operations; index++) {
        run.trace(
          index.toString(16).padStart(32, "0"),
          [{ durationMs: durationFor(index) }],
          HOUR_ALIGNED + Math.floor(index / 500) * MINUTE_MS,
        );
      }
      return run.exemplars.length / operations;
    };

    const continuous = measure((index) => 8 + ((index * 2654435761) % 100_000) / 12_500);
    // A cached endpoint that always answers in exactly the same time: every
    // observation lands in one bucket, so `>=` would retain all of them.
    const constant = measure(() => 2);
    // An endpoint quantised to a handful of values — the shape that retained 12%
    // before the rate became the invariant.
    const quantised = measure((index) => 8 + (index % 9));

    for (const [label, rate] of [
      ["continuous", continuous],
      ["constant", constant],
      ["quantised", quantised],
    ] as const) {
      expect({ label, over: rate > TARGET_TAIL_RATE * 2.5 }).toEqual({ label, over: false });
      expect({ label, under: rate < TARGET_TAIL_RATE * 0.2 }).toEqual({ label, under: false });
    }
  });

  test("a cold cohort retains rather than falling through to nothing", () => {
    const run = driver({ baselineProbability: 0 });
    const exemplar = run.trace(ids[1]!, [
      { durationMs: 3, functionName: "api.newly.deployed" },
    ])!;
    // A function nobody has called yet has no quantile; retaining its first
    // traces is why a fresh deploy has something to look at at all.
    expect(exemplar.reason).toBe("cold");
    expect(exemplar.thresholdMs).toBeUndefined();
  });
});
