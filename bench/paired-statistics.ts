/**
 * The comparison statistic. Every metric arrives as a list of *paired* samples:
 * one base value and one head value measured back to back on the same host,
 * inside the same second, for the same slice of work. A difference of two means
 * would charge whatever the machine was doing to whichever side ran second; the
 * ratio of an adjacent pair charges it to neither, because both sides met the
 * same machine.
 *
 * Work in log space so a halving and a doubling are the same distance from
 * neutral, take the median so one stalled repetition cannot carry the verdict,
 * and bound that median with a distribution-free interval built from the
 * repetitions themselves. That interval is the noise band: it is measured from
 * this metric's own scatter in this very run, not carried in from a constant
 * someone once guessed.
 *
 * The shape of that rule is the field's, not this repository's. `criterion.rs`
 * pairs a nonparametric significance test with a noise threshold and reports
 * "no change" when either fails; Go's `benchstat` is the same rule without the
 * threshold. What is local is only which metrics gate and where the floor sits.
 */
import { median } from "./load-engine.ts";
import type { BenchmarkConfig } from "./benchmark.ts";

export interface PairedSample {
  readonly base: number;
  readonly head: number;
}

export const PAIRED_SCHEMA_VERSION = 2;

/** Every repetition of one metric on one unit, base beside head. */
export interface PairedSeries {
  readonly unitId: string;
  readonly metric: string;
  readonly samples: readonly (PairedSample & { readonly repetition: number })[];
}

/**
 * The pair driver's record, as written to `pair.json` and read back by
 * everything that judges or remembers a run. One declaration, because a reader
 * that disagrees with the writer about this shape disagrees silently.
 */
export interface PairedRunRecord {
  readonly schemaVersion: number;
  readonly base: string;
  readonly head: string;
  readonly executionHost: string;
  readonly repetitions: number;
  readonly wallSeconds: number;
  readonly config: BenchmarkConfig;
  readonly units: readonly string[];
  readonly profiles: readonly {
    readonly profile: string;
    readonly series: readonly PairedSeries[];
    readonly terminalFailures: readonly string[];
  }[];
}

export type MetricSignal = "regression" | "improvement" | "no signal" | "not measured";

export interface PairedComparison {
  /** Pairs where both sides produced a usable positive, finite number. */
  readonly pairs: number;
  readonly discardedPairs: number;
  readonly medianPercent: number;
  readonly lowPercent: number;
  readonly highPercent: number;
  /** Interval coverage actually achieved by the order statistics used, in [0, 1]. */
  readonly coverage: number;
  readonly signal: MetricSignal;
  readonly reason: string;
}

export interface ComparisonPolicy {
  readonly better: "higher" | "lower";
  /**
   * The smallest movement worth stopping a merge for. A consistent interval
   * proves a change is real; this proves it is large enough to matter, and it
   * is the one number in the gate that is a decision rather than a measurement.
   */
  readonly floorPercent: number;
  /** Largest acceptable chance that pure noise produces an interval excluding zero. */
  readonly alpha: number;
  readonly minimumPairs: number;
}

/**
 * The smallest movement worth stopping a merge for. It is a decision rather
 * than a measurement, and deliberately not this gate's main defence.
 *
 * Null runs say why. Comparing `canary` against itself, where every true delta
 * is zero, the median absolute paired delta across ninety-one metrics was one to
 * two percent and the p90 six to seven — but the widest single metric reached
 * fifteen percent in one run and twenty-nine in another. A floor alone would
 * have fired on both. What rejected them was the interval: their repetitions did
 * not agree on a direction. Across those hundred and eighty-two null verdicts
 * exactly one metric satisfied both conditions, and it was a `p99` — which this
 * harness reports and never gates, for this reason.
 *
 * The floor's job is the opposite one: to stop a real but tiny movement, which a
 * consistent interval will happily certify, from blocking a merge over something
 * nobody would act on. See `docs/releases.md`.
 */
export const DEFAULT_FLOOR_PERCENT = 12;

/**
 * Sixteen, because eight is below what the field will sign off on and the
 * shortfall has a mechanism.
 *
 * `benchstat` asks for "at least 10, ideally 20" samples per side. At eight,
 * `medianIntervalRank` collapses to rank 1: the interval is the extreme pair, so
 * *every* repetition must agree on the direction before a metric can be called.
 * That unanimity was never a design choice — it is simply the deepest rank eight
 * repetitions can afford at alpha 0.05 — and it is a condition a **bimodal**
 * metric can satisfy by luck while a merely noisy one cannot. At sixteen the
 * same alpha buys rank 4, so up to three repetitions may dissent, and scatter
 * alone stops being able to manufacture a verdict.
 *
 * Nothing about the rule moved to get there. Alpha is still 0.05, the floor is
 * still twelve percent, and the same metrics gate; the rank is a consequence of
 * the count. Measured on a runner null run's own recorded noise — 72 gated
 * series, 20 000 relabellings of which side is base, which is a valid
 * permutation under the null — the false-failure rate goes from **2.1% of runs
 * at eight to 2.5% at sixteen**, barely moving, because the deeper rank is paid
 * for by a median that sixteen repetitions pin down better than eight. What
 * moves is detection: a fifteen-percent regression goes from 72% to 93% and a
 * twenty-percent one from 85% to 98%. Twelve was measured too and is worse than
 * both, at 5.8%: rank 3 on twelve pairs covers only 96.1%, where rank 4 on
 * sixteen covers 97.9%. `docs/releases.md` carries the full curve, a second
 * host, and the wall clock it costs.
 *
 * Even matters independently of the count: the pair driver alternates which
 * side runs first on each repetition, so an odd number would hand one side an
 * extra turn in the leading, colder slot.
 */
export const DEFAULT_REPETITIONS = 16;

export const DEFAULT_POLICY = Object.freeze({
  floorPercent: DEFAULT_FLOOR_PERCENT,
  alpha: 0.05,
  minimumPairs: 5,
});

function binomialTailProbability(n: number, upTo: number): number {
  let total = 0;
  let coefficient = 1;
  for (let i = 0; i <= upTo; i++) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    total += coefficient;
  }
  return total / 2 ** n;
}

/**
 * The rank of the order statistics that bound the median without assuming a
 * distribution: the deepest pair of ranks whose two-sided sign-test probability
 * still fits the budget. Returns a one-based rank, or `undefined` when no rank
 * is deep enough — which is itself the honest answer that this many repetitions
 * cannot resolve anything at this confidence.
 */
export function medianIntervalRank(pairs: number, alpha: number): number | undefined {
  for (let rank = Math.floor(pairs / 2); rank >= 1; rank--) {
    if (2 * binomialTailProbability(pairs, rank - 1) <= alpha) return rank;
  }
  return undefined;
}

function percent(logRatio: number): number {
  return (Math.exp(logRatio) - 1) * 100;
}

export function comparePaired(
  samples: readonly PairedSample[],
  policy: ComparisonPolicy,
): PairedComparison {
  const logRatios = samples.flatMap(({ base, head }) =>
    Number.isFinite(base) && Number.isFinite(head) && base > 0 && head > 0
      ? [Math.log(head / base)]
      : []
  );
  const discardedPairs = samples.length - logRatios.length;
  const empty = {
    pairs: logRatios.length,
    discardedPairs,
    medianPercent: Number.NaN,
    lowPercent: Number.NaN,
    highPercent: Number.NaN,
    coverage: 0,
  };
  if (logRatios.length < policy.minimumPairs) {
    return {
      ...empty,
      signal: "not measured",
      reason: `only ${logRatios.length} of ${samples.length} repetitions produced a usable pair`,
    };
  }
  const rank = medianIntervalRank(logRatios.length, policy.alpha);
  if (rank === undefined) {
    return {
      ...empty,
      pairs: logRatios.length,
      medianPercent: percent(median(logRatios)),
      signal: "not measured",
      reason: `${logRatios.length} repetitions cannot bound a median at alpha ${policy.alpha}`,
    };
  }
  const sorted = [...logRatios].sort((left, right) => left - right);
  const low = sorted[rank - 1]!;
  const high = sorted[sorted.length - rank]!;
  const centre = median(sorted);
  const comparison = {
    pairs: sorted.length,
    discardedPairs,
    medianPercent: percent(centre),
    lowPercent: percent(low),
    highPercent: percent(high),
    coverage: 1 - 2 * binomialTailProbability(sorted.length, rank - 1),
  };

  // A move is only news when the interval keeps the whole median on one side of
  // neutral *and* the median clears the floor. The first condition rejects
  // scatter, the second rejects movements too small to spend a merge on.
  const worseSideIsPositive = policy.better === "lower";
  const consistentlyWorse = worseSideIsPositive ? low > 0 : high < 0;
  const consistentlyBetter = worseSideIsPositive ? high < 0 : low > 0;
  const clearsFloor = Math.abs(comparison.medianPercent) >= policy.floorPercent;
  const band = `${comparison.lowPercent.toFixed(1)}%..${comparison.highPercent.toFixed(1)}%`;
  if (!consistentlyWorse && !consistentlyBetter) {
    return {
      ...comparison,
      signal: "no signal",
      reason: `the ${(comparison.coverage * 100).toFixed(1)}% interval ${band} spans zero`,
    };
  }
  if (!clearsFloor) {
    return {
      ...comparison,
      signal: "no signal",
      reason: `consistent but below the ${policy.floorPercent}% floor`,
    };
  }
  return {
    ...comparison,
    signal: consistentlyWorse ? "regression" : "improvement",
    reason: `${(comparison.coverage * 100).toFixed(1)}% interval ${band} clears the ${policy.floorPercent}% floor`,
  };
}

/**
 * What this run's own scatter looked like across every metric it measured. A
 * reader who distrusts the verdict can check these against the floor: when the
 * spread approaches the floor, the run was too noisy to have been believed.
 */
export function scatterSummary(comparisons: readonly PairedComparison[]): {
  readonly metrics: number;
  readonly medianAbsolutePercent: number;
  readonly p90AbsolutePercent: number;
  readonly maximumAbsolutePercent: number;
} {
  const magnitudes = comparisons
    .flatMap((comparison) => Number.isFinite(comparison.medianPercent) ? [Math.abs(comparison.medianPercent)] : [])
    .sort((left, right) => left - right);
  if (magnitudes.length === 0) {
    return { metrics: 0, medianAbsolutePercent: 0, p90AbsolutePercent: 0, maximumAbsolutePercent: 0 };
  }
  return {
    metrics: magnitudes.length,
    medianAbsolutePercent: median(magnitudes),
    p90AbsolutePercent: magnitudes[Math.max(0, Math.ceil(magnitudes.length * 0.9) - 1)]!,
    maximumAbsolutePercent: magnitudes[magnitudes.length - 1]!,
  };
}
