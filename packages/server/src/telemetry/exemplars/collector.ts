/**
 * What a retained trace looks like on the way to storage.
 *
 * There is no collector here any more. Accumulating spans per trace, bounding
 * that accumulation, and deciding at trace end whether to keep it are all
 * `TraceRetention`'s job and always were — a second component doing the same
 * three things beside it staged every trace's spans twice, which is precisely
 * the memory this design exists to bound, and gave two places for the same
 * judgement to drift. One decision, made once, where the trace settles.
 *
 * What is left is the row: its shape, the disclosure it must carry, and the
 * bounded payload built from the spans the trace already staged.
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
 * exemplar becomes `oversized`: what it kept, with `complete: false` and the
 * omitted count. A silently truncated tree that still claims completeness is the
 * one outcome this must never produce, because it looks exactly like a small one.
 */
import type { TelemetrySpanRecord } from "../contracts/types.ts";
import type { ExemplarReason, ExemplarVerdict } from "../policy.ts";

export type { ExemplarReason };

/**
 * Bump when the thresholds or the shape of the selection change. Stored with
 * every row so a reader can tell traces selected under different policies apart
 * instead of pooling them.
 */
export const TRACE_POLICY_VERSION = 1;

export interface TraceExemplarLimits {
  /** Share of healthy traces kept so "show me a normal one" has an answer. */
  readonly baselineProbability: number;
}

export const DEFAULT_EXEMPLAR_LIMITS: TraceExemplarLimits = Object.freeze({
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
  /**
   * The cohort quantile this trace was measured against, in milliseconds —
   * absent while the cohort was still cold. Stored so a reader can tell a trace
   * kept under a 40 ms threshold from one kept under 4 s.
   */
  readonly thresholdMs: number | undefined;
  readonly inclusionProbability: number;
  /** False when the payload is not the whole trace. */
  readonly complete: boolean;
  readonly oversized: boolean;
  /** Spans the trace saw, whether or not they are in the payload. */
  readonly observedSpans: number;
  /** Spans the payload leaves out. Zero exactly when `complete`. */
  readonly omittedSpans: number;
  readonly payload: string;
}

export interface TraceExemplarInput {
  readonly traceId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly errorSpans: number;
  readonly observedSpans: number;
  readonly omittedSpans: number;
  readonly verdict: ExemplarVerdict;
  readonly spans: readonly TelemetrySpanRecord[];
}

/** Build one row from the spans the trace staged and the verdict that kept it. */
export function buildExemplar(input: TraceExemplarInput): TraceExemplar {
  const root = input.spans.find((candidate) => candidate.parentSpanId === undefined) ??
    input.spans[0];
  return Object.freeze({
    traceId: input.traceId,
    startedAtMs: input.startedAtMs,
    durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
    rootFunction: root?.function,
    rootOperation: root?.operation,
    outcome: input.errorSpans > 0 ? "error" : "ok",
    errorCount: input.errorSpans,
    reason: input.verdict.reason,
    policyVersion: TRACE_POLICY_VERSION,
    thresholdMs: input.verdict.thresholdMs,
    inclusionProbability: input.verdict.inclusionProbability,
    complete: input.omittedSpans === 0,
    oversized: input.omittedSpans > 0,
    observedSpans: input.observedSpans,
    omittedSpans: input.omittedSpans,
    payload: JSON.stringify(input.spans.map((span) => ({
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
