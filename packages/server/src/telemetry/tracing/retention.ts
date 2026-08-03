import type { TelemetryRecordContext, TelemetrySpanRecord } from "../contracts/types.ts";
import { materializeSpan, stagedSpanBytes } from "../records/codec.ts";
import { boundedCount, safeId } from "../records/sanitize.ts";
import type { SanitizedTelemetrySpan } from "../records/types.ts";
import { NO_SLOT } from "../state/constants.ts";
import type {
  MutableTraceList,
  MutableTraceRetention,
  TelemetryState,
} from "../state/types.ts";
import { AuthenticTelemetryTraceContext } from "./context.ts";
import type { OperationTrace } from "./operation-trace.ts";

type RetainSpan = (record: TelemetrySpanRecord, retainedAtMs: number) => void;

/** Owns bounded trace decisions, staged tails, promotion, and delayed-delivery leases. */
export class TraceRetention {
  constructor(
    private readonly state: TelemetryState,
    private readonly retainSpan: RetainSpan,
  ) {}

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

  complete(trace: MutableTraceRetention, completedAtMs: number): void {
    const state = this.state;
    if (
      !trace.retained &&
      completedAtMs - trace.startedAtMs >= state.limits.slowOperationMs
    ) {
      this.promote(trace, completedAtMs);
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

  stageSpan(trace: MutableTraceRetention, span: SanitizedTelemetrySpan): void {
    // One trace may stage at most one export batch; an active high-fanout
    // trace must not accumulate the whole queue and evict every other record.
    if (!this.canStageSpan(trace)) return;
    this.stageJournalSpan(trace, span, stagedSpanBytes(span));
  }

  promote(trace: MutableTraceRetention, retainedAtMs: number): void {
    if (trace.retained) return;
    trace.retained = true;
    this.state.traceHealth.promotedTraces = boundedCount(
      this.state.traceHealth.promotedTraces,
    );
    this.drainSpans(trace, retainedAtMs);
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
    this.discard(trace);
  }

  discardAll(): void {
    const state = this.state;
    const traces = state.activeTraces.size + state.completedTraces.size;
    for (let trace = state.activeTraces.head; trace !== undefined;) {
      const next = trace.next;
      this.remove(trace);
      this.discard(trace);
      trace = next;
    }
    for (let trace = state.completedTraces.head; trace !== undefined;) {
      const next = trace.next;
      this.remove(trace);
      this.discard(trace);
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
  ): void {
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
      return;
    }
    const wasEmpty = trace.stagedRecords === 0;
    if (!state.traceJournal.append(trace, span, bytes)) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return;
    }
    if (trace.phase === "completed" && wasEmpty) state.completedTracesWithStaging++;
    state.stagedTraceRecords++;
    state.stagedTraceBytes += bytes;
  }

  private drainSpans(trace: MutableTraceRetention, retainedAtMs?: number): number {
    const state = this.state;
    if (trace.phase === "completed" && trace.stagedRecords > 0) {
      state.completedTracesWithStaging--;
    }
    const released = state.traceJournal.drain(
      trace,
      retainedAtMs === undefined
        ? undefined
        : (span) => this.retainSpan(materializeSpan(span), retainedAtMs),
    );
    state.stagedTraceRecords -= released.records;
    state.stagedTraceBytes -= released.bytes;
    return released.records;
  }

  private discard(trace: MutableTraceRetention): void {
    const discardedRecords = this.drainSpans(trace);
    if (trace.retained) return;
    this.state.traceHealth.discardedTraces = boundedCount(
      this.state.traceHealth.discardedTraces,
    );
    this.state.traceHealth.discardedRecords = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.state.traceHealth.discardedRecords + discardedRecords,
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
    this.discard(trace);
  }

  private settleDelivered(trace: MutableTraceRetention): void {
    if (trace.owner !== this.state || trace.phase !== "completed") return;
    this.remove(trace);
    this.discard(trace);
  }
}
