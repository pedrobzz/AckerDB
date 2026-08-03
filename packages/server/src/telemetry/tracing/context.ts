import type { PREPARED_TRACE_CONTEXT, PreparedTelemetryTraceContext, TelemetryRecordContext } from "../contracts/types.ts";
import type { MutableTraceRetention } from "../state/types.ts";
import { UUID_LENGTH } from "../state/constants.ts";

interface MutableTelemetryId {
  value?: string;
}

export class AuthenticTelemetryTraceContext implements PreparedTelemetryTraceContext {
  readonly #authentic = true;
  /** Shared owner lets every frozen child resolve retention without a global identity table. */
  readonly #root: AuthenticTelemetryTraceContext;
  /** Generated span ids stay virtual until a retained record actually needs them. */
  readonly #span: MutableTelemetryId;
  readonly #parentSpan?: MutableTelemetryId;
  readonly #explicitParentSpanId?: string;
  #retention?: MutableTraceRetention;
  declare readonly [PREPARED_TRACE_CONTEXT]: true;
  declare readonly traceId: string;
  declare readonly requestId?: string;
  declare readonly connectionId?: string;
  declare readonly mutationId?: string;
  declare readonly commitId?: string;
  declare readonly subscriptionId?: string;

  constructor(
    context: TelemetryRecordContext,
    owner?: AuthenticTelemetryTraceContext,
    span?: MutableTelemetryId,
    parentSpan?: MutableTelemetryId,
  ) {
    this.#root = owner === undefined ? this : owner.#root;
    this.#span = span ?? { value: context.spanId };
    this.#parentSpan = parentSpan;
    this.#explicitParentSpanId = context.parentSpanId;
    this.traceId = context.traceId!;
    this.requestId = context.requestId;
    this.connectionId = context.connectionId;
    this.mutationId = context.mutationId;
    this.commitId = context.commitId;
    this.subscriptionId = context.subscriptionId;
    Object.freeze(this);
  }

  get spanId(): string {
    return this.#span.value ??= crypto.randomUUID();
  }

  get parentSpanId(): string | undefined {
    if (this.#parentSpan !== undefined) {
      return this.#parentSpan.value ??= crypto.randomUUID();
    }
    return this.#explicitParentSpanId;
  }

  static owns(value: unknown): value is AuthenticTelemetryTraceContext {
    return typeof value === "object" && value !== null && #authentic in value;
  }

  static root(context: AuthenticTelemetryTraceContext): AuthenticTelemetryTraceContext {
    return context.#root;
  }

  static derive(
    parent: AuthenticTelemetryTraceContext,
    context: TelemetryRecordContext,
  ): AuthenticTelemetryTraceContext {
    return new AuthenticTelemetryTraceContext(context, parent, undefined, parent.#span);
  }

  static identify(
    context: AuthenticTelemetryTraceContext,
    requestId: string | undefined,
  ): AuthenticTelemetryTraceContext {
    return new AuthenticTelemetryTraceContext({
      traceId: context.traceId,
      parentSpanId: context.#explicitParentSpanId,
      requestId,
      connectionId: context.connectionId,
      mutationId: context.mutationId,
      commitId: context.commitId,
      subscriptionId: context.subscriptionId,
    }, context, context.#span, context.#parentSpan);
  }

  static idLength(
    context: AuthenticTelemetryTraceContext,
    id: "spanId" | "parentSpanId",
  ): number | undefined {
    if (id === "spanId") return context.#span.value?.length ?? UUID_LENGTH;
    if (context.#parentSpan !== undefined) {
      return context.#parentSpan.value?.length ?? UUID_LENGTH;
    }
    return context.#explicitParentSpanId?.length;
  }

  static retention(context: AuthenticTelemetryTraceContext): MutableTraceRetention | undefined {
    return context.#root.#retention;
  }

  static bind(
    context: AuthenticTelemetryTraceContext,
    trace: MutableTraceRetention,
  ): boolean {
    const root = context.#root;
    if (root.#retention !== undefined) return false;
    root.#retention = trace;
    return true;
  }

  static release(trace: MutableTraceRetention): void {
    const root = trace.rootContext;
    if (root !== undefined && root.#retention === trace) root.#retention = undefined;
  }
}
