/**
 * A mergeable, bounded distribution with a declared relative error, on the grid
 * OpenTelemetry already speaks.
 *
 * Bucket `i` holds values in `(γ^(i-1), γ^i]`, so every bucket is a constant
 * *relative* width and a quantile answered from bucket `i` is within `α` of the
 * true value. That is the property a latency distribution needs — an
 * absolute-width histogram either wastes thousands of buckets on the millisecond
 * range or cannot tell 900 ms from 1,400 ms — and it is the property that makes
 * two sketches mergeable by adding their counts, which is what lets a minute
 * bucket roll up into an hour without going back to the raw observations.
 *
 * **γ is not a free parameter.** OTLP's `ExponentialHistogramDataPoint` fixes
 * `γ = 2^(2^-scale)` for an INTEGER scale, and its exemplar list carrying
 * `trace_id` is exactly this model's aggregate-plus-exemplar shape. Choosing γ
 * from a target α instead — α = 0.01 gives γ = 1.020202, which is scale 5.115 —
 * lands the grid between two legal scales, and then every export is a lossy
 * re-bucket of numbers we computed exactly. So the scale is the parameter and α
 * is derived from it. Scale 6 declares 0.5415%, which is a tighter guarantee
 * than the 1% it replaces.
 *
 * **Over the bin budget it DOWNSCALES; it never collapses.** Halving the scale
 * merges adjacent bucket pairs exactly — `key → ceil(key/2)` — so the shape
 * survives and only the declared error widens, and the widened bound is reported
 * with the data. The alternative, folding the lowest buckets together, destroys
 * the body of the distribution to protect the tail and leaves a p50 that is
 * wrong by an unstated amount. Downscaling is also what every OTLP consumer
 * does: Grafana Mimir silently downscales samples above its bucket limit, which
 * would void a declared bound computed here with nothing raised. Staying inside
 * the budget ourselves means the number on the wire is the number we measured.
 *
 * **The sketch sees 100% of observations and is still numerically approximate.**
 * Those are different properties and conflating them is how a percentile becomes
 * a lie. Count, error count and total are exact; quantiles carry `α`. Both facts
 * travel with the data rather than living in someone's memory.
 */

/**
 * OTLP exponential-histogram scale. 6 gives γ = 2^(1/64) = 1.01089 and a 0.5415%
 * relative bound — one integer step finer than Datadog's production 1% shape and,
 * unlike it, expressible on the wire without re-bucketing.
 */
export const DEFAULT_MAPPING_SCALE = 6;

/**
 * The STORED bucket budget, which is not the wire budget.
 *
 * A consumer's bucket limit is a limit on what it accepts, and OTLP carries a
 * `scale` field precisely so a producer can merge adjacent buckets on the way
 * out — downscaling is the format's designed mechanism, not data loss. Sizing
 * storage to the smallest consumer would be sizing the product to the wire: 160
 * buckets at scale 6 span 5.66×, which for latency means a busy series is
 * permanently coarse, and once coarse it cannot be made fine again for anyone.
 *
 * So the resolution the product needs is stored, and export coarsens to whatever
 * a given consumer accepts and declares the widened bound it is sending. 2,048
 * at scale 6 spans 2^32, which covers every latency a request can have.
 */
export const DEFAULT_MAX_BINS = 2_048;

/** OTLP's floor. At scale −10 one bucket covers the whole double range. */
export const MIN_MAPPING_SCALE = -10;

export function mappingGamma(scale: number): number {
  return 2 ** (2 ** -scale);
}

/** The bound a scale declares: α = (γ−1)/(γ+1). */
export function mappingRelativeAccuracy(scale: number): number {
  const gamma = mappingGamma(scale);
  return (gamma - 1) / (gamma + 1);
}

export const DEFAULT_RELATIVE_ACCURACY = mappingRelativeAccuracy(DEFAULT_MAPPING_SCALE);

/** `1 / ln(γ)`, cached by callers that place many values on one scale. */
export function scaleMultiplier(scale: number): number {
  return 1 / Math.log(mappingGamma(scale));
}

/**
 * The bucket a value belongs to. It is the ONE definition, exported because
 * anything comparing a value against a bucket boundary has to do it here, in
 * integer key space, and never against a reconstructed edge.
 *
 * Reconstructing the edge is a fail-open. Bucket `k` covers `(γ^(k-1), γ^k]`, so
 * "above the boundary bucket" reads naturally as `value > γ^k` — but `γ^k` is
 * computed in floating point, and at scale 6 every power of two is an exact
 * bucket edge, so `Math.pow(2 ** (1/64), 64)` is 1.9999999999999964 and a
 * constant 2 ms endpoint tests as ABOVE its own bucket. Every observation then
 * retains, which is the third time a rule of the form "retain when X" in this
 * component has had its X quietly stop discriminating.
 */
export function bucketKey(value: number, multiplier: number): number {
  return Math.ceil(Math.log(value) * multiplier);
}

export interface SketchSnapshot {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** The scale this sketch ended at; it only ever coarsens. */
  readonly mappingScale: number;
  /** Derived from the scale, so it is always the bound that currently holds. */
  readonly relativeAccuracy: number;
  readonly bins: number;
}

export class Sketch {
  readonly maxBins: number;
  private mappingScale: number;
  private gamma: number;
  private multiplier: number;
  /** Dense counts from `offset` upward; index 0 is bucket key `offset`. */
  private counts: Float64Array;
  private offset = 0;
  private used = 0;
  private zeroCount = 0;
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  constructor(scale = DEFAULT_MAPPING_SCALE, maxBins = DEFAULT_MAX_BINS) {
    if (!Number.isSafeInteger(scale) || scale < MIN_MAPPING_SCALE || scale > 20) {
      throw new RangeError(`sketch scale must be an integer in [${MIN_MAPPING_SCALE}, 20]`);
    }
    if (!Number.isSafeInteger(maxBins) || maxBins < 2) {
      throw new RangeError("sketch maxBins must be an integer of at least 2");
    }
    this.maxBins = maxBins;
    this.mappingScale = scale;
    this.gamma = mappingGamma(scale);
    this.multiplier = 1 / Math.log(this.gamma);
    this.counts = new Float64Array(Math.min(maxBins, 64));
  }

  get scale(): number {
    return this.mappingScale;
  }

  get relativeAccuracy(): number {
    return mappingRelativeAccuracy(this.mappingScale);
  }

  private key(value: number): number {
    return bucketKey(value, this.multiplier);
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
    const lowest = Math.min(key, this.offset);
    const highest = Math.max(key, this.offset + this.used - 1);
    const steps = this.stepsToFit(lowest, highest);
    if (steps > 0) {
      this.downscale(steps);
      this.addToKey(Math.ceil(key / 2 ** steps), weight);
      return;
    }
    if (key < this.offset) {
      const growth = this.offset - key;
      this.reserve(this.used + growth, growth);
      this.offset = key;
      this.used += growth;
      this.counts[0] = weight;
      return;
    }
    const index = key - this.offset;
    if (index >= this.used) {
      this.reserve(index + 1, 0);
      this.used = index + 1;
    }
    this.counts[index] = (this.counts[index] ?? 0) + weight;
  }

  /**
   * How many halvings the mapping needs before `[lowest, highest]` fits the bin
   * budget. Each step is exact — `key → ceil(key/2)` is the bucket pairing OTLP
   * defines — so this widens the declared bound and nothing else.
   */
  private stepsToFit(lowest: number, highest: number): number {
    let steps = 0;
    while (
      this.mappingScale - steps > MIN_MAPPING_SCALE &&
      Math.ceil(highest / 2 ** steps) - Math.ceil(lowest / 2 ** steps) + 1 > this.maxBins
    ) {
      steps++;
    }
    return steps;
  }

  /**
   * Return this distribution on a coarser grid, for a consumer whose bucket
   * limit is below ours. Exact — each step merges adjacent bucket pairs — and
   * the result reports the widened bound as its own, so what is declared on the
   * wire is what was actually sent.
   */
  coarsenTo(scale: number): Sketch {
    if (scale >= this.mappingScale) return this;
    const coarse = Sketch.decode(this.encode(), this.maxBins);
    coarse.downscale(this.mappingScale - scale);
    return coarse;
  }

  private downscale(steps: number): void {
    const divisor = 2 ** steps;
    const nextOffset = Math.ceil(this.offset / divisor);
    const nextTop = Math.ceil((this.offset + this.used - 1) / divisor);
    const next = new Float64Array(Math.max(1, nextTop - nextOffset + 1));
    for (let index = 0; index < this.used; index++) {
      const weight = this.counts[index] ?? 0;
      if (weight === 0) continue;
      const slot = Math.ceil((this.offset + index) / divisor) - nextOffset;
      next[slot] = (next[slot] ?? 0) + weight;
    }
    this.counts = next;
    this.offset = nextOffset;
    this.used = next.length;
    this.mappingScale -= steps;
    this.gamma = mappingGamma(this.mappingScale);
    this.multiplier = 1 / Math.log(this.gamma);
  }

  private reserve(needed: number, shiftBy: number): void {
    if (needed <= this.counts.length && shiftBy === 0) return;
    const capacity = Math.min(this.maxBins, Math.max(needed, this.counts.length * 2));
    const next = new Float64Array(capacity);
    for (let i = 0; i < this.used; i++) next[i + shiftBy] = this.counts[i] ?? 0;
    this.counts = next;
  }

  /**
   * Fold `other` in. Scales are reconciled to the coarser of the two, which is
   * OTLP's own merge rule: the finer sketch can always be expressed on the
   * coarser grid exactly, and never the other way round.
   */
  merge(other: Sketch): void {
    if (other.count === 0) return;
    if (other.mappingScale < this.mappingScale) {
      this.downscale(this.mappingScale - other.mappingScale);
    }
    this.count += other.count;
    this.sum += other.sum;
    if (other.min < this.min) this.min = other.min;
    if (other.max > this.max) this.max = other.max;
    this.zeroCount += other.zeroCount;
    for (let i = 0; i < other.used; i++) {
      const weight = other.counts[i] ?? 0;
      if (weight === 0) continue;
      // Recomputed per bucket: folding these in can itself force a downscale,
      // and a shift captured before the loop would map the rest onto the grid
      // this sketch has already left.
      const shift = other.mappingScale - this.mappingScale;
      this.addToKey(
        shift === 0 ? other.offset + i : Math.ceil((other.offset + i) / 2 ** shift),
        weight,
      );
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
        return (2 * this.gamma ** key) / (this.gamma + 1);
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
  /**
   * The quantile's value AND the bucket it came from, in one answer.
   *
   * The policy previously took `quantile(q)` and handed the millisecond result
   * back to `shareAtAndAbove`, which re-derived the key from it — a round trip
   * through a float to recover an integer this class never lost. It happens to
   * survive, because a bucket's reported value is its midpoint and a midpoint is
   * far from both edges, but it is the same shape as the defect that made a
   * constant-latency endpoint retain 100%: a boundary reconstructed instead of
   * carried. The key is carried.
   */
  quantileBucket(q: number): {
    readonly valueMs: number;
    readonly at: number;
    readonly above: number;
    readonly key: number;
    readonly mappingScale: number;
  } | undefined {
    if (this.count === 0 || !(q >= 0 && q <= 1)) return undefined;
    const target = q * (this.count - 1);
    let seen = this.zeroCount;
    let key = Number.NEGATIVE_INFINITY;
    let valueMs = 0;
    if (target >= seen) {
      let found = false;
      for (let i = 0; i < this.used; i++) {
        seen += this.counts[i] ?? 0;
        if (seen > target) {
          key = this.offset + i;
          valueMs = (2 * this.gamma ** key) / (this.gamma + 1);
          found = true;
          break;
        }
      }
      if (!found) return undefined;
    }
    let at = 0;
    let above = 0;
    for (let i = 0; i < this.used; i++) {
      const weight = this.counts[i] ?? 0;
      if (weight === 0) continue;
      const bucket = this.offset + i;
      if (bucket === key) at += weight;
      else if (bucket > key) above += weight;
    }
    if (key === Number.NEGATIVE_INFINITY) at = this.zeroCount;
    return {
      valueMs,
      at: at / this.count,
      above: above / this.count,
      key,
      mappingScale: this.mappingScale,
    };
  }

  shareAtAndAbove(value: number): {
    readonly at: number;
    readonly above: number;
    /** The boundary bucket, so a caller compares keys and never float edges. */
    readonly key: number;
    readonly mappingScale: number;
  } | undefined {
    if (this.count === 0 || !Number.isFinite(value) || value < 0) return undefined;
    const key = value === 0 ? Number.NEGATIVE_INFINITY : this.key(value);
    if (value === 0) {
      return {
        at: this.zeroCount / this.count,
        above: (this.count - this.zeroCount) / this.count,
        key,
        mappingScale: this.mappingScale,
      };
    }
    let at = 0;
    let above = 0;
    for (let i = 0; i < this.used; i++) {
      const weight = this.counts[i] ?? 0;
      if (weight === 0) continue;
      const bucket = this.offset + i;
      if (bucket === key) at += weight;
      else if (bucket > key) above += weight;
    }
    return {
      at: at / this.count,
      above: above / this.count,
      key,
      mappingScale: this.mappingScale,
    };
  }

  snapshot(): SketchSnapshot {
    return Object.freeze({
      count: this.count,
      sum: this.sum,
      min: this.count === 0 ? 0 : this.min,
      max: this.count === 0 ? 0 : this.max,
      mappingScale: this.mappingScale,
      relativeAccuracy: this.relativeAccuracy,
      bins: this.used + (this.zeroCount > 0 ? 1 : 0),
    });
  }

  /** Compact wire form: scale, offset, zero count, and the dense run of counts. */
  encode(): string {
    const bins: number[] = [];
    for (let i = 0; i < this.used; i++) bins.push(this.counts[i] ?? 0);
    return JSON.stringify({
      v: 2,
      sc: this.mappingScale,
      o: this.offset,
      z: this.zeroCount,
      c: this.count,
      s: this.sum,
      mn: this.count === 0 ? 0 : this.min,
      mx: this.count === 0 ? 0 : this.max,
      b: bins,
    });
  }

  static decode(encoded: string, maxBins = DEFAULT_MAX_BINS): Sketch {
    const raw = JSON.parse(encoded) as {
      sc: number; o: number; z: number; c: number; s: number;
      mn: number; mx: number; b: number[];
    };
    const sketch = new Sketch(raw.sc, Math.max(maxBins, raw.b.length));
    sketch.offset = raw.o;
    sketch.zeroCount = raw.z;
    sketch.count = raw.c;
    sketch.sum = raw.s;
    sketch.min = raw.c === 0 ? Number.POSITIVE_INFINITY : raw.mn;
    sketch.max = raw.c === 0 ? Number.NEGATIVE_INFINITY : raw.mx;
    sketch.used = raw.b.length;
    sketch.counts = new Float64Array(Math.max(raw.b.length, 1));
    for (let i = 0; i < raw.b.length; i++) sketch.counts[i] = raw.b[i]!;
    return sketch;
  }
}
