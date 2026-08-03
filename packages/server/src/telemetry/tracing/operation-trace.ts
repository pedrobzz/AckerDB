import type { PreparedTelemetryTraceContext, TelemetryEventInput, TelemetryRecordContext, TelemetrySpanInput } from "../contracts/types.ts";
import type { TelemetryOperation, TelemetryOutcome } from "../contracts/schema.ts";
import type { MutableTraceRetention } from "../state/types.ts";
import { NO_SLOT, UUID_LENGTH } from "../state/constants.ts";
import { safeId, safeName } from "../records/sanitize.ts";
import { AuthenticTelemetryTraceContext } from "./context.ts";

const OPERATION_TRACE_HANDLE: unique symbol = Symbol("ackerdb.operationTraceHandle");

/** Package-internal ownership handle for one Runtime operation. */
export interface OperationTraceHandle {
  readonly [OPERATION_TRACE_HANDLE]: true;
}

export interface OperationTraceInput {
  readonly operation: TelemetryOperation;
  readonly functionName?: string;
  readonly requestId?: string;
  readonly connectionId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
  readonly subscriptionId?: string;
  readonly inheritedContext?: PreparedTelemetryTraceContext;
}

export interface OperationTelemetrySpanInput extends Omit<
  TelemetrySpanInput,
  "timestampMs" | "context" | "links"
> {
  readonly requestId?: string;
  readonly connectionId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
  readonly subscriptionId?: string;
}

export const OPEN_OPERATION_TRACE = Symbol("ackerdb.openOperationTrace");
export const IDENTIFY_OPERATION_TRACE = Symbol("ackerdb.identifyOperationTrace");
export const FINISH_OPERATION_TRACE = Symbol("ackerdb.finishOperationTrace");
export const OPERATION_INVOCATION_NODE = Symbol("ackerdb.operationInvocationNode");
export const OPERATION_TRACE_CONTEXT = Symbol("ackerdb.operationTraceContext");
export const RECORD_OPERATION_SPAN = Symbol("ackerdb.recordOperationSpan");
export const RECORD_OPERATION_EVENT = Symbol("ackerdb.recordOperationEvent");
export const CLAIM_OPERATION_DELIVERY_LEASE = Symbol("ackerdb.claimOperationDeliveryLease");

const INVOCATION_PHASE_CODES = Object.freeze({ auth: 0, policy: 1, handler: 2 } as const);

export class OperationTrace implements OperationTraceHandle {
  readonly [OPERATION_TRACE_HANDLE] = true;
  readonly operation: TelemetryOperation;
  rootFunction?: string;
  requestId?: string;
  readonly connectionId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
  readonly subscriptionId?: string;
  readonly inheritedContext?: AuthenticTelemetryTraceContext;
  readonly startedAtMs?: number;
  readonly sampled: boolean;
  retention?: MutableTraceRetention;
  outcome: TelemetryOutcome = "ok";
  private traceId?: string;
  private nodeParents?: number[];
  private nodeIds?: string[];
  private invocationNodes?: Map<number, number>;
  private nextNode = 1;

  constructor(input: OperationTraceInput, startedAtMs?: number, sampled = false) {
    this.operation = input.operation;
    this.rootFunction = safeName(input.functionName);
    this.requestId = safeId(input.requestId ?? input.inheritedContext?.requestId);
    this.connectionId = safeId(input.connectionId ?? input.inheritedContext?.connectionId);
    this.mutationId = safeId(input.mutationId ?? input.inheritedContext?.mutationId);
    this.commitId = safeId(input.commitId ?? input.inheritedContext?.commitId);
    this.subscriptionId = safeId(
      input.subscriptionId ?? input.inheritedContext?.subscriptionId,
    );
    this.inheritedContext = AuthenticTelemetryTraceContext.owns(input.inheritedContext)
      ? input.inheritedContext
      : undefined;
    this.startedAtMs = startedAtMs;
    this.sampled = sampled;
  }

  identify(functionName: string, requestId: string): void {
    this.rootFunction = safeName(functionName) ?? this.rootFunction;
    this.requestId = safeId(requestId) ?? this.requestId;
  }

  observeOutcome(outcome: TelemetryOutcome): void {
    if (outcome !== "ok") this.outcome = outcome;
  }

  childNode(parent: number): number {
    const node = this.nextNode++;
    (this.nodeParents ??= [NO_SLOT])[node] = parent;
    return node;
  }

  invocationNode(
    invocationId: number,
    phase: "auth" | "policy" | "handler",
    parent: number,
  ): number {
    if (!this.sampled) return 0;
    const key = invocationId * 4 + INVOCATION_PHASE_CODES[phase];
    const existing = this.invocationNodes?.get(key);
    if (existing !== undefined) return existing;
    const node = this.childNode(parent);
    (this.invocationNodes ??= new Map()).set(key, node);
    return node;
  }

  context(
    node: number,
    requestId?: string,
    connectionId?: string,
    mutationId?: string,
    commitId?: string,
    subscriptionId?: string,
  ): OperationTraceContext {
    return new OperationTraceContext(
      this,
      node,
      requestId ?? this.requestId,
      connectionId ?? this.connectionId,
      mutationId ?? this.mutationId,
      commitId ?? this.commitId,
      subscriptionId ?? this.subscriptionId,
    );
  }

  traceIdLength(): number {
    return this.traceId?.length ?? this.inheritedContext?.traceId.length ?? UUID_LENGTH;
  }

  spanIdLength(node: number): number {
    const existing = this.nodeIds?.[node];
    if (existing !== undefined) return existing.length;
    if (node === 0 && this.inheritedContext !== undefined) {
      return AuthenticTelemetryTraceContext.idLength(this.inheritedContext, "spanId")!;
    }
    return UUID_LENGTH;
  }

  parentSpanIdLength(node: number): number | undefined {
    const parent = node === 0 ? NO_SLOT : this.nodeParents?.[node] ?? NO_SLOT;
    if (parent !== NO_SLOT) return this.spanIdLength(parent);
    return this.inheritedContext === undefined
      ? undefined
      : AuthenticTelemetryTraceContext.idLength(this.inheritedContext, "parentSpanId");
  }

  materializeTraceId(): string {
    return this.traceId ??= this.inheritedContext?.traceId ?? crypto.randomUUID();
  }

  materializeNodeId(node: number): string {
    const ids = this.nodeIds ??= [];
    return ids[node] ??= node === 0 && this.inheritedContext !== undefined
      ? this.inheritedContext.spanId
      : crypto.randomUUID();
  }

  materializeParentNodeId(node: number): string | undefined {
    const parent = node === 0 ? NO_SLOT : this.nodeParents?.[node] ?? NO_SLOT;
    return parent === NO_SLOT
      ? this.inheritedContext?.parentSpanId
      : this.materializeNodeId(parent);
  }
}

export class OperationTraceContext implements TelemetryRecordContext {
  constructor(
    readonly trace: OperationTrace,
    readonly node: number,
    readonly requestId?: string,
    readonly connectionId?: string,
    readonly mutationId?: string,
    readonly commitId?: string,
    readonly subscriptionId?: string,
  ) {}

  get traceId(): string {
    return this.trace.materializeTraceId();
  }

  get spanId(): string {
    return this.trace.materializeNodeId(this.node);
  }

  get parentSpanId(): string | undefined {
    return this.trace.materializeParentNodeId(this.node);
  }
}
