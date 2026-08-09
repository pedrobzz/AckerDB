/**
 * A mergeable, bounded distribution with a declared relative error.
 *
 * This is DDSketch: bucket `i` holds values in `(γ^(i-1), γ^i]` where
 * `γ = (1+α)/(1−α)`, so every bucket is a constant *relative* width and a
 * quantile answered from bucket `i` is within `α` of the true value. That is the
 * property a latency distribution needs — an absolute-width histogram either
 * wastes thousands of buckets on the millisecond range or cannot tell 900 ms
 * from 1,400 ms — and it is the property that makes two sketches mergeable by
 * adding their counts, which is what lets a minute bucket roll up into an hour
 * without going back to the raw observations.
 *
 * **The sketch sees 100% of observations, and is still numerically approximate.**
 * Those are different properties and conflating them is how a percentile becomes
 * a lie. Count, error count and total are exact; quantiles carry `α`. Both
 * facts travel with the data rather than living in someone's memory.
 *
 * Bins are capped. Over the cap the LOWEST buckets collapse together, because
 * losing resolution among the fastest observations costs an operator nothing
 * while losing it in the tail costs them the only number they were looking at.
 * A collapsed sketch reports it, so a p50 computed inside the collapsed region
 * is known to be worse than `α` rather than quietly wrong.
 */

/** Datadog's production trace-metrics configuration; ~2 kB per sketch. */
export const DEFAULT_RELATIVE_ACCURACY = 0.01;
export const DEFAULT_MAX_BINS = 2_048;

export interface SketchSnapshot {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly relativeAccuracy: number;
  /** True once the lowest buckets were merged; quantiles below `collapsedBelow` are coarser. */
  readonly collapsed: boolean;
  readonly bins: number;
}

export class Sketch {
  readonly relativeAccuracy: number;
  readonly maxBins: number;
  private readonly gamma: number;
  private readonly multiplier: number;
  /** Dense counts from `offset` upward; index 0 is bucket key `offset`. */
  private counts: Float64Array;
  private offset = 0;
  private used = 0;
  private zeroCount = 0;
  private collapsedFlag = false;
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  constructor(relativeAccuracy = DEFAULT_RELATIVE_ACCURACY, maxBins = DEFAULT_MAX_BINS) {
    if (!(relativeAccuracy > 0 && relativeAccuracy < 1)) {
      throw new RangeError("sketch relativeAccuracy must be between 0 and 1");
    }
    if (!Number.isSafeInteger(maxBins) || maxBins < 2) {
      throw new RangeError("sketch maxBins must be an integer of at least 2");
    }
    this.relativeAccuracy = relativeAccuracy;
    this.maxBins = maxBins;
    this.gamma = (1 + relativeAccuracy) / (1 - relativeAccuracy);
    this.multiplier = 1 / Math.log(this.gamma);
    this.counts = new Float64Array(Math.min(maxBins, 64));
  }

  private key(value: number): number {
    return Math.ceil(Math.log(value) * this.multiplier);
  }

  /**
   * Add one observation. Non-finite and negative values are refused rather than
   * folded in: a duration that is not a duration must not move a percentile.
   */
  add(value: number, weight = 1): boolean {
    if (!Number.isFinite(value) || value < 0 || weight <= 0) return false;
    this.count += weight;
    this.sum += value * weight;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    // Zero and denormals have no logarithm; they are their own bucket, which is
    // exact rather than approximate.
    if (value === 0) {
      this.zeroCount += weight;
      return true;
    }
    this.addToKey(this.key(value), weight);
    return true;
  }

  private addToKey(key: number, weight: number): void {
    if (this.used === 0) {
      this.offset = key;
      this.used = 1;
      this.counts[0] = weight;
      return;
    }
    if (key < this.offset) {
      const growth = this.offset - key;
      if (this.used + growth > this.maxBins) {
        // Below the window: collapse into the lowest retained bucket.
        this.counts[0] = (this.counts[0] ?? 0) + weight;
        this.collapsedFlag = true;
        return;
      }
      this.reserve(this.used + growth, growth);
      this.offset = key;
      this.used += growth;
      this.counts[0] = weight;
      return;
    }
    const index = key - this.offset;
    if (index < this.used) {
      this.counts[index] = (this.counts[index] ?? 0) + weight;
      return;
    }
    const needed = index + 1;
    if (needed > this.maxBins) {
      // Above the window: shift the window up, folding what falls off the bottom
      // into the new lowest bucket. The tail keeps its resolution.
      const shift = needed - this.maxBins;
      let folded = 0;
      for (let i = 0; i < Math.min(shift, this.used); i++) folded += this.counts[i] ?? 0;
      const next = new Float64Array(this.maxBins);
      for (let i = shift; i < this.used; i++) next[i - shift] = this.counts[i] ?? 0;
      next[0] = (next[0] ?? 0) + folded;
      this.counts = next;
      this.offset += shift;
      this.used = this.maxBins;
      this.collapsedFlag = true;
      this.counts[key - this.offset] = (this.counts[key - this.offset] ?? 0) + weight;
      return;
    }
    this.reserve(needed, 0);
    this.used = needed;
    this.counts[index] = (this.counts[index] ?? 0) + weight;
  }

  private reserve(needed: number, shiftBy: number): void {
    if (needed <= this.counts.length && shiftBy === 0) return;
    const capacity = Math.min(this.maxBins, Math.max(needed, this.counts.length * 2));
    const next = new Float64Array(capacity);
    for (let i = 0; i < this.used; i++) next[i + shiftBy] = this.counts[i] ?? 0;
    this.counts = next;
  }

  /** Fold `other` in. Both must share a relative accuracy for the bound to hold. */
  merge(other: Sketch): void {
    if (other.relativeAccuracy !== this.relativeAccuracy) {
      throw new TypeError("sketches merge only at one relative accuracy");
    }
    if (other.count === 0) return;
    this.count += other.count;
    this.sum += other.sum;
    if (other.min < this.min) this.min = other.min;
    if (other.max > this.max) this.max = other.max;
    this.zeroCount += other.zeroCount;
    if (other.collapsedFlag) this.collapsedFlag = true;
    for (let i = 0; i < other.used; i++) {
      const weight = other.counts[i] ?? 0;
      if (weight > 0) this.addToKey(other.offset + i, weight);
    }
  }

  /**
   * The value at `q`, within `relativeAccuracy` of the true quantile. Returns
   * `undefined` for an empty sketch rather than zero — "no observations" and
   * "every observation was zero" are different answers.
   */
  quantile(q: number): number | undefined {
    if (this.count === 0 || !(q >= 0 && q <= 1)) return undefined;
    const target = q * (this.count - 1);
    let seen = this.zeroCount;
    if (target < seen) return 0;
    for (let i = 0; i < this.used; i++) {
      seen += this.counts[i] ?? 0;
      if (seen > target) {
        const key = this.offset + i;
        return (2 * Math.pow(this.gamma, key)) / (this.gamma + 1);
      }
    }
    return this.max;
  }

  /**
   * The fraction of observations at or below `value` — the operation #196 needs
   * for "where does this span sit among its peers". Answered from the sketch,
   * never from stored exemplars: the retained cohort over-represents slow and
   * failed traces, so ranking against it is biased in the same direction as the
   * metric being read.
   */
  rank(value: number): number | undefined {
    if (this.count === 0 || !Number.isFinite(value) || value < 0) return undefined;
    let seen = this.zeroCount;
    if (value > 0) {
      const key = this.key(value);
      for (let i = 0; i < this.used && this.offset + i <= key; i++) seen += this.counts[i] ?? 0;
    }
    return seen / this.count;
  }

  /**
   * The share of observations sitting in the same bucket as `value`, and the
   * share strictly above that bucket.
   *
   * This is what lets the retention policy hit a RATE rather than merely apply a
   * threshold. `>=` at a threshold retains every tie, so a distribution with
   * mass piled on one value — a cached endpoint that always answers in 2 ms, an
   * endpoint dominated by a fixed timeout — retains that entire pile. Knowing
   * how much mass is at the boundary is what makes it possible to admit only
   * part of it.
   */
  shareAtAndAbove(value: number): {
    readonly at: number;
    readonly above: number;
    readonly lower: number;
    readonly upper: number;
  } | undefined {
    if (this.count === 0 || !Number.isFinite(value) || value < 0) return undefined;
    if (value === 0) {
      return {
        at: this.zeroCount / this.count,
        above: (this.count - this.zeroCount) / this.count,
        lower: 0,
        upper: 0,
      };
    }
    const key = this.key(value);
    let at = 0;
    let above = 0;
    for (let i = 0; i < this.used; i++) {
      const weight = this.counts[i] ?? 0;
      if (weight === 0) continue;
      const bucket = this.offset + i;
      if (bucket === key) at += weight;
      else if (bucket > key) above += weight;
    }
    // Bucket `key` covers (γ^(key−1), γ^key]; the caller needs those edges to
    // tell "inside the boundary bucket" from "above it".
    return {
      at: at / this.count,
      above: above / this.count,
      lower: Math.pow(this.gamma, key - 1),
      upper: Math.pow(this.gamma, key),
    };
  }

  snapshot(): SketchSnapshot {
    return Object.freeze({
      count: this.count,
      sum: this.sum,
      min: this.count === 0 ? 0 : this.min,
      max: this.count === 0 ? 0 : this.max,
      relativeAccuracy: this.relativeAccuracy,
      collapsed: this.collapsedFlag,
      bins: this.used + (this.zeroCount > 0 ? 1 : 0),
    });
  }

  /** Compact wire form: offset, zero count, and the dense run of counts. */
  encode(): string {
    const bins: number[] = [];
    for (let i = 0; i < this.used; i++) bins.push(this.counts[i] ?? 0);
    return JSON.stringify({
      v: 1,
      a: this.relativeAccuracy,
      o: this.offset,
      z: this.zeroCount,
      c: this.count,
      s: this.sum,
      mn: this.count === 0 ? 0 : this.min,
      mx: this.count === 0 ? 0 : this.max,
      x: this.collapsedFlag ? 1 : 0,
      b: bins,
    });
  }

  static decode(encoded: string, maxBins = DEFAULT_MAX_BINS): Sketch {
    const raw = JSON.parse(encoded) as {
      a: number; o: number; z: number; c: number; s: number;
      mn: number; mx: number; x: number; b: number[];
    };
    const sketch = new Sketch(raw.a, maxBins);
    sketch.offset = raw.o;
    sketch.zeroCount = raw.z;
    sketch.count = raw.c;
    sketch.sum = raw.s;
    sketch.min = raw.c === 0 ? Number.POSITIVE_INFINITY : raw.mn;
    sketch.max = raw.c === 0 ? Number.NEGATIVE_INFINITY : raw.mx;
    sketch.collapsedFlag = raw.x === 1;
    sketch.used = raw.b.length;
    sketch.counts = new Float64Array(Math.max(raw.b.length, 1));
    for (let i = 0; i < raw.b.length; i++) sketch.counts[i] = raw.b[i]!;
    return sketch;
  }
}
