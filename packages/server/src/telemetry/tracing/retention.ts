import type { TelemetryRecordContext, TelemetrySpanRecord } from "../contracts/types.ts";
import type { TelemetryOperation } from "../contracts/schema.ts";
import { materializeSpan, stagedSpanBytes } from "../records/codec.ts";
import { boundedCount, safeId } from "../records/sanitize.ts";
import type { SanitizedTelemetrySpan } from "../records/types.ts";
import { NO_SLOT } from "../state/constants.ts";
import type {
  MutableTraceList,
  MutableTraceRetention,
  TelemetryState,
} from "../state/types.ts";
import { selectExemplar, type CohortThreshold } from "../policy.ts";
import { bucketKey, scaleMultiplier } from "../aggregation/sketch.ts";
import {
  DEFAULT_EXEMPLAR_LIMITS,
  type TraceExemplarInput,
  type TraceExemplarLimits,
} from "../exemplars/collector.ts";
import { AuthenticTelemetryTraceContext } from "./context.ts";
import type { OperationTrace } from "./operation-trace.ts";

type RetainSpan = (record: TelemetrySpanRecord, retainedAtMs: number) => void;

export interface TraceRetentionSinks {
  /** Where a retained span goes for the in-memory export and local pipelines. */
  readonly retainSpan: RetainSpan;
  /** The cohort distribution a slow verdict is measured against. */
  readonly thresholdFor: (
    operation: TelemetryOperation | undefined,
    functionAddress: string | undefined,
  ) => CohortThreshold;
  /**
   * A settled trace worth storing, handed over RAW. Turning it into a row means
   * serializing its span tree, and settle runs inside an operation's own
   * response path — so what crosses here is the facts and the span references,
   * and the building happens on a deferred pump.
   */
  readonly exemplar?: (settled: TraceExemplarInput) => void;
  readonly limits?: Partial<TraceExemplarLimits>;
}

/**
 * Owns bounded trace decisions, staged tails, promotion, delayed-delivery
 * leases — and the exemplar a retained trace becomes.
 *
 * **One decision, made once, where the trace settles.** A trace either matters
 * or it does not, and both the in-memory export pipeline and the durable
 * exemplar store want the answer to that same question about the same spans.
 * They were briefly two components asking it separately, which staged every
 * trace's spans twice and gave the judgement two places to drift. The spans stage
 * once here, in the fixed-slot journal that already bounds them globally, and one
 * drain at settle feeds both consumers.
 *
 * **What "matters" means is not decided here.** `policy.ts` owns the rule — the
 * tail quantile read from the same distribution the chart reports, the rate
 * invariant at the boundary bucket, the baseline share. This class owns the
 * bounds, the lifecycle and the staging, which are commodity.
 */
export class TraceRetention {
  private readonly retainSpan: RetainSpan;
  private readonly exemplarLimits: TraceExemplarLimits;

  constructor(
    private readonly state: TelemetryState,
    private readonly sinks: TraceRetentionSinks,
  ) {
    this.retainSpan = sinks.retainSpan;
    this.exemplarLimits = { ...DEFAULT_EXEMPLAR_LIMITS, ...sinks.limits };
  }

  create(
    startedAtMs: number,
    traceId?: string,
    rootContext?: AuthenticTelemetryTraceContext,
    operationTrace?: OperationTrace,
  ): MutableTraceRetention | undefined {
    const state = this.state;
    while (
      state.activeTraces.size + state.completedTraces.size >= state.limits.maxRecords &&
      state.completedTraces.size > 0
    ) {
      this.evictOldestCompleted();
    }
    if (state.activeTraces.size + state.completedTraces.size >= state.limits.maxRecords) {
      state.traceHealth.dropped.activeOverflow = boundedCount(
        state.traceHealth.dropped.activeOverflow,
      );
      return undefined;
    }
    return {
      traceId,
      startedAtMs,
      endedAtMs: startedAtMs,
      observedSpans: 0,
      omittedSpans: 0,
      errorSpans: 0,
      owner: state,
      rootContext,
      operationTrace,
      phase: "active",
      retained: false,
      stagedHead: NO_SLOT,
      stagedTail: NO_SLOT,
      stagedRecords: 0,
      stagedBytes: 0,
    };
  }

  activate(trace: MutableTraceRetention): void {
    trace.phase = "active";
    this.append(this.state.activeTraces, trace);
  }

  /**
   * The trace is over, so its duration is known and the verdict can be taken.
   * Emission waits for settle, because a delayed delivery span still belongs to
   * this trace and an exemplar written before them would be missing them.
   */
  complete(trace: MutableTraceRetention, completedAtMs: number): void {
    const state = this.state;
    if (completedAtMs > trace.endedAtMs) trace.endedAtMs = completedAtMs;
    if (trace.verdict === undefined && trace.errorSpans === 0 && this.sinks.exemplar !== undefined) {
      const durationMs = Math.max(0, trace.endedAtMs - trace.startedAtMs);
      const cohort = this.sinks.thresholdFor(trace.rootOperation, trace.rootFunction);
      trace.verdict = selectExemplar({
        traceId: () => this.traceIdOf(trace),
        durationMs,
        errorSpans: trace.errorSpans,
        cohort,
        baselineProbability: this.exemplarLimits.baselineProbability,
        durationKey: durationMs > 0
          ? bucketKey(durationMs, scaleMultiplier(cohort.mappingScale))
          : undefined,
      });
    }
    if (trace.errorSpans > 0 && this.sinks.exemplar !== undefined) {
      trace.verdict ??= { reason: "error", inclusionProbability: 1, thresholdMs: undefined };
    }
    // The export pipeline keeps its own predicate. It feeds an external APM the
    // operator configured, which does its own sampling and has its own contract;
    // the exemplar verdict decides what goes in OUR store. Same spans, same
    // staging, same settle — two sinks, two questions. Collapsing them would
    // silently change what an existing exporter receives, and "cold retains
    // outright" is a rule about a fresh cohort's exemplars, not about flooding
    // someone's APM for the first fifty traces of every deploy.
    if (
      !trace.retained &&
      completedAtMs - trace.startedAtMs >= state.limits.slowOperationMs
    ) {
      this.promote(trace, completedAtMs);
    }
    // A trace the export pipeline did not want can still be an exemplar, so its
    // spans are collected here rather than left to a drain that discards them.
    if (!trace.retained && trace.verdict !== undefined && this.wantsExemplar(trace)) {
      trace.exemplarSpans ??= [];
    }
    trace.completedAtMs = completedAtMs;
    this.unlink(state.activeTraces, trace);
    trace.phase = "completed";
    if (trace.stagedRecords > 0) state.completedTracesWithStaging++;
    this.append(state.completedTraces, trace);
    if (trace.pendingDeliveries === 0) this.settleDelivered(trace);
  }

  claimDelivery(trace: MutableTraceRetention | undefined): MutableTraceRetention | undefined {
    if (
      trace?.owner !== this.state ||
      trace.phase !== "active" ||
      trace.pendingDeliveries === Number.MAX_SAFE_INTEGER
    ) return undefined;
    trace.pendingDeliveries = (trace.pendingDeliveries ?? 0) + 1;
    return trace;
  }

  releaseDelivery(trace: MutableTraceRetention): void {
    if (
      trace.owner !== this.state ||
      trace.phase === "settled" ||
      trace.pendingDeliveries === undefined ||
      trace.pendingDeliveries === 0
    ) return;
    trace.pendingDeliveries--;
    if (trace.phase === "completed" && trace.pendingDeliveries === 0) {
      this.settleDelivered(trace);
    }
  }

  /**
   * Stage one span against its trace, and record the facts a verdict and an
   * exemplar need. Every span passes here, retained or not, because which it is
   * has not been decided yet — that is what tail sampling means.
   *
   * Nothing here reads a trace id. An operation trace allocates one on first
   * read, so touching it while staging would put a `randomUUID` on every span of
   * every trace — which is what the lazy-id guard in the suite exists to catch.
   */
  /**
   * Record what one span says about its trace: how many there were, when it
   * really started and ended, whether anything failed, and which cohort its root
   * belongs to.
   *
   * Separate from staging because a span on an ALREADY retained trace never
   * stages — it goes straight to the export pipeline — and the facts must be the
   * same either way. Folding the two together is how an errored trace ended up
   * reporting zero errors: every one of its spans took the other branch.
   */
  observeSpan(trace: MutableTraceRetention, span: SanitizedTelemetrySpan): void {
    trace.observedSpans++;
    if (span.timestampMs < trace.startedAtMs) trace.startedAtMs = span.timestampMs;
    const endedAt = span.timestampMs + span.durationMs;
    if (endedAt > trace.endedAtMs) trace.endedAtMs = endedAt;
    if (span.outcome !== "ok") trace.errorSpans++;
    if (trace.rootFunction === undefined && span.context.parentSpanId === undefined) {
      trace.rootFunction = span.function;
      trace.rootOperation = span.operation;
    }
  }

  stageSpan(trace: MutableTraceRetention, span: SanitizedTelemetrySpan): void {
    this.observeSpan(trace, span);
    // One trace may stage at most one export batch; an active high-fanout
    // trace must not accumulate the whole queue and evict every other record.
    // Past that the exemplar becomes oversized and SAYS so, because a silently
    // truncated tree looks exactly like a genuinely small one.
    if (!this.canStageSpan(trace)) {
      trace.omittedSpans++;
      return;
    }
    if (!this.stageJournalSpan(trace, span, stagedSpanBytes(span))) trace.omittedSpans++;
  }

  /**
   * Mark a trace worth keeping and release its staged tail to the export
   * pipeline immediately. Immediately matters: staging is the bounded resource
   * every trace shares, and a long-lived trace that held its spans until settle
   * would occupy it for as long as it runs.
   *
   * The same drain starts the exemplar's span list when one is wanted. That list
   * holds REFERENCES to the records the export pipeline already has — one
   * pointer per span of the retained minority, released at settle — not a second
   * copy of every trace's tree.
   */
  promote(trace: MutableTraceRetention, retainedAtMs: number): void {
    if (trace.retained) return;
    trace.retained = true;
    if (this.sinks.exemplar !== undefined) trace.exemplarSpans ??= [];
    this.state.traceHealth.promotedTraces = boundedCount(
      this.state.traceHealth.promotedTraces,
    );
    this.drainSpans(trace, retainedAtMs, trace.exemplarSpans);
  }

  /** One already-retained span, to the export pipeline and the exemplar alike. */
  retainSpanFor(
    trace: MutableTraceRetention,
    span: SanitizedTelemetrySpan,
    record: TelemetrySpanRecord,
  ): void {
    this.observeSpan(trace, span);
    if (trace.exemplarSpans === undefined && this.sinks.exemplar !== undefined) {
      // The verdict is not in yet for a trace promoted by an error mid-flight,
      // but an error is already a keep, so collection starts now rather than
      // losing every span between promotion and completion.
      trace.exemplarSpans = [];
    }
    trace.exemplarSpans?.push(record);
    this.retainSpan(record, span.timestampMs);
  }

  private wantsExemplar(trace: MutableTraceRetention): boolean {
    return this.sinks.exemplar !== undefined && trace.verdict !== undefined;
  }

  /**
   * The trace's id, materializing an operation trace's lazy UUID only now — at
   * most once per trace, and only for one the policy is about to keep.
   */
  private traceIdOf(trace: MutableTraceRetention): string | undefined {
    return trace.traceId ??= trace.rootContext?.traceId ??
      trace.operationTrace?.materializeTraceId();
  }

  forContext(
    context: Pick<TelemetryRecordContext, "traceId"> | undefined,
  ): MutableTraceRetention | undefined {
    const state = this.state;
    if (AuthenticTelemetryTraceContext.owns(context)) {
      const trace = AuthenticTelemetryTraceContext.retention(context);
      return trace?.owner === state && trace.phase !== "settled" ? trace : undefined;
    }
    const traceId = context === undefined ? undefined : safeId(context.traceId);
    if (traceId === undefined) return undefined;
    const publicTrace = state.publicTraceIndex.get(traceId);
    if (publicTrace !== undefined) return publicTrace;
    for (let trace = state.activeTraces.head; trace !== undefined; trace = trace.next) {
      if (trace.traceId === traceId) return trace;
    }
    for (let trace = state.completedTraces.head; trace !== undefined; trace = trace.next) {
      if (trace.traceId === traceId) return trace;
    }
    return undefined;
  }

  abortActive(trace: MutableTraceRetention | undefined): void {
    if (trace?.owner !== this.state || trace.phase !== "active") return;
    this.remove(trace);
    this.settle(trace, trace.endedAtMs);
  }

  discardAll(): void {
    const state = this.state;
    const traces = state.activeTraces.size + state.completedTraces.size;
    // A trace already judged worth keeping is drained rather than dropped: its
    // spans were held here precisely so one drain could serve both consumers, so
    // a shutdown that discarded them would lose records the pipeline previously
    // already had. An unjudged trace is still released without force-promoting.
    for (let trace = state.activeTraces.head; trace !== undefined;) {
      const next = trace.next;
      this.remove(trace);
      this.settle(trace, trace.endedAtMs);
      trace = next;
    }
    for (let trace = state.completedTraces.head; trace !== undefined;) {
      const next = trace.next;
      this.remove(trace);
      this.settle(trace, trace.endedAtMs);
      trace = next;
    }
    state.publicTraceIndex = new Map();
    state.publicTraceDeletions = 0;
    state.traceHealth.dropped.drain = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.traceHealth.dropped.drain + traces,
    );
  }

  pruneCompleted(now: number): void {
    while (this.state.completedTraces.head !== undefined) {
      const oldest = this.state.completedTraces.head;
      if (
        oldest.completedAtMs === undefined ||
        now - oldest.completedAtMs < this.state.limits.retentionMs
      ) return;
      this.removeCompleted(oldest, "expiredDecisions");
    }
  }

  private canStageSpan(trace: MutableTraceRetention): boolean {
    const state = this.state;
    const excludedCompletedTrace = trace.phase === "completed" && trace.stagedRecords > 0
      ? 1
      : 0;
    const available = trace.stagedRecords < state.limits.maxBatchRecords &&
      (state.completedTracesWithStaging > excludedCompletedTrace ||
        (state.stagedTraceRecords < state.limits.maxRecords &&
          state.stagedTraceBytes < state.limits.maxBytes));
    if (!available) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
    }
    return available;
  }

  private stageJournalSpan(
    trace: MutableTraceRetention,
    span: SanitizedTelemetrySpan,
    bytes: number,
  ): boolean {
    const state = this.state;
    while (
      (state.stagedTraceRecords >= state.limits.maxRecords ||
        bytes > state.limits.maxBytes - state.stagedTraceBytes) &&
      this.evictOldestCompleted(trace, true)
    ) {
      // Prefer a current active trace over an older completed tail decision.
    }
    if (
      bytes > state.limits.maxBytes ||
      state.stagedTraceRecords >= state.limits.maxRecords ||
      bytes > state.limits.maxBytes - state.stagedTraceBytes
    ) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return false;
    }
    const wasEmpty = trace.stagedRecords === 0;
    if (!state.traceJournal.append(trace, span, bytes)) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return false;
    }
    if (trace.phase === "completed" && wasEmpty) state.completedTracesWithStaging++;
    state.stagedTraceRecords++;
    state.stagedTraceBytes += bytes;
    return true;
  }

  private drainSpans(
    trace: MutableTraceRetention,
    retainedAtMs?: number,
    collect?: TelemetrySpanRecord[],
    toExport = true,
  ): number {
    const state = this.state;
    if (trace.phase === "completed" && trace.stagedRecords > 0) {
      state.completedTracesWithStaging--;
    }
    const released = state.traceJournal.drain(
      trace,
      retainedAtMs === undefined
        ? undefined
        // One materialization, two consumers. Materializing twice would double
        // the allocation the staging bounds exist to keep finite.
        : (span) => {
          const record = materializeSpan(span);
          collect?.push(record);
          if (toExport) this.retainSpan(record, retainedAtMs);
        },
    );
    state.stagedTraceRecords -= released.records;
    state.stagedTraceBytes -= released.bytes;
    return released.records;
  }

  /**
   * The trace is finished with. One drain: a retained trace's spans go to the
   * export pipeline and, together, become its exemplar row; an unretained
   * trace's spans are freed and counted. This is the only place either happens.
   */
  private settle(trace: MutableTraceRetention, settledAtMs: number): void {
    const emit = this.sinks.exemplar;
    const verdict = trace.verdict;
    const traceId = verdict === undefined ? undefined : this.traceIdOf(trace);
    const carried = trace.exemplarSpans;
    // Anything still staged is drained now: into the export pipeline if the
    // trace is retained, into the exemplar's list if one is being built, and
    // materialized ONCE either way.
    const drained = this.drainSpans(
      trace,
      trace.retained || carried !== undefined ? settledAtMs : undefined,
      carried,
      trace.retained,
    );
    trace.exemplarSpans = undefined;

    if (emit !== undefined && verdict !== undefined && traceId !== undefined) {
      emit({
        traceId,
        startedAtMs: trace.startedAtMs,
        endedAtMs: trace.endedAtMs,
        errorSpans: trace.errorSpans,
        observedSpans: trace.observedSpans,
        omittedSpans: trace.omittedSpans,
        verdict,
        spans: carried ?? [],
      });
    }
    if (trace.retained) return;
    this.state.traceHealth.discardedTraces = boundedCount(
      this.state.traceHealth.discardedTraces,
    );
    this.state.traceHealth.discardedRecords = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.state.traceHealth.discardedRecords + drained,
    );
  }

  private append(list: MutableTraceList, trace: MutableTraceRetention): void {
    trace.previous = list.tail;
    trace.next = undefined;
    if (list.tail === undefined) list.head = trace;
    else list.tail.next = trace;
    list.tail = trace;
    list.size++;
  }

  private unlink(list: MutableTraceList, trace: MutableTraceRetention): void {
    const { previous, next } = trace;
    if (previous === undefined) list.head = next;
    else previous.next = next;
    if (next === undefined) list.tail = previous;
    else next.previous = previous;
    trace.previous = undefined;
    trace.next = undefined;
    list.size--;
  }

  private remove(trace: MutableTraceRetention): void {
    const state = this.state;
    if (trace.owner !== state || trace.phase === "settled") return;
    if (trace.phase === "completed" && trace.stagedRecords > 0) {
      state.completedTracesWithStaging--;
    }
    this.unlink(trace.phase === "active" ? state.activeTraces : state.completedTraces, trace);
    trace.phase = "settled";
    AuthenticTelemetryTraceContext.release(trace);
    if (trace.operationTrace?.retention === trace) trace.operationTrace.retention = undefined;
    if (
      trace.rootContext === undefined &&
      trace.traceId !== undefined &&
      state.publicTraceIndex.get(trace.traceId) === trace
    ) {
      state.publicTraceIndex.delete(trace.traceId);
      state.publicTraceDeletions++;
      if (state.publicTraceDeletions >= state.limits.maxRecords) {
        state.publicTraceIndex = new Map();
        state.publicTraceDeletions = 0;
      }
    }
    trace.rootContext = undefined;
    trace.operationTrace = undefined;
    trace.owner = undefined;
  }

  private evictOldestCompleted(
    excludedTrace?: MutableTraceRetention,
    requireStaged = false,
  ): boolean {
    const state = this.state;
    if (
      requireStaged &&
      state.completedTracesWithStaging <=
        (excludedTrace?.phase === "completed" && excludedTrace.stagedRecords > 0 ? 1 : 0)
    ) return false;
    for (let trace = state.completedTraces.head; trace !== undefined; trace = trace.next) {
      if (trace === excludedTrace || (requireStaged && trace.stagedRecords === 0)) continue;
      this.removeCompleted(trace, "decisionOverflow");
      return true;
    }
    return false;
  }

  private removeCompleted(
    trace: MutableTraceRetention,
    reason: "decisionOverflow" | "expiredDecisions",
  ): void {
    if (trace.owner !== this.state || trace.phase !== "completed") return;
    this.remove(trace);
    this.state.traceHealth.dropped[reason] = boundedCount(this.state.traceHealth.dropped[reason]);
    this.settle(trace, trace.endedAtMs);
  }

  private settleDelivered(trace: MutableTraceRetention): void {
    if (trace.owner !== this.state || trace.phase !== "completed") return;
    this.remove(trace);
    this.settle(trace, trace.endedAtMs);
  }
}
