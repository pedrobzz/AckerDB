/**
 * The aggregate every valid observation reaches, before anything decides what to
 * keep.
 *
 * This is the half of #194 that was a real requirement. The trace store keeps a
 * tail-sampled minority; this sees everything, so "how many calls, how many
 * failed, how slow" is answered from complete coverage rather than from whatever
 * the sampler happened to retain. Datadog states the same property of its trace
 * metrics — computed on 100% of traffic regardless of ingestion sampling — and
 * enforces it by cloning for stats before the sampler runs. The ordering is the
 * design; everything else here is bookkeeping.
 *
 * **Two resolutions, one model.** Minute buckets answer the short windows an
 * operator watches during an incident; hourly buckets, merged from the same
 * sketches, answer long horizons at a sixtieth of the rows. A second store would
 * be a second truth.
 *
 * **Cardinality is capped, and overflow is disclosed.** `function` is
 * application-supplied and therefore unbounded, which is exactly the shape that
 * turns an in-process aggregate into a memory leak. Past the cap, observations
 * land in one overflow series that says so, rather than silently inventing a
 * merged series that looks like a real one.
 *
 * **Coverage is recorded, not assumed.** A bucket is marked closed only once its
 * minute has ended and it has been handed over for persistence. A process that
 * dies mid-minute leaves that minute open, so the next generation can say the
 * window is incomplete instead of presenting a smaller count as exact.
 */
import { Sketch, DEFAULT_MAPPING_SCALE, DEFAULT_MAX_BINS } from "./sketch.ts";
import type { TelemetryOperation, TelemetryOutcome } from "../contracts/schema.ts";
import {
  coldThreshold,
  lowConfidenceQuantiles,
  thresholdFrom,
  type CohortThreshold,
} from "../policy.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;



/** The overflow series' function name; no application function may collide. */
export const OVERFLOW_FUNCTION = "\u0000overflow";

export interface TelemetryAggregateLimits {
  /** Distinct (operation, function) series one bucket may hold. */
  readonly maxSeriesPerBucket: number;
  /** Minute buckets held open at once — clock skew and long operations. */
  readonly maxOpenBuckets: number;
  /**
   * How much history the retention threshold is read from. One tumbling window
   * of lag keeps the threshold stable: reading a half-filled minute would make
   * the policy lurch every sixty seconds.
   */
  readonly referenceWindowMs: number;
  /**
   * Observations a cohort needs before its quantile means anything. Below it the
   * cohort is cold and every trace is retained, so a newly deployed function has
   * exemplars immediately instead of none until it happens to get busy.
   */
  readonly warmObservations: number;
  /**
   * The OTLP exponential-histogram scale the sketches start at. An integer,
   * because a mapping that is not on OTLP's grid cannot be exported without
   * re-bucketing; a busy series coarsens from here on its own and says so.
   */
  readonly mappingScale: number;
  readonly maxBins: number;
}

export const DEFAULT_AGGREGATE_LIMITS: TelemetryAggregateLimits = Object.freeze({
  maxSeriesPerBucket: 1_024,
  maxOpenBuckets: 8,
  referenceWindowMs: 5 * MINUTE_MS,
  warmObservations: 50,
  mappingScale: DEFAULT_MAPPING_SCALE,
  maxBins: DEFAULT_MAX_BINS,
});

/**
 * The one place a cohort key is built. It was briefly built in two, with two
 * different separators, and the lookup silently missed every time — a threshold
 * that always reads "cold" fails open rather than loudly, which is the worst
 * way for this particular bug to behave.
 */
function cohortKey(operation: TelemetryOperation, functionAddress: string | undefined): string {
  return `${operation}\u0000${functionAddress ?? ""}`;
}

/** One (operation, function) series inside one minute. */
interface Series {
  readonly operation: TelemetryOperation;
  readonly functionAddress: string;
  readonly overflow: boolean;
  count: number;
  errorCount: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  readonly ok: Sketch;
  readonly failed: Sketch;
}

interface Bucket {
  readonly startMs: number;
  readonly series: Map<string, Series>;
  overflowedObservations: number;
  observations: number;
}


/** One series, ready to persist. */
export interface AggregateSeriesRow {
  readonly startMs: number;
  readonly operation: TelemetryOperation;
  readonly functionAddress: string;
  readonly overflow: boolean;
  readonly count: number;
  readonly errorCount: number;
  readonly totalMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /**
   * The scale the row's sketches ended at. It is the row's declared error bound
   * — α = (γ−1)/(γ+1) — and it is what an OTLP export writes into the data
   * point, so it is stored rather than recomputed by whoever reads the row.
   */
  readonly mappingScale: number;
  /**
   * Exposed quantiles this window holds too few observations to answer as fact.
   * Carried on the row rather than left for a screen to infer, for the same
   * reason coverage is: a number presented without its confidence is read as
   * certain.
   */
  readonly lowConfidenceQuantiles: readonly number[];
  readonly sketchOk: string;
  readonly sketchFailed: string;
}

export interface AggregateBucketHandoff {
  readonly startMs: number;
  /** False when the process is handing over a minute that has not ended. */
  readonly closed: boolean;
  readonly observations: number;
  readonly overflowedObservations: number;
  readonly rows: readonly AggregateSeriesRow[];
}

export interface TelemetryAggregateSnapshot2 {
  readonly openBuckets: number;
  readonly observations: number;
  readonly overflowedObservations: number;
  readonly droppedObservations: number;
  readonly seriesHighWater: number;
  readonly mappingScale: number;
}

export class TelemetryAggregateBuckets {
  readonly limits: TelemetryAggregateLimits;
  private readonly buckets = new Map<number, Bucket>();
  /** Duration history for the current reference window, by cohort. */
  private reference = new Map<string, Sketch>();
  /** The previous window's history — what thresholds are actually read from. */
  private published = new Map<string, Sketch>();
  private referenceWindowStart = 0;
  private observations = 0;
  private overflowedObservations = 0;
  private droppedObservations = 0;
  private seriesHighWater = 0;

  constructor(limits: Partial<TelemetryAggregateLimits> = {}) {
    this.limits = Object.freeze({ ...DEFAULT_AGGREGATE_LIMITS, ...limits });
  }

  /**
   * Record one observation. Called before any retention decision, for every
   * valid span — this is the "100%" the whole model rests on, so it is total and
   * allocation-light on the common path.
   */
  record(
    timestampMs: number,
    operation: TelemetryOperation,
    functionAddress: string | undefined,
    outcome: TelemetryOutcome,
    durationMs: number,
  ): boolean {
    if (!Number.isFinite(timestampMs) || !Number.isFinite(durationMs) || durationMs < 0) {
      this.droppedObservations++;
      return false;
    }
    const startMs = Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS;
    let bucket = this.buckets.get(startMs);
    if (bucket === undefined) {
      if (this.buckets.size >= this.limits.maxOpenBuckets) {
        // A timestamp far from every open bucket is clock skew or a stalled
        // operation; folding it into an arbitrary bucket would corrupt a window
        // an operator reads as exact, so it is refused and counted.
        this.droppedObservations++;
        return false;
      }
      bucket = { startMs, series: new Map(), overflowedObservations: 0, observations: 0 };
      this.buckets.set(startMs, bucket);
    }
    const name = functionAddress ?? "";
    const key = cohortKey(operation, functionAddress);
    let series = bucket.series.get(key);
    if (series === undefined) {
      if (bucket.series.size >= this.limits.maxSeriesPerBucket) {
        series = this.overflowSeries(bucket, operation);
        bucket.overflowedObservations++;
        this.overflowedObservations++;
      } else {
        series = this.newSeries(operation, name, false);
        bucket.series.set(key, series);
        if (bucket.series.size > this.seriesHighWater) this.seriesHighWater = bucket.series.size;
      }
    }
    this.rollReferenceWindow(startMs);
    // The threshold history follows the same cardinality budget as the buckets;
    // an overflowed cohort has no threshold of its own and stays cold, which
    // retains rather than silently keeping nothing.
    if (!series.overflow) {
      let history = this.reference.get(key);
      if (history === undefined && this.reference.size < this.limits.maxSeriesPerBucket) {
        history = new Sketch(this.limits.mappingScale, this.limits.maxBins);
        this.reference.set(key, history);
      }
      history?.add(durationMs);
    }
    const failed = outcome !== "ok";
    series.count++;
    if (failed) series.errorCount++;
    series.totalMs += durationMs;
    if (durationMs < series.minMs) series.minMs = durationMs;
    if (durationMs > series.maxMs) series.maxMs = durationMs;
    (failed ? series.failed : series.ok).add(durationMs);
    bucket.observations++;
    this.observations++;
    return true;
  }

  /**
   * Publish the accumulated window and start a new one. Thresholds always read
   * a complete window, so they never swing on a minute that has barely begun.
   */
  private rollReferenceWindow(startMs: number): void {
    if (this.referenceWindowStart === 0) {
      this.referenceWindowStart = startMs;
      return;
    }
    if (startMs < this.referenceWindowStart + this.limits.referenceWindowMs) return;
    this.published = this.reference;
    this.reference = new Map();
    this.referenceWindowStart = startMs;
  }

  /**
   * The distribution one cohort's retention threshold is read from — the SAME
   * one the chart is drawn from, which is the invariant `policy.ts` owns. This
   * method only chooses which window is authoritative and hands it over; what
   * the threshold means is not the aggregate's business.
   */
  thresholdFor(operation: TelemetryOperation, functionAddress: string | undefined): CohortThreshold {
    const key = cohortKey(operation, functionAddress);
    // The published window is preferred because it is complete and therefore
    // stable. But warmth must not WAIT for one: a cohort whose first window has
    // not closed yet would be cold for the whole window, and "cold retains
    // everything" for five minutes at three thousand operations a second is the
    // retain-everything failure this design exists to remove. The accumulating
    // window is a worse estimate than a closed one and a far better one than
    // nothing, so it is used the moment it has enough observations to speak.
    const published = this.published.get(key);
    const source = published !== undefined && published.count >= this.limits.warmObservations
      ? published
      : this.reference.get(key);
    const observations = source?.count ?? 0;
    if (source === undefined || observations < this.limits.warmObservations) {
      return coldThreshold(observations, this.limits.mappingScale);
    }
    return thresholdFrom(source, this.limits.mappingScale);
  }

  private newSeries(
    operation: TelemetryOperation,
    functionAddress: string,
    overflow: boolean,
  ): Series {
    return {
      operation,
      functionAddress,
      overflow,
      count: 0,
      errorCount: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: Number.NEGATIVE_INFINITY,
      ok: new Sketch(this.limits.mappingScale, this.limits.maxBins),
      failed: new Sketch(this.limits.mappingScale, this.limits.maxBins),
    };
  }

  private overflowSeries(bucket: Bucket, operation: TelemetryOperation): Series {
    const key = cohortKey(operation, OVERFLOW_FUNCTION);
    let series = bucket.series.get(key);
    if (series === undefined) {
      series = this.newSeries(operation, OVERFLOW_FUNCTION, true);
      bucket.series.set(key, series);
    }
    return series;
  }

  /**
   * Hand over every bucket whose minute has ended. `force` also hands over the
   * still-open ones, marked not closed — which is what a drain does, so a clean
   * shutdown loses nothing while still refusing to call a partial minute whole.
   */
  drain(nowMs: number, force = false): AggregateBucketHandoff[] {
    const out: AggregateBucketHandoff[] = [];
    for (const [startMs, bucket] of this.buckets) {
      const closed = nowMs >= startMs + MINUTE_MS;
      if (!closed && !force) continue;
      this.buckets.delete(startMs);
      out.push({
        startMs,
        closed,
        observations: bucket.observations,
        overflowedObservations: bucket.overflowedObservations,
        rows: [...bucket.series.values()].map((series) => Object.freeze({
          startMs,
          operation: series.operation,
          functionAddress: series.functionAddress,
          overflow: series.overflow,
          count: series.count,
          errorCount: series.errorCount,
          totalMs: series.totalMs,
          minMs: series.count === 0 ? 0 : series.minMs,
          maxMs: series.count === 0 ? 0 : series.maxMs,
          mappingScale: Math.min(series.ok.scale, series.failed.scale),
          lowConfidenceQuantiles: lowConfidenceQuantiles(series.count),
          sketchOk: series.ok.encode(),
          sketchFailed: series.failed.encode(),
        })),
      });
    }
    return out;
  }

  snapshot(): TelemetryAggregateSnapshot2 {
    return Object.freeze({
      openBuckets: this.buckets.size,
      observations: this.observations,
      overflowedObservations: this.overflowedObservations,
      droppedObservations: this.droppedObservations,
      seriesHighWater: this.seriesHighWater,
      mappingScale: this.limits.mappingScale,
    });
  }
}

/** Merge minute rows into their hour. Sketches add; extremes take the outer value. */
export function mergeIntoHour(
  rows: readonly AggregateSeriesRow[],
  maxBins = DEFAULT_MAX_BINS,
): AggregateSeriesRow[] {
  const merged = new Map<string, {
    row: AggregateSeriesRow;
    ok: Sketch;
    failed: Sketch;
    count: number;
    errorCount: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
  }>();
  for (const row of rows) {
    const hour = Math.floor(row.startMs / HOUR_MS) * HOUR_MS;
    const key = `${hour}\0${row.operation}\0${row.functionAddress}`;
    let entry = merged.get(key);
    if (entry === undefined) {
      entry = {
        row: { ...row, startMs: hour },
        ok: new Sketch(row.mappingScale, maxBins),
        failed: new Sketch(row.mappingScale, maxBins),
        count: 0,
        errorCount: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: Number.NEGATIVE_INFINITY,
      };
      merged.set(key, entry);
    }
    entry.ok.merge(Sketch.decode(row.sketchOk, maxBins));
    entry.failed.merge(Sketch.decode(row.sketchFailed, maxBins));
    entry.count += row.count;
    entry.errorCount += row.errorCount;
    entry.totalMs += row.totalMs;
    if (row.count > 0) {
      if (row.minMs < entry.minMs) entry.minMs = row.minMs;
      if (row.maxMs > entry.maxMs) entry.maxMs = row.maxMs;
    }

  }
  return [...merged.values()].map((entry) => Object.freeze({
    ...entry.row,
    count: entry.count,
    errorCount: entry.errorCount,
    totalMs: entry.totalMs,
    minMs: entry.count === 0 ? 0 : entry.minMs,
    maxMs: entry.count === 0 ? 0 : entry.maxMs,
    mappingScale: Math.min(entry.ok.scale, entry.failed.scale),
    lowConfidenceQuantiles: lowConfidenceQuantiles(entry.count),
    sketchOk: entry.ok.encode(),
    sketchFailed: entry.failed.encode(),
  }));
}

export type { CohortThreshold };
