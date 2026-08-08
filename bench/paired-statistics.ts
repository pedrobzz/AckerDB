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
 */
import { median } from "./load-engine.ts";

export interface PairedSample {
  readonly base: number;
  readonly head: number;
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
 * Repetitions buy both confidence and sensitivity, and eight is where the
 * measured trade sits. Relabelling which side is base within each repetition —
 * a valid permutation under the null — puts the false-failure rate at 3.6% of
 * runs here, while injecting a known effect into the harness's own recorded
 * noise detects 60% of twenty-percent regressions and 94% of fifty-percent
 * ones. More repetitions raise both at proportional wall-clock cost;
 * `BENCH_REPETITIONS` is the knob, and `docs/releases.md` carries the curve.
 *
 * Even matters independently of the count: the pair driver alternates which
 * side runs first on each repetition, so an odd number would hand one side an
 * extra turn in the leading, colder slot.
 */
export const DEFAULT_REPETITIONS = 8;

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
