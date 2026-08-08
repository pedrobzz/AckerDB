/**
 * Tail-sampled trace exemplars: one row per retained trace, and nothing at all
 * for the rest.
 *
 * The aggregate beside this sees every observation, so nothing here is
 * responsible for counting. What an exemplar is for is the other question — not
 * "how slow was this endpoint" but "show me one that was slow" — and answering
 * that needs a handful of whole traces, not all of them. Real products retain
 * 0.1%–1%; #194 attempted 100% and produced 512 MB a minute at design load.
 *
 * **Every stored trace says why it is here.** Selection reason, policy version,
 * inclusion probability, completeness, and the observed and omitted span counts
 * travel in the row. This is the contract, not bookkeeping: a retained cohort
 * deliberately over-represents errors and slow traces, so a stored trace that
 * cannot say why it was kept is indistinguishable from a representative sample.
 * Datadog documents exactly this hazard about its own diversity-sampled set and
 * tells readers to keep it out of analytics. Nothing may compute a rate, a
 * percentile, or a rank from this table — those come from the aggregate.
 *
 * **A trace that outgrew its budget says so.** Past the per-trace cap the
 * exemplar becomes `oversized`: the root, every error span, and a bounded set of
 * the slowest spans, with `complete: false` and the omitted count. A silently
 * truncated tree that still claims completeness is the one outcome this must
 * never produce, because it looks exactly like a small trace.
 */
import type { TelemetrySpanRecord } from "../contracts/types.ts";

/**
 * Bump when the thresholds or the shape of the selection change. Stored with
 * every row so a reader can tell traces selected under different policies apart
 * instead of pooling them.
 */
export const TRACE_POLICY_VERSION = 1;

export type ExemplarReason = "error" | "slow" | "baseline";

export interface TraceExemplarLimits {
  /** Spans one exemplar may carry before it becomes `oversized`. */
  readonly maxSpansPerTrace: number;
  /** Bytes one exemplar's payload may reach before it becomes `oversized`. */
  readonly maxBytesPerTrace: number;
  /** Traces accumulating at once; beyond this an unselected trace is discarded whole. */
  readonly maxOpenTraces: number;
  /** Bytes across every accumulating trace. */
  readonly maxOpenBytes: number;
  /** Share of healthy traces kept so "show me a normal one" has an answer. */
  readonly baselineProbability: number;
}

export const DEFAULT_EXEMPLAR_LIMITS: TraceExemplarLimits = Object.freeze({
  maxSpansPerTrace: 512,
  maxBytesPerTrace: 256 * 1_024,
  maxOpenTraces: 2_048,
  maxOpenBytes: 4 * 1_024 * 1_024,
  baselineProbability: 0.01,
});

export interface TraceExemplar {
  readonly traceId: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly rootFunction: string | undefined;
  readonly rootOperation: string | undefined;
  readonly outcome: string;
  readonly errorCount: number;
  /** Why this trace is stored. Never absent, never inferred by a reader. */
  readonly reason: ExemplarReason;
  readonly policyVersion: number;
  /** The chance a trace like this one had of being kept: 1 for error and slow. */
  readonly inclusionProbability: number;
  /** False when the payload is not the whole trace. */
  readonly complete: boolean;
  readonly oversized: boolean;
  /** Spans the collector saw, whether or not they are in the payload. */
  readonly observedSpans: number;
  /** Spans the payload leaves out. Zero exactly when `complete`. */
  readonly omittedSpans: number;
  readonly payload: string;
}

export interface TraceExemplarSnapshot {
  readonly openTraces: number;
  readonly openBytes: number;
  readonly retainedTraces: number;
  readonly oversizedTraces: number;
  readonly discardedTraces: number;
  readonly discardedSpans: number;
  readonly baselineProbability: number;
  readonly policyVersion: number;
}

interface OpenTrace {
  readonly traceId: string;
  readonly spans: TelemetrySpanRecord[];
  bytes: number;
  observed: number;
  errorSpans: TelemetrySpanRecord[];
  oversized: boolean;
  startedAtMs: number;
  endedAtMs: number;
  errorCount: number;
  /** Decided once, at creation, from the trace id — never re-rolled per span. */
  readonly baselineSelected: boolean;
}

/**
 * A stable [0,1) from a trace id. Deterministic so the baseline decision can be
 * made when the trace is created rather than when it ends: a selected trace
 * retains immediately, and only the undecided ones pay to be staged while their
 * error-or-slow verdict is still pending.
 */
export function traceFraction(traceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < traceId.length; index++) {
    hash ^= traceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

function spanBytes(span: TelemetrySpanRecord): number {
  return 96 +
    (span.function?.length ?? 0) +
    (span.statement?.length ?? 0) +
    (span.spanId?.length ?? 0) +
    (span.parentSpanId?.length ?? 0);
}

export class TraceExemplarCollector {
  readonly limits: TraceExemplarLimits;
  private readonly open = new Map<string, OpenTrace>();
  private openBytes = 0;
  private retainedTraces = 0;
  private oversizedTraces = 0;
  private discardedTraces = 0;
  private discardedSpans = 0;

  constructor(limits: Partial<TraceExemplarLimits> = {}) {
    this.limits = Object.freeze({ ...DEFAULT_EXEMPLAR_LIMITS, ...limits });
  }

  /** Whether a trace id is in the deterministic healthy-baseline share. */
  isBaseline(traceId: string): boolean {
    return traceFraction(traceId) < this.limits.baselineProbability;
  }

  /**
   * Offer one span. Accumulation is bounded twice: per trace, where overflow
   * turns the exemplar `oversized` rather than truncating it silently, and
   * globally, where exhaustion discards an entire trace rather than leaving a
   * mutilated one behind.
   */
  observe(traceId: string, span: TelemetrySpanRecord): void {
    let trace = this.open.get(traceId);
    if (trace === undefined) {
      if (this.open.size >= this.limits.maxOpenTraces || this.openBytes >= this.limits.maxOpenBytes) {
        this.discardedTraces++;
        this.discardedSpans++;
        return;
      }
      trace = {
        traceId,
        spans: [],
        bytes: 0,
        observed: 0,
        errorSpans: [],
        oversized: false,
        startedAtMs: span.timestampMs,
        endedAtMs: span.timestampMs,
        errorCount: 0,
        baselineSelected: this.isBaseline(traceId),
      };
      this.open.set(traceId, trace);
    }
    trace.observed++;
    if (span.timestampMs < trace.startedAtMs) trace.startedAtMs = span.timestampMs;
    const endedAt = span.timestampMs + span.durationMs;
    if (endedAt > trace.endedAtMs) trace.endedAtMs = endedAt;
    if (span.outcome !== "ok") {
      trace.errorCount++;
      // Error spans are what an operator opened the trace for, so they survive
      // the cap even when the ordinary span list stops growing.
      if (trace.errorSpans.length < 32) trace.errorSpans.push(span);
    }
    const bytes = spanBytes(span);
    if (
      trace.spans.length >= this.limits.maxSpansPerTrace ||
      trace.bytes + bytes > this.limits.maxBytesPerTrace
    ) {
      trace.oversized = true;
      return;
    }
    trace.spans.push(span);
    trace.bytes += bytes;
    this.openBytes += bytes;
  }

  /**
   * Close a trace. Returns an exemplar when the policy kept it, `undefined`
   * when it did not — and forgetting is the common case by design.
   */
  settle(
    traceId: string,
    slowOperationMs: number,
  ): TraceExemplar | undefined {
    const trace = this.open.get(traceId);
    if (trace === undefined) return undefined;
    this.open.delete(traceId);
    this.openBytes -= trace.bytes;
    const durationMs = Math.max(0, trace.endedAtMs - trace.startedAtMs);
    const slow = slowOperationMs > 0 && durationMs >= slowOperationMs;
    const reason: ExemplarReason | undefined = trace.errorCount > 0
      ? "error"
      : slow
        ? "slow"
        : trace.baselineSelected
          ? "baseline"
          : undefined;
    if (reason === undefined) {
      this.discardedTraces++;
      this.discardedSpans += trace.observed;
      return undefined;
    }
    this.retainedTraces++;
    if (trace.oversized) this.oversizedTraces++;
    const root = trace.spans.find((span) => span.parentSpanId === undefined) ?? trace.spans[0];
    // An oversized exemplar carries the root, every error span it kept, and the
    // slowest of the rest — the parts an operator opened it for.
    const carried = trace.oversized
      ? dedupe([
          ...(root === undefined ? [] : [root]),
          ...trace.errorSpans,
          ...[...trace.spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, 64),
        ])
      : trace.spans;
    return Object.freeze({
      traceId,
      startedAtMs: trace.startedAtMs,
      durationMs,
      rootFunction: root?.function,
      rootOperation: root?.operation,
      outcome: trace.errorCount > 0 ? "error" : "ok",
      errorCount: trace.errorCount,
      reason,
      policyVersion: TRACE_POLICY_VERSION,
      inclusionProbability: reason === "baseline" ? this.limits.baselineProbability : 1,
      complete: !trace.oversized,
      oversized: trace.oversized,
      observedSpans: trace.observed,
      omittedSpans: Math.max(0, trace.observed - carried.length),
      payload: JSON.stringify(carried.map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        operation: span.operation,
        stage: span.stage,
        outcome: span.outcome,
        function: span.function,
        statement: span.statement,
        timestampMs: span.timestampMs,
        durationMs: span.durationMs,
      }))),
    });
  }

  /** Forget a trace without producing an exemplar — a drain drops what is open. */
  abandon(traceId: string): void {
    const trace = this.open.get(traceId);
    if (trace === undefined) return;
    this.open.delete(traceId);
    this.openBytes -= trace.bytes;
    this.discardedTraces++;
    this.discardedSpans += trace.observed;
  }

  snapshot(): TraceExemplarSnapshot {
    return Object.freeze({
      openTraces: this.open.size,
      openBytes: this.openBytes,
      retainedTraces: this.retainedTraces,
      oversizedTraces: this.oversizedTraces,
      discardedTraces: this.discardedTraces,
      discardedSpans: this.discardedSpans,
      baselineProbability: this.limits.baselineProbability,
      policyVersion: TRACE_POLICY_VERSION,
    });
  }
}

function dedupe(spans: readonly TelemetrySpanRecord[]): TelemetrySpanRecord[] {
  const seen = new Set<TelemetrySpanRecord>();
  const out: TelemetrySpanRecord[] = [];
  for (const span of spans) {
    if (seen.has(span)) continue;
    seen.add(span);
    out.push(span);
  }
  return out;
}
