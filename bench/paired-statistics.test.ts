import { describe, expect, test } from "bun:test";
import {
  comparePaired,
  medianIntervalRank,
  scatterSummary,
  DEFAULT_POLICY,
  DEFAULT_REPETITIONS,
  type PairedSample,
} from "./paired-statistics.ts";
import {
  benchUnits,
  contractShortfalls,
  expectedUnitMetricNames,
  leadingSide,
  metricPolicy,
} from "./units.ts";
import { benchmarkConfigFromEnv } from "./benchmark.ts";

const higher = { ...DEFAULT_POLICY, better: "higher" } as const;
const lower = { ...DEFAULT_POLICY, better: "lower" } as const;

/** Base held flat so the ratio is exactly the multiplier applied to head. */
function pairs(multipliers: readonly number[], base = 100): PairedSample[] {
  return multipliers.map((multiplier) => ({ base, head: base * multiplier }));
}

describe("median interval rank", () => {
  test("is the deepest rank whose two-sided sign test fits the budget", () => {
    // Eight repetitions can only afford the extreme pair, which is the same
    // statement as "every repetition must agree".
    expect(medianIntervalRank(8, 0.05)).toBe(1);
    expect(medianIntervalRank(10, 0.05)).toBe(2);
    expect(medianIntervalRank(20, 0.05)).toBe(6);
  });

  test("refuses when no rank is deep enough rather than inventing confidence", () => {
    expect(medianIntervalRank(5, 0.05)).toBeUndefined();
    expect(medianIntervalRank(2, 0.05)).toBeUndefined();
  });

  test("the default repetition count is even so neither side leads more often", () => {
    expect(DEFAULT_REPETITIONS % 2).toBe(0);
    expect(medianIntervalRank(DEFAULT_REPETITIONS, DEFAULT_POLICY.alpha)).toBeDefined();
  });
});

describe("paired comparison", () => {
  test("calls a large consistent throughput drop a regression", () => {
    const comparison = comparePaired(
      pairs([0.24, 0.21, 0.26, 0.23, 0.25, 0.22, 0.27, 0.2]),
      higher,
    );
    expect(comparison.signal).toBe("regression");
    expect(comparison.medianPercent).toBeCloseTo(-76.5, 0);
    expect(comparison.highPercent).toBeLessThan(0);
  });

  test("calls the same drop an improvement when lower is better", () => {
    const comparison = comparePaired(
      pairs([0.24, 0.21, 0.26, 0.23, 0.25, 0.22, 0.27, 0.2]),
      lower,
    );
    expect(comparison.signal).toBe("improvement");
  });

  test("reports no signal when one repetition disagrees, however large the median", () => {
    // Seven repetitions lose a third of throughput and one gains a little. The
    // median is far past the floor, but scatter that changes sign is not a
    // measurement of the change.
    const comparison = comparePaired(pairs([0.66, 0.7, 0.63, 0.68, 0.65, 0.71, 0.67, 1.04]), higher);
    expect(comparison.medianPercent).toBeLessThan(-30);
    expect(comparison.signal).toBe("no signal");
    expect(comparison.reason).toContain("spans zero");
  });

  test("reports no signal for a consistent move that is too small to matter", () => {
    const comparison = comparePaired(
      pairs([0.97, 0.96, 0.98, 0.97, 0.96, 0.95, 0.97, 0.98]),
      higher,
    );
    expect(comparison.signal).toBe("no signal");
    expect(comparison.reason).toContain("floor");
  });

  test("a doubling and a halving are the same distance from neutral", () => {
    const doubled = comparePaired(pairs(Array(8).fill(2)), higher);
    const halved = comparePaired(pairs(Array(8).fill(0.5)), higher);
    expect(doubled.medianPercent).toBeCloseTo(100, 6);
    expect(halved.medianPercent).toBeCloseTo(-50, 6);
    // Symmetric in the space the statistic actually works in.
    expect(Math.log(1 + doubled.medianPercent / 100)).toBeCloseTo(
      -Math.log(1 + halved.medianPercent / 100),
      6,
    );
  });

  test("discards pairs that cannot form a ratio and says so", () => {
    const comparison = comparePaired(
      [
        ...pairs([0.2, 0.2, 0.2, 0.2, 0.2]),
        { base: 0, head: 5 },
        { base: 5, head: Number.NaN },
        { base: 5, head: Number.POSITIVE_INFINITY },
      ],
      higher,
    );
    expect(comparison.discardedPairs).toBe(3);
    expect(comparison.pairs).toBe(5);
    // Five usable pairs cannot bound a median at this confidence, and the
    // honest answer is that the run could not resolve it.
    expect(comparison.signal).toBe("not measured");
  });

  test("too few repetitions is not measured rather than silently confident", () => {
    expect(comparePaired(pairs([0.2, 0.2]), higher).signal).toBe("not measured");
  });

  test("shrinking the repetition count cannot buy a pass, only a failed measurement", () => {
    // An eighty-percent throughput loss, sampled too few times to bound. The
    // answer is "not measured", which `report.ts` counts against a gated metric
    // as a failure — so turning `BENCH_REPETITIONS` down to escape a regression
    // fails the check instead of passing it.
    for (const repetitions of [2, 4, 6]) {
      const comparison = comparePaired(pairs(Array(repetitions).fill(0.2)), higher);
      expect(comparison.signal).not.toBe("no signal");
      if (repetitions < DEFAULT_POLICY.minimumPairs) expect(comparison.signal).toBe("not measured");
    }
  });

  test("an unchanging metric produces no signal, not a verdict of zero", () => {
    expect(comparePaired(pairs(Array(8).fill(1)), higher).signal).toBe("no signal");
  });
});

describe("scatter summary", () => {
  test("orders the run's magnitudes so a reader can weigh the floor against them", () => {
    const summary = scatterSummary([
      comparePaired(pairs(Array(8).fill(1.01)), higher),
      comparePaired(pairs(Array(8).fill(1.2)), higher),
      comparePaired(pairs(Array(8).fill(0.9)), higher),
    ]);
    expect(summary.metrics).toBe(3);
    expect(summary.maximumAbsolutePercent).toBeCloseTo(20, 6);
    expect(summary.medianAbsolutePercent).toBeCloseTo(10, 6);
  });
});

describe("execution order", () => {
  test("each side leads exactly half the repetitions", () => {
    const leads = Array.from({ length: DEFAULT_REPETITIONS }, (_, repetition) => leadingSide(repetition));
    expect(leads.filter((side) => side === "base")).toHaveLength(DEFAULT_REPETITIONS / 2);
    expect(leads.filter((side) => side === "head")).toHaveLength(DEFAULT_REPETITIONS / 2);
  });

  test("consecutive repetitions never hand the same side the leading slot", () => {
    for (let repetition = 1; repetition < DEFAULT_REPETITIONS; repetition++) {
      expect(leadingSide(repetition)).not.toBe(leadingSide(repetition - 1));
    }
  });
});

describe("metric policy", () => {
  test("every metric a unit can emit has a declared direction and gating", () => {
    const config = benchmarkConfigFromEnv();
    for (const unit of benchUnits(config)) {
      for (const name of expectedUnitMetricNames(config, unit)) {
        expect(() => metricPolicy(name)).not.toThrow();
      }
    }
  });

  test("resolves a capacity metric through its writer-slot namespace", () => {
    expect(metricPolicy("512 writers/all p95 ms")).toEqual(metricPolicy("all p95 ms"));
  });

  test("refuses a metric nobody decided about, rather than guessing a direction", () => {
    expect(() => metricPolicy("bytes shuffled")).toThrow(/no direction or gating policy/);
  });

  test("the tail statistics named as untrustworthy are reported but never gate", () => {
    for (const name of ["p99 ms", "delivery p99 ms", "all p99 ms", "ready p95 ms"]) {
      expect(metricPolicy(name).gated).toBe(false);
      expect(metricPolicy(name).note).toBeDefined();
    }
    expect(metricPolicy("p95 ms").gated).toBe(true);
    expect(metricPolicy("throughput/s").gated).toBe(true);
  });
});

describe("measurement contract", () => {
  const config = benchmarkConfigFromEnv();
  const complete = benchUnits(config).flatMap((unit) =>
    expectedUnitMetricNames(config, unit).map((metric) => ({
      unitId: unit.id,
      metric,
      samples: Array(DEFAULT_REPETITIONS).fill({ base: 1, head: 1 }),
    }))
  );

  test("a run that delivered everything it owes has nothing to report", () => {
    expect(contractShortfalls(config, DEFAULT_REPETITIONS, complete)).toEqual([]);
  });

  test("a metric that quietly stopped being produced is named", () => {
    const dropped = complete.filter((series) => series.metric !== "throughput/s");
    const shortfalls = contractShortfalls(config, DEFAULT_REPETITIONS, dropped);
    expect(shortfalls.length).toBeGreaterThan(0);
    expect(shortfalls.every((line) => line.includes("never produced throughput/s"))).toBe(true);
  });

  test("a whole unit that vanished is named", () => {
    const withoutSubscriptions = complete.filter((series) => !series.unitId.startsWith("subscription:"));
    expect(contractShortfalls(config, DEFAULT_REPETITIONS, withoutSubscriptions).length).toBeGreaterThan(0);
  });

  test("a series that paired fewer repetitions than the run asked for is named", () => {
    const short = complete.map((series, index) =>
      index === 0 ? { ...series, samples: series.samples.slice(1) } : series
    );
    expect(contractShortfalls(config, DEFAULT_REPETITIONS, short)).toEqual([
      `${complete[0]!.unitId} ${complete[0]!.metric} paired ${DEFAULT_REPETITIONS - 1} of ${DEFAULT_REPETITIONS} repetitions`,
    ]);
  });
});
