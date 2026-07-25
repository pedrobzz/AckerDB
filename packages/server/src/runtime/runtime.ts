import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import {
  PROTOCOL_VERSION,
  Failure,
  Ok,
  decode,
  encode,
  isApplicationError,
  isResult,
  stableEncode,
  type ApplicationErrorMessage,
  type ErrorMessage,
  type EventMessage,
  type LiveEvent,
  type MutationMessage,
  type MutationOkMessage,
  type Outcome,
  type ProcedureMessage,
  type ProcedureOkMessage,
  type QueryMessage,
  type QueryOkMessage,
  type Result,
  type ResetRequestMessage,
  type SseAckRequest,
  type SubscribeMessage,
  type SubscriptionTransition,
  type TransitionMessage,
  type UnsubscribeMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  verifyUserBearerCredential,
  type CredentialVerifier,
  type ExternalAccount,
  type McpPrincipal,
  type Principal,
} from "../auth/credentials.ts";
import {
  AuthInvalidationBoundary,
  type AuthInvalidationScope,
} from "../auth/invalidation.ts";
import { assertCredentialVerifier } from "../auth/lease.ts";
import { callerFairnessKey, externalAccountFairnessKey, transportSource } from "./caller.ts";
import {
  CommitCoordinator,
  withFetchObserver,
  type CommitHookContext,
  type CommitHookStage,
  type CommitResult,
  type CommitTelemetryEvent,
  type CommitWaitHook,
  type FetchObservation,
} from "./coordinator.ts";
import { isValidationError, type Identity } from "../validation/v.ts";
import {
  makeDbReader,
  type ReadRecorder,
  type WriteCollector,
} from "../database/access.ts";
import type {
  DbStatementObservation,
  DbStatementObserver,
} from "../database/statement-observation.ts";
import {
  BoundedSseProducer,
  FINALIZE_DELIVERY_OBSERVER,
  OutboundBudget,
  type DeliveryObservation,
  type DeliveryObserver,
  type OutboundLane,
  type OutboundReservation,
  type SseDeliverySnapshot,
} from "../realtime/delivery.ts";
import type { Engine } from "../database/engine.ts";
import { DbzzError, isDbzzError, throwIfAborted } from "../shared/errors.ts";
import {
  claimHttpTrace,
  finishClaimedHttpTrace,
  type ClaimedHttpTrace,
} from "../telemetry/external-trace.ts";
import {
  BoundedExecutor,
  type ExecutorSnapshot,
  type ExecutorTaskOptions,
} from "./executor.ts";
import type {
  AnyRegistered,
  AnyRegisteredSse,
  MutationCtx,
  ProcedureCtx,
  QueryCtx,
  SseCtx,
  SseSource,
  TxCtx,
} from "../app/functions.ts";
import {
  authorizeInvocation,
  currentInvocationTelemetryContext,
  invokeFunction,
  poisonCurrentInvocation,
  withInvocationTelemetry,
  type InvocationOutcome,
  type InvocationTelemetryContext,
} from "../app/invocation.ts";
import { withMutationAccess } from "./invocation-state.ts";
import { createMutationInvocationScope } from "./mutation-scope.ts";
import {
  finalizeMcpToolResult,
  type AnyRegisteredMcpTool,
  type McpToolCtx,
} from "../mcp/index.ts";
import {
  bindMcpAiContext,
  mcpLocalGrant,
  withMcpLocalAuthority,
  type McpAiContext,
  type McpAiRuntimeCapability,
} from "../mcp/ai.ts";
import type { McpCallToolResult } from "../mcp/content.ts";
import { parseMcpToken, type ParsedMcpToken } from "../mcp/credential.ts";
import { isMcpToolAuthorized } from "../mcp/scopes.ts";
import { withMcpTokenContext as withMcpTokenCapability } from "../mcp/token-context.ts";
import {
  McpTokenInvalidationBoundary,
  takeMcpTokenInvalidations,
} from "../mcp/token-invalidation.ts";
import { mcpTokenVaultOwner } from "../mcp/token-vault.ts";
import { emitWriteKeys } from "../database/keys.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import { fitOutcome, outcomeFromError, outcomeHttpStatus } from "./outcome.ts";
import {
  PluginRuntime,
  type PluginReadExecution,
  type PluginWriteExecution,
} from "../plugins/runtime.ts";
import { claimHttpRequestProvenance } from "./request-provenance.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type QueryEvaluationInput,
  type ReactiveObservation,
  type ReactiveObserver,
  type Subscriber,
} from "../realtime/reactive.ts";
import type { Registry } from "../app/registry.ts";
import {
  CLAIM_OPERATION_DELIVERY_LEASE,
  FINISH_OPERATION_TRACE,
  OPEN_OPERATION_TRACE,
  OPERATION_INVOCATION_NODE,
  prepareTelemetryTraceContext,
  RECORD_OPERATION_EVENT,
  RECORD_OPERATION_SPAN,
  RELEASE_DELIVERY_LEASE,
  Telemetry,
  type TelemetryAggregateSnapshot,
  type TelemetryEventInput,
  type OperationTraceHandle,
  type PreparedTelemetryTraceContext,
  type TelemetryOperation,
  type TelemetryOptions,
  type TelemetryOutcome,
  type TelemetryResource,
  type TelemetrySnapshot,
  type TelemetryStage,
  type TelemetryTraceContext,
} from "../telemetry/telemetry.ts";
import {
  claimRuntimeRequestBytes,
  prepareRuntimePublication,
  type RuntimeAuthTransition,
  type RuntimeMutationResult,
  type RuntimePort,
  type RuntimePublication,
  type RuntimePublicationBatch,
  type RuntimeRequest,
  type SessionApplicationMessage,
  type SessionRuntimeContext,
} from "../realtime/session.ts";

const utf8 = new TextEncoder();
const SCHEDULER_RETRY_MS = 1_000;
const STALE_SCHEDULED_CANDIDATE = Symbol("staleScheduledCandidate");
const DIRECT_RUNTIME_SOURCE = transportSource({ family: "runtime", address: "local" });
/** Package-private transport hook; intentionally absent from the public index. */
export const CAPTURE_DELIVERY_OBSERVER = Symbol("dbzz.captureDeliveryObserver");

function applicationError(value: unknown) {
  if (!isApplicationError(value)) {
    throw new DbzzError("internal", "registered Err contains no application error");
  }
  return value;
}

function restoreMutationResult(value: unknown): Result<unknown, unknown> {
  if (isResult(value)) return value;
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new DbzzError("internal", "stored mutation result has no Result shape");
  }
  if (value.ok === true && "data" in value) return Ok(value.data);
  if (value.ok === false && "error" in value && isApplicationError(value.error)) {
    return Failure(value.error);
  }
  throw new DbzzError("internal", "stored mutation Result is invalid");
}

export type RuntimeLifecycleState = "ready" | "draining" | "stopped" | "failed";

export type RuntimeHookStage = CommitHookStage;
export type RuntimeHookContext = CommitHookContext;

/** Optional semantic gates for deterministic fault tests; failures are fail-open. */
export interface RuntimeHooks {
  /** Runs after the named stage completes while its owning state machine is still paused. */
  readonly wait?: CommitWaitHook;
}

const DRAIN_RETRY_AFTER_MS = 1_000;
/** Individually retained non-ok delivery observations per summary key per sampler interval. */
const DELIVERY_FAILURE_EXEMPLARS_PER_INTERVAL = 8;
/** Early flush bound so an unsampled storm cannot defer its summary indefinitely. */
const DELIVERY_FAILURE_SUMMARY_FLUSH_THRESHOLD = 4_096;

interface DeliveryFailureSummary {
  readonly operation: TelemetryOperation;
  readonly stage: TelemetryStage;
  readonly outcome: TelemetryOutcome;
  readonly resource: TelemetryResource;
  exemplars: number;
  summarized: number;
}

export interface RuntimeOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  /** A started Plugin graph bound to this Engine's reconciled private scopes. */
  readonly pluginRuntime?: PluginRuntime;
  readonly verifier?: CredentialVerifier;
  readonly limits?: ServiceLimits;
  readonly telemetry?: Telemetry | TelemetryOptions | false;
  readonly hooks?: RuntimeHooks;
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

export interface RuntimeMcpToolRequest {
  readonly id: string | number;
  readonly mcp: string;
  readonly tool: string;
  readonly args: unknown;
  readonly principal: Principal;
  readonly signal?: AbortSignal;
  readonly fairnessKey?: string;
}

export interface McpCredentialLease {
  readonly principal: McpPrincipal;
  readonly signal: AbortSignal;
  release(): void;
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

export interface RuntimeSseResponse {
  readonly stream: ReadableStream<Uint8Array>;
  readonly streamId: string;
}

interface OwnedProcedureContext {
  readonly value: ProcedureCtx;
  readonly release: () => void;
}

interface ProcedureInvalidations {
  publish(account: ExternalAccount): void;
  finish(): void;
}

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
  readonly telemetryAggregates: TelemetryAggregateSnapshot;
  readonly storage: ReturnType<Engine["status"]>;
}

interface ReactiveContext {
  readonly principal: Principal;
}

interface QueryExecution<T = unknown> {
  readonly value: T;
  readonly readSet: ReadonlySet<string>;
  readonly commitVersion: bigint;
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
  readonly contexts: WeakSet<SessionRuntimeContext>;
  subscriber: Subscriber;
  readonly telemetryConnectionId?: string;
  readonly subscriptionControlTails: Map<number, Promise<void>>;
  subscriptionControlFrontier: Promise<void>;
  pendingSubscriptionControls: number;
  capture: AuthTransitionCapture | null;
  phase: "open" | "closing" | "removed";
  closeDrain: Deferred<void> | null;
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

type SessionOperationOrder =
  | { readonly kind: "subscription-control"; readonly id: number }
  | { readonly kind: "subscription-frontier" };

interface OperationAdmission {
  readonly predecessor: Promise<void> | undefined;
  release(): void;
}

interface RunOperationOptions<T, R> {
  readonly identifiers?: TraceIdentifiers;
  readonly synthesizeHandler?: boolean;
  readonly finalize?: RuntimeOperationFinalizer<T, R>;
  readonly claimedTrace?: ClaimedHttpTrace;
  readonly fairnessKey?: string;
  readonly sessionOrder?: SessionOperationOrder;
}

interface FinishedRuntimeMutation {
  readonly result: RuntimeMutationResult;
  readonly publication: RuntimePublication;
}

interface SessionOperationOptions<T> {
  readonly identifiers?: TraceIdentifiers;
  readonly synthesizeHandler?: boolean;
  readonly successPublication?: (value: T) => RuntimePublication;
}

interface RuntimeTraceScope {
  readonly operation: TelemetryOperation;
  readonly rootFunction?: string;
  readonly trace: OperationTraceHandle;
  invocations: number;
}

interface DetachedDeliveryTrace {
  readonly operation: TelemetryOperation;
  readonly context: PreparedTelemetryTraceContext;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const releaseNothing = (): void => {};

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

function convergenceError(message: string): DbzzError {
  return new DbzzError("convergence_unavailable", message, { committed: true });
}

function transportError(error: unknown): unknown {
  return isValidationError(error)
    ? new DbzzError("validation", error.message, { cause: error })
    : error;
}

interface SseChunkIterator {
  next(): Promise<IteratorResult<unknown, unknown>>;
  /** Returns/cancels the handler's source so its cleanup runs exactly once. */
  release(reason?: unknown): Promise<unknown>;
}

function sseChunkIterator(source: SseSource<unknown>): SseChunkIterator {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    return {
      next: async () => {
        const part = await reader.read();
        return part.done ? { done: true, value: undefined } : { done: false, value: part.value };
      },
      release: (reason) => reader.cancel(reason),
    };
  }
  if (
    (typeof source === "object" || typeof source === "function") &&
    source !== null &&
    Symbol.asyncIterator in source
  ) {
    const iterator = source[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      release: (reason) =>
        iterator.return === undefined ? Promise.resolve() : iterator.return(reason),
    };
  }
  throw new DbzzError("internal", "sse handler must return a ReadableStream or async iterable");
}

/**
 * Adapts the handler's returned source into the producer's merge input.
 * Zero high-water: the source advances only when the receiver-credited merge
 * loop asks for the next chunk, so downstream acknowledgement drives the
 * handler. Every chunk is validated against the declared `yields` validator;
 * a failing chunk releases the source and fails the stream with the exact
 * validation error. `handlerContext` restores the invocation-time async
 * context, so generator bodies keep the handler's trace/invocation ownership.
 */
function validatedSseSource(
  fn: AnyRegisteredSse,
  source: SseSource<unknown>,
  handlerContext: <T>(work: () => T) => T,
): ReadableStream<unknown> {
  const iterator = handlerContext(() => sseChunkIterator(source));
  return new ReadableStream<unknown>(
    {
      pull: async (controller) => {
        const part = await handlerContext(() => iterator.next());
        if (part.done === true) {
          controller.close();
          return;
        }
        let chunk: unknown;
        try {
          chunk = fn.yields.check(part.value, "chunk");
        } catch (error) {
          // The source's own cleanup failures cannot mask the validation error.
          void Promise.resolve()
            .then(() => handlerContext(() => iterator.release(error)))
            .catch(() => {});
          throw transportError(error);
        }
        controller.enqueue(chunk);
      },
      cancel: async (reason) => {
        await handlerContext(() => iterator.release(reason));
      },
    },
    { highWaterMark: 0 },
  );
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
  readonly credentialVerifier: CredentialVerifier | undefined;
  readonly limits: ServiceLimits;
  readonly telemetry: Telemetry;
  readonly reactive: OrderedReactive<ReactiveContext>;
  readonly deliveryObserver: DeliveryObserver = (observation): void => {
    const ambient = this.trace.getStore();
    if (ambient !== undefined) {
      this.observeDelivery(
        ambient,
        this.invocationNode(ambient, currentInvocationTelemetryContext()),
        observation,
      );
      return;
    }
    this.observeDelivery({
      operation: observation.transport === "sse" ? "sse" : "subscription",
      context: prepareTelemetryTraceContext(),
    }, 0, observation);
  };

  private observeDelivery(
    trace: RuntimeTraceScope | DetachedDeliveryTrace,
    parentNode: number,
    observation: DeliveryObservation,
  ): void {
    const outcome: TelemetryOutcome = observation.outcome === "dropped"
      ? "unavailable"
      : observation.outcome;
    const fallbackOperation: TelemetryOperation = observation.transport === "sse"
      ? "sse"
      : "subscription";
    const resource: TelemetryResource = observation.transport === "sse" ? "sse" : "outbound";
    if (observation.droppedObservations !== undefined) {
      this.telemetry.recordMetric({
        name: "delivery.observations_dropped",
        value: observation.droppedObservations,
        unit: "count",
        labels: { operation: fallbackOperation, resource },
      });
    }
    // Mass disconnect and fanout backpressure can fail thousands of queued
    // frames inside one event-loop turn. Per-frame failure records at that
    // rate carry no more signal than a count and can outrun any bounded
    // asynchronous exporter, so beyond a per-interval exemplar budget the
    // remainder is summarized into delivery.failures_coalesced instead of
    // being individually retained. A successfully encoded terminal error
    // frame reports outcome "ok" while carrying the actual failure in
    // terminalOutcome, so that shape budgets by the terminal outcome.
    const terminalFailure = observation.source === "terminal" &&
      observation.stage === "encoding" &&
      observation.terminalOutcome !== undefined;
    const failureOutcome: TelemetryOutcome | undefined = outcome !== "ok"
      ? outcome
      : terminalFailure
        ? observation.terminalOutcome
        : undefined;
    let summarizedFailure = false;
    if (failureOutcome !== undefined && this.telemetry.enabled) {
      const operation = trace.operation;
      const key = `${operation}|${observation.stage}|${failureOutcome}|${resource}`;
      let summary = this.deliveryFailureSummaries.get(key);
      if (summary === undefined) {
        summary = {
          operation,
          stage: observation.stage,
          outcome: failureOutcome,
          resource,
          exemplars: 0,
          summarized: 0,
        };
        this.deliveryFailureSummaries.set(key, summary);
      }
      if (summary.exemplars >= DELIVERY_FAILURE_EXEMPLARS_PER_INTERVAL) {
        summarizedFailure = true;
        summary.summarized++;
        if (summary.summarized >= DELIVERY_FAILURE_SUMMARY_FLUSH_THRESHOLD) {
          this.flushDeliveryFailureSummary(summary);
        }
      } else {
        summary.exemplars++;
      }
    }
    // A summarized observation emits no span at all: even its ok-outcome
    // encoding span would be individually retained under slowOperationMs 0
    // or once an exemplar failure event has promoted the ambient trace,
    // which would reopen the storm this budget exists to bound.
    if (!summarizedFailure) {
      const span = {
        stage: observation.stage,
        outcome,
        resource,
        durationMs: observation.durationMs,
        sizeBytes: observation.bytes,
      } as const;
      if ("trace" in trace) {
        this.traceSpan(span, fallbackOperation, trace, parentNode);
      } else {
        this.telemetry.recordSpan({
          ...span,
          operation: trace.operation,
          context: trace.context,
        });
      }
    }
    if (terminalFailure && !summarizedFailure) {
      const event = {
        name: "failure",
        level: "error",
        operation: trace.operation,
        stage: "delivery",
        outcome: observation.terminalOutcome,
        resource,
      } as const;
      if ("trace" in trace) {
        this.traceEvent(event, trace, parentNode);
      } else {
        this.telemetry.recordEvent({ ...event, context: trace.context });
      }
    }
  }

  private readonly now: () => number;
  private readonly pluginRuntime: PluginRuntime | undefined;
  private readonly authInvalidation: AuthInvalidationBoundary;
  private readonly immediateProcedureInvalidations: ProcedureInvalidations;
  private readonly mcpTokenInvalidation = new McpTokenInvalidationBoundary();
  private readonly reader: BoundedExecutor;
  private readonly availableReaders: Database[];
  private readonly coordinator: CommitCoordinator<ReactiveCommit>;
  private readonly scheduled: Map<string, string>;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly authCaptureBudget: OutboundBudget;
  private readonly sseBudget: OutboundBudget;
  private readonly sseProducers = new Map<string, BoundedSseProducer>();
  private readonly externalOperations = new Map<string, number>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly deliveryFailureSummaries = new Map<string, DeliveryFailureSummary>();
  private readonly trace = new AsyncLocalStorage<RuntimeTraceScope>();
  private readonly ownsTelemetry: boolean;
  private readonly hasMcpCapabilities: boolean;
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
    if (options.pluginRuntime !== undefined && options.pluginRuntime.state !== "ready") {
      throw new TypeError("Runtime requires a ready Plugin runtime");
    }
    this.pluginRuntime = options.pluginRuntime;
    this.hasMcpCapabilities = this.registry.mcps.size > 0;
    this.limits = options.limits === undefined ? PRODUCTION_LIMITS : defineServiceLimits(options.limits);
    const mcpToolCounts = new Map<string, number>();
    for (const tool of this.registry.mcpTools.values()) {
      const count = (mcpToolCounts.get(tool.mcp.name) ?? 0) + 1;
      if (count > this.limits.mcp.maxToolsPerEndpoint) {
        throw new RangeError(
          `MCP "${tool.mcp.name}" exceeds mcp.maxToolsPerEndpoint`,
        );
      }
      mcpToolCounts.set(tool.mcp.name, count);
    }
    if (options.verifier !== undefined) {
      assertCredentialVerifier(options.verifier, this.limits.auth.revocationDeadlineMs);
    }
    this.authInvalidation = new AuthInvalidationBoundary(options.verifier);
    this.immediateProcedureInvalidations = Object.freeze({
      publish: (account: ExternalAccount): void => {
        this.authInvalidation.publishAccount(account);
      },
      finish: (): void => {},
    });
    this.credentialVerifier = this.authInvalidation.verifier;
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
      ...(this.hasMcpCapabilities
        ? {
            afterCommit: (writes: WriteCollector) => {
              for (const invalidation of takeMcpTokenInvalidations(writes)) {
                this.mcpTokenInvalidation.publish(invalidation);
              }
            },
          }
        : {}),
      ...(options.hooks?.wait === undefined ? {} : { wait: options.hooks.wait }),
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

  async resolveIdentity(
    account: ExternalAccount,
    signal?: AbortSignal,
  ): Promise<Identity> {
    const requestBytes = this.admittedRequestBytes(account);
    const operationSignal = this.operationSignal(signal);
    const fairnessKey = externalAccountFairnessKey(account);
    return this.runOperation(
      null,
      "transaction",
      undefined,
      requestBytes,
      async () => {
        const existing = await this.submitRead(
          (connection) => this.engine.identityForAccount(
            connection,
            account.issuer,
            account.subject,
          ),
          {
            operation: "transaction",
            bytes: requestBytes,
            fairnessKey,
            signal: operationSignal,
          },
          false,
        );
        if (existing !== null) return existing;
        return this.coordinator.transactFramework({
          fairnessKey,
          requestBytes,
          admissionSignal: operationSignal,
          transactionSignal: operationSignal,
          work: () => this.engine.resolveIdentity(account.issuer, account.subject),
        });
      },
      { synthesizeHandler: false, fairnessKey },
    );
  }

  /** Resolve one endpoint-bound MCP bearer without consulting external identity providers. */
  async authenticateMcpToken(
    mcp: string,
    rawToken: string,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<McpPrincipal> {
    const parsed = parseMcpToken(rawToken);
    if (parsed === null) throw new DbzzError("unauthenticated", "invalid MCP credential");
    const operationSignal = this.operationSignal(signal);
    return this.verifyMcpToken(mcp, parsed, fairnessKey, operationSignal);
  }

  /** Own one exact non-expiring MCP credential from verification through HTTP completion. */
  async acquireMcpTokenLease(
    mcp: string,
    parsed: ParsedMcpToken,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<McpCredentialLease> {
    this.assertReady();
    const controller = new AbortController();
    const unsubscribe = this.mcpTokenInvalidation.subscribe(mcp, parsed.id, () => {
      if (!controller.signal.aborted) {
        controller.abort(new DbzzError("unauthenticated", "credential revoked"));
      }
    });
    const leaseSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    const verificationSignal = this.operationSignal(leaseSignal);
    try {
      const principal = await this.verifyMcpToken(mcp, parsed, fairnessKey, verificationSignal);
      throwIfAborted(verificationSignal);
      let active = true;
      return Object.freeze({
        principal,
        signal: leaseSignal,
        release: () => {
          if (!active) return;
          active = false;
          unsubscribe();
        },
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async verifyMcpToken(
    mcp: string,
    parsed: ParsedMcpToken,
    fairnessKey: string,
    signal: AbortSignal,
  ): Promise<McpPrincipal> {
    this.assertReady();
    const declaration = this.registry.mcps.get(mcp);
    if (declaration === undefined) throw new DbzzError("not_found", `unknown MCP "${mcp}"`);
    const scopeDescriptor = "scopes" in declaration ? declaration.scopes : undefined;
    const credential = await this.submitRead(
      (connection) => this.engine[mcpTokenVaultOwner].authenticate(
        connection,
        mcp,
        parsed,
        scopeDescriptor,
      ),
      {
        operation: "procedure",
        bytes: parsed.bytes,
        fairnessKey,
        signal,
      },
      false,
    );
    throwIfAborted(signal);
    return Object.freeze({
      kind: "mcp",
      identity: credential.identity,
      mcp,
      tokenId: credential.tokenId,
      scopes: credential.scopes,
    });
  }

  private async linkAccount(
    principal: Principal,
    rawBearerToken: string,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): Promise<void> {
    if (principal.kind !== "user") {
      throw new DbzzError("unauthorized", "account linking requires a user identity");
    }
    throwIfAborted(signal);
    const account = await verifyUserBearerCredential(
      rawBearerToken,
      this.credentialVerifier,
      this.now,
    );
    throwIfAborted(signal);
    await this.coordinator.transactFramework({
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work: () => {
        if (account.expiresAt <= this.readNow()) {
          throw new DbzzError("unauthenticated", "invalid credential");
        }
        if (!this.engine.attachIdentityAccount(
          principal.identity,
          account.issuer,
          account.subject,
        )) {
          throw new DbzzError("conflict", "external account is already linked");
        }
      },
    });
  }

  private async unlinkAccount(
    principal: Principal,
    candidate: ExternalAccount,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    accountUnlinked: (account: ExternalAccount) => void,
  ): Promise<void> {
    if (principal.kind !== "user") {
      throw new DbzzError("unauthorized", "account unlinking requires ownership");
    }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.issuer !== "string" ||
      candidate.issuer.length === 0 ||
      typeof candidate.subject !== "string" ||
      candidate.subject.length === 0
    ) {
      throw new DbzzError("validation", "external account must have an issuer and subject");
    }
    const account = Object.freeze({ issuer: candidate.issuer, subject: candidate.subject });
    throwIfAborted(signal);
    const result = await this.coordinator.transactFramework({
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work: () => this.engine.detachIdentityAccount(
        principal.identity,
        account.issuer,
        account.subject,
      ),
      afterCommit: (committed) => {
        if (committed === "removed") accountUnlinked(account);
      },
    });
    if (result === "not_owned") {
      throw new DbzzError("unauthorized", "account unlinking requires ownership");
    }
    if (result === "last_account") {
      throw new DbzzError("conflict", "cannot unlink the final external account");
    }
  }

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.assertReady();
    if (context.authEpoch !== 0) throw new DbzzError("validation", "new sessions must start at auth epoch 0");
    if (context.principal.kind === "system" || context.principal.kind === "mcp") {
      throw new DbzzError("unauthorized", "principal cannot authenticate the DBZZ client API");
    }
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
      contexts: new WeakSet([context]),
      subscriber,
      ...(this.telemetry.enabled
        ? { telemetryConnectionId: digest(context.clientSessionId) }
        : {}),
      subscriptionControlTails: new Map(),
      subscriptionControlFrontier: Promise.resolve(),
      pendingSubscriptionControls: 0,
      capture: null,
      phase: "open",
      closeDrain: null,
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
      throwIfAborted(transition.to.signal);
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
        state.contexts.add(transition.to);
        state.context = transition.to;
        state.subscriber = this.makeSubscriber(() => state, transition.to.authEpoch);
        captured.phase = "reattaching";
        captured.authEpoch = transition.to.authEpoch;
        for (const definition of rotation.subscriptions) {
          try {
            await this.attachSubscription(
              state,
              definition.id,
              definition.address,
              definition.args,
            );
          } catch (error) {
            this.captureFrame(captured, this.prepareFrame({
              v: PROTOCOL_VERSION,
              t: "err",
              id: definition.id,
              outcome: outcomeFromError(transportError(error)),
            }, "subscription frame", "subscription"));
          }
        }
        return this.finishCapture(captured);
      } catch (error) {
        // A failed transition is terminal, but ownership stays attached until
        // this and every other already-admitted operation have finalized.
        void this.startSessionClose(state);
        throw error;
      } finally {
        if (state.capture === captured) state.capture = null;
        this.releaseCapture(captured);
      }
    }, {
      fairnessKey: transition.from.fairnessKey,
      sessionOrder: { kind: "subscription-frontier" },
    });
  }

  async subscribe(context: SessionRuntimeContext, request: RuntimeRequest<SubscribeMessage>): Promise<void> {
    const { message } = request;
    await this.runSessionOperation(context, request, "subscription", message.ref, async (state) => {
      await this.attachSubscription(
        state,
        message.id,
        message.ref,
        snapshotValue(message.args),
        message.cursor === undefined ? undefined : Object.freeze({ ...message.cursor }),
      );
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async unsubscribe(context: SessionRuntimeContext, request: RuntimeRequest<UnsubscribeMessage>): Promise<void> {
    const { message } = request;
    await this.runSessionOperation(context, request, "subscription", undefined, (state) => {
      this.reactive.unsubscribe(state.subscriber, message.id);
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async reset(context: SessionRuntimeContext, request: RuntimeRequest<ResetRequestMessage>): Promise<void> {
    const { message } = request;
    await this.runSessionOperation(context, request, "subscription", undefined, (state) =>
      this.reactive.reset(state.subscriber, message.id, message.cursor), {
        identifiers: {
          requestId: String(message.id),
          subscriptionId: String(message.id),
        },
      });
  }

  async query(context: SessionRuntimeContext, request: RuntimeRequest<QueryMessage>): Promise<unknown> {
    const { message } = request;
    let publication: RuntimePublication | undefined;
    return this.runSessionOperation(context, request, "query", message.ref, async (_state, requestBytes) => {
      const signal = this.operationSignal(context.signal);
      const result = await this.executeQuery(
        message.ref,
        message.args,
        context.principal,
        context.fairnessKey,
        signal,
        requestBytes,
      );
      if (!isResult(result)) throw new DbzzError("internal", "query boundary returned no Result");
      publication = this.prepareFrame(
        result.ok
          ? {
              v: PROTOCOL_VERSION,
              t: "ok",
              id: message.id,
              kind: "query",
              value: result.data,
            } satisfies QueryOkMessage
          : {
              v: PROTOCOL_VERSION,
              t: "app_err",
              id: message.id,
              kind: "query",
              error: applicationError(result.error),
            } satisfies ApplicationErrorMessage,
        "query result",
      );
      return result.ok ? result.data : result;
    }, {
      identifiers: { requestId: String(message.id) },
      successPublication: () => {
        if (publication === undefined) throw new Error("query publication was not prepared");
        return publication;
      },
    });
  }

  async procedure(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ProcedureMessage>,
  ): Promise<unknown> {
    const { message } = request;
    let publication: RuntimePublication | undefined;
    const invalidations = this.procedureInvalidations(
      context.principal,
      context.invalidationScope,
    );
    try {
      return await this.runSessionOperation(context, request, "procedure", message.ref, async (_state, requestBytes) => {
        const fn = this.expect(message.ref, "procedure");
        const signal = this.operationSignal(request.signal ?? context.signal);
        throwIfAborted(signal);
        const procedure = this.procedureContext(
          context.principal,
          context.fairnessKey,
          signal,
          requestBytes,
          this.readNow(),
          invalidations.publish,
        );
        try {
          let handlerStarted = false;
          const result = await invokeFunction(fn, procedure.value, message.args, {
            onAuthorized: () => {
              throwIfAborted(signal);
              handlerStarted = true;
            },
          }).catch((cause) => {
            if (!handlerStarted || !signal.aborted) throw cause;
            throw new DbzzError(
              "indeterminate",
              "procedure completion is unknown after cancellation",
              { resource: "operation", cause },
            );
          });
          if (signal.aborted) {
            throw new DbzzError(
              "indeterminate",
              "procedure completion is unknown after cancellation",
              { resource: "operation", cause: signal.reason },
            );
          }
          if (!isResult(result)) throw new DbzzError("internal", "procedure boundary returned no Result");
          publication = this.prepareFrame(
            result.ok
              ? {
                  v: PROTOCOL_VERSION,
                  t: "ok",
                  id: message.id,
                  kind: "procedure",
                  value: result.data,
                } satisfies ProcedureOkMessage
              : {
                  v: PROTOCOL_VERSION,
                  t: "app_err",
                  id: message.id,
                  kind: "procedure",
                  error: applicationError(result.error),
                } satisfies ApplicationErrorMessage,
            "procedure result",
          );
          return result.ok ? result.data : result;
        } finally {
          procedure.release();
        }
      }, {
        identifiers: { requestId: String(message.id) },
        successPublication: () => {
          if (publication === undefined) throw new Error("procedure publication was not prepared");
          return publication;
        },
      });
    } finally {
      invalidations.finish();
    }
  }

  async mutation(context: SessionRuntimeContext, request: RuntimeRequest<MutationMessage>): Promise<RuntimeMutationResult> {
    const { message } = request;
    let successPublication: RuntimePublication | undefined;
    return this.runSessionOperation(context, request, "mutation", message.ref, async (state, requestBytes) => {
      const fn = this.expect(message.ref, "mutation");
      const signal = this.operationSignal(context.signal);
      let scheduledTouched = false;
      let executedPublication: RuntimePublication | undefined;
      const result = await this.coordinator.execute({
        operation: "mutation",
        fairnessKey: context.fairnessKey,
        requestBytes,
        admissionSignal: signal,
        ...(this.telemetry.enabled
          ? {
              telemetry: this.observeCommit,
              statementTelemetry: this.observeStatement,
              run: AsyncLocalStorage.snapshot(),
            }
          : {}),
        idempotency: {
          sessionId: context.clientSessionId,
          requestId: message.mutationRequestId,
          issuedAt: message.issuedAt,
          principalFingerprint: digest(context.principal),
          functionRef: message.ref,
          argsFingerprint: digest(message.args),
        },
        work: (db, writes) => {
          const invocation = this.hostMutationContext(
            db,
            context.principal,
            this.readNow(),
            writes,
          );
          const scope = createMutationInvocationScope(this.engine.writer, writes);
          return scope.runRoot((mutationAccess) =>
            this.hasMcpCapabilities
              ? withMcpTokenCapability(
                  invocation,
                  this.mcpTokenCapability(context.principal, this.engine.writer, null, writes),
                  (ctx) => invokeFunction(fn, ctx, message.args, {
                    mutationAccess,
                  }),
                )
              : invokeFunction(fn, invocation, message.args, {
                  mutationAccess,
                }));
        },
        rollbackWhen: (value) => isResult(value) && !value.ok,
        publication: (_version, writes) => {
          scheduledTouched = writes.scheduledTouched;
          return this.publicationFor(writes, state.subscriber);
        },
        validate: (value, version, _writes, publication) => {
          executedPublication = this.prepareFrame(
            this.mutationFrame(
              message,
              value,
              version,
              this.engine.durability,
              "executed",
              publication.affectedCallerIds,
            ),
            "mutation result",
          );
        },
      });
      if (scheduledTouched) this.armScheduler();
      const finished = await this.finishMutation(state, message, result, executedPublication);
      successPublication = finished.publication;
      return finished.result;
    }, {
      identifiers: {
        requestId: String(message.id),
        mutationId: message.mutationRequestId,
      },
      synthesizeHandler: false,
      successPublication: () => {
        if (successPublication === undefined) throw new Error("mutation publication was not prepared");
        return successPublication;
      },
    });
  }

  async closeSession(context: SessionRuntimeContext, _outcome: Outcome): Promise<void> {
    const state = this.sessions.get(context.clientSessionId);
    if (state === undefined || !state.contexts.has(context)) return;
    await this.startSessionClose(state);
  }

  private startSessionClose(state: RuntimeSession): Promise<void> {
    if (state.phase === "removed") return Promise.resolve();
    if (state.phase === "closing") return state.closeDrain?.promise ?? Promise.resolve();
    state.phase = "closing";
    if (state.activeOperations === 0) {
      this.removeSession(state);
      return Promise.resolve();
    }
    const drain = deferred<void>();
    state.closeDrain = drain;
    return drain.promise;
  }

  private removeSession(state: RuntimeSession): void {
    if (state.phase === "removed") return;
    state.phase = "removed";
    const capture = state.capture;
    state.capture = null;
    if (capture !== null) this.releaseCapture(capture);
    this.reactive.disconnect(state.subscriber);
    if (this.sessions.get(state.context.clientSessionId) === state) {
      this.sessions.delete(state.context.clientSessionId);
      this.telemetry.recordMetric({ name: "runtime.connections", value: this.sessions.size, unit: "gauge" });
    }
    const drain = state.closeDrain;
    state.closeDrain = null;
    drain?.resolve(undefined);
  }

  async runProcedure(request: RuntimeProcedureRequest): Promise<Response> {
    if (request.principal.kind === "mcp") {
      throw new DbzzError("unauthorized", "MCP credentials cannot call DBZZ procedures");
    }
    const provenance = claimHttpRequestProvenance(request);
    const requestBytes = this.admittedRequestBytes({
      v: PROTOCOL_VERSION,
      t: "call",
      id: request.id,
      ref: request.address,
      args: request.args,
    }, provenance?.bytes);
    const claimedTrace = claimHttpTrace(
      provenance?.trace,
      "procedure",
      request.address,
      String(request.id),
    );
    const fairnessKey = request.fairnessKey ?? callerFairnessKey(
      request.principal,
      DIRECT_RUNTIME_SOURCE,
    );
    const invalidations = this.procedureInvalidations(
      request.principal,
      provenance?.invalidationScope,
    );
    return this.runOperation(null, "procedure", request.address, requestBytes, async () => {
      const fn = this.expect(request.address, "procedure");
      const signal = this.operationSignal(request.signal);
      throwIfAborted(signal);
      const context = this.procedureContext(
        request.principal,
        fairnessKey,
        signal,
        requestBytes,
        this.readNow(),
        invalidations.publish,
      );
      try {
        const value = await invokeFunction(fn, context.value, request.args);
        throwIfAborted(signal);
        return value;
      } finally {
        context.release();
      }
    }, {
      identifiers: { requestId: String(request.id) },
      finalize: (outcome) => {
        try {
          return this.respondProcedure(request, outcome);
        } finally {
          invalidations.finish();
        }
      },
      claimedTrace,
      fairnessKey,
    });
  }

  /** The single deep MCP execution path used by every present and future adapter. */
  async runMcpTool(request: RuntimeMcpToolRequest): Promise<McpCallToolResult> {
    const provenance = claimHttpRequestProvenance(request);
    const requestBytes = this.admittedRequestBytes({
      jsonrpc: "2.0",
      id: request.id,
      method: "tools/call",
      params: { name: request.tool, arguments: request.args },
    }, provenance?.bytes);
    const registeredTool = this.registry.mcpTool(request.mcp, request.tool);
    const functionName = registeredTool === undefined
      ? "mcp.unknown"
      : `${registeredTool.mcp.name}:${registeredTool.name}`;
    const claimedTrace = claimHttpTrace(
      provenance?.trace,
      "procedure",
      functionName,
      String(request.id),
    );
    const fairnessKey = request.fairnessKey ?? callerFairnessKey(
      request.principal,
      DIRECT_RUNTIME_SOURCE,
    );
    return this.runOperation(null, "procedure", functionName, requestBytes, async () => {
      const signal = this.operationSignal(request.signal);
      return this.dispatchMcpTool(
        request.mcp,
        request.tool,
        request.args,
        this.transactionalContext(
          request.principal,
          fairnessKey,
          signal,
          requestBytes,
          this.readNow(),
        ),
        fairnessKey,
        requestBytes,
      );
    }, {
      identifiers: { requestId: String(request.id) },
      claimedTrace,
      fairnessKey,
    });
  }

  /** Resolve one callable tool without trusting discovery or revealing inaccessible names. */
  authorizeMcpTool(mcp: string, name: string, principal: Principal): AnyRegisteredMcpTool {
    const endpointMatches = principal.kind !== "mcp" || principal.mcp === mcp;
    const tool = endpointMatches ? this.registry.mcpTool(mcp, name) : undefined;
    if (
      tool !== undefined &&
      isMcpToolAuthorized(
        tool.accessPolicy,
        principal,
        mcpLocalGrant(principal, tool.mcp),
      )
    ) return tool;
    if (principal.kind === "anonymous") {
      throw new DbzzError("unauthenticated", "authentication required");
    }
    if (!endpointMatches || tool !== undefined) {
      throw new DbzzError("unauthorized", "access denied");
    }
    throw new DbzzError("not_found", "MCP tool not found");
  }

  private async dispatchMcpTool(
    mcp: string,
    name: string,
    args: unknown,
    context: McpToolCtx & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): Promise<McpCallToolResult> {
    const toolContext = Object.freeze({
      auth: context.auth,
      abortSignal: context.abortSignal,
      timestamp: context.timestamp,
      tx: context.tx,
    });
    const release = bindMcpAiContext(
      toolContext,
      this.mcpAiCapability(toolContext, fairnessKey, requestBytes),
    );
    try {
      const tool = this.authorizeMcpTool(mcp, name, toolContext.auth);
      throwIfAborted(toolContext.abortSignal);
      const value = await invokeFunction(tool, toolContext, args);
      throwIfAborted(toolContext.abortSignal);
      const result = finalizeMcpToolResult(tool, value);
      throwIfAborted(toolContext.abortSignal);
      return result;
    } finally {
      release();
    }
  }

  private respondProcedure(
    request: RuntimeProcedureRequest,
    outcome: RuntimeOperationOutcome<unknown>,
  ): Response {
    let frame: ProcedureOkMessage | ApplicationErrorMessage | ErrorMessage;
    let status: number;
    if (outcome.ok) {
      if (!isResult(outcome.value)) {
        throw new DbzzError("internal", "procedure boundary returned no Result");
      }
      if (outcome.value.ok) {
        frame = {
          v: PROTOCOL_VERSION,
          t: "ok",
          id: request.id,
          kind: "procedure",
          value: outcome.value.data,
        };
        status = 200;
      } else {
        frame = {
          v: PROTOCOL_VERSION,
          t: "app_err",
          id: request.id,
          kind: "procedure",
          error: applicationError(outcome.value.error),
        };
        status = frame.error.status;
      }
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
    frame: ProcedureOkMessage | ApplicationErrorMessage | ErrorMessage,
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
    const fitted = fitOutcome(frame.outcome, this.limits.maxFrameBytes, (outcome) => {
      const value = encode({
        ...frame,
        outcome,
      } satisfies ErrorMessage);
      return { value, bytes: utf8.encode(value).byteLength };
    });
    if (fitted === null) {
      throw new DbzzError("overloaded", "procedure error response exceeds maxFrameBytes", {
        resource: "operation",
      });
    }
    return { body: fitted.value, bytes: fitted.bytes };
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
    const invocation = currentInvocationTelemetryContext();
    const functionName = invocation === undefined
      ? scope?.rootFunction
      : this.registry.invocationNameOf(invocation.fn) ?? scope?.rootFunction;
    this.traceEvent({
      name: "failure",
      level: "error",
      operation: "procedure",
      stage,
      outcome: outcomeFromError(error).code,
      ...(functionName === undefined ? {} : { functionName }),
      resource: "operation",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  }

  async runSse(request: RuntimeSseRequest): Promise<RuntimeSseResponse> {
    if (request.principal.kind === "mcp") {
      throw new DbzzError("unauthorized", "MCP credentials cannot call DBZZ SSE procedures");
    }
    const provenance = claimHttpRequestProvenance(request);
    const requestBytes = this.admittedRequestBytes({
      v: PROTOCOL_VERSION,
      t: "call",
      id: request.id,
      ref: request.address,
      args: request.args,
    }, provenance?.bytes);
    const claimedTrace = claimHttpTrace(
      provenance?.trace,
      "sse",
      request.address,
      String(request.id),
    );
    const fairnessKey = request.fairnessKey ?? callerFairnessKey(
      request.principal,
      DIRECT_RUNTIME_SOURCE,
    );
    const scope = this.telemetry.enabled
      ? this.operationTrace(
          null,
          "sse",
          request.address,
          { requestId: String(request.id) },
          claimedTrace?.context,
        )
      : undefined;
    let traceFinished = false;
    const finishOperationTrace = (): void => {
      if (traceFinished) return;
      traceFinished = true;
      if (claimedTrace !== undefined) {
        finishClaimedHttpTrace(claimedTrace);
        return;
      }
      if (scope !== undefined) this.telemetry[FINISH_OPERATION_TRACE](scope.trace);
    };
    const admittedAt = scope === undefined ? 0 : performance.now();
    let release: () => void;
    try {
      release = this.admitOperation(null, fairnessKey).release;
      if (scope !== undefined) {
        this.telemetry[RECORD_OPERATION_SPAN](
          scope.trace,
          0,
          0,
          {
            operation: "sse",
            stage: "admission",
            outcome: "ok",
            functionName: request.address,
            resource: "operation",
            durationMs: Math.max(0, performance.now() - admittedAt),
            sizeBytes: requestBytes,
          },
        );
      }
    } catch (error) {
      const safeError = transportError(error);
      if (scope !== undefined) {
        const outcome = outcomeFromError(safeError).code;
        this.telemetry[RECORD_OPERATION_SPAN](
          scope.trace,
          0,
          0,
          {
            operation: "sse",
            stage: "admission",
            outcome,
            functionName: request.address,
            resource: "operation",
            durationMs: Math.max(0, performance.now() - admittedAt),
            sizeBytes: requestBytes,
          },
        );
      }
      finishOperationTrace();
      throw safeError;
    }
    const startedAt = scope === undefined ? 0 : performance.now();
    const execute = async (): Promise<RuntimeSseResponse> => {
      let producer: BoundedSseProducer | null = null;
      let streamId: string | null = null;
      let lifecycle: Promise<void> | null = null;
      let procedure: OwnedProcedureContext | null = null;
      let deliveryObserver: DeliveryObserver | undefined;
      try {
        const fn = this.expect(request.address, "sse") as AnyRegisteredSse;
        if (fn.yields === undefined) {
          throw new DbzzError("internal", `sse "${request.address}" has no yields validator`);
        }
        const signal = this.operationSignal(request.signal);
        throwIfAborted(signal);
        producer = new BoundedSseProducer({
          budget: this.sseBudget,
          limits: this.limits,
          signal,
          ...(this.telemetry.enabled
            ? { observer: (observation: DeliveryObservation) => deliveryObserver?.(observation) }
            : {}),
        });
        streamId = this.registerSseProducer(producer);
        void producer.finished.then(() => this.removeSseProducer(streamId!, producer!));
        const authorized = deferred<void>();
        let handlerContext: <T>(work: () => T) => T = (work) => work();
        procedure = this.procedureContext(
          request.principal,
          fairnessKey,
          producer.signal,
          requestBytes,
          this.readNow(),
          (account) => this.authInvalidation.publishAccount(account),
        );
        const handler = invokeFunction(
          fn,
          procedure.value as SseCtx,
          request.args,
          {
            onAuthorized: () => {
              deliveryObserver = this[CAPTURE_DELIVERY_OBSERVER]();
              handlerContext = AsyncLocalStorage.snapshot();
              authorized.resolve();
            },
          },
        );
        const completion = handler
          .then(async (result: SseSource<unknown>) => {
            const source = validatedSseSource(fn, result, handlerContext);
            try {
              await producer!.merge(source);
            } catch (error) {
              // merge() that never consumed the source still owns releasing it.
              void source.cancel(error).catch(() => {});
              throw error;
            }
            return producer!.complete();
          })
          .catch(async (error) => {
            producer!.fail(error);
            try {
              await producer!.complete();
            } catch {
              // Preserve the handler failure after terminal ACK/cancel owns cleanup.
            }
            throw error;
          });
        lifecycle = completion.catch((error) => {
          if (scope !== undefined) {
            const safeError = transportError(error);
            this.traceEvent({
              name: "failure",
              level: "error",
              operation: "sse",
              outcome: outcomeFromError(safeError).code,
              functionName: request.address,
              errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
            }, scope);
          }
          throw error;
        }).finally(() => {
          procedure!.release();
          procedure = null;
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
        return Object.freeze({ stream: producer.stream, streamId });
      } catch (error) {
        if (producer !== null) {
          try {
            await producer.stream.cancel(error);
          } catch {
            // No stream escaped this boundary; cancellation is capacity cleanup.
          }
        }
        if (lifecycle !== null) await lifecycle.catch(() => {});
        else {
          procedure?.release();
          procedure = null;
          release();
          finishOperationTrace();
        }
        const safeError = transportError(error);
        if (scope !== undefined) {
          const outcome = outcomeFromError(safeError).code;
          if (scope.invocations === 0) {
            this.traceSpan({
              operation: "sse",
              stage: "handler",
              outcome,
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes: requestBytes,
            }, "sse");
          }
          this.traceEvent({
            name: outcome === "overloaded" ? "overload" : "failure",
            level: outcome === "overloaded" ? "warn" : "error",
            operation: "sse",
            outcome,
            functionName: request.address,
            errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
          }, scope);
        }
        throw safeError;
      }
    };
    return scope === undefined ? execute() : this.runTraced(scope, execute);
  }

  /** Receiver credit is capability-authenticated and remains routable during drain. */
  ackSse(request: SseAckRequest): boolean {
    return this.sseProducers.get(request.stream)?.ack(request.seq, request.proof) ?? false;
  }

  /** Delivery snapshot of one active stream, or null once it finished. */
  sseSnapshot(streamId: string): SseDeliverySnapshot | null {
    return this.sseProducers.get(streamId)?.snapshot() ?? null;
  }

  private registerSseProducer(producer: BoundedSseProducer): string {
    let streamId: string;
    do streamId = randomBytes(16).toString("base64url");
    while (this.sseProducers.has(streamId));
    this.sseProducers.set(streamId, producer);
    return streamId;
  }

  private removeSseProducer(streamId: string, producer: BoundedSseProducer): void {
    if (this.sseProducers.get(streamId) === producer) this.sseProducers.delete(streamId);
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
            admissionSignal: this.shutdownController.signal,
            ...(this.telemetry.enabled
              ? {
                  telemetry: this.observeCommit,
                  statementTelemetry: this.observeStatement,
                  run: AsyncLocalStorage.snapshot(),
                }
              : {}),
            work: async (db, writes) => {
              const plan = this.engine.plan(candidate.table);
              const raw = this.measuredStatement("read", candidate.table, "scheduledGet", () =>
                this.engine.writer.query(
                  `SELECT ${plan.readProjection} FROM ${quoted(candidate.table)} WHERE ${quoted(plan.pk)} = ? AND ${quoted(plan.scheduleAt!)} <= ?`,
                )
                  .get(candidate.primaryKey as never, now) as Record<string, unknown> | null,
                (value) => value === null ? 0 : 1,
              );
              if (raw === null) throw STALE_SCHEDULED_CANDIDATE;
              row = this.engine.rowFromSql(plan, raw);
              const fn = this.expect(candidate.address, "mutation");
              const invocation = this.hostMutationContext(
                db,
                SYSTEM_PRINCIPAL,
                this.readNow(),
                writes,
              );
              const scope = createMutationInvocationScope(this.engine.writer, writes);
              const result = await scope.runRoot((mutationAccess) =>
                this.hasMcpCapabilities
                  ? withMcpTokenCapability(
                      invocation,
                      this.mcpTokenCapability(SYSTEM_PRINCIPAL, this.engine.writer, null, writes),
                      (ctx) => invokeFunction(fn, ctx, row, {
                        mutationAccess,
                      }),
                    )
                  : invokeFunction(fn, invocation, row, {
                      mutationAccess,
                    }));
              if (!result.ok) {
                throw new DbzzError(
                  "conflict",
                  `scheduled mutation returned application error ${result.error.code}`,
                );
              }
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
      telemetryAggregates: this.telemetry.aggregateSnapshot(),
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
    const sessionDrains = [...this.sessions.values()].map((state) => this.startSessionClose(state));
    for (const producer of this.sseProducers.values()) producer.fail(draining);

    // Close every internal admission boundary before the first await. Existing
    // handlers get one finite grace period; queued and future work cannot grow.
    this.coordinator.close();
    this.reader.close();
    if (this.ownsTelemetry) this.telemetry.stop();
    const reactiveDrain = this.reactive.close();
    let deadlineReached = false;
    const coreShutdown = (async () => {
      const settled = await Promise.allSettled([
        this.waitForActiveOperations(),
        this.coordinator.drain(),
        reactiveDrain,
        this.reader.drain(),
        ...sessionDrains,
      ]);
      const errors = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      try {
        await this.pluginRuntime?.stop(draining);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Runtime shutdown failed");
      }
    })();
    const shutdownWork = coreShutdown.then(() => {
      // A core that outlives the Runtime deadline must not start a detached
      // telemetry tail after drain has already failed.
      if (deadlineReached) return;
      this.flushDeliveryFailureSummaries();
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
        void this.pluginRuntime?.stop(deadlineError).catch(() => {});
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
      state.context.fairnessKey !== context.fairnessKey ||
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
    if (state.phase !== "open") throw new DbzzError("auth_stale", "session is closing");
    if (!allowAborted) throwIfAborted(context.signal);
    return state;
  }

  private runSessionOperation<T>(
    context: SessionRuntimeContext,
    request: RuntimeRequest<
      SubscribeMessage | UnsubscribeMessage | ResetRequestMessage | QueryMessage | ProcedureMessage | MutationMessage
    >,
    operation: "query" | "mutation" | "procedure" | "subscription",
    functionName: string | undefined,
    work: (state: RuntimeSession, requestBytes: number) => T | Promise<T>,
    options: SessionOperationOptions<T> = {},
  ): Promise<T> {
    const { message } = request;
    const requestBytes = this.admittedRequestBytes(
      message,
      claimRuntimeRequestBytes(request),
    );
    const state = this.matchingSession(context);
    const execute = () => {
      if (state === null) throw new DbzzError("auth_stale", "authentication state changed");
      throwIfAborted(context.signal);
      return work(state, requestBytes);
    };
    const sessionOrder: SessionOperationOrder | undefined = operation === "subscription"
      ? { kind: "subscription-control", id: message.id }
      : operation === "mutation"
        ? { kind: "subscription-frontier" }
        : undefined;
    return this.runOperation(
      state,
      operation,
      functionName,
      requestBytes,
      execute,
      {
        identifiers: options.identifiers ?? {},
        synthesizeHandler: options.synthesizeHandler ?? true,
        finalize: (outcome) =>
          this.publishOperationOutcome(context, state, message.id, operation, outcome, options),
        fairnessKey: context.fairnessKey,
        ...(sessionOrder === undefined ? {} : { sessionOrder }),
      },
    );
  }

  private async publishOperationOutcome<T>(
    context: SessionRuntimeContext,
    state: RuntimeSession | null,
    id: number,
    operation: "query" | "mutation" | "procedure" | "subscription",
    outcome: RuntimeOperationOutcome<T>,
    options: SessionOperationOptions<T>,
  ): Promise<T> {
    if (!context.signal.aborted) {
      const successPublication = outcome.ok
        ? options.successPublication?.(outcome.value)
        : undefined;
      const message = outcome.ok
        ? successPublication?.message
        : {
            v: PROTOCOL_VERSION,
            t: "err",
            id,
            outcome: outcomeFromError(outcome.error),
          } satisfies ErrorMessage;
      if (message !== undefined) {
        if (state !== null) {
          await this.publishSession(
            state,
            context.authEpoch,
            message,
            successPublication,
          );
        } else {
          await context.publish(successPublication ?? this.prepareFrame(
            message,
            "application frame",
            operation === "subscription" ? "subscription" : "operation",
          ));
        }
      }
    }
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  private makeSubscriber(state: () => RuntimeSession, authEpoch: number): Subscriber {
    const publish = (message: SessionApplicationMessage): Promise<void> =>
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
    message: SessionApplicationMessage,
    prepared?: RuntimePublication,
  ): Promise<void> {
    if (prepared !== undefined && prepared.message !== message) {
      throw new TypeError("prepared publication does not own the supplied message");
    }
    const capture = state.capture;
    if (capture !== null) {
      if (!this.captureAccepts(capture, sourceAuthEpoch, message)) return;
      this.captureFrame(
        capture,
        prepared ?? this.prepareFrame(message, "subscription frame", "subscription"),
      );
      return;
    }
    if (sourceAuthEpoch !== state.context.authEpoch) return;
    const publication = prepared ?? this.prepareFrame(
      message,
      "application frame",
      message.t === "transition" || message.t === "event" ||
          this.trace.getStore()?.operation === "subscription"
        ? "subscription"
        : "operation",
    );
    if (!await state.context.publish(publication)) {
      throw new DbzzError("auth_stale", "authentication state changed");
    }
  }

  private captureAccepts(
    capture: AuthTransitionCapture,
    sourceAuthEpoch: number,
    message: SessionApplicationMessage,
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
    publication: RuntimePublication,
  ): void {
    if (!capture.active) throw new DbzzError("auth_stale", "authentication state changed");
    const maxItems = Math.min(Number.MAX_SAFE_INTEGER, this.limits.maxSubscriptionsPerConnection * 2);
    const maxBytes = this.limits.webSocket.maxBytesPerConnection - this.limits.maxFrameBytes;
    if (capture.frames.length >= maxItems || publication.bytes > maxBytes - capture.bytes) {
      throw new DbzzError("overloaded", "authentication transition exceeds capture capacity", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    const reservation = this.authCaptureBudget.reserve(publication.bytes, "application");
    if (reservation === null) {
      throw new DbzzError("overloaded", "authentication transition exceeds global capture capacity", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    capture.frames.push(publication);
    capture.reservations.push(reservation);
    capture.bytes += publication.bytes;
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
    address: string,
    args: unknown,
    cursor?: SubscribeMessage["cursor"],
  ): Promise<void> {
    if (address.startsWith("events.")) {
      const table = address.slice("events.".length);
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
          args,
        );
        if (this.telemetry.enabled) {
          this.traceSpan({
            stage: "policy",
            outcome: "ok",
            functionName: address,
            resource: "subscription",
            durationMs: Math.max(0, performance.now() - policyAt),
          }, "subscription");
        }
      } catch (error) {
        if (this.telemetry.enabled) {
          this.traceSpan({
            stage: "policy",
            outcome: outcomeFromError(transportError(error)).code,
            functionName: address,
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
    } else {
      this.expect(address, "query");
      await this.reactive.subscribeQuery({
        subscriber: state.subscriber,
        id,
        address,
        args,
        policyScopeFingerprint: digest(state.context.principal),
        fairnessKey: state.context.fairnessKey,
        context: {
          principal: state.context.principal,
        },
        authEpoch: state.context.authEpoch,
        ...(cursor === undefined ? {} : { cursor }),
      });
    }
  }

  private executeQuery(
    address: string,
    args: unknown,
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
  ): Promise<unknown> {
    const fn = this.expect(address, "query");
    return this.executeRead(
      "query",
      fairnessKey,
      signal,
      requestBytes,
      null,
      (execution) => this.invokeQuery(fn, args, principal, execution),
    );
  }

  private invokeQuery(
    fn: AnyRegistered,
    args: unknown,
    principal: Principal,
    execution: Readonly<PluginReadExecution>,
  ): Promise<unknown> {
    const db = makeDbReader(
      this.engine,
      execution.connection,
      execution.reads,
      execution.statementObserver,
    );
    const timestamp = this.readNow();
    const context = this.hostQueryContext(db, principal, timestamp, execution);
    return this.hasMcpCapabilities
      ? withMcpTokenCapability(
          context,
          this.mcpTokenCapability(principal, execution.connection, execution.reads, null),
          (ctx) => invokeFunction(fn, ctx, args),
        )
      : invokeFunction(fn, context, args);
  }

  private executeRead<T>(
    operation: "query" | "subscription",
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
    reads: ReadRecorder | null,
    work: (
      execution: Readonly<PluginReadExecution>,
      commitVersion: bigint,
    ) => T | Promise<T>,
  ): Promise<T> {
    return this.submitRead(async (connection) => {
      throwIfAborted(signal);
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
        // A deferred reader pins its snapshot on this first SELECT.
        const commitVersion = this.engine.commitVersion(connection);
        const value = await work(Object.freeze({
          connection,
          reads,
          ...(this.telemetry.enabled ? { statementObserver: this.observeStatement } : {}),
        }), commitVersion);
        throwIfAborted(signal);
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
        return value;
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
    const execute = () => {
      const fn = this.expect(input.address, "query");
      const readSet = new Set<string>();
      const reads: ReadRecorder = { add: (key) => readSet.add(key) };
      return this.executeRead(
        "subscription",
        input.fairnessKey,
        this.shutdownController.signal,
        byteLength(input.args),
        reads,
        async (execution, commitVersion) => {
          const value = await this.invokeQuery(
            fn,
            input.args,
            input.context.principal,
            execution,
          );
          return Object.freeze({ value, readSet, commitVersion });
        },
      ).then((execution) => this.encodeQueryEvaluation(execution));
    };
    if (!this.telemetry.enabled) return execute();
    const scope = this.trace.getStore();
    if (scope === undefined) {
      const evaluationScope = this.operationTrace(null, "subscription", input.address, {});
      const evaluation = this.runTraced(evaluationScope, execute);
      return evaluation.finally(() => {
        this.telemetry[FINISH_OPERATION_TRACE](evaluationScope.trace);
      });
    }
    return this.trace.run({
      ...scope,
      operation: "subscription",
      rootFunction: input.address,
    }, execute);
  }

  private encodeQueryEvaluation(execution: QueryExecution): QueryEvaluation {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    try {
      if (!isResult(execution.value)) {
        throw new DbzzError("internal", "subscription query boundary returned no Result");
      }
      const wireValue = execution.value.ok
        ? execution.value.data
        : execution.value.error;
      const encoded = encode(wireValue);
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: "ok",
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: Buffer.byteLength(encoded),
          resultCount: Array.isArray(wireValue)
            ? wireValue.length
            : wireValue === null
              ? 0
              : 1,
        }, "subscription");
      }
      return Object.freeze({
        ...execution,
        value: execution.value.ok ? execution.value.data : undefined,
        ...(execution.value.ok
          ? {}
          : { applicationError: applicationError(execution.value.error) }),
        encoded,
      });
    } catch (error) {
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: outcomeFromError(transportError(error)).code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
        }, "subscription");
      }
      throw error;
    }
  }

  private hostQueryContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    execution: Readonly<PluginReadExecution>,
  ): QueryCtx {
    const plugins = this.pluginRuntime?.bindQuery({ ...execution, timestamp }) ?? {};
    return Object.freeze({ db, auth: principal, timestamp, ...plugins }) as QueryCtx;
  }

  private hostMutationContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    writes: WriteCollector,
  ): MutationCtx {
    const plugins = this.pluginRuntime?.bindMutation({
      writes,
      timestamp,
      ...(this.telemetry.enabled ? { statementObserver: this.observeStatement } : {}),
    }) ?? {};
    return Object.freeze({ db, auth: principal, timestamp, ...plugins }) as MutationCtx;
  }

  private async executeWrite<T>(
    operation: "mutation" | "transaction",
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (db: MutationCtx["db"], writes: WriteCollector) => T | Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    let scheduledTouched = false;
    const result = await this.coordinator.execute({
      operation,
      fairnessKey,
      requestBytes,
      ...(this.telemetry.enabled
        ? {
            telemetry: this.observeCommit,
            statementTelemetry: this.observeStatement,
            run: AsyncLocalStorage.snapshot(),
          }
        : {}),
      admissionSignal: signal,
      transactionSignal: signal,
      work,
      rollbackWhen: (value) => isResult(value) && !value.ok,
      publication: (_version, writes) => {
        scheduledTouched = writes.scheduledTouched;
        return this.publicationFor(writes);
      },
    });
    if (scheduledTouched) this.armScheduler();
    return result.value;
  }

  private inTransactionTrace<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.trace.getStore();
    return scope === undefined
      ? work()
      : this.trace.run({ ...scope, operation: "transaction" }, work);
  }

  /** MCP gets the ordinary transaction capability, never mounted Plugins. */
  private transactionalContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number,
  ): McpToolCtx & Pick<ProcedureCtx, "timestamp"> {
    return Object.freeze({
      auth: principal,
      abortSignal: signal,
      timestamp,
      tx: async <R>(work: (ctx: TxCtx) => R): Promise<Awaited<R>> =>
        await this.inTransactionTrace(() => this.executeWrite(
          "transaction",
          fairnessKey,
          signal,
          requestBytes,
          async (db, writes) => {
            const context = Object.freeze({ db, auth: principal, timestamp }) as TxCtx;
            try {
              return await (this.hasMcpCapabilities
                ? withMcpTokenCapability(
                    context,
                    this.mcpTokenCapability(principal, this.engine.writer, null, writes),
                    work,
                  )
                : work(context));
            } catch (error) {
              return poisonCurrentInvocation(error);
            }
          },
        )) as Awaited<R>,
    });
  }

  private executePluginQuery<T>(
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (execution: Readonly<PluginReadExecution>) => T | Promise<T>,
  ): Promise<T> {
    return this.executeRead("query", fairnessKey, signal, requestBytes, null, work);
  }

  private executePluginWrite<T>(
    operation: "mutation" | "transaction",
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (execution: Readonly<PluginWriteExecution>) => T | Promise<T>,
  ): Promise<T> {
    const execute = () => this.executeWrite(
      operation,
      fairnessKey,
      signal,
      requestBytes,
      (_db, writes) => work(Object.freeze({
        writes,
        ...(this.telemetry.enabled ? { statementObserver: this.observeStatement } : {}),
      })),
    );
    return operation === "transaction" ? this.inTransactionTrace(execute) : execute();
  }

  private procedureInvalidations(
    principal: Principal,
    originScope: AuthInvalidationScope | undefined,
  ): ProcedureInvalidations {
    if (originScope === undefined) return this.immediateProcedureInvalidations;
    const pending = new Map<string, Map<string, ExternalAccount>>();
    return Object.freeze({
      publish: (account: ExternalAccount): void => {
        const isSelf =
          principal.kind === "user" &&
          principal.issuer === account.issuer &&
          principal.subject === account.subject;
        if (!this.authInvalidation.publishAccount(account, isSelf ? originScope : undefined)) return;
        if (!isSelf) return;
        let subjects = pending.get(account.issuer);
        if (subjects === undefined) pending.set(account.issuer, (subjects = new Map()));
        subjects.set(account.subject, account);
      },
      finish: (): void => {
        for (const subjects of pending.values()) {
          for (const account of subjects.values()) {
            this.authInvalidation.publishAccountTo(account, originScope);
          }
        }
        pending.clear();
      },
    });
  }

  private procedureContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number,
    accountUnlinked: (account: ExternalAccount) => void,
  ): OwnedProcedureContext {
    const plugins = this.pluginRuntime?.bindProcedure({
      timestamp,
      abortSignal: signal,
      runQuery: (work) => this.executePluginQuery(fairnessKey, signal, requestBytes, work),
      runMutation: (work) => this.executePluginWrite(
        "mutation",
        fairnessKey,
        signal,
        requestBytes,
        work,
      ),
      runTransaction: (work) => this.executePluginWrite(
        "transaction",
        fairnessKey,
        signal,
        requestBytes,
        work,
      ),
    }) ?? {};
    const value = Object.freeze({
      auth: principal,
      abortSignal: signal,
      timestamp,
      ...plugins,
      tx: <R>(work: (ctx: TxCtx) => R) =>
        this.inTransactionTrace(() => this.executeWrite(
          "transaction",
          fairnessKey,
          signal,
          requestBytes,
          (db, writes) => {
            const context = this.hostMutationContext(db, principal, timestamp, writes) as TxCtx;
            const scope = createMutationInvocationScope(this.engine.writer, writes);
            return scope.runRoot((mutationAccess) =>
              withMutationAccess(mutationAccess, async () => {
                try {
                  const value = await (this.hasMcpCapabilities
                    ? withMcpTokenCapability(
                        context,
                        this.mcpTokenCapability(principal, this.engine.writer, null, writes),
                        work,
                      )
                    : work(context));
                  return isResult(value) ? value : Ok(value);
                } catch (error) {
                  return poisonCurrentInvocation(error);
                }
              }));
          },
        )),
      linkAccount: (rawBearerToken: string) => this.linkAccount(
        principal,
        rawBearerToken,
        fairnessKey,
        signal,
        requestBytes,
      ),
      unlinkAccount: (account: ExternalAccount) => this.unlinkAccount(
        principal,
        account,
        fairnessKey,
        signal,
        requestBytes,
        accountUnlinked,
      ),
    }) as ProcedureCtx;
    const release = this.hasMcpCapabilities
      ? bindMcpAiContext(
        value,
        this.mcpAiCapability(value, fairnessKey, requestBytes),
      )
      : releaseNothing;
    return Object.freeze({ value, release });
  }

  private mcpAiCapability(
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): McpAiRuntimeCapability {
    return Object.freeze({
      toolsFor: (mcp) => this.registry.mcps.get(mcp.name) === mcp
        ? this.registry.registeredToolsFor(mcp)
        : undefined,
      execute: (mcp, tool, args, scopes, signal) => withMcpLocalAuthority(
        context.auth,
        mcp,
        scopes,
        () => this.dispatchMcpTool(
          mcp.name,
          tool.name,
          args,
          this.transactionalContext(
            context.auth,
            fairnessKey,
            signal,
            requestBytes,
            context.timestamp,
          ),
          fairnessKey,
          requestBytes,
        ),
      ),
    } satisfies McpAiRuntimeCapability);
  }

  /** Construct token authority only from an MCP-enabled invocation branch. */
  private mcpTokenCapability(
    principal: Principal,
    connection: Database,
    reads: ReadRecorder | null,
    writes: WriteCollector | null,
  ) {
    return {
      engine: this.engine,
      connection,
      principal,
      reads,
      writes,
      limits: this.limits.mcp,
      now: this.now,
    };
  }

  private publicationFor(writes: WriteCollector, caller?: Subscriber): ReactiveCommit {
    return new ReactiveCommit(
      writes.keys,
      writes.events,
      caller === undefined ? [] : this.reactive.affectedQueryIds(caller, writes.keys),
    );
  }

  private async finishMutation(
    state: RuntimeSession,
    message: MutationMessage,
    result: CommitResult<unknown, ReactiveCommit>,
    executedPublication?: RuntimePublication,
  ): Promise<FinishedRuntimeMutation> {
    const value = restoreMutationResult(result.value);
    let obligations: readonly number[];
    if (!value.ok && result.publication === undefined) {
      obligations = [];
    } else if (result.replay === "replayed") {
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
    let publication = executedPublication;
    if (!value.ok && result.publication === undefined) {
      publication = this.prepareFrame(this.mutationFrame(
        message,
        value,
        result.commitVersion,
        result.durability,
        result.replay,
        obligations,
      ), "mutation result");
    } else if (result.replay === "replayed") {
      try {
        publication = this.prepareFrame(this.mutationFrame(
          message,
          value,
          result.commitVersion,
          result.durability,
          result.replay,
          obligations,
        ), "mutation result");
      } catch {
        throw convergenceError(
          `mutation ${message.mutationRequestId} committed but its receipt cannot fit one frame`,
        );
      }
    }
    if (
      publication === undefined ||
      (publication.message.t !== "ok" && publication.message.t !== "app_err") ||
      publication.message.kind !== "mutation"
    ) {
      throw convergenceError("committed mutation publication was not prepared");
    }
    return Object.freeze({
      result: Object.freeze({
        value: value.ok ? value.data : value,
        receipt: publication.message.receipt!,
      }),
      publication,
    });
  }

  private mutationFrame(
    message: MutationMessage,
    value: unknown,
    commitVersion: bigint,
    durability: CommitResult<unknown, ReactiveCommit>["durability"],
    replay: "executed" | "replayed",
    obligations: readonly number[],
  ): MutationOkMessage | ApplicationErrorMessage {
    if (!isResult(value)) throw new DbzzError("internal", "mutation boundary returned no Result");
    const receipt = {
      mutationRequestId: message.mutationRequestId,
      commitVersion,
      durability,
      replay,
      obligations: Object.freeze([...obligations]),
    };
    if (!value.ok) {
      return {
        v: PROTOCOL_VERSION,
        t: "app_err",
        id: message.id,
        kind: "mutation",
        error: applicationError(value.error),
        receipt,
      };
    }
    return {
      v: PROTOCOL_VERSION,
      t: "ok",
      id: message.id,
      kind: "mutation",
      value: value.data,
      receipt,
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

  private prepareFrame(
    frame: SessionApplicationMessage,
    label: string,
    resource: "operation" | "subscription" = "operation",
  ): RuntimePublication {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    let publication: RuntimePublication;
    try {
      publication = prepareRuntimePublication(frame);
    } catch (error) {
      const failure = new DbzzError("validation", `${label} is not wire-representable`, {
        cause: error,
      });
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: failure.code,
          resource: "outbound",
          durationMs: Math.max(0, performance.now() - startedAt),
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (publication.bytes > this.limits.maxFrameBytes) {
      const failure = new DbzzError("overloaded", `${label} exceeds maxFrameBytes`, { resource });
      if (this.telemetry.enabled) {
        this.traceSpan({
          stage: "encoding",
          outcome: failure.code,
          resource: "outbound",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: publication.bytes,
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (this.telemetry.enabled) {
      this.traceSpan({
        stage: "encoding",
        outcome: "ok",
        resource: "outbound",
        durationMs: Math.max(0, performance.now() - startedAt),
        sizeBytes: publication.bytes,
        ...(frame.t === "ok" && frame.kind === "query"
          ? {
              resultCount: Array.isArray(frame.value)
                ? frame.value.length
                : frame.value === null
                  ? 0
                  : 1,
            }
          : {}),
      }, resource === "subscription" ? "subscription" : "query");
    }
    return publication;
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

  private readonly observeInvocation = (
    invocation: InvocationTelemetryContext,
    durationMs: number,
    outcome: InvocationOutcome,
  ): void => {
    const scope = this.trace.getStore();
    if (scope === undefined) return;
    scope.invocations++;
    const parent = this.invocationNode(scope, invocation.parent, "handler");
    const node = this.telemetry[OPERATION_INVOCATION_NODE](
      scope.trace,
      invocation.invocationId,
      invocation.phase,
      parent,
    );
    this.telemetry[RECORD_OPERATION_SPAN](
      scope.trace,
      node,
      parent,
      {
        operation: scope.operation,
        stage: invocation.phase,
        outcome,
        functionName: this.registry.invocationNameOf(invocation.fn) ?? scope.rootFunction,
        durationMs,
      },
    );
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
        : { commitId: String(event.commitVersion) }),
    }, event.operation);
  };

  private readonly observeReactive: ReactiveObserver = (
    observation: ReactiveObservation,
  ): void => {
    if (observation.phase === "failure") {
      this.traceEvent({
        name: "failure",
        level: "error",
        operation: "subscription",
        outcome: observationOutcome(observation.outcome),
        ...(observation.address === undefined ? {} : { functionName: observation.address }),
        resource: "subscription",
        ...(observation.subscriptionId === undefined
          ? {}
          : { subscriptionId: String(observation.subscriptionId) }),
        ...(observation.commitVersion === undefined
          ? {}
          : { commitId: String(observation.commitVersion) }),
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
    const scope = this.trace.getStore();
    const subscriptionId = observation.subscriptionId === undefined
      ? undefined
      : String(observation.subscriptionId);
    const commitId = observation.commitVersion === undefined
      ? undefined
      : String(observation.commitVersion);
    if (scope === undefined) {
      this.telemetry.recordSpan({
        operation: "subscription",
        stage,
        outcome: observationOutcome(observation.outcome),
        resource,
        durationMs: observation.durationMs,
        functionName: observation.address,
        resultCount: observation.resultCount,
        dependencyCount: observation.dependencyCount,
        sizeBytes: observation.byteCount,
        context: prepareTelemetryTraceContext({ subscriptionId, commitId }),
      });
      return;
    }
    this.telemetry[RECORD_OPERATION_SPAN](
      scope.trace,
      -1,
      this.invocationNode(scope, currentInvocationTelemetryContext()),
      {
        operation: "subscription",
        stage,
        outcome: observationOutcome(observation.outcome),
        functionName: observation.address,
        resource,
        durationMs: observation.durationMs,
        sizeBytes: observation.byteCount,
        resultCount: observation.resultCount,
        dependencyCount: observation.dependencyCount,
        commitId,
        subscriptionId,
      },
    );
  };

  private operationTrace(
    session: RuntimeSession | null,
    operation: TelemetryOperation,
    functionName: string | undefined,
    identifiers: TraceIdentifiers,
    inheritedContext?: PreparedTelemetryTraceContext,
  ): RuntimeTraceScope {
    return {
      operation,
      ...(functionName === undefined ? {} : { rootFunction: functionName }),
      trace: this.telemetry[OPEN_OPERATION_TRACE]({
        operation,
        ...(functionName === undefined ? {} : { functionName }),
        ...(session?.telemetryConnectionId === undefined
          ? {}
          : { connectionId: session.telemetryConnectionId }),
        ...identifiers,
        ...(inheritedContext === undefined ? {} : { inheritedContext }),
      }),
      invocations: 0,
    };
  }

  private invocationNode(
    scope: RuntimeTraceScope,
    invocation: InvocationTelemetryContext | undefined,
    phase: "auth" | "policy" | "handler" = invocation?.phase ?? "handler",
  ): number {
    if (invocation === undefined) return 0;
    const parent = this.invocationNode(scope, invocation.parent, "handler");
    return this.telemetry[OPERATION_INVOCATION_NODE](
      scope.trace,
      invocation.invocationId,
      phase,
      parent,
    );
  }

  private traceSpan(
    input: {
      readonly operation?: TelemetryOperation;
      readonly stage: TelemetryStage;
      readonly outcome: TelemetryOutcome;
      readonly functionName?: string;
      readonly statement?: string;
      readonly resource?: TelemetryResource;
      readonly durationMs: number;
      readonly sizeBytes?: number;
      readonly rowCount?: number;
      readonly resultCount?: number;
      readonly replayed?: boolean;
      readonly dependencyCount?: number;
      readonly postCommit?: boolean;
      readonly requestId?: string;
      readonly connectionId?: string;
      readonly mutationId?: string;
      readonly commitId?: string;
      readonly subscriptionId?: string;
    },
    fallbackOperation: TelemetryOperation,
    capturedScope?: RuntimeTraceScope,
    capturedParent?: number,
  ): void {
    if (!this.telemetry.enabled) return;
    const scope = capturedScope ?? this.trace.getStore();
    if (scope === undefined) return;
    const invocation = currentInvocationTelemetryContext();
    const parent = capturedParent ?? this.invocationNode(scope, invocation);
    const currentFunction = invocation === undefined
      ? undefined
      : this.registry.invocationNameOf(invocation.fn);
    this.telemetry[RECORD_OPERATION_SPAN](
      scope.trace,
      -1,
      parent,
      {
        ...input,
        operation: input.operation ?? scope.operation ?? fallbackOperation,
        functionName: input.functionName ?? currentFunction ?? scope.rootFunction,
      },
    );
  }

  private traceEvent(
    input: Omit<TelemetryEventInput, "context"> & TraceIdentifiers,
    capturedScope?: RuntimeTraceScope,
    capturedParent?: number,
  ): void {
    const scope = capturedScope ?? this.trace.getStore();
    if (scope === undefined) return;
    const parent = capturedParent ?? this.invocationNode(
      scope,
      currentInvocationTelemetryContext(),
    );
    const {
      requestId,
      connectionId,
      mutationId,
      commitId,
      subscriptionId,
      ...event
    } = input;
    this.telemetry[RECORD_OPERATION_EVENT](
      scope.trace,
      parent,
      event,
      requestId,
      connectionId,
      mutationId,
      commitId,
      subscriptionId,
    );
  }

  private runTraced<T>(scope: RuntimeTraceScope, work: () => T): T {
    return this.trace.run(scope, () => withFetchObserver(
      this.observeFetch,
      () => withInvocationTelemetry(this.observeInvocation, work),
    ));
  }

  readonly [CAPTURE_DELIVERY_OBSERVER] = (
    lane: OutboundLane = "application",
    clientSessionId?: string,
  ): DeliveryObserver | undefined => {
    if (!this.telemetry.enabled) return undefined;
    const scope = this.trace.getStore();
    if (scope === undefined) {
      const detached: DetachedDeliveryTrace = {
        operation: lane === "control" ? "lifecycle" : "subscription",
        context: prepareTelemetryTraceContext(
          clientSessionId === undefined ? {} : { connectionId: digest(clientSessionId) },
        ),
      };
      return (observation) => this.observeDelivery(detached, 0, observation);
    }
    const parent = this.invocationNode(scope, currentInvocationTelemetryContext());
    const lease = scope.operation === "sse"
      ? undefined
      : this.telemetry[CLAIM_OPERATION_DELIVERY_LEASE](scope.trace);
    if (lease === undefined) {
      return (observation) => this.observeDelivery(scope, parent, observation);
    }
    let released = false;
    return Object.assign(
      (observation: DeliveryObservation) =>
        this.observeDelivery(scope, parent, observation),
      {
        [FINALIZE_DELIVERY_OBSERVER]: () => {
          if (released) return;
          released = true;
          this.telemetry[RELEASE_DELIVERY_LEASE](lease);
        },
      },
    );
  };

  private runOperation<T, R = T>(
    session: RuntimeSession | null,
    operation: TelemetryOperation,
    functionName: string | undefined,
    sizeBytes: number,
    work: () => T | Promise<T>,
    options: RunOperationOptions<T, R> = {},
  ): Promise<R> {
    const identifiers = options.identifiers ?? {};
    const synthesizeHandler = options.synthesizeHandler ?? true;
    const finalize = options.finalize;
    const claimedTrace = options.claimedTrace;
    const scope = this.telemetry.enabled
      ? this.operationTrace(session, operation, functionName, identifiers, claimedTrace?.context)
      : undefined;
    const finishOperationTrace = <V>(result: Promise<V>): Promise<V> =>
      claimedTrace !== undefined
        ? result.finally(() => finishClaimedHttpTrace(claimedTrace))
        : scope !== undefined
          ? result.finally(() => {
              this.telemetry[FINISH_OPERATION_TRACE](scope.trace);
            })
          : result;
    const admittedAt = scope === undefined ? 0 : performance.now();
    const settle = async (outcome: RuntimeOperationOutcome<T>): Promise<R> => {
      if (finalize !== undefined) return finalize(outcome);
      if (outcome.ok) return outcome.value as unknown as R;
      throw outcome.error;
    };
    let admission: OperationAdmission;
    try {
      this.assertRequestBytes(sizeBytes);
      admission = this.admitOperation(session, options.fairnessKey, options.sessionOrder);
      if (scope !== undefined) {
        this.telemetry[RECORD_OPERATION_SPAN](
          scope.trace,
          0,
          0,
          {
            operation,
            stage: "admission",
            outcome: "ok",
            functionName,
            resource: "operation",
            durationMs: Math.max(0, performance.now() - admittedAt),
            sizeBytes,
          },
        );
      }
    } catch (error) {
      const safeError = transportError(error);
      if (scope !== undefined) {
        const outcome = outcomeFromError(safeError).code;
        this.telemetry[RECORD_OPERATION_SPAN](
          scope.trace,
          0,
          0,
          {
            operation,
            stage: "admission",
            outcome,
            functionName,
            resource: "operation",
            durationMs: Math.max(0, performance.now() - admittedAt),
            sizeBytes,
          },
        );
        this.traceEvent({
          name: outcome === "overloaded" ? "overload" : "failure",
          level: outcome === "overloaded" ? "warn" : "error",
          operation,
          stage: "admission",
          outcome,
          ...(functionName === undefined ? {} : { functionName }),
          resource: "operation",
          errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
        }, scope, 0);
      }
      const rejected = () => settle({ ok: false, error: safeError });
      return finishOperationTrace(
        scope === undefined ? rejected() : this.runTraced(scope, rejected),
      );
    }
    const startedAt = scope === undefined ? 0 : performance.now();
    const start = () => Promise.resolve().then(work);
    const execute = () => (admission.predecessor === undefined
      ? start()
      : admission.predecessor.then(start))
      .then(
        (value): RuntimeOperationOutcome<T> => {
          if (scope !== undefined && synthesizeHandler && scope.invocations === 0) {
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
            if (synthesizeHandler && scope.invocations === 0) {
              this.traceSpan({
                stage: "handler",
                outcome,
                durationMs: Math.max(0, performance.now() - startedAt),
                sizeBytes,
              }, operation);
            }
            this.traceEvent({
              name: outcome === "overloaded" ? "overload" : "failure",
              level: outcome === "overloaded" ? "warn" : "error",
              operation,
              outcome,
              ...(functionName === undefined ? {} : { functionName }),
              errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
            }, scope);
          }
          return { ok: false, error: safeError };
        },
      )
      .then(settle)
      .finally(admission.release);
    return finishOperationTrace(scope === undefined ? execute() : this.runTraced(scope, execute));
  }

  private admitOperation(
    session: RuntimeSession | null,
    fairnessKey?: string,
    sessionOrder?: SessionOperationOrder,
  ): OperationAdmission {
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
    if (session !== null && session.phase !== "open") {
      throw new DbzzError("auth_stale", "session is closing");
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

    let predecessor: Promise<void> | undefined;
    let control: {
      readonly state: RuntimeSession;
      readonly id: number;
      readonly completion: Deferred<void>;
    } | undefined;
    if (session !== null && sessionOrder?.kind === "subscription-control") {
      predecessor = session.subscriptionControlTails.get(sessionOrder.id);
      const completion = deferred<void>();
      control = { state: session, id: sessionOrder.id, completion };
      session.pendingSubscriptionControls++;
      session.subscriptionControlTails.set(sessionOrder.id, completion.promise);
      session.subscriptionControlFrontier = Promise.all([
        session.subscriptionControlFrontier,
        completion.promise,
      ]).then(() => {});
    } else if (
      session !== null &&
      sessionOrder?.kind === "subscription-frontier" &&
      session.pendingSubscriptionControls > 0
    ) {
      predecessor = session.subscriptionControlFrontier;
    }

    let active = true;
    return {
      predecessor,
      release: () => {
        if (!active) return;
        active = false;
        if (control !== undefined) {
          const { state, id, completion } = control;
          state.pendingSubscriptionControls--;
          if (state.subscriptionControlTails.get(id) === completion.promise) {
            state.subscriptionControlTails.delete(id);
          }
          completion.resolve(undefined);
          if (state.pendingSubscriptionControls === 0) {
            state.subscriptionControlFrontier = Promise.resolve();
          }
        }
        this.activeOperations--;
        if (session !== null) {
          session.activeOperations--;
          if (session.activeOperations === 0 && session.phase === "closing") {
            this.removeSession(session);
          }
        }
        if (fairnessKey !== undefined) {
          const remaining = this.externalOperations.get(fairnessKey)! - 1;
          if (remaining === 0) this.externalOperations.delete(fairnessKey);
          else this.externalOperations.set(fairnessKey, remaining);
        }
        if (this.activeOperations === 0) {
          for (const resolve of this.activeWaiters) resolve();
          this.activeWaiters.clear();
        }
      },
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

  /** Trusts only package-owned transport provenance; direct callers are re-encoded canonically. */
  private admittedRequestBytes(request: unknown, receivedBytes?: number): number {
    let bytes = receivedBytes;
    if (bytes === undefined) {
      try {
        bytes = byteLength(request);
      } catch (cause) {
        throw new DbzzError("validation", "request is not wire-representable", { cause });
      }
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
    const checkpoint = storage.lastCheckpoint;
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
      ["runtime.checkpoint_completed", checkpoint === null ? 0 : 1, "gauge"],
      ["runtime.checkpoint_busy", checkpoint?.busy ?? 0, "gauge"],
      ["runtime.checkpoint_total_frames", checkpoint?.totalFrames ?? 0, "gauge"],
      ["runtime.checkpoint_checkpointed_frames", checkpoint?.checkpointedFrames ?? 0, "gauge"],
      ["runtime.checkpoint_residual_frames", checkpoint?.residualFrames ?? 0, "gauge"],
      ["runtime.checkpoint_duration", checkpoint?.durationMs ?? 0, "milliseconds"],
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
    this.flushDeliveryFailureSummaries();
  }

  /** Emit and reset one coalesced non-ok delivery observation summary. */
  private flushDeliveryFailureSummary(summary: DeliveryFailureSummary): void {
    if (summary.summarized > 0) {
      this.telemetry.recordMetric({
        name: "delivery.failures_coalesced",
        value: summary.summarized,
        unit: "count",
        labels: {
          operation: summary.operation,
          stage: summary.stage,
          outcome: summary.outcome,
          resource: summary.resource,
        },
        // The count must stay observable on the default local-console
        // profile, where the summarized per-frame records no longer appear.
        local: true,
      });
    }
    summary.summarized = 0;
  }

  /** Flush every summary and reset exemplar budgets for the next interval. */
  private flushDeliveryFailureSummaries(): void {
    for (const summary of this.deliveryFailureSummaries.values()) {
      this.flushDeliveryFailureSummary(summary);
    }
    this.deliveryFailureSummaries.clear();
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}
