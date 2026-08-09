/**
 * The retention policy: the small part of this subsystem that is ours.
 *
 * Almost everything else in telemetry is commodity with published prior art —
 * the sketch is DDSketch, the retention model is journald and Netdata and
 * VictoriaLogs, the discard-reason names are Loki's, the batching is
 * `BatchSpanProcessor`, the export format is OTLP, and the tail-sampling shapes
 * are the OTel Collector's `tailsamplingprocessor`, which ships `latency`,
 * `status_code` and `probabilistic` policies we arrived at independently. This
 * module holds the part nobody else does, and it lives apart from the aggregate
 * so that replacing the sketch beneath it never touches the invariant.
 *
 * **The invariant: the retention threshold is read from the same distribution
 * the chart reports.** That makes "the chart shows p99, therefore a p99 exemplar
 * exists" true by construction at every load, with no constant to tune. Nobody
 * ships this. Datadog's retention filter covers p75, p90 and p95 while p99 is
 * the number everyone watches; OpenTelemetry Collector #30319 asked for it in
 * January 2024 and was closed by a bot as stale. It is cheap here and expensive
 * for a multi-tenant vendor, which is the whole reason a single node can have it.
 *
 * The seam onto the commodity beneath is `CohortDistribution`: the mass at and
 * above a value's bucket, and the value at a quantile. Any sketch that can
 * answer those two questions can carry this policy.
 */

/**
 * The quantiles a screen may show, split by what exposing them costs.
 *
 * Retention follows the lowest TAIL quantile, and the rule must say *tail* and
 * not merely *lowest*: the day a screen exposes p50, "retain at the lowest
 * exposed quantile" would mean retaining half of all traffic and the policy
 * would quietly become "store everything" again. Body quantiles are display
 * only. Leaving them out is safe because the deterministic baseline already
 * supplies typical traces — a uniform sample is representative by construction —
 * while what a uniform sample almost never contains is a tail outlier at useful
 * density: in a one-minute window of a hundred requests, a 1% baseline is one
 * trace with a one-in-a-hundred chance of being the slow one.
 *
 * **Exposing p95 is the expensive choice and it is deliberate.** Retention
 * follows the lowest tail quantile, so exposing p95 retains roughly 5% of traces
 * where p99 alone would retain 1%. Showing the lower tail number costs five
 * times more, not less. It is paid because p95 alone hides any incident
 * affecting under 5% of traffic — the shape of most real ones — and because a
 * page making twenty backend calls has only a 36% chance of dodging the slow 5%
 * entirely. Do not "optimise" this by dropping p99; dropping p95 is what would
 * save storage, and it is the number worth keeping least.
 */
export const TAIL_QUANTILES: readonly number[] = Object.freeze([0.95, 0.99]);
export const BODY_QUANTILES: readonly number[] = Object.freeze([0.5]);
export const EXPOSED_QUANTILES: readonly number[] = Object.freeze(
  [...BODY_QUANTILES, ...TAIL_QUANTILES].sort((left, right) => left - right),
);

/** Derived from the TAIL set alone; a body quantile can never move it. */
export const RETENTION_QUANTILE = Math.min(...TAIL_QUANTILES);

/** The share of traffic the policy aims to retain for the tail. */
export const TARGET_TAIL_RATE = 1 - RETENTION_QUANTILE;

/**
 * Observations that must fall ABOVE a quantile before it is a statistic rather
 * than an anecdote. At p99 with 100 observations in a window the answer is one
 * request; reporting that as fact is how a dashboard manufactures an incident.
 * Ten is the smallest count at which the estimate stops being a single sample.
 */
export const MIN_SAMPLES_ABOVE_QUANTILE = 10;

/** Whether a window of `count` observations can speak to `quantile` at all. */
export function isConfidentQuantile(count: number, quantile: number): boolean {
  return count * (1 - quantile) >= MIN_SAMPLES_ABOVE_QUANTILE;
}

/** Exposed quantiles a window of `count` observations cannot answer as fact. */
export function lowConfidenceQuantiles(count: number): readonly number[] {
  return Object.freeze(
    EXPOSED_QUANTILES.filter((quantile) => !isConfidentQuantile(count, quantile)),
  );
}

/**
 * The seam onto whatever holds the distribution. Two questions, both of which
 * any bucketed sketch answers, and neither of which mentions a sketch.
 */
export interface CohortDistribution {
  readonly count: number;
  quantile(q: number): number | undefined;
  /**
   * The share of observations in the same bucket as `value` and the share
   * strictly above it, with that bucket identified by KEY. The key matters: a
   * caller that compares a duration against a reconstructed millisecond edge is
   * comparing against a float, and at OTLP scale 6 every power of two is an
   * exact bucket edge, so a constant-latency endpoint tests as above its own
   * bucket and the policy retains all of it.
   */
  shareAtAndAbove(value: number): {
    readonly at: number;
    readonly above: number;
    readonly key: number;
    readonly mappingScale: number;
  } | undefined;
}

/** What the retention policy tells the collector about one cohort. */
export interface CohortThreshold {
  /** The cohort's current value at `RETENTION_QUANTILE`, once it is warm. */
  readonly thresholdMs: number | undefined;
  /** False while the cohort has too little history for a quantile to mean anything. */
  readonly warm: boolean;
  readonly observations: number;
  /**
   * The chance a trace landing exactly in the threshold's bucket is admitted.
   *
   * The contract is a retention RATE; the threshold is only a means of hitting
   * it. Everything strictly above the boundary bucket is retained, and the
   * remainder of the target rate is drawn from the boundary bucket at this
   * probability — so a distribution with mass piled on one value realizes the
   * same rate as a smooth one instead of retaining the whole pile.
   */
  readonly boundaryAdmitProbability: number;
  /** The boundary bucket's key, for an exact integer comparison. */
  readonly boundaryKey: number | undefined;
  readonly mappingScale: number;
}

/** A cohort with too little history has no quantile, so it retains outright. */
export function coldThreshold(observations: number, mappingScale: number): CohortThreshold {
  return {
    thresholdMs: undefined,
    warm: false,
    observations,
    boundaryAdmitProbability: 1,
    boundaryKey: undefined,
    mappingScale,
  };
}

/**
 * Read one cohort's retention threshold off its own distribution.
 *
 * The rate is the invariant and the threshold is only how it is reached. Four
 * defects in this policy have been a rule of the form *retain when X* whose X
 * quietly stopped discriminating, every one of them failing toward retaining
 * everything while looking healthy — a cohort key built two ways, a cold-start
 * that waited for a published window, a `>=` that kept every tie, and a
 * reconstructed float bucket edge. Enforcing the rate closes the class:
 * everything above the boundary bucket retains, and the boundary bucket admits
 * at whatever probability makes the realized rate match the target.
 */
export function thresholdFrom(
  distribution: CohortDistribution,
  mappingScale: number,
): CohortThreshold {
  const thresholdMs = distribution.quantile(RETENTION_QUANTILE);
  const share = thresholdMs === undefined ? undefined : distribution.shareAtAndAbove(thresholdMs);
  return {
    thresholdMs,
    warm: true,
    observations: distribution.count,
    boundaryAdmitProbability: share === undefined || share.at <= 0
      ? 1
      : Math.min(1, Math.max(0, (TARGET_TAIL_RATE - share.above) / share.at)),
    boundaryKey: share?.key,
    mappingScale: share?.mappingScale ?? mappingScale,
  };
}
