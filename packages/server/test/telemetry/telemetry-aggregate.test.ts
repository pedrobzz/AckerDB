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
  TraceExemplarCollector,
  type CohortThresholdProvider,
} from "../../src/telemetry/exemplars/collector.ts";
import {
  BODY_QUANTILES,
  EXPOSED_QUANTILES,
  MIN_SAMPLES_ABOVE_QUANTILE,
  RETENTION_QUANTILE,
  TAIL_QUANTILES,
  TARGET_TAIL_RATE,
  isConfidentQuantile,
} from "../../src/telemetry/aggregation/buckets.ts";
import type { TelemetrySpanRecord } from "../../src/telemetry/telemetry.ts";

const HOUR_ALIGNED = Math.floor(1_700_000_000_000 / 3_600_000) * 3_600_000;

/** A cohort that is always warm at a fixed threshold, for the policy tests. */
const warmAt = (thresholdMs: number): CohortThresholdProvider =>
  () => ({
    thresholdMs,
    warm: true,
    observations: 10_000,
    boundaryAdmitProbability: 1,
    // A degenerate boundary bucket: the fixture is a hard threshold, so nothing
    // sits "inside" it and everything above is retained.
    boundaryLowerMs: thresholdMs,
    boundaryUpperMs: thresholdMs,
  });

function span(overrides: Record<string, unknown> = {}): TelemetrySpanRecord {
  return Object.freeze({
    schemaVersion: 1,
    kind: "span",
    timestampMs: 1_000,
    operation: "query",
    stage: "handler",
    outcome: "ok",
    durationMs: 1,
    spanId: "s1",
    function: "api.items.list",
    ...overrides,
  }) as unknown as TelemetrySpanRecord;
}

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

describe("trace exemplars", () => {
  const ids = Array.from(
    { length: 20_000 },
    (_, index) => index.toString(16).padStart(32, "0"),
  );

  test("keeps a declared share of healthy traces, decided from the trace id", () => {
    const collector = new TraceExemplarCollector(warmAt(500), { baselineProbability: 0.01 });
    const kept = ids.filter((id) => collector.isBaseline(id)).length / ids.length;
    expect(kept).toBeGreaterThan(0.005);
    expect(kept).toBeLessThan(0.02);
    // Deciding at creation is what lets a selected trace retain immediately
    // instead of staging while its verdict is pending.
    for (const id of ids.slice(0, 200)) {
      expect(collector.isBaseline(id)).toBe(collector.isBaseline(id));
    }
  });

  test("forgets a healthy trace outside the baseline share", () => {
    const collector = new TraceExemplarCollector(warmAt(500));
    const id = ids.find((candidate) => !collector.isBaseline(candidate))!;
    collector.observe(id, span());
    expect(collector.settle(id)).toBeUndefined();
    expect(collector.snapshot().discardedTraces).toBe(1);
  });

  test("every stored trace says why it was kept and how likely that was", () => {
    const collector = new TraceExemplarCollector(warmAt(500));
    const failed = ids.find((candidate) => !collector.isBaseline(candidate))!;
    collector.observe(failed, span());
    collector.observe(failed, span({ spanId: "s2", parentSpanId: "s1", outcome: "internal" }));
    const errored = collector.settle(failed)!;
    expect(errored.reason).toBe("error");
    expect(errored.inclusionProbability).toBe(1);
    expect(errored.policyVersion).toBe(TRACE_POLICY_VERSION);
    expect(errored.complete).toBe(true);
    expect(errored.omittedSpans).toBe(0);

    const slowId = ids.find((candidate) =>
      !collector.isBaseline(candidate) && candidate !== failed)!;
    collector.observe(slowId, span({ durationMs: 900 }));
    const slow = collector.settle(slowId)!;
    expect(slow.reason).toBe("slow");
    expect(slow.inclusionProbability).toBe(1);

    const baselineId = ids.find((candidate) => collector.isBaseline(candidate))!;
    collector.observe(baselineId, span());
    const baseline = collector.settle(baselineId)!;
    expect(baseline.reason).toBe("baseline");
    expect(baseline.inclusionProbability).toBe(collector.limits.baselineProbability);
  });

  test("a trace past its budget is typed oversized, never quietly truncated", () => {
    const collector = new TraceExemplarCollector(warmAt(500), { maxSpansPerTrace: 128 });
    const id = ids.find((candidate) => !collector.isBaseline(candidate))!;
    for (let index = 0; index < 5_000; index++) {
      collector.observe(id, span({
        spanId: `s${index}`,
        ...(index === 0 ? {} : { parentSpanId: "s0" }),
        durationMs: index % 50,
        outcome: index === 4_999 ? "internal" : "ok",
      }));
    }
    const exemplar = collector.settle(id)!;
    expect(exemplar.oversized).toBe(true);
    expect(exemplar.complete).toBe(false);
    expect(exemplar.observedSpans).toBe(5_000);
    // The payload plus what it admits leaving out must equal what was seen; a
    // truncated tree that still added up would be indistinguishable from a
    // genuinely small trace.
    const carried = (JSON.parse(exemplar.payload) as unknown[]).length;
    expect(carried + exemplar.omittedSpans).toBe(exemplar.observedSpans);
    expect(exemplar.errorCount).toBe(1);
  });

  test("global staging exhaustion discards whole traces, not parts of them", () => {
    const collector = new TraceExemplarCollector(warmAt(500), { maxOpenTraces: 4 });
    for (let index = 0; index < 50; index++) {
      collector.observe(index.toString(16).padStart(32, "0"), span());
    }
    expect(collector.snapshot().openTraces).toBe(4);
    expect(collector.snapshot().discardedTraces).toBe(46);
  });

  test("the retained cohort is not a sample, and its error rate proves it", () => {
    const collector = new TraceExemplarCollector(warmAt(500), { baselineProbability: 0.01 });
    let stored = 0;
    let storedErrors = 0;
    const produced = 10_000;
    for (let index = 0; index < produced; index++) {
      const id = index.toString(16).padStart(32, "0");
      const failed = index % 100 === 0;
      collector.observe(id, span({ outcome: failed ? "internal" : "ok" }));
      const exemplar = collector.settle(id);
      if (exemplar !== undefined) {
        stored++;
        if (exemplar.errorCount > 0) storedErrors++;
      }
    }
    // The true error rate is 1%. Among stored traces it is close to half,
    // because the policy keeps every failure and only a sliver of the rest.
    // Nothing may derive a rate from this table; that is the aggregate's job.
    expect(storedErrors / stored).toBeGreaterThan(0.3);
    expect(stored / produced).toBeLessThan(0.05);
  });

  test("a rare healthy function may honestly have no exemplar at all", () => {
    const collector = new TraceExemplarCollector(warmAt(500), { baselineProbability: 0.01 });
    const rare = ids.filter((candidate) => !collector.isBaseline(candidate)).slice(0, 5);
    for (const id of rare) {
      collector.observe(id, span({ function: "api.rare.call" }));
      expect(collector.settle(id)).toBeUndefined();
    }
    // "Show me a normal trace" has no answer here, and the absence is a fact the
    // reader must be told rather than a gap it should fill by implication.
    expect(collector.snapshot().retainedTraces).toBe(0);
  });

  test("a trace at or above the reported p99 exists for the window the chart covers", () => {
    // The scenario an operator feels at 3 a.m.: the chart shows a p99 spike,
    // they click it, and either a trace is there or the policy was measuring
    // something unrelated to the number on screen.
    const buckets = new TelemetryAggregateBuckets({
      warmObservations: 50,
      referenceWindowMs: MINUTE_MS,
    });
    const collector = new TraceExemplarCollector(
      (operation, fn) => buckets.thresholdFor(operation ?? "query", fn),
      { baselineProbability: 0 },
    );
    const stored: number[] = [];
    let traceIndex = 0;

    const drive = (minute: number, durations: readonly number[]) => {
      for (const durationMs of durations) {
        const at = HOUR_ALIGNED + minute * MINUTE_MS;
        buckets.record(at, "procedure", "api.checkout.submit", "ok", durationMs);
        const traceId = (traceIndex++).toString(16).padStart(32, "0");
        collector.observe(traceId, span({
          operation: "procedure",
          function: "api.checkout.submit",
          timestampMs: at,
          durationMs,
        }));
        const exemplar = collector.settle(traceId);
        if (exemplar !== undefined) stored.push(exemplar.durationMs);
      }
    };

    const baseline = Array.from({ length: 400 }, (_, index) => 10 + (index % 20));
    for (const minute of [0, 1, 2, 3]) drive(minute, baseline);
    // Then latency climbs by an order of magnitude — the spike on the chart.
    drive(4, Array.from({ length: 400 }, (_, index) => 100 + (index % 400)));

    const reported = buckets.thresholdFor("procedure", "api.checkout.submit");
    expect(reported.warm).toBe(true);
    const threshold = reported.thresholdMs!;

    // Retention follows the lowest exposed TAIL quantile, so an exemplar at or
    // above every tail quantile — p99 included — exists by construction.
    expect(stored.some((durationMs) => durationMs >= threshold)).toBe(true);
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
    // Two defects in this component have failed OPEN — a cohort key built with
    // two different separators, and a cold-start rule that waited for a
    // published window. Both presented as working systems while silently storing
    // every trace. This asserts the property those bugs violated, so the next
    // one is caught by the suite instead of by a ramp someone thought to run.
    const buckets = new TelemetryAggregateBuckets({
      warmObservations: 50,
      referenceWindowMs: MINUTE_MS,
    });
    const collector = new TraceExemplarCollector(
      (operation, fn) => buckets.thresholdFor(operation ?? "procedure", fn),
      { baselineProbability: 0.01 },
    );
    const operations = 20_000;
    let retained = 0;
    for (let index = 0; index < operations; index++) {
      const traceId = index.toString(16).padStart(32, "0");
      // A healthy application: no errors, and a continuous spread rather than a
      // handful of discrete values. The distinction matters: `>=` at the
      // threshold retains every tie, so a latency quantised to a few values can
      // retain its whole top bucket — nine discrete values here retained 12%
      // rather than 5%. Real latency is continuous; a quantised endpoint is a
      // real over-retention mode and is noted as such.
      const durationMs = 8 + ((index * 2654435761) % 100_000) / 12_500;
      const at = HOUR_ALIGNED + Math.floor(index / 400) * MINUTE_MS;
      buckets.record(at, "procedure", "api.checkout.submit", "ok", durationMs);
      collector.observe(traceId, span({
        operation: "procedure",
        function: "api.checkout.submit",
        timestampMs: at,
        durationMs,
      }));
      if (collector.settle(traceId) !== undefined) retained++;
    }
    // Errors + slow + baseline on a healthy application is a few per cent. Ten
    // is generous headroom; anything near 100% means the policy has stopped
    // selecting and is storing everything again.
    expect(retained / operations).toBeLessThan(0.10);
    expect(retained).toBeGreaterThan(0);
  });

  test("realizes the target rate whatever shape the distribution has", () => {
    // The policy's contract is a RATE. Three fail-opens in this component were
    // all the same shape — a rule "retain when X" whose X stopped
    // discriminating, always failing toward retaining everything. Asserting the
    // rate rather than the threshold is what closes that class.
    const measure = (durationFor: (index: number) => number): number => {
      const buckets = new TelemetryAggregateBuckets({
        warmObservations: 50,
        referenceWindowMs: MINUTE_MS,
      });
      const collector = new TraceExemplarCollector(
        (operation, fn) => buckets.thresholdFor(operation ?? "procedure", fn),
        { baselineProbability: 0 },
      );
      const operations = 40_000;
      let retained = 0;
      for (let index = 0; index < operations; index++) {
        const traceId = index.toString(16).padStart(32, "0");
        const durationMs = durationFor(index);
        const at = HOUR_ALIGNED + Math.floor(index / 500) * MINUTE_MS;
        buckets.record(at, "procedure", "api.checkout.submit", "ok", durationMs);
        collector.observe(traceId, span({
          operation: "procedure",
          function: "api.checkout.submit",
          timestampMs: at,
          durationMs,
        }));
        if (collector.settle(traceId) !== undefined) retained++;
      }
      return retained / operations;
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
    const buckets = new TelemetryAggregateBuckets({ warmObservations: 50 });
    const collector = new TraceExemplarCollector(
      (operation, fn) => buckets.thresholdFor(operation ?? "query", fn),
      { baselineProbability: 0 },
    );
    const id = (1).toString(16).padStart(32, "0");
    collector.observe(id, span({ function: "api.newly.deployed", durationMs: 3 }));
    const exemplar = collector.settle(id)!;
    // A function nobody has called yet has no quantile; retaining its first
    // traces is why a fresh deploy has something to look at at all.
    expect(exemplar.reason).toBe("cold");
    expect(exemplar.thresholdMs).toBeUndefined();
  });
});
