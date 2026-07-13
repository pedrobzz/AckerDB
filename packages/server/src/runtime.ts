import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  stableEncode,
  type ErrorMessage,
  type EventMessage,
  type LiveEvent,
  type MutationMessage,
  type MutationOkMessage,
  type Outcome,
  type ProcedureOkMessage,
  type QueryMessage,
  type QueryOkMessage,
  type ResetRequestMessage,
  type SubscribeMessage,
  type SubscriptionTransition,
  type TransitionMessage,
  type UnsubscribeMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  type Principal,
} from "./auth.ts";
import {
  CommitCoordinator,
  withFetchObserver,
  type CommitResult,
  type CommitTelemetryEvent,
  type FetchObservation,
} from "./coordinator.ts";
import { ValidationError } from "./dbz.ts";
import {
  makeDbReader,
  type DbStatementObservation,
  type DbStatementObserver,
  type ReadRecorder,
  type WriteCollector,
} from "./db.ts";
import {
  BoundedSseProducer,
  OutboundBudget,
  type DeliveryObservation,
  type DeliveryObserver,
  type OutboundLane,
  type OutboundReservation,
} from "./delivery.ts";
import type { Engine } from "./engine.ts";
import { DbzzError, isDbzzError } from "./errors.ts";
import {
  carriedHttpTrace,
  claimHttpTrace,
  finishClaimedHttpTrace,
  type ClaimedHttpTrace,
} from "./external-trace.ts";
import {
  BoundedExecutor,
  type ExecutorSnapshot,
  type ExecutorTaskOptions,
} from "./executor.ts";
import type {
  AnyRegistered,
  ProcedureCtx,
  SseCtx,
  StreamWriter,
  TxCtx,
} from "./functions.ts";
import {
  authorizeInvocation,
  invokeFunction,
  withInvocationObserver,
  type InvocationObservation,
  type InvocationPhaseRunner,
  type InvocationPhaseScope,
} from "./invocation.ts";
import { emitWriteKeys } from "./keys.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import { outcomeFromError, outcomeHttpStatus } from "./outcome.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type QueryEvaluationInput,
  type ReactiveObservation,
  type ReactiveObserver,
  type Subscriber,
} from "./reactive.ts";
import type { Registry } from "./registry.ts";
import {
  Telemetry,
  type TelemetryOperation,
  type TelemetryOptions,
  type TelemetryOutcome,
  type TelemetryResource,
  type TelemetrySnapshot,
  type TelemetrySpanInput,
  type TelemetryStage,
  type TelemetryTraceContext,
} from "./telemetry.ts";
import type {
  RuntimeAuthTransition,
  RuntimeMutationResult,
  RuntimePort,
  RuntimePublication,
  RuntimePublicationBatch,
  SessionRuntimeContext,
} from "./session.ts";

const utf8 = new TextEncoder();
const SCHEDULER_RETRY_MS = 1_000;
const STALE_SCHEDULED_CANDIDATE = Symbol("staleScheduledCandidate");

export type RuntimeLifecycleState = "ready" | "draining" | "stopped" | "failed";

const DRAIN_RETRY_AFTER_MS = 1_000;

export interface RuntimeOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits?: ServiceLimits;
  readonly telemetry?: Telemetry | TelemetryOptions | false;
  readonly now?: () => number;
}

interface RuntimeExternalRequest {
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly principal: Principal;
  readonly signal?: AbortSignal;
  readonly fairnessKey?: string;
}

export interface RuntimeProcedureResponse {
  readonly body: string;
  readonly bytes: number;
  readonly status: number;
}

/** Constructs the HTTP response; return is the measured application handoff, not network delivery. */
export type RuntimeProcedureResponder = (response: RuntimeProcedureResponse) => Response;

export interface RuntimeProcedureRequest extends RuntimeExternalRequest {
  readonly respond: RuntimeProcedureResponder;
}

export interface RuntimeSseRequest extends RuntimeExternalRequest {}

export interface RuntimeStatus {
  readonly state: RuntimeLifecycleState;
  readonly connections: number;
  readonly activeOperations: number;
  readonly activeOperationCallers: number;
  readonly activeSse: number;
  readonly scheduledHandlers: number;
  readonly schedulerArmed: boolean;
  readonly reader: ExecutorSnapshot;
  readonly writer: ExecutorSnapshot;
  readonly reactive: ReturnType<OrderedReactive<ReactiveContext>["snapshot"]>;
  readonly publication: ReturnType<OrderedReactive<ReactiveContext>["publication"]["snapshot"]>;
  readonly authCaptureBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly sseBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly telemetry: TelemetrySnapshot;
  readonly storage: ReturnType<Engine["status"]>;
}

interface ReactiveContext {
  readonly principal: Principal;
  readonly fairnessKey: string;
}

interface RuntimeSubscription {
  readonly address: string;
  readonly args: unknown;
  readonly cursor?: SubscribeMessage["cursor"];
}

interface AuthTransitionCapture {
  phase: "revoking" | "reattaching";
  authEpoch: number;
  readonly frames: RuntimePublication[];
  readonly reservations: OutboundReservation[];
  bytes: number;
  active: boolean;
}

interface RuntimeSession {
  context: SessionRuntimeContext;
  subscriber: Subscriber;
  readonly subscriptions: Map<number, RuntimeSubscription>;
  capture: AuthTransitionCapture | null;
  activeOperations: number;
}

interface ScheduledCandidate {
  readonly table: string;
  readonly address: string;
  readonly primaryKey: unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

type TraceIdentifiers = Partial<Pick<
  TelemetryTraceContext,
  "requestId" | "connectionId" | "mutationId" | "commitId" | "subscriptionId"
>>;

type RuntimeOperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type RuntimeOperationFinalizer<T, R> = (outcome: RuntimeOperationOutcome<T>) => R | Promise<R>;

interface SessionOperationOptions<T> {
  readonly identifiers?: TraceIdentifiers;
  readonly synthesizeHandler?: boolean;
  readonly successFrame?: (value: T) => RuntimePublication;
}

interface InvocationTraceNode {
  readonly parent: TelemetryTraceContext;
  readonly handler: TelemetryTraceContext;
}

interface RuntimeTraceScope {
  readonly operation: TelemetryOperation;
  readonly rootFunction?: string;
  readonly rootContext: TelemetryTraceContext;
  readonly currentContext: TelemetryTraceContext;
  readonly currentFunction?: string;
  readonly invocations: Map<number, InvocationTraceNode>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function byteLength(value: unknown): number {
  return utf8.encode(encode(value)).byteLength;
}

function snapshotValue(value: unknown): unknown {
  return decode(encode(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("base64url");
}

function externalCallerKey(principal: Principal): string {
  return principal.kind === "user" || principal.kind === "workload"
    ? digest([principal.kind, principal.issuer, principal.subject])
    : digest([principal.kind]);
}

function convergenceError(message: string): DbzzError {
  return new DbzzError("convergence_unavailable", message, { committed: true });
}

function transportError(error: unknown): unknown {
  return error instanceof ValidationError
    ? new DbzzError("validation", error.message, { cause: error })
    : error;
}

function aborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw isDbzzError(signal.reason)
    ? signal.reason
    : new DbzzError("unavailable", "operation was canceled", {
        resource: "operation",
        cause: signal.reason,
      });
}

function telemetryContext(
  identifiers: TraceIdentifiers & { readonly connectionId?: string } = {},
): TelemetryTraceContext {
  return Object.freeze({
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    ...identifiers,
  });
}

function childTelemetryContext(
  parent: TelemetryTraceContext,
  identifiers: TraceIdentifiers = {},
): TelemetryTraceContext {
  return Object.freeze({
    traceId: parent.traceId,
    spanId: crypto.randomUUID(),
    parentSpanId: parent.spanId,
    ...(parent.requestId === undefined ? {} : { requestId: parent.requestId }),
    ...(parent.connectionId === undefined ? {} : { connectionId: parent.connectionId }),
    ...(parent.mutationId === undefined ? {} : { mutationId: parent.mutationId }),
    ...(parent.commitId === undefined ? {} : { commitId: parent.commitId }),
    ...(parent.subscriptionId === undefined ? {} : { subscriptionId: parent.subscriptionId }),
    ...identifiers,
  });
}

function observationOutcome(
  outcome: ReactiveObservation["outcome"],
): TelemetryOutcome {
  return outcome === "changed" || outcome === "unchanged" ||
      outcome === "matched" || outcome === "unmatched"
    ? "ok"
    : outcome;
}

/**
 * Owns bounded execution, the only commit coordinator, ordered convergence,
 * authenticated session state, scheduling, SSE production, and runtime drain.
 * Engine lifetime remains with the caller so storage closes exactly once.
 */
export class Runtime implements RuntimePort {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits: ServiceLimits;
  readonly telemetry: Telemetry;
  readonly reactive: OrderedReactive<ReactiveContext>;
  readonly deliveryObserver: DeliveryObserver = (observation): void => {
    const outcome: TelemetryOutcome = observation.outcome === "dropped"
      ? "unavailable"
      : observation.outcome;
    const fallbackOperation: TelemetryOperation = observation.transport === "sse"
      ? "sse"
      : "subscription";
    if (observation.droppedObservations !== undefined) {
      this.telemetry.recordMetric({
        name: "delivery.observations_dropped",
        value: observation.droppedObservations,
        unit: "count",
        labels: {
          operation: fallbackOperation,
          resource: observation.transport === "sse" ? "sse" : "outbound",
        },
      });
    }
    this.traceSpan({
      stage: observation.stage,
      outcome,
      resource: observation.transport === "sse" ? "sse" : "outbound",
      durationMs: observation.durationMs,
      sizeBytes: observation.bytes,
    }, fallbackOperation);
    if (
      observation.source === "terminal" &&
      observation.stage === "encoding" &&
      observation.terminalOutcome !== undefined
    ) {
      const scope = this.trace.getStore();
      this.telemetry.recordEvent({
        name: "failure",
        level: "error",
        operation: scope?.operation ?? fallbackOperation,
        stage: "delivery",
        outcome: observation.terminalOutcome,
        resource: observation.transport === "sse" ? "sse" : "outbound",
        context: this.observationContext(),
      });
    }
  };

  private readonly now: () => number;
  private readonly reader: BoundedExecutor;
  private readonly availableReaders: Database[];
  private readonly coordinator: CommitCoordinator<ReactiveCommit>;
  private readonly scheduled: Map<string, string>;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly authCaptureBudget: OutboundBudget;
  private readonly sseBudget: OutboundBudget;
  private readonly sseProducers = new Set<BoundedSseProducer>();
  private readonly externalOperations = new Map<string, number>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly trace = new AsyncLocalStorage<RuntimeTraceScope>();
  private readonly ownsTelemetry: boolean;
  private lifecycle: RuntimeLifecycleState = "ready";
  private activeOperations = 0;
  private schedulerGeneration = 0;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledRun: Promise<number> | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();
  private expectedSampleAt = performance.now();

  constructor(options: RuntimeOptions) {
    this.engine = options.engine;
    this.registry = options.registry;
    this.limits = options.limits === undefined ? PRODUCTION_LIMITS : defineServiceLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.scheduled = options.registry.resolveScheduled(options.engine.schema);
    this.ownsTelemetry = !(options.telemetry instanceof Telemetry);
    this.telemetry = options.telemetry instanceof Telemetry
      ? options.telemetry
      : new Telemetry(options.telemetry === false
        ? { enabled: false }
        : {
            ...options.telemetry,
            limits: {
              ...this.limits.telemetry,
              ...options.telemetry?.limits,
            },
          });
    this.availableReaders = [this.engine.reader];
    this.reader = new BoundedExecutor({
      concurrency: this.limits.revalidationConcurrency,
      discipline: "round-robin",
      limits: this.limits.readQueue,
      resource: "reader",
      retryAfterMs: 0,
      now: this.now,
    });
    this.reactive = new OrderedReactive<ReactiveContext>({
      limits: this.limits,
      initialVersion: this.engine.commitVersion(),
      now: this.now,
      evaluate: (input) => this.evaluateSubscription(input),
      ...(this.telemetry.enabled ? { observer: this.observeReactive } : {}),
    });
    this.coordinator = new CommitCoordinator({
      engine: this.engine,
      limits: this.limits,
      reservePublication: (bytes) => this.reactive.publication.reserve(bytes),
      now: this.now,
    });
    const globalControlReserve = Math.min(
      this.limits.maxFrameBytes,
      this.limits.sse.maxBytes - 1,
    );
    this.sseBudget = new OutboundBudget(this.limits.sse.maxBytes, globalControlReserve);
    const authCaptureControlReserve = Math.min(
      this.limits.maxFrameBytes,
      this.limits.webSocket.maxBytes - 1,
    );
    this.authCaptureBudget = new OutboundBudget(
      this.limits.webSocket.maxBytes,
      authCaptureControlReserve,
    );
    this.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "ready",
    });
    this.startSampler();
    this.armScheduler();
  }

  get state(): RuntimeLifecycleState {
    return this.lifecycle;
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  kindOf(address: string): string | null {
    if (address.startsWith("events.")) return "event";
    return this.registry.kindOf(address) ?? null;
  }

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.assertReady();
    if (context.authEpoch !== 0) throw new DbzzError("validation", "new sessions must start at auth epoch 0");
    if (context.principal.kind === "system") throw new DbzzError("unauthorized", "system identity is local only");
    if (this.sessions.has(context.clientSessionId)) {
      throw new DbzzError("conflict", "client session is already connected", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }
    if (this.sessions.size >= this.limits.maxConnections) {
      throw new DbzzError("overloaded", "connection capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }

    let state!: RuntimeSession;
    const subscriber = this.makeSubscriber(() => state, context.authEpoch);
    state = {
      context,
      subscriber,
      subscriptions: new Map(),
      capture: null,
      activeOperations: 0,
    };
    this.sessions.set(context.clientSessionId, state);
    this.telemetry.recordMetric({ name: "runtime.connections", value: this.sessions.size, unit: "gauge" });
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch> {
    const state = this.currentSession(transition.from, true);
    return this.runOperation(state, "subscription", undefined, 1, async () => {
      if (
        transition.to.clientSessionId !== transition.from.clientSessionId ||
        transition.to.authEpoch !== transition.from.authEpoch + 1
      ) {
        throw new DbzzError("validation", "authentication transition is not monotonic");
      }
      aborted(transition.to.signal);
      const captured: AuthTransitionCapture = {
        phase: "revoking",
        authEpoch: transition.from.authEpoch,
        frames: [],
        reservations: [],
        bytes: 0,
        active: true,
      };
      state.capture = captured;
      try {
        const rotation = await this.reactive.rotateAuth(state.subscriber, transition.to.authEpoch);
        if (rotation.deliveryFailures.length > 0) {
          throw new DbzzError("unavailable", "subscription revocation could not be delivered", {
            resource: "subscription",
            cause: rotation.deliveryFailures[0]?.error,
          });
        }
        if (
          state.capture !== captured ||
          this.sessions.get(transition.from.clientSessionId) !== state
        ) {
          throw new DbzzError("auth_stale", "authentication state changed");
        }
        state.context = transition.to;
        state.subscriber = this.makeSubscriber(() => state, transition.to.authEpoch);
        captured.phase = "reattaching";
        captured.authEpoch = transition.to.authEpoch;
        for (const [id, definition] of [...state.subscriptions].sort(([left], [right]) => left - right)) {
          try {
            await this.attachSubscription(state, id, definition, false);
          } catch (error) {
            state.subscriptions.delete(id);
            this.captureFrame(captured, {
              v: PROTOCOL_VERSION,
              t: "err",
              id,
              outcome: outcomeFromError(transportError(error)),
            });
          }
        }
        return this.finishCapture(captured);
      } catch (error) {
        // Auth transitions are terminal when their captured protocol cannot be
        // completed. Remove both old and partially reattached ownership now;
        // Session still holds the old epoch and cannot close the new one.
        this.removeSession(state);
        throw error;
      } finally {
        if (state.capture === captured) state.capture = null;
        this.releaseCapture(captured);
      }
    });
  }

  async subscribe(context: SessionRuntimeContext, message: SubscribeMessage): Promise<void> {
    await this.runSessionOperation(context, message, "subscription", message.ref, async (state) => {
      const definition: RuntimeSubscription = Object.freeze({
        address: message.ref,
        args: snapshotValue(message.args),
        ...(message.cursor === undefined ? {} : { cursor: Object.freeze({ ...message.cursor }) }),
      });
      await this.attachSubscription(state, message.id, definition, true);
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async unsubscribe(context: SessionRuntimeContext, message: UnsubscribeMessage): Promise<void> {
    await this.runSessionOperation(context, message, "subscription", undefined, (state) => {
      this.reactive.unsubscribe(state.subscriber, message.id);
      state.subscriptions.delete(message.id);
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async reset(context: SessionRuntimeContext, message: ResetRequestMessage): Promise<void> {
    await this.runSessionOperation(context, message, "subscription", undefined, (state) =>
      this.reactive.reset(state.subscriber, message.id, message.cursor), {
        identifiers: {
          requestId: String(message.id),
          subscriptionId: String(message.id),
        },
      });
  }

  async query(context: SessionRuntimeContext, message: QueryMessage): Promise<unknown> {
    return this.runSessionOperation(context, message, "query", message.ref, async (_state, requestBytes) => {
      const signal = this.operationSignal(context.signal);
      const evaluation = await this.executeQuery(
        "query",
        message.ref,
        message.args,
        context.principal,
        context.clientSessionId,
        signal,
        requestBytes,
      );
      this.assertFrameFits({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: message.id,
        kind: "query",
        value: evaluation.value,
      } satisfies QueryOkMessage, "query result");
      return evaluation.value;
    }, {
      identifiers: { requestId: String(message.id) },
      successFrame: (value) => ({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: message.id,
        kind: "query",
        value,
      } satisfies QueryOkMessage),
    });
  }

  async mutation(context: SessionRuntimeContext, message: MutationMessage): Promise<RuntimeMutationResult> {
    return this.runSessionOperation(context, message, "mutation", message.ref, async (state, requestBytes) => {
      const fn = this.expect(message.ref, "mutation");
      const signal = this.operationSignal(context.signal);
      let scheduledTouched = false;
      const result = await this.coordinator.execute({
        operation: "mutation",
        fairnessKey: context.clientSessionId,
        requestBytes,
        signal,
        ...(this.telemetry.enabled
          ? { telemetry: this.observeCommit, statementTelemetry: this.observeStatement }
          : {}),
        idempotency: {
          sessionId: context.clientSessionId,
          requestId: message.mutationRequestId,
          issuedAt: message.issuedAt,
          principalFingerprint: digest(context.principal),
          functionRef: message.ref,
          argsFingerprint: digest(message.args),
        },
        work: (db) => invokeFunction(fn, Object.freeze({ db, auth: context.principal }), message.args),
        publication: (_version, writes) => {
          scheduledTouched = writes.scheduledTouched;
          return this.publicationFor(writes, state.subscriber);
        },
        validate: (value, version, writes) => {
          const obligations = this.reactive.affectedQueryIds(state.subscriber, writes.keys);
          this.assertFrameFits(
            this.mutationFrame(
              message,
              value,
              version,
              this.engine.durability,
              "executed",
              obligations,
            ),
            "mutation result",
          );
        },
      });
      if (scheduledTouched) this.armScheduler();
      return this.finishMutation(state, message, result);
    }, {
      identifiers: {
        requestId: String(message.id),
        mutationId: message.mutationRequestId,
      },
      synthesizeHandler: false,
      successFrame: (result) => ({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: message.id,
        kind: "mutation",
        value: result.value,
        receipt: result.receipt,
      } satisfies MutationOkMessage),
    });
  }

  async closeSession(context: SessionRuntimeContext, _outcome: Outcome): Promise<void> {
    const state = this.matchingSession(context);
    if (state === null) return;
    this.removeSession(state);
  }

  private removeSession(state: RuntimeSession): void {
    const capture = state.capture;
    state.capture = null;
    if (capture !== null) this.releaseCapture(capture);
    this.reactive.disconnect(state.subscriber);
    state.subscriptions.clear();
    if (this.sessions.get(state.context.clientSessionId) !== state) return;
    this.sessions.delete(state.context.clientSessionId);
    this.telemetry.recordMetric({ name: "runtime.connections", value: this.sessions.size, unit: "gauge" });
  }

  async runProcedure(request: RuntimeProcedureRequest): Promise<Response> {
    const requestBytes = this.requestBytes({
      v: PROTOCOL_VERSION,
      t: "call",
      id: request.id,
      ref: request.address,
      args: request.args,
    });
    const claimedTrace = claimHttpTrace(
      carriedHttpTrace(request),
      "procedure",
      request.address,
      String(request.id),
    );
    const fairnessKey = request.fairnessKey ?? externalCallerKey(request.principal);
    return this.runOperation(null, "procedure", request.address, requestBytes, async () => {
      const fn = this.expect(request.address, "procedure");
      const signal = this.operationSignal(request.signal);
      aborted(signal);
      const value = await invokeFunction(
        fn,
        this.procedureContext(
          request.principal,
          fairnessKey,
          signal,
          requestBytes,
        ),
        request.args,
      );
      aborted(signal);
      return value;
    }, { requestId: String(request.id) }, true, (outcome) =>
      this.respondProcedure(request, outcome), claimedTrace, fairnessKey);
  }

  private respondProcedure(
    request: RuntimeProcedureRequest,
    outcome: RuntimeOperationOutcome<unknown>,
  ): Response {
    let frame: ProcedureOkMessage | ErrorMessage;
    let status: number;
    if (outcome.ok) {
      frame = {
        v: PROTOCOL_VERSION,
        t: "ok",
        id: request.id,
        kind: "procedure",
        value: outcome.value,
      };
      status = 200;
    } else {
      const safe = outcomeFromError(outcome.error);
      frame = { v: PROTOCOL_VERSION, t: "err", id: request.id, outcome: safe };
      status = outcomeHttpStatus(safe);
    }

    let encoded: Pick<RuntimeProcedureResponse, "body" | "bytes">;
    try {
      encoded = this.encodeProcedureFrame(frame);
    } catch (error) {
      if (!outcome.ok) throw error;
      this.recordProcedureResponseFailure(error, "encoding");
      const safe = outcomeFromError(error);
      frame = { v: PROTOCOL_VERSION, t: "err", id: request.id, outcome: safe };
      status = outcomeHttpStatus(safe);
      encoded = this.encodeProcedureFrame(frame);
    }

    return this.handoffProcedureResponse(request, Object.freeze({ ...encoded, status }));
  }

  private encodeProcedureFrame(
    frame: ProcedureOkMessage | ErrorMessage,
  ): Pick<RuntimeProcedureResponse, "body" | "bytes"> {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    let bytes: number | undefined;
    try {
      const body = encode(frame);
      bytes = utf8.encode(body).byteLength;
      let encoded = { body, bytes };
      if (bytes > this.limits.maxFrameBytes) {
        if (frame.t !== "err") {
          throw new DbzzError("overloaded", "procedure result exceeds maxFrameBytes", {
            resource: "operation",
          });
        }
        encoded = this.fitProcedureErrorFrame(frame);
        bytes = encoded.bytes;
      }
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: "ok",
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: bytes,
        }, "procedure");
      }
      return encoded;
    } catch (cause) {
      const error = isDbzzError(cause)
        ? cause
        : new DbzzError("validation", "procedure result is not wire-representable", { cause });
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: error.code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          ...(bytes === undefined ? {} : { sizeBytes: bytes }),
        }, "procedure");
      }
      throw error;
    }
  }

  private fitProcedureErrorFrame(
    frame: ErrorMessage,
  ): Pick<RuntimeProcedureResponse, "body" | "bytes"> {
    const withMessage = (message: string): Pick<RuntimeProcedureResponse, "body" | "bytes"> => {
      const body = encode({
        ...frame,
        outcome: { ...frame.outcome, message },
      } satisfies ErrorMessage);
      return { body, bytes: utf8.encode(body).byteLength };
    };
    let best = withMessage("");
    if (best.bytes > this.limits.maxFrameBytes) {
      throw new DbzzError("overloaded", "procedure error response exceeds maxFrameBytes", {
        resource: "operation",
      });
    }

    const characters = [...frame.outcome.message];
    let low = 0;
    let high = characters.length - 1;
    while (low <= high) {
      const length = low + Math.floor((high - low) / 2);
      const candidate = withMessage(`${characters.slice(0, length).join("")}…`);
      if (candidate.bytes <= this.limits.maxFrameBytes) {
        best = candidate;
        low = length + 1;
      } else {
        high = length - 1;
      }
    }
    return best;
  }

  private handoffProcedureResponse(
    request: RuntimeProcedureRequest,
    response: RuntimeProcedureResponse,
  ): Response {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    try {
      const delivered = request.respond(response);
      if (!(delivered instanceof Response)) {
        throw new TypeError("procedure responder must return a Response");
      }
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "delivery",
          outcome: "ok",
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: response.bytes,
        }, "procedure");
      }
      return delivered;
    } catch (cause) {
      const error = new DbzzError("internal", "HTTP response handoff failed", { cause });
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "delivery",
          outcome: error.code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: response.bytes,
        }, "procedure");
      }
      this.recordProcedureResponseFailure(error, "delivery");
      throw error;
    }
  }

  private recordProcedureResponseFailure(
    error: unknown,
    stage: "encoding" | "delivery",
  ): void {
    if (!this.telemetry.enabled) return;
    const scope = this.trace.getStore();
    this.telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: "procedure",
      stage,
      outcome: outcomeFromError(error).code,
      ...(scope?.currentFunction === undefined ? {} : { functionName: scope.currentFunction }),
      resource: "operation",
      context: this.observationContext(),
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  }

  async runSse(request: RuntimeSseRequest): Promise<ReadableStream<Uint8Array>> {
    const requestBytes = this.requestBytes({
      v: PROTOCOL_VERSION,
      t: "call",
      id: request.id,
      ref: request.address,
      args: request.args,
    });
    const claimedTrace = claimHttpTrace(
      carriedHttpTrace(request),
      "sse",
      request.address,
      String(request.id),
    );
    const fairnessKey = request.fairnessKey ?? externalCallerKey(request.principal);
    const scope = this.telemetry.enabled
      ? this.operationTrace(
          null,
          "sse",
          request.address,
          { requestId: String(request.id) },
          claimedTrace?.context,
        )
      : undefined;
    let traceOpened = claimedTrace === undefined &&
      scope !== undefined &&
      this.telemetry.beginTrace(scope.rootContext);
    const finishOperationTrace = (): void => {
      if (claimedTrace !== undefined) {
        finishClaimedHttpTrace(claimedTrace);
        return;
      }
      if (!traceOpened) return;
      traceOpened = false;
      this.telemetry.finishTrace(scope!.rootContext);
    };
    const admittedAt = scope === undefined ? 0 : performance.now();
    let release: () => void;
    try {
      release = this.admitOperation(null, fairnessKey);
      if (scope !== undefined) {
        this.telemetry.recordSpan({
          operation: "sse",
          stage: "admission",
          outcome: "ok",
          functionName: request.address,
          resource: "operation",
          context: scope.rootContext,
          durationMs: Math.max(0, performance.now() - admittedAt),
          sizeBytes: requestBytes,
        });
      }
    } catch (error) {
      const safeError = transportError(error);
      if (scope !== undefined) {
        const outcome = outcomeFromError(safeError).code;
        this.telemetry.recordSpan({
          operation: "sse",
          stage: "admission",
          outcome,
          functionName: request.address,
          resource: "operation",
          context: scope.rootContext,
          durationMs: Math.max(0, performance.now() - admittedAt),
          sizeBytes: requestBytes,
        });
      }
      finishOperationTrace();
      throw safeError;
    }
    const startedAt = scope === undefined ? 0 : performance.now();
    const execute = async (): Promise<ReadableStream<Uint8Array>> => {
      let producer: BoundedSseProducer | null = null;
      let deliveryObserver: DeliveryObserver | undefined;
      try {
        const fn = this.expect(request.address, "sse");
        const signal = this.operationSignal(request.signal);
        aborted(signal);
        producer = new BoundedSseProducer({
          budget: this.sseBudget,
          limits: this.limits,
          signal,
          ...(this.telemetry.enabled
            ? { observer: (observation: DeliveryObservation) => deliveryObserver?.(observation) }
            : {}),
        });
        this.sseProducers.add(producer);
        const authorized = deferred<void>();
        const stream: StreamWriter = Object.freeze({
          write: (chunk: unknown) => producer!.write(chunk),
          merge: (source: ReadableStream<unknown>) => {
            void producer!.merge(source).catch(() => {});
          },
        });
        const handler = invokeFunction(
          fn,
          Object.freeze({
            ...this.procedureContext(
              request.principal,
              fairnessKey,
              producer.signal,
              requestBytes,
            ),
            stream,
            abortSignal: producer.signal,
          }) as SseCtx,
          request.args,
          {
            onAuthorized: () => {
              deliveryObserver = this.captureDeliveryObserver();
              authorized.resolve();
            },
          },
        );
        const completion = handler.then(
          () => producer!.complete(),
          (error) => {
            producer!.fail(error);
            throw error;
          },
        );
        const lifecycle = completion.catch((error) => {
          if (scope !== undefined) {
            const safeError = transportError(error);
            this.telemetry.recordEvent({
              name: "failure",
              level: "error",
              operation: "sse",
              outcome: outcomeFromError(safeError).code,
              functionName: request.address,
              context: this.observationContext(),
              errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
            });
          }
          throw error;
        }).finally(() => {
          this.sseProducers.delete(producer!);
          release();
          finishOperationTrace();
        });
        void lifecycle.catch(() => {});
        await Promise.race([
          authorized.promise,
          handler.then(
            () => undefined,
            (error) => {
              throw error;
            },
          ),
        ]);
        return producer.stream;
      } catch (error) {
        if (producer !== null) {
          this.sseProducers.delete(producer);
          try {
            await producer.stream.cancel(error);
          } catch {
            // No stream escaped this boundary; cancellation is capacity cleanup.
          }
        }
        release();
        const safeError = transportError(error);
        if (scope !== undefined) {
          const outcome = outcomeFromError(safeError).code;
          if (scope.invocations.size === 0) {
            this.traceSpan({
              operation: "sse",
              stage: "handler",
              outcome,
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes: requestBytes,
            }, "sse");
          }
          this.telemetry.recordEvent({
            name: outcome === "overloaded" ? "overload" : "failure",
            level: outcome === "overloaded" ? "warn" : "error",
            operation: "sse",
            outcome,
            functionName: request.address,
            context: this.observationContext(),
            errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
          });
        }
        finishOperationTrace();
        throw safeError;
      }
    };
    return scope === undefined ? execute() : this.runTraced(scope, execute);
  }

  runScheduled(now = this.readNow()): Promise<number> {
    if (this.scheduledRun !== null) return this.scheduledRun;
    this.assertReady();
    const execution = this.runOperation(null, "scheduled", undefined, 1, async () => {
      let handled = 0;
      for (let attempts = 0; attempts < this.limits.schedulerBatchSize; attempts++) {
        const candidate = await this.nextScheduledCandidate(now);
        if (candidate === null) break;
        let row: Record<string, unknown> | null = null;
        try {
          await this.coordinator.execute({
            operation: "scheduled",
            fairnessKey: "system:scheduler",
            requestBytes: 1,
            signal: this.shutdownController.signal,
            ...(this.telemetry.enabled
              ? { telemetry: this.observeCommit, statementTelemetry: this.observeStatement }
              : {}),
            work: async (db) => {
              const plan = this.engine.plan(candidate.table);
              const raw = this.measuredStatement("read", candidate.table, "scheduledGet", () =>
                this.engine.writer.query(
                  `SELECT * FROM ${quoted(candidate.table)} WHERE ${quoted(plan.pk)} = ? AND ${quoted(plan.scheduleAt!)} <= ?`,
                )
                  .get(candidate.primaryKey as never, now) as Record<string, unknown> | null,
                (value) => value === null ? 0 : 1,
              );
              if (raw === null) throw STALE_SCHEDULED_CANDIDATE;
              row = this.engine.rowFromSql(plan, raw);
              const fn = this.expect(candidate.address, "mutation");
              await invokeFunction(fn, Object.freeze({ db, auth: SYSTEM_PRINCIPAL }), row);
            },
            finalize: (writes) => {
              const scheduledRow = row;
              if (scheduledRow === null) {
                throw new Error("scheduled row disappeared during its writer turn");
              }
              const plan = this.engine.plan(candidate.table);
              this.measuredStatement("write", candidate.table, "scheduledDelete", () =>
                this.engine.writer
                  .query(`DELETE FROM ${quoted(candidate.table)} WHERE ${quoted(plan.pk)} = ?`)
                  .run(scheduledRow[plan.pk] as never),
                () => 1,
              );
              emitWriteKeys(plan, scheduledRow, writes.keys);
              writes.scheduledTouched = true;
            },
            publication: (_version, writes) => this.publicationFor(writes),
          });
          handled++;
        } catch (error) {
          if (error !== STALE_SCHEDULED_CANDIDATE) throw error;
        }
      }
      return handled;
    });
    let run!: Promise<number>;
    run = execution.then(
      (handled) => {
        if (this.lifecycle === "ready") this.armScheduler();
        return handled;
      },
      (error) => {
        this.retryScheduler(error);
        throw error;
      },
    ).finally(() => {
      if (this.scheduledRun === run) this.scheduledRun = null;
    });
    this.scheduledRun = run;
    return run;
  }

  armScheduler(): void {
    const generation = ++this.schedulerGeneration;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.lifecycle !== "ready" || this.scheduled.size === 0) return;
    void this.nextScheduledAt().then(
      (at) => {
        if (this.lifecycle !== "ready" || generation !== this.schedulerGeneration || at === null) return;
        const delay = Math.min(Math.max(0, at - this.readNow()), 0x7fff_ffff);
        this.schedulerTimer = setTimeout(() => {
          this.schedulerTimer = null;
          void this.runScheduled().catch(() => {});
        }, delay);
        this.schedulerTimer.unref?.();
      },
      (error) => {
        if (this.lifecycle === "ready" && generation === this.schedulerGeneration) {
          this.retryScheduler(error);
        }
      },
    );
  }

  private retryScheduler(error: unknown): void {
    this.telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: "scheduled",
      outcome: outcomeFromError(transportError(error)).code,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    const generation = ++this.schedulerGeneration;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.lifecycle !== "ready") return;
    this.schedulerTimer = setTimeout(() => {
      if (this.lifecycle === "ready" && generation === this.schedulerGeneration) this.armScheduler();
    }, SCHEDULER_RETRY_MS);
    this.schedulerTimer.unref?.();
  }

  status(): RuntimeStatus {
    return Object.freeze({
      state: this.lifecycle,
      connections: this.sessions.size,
      activeOperations: this.activeOperations,
      activeOperationCallers: this.externalOperations.size,
      activeSse: this.sseProducers.size,
      scheduledHandlers: this.scheduled.size,
      schedulerArmed: this.schedulerTimer !== null,
      reader: this.reader.snapshot(),
      writer: this.coordinator.snapshot(),
      reactive: this.reactive.snapshot(),
      publication: this.reactive.publication.snapshot(),
      authCaptureBudget: this.authCaptureBudget.snapshot(),
      sseBudget: this.sseBudget.snapshot(),
      telemetry: this.telemetry.snapshot(),
      storage: this.engine.status(),
    });
  }

  drain(deadlineAtMs = Date.now() + this.limits.gracefulShutdownMs): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (!Number.isFinite(deadlineAtMs)) {
      throw new RangeError("runtime shutdown deadline must be finite");
    }
    this.lifecycle = "draining";
    this.schedulerGeneration++;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    this.stopSampler();
    this.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "draining",
    });
    const draining = new DbzzError("draining", "runtime is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "operation",
    });
    for (const state of [...this.sessions.values()]) this.removeSession(state);
    for (const producer of this.sseProducers) producer.fail(draining);

    // Close every internal admission boundary before the first await. Existing
    // handlers get one finite grace period; queued and future work cannot grow.
    this.coordinator.close();
    this.reader.close();
    if (this.ownsTelemetry) this.telemetry.stop();
    const reactiveDrain = this.reactive.close();
    let deadlineReached = false;
    const coreShutdown = Promise.all([
      this.waitForActiveOperations(),
      this.coordinator.drain(),
      reactiveDrain,
      this.reader.drain(),
    ]).then(() => undefined);
    const shutdownWork = coreShutdown.then(() => {
      // A core that outlives the Runtime deadline must not start a detached
      // telemetry tail after drain has already failed.
      if (deadlineReached) return;
      this.telemetry.recordEvent({
        name: "lifecycle",
        level: "info",
        operation: "lifecycle",
        lifecycleState: "stopped",
      });
      return this.ownsTelemetry ? this.telemetry.drain(deadlineAtMs) : this.telemetry.flush();
    });

    const deadlineError = new DbzzError(
      "deadline_exceeded",
      "runtime graceful shutdown deadline exceeded",
      { resource: "operation" },
    );
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        deadlineReached = true;
        this.shutdownController.abort(deadlineError);
        reject(deadlineError);
      }, Math.max(0, deadlineAtMs - Date.now()));
    });
    this.drainPromise = Promise.race([shutdownWork, deadline]).then(
      () => {
        clearTimeout(timeout);
        this.shutdownController.abort(draining);
        this.lifecycle = "stopped";
      },
      async (error) => {
        clearTimeout(timeout);
        deadlineReached = true;
        this.shutdownController.abort(error);
        this.lifecycle = "failed";
        this.telemetry.recordEvent({
          name: "lifecycle",
          level: "error",
          operation: "lifecycle",
          lifecycleState: "failed",
          outcome: outcomeFromError(error).code,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
        // Owned telemetry was stopped before core shutdown. Capture the final
        // failed event into its bounded drain even though the absolute Runtime
        // deadline has already elapsed, so no post-failure queue is retained.
        if (this.ownsTelemetry) await this.telemetry.drain(deadlineAtMs);
        throw error;
      },
    );
    return this.drainPromise;
  }

  private expect(address: string, kind: "query" | "mutation" | "procedure" | "sse"): AnyRegistered {
    const fn = this.registry.get(address);
    if (fn === undefined) throw new DbzzError("not_found", `unknown function "${address}"`);
    if (fn.kind !== kind) {
      throw new DbzzError("validation", `"${address}" is a ${fn.kind}, expected a ${kind}`);
    }
    return fn;
  }

  private matchingSession(context: SessionRuntimeContext): RuntimeSession | null {
    const state = this.sessions.get(context.clientSessionId);
    if (
      state === undefined ||
      state.context.authEpoch !== context.authEpoch ||
      state.context.principal !== context.principal ||
      state.context.signal !== context.signal
    ) {
      return null;
    }
    return state;
  }

  private currentSession(context: SessionRuntimeContext, allowAborted = false): RuntimeSession {
    this.assertReady();
    const state = this.matchingSession(context);
    if (state === null) throw new DbzzError("auth_stale", "authentication state changed");
    if (!allowAborted) aborted(context.signal);
    return state;
  }

  private runSessionOperation<T>(
    context: SessionRuntimeContext,
    message: SubscribeMessage | UnsubscribeMessage | ResetRequestMessage | QueryMessage | MutationMessage,
    operation: "query" | "mutation" | "subscription",
    functionName: string | undefined,
    work: (state: RuntimeSession, requestBytes: number) => T | Promise<T>,
    options: SessionOperationOptions<T> = {},
  ): Promise<T> {
    const requestBytes = this.requestBytes(message);
    const state = this.matchingSession(context);
    return this.runOperation(
      state,
      operation,
      functionName,
      requestBytes,
      () => work(this.currentSession(context), requestBytes),
      options.identifiers ?? {},
      options.synthesizeHandler ?? true,
      (outcome) => this.publishOperationOutcome(context, state, message.id, operation, outcome, options),
    );
  }

  private async publishOperationOutcome<T>(
    context: SessionRuntimeContext,
    state: RuntimeSession | null,
    id: number,
    operation: "query" | "mutation" | "subscription",
    outcome: RuntimeOperationOutcome<T>,
    options: SessionOperationOptions<T>,
  ): Promise<T> {
    const frame = outcome.ok
      ? options.successFrame?.(outcome.value)
      : {
          v: PROTOCOL_VERSION,
          t: "err",
          id,
          outcome: outcomeFromError(outcome.error),
        } satisfies ErrorMessage;
    if (frame !== undefined && !context.signal.aborted) {
      if (state !== null) {
        await this.publishSession(state, context.authEpoch, frame);
      } else {
        this.assertFrameFits(
          frame,
          "application frame",
          operation === "subscription" ? "subscription" : "operation",
        );
        await context.publish(frame);
      }
    }
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  private makeSubscriber(state: () => RuntimeSession, authEpoch: number): Subscriber {
    const publish = (message: RuntimePublication): Promise<void> =>
      this.publishSession(state(), authEpoch, message);
    return Object.freeze({
      sendTransition: (id: number, transition: SubscriptionTransition) => publish({
        v: PROTOCOL_VERSION,
        t: "transition",
        id,
        transition,
      } satisfies TransitionMessage),
      sendEvent: (id: number, event: LiveEvent) => publish({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event,
      } satisfies EventMessage),
      sendError: (id: number, outcome: Outcome) => publish({
        v: PROTOCOL_VERSION,
        t: "err",
        id,
        outcome,
      } satisfies ErrorMessage),
    });
  }

  private async publishSession(
    state: RuntimeSession,
    sourceAuthEpoch: number,
    message: RuntimePublication,
  ): Promise<void> {
    const capture = state.capture;
    if (capture !== null) {
      if (!this.captureAccepts(capture, sourceAuthEpoch, message)) return;
      const bytes = this.assertFrameFits(message, "subscription frame", "subscription");
      this.captureFrame(capture, message, bytes);
      return;
    }
    if (sourceAuthEpoch !== state.context.authEpoch) return;
    const resource = message.t === "transition" || message.t === "event" ||
      this.trace.getStore()?.operation === "subscription"
      ? "subscription"
      : "operation";
    this.assertFrameFits(message, "application frame", resource);
    if (!await state.context.publish(message)) {
      throw new DbzzError("auth_stale", "authentication state changed");
    }
  }

  private captureAccepts(
    capture: AuthTransitionCapture,
    sourceAuthEpoch: number,
    message: RuntimePublication,
  ): boolean {
    if (sourceAuthEpoch !== capture.authEpoch) return false;
    if (capture.phase === "revoking") {
      return (
        message.t === "transition" &&
        message.transition.kind === "revoked" &&
        message.transition.outcome.code === "auth_stale"
      ) || (message.t === "err" && message.outcome.code === "auth_stale");
    }
    return (
      (message.t === "transition" && message.transition.kind === "reset") ||
      (message.t === "event" && message.event.kind === "reset") ||
      message.t === "err"
    );
  }

  private captureFrame(
    capture: AuthTransitionCapture,
    message: RuntimePublication,
    measuredBytes = this.assertFrameFits(message, "subscription frame", "subscription"),
  ): void {
    if (!capture.active) throw new DbzzError("auth_stale", "authentication state changed");
    const maxItems = Math.min(Number.MAX_SAFE_INTEGER, this.limits.maxSubscriptionsPerConnection * 2);
    const maxBytes = this.limits.webSocket.maxBytesPerConnection - this.limits.maxFrameBytes;
    if (capture.frames.length >= maxItems || measuredBytes > maxBytes - capture.bytes) {
      throw new DbzzError("overloaded", "authentication transition exceeds capture capacity", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    const reservation = this.authCaptureBudget.reserve(measuredBytes, "application");
    if (reservation === null) {
      throw new DbzzError("overloaded", "authentication transition exceeds global capture capacity", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    capture.frames.push(message);
    capture.reservations.push(reservation);
    capture.bytes += measuredBytes;
  }

  private finishCapture(capture: AuthTransitionCapture): RuntimePublicationBatch {
    if (!capture.active) throw new DbzzError("auth_stale", "authentication state changed");
    capture.active = false;
    const frames = capture.frames.splice(0);
    const reservations = capture.reservations.splice(0);
    const bytes = capture.bytes;
    capture.bytes = 0;
    let released = false;
    return Object.freeze({
      frames,
      bytes,
      release: () => {
        if (released) return;
        released = true;
        frames.length = 0;
        for (const reservation of reservations) reservation.release();
        reservations.length = 0;
      },
    });
  }

  private releaseCapture(capture: AuthTransitionCapture): void {
    if (!capture.active && capture.reservations.length === 0) return;
    capture.active = false;
    capture.frames.length = 0;
    capture.bytes = 0;
    for (const reservation of capture.reservations) reservation.release();
    capture.reservations.length = 0;
  }

  private async attachSubscription(
    state: RuntimeSession,
    id: number,
    definition: RuntimeSubscription,
    remember: boolean,
  ): Promise<void> {
    let remembered = definition;
    if (definition.address.startsWith("events.")) {
      const table = definition.address.slice("events.".length);
      const tableDefinition = this.engine.schema.tables[table];
      if (tableDefinition?.kind !== "event") {
        throw new DbzzError("not_found", `unknown event table "${table}"`);
      }
      const subscription = tableDefinition.eventSubscription!;
      const policyAt = this.telemetry.enabled ? performance.now() : 0;
      let authorized: Awaited<ReturnType<typeof authorizeInvocation>>;
      try {
        authorized = await authorizeInvocation(
          subscription,
          { auth: state.context.principal },
          definition.args,
        );
        if (this.telemetry.enabled) {
          this.traceSpan({
            stage: "policy",
            outcome: "ok",
            functionName: definition.address,
            resource: "subscription",
            durationMs: Math.max(0, performance.now() - policyAt),
          }, "subscription");
        }
      } catch (error) {
        if (this.telemetry.enabled) {
          this.traceSpan({
            stage: "policy",
            outcome: outcomeFromError(transportError(error)).code,
            functionName: definition.address,
            resource: "subscription",
            durationMs: Math.max(0, performance.now() - policyAt),
          }, "subscription");
        }
        throw error;
      }
      await this.reactive.subscribeEvent({
        subscriber: state.subscriber,
        id,
        table,
        authEpoch: state.context.authEpoch,
        args: authorized.args,
        matches: subscription.matches as (row: unknown, args: unknown) => boolean,
      });
      remembered = Object.freeze({ ...definition, args: authorized.args });
    } else {
      this.expect(definition.address, "query");
      await this.reactive.subscribeQuery({
        subscriber: state.subscriber,
        id,
        address: definition.address,
        args: definition.args,
        policyScopeFingerprint: digest(state.context.principal),
        context: {
          principal: state.context.principal,
          fairnessKey: state.context.clientSessionId,
        },
        authEpoch: state.context.authEpoch,
        ...(!remember || definition.cursor === undefined ? {} : { cursor: definition.cursor }),
      });
    }
    if (remember) state.subscriptions.set(id, remembered);
  }

  private executeQuery(
    operation: "query" | "subscription",
    address: string,
    args: unknown,
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
  ): Promise<QueryEvaluation> {
    const fn = this.expect(address, "query");
    return this.submitRead(async (connection) => {
      aborted(signal);
      let transactionOpen = false;
      const beginAt = this.telemetry.enabled ? performance.now() : 0;
      try {
        connection.exec("BEGIN DEFERRED");
        transactionOpen = true;
        if (this.telemetry.enabled) {
          this.traceSpan({
            stage: "storage",
            outcome: "ok",
            resource: "reader",
            durationMs: Math.max(0, performance.now() - beginAt),
          }, "query");
        }
        const readSet = new Set<string>();
        const recorder: ReadRecorder = { add: (key) => readSet.add(key) };
        const version = this.engine.commitVersion(connection);
        const db = makeDbReader(
          this.engine,
          connection,
          recorder,
          this.telemetry.enabled ? this.observeStatement : undefined,
        );
        const value = await invokeFunction(fn, Object.freeze({ db, auth: principal }), args);
        aborted(signal);
        const encodingAt = this.telemetry.enabled ? performance.now() : 0;
        let encoded: string;
        try {
          encoded = encode(value);
          if (this.telemetry.enabled) {
            this.traceSpan({
              stage: "encoding",
              outcome: "ok",
              resource: "operation",
              durationMs: Math.max(0, performance.now() - encodingAt),
              sizeBytes: utf8.encode(encoded).byteLength,
              resultCount: Array.isArray(value) ? value.length : value === null ? 0 : 1,
            }, "query");
          }
        } catch (error) {
          if (this.telemetry.enabled) {
            this.traceSpan({
              stage: "encoding",
              outcome: outcomeFromError(transportError(error)).code,
              resource: "operation",
              durationMs: Math.max(0, performance.now() - encodingAt),
            }, "query");
          }
          throw error;
        }
        const commitAt = this.telemetry.enabled ? performance.now() : 0;
        try {
          connection.exec("COMMIT");
          transactionOpen = false;
          if (this.telemetry.enabled) {
            this.traceSpan({
              stage: "commit",
              outcome: "ok",
              resource: "reader",
              durationMs: Math.max(0, performance.now() - commitAt),
            }, "query");
          }
        } catch (error) {
          if (this.telemetry.enabled) {
            this.traceSpan({
              stage: "commit",
              outcome: outcomeFromError(transportError(error)).code,
              resource: "reader",
              durationMs: Math.max(0, performance.now() - commitAt),
            }, "query");
          }
          throw error;
        }
        return Object.freeze({ value, encoded, readSet, commitVersion: version });
      } catch (error) {
        if (transactionOpen) {
          const rollbackAt = this.telemetry.enabled ? performance.now() : 0;
          try {
            connection.exec("ROLLBACK");
            if (this.telemetry.enabled) {
              this.traceSpan({
                stage: "rollback",
                outcome: "ok",
                resource: "reader",
                durationMs: Math.max(0, performance.now() - rollbackAt),
              }, "query");
            }
          } catch (rollbackError) {
            if (this.telemetry.enabled) {
              this.traceSpan({
                stage: "rollback",
                outcome: "unavailable",
                resource: "reader",
                durationMs: Math.max(0, performance.now() - rollbackAt),
              }, "query");
            }
            throw new DbzzError("unavailable", "reader snapshot could not be closed", {
              resource: "reader",
              cause: rollbackError,
            });
          }
        } else if (this.telemetry.enabled && beginAt > 0) {
          this.traceSpan({
            stage: "storage",
            outcome: outcomeFromError(transportError(error)).code,
            resource: "reader",
            durationMs: Math.max(0, performance.now() - beginAt),
          }, "query");
        }
        throw error;
      }
    }, {
      operation,
      bytes: requestBytes,
      fairnessKey,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private submitRead<T>(
    work: (connection: Database) => T | Promise<T>,
    options: ExecutorTaskOptions,
    observed = this.telemetry.enabled,
  ): Promise<T> {
    const run = async () => {
      const connection = this.availableReaders.pop() ?? this.engine.createReader();
      try {
        return await work(connection);
      } finally {
        this.availableReaders.push(connection);
      }
    };
    if (!observed) return this.reader.submit(run, options);
    const scope = this.trace.getStore();
    const queuedAt = performance.now();
    let started = false;
    return this.reader.submit(() => {
      started = true;
      const admitted = () => {
        this.traceSpan({
          operation: options.operation,
          stage: "queue",
          outcome: "ok",
          resource: "reader",
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: options.bytes,
        }, options.operation);
        return run();
      };
      return scope === undefined ? admitted() : this.trace.run(scope, admitted);
    }, options).catch((error) => {
      if (!started) {
        const rejected = () => this.traceSpan({
          operation: options.operation,
          stage: "queue",
          outcome: outcomeFromError(transportError(error)).code,
          resource: "reader",
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: options.bytes,
        }, options.operation);
        if (scope === undefined) rejected();
        else this.trace.run(scope, rejected);
      }
      throw error;
    });
  }

  private evaluateSubscription(input: QueryEvaluationInput<ReactiveContext>): Promise<QueryEvaluation> {
    const execute = () => this.executeQuery(
      "subscription",
      input.address,
      input.args,
      input.context.principal,
      input.context.fairnessKey,
      this.shutdownController.signal,
      byteLength(input.args),
    );
    if (!this.telemetry.enabled) return execute();
    const scope = this.trace.getStore();
    if (scope === undefined) {
      const evaluationScope = this.operationTrace(null, "subscription", input.address, {});
      const traceOpened = this.telemetry.beginTrace(evaluationScope.rootContext);
      const evaluation = this.runTraced(evaluationScope, execute);
      return traceOpened
        ? evaluation.finally(() => {
            this.telemetry.finishTrace(evaluationScope.rootContext);
          })
        : evaluation;
    }
    return this.trace.run({
      ...scope,
      operation: "subscription",
      currentFunction: input.address,
    }, execute);
  }

  private procedureContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): ProcedureCtx {
    return Object.freeze({
      auth: principal,
      abortSignal: signal,
      tx: async <T>(work: (ctx: TxCtx) => T | Promise<T>): Promise<T> => {
        const execute = async (): Promise<T> => {
          aborted(signal);
          let scheduledTouched = false;
          const result = await this.coordinator.execute({
            operation: "transaction",
            fairnessKey,
            requestBytes,
            ...(this.telemetry.enabled
              ? { telemetry: this.observeCommit, statementTelemetry: this.observeStatement }
              : {}),
            signal,
            work: (db) => work(Object.freeze({ db, auth: principal })),
            publication: (_version, writes) => {
              scheduledTouched = writes.scheduledTouched;
              return this.publicationFor(writes);
            },
          });
          if (scheduledTouched) this.armScheduler();
          return result.value;
        };
        const scope = this.trace.getStore();
        return scope === undefined
          ? execute()
          : this.trace.run({ ...scope, operation: "transaction" }, execute);
      },
    });
  }

  private publicationFor(writes: WriteCollector, caller?: Subscriber): ReactiveCommit {
    return new ReactiveCommit(
      writes.keys,
      writes.events,
      caller,
    );
  }

  private async finishMutation(
    state: RuntimeSession,
    message: MutationMessage,
    result: CommitResult<unknown, ReactiveCommit>,
  ): Promise<RuntimeMutationResult> {
    let obligations: readonly number[];
    if (result.replay === "replayed") {
      const convergence = await this.reactive.converge(state.subscriber, result.commitVersion);
      obligations = convergence.affectedCallerIds;
      this.assertConvergence(state.subscriber, obligations, convergence.deliveryFailures);
    } else {
      const convergence = result.publication?.result;
      if (convergence === undefined) {
        throw convergenceError("commit publication did not produce convergence state");
      }
      obligations = convergence.affectedCallerIds;
      this.assertConvergence(state.subscriber, obligations, convergence.deliveryFailures);
    }
    const frame = this.mutationFrame(
      message,
      result.value,
      result.commitVersion,
      result.durability,
      result.replay,
      obligations,
    );
    try {
      this.assertFrameFits(frame, "mutation result");
    } catch (error) {
      throw convergenceError(
        `mutation ${message.mutationRequestId} committed but its receipt cannot fit one frame`,
      );
    }
    return Object.freeze({ value: result.value, receipt: frame.receipt });
  }

  private mutationFrame(
    message: MutationMessage,
    value: unknown,
    commitVersion: bigint,
    durability: CommitResult<unknown, ReactiveCommit>["durability"],
    replay: "executed" | "replayed",
    obligations: readonly number[],
  ): MutationOkMessage {
    return {
      v: PROTOCOL_VERSION,
      t: "ok",
      id: message.id,
      kind: "mutation",
      value,
      receipt: {
        mutationRequestId: message.mutationRequestId,
        commitVersion,
        durability,
        replay,
        obligations: Object.freeze([...obligations]),
      },
    };
  }

  private assertConvergence(
    caller: Subscriber,
    obligations: readonly number[],
    failures: readonly { subscriber: Subscriber; subscriptionId: number; error: unknown }[],
  ): void {
    const required = new Set(obligations);
    const failure = failures.find(
      (candidate) => candidate.subscriber === caller && required.has(candidate.subscriptionId),
    );
    if (failure !== undefined) {
      throw new DbzzError("convergence_unavailable", "mutation committed but subscription convergence failed", {
        committed: true,
        cause: failure.error,
      });
    }
  }

  private assertFrameFits(
    frame: unknown,
    label: string,
    resource: "operation" | "subscription" = "operation",
  ): number {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    let bytes: number;
    try {
      bytes = byteLength(frame);
    } catch (error) {
      const failure = new DbzzError("validation", `${label} is not wire-representable`, {
        cause: error,
      });
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: failure.code,
          resource,
          durationMs: Math.max(0, performance.now() - startedAt),
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (bytes > this.limits.maxFrameBytes) {
      const failure = new DbzzError("overloaded", `${label} exceeds maxFrameBytes`, { resource });
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: failure.code,
          resource,
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: bytes,
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (this.telemetry.enabled) {
      this.traceSpan({
        stage: "encoding",
        outcome: "ok",
        resource,
        durationMs: Math.max(0, performance.now() - startedAt),
        sizeBytes: bytes,
      }, resource === "subscription" ? "subscription" : "query");
    }
    return bytes;
  }

  private nextScheduledAt(): Promise<number | null> {
    return this.submitRead((connection) => {
      let earliest: number | null = null;
      for (const table of this.scheduled.keys()) {
        const plan = this.engine.plan(table);
        const row = connection
          .query(`SELECT MIN(${quoted(plan.scheduleAt!)}) AS at FROM ${quoted(table)}`)
          .get() as { at: number | bigint | null };
        if (row.at === null) continue;
        const value = Number(row.at);
        if (earliest === null || value < earliest) earliest = value;
      }
      return earliest;
    }, {
      operation: "scheduled",
      bytes: 1,
      fairnessKey: "system:scheduler",
    }, false);
  }

  private nextScheduledCandidate(now: number): Promise<ScheduledCandidate | null> {
    return this.submitRead((connection) => {
      let candidate: (ScheduledCandidate & { readonly at: number }) | null = null;
      for (const [table, address] of this.scheduled) {
        const plan = this.engine.plan(table);
        const raw = this.measuredStatement("read", table, "scheduledCandidate", () =>
          connection.query(
            `SELECT ${quoted(plan.pk)} AS primaryKey, ${quoted(plan.scheduleAt!)} AS at FROM ${quoted(table)} WHERE ${quoted(plan.scheduleAt!)} <= ? ORDER BY ${quoted(plan.scheduleAt!)}, ${quoted(plan.pk)} LIMIT 1`,
          )
            .get(now) as { primaryKey: unknown; at: number | bigint } | null,
          (value) => value === null ? 0 : 1,
        );
        if (raw === null) continue;
        const at = Number(raw.at);
        if (candidate === null || at < candidate.at) {
          candidate = { table, address, primaryKey: raw.primaryKey, at };
        }
      }
      return candidate === null
        ? null
        : { table: candidate.table, address: candidate.address, primaryKey: candidate.primaryKey };
    }, {
      operation: "scheduled",
      bytes: 1,
      fairnessKey: "system:scheduler",
    });
  }

  private readonly observeInvocation = (observation: InvocationObservation): void => {
    const scope = this.trace.getStore();
    if (scope === undefined) return;
    this.telemetry.recordSpan({
      operation: scope.operation,
      stage: observation.phase,
      outcome: observation.outcome,
      functionName: this.registry.addressOf(observation.fn) ?? scope.currentFunction,
      context: scope.currentContext,
      durationMs: observation.durationMs,
    });
  };

  private readonly runInvocationPhase: InvocationPhaseRunner = (
    phase: Readonly<InvocationPhaseScope>,
    work,
  ) => {
    const scope = this.trace.getStore();
    if (scope === undefined) return work();
    let node = scope.invocations.get(phase.invocationId);
    if (node === undefined) {
      const parent = phase.parentInvocationId === undefined
        ? scope.rootContext
        : scope.invocations.get(phase.parentInvocationId)?.handler ?? scope.rootContext;
      node = Object.freeze({ parent, handler: childTelemetryContext(parent) });
      scope.invocations.set(phase.invocationId, node);
    }
    const context = phase.phase === "handler"
      ? node.handler
      : childTelemetryContext(node.parent);
    const functionName = this.registry.addressOf(phase.fn) ?? scope.currentFunction;
    return this.trace.run({
      ...scope,
      currentContext: context,
      ...(functionName === undefined ? {} : { currentFunction: functionName }),
    }, work);
  };

  private readonly observeFetch = (observation: Readonly<FetchObservation>): void => {
    this.traceSpan({
      stage: "fetch",
      outcome: observation.outcome,
      resource: "outbound",
      durationMs: observation.durationMs,
    }, "procedure");
  };

  private readonly observeStatement: DbStatementObserver = (
    observation: Readonly<DbStatementObservation>,
  ): void => {
    this.traceSpan({
      stage: "statement",
      outcome: observation.outcome === "ok" ? "ok" : "internal",
      statement: `${observation.table}.${observation.statement}`,
      resource: observation.kind === "read" ? "reader" : "writer",
      durationMs: observation.durationMs,
      ...(observation.rowCount === undefined ? {} : { rowCount: observation.rowCount }),
    }, observation.kind === "read" ? "query" : "transaction");
  };

  private measuredStatement<T>(
    kind: DbStatementObservation["kind"],
    table: string,
    statement: string,
    work: () => T,
    rowCount: (value: T) => number,
  ): T {
    if (!this.telemetry.enabled) return work();
    const startedAt = performance.now();
    try {
      const value = work();
      this.observeStatement({
        kind,
        table,
        statement,
        outcome: "ok",
        durationMs: Math.max(0, performance.now() - startedAt),
        rowCount: rowCount(value),
      });
      return value;
    } catch (error) {
      this.observeStatement({
        kind,
        table,
        statement,
        outcome: "failed",
        durationMs: Math.max(0, performance.now() - startedAt),
      });
      throw error;
    }
  }

  private readonly observeCommit = (event: Readonly<CommitTelemetryEvent>): void => {
    const resource: TelemetryResource = event.stage === "publication"
      ? "publication"
      : event.replayed === true || event.stage === "encoding"
        ? "idempotency"
        : "writer";
    this.traceSpan({
      operation: event.operation,
      stage: event.stage,
      outcome: event.outcome,
      resource,
      durationMs: event.durationMs,
      ...(event.sizeBytes === undefined ? {} : { sizeBytes: event.sizeBytes }),
      ...(event.resultCount === undefined ? {} : { resultCount: event.resultCount }),
      ...(event.dependencyCount === undefined ? {} : { dependencyCount: event.dependencyCount }),
      ...(event.replayed === undefined ? {} : { replayed: event.replayed }),
      ...(event.postCommit === undefined ? {} : { postCommit: event.postCommit }),
      ...(event.commitVersion === undefined
        ? {}
        : { context: this.observationContext({ commitId: String(event.commitVersion) }) }),
    }, event.operation);
  };

  private readonly observeReactive: ReactiveObserver = (
    observation: ReactiveObservation,
  ): void => {
    if (observation.phase === "failure") {
      this.telemetry.recordEvent({
        name: "failure",
        level: "error",
        operation: "subscription",
        outcome: observationOutcome(observation.outcome),
        ...(observation.address === undefined ? {} : { functionName: observation.address }),
        resource: "subscription",
        context: this.observationContext({
          ...(observation.subscriptionId === undefined
            ? {}
            : { subscriptionId: String(observation.subscriptionId) }),
          ...(observation.commitVersion === undefined
            ? {}
            : { commitId: String(observation.commitVersion) }),
        }),
      });
      return;
    }
    const stage: TelemetryStage = observation.phase === "initial_evaluation" ||
        observation.phase === "evaluation"
      ? "evaluation"
      : observation.phase === "invalidation_match" || observation.phase === "event_match"
        ? "match"
        : observation.phase === "revalidation_queue" || observation.phase === "listener_queue"
          ? "queue"
          : observation.phase;
    const resource: TelemetryResource = observation.phase === "revalidation_queue" ||
        observation.phase === "evaluation" || observation.phase === "initial_evaluation" ||
        observation.phase === "changed" || observation.phase === "unchanged"
      ? "revalidation"
      : observation.phase === "delivery" || observation.phase === "listener_queue" ||
          observation.phase === "fanout"
        ? "outbound"
        : "subscription";
    this.traceSpan({
      operation: "subscription",
      stage,
      outcome: observationOutcome(observation.outcome),
      resource,
      durationMs: observation.durationMs,
      ...(observation.address === undefined ? {} : { functionName: observation.address }),
      ...(observation.resultCount === undefined ? {} : { resultCount: observation.resultCount }),
      ...(observation.dependencyCount === undefined
        ? {}
        : { dependencyCount: observation.dependencyCount }),
      ...(observation.byteCount === undefined ? {} : { sizeBytes: observation.byteCount }),
      context: this.observationContext({
        ...(observation.subscriptionId === undefined
          ? {}
          : { subscriptionId: String(observation.subscriptionId) }),
        ...(observation.commitVersion === undefined
          ? {}
          : { commitId: String(observation.commitVersion) }),
      }),
    }, "subscription");
  };

  private operationTrace(
    session: RuntimeSession | null,
    operation: TelemetryOperation,
    functionName: string | undefined,
    identifiers: TraceIdentifiers,
    inheritedContext?: TelemetryTraceContext,
  ): RuntimeTraceScope {
    const rootContext = inheritedContext ?? telemetryContext({
      ...(session === null
        ? {}
        : { connectionId: digest(session.context.clientSessionId) }),
      ...identifiers,
    });
    return {
      operation,
      ...(functionName === undefined ? {} : { rootFunction: functionName }),
      rootContext,
      currentContext: rootContext,
      ...(functionName === undefined ? {} : { currentFunction: functionName }),
      invocations: new Map(),
    };
  }

  private observationContext(identifiers: TraceIdentifiers = {}): TelemetryTraceContext {
    const current = this.trace.getStore()?.currentContext;
    return current === undefined
      ? telemetryContext(identifiers)
      : childTelemetryContext(current, identifiers);
  }

  private traceSpan(
    input: Omit<TelemetrySpanInput, "operation" | "context"> & {
      readonly operation?: TelemetryOperation;
      readonly context?: TelemetryTraceContext;
    },
    fallbackOperation: TelemetryOperation,
  ): void {
    if (!this.telemetry.enabled) return;
    const scope = this.trace.getStore();
    const context = input.context ?? this.observationContext();
    this.telemetry.recordSpan({
      ...input,
      operation: input.operation ?? scope?.operation ?? fallbackOperation,
      context,
      functionName: input.functionName ?? scope?.currentFunction ?? scope?.rootFunction,
    });
  }

  private runTraced<T>(scope: RuntimeTraceScope, work: () => T): T {
    return this.trace.run(scope, () => withFetchObserver(
      this.observeFetch,
      () => withInvocationObserver(this.observeInvocation, work, this.runInvocationPhase),
    ));
  }

  readonly captureDeliveryObserver = (
    lane: OutboundLane = "application",
    clientSessionId?: string,
  ): DeliveryObserver | undefined => {
    if (!this.telemetry.enabled) return undefined;
    const scope = this.trace.getStore() ?? this.operationTrace(
      null,
      lane === "control" ? "lifecycle" : "subscription",
      undefined,
      clientSessionId === undefined ? {} : { connectionId: digest(clientSessionId) },
    );
    return (observation) => this.trace.run(scope, () => this.deliveryObserver(observation));
  };

  private runOperation<T, R = T>(
    session: RuntimeSession | null,
    operation: TelemetryOperation,
    functionName: string | undefined,
    sizeBytes: number,
    work: () => T | Promise<T>,
    identifiers: TraceIdentifiers = {},
    synthesizeHandler = true,
    finalize?: RuntimeOperationFinalizer<T, R>,
    claimedTrace?: ClaimedHttpTrace,
    fairnessKey?: string,
  ): Promise<R> {
    const scope = this.telemetry.enabled
      ? this.operationTrace(session, operation, functionName, identifiers, claimedTrace?.context)
      : undefined;
    const traceOpened = claimedTrace === undefined &&
      scope !== undefined &&
      this.telemetry.beginTrace(scope.rootContext);
    const finishOperationTrace = <V>(result: Promise<V>): Promise<V> =>
      claimedTrace !== undefined
        ? result.finally(() => finishClaimedHttpTrace(claimedTrace))
        : traceOpened
          ? result.finally(() => {
              this.telemetry.finishTrace(scope!.rootContext);
            })
          : result;
    const admittedAt = scope === undefined ? 0 : performance.now();
    const settle = async (outcome: RuntimeOperationOutcome<T>): Promise<R> => {
      if (finalize !== undefined) return finalize(outcome);
      if (outcome.ok) return outcome.value as unknown as R;
      throw outcome.error;
    };
    let release: () => void;
    try {
      this.assertRequestBytes(sizeBytes);
      release = this.admitOperation(session, fairnessKey);
      if (scope !== undefined) {
        this.telemetry.recordSpan({
          operation,
          stage: "admission",
          outcome: "ok",
          ...(functionName === undefined ? {} : { functionName }),
          resource: "operation",
          context: scope.rootContext,
          durationMs: Math.max(0, performance.now() - admittedAt),
          sizeBytes,
        });
      }
    } catch (error) {
      const safeError = transportError(error);
      if (scope !== undefined) {
        const outcome = outcomeFromError(safeError).code;
        this.telemetry.recordSpan({
          operation,
          stage: "admission",
          outcome,
          ...(functionName === undefined ? {} : { functionName }),
          resource: "operation",
          context: scope.rootContext,
          durationMs: Math.max(0, performance.now() - admittedAt),
          sizeBytes,
        });
        this.telemetry.recordEvent({
          name: outcome === "overloaded" ? "overload" : "failure",
          level: outcome === "overloaded" ? "warn" : "error",
          operation,
          stage: "admission",
          outcome,
          ...(functionName === undefined ? {} : { functionName }),
          resource: "operation",
          context: scope.rootContext,
          errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
        });
      }
      const rejected = () => settle({ ok: false, error: safeError });
      return finishOperationTrace(
        scope === undefined ? rejected() : this.runTraced(scope, rejected),
      );
    }
    const startedAt = scope === undefined ? 0 : performance.now();
    const execute = () => Promise.resolve().then(work)
      .then(
        (value): RuntimeOperationOutcome<T> => {
          if (scope !== undefined && synthesizeHandler && scope.invocations.size === 0) {
            this.traceSpan({
              stage: "handler",
              outcome: "ok",
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes,
            }, operation);
          }
          return { ok: true, value };
        },
        (error): RuntimeOperationOutcome<T> => {
          const safeError = transportError(error);
          if (scope !== undefined) {
            const outcome = outcomeFromError(safeError).code;
            if (synthesizeHandler && scope.invocations.size === 0) {
              this.traceSpan({
                stage: "handler",
                outcome,
                durationMs: Math.max(0, performance.now() - startedAt),
                sizeBytes,
              }, operation);
            }
            this.telemetry.recordEvent({
              name: outcome === "overloaded" ? "overload" : "failure",
              level: outcome === "overloaded" ? "warn" : "error",
              operation,
              outcome,
              ...(functionName === undefined ? {} : { functionName }),
              context: this.observationContext(),
              errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
            });
          }
          return { ok: false, error: safeError };
        },
      )
      .finally(release)
      .then(settle);
    return finishOperationTrace(scope === undefined ? execute() : this.runTraced(scope, execute));
  }

  private admitOperation(session: RuntimeSession | null, fairnessKey?: string): () => void {
    this.assertReady();
    const callerOperations = fairnessKey === undefined
      ? 0
      : this.externalOperations.get(fairnessKey) ?? 0;
    if (fairnessKey !== undefined && callerOperations >= this.limits.maxOperationsPerCaller) {
      throw new DbzzError("overloaded", "per-caller operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    if (session !== null && session.activeOperations >= this.limits.maxOperationsPerConnection) {
      throw new DbzzError("overloaded", "per-connection operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    if (this.activeOperations >= this.limits.maxOperations) {
      throw new DbzzError("overloaded", "operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    this.activeOperations++;
    if (session !== null) session.activeOperations++;
    if (fairnessKey !== undefined) this.externalOperations.set(fairnessKey, callerOperations + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeOperations--;
      if (session !== null) session.activeOperations--;
      if (fairnessKey !== undefined) {
        const remaining = this.externalOperations.get(fairnessKey)! - 1;
        if (remaining === 0) this.externalOperations.delete(fairnessKey);
        else this.externalOperations.set(fairnessKey, remaining);
      }
      if (this.activeOperations === 0) {
        for (const resolve of this.activeWaiters) resolve();
        this.activeWaiters.clear();
      }
    };
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.activeWaiters.add(resolve));
  }

  private assertReady(): void {
    if (this.lifecycle === "ready") return;
    if (this.lifecycle === "draining") {
      throw new DbzzError("draining", "runtime is not accepting operations", {
        retryable: true,
        retryAfterMs: DRAIN_RETRY_AFTER_MS,
        resource: "operation",
      });
    }
    throw new DbzzError("unavailable", "runtime is not available", { resource: "operation" });
  }

  private requestBytes(request: unknown): number {
    let bytes: number;
    try {
      bytes = byteLength(request);
    } catch (cause) {
      throw new DbzzError("validation", "request is not wire-representable", { cause });
    }
    this.assertRequestBytes(bytes);
    return bytes;
  }

  private assertRequestBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("request bytes must be a non-negative safe integer");
    }
    if (bytes > this.limits.maxRequestBytes) {
      throw new DbzzError("overloaded", "request exceeds maxRequestBytes", {
        resource: "operation",
      });
    }
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.shutdownController.signal
      : AbortSignal.any([signal, this.shutdownController.signal]);
  }

  private startSampler(): void {
    if (!this.telemetry.enabled) return;
    const interval = this.telemetry.sampleIntervalMs;
    this.expectedSampleAt = performance.now() + interval;
    this.sampleTimer = setInterval(() => this.sample(), interval);
    this.sampleTimer.unref?.();
  }

  private stopSampler(): void {
    if (this.sampleTimer === null) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  private sample(): void {
    if (this.lifecycle !== "ready") return;
    const now = performance.now();
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    const cpu = process.cpuUsage(this.lastCpu);
    const cores = (cpu.user + cpu.system) / (elapsedMs * 1_000);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const eventLoopDrift = Math.max(0, now - this.expectedSampleAt);
    this.expectedSampleAt = now + this.telemetry.sampleIntervalMs;
    const storage = this.engine.status();
    const reactive = this.reactive.snapshot();
    const reader = this.reader.snapshot();
    const writer = this.coordinator.snapshot();
    const publication = this.reactive.publication.snapshot();
    const authCapture = this.authCaptureBudget.snapshot();
    const sse = this.sseBudget.snapshot();
    const telemetry = this.telemetry.snapshot();
    const telemetryDrops = Object.values(telemetry.dropped).reduce((sum, value) => sum + value, 0);
    const metrics: ReadonlyArray<readonly [string, number, "count" | "bytes" | "milliseconds" | "gauge"]> = [
      ["runtime.connections", this.sessions.size, "gauge"],
      ["runtime.operations", this.activeOperations, "gauge"],
      ["runtime.operation_callers", this.externalOperations.size, "gauge"],
      ["runtime.sse_streams", this.sseProducers.size, "gauge"],
      ["runtime.subscriptions", reactive.queryListeners + reactive.eventListeners, "gauge"],
      ["runtime.subscription_entries", reactive.sharedEntries, "gauge"],
      ["runtime.subscription_result_bytes", reactive.resultBytes, "bytes"],
      ["runtime.subscription_history_items", reactive.historyTransitions, "gauge"],
      ["runtime.subscription_history_bytes", reactive.historyBytes, "bytes"],
      ["runtime.read_queue_items", reader.queue.queuedItems, "gauge"],
      ["runtime.read_queue_bytes", reader.queue.queuedBytes, "bytes"],
      ["runtime.read_queue_age", reader.queue.oldestAgeMs, "milliseconds"],
      ["runtime.write_queue_items", writer.queue.queuedItems, "gauge"],
      ["runtime.write_queue_bytes", writer.queue.queuedBytes, "bytes"],
      ["runtime.write_queue_age", writer.queue.oldestAgeMs, "milliseconds"],
      ["runtime.revalidation_active", reactive.revalidation.active, "gauge"],
      ["runtime.revalidation_queue_items", reactive.revalidation.queue.queuedItems, "gauge"],
      ["runtime.revalidation_queue_bytes", reactive.revalidation.queue.queuedBytes, "bytes"],
      ["runtime.revalidation_queue_age", reactive.revalidation.queue.oldestAgeMs, "milliseconds"],
      ["runtime.publication_items", publication.items, "gauge"],
      ["runtime.publication_bytes", publication.bytes, "bytes"],
      ["runtime.publication_age", publication.oldestAgeMs, "milliseconds"],
      ["runtime.auth_capture_bytes", authCapture.bytes, "bytes"],
      ["runtime.sse_outbound_bytes", sse.bytes, "bytes"],
      ["runtime.database_bytes", storage.databaseBytes, "bytes"],
      ["runtime.wal_bytes", storage.walBytes, "bytes"],
      ["runtime.checkpoint_completed", storage.lastCheckpointAtMs === null ? 0 : 1, "gauge"],
      ["runtime.checkpoint_age", storage.lastCheckpointAtMs === null
        ? 0
        : Math.max(0, Date.now() - storage.lastCheckpointAtMs), "milliseconds"],
      ["runtime.recovered_from_crash", storage.recoveredFromCrash ? 1 : 0, "gauge"],
      ["runtime.mutation_replay_records", storage.mutationRecords, "gauge"],
      ["runtime.mutation_replay_bytes", storage.mutationResultBytes, "bytes"],
      ["runtime.telemetry_queue_records", telemetry.queuedRecords, "gauge"],
      ["runtime.telemetry_queue_bytes", telemetry.queuedBytes, "bytes"],
      ["runtime.telemetry_queue_age", telemetry.oldestAgeMs, "milliseconds"],
      ["runtime.telemetry_local_queue_records", telemetry.localSink.pendingRecords, "gauge"],
      ["runtime.telemetry_local_queue_bytes", telemetry.localSink.pendingBytes, "bytes"],
      ["runtime.telemetry_export_attempts", telemetry.exporter.attempts, "count"],
      ["runtime.telemetry_export_failures", telemetry.exporter.failures, "count"],
      ["runtime.telemetry_export_timeouts", telemetry.exporter.timeouts, "count"],
      ["runtime.telemetry_export_duration", telemetry.exporter.lastDurationMs ?? 0, "milliseconds"],
      ["runtime.telemetry_drops", telemetryDrops, "count"],
      ["runtime.rss_bytes", process.memoryUsage().rss, "bytes"],
      ["runtime.cpu_cores", cores, "gauge"],
      ["runtime.event_loop_drift", eventLoopDrift, "milliseconds"],
    ];
    for (const [name, value, unit] of metrics) this.telemetry.recordMetric({ name, value, unit });
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}
