import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  PROTOCOL_VERSION,
  Failure,
  Ok,
  encode,
  isApplicationError,
  isResult,
  stableEncode,
  uuidV7Timestamp,
  type ApplicationErrorMessage,
  type ChannelJoinMessage,
  type ChannelLeaveMessage,
  type ChannelSendMessage,
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
  type UnsubscribeMessage,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
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
  type CommitResult,
  type IdempotencyIdentity,
} from "./coordinator.ts";
import type { Identity } from "../validation/v.ts";
import type { ExposedHttpCodec } from "../transport/http-codec.ts";
import type { ExposedHttpKind } from "../transport/http-surface.ts";
import type { ReadRecorder } from "../database/access.ts";
import {
  BoundedSseProducer,
  OutboundBudget,
  type DeliveryObservation,
  type DeliveryObserver,
  type OutboundLane,
  type SseDeliverySnapshot,
} from "../subscriptions/delivery.ts";
import type { Engine } from "../database/engine.ts";
import { telemetryJournalPath } from "../database/artifacts.ts";
import { AckerDBError, throwIfAborted } from "../shared/errors.ts";
import {
  claimHttpTrace,
  finishClaimedHttpTrace,
  type ClaimedHttpTrace,
} from "../telemetry/external-trace.ts";
import type {
  AnyRegistered,
  AnyRegisteredSse,
  OwnedProcedureContext,
  ProcedureCtx,
  SseCtx,
  SseSource,
} from "../app/functions.ts";
import {
  isSystemOperationName,
  type SystemCtx,
  type SystemRunner,
  type SystemRunOptions,
} from "../app/system.ts";
import {
  currentInvocationTelemetryContext,
  invokeFunction,
} from "../app/invocation.ts";
import {
  runInInvocationRoot,
} from "./invocation-state.ts";
import { inTransaction } from "./transaction-context.ts";
import {
  finalizeMcpToolResult,
  type AnyMcpAuthProvider,
  type AnyRegisteredMcpTool,
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
import {
  McpTokenInvalidationBoundary,
} from "../mcp/token-invalidation.ts";
import { mcpTokenVaultOwner } from "../mcp/token-vault.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import { outcomeFromError } from "./outcome.ts";
import {
  PluginRuntime,
} from "../plugins/runtime.ts";
import { claimHttpRequestProvenance } from "./request-provenance.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type QueryEvaluationInput,
  type Subscriber,
} from "../subscriptions/reactive.ts";
import type { Registry } from "../app/registry.ts";
import {
  ChannelHub,
} from "../channels/hub.ts";
import type { RealtimePeerDiagnostic, RealtimeRuntime } from "../realtime/host.ts";
import { createRealtimeRuntimeApplication } from "../realtime/runtime-application.ts";
import {
  FINISH_OPERATION_TRACE,
  RECORD_OPERATION_SPAN,
  Telemetry,
  type TelemetryOperation,
} from "../telemetry/telemetry.ts";
import { ApplicationSignals } from "../telemetry/application-signals/application-signals.ts";
import {
  TelemetryJournal,
} from "../telemetry/application-signals/journal.ts";
import type { ApplicationLogger } from "../telemetry/application-signals/types.ts";
import {
  TelemetryJournalExporters,
  validateTelemetryJournalExportersOptions,
} from "../telemetry/application-signals/exporters.ts";
import {
  type RuntimeAuthTransition,
  type RuntimeMutationResult,
  type RuntimePort,
  type RuntimePublication,
  type RuntimePublicationBatch,
  type RuntimeRequest,
  type SessionRuntimeContext,
} from "../subscriptions/session.ts";
import {
  canceledHandlerOutcome,
  invokeSideEffectingHandler,
} from "./side-effecting-handler.ts";
import type { RuntimeLifecycleState } from "./contracts/lifecycle.ts";
import type { RuntimeOptions } from "./contracts/options.ts";
import type {
  McpCredentialLease,
  RuntimeExternalRequest,
  RuntimeHttpMutationRequest,
  RuntimeHttpRequest,
  RuntimeMcpToolRequest,
  RuntimeSseRequest,
  RuntimeSseResponse,
} from "./contracts/requests.ts";
import type { RuntimeStatus } from "./contracts/status.ts";
import { RuntimeTraceBridge } from "./telemetry/trace-bridge.ts";
import {
  RuntimeOperationRunner,
  transportError,
  type OperationAdmission,
  type SessionOperationOrder,
} from "./execution/operation-runner.ts";
import { RuntimeReadExecutor } from "./execution/read.ts";
import { RuntimeFunctionExecutor } from "./execution/functions.ts";
import {
  authorizedMcpTool,
  mcpToolAuthorization,
  mcpToolAuthorizationFailure,
  type RuntimeMcpToolAuthorization,
} from "./mcp/authorization.ts";
import { validatedSseSource } from "./sse/source.ts";
import {
  RuntimeHttpResponses,
  type CommittedHttpMutation,
  type EncodedHttpBody,
  type HttpValueOperation,
} from "./http/response.ts";
import {
  RuntimeSessionStore,
  type RuntimeReactiveContext,
  type RuntimeSession,
} from "./sessions/store.ts";
import { RuntimeSampler } from "./telemetry/sampler.ts";
import { RuntimeDeliveryTelemetry } from "./telemetry/delivery-observer.ts";
import { RuntimeScheduledCandidates } from "./scheduler/candidate.ts";

const utf8 = new TextEncoder();
const SCHEDULER_RETRY_MS = 1_000;
const DIRECT_RUNTIME_SOURCE = transportSource({ family: "runtime", address: "local" });
const SYSTEM_FAIRNESS_KEY = callerFairnessKey(SYSTEM_PRINCIPAL, DIRECT_RUNTIME_SOURCE);
/** Package-private transport hook; intentionally absent from the public index. */
export const CAPTURE_DELIVERY_OBSERVER = Symbol("ackerdb.captureDeliveryObserver");
function applicationError(value: unknown) {
  if (!isApplicationError(value)) {
    throw new AckerDBError("internal", "registered Err contains no application error");
  }
  return value;
}

function restoreMutationResult(value: unknown): Result<unknown, unknown> {
  if (isResult(value)) return value;
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new AckerDBError("internal", "stored mutation result has no Result shape");
  }
  if (value.ok === true && "data" in value) return Ok(value.data);
  if (value.ok === false && "error" in value && isApplicationError(value.error)) {
    return Failure(value.error);
  }
  throw new AckerDBError("internal", "stored mutation Result is invalid");
}

const DRAIN_RETRY_AFTER_MS = 1_000;
/** What every path-addressed entry point derives from its request before it runs. */
interface ClaimedHttpRequest {
  readonly requestBytes: number;
  readonly codec: ExposedHttpCodec;
  readonly claimedTrace?: ClaimedHttpTrace;
  readonly fairnessKey: string;
  /** The transport's auth-invalidation scope, when it carried one. */
  readonly invalidationScope?: AuthInvalidationScope;
}

/** An HTTP caller holds no subscriptions, so it owes no convergence obligation. */
const NO_OBLIGATIONS: readonly number[] = Object.freeze([]);

interface ProcedureInvalidations {
  publish(account: ExternalAccount): void;
  finish(): void;
}

interface QueryExecution<T = unknown> {
  readonly value: T;
  readonly readSet: ReadonlySet<string>;
  readonly commitVersion: bigint;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface FinishedRuntimeMutation {
  readonly result: RuntimeMutationResult;
  readonly publication: RuntimePublication;
}

/** What varies between two commits; everything invariant lives in `commitWrite`. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function byteLength(value: unknown): number {
  return utf8.encode(encode(value)).byteLength;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("base64url");
}

function convergenceError(message: string): AckerDBError {
  return new AckerDBError("convergence_unavailable", message, { committed: true });
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
  readonly telemetryJournal: TelemetryJournal;
  readonly telemetryExporters: TelemetryJournalExporters | undefined;
  readonly log: ApplicationLogger;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly channels: ChannelHub;
  readonly realtime: RealtimeRuntime | undefined = undefined;
  readonly system: SystemRunner;
  readonly deliveryObserver: DeliveryObserver;

  private readonly now: () => number;
  private readonly pluginRuntime: PluginRuntime | undefined;
  private readonly authInvalidation: AuthInvalidationBoundary;
  private readonly immediateProcedureInvalidations: ProcedureInvalidations;
  private readonly mcpTokenInvalidation = new McpTokenInvalidationBoundary();
  private readonly reads: RuntimeReadExecutor;
  private readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  private readonly schedulerCandidates: RuntimeScheduledCandidates;
  private readonly scheduled: Map<string, string>;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly authCaptureBudget: OutboundBudget;
  private readonly sseBudget: OutboundBudget;
  private readonly sseProducers = new Map<string, BoundedSseProducer>();
  private readonly externalOperations = new Map<string, number>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly tracing: RuntimeTraceBridge;
  private readonly deliveryTelemetry: RuntimeDeliveryTelemetry;
  private readonly operations: RuntimeOperationRunner<RuntimeSession>;
  private readonly httpResponses: RuntimeHttpResponses;
  private readonly sampler: RuntimeSampler;
  private readonly systemRoot: ReturnType<typeof AsyncLocalStorage.snapshot>;
  private readonly ownsTelemetry: boolean;
  private readonly ownsTelemetryJournal: boolean;
  private readonly applicationSignals: ApplicationSignals;
  private readonly releaseTelemetryJournalFailure: () => void;
  private readonly hasMcpCapabilities: boolean;
  private lifecycle: RuntimeLifecycleState = "ready";
  private activeOperations = 0;
  private schedulerGeneration = 0;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledRun: Promise<number> | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private readonly systemDrainController = new AbortController();

  constructor(options: RuntimeOptions) {
    if (options.telemetryExporters !== undefined) {
      // Fail before opening the journal; the exporter owns the same validation at direct construction.
      validateTelemetryJournalExportersOptions(options.telemetryExporters);
    }
    this.engine = options.engine;
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
    if (options.pluginRuntime !== undefined && options.pluginRuntime.state !== "ready") {
      throw new TypeError("Runtime requires a ready Plugin runtime");
    }
    this.pluginRuntime = options.pluginRuntime;
    this.hasMcpCapabilities = this.registry.mcps.size > 0;
    this.limits = options.limits === undefined ? PRODUCTION_LIMITS : defineServiceLimits(options.limits);
    this.channels = new ChannelHub({
      registry: this.registry,
      maxMembers: this.limits.maxSubscriptions,
      maxMembersPerSession: this.limits.maxSubscriptionsPerConnection,
      disconnectTimeoutMs: Math.min(5_000, this.limits.gracefulShutdownMs),
      observeDisconnectTimeout: () =>
        this.telemetry.recordMetric({
          name: "runtime.channel_disconnect_timeouts",
          value: 1,
          unit: "count",
        }),
    });
    if (this.registry.realtime.size > 0) {
      if (options.realtime === undefined) {
        throw new TypeError(
          "Runtime has realtime definitions but @ackerdb/realtime is not configured",
        );
      }
      this.realtime = options.realtime.create({
        application: this.realtimeApplication(),
        now: this.now,
        definition: (address) => this.registry.getRealtime(address),
      });
    }
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
    this.system = Object.freeze({
      run: <R>(
        name: string,
        work: (ctx: SystemCtx) => R | PromiseLike<R>,
        runOptions?: SystemRunOptions,
      ) => this.runSystem(name, work, runOptions),
    });
    this.credentialVerifier = this.authInvalidation.verifier;
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
    this.tracing = new RuntimeTraceBridge(this.telemetry, this.registry);
    this.deliveryTelemetry = new RuntimeDeliveryTelemetry(
      this.telemetry,
      this.tracing,
      (clientSessionId) => digest(clientSessionId),
    );
    this.deliveryObserver = this.deliveryTelemetry.observer;
    this.operations = new RuntimeOperationRunner({
      telemetry: this.telemetry,
      tracing: this.tracing,
      assertRequestBytes: (bytes) => this.assertRequestBytes(bytes),
      admit: (session, fairnessKey, sessionOrder) =>
        this.admitOperation(session, fairnessKey, sessionOrder),
    });
    this.httpResponses = new RuntimeHttpResponses(this.limits.maxFrameBytes, {
      enabled: this.telemetry.enabled,
      span: (input, operation) => this.tracing.span(input, operation),
      failure: (error, operation, stage) =>
        this.recordHttpResponseFailure(error, operation, stage),
    });
    // The system root must capture this trace storage's empty state.
    this.systemRoot = AsyncLocalStorage.snapshot();
    this.ownsTelemetryJournal = !(options.telemetryJournal instanceof TelemetryJournal);
    this.telemetryJournal = options.telemetryJournal instanceof TelemetryJournal
      ? options.telemetryJournal
      : new TelemetryJournal({
          path: this.engine.path === ":memory:"
            ? ":memory:"
            : telemetryJournalPath(this.engine.path),
          ...options.telemetryJournal,
        });
    if (this.telemetryJournal.snapshot().state !== "ready") {
      throw new TypeError("Runtime requires a ready telemetry journal");
    }
    this.applicationSignals = new ApplicationSignals(
      this.telemetryJournal,
      this.now,
      () => this.tracing.applicationLogContext(),
    );
    this.log = this.applicationSignals.log;
    this.releaseTelemetryJournalFailure = this.telemetryJournal.onFailure((error) => {
      this.telemetry.recordEvent({
        name: "failure",
        level: "error",
        operation: "lifecycle",
        outcome: "internal",
        resource: "telemetry",
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      if (this.lifecycle === "ready") {
        void this.drain(Date.now() + this.limits.gracefulShutdownMs).catch(() => {});
      }
    });
    this.telemetryExporters = options.telemetryExporters === undefined
      ? undefined
      : new TelemetryJournalExporters({
          journal: this.telemetryJournal,
          ...options.telemetryExporters,
        });
    this.reads = new RuntimeReadExecutor({
      engine: this.engine,
      limits: this.limits,
      now: this.now,
      telemetryEnabled: this.telemetry.enabled,
      tracing: this.tracing,
    });
    this.schedulerCandidates = new RuntimeScheduledCandidates({
      scheduled: this.scheduled,
      engine: this.engine,
      reads: this.reads,
      tracing: this.tracing,
    });
    this.reactive = new OrderedReactive<RuntimeReactiveContext>({
      limits: this.limits,
      initialVersion: this.engine.commitVersion(),
      now: this.now,
      evaluate: (input) => this.evaluateSubscription(input),
      ...(this.telemetry.enabled ? { observer: this.tracing.observeReactive } : {}),
    });
    this.functions = new RuntimeFunctionExecutor({
      engine: this.engine,
      registry: this.registry,
      limits: this.limits,
      reads: this.reads,
      reactive: this.reactive,
      telemetry: this.telemetry,
      tracing: this.tracing,
      applicationSignals: this.applicationSignals,
      log: this.log,
      pluginRuntime: this.pluginRuntime,
      credentialVerifier: this.credentialVerifier,
      hasMcpCapabilities: this.hasMcpCapabilities,
      mcpTokenInvalidation: this.mcpTokenInvalidation,
      ...(this.hasMcpCapabilities
        ? {
            bindMcpAiContext: (context, fairnessKey, requestBytes) =>
              bindMcpAiContext(
                context,
                this.mcpAiCapability(context, fairnessKey, requestBytes),
              ),
          }
        : {}),
      armScheduler: () => this.armScheduler(),
      hooks: options.hooks,
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
    this.sessionStore = new RuntimeSessionStore({
      limits: this.limits,
      engine: this.engine,
      registry: this.registry,
      channels: this.channels,
      reactive: this.reactive,
      operations: this.operations,
      authCaptureBudget: this.authCaptureBudget,
      telemetry: this.telemetry,
      tracing: this.tracing,
      ...(this.telemetry.enabled
        ? { telemetryConnectionId: (clientSessionId) => digest(clientSessionId) }
        : {}),
      createChannelContext: (state, signal, requestBytes) =>
        this.channelProcedureContext(state, signal, requestBytes),
      observeConnectionCount: (connections) =>
        this.telemetry.recordMetric({
          name: "runtime.connections",
          value: connections,
          unit: "gauge",
        }),
    });
    this.sampler = new RuntimeSampler({
      telemetry: this.telemetry,
      isReady: () => this.lifecycle === "ready",
      state: () => ({
        connections: this.sessionStore.size,
        activeOperations: this.activeOperations,
        activeOperationCallers: this.externalOperations.size,
        activeSse: this.sseProducers.size,
        realtime: this.realtime?.snapshot() ?? null,
        reader: this.reads.snapshot(),
        writer: this.functions.snapshot(),
        reactive: this.reactive.snapshot(),
        publication: this.reactive.publication.snapshot(),
        authCaptureBudget: this.authCaptureBudget.snapshot(),
        sseBudget: this.sseBudget.snapshot(),
        telemetry: this.telemetry.snapshot(),
        storage: this.engine.status(),
      }),
      sampleRealtime: () => {
        void this.realtime?.sampleHealth(8);
      },
      flushDeliveryFailures: () => this.deliveryTelemetry.flush(),
    });
    this.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "ready",
    });
    this.sampler.start();
    this.armScheduler();
  }

  get state(): RuntimeLifecycleState {
    return this.lifecycle;
  }

  get connectionCount(): number {
    return this.sessionStore.size;
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
    return this.operations.run(
      null,
      "transaction",
      undefined,
      requestBytes,
      () => this.functions.resolveIdentity(
        account,
        fairnessKey,
        operationSignal,
        requestBytes,
      ),
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
    if (parsed === null) throw new AckerDBError("unauthenticated", "invalid MCP credential");
    const operationSignal = this.operationSignal(signal);
    return this.verifyMcpToken(mcp, parsed, fairnessKey, operationSignal);
  }

  /** The provider behind a token realm, shared by every endpoint that names it. */
  private mcpProvider(name: string): AnyMcpAuthProvider {
    for (const endpoint of this.registry.mcps.values()) {
      if (endpoint.auth.name === name) return endpoint.auth;
    }
    throw new AckerDBError("not_found", `unknown MCP auth provider "${name}"`);
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
        controller.abort(new AckerDBError("unauthenticated", "credential revoked"));
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
    // `mcp` is the provider name: a token is minted by, and verified against,
    // the provider that owns the scope vocabulary it carries.
    const provider = this.mcpProvider(mcp);
    const scopeDescriptor = provider.scopes;
    const credential = await this.reads.submit(
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

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.assertReady();
    this.sessionStore.open(context);
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch> {
    this.assertReady();
    return this.sessionStore.transitionAuth(transition);
  }

  async subscribe(context: SessionRuntimeContext, request: RuntimeRequest<SubscribeMessage>): Promise<void> {
    const { message } = request;
    await this.sessionStore.run(context, request, "subscription", message.ref, (state) => {
      return this.sessionStore.subscribe(
        state,
        message.id,
        message.ref,
        message.args,
        message.cursor === undefined ? undefined : Object.freeze({ ...message.cursor }),
      );
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async unsubscribe(context: SessionRuntimeContext, request: RuntimeRequest<UnsubscribeMessage>): Promise<void> {
    const { message } = request;
    await this.sessionStore.run(context, request, "subscription", undefined, (state) =>
      this.sessionStore.unsubscribe(state, message.id), {
      identifiers: { requestId: String(message.id), subscriptionId: String(message.id) },
    });
  }

  async reset(context: SessionRuntimeContext, request: RuntimeRequest<ResetRequestMessage>): Promise<void> {
    const { message } = request;
    await this.sessionStore.run(context, request, "subscription", undefined, (state) =>
      this.sessionStore.reset(state, message.id, message.cursor), {
        identifiers: {
          requestId: String(message.id),
          subscriptionId: String(message.id),
        },
      });
  }

  async joinChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelJoinMessage>,
  ): Promise<void> {
    const { message } = request;
    await this.sessionStore.run(
      context,
      request,
      "subscription",
      message.ref,
      async (state, requestBytes) => {
        return this.sessionStore.joinChannel(
          state,
          message.id,
          message.ref,
          message.args,
          Object.hasOwn(message, "room"),
          message.room,
          requestBytes,
        );
      },
      {
        identifiers: {
          requestId: String(message.id),
          subscriptionId: String(message.id),
        },
        successPublication: (publication) => publication,
      },
    ).then(() => {});
  }

  async leaveChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelLeaveMessage>,
  ): Promise<void> {
    const { message } = request;
    await this.sessionStore.run(
      context,
      request,
      "subscription",
      undefined,
      async (state, requestBytes) => {
        await this.sessionStore.leaveChannel(state, message.id, requestBytes);
      },
      {
        identifiers: {
          requestId: String(message.id),
          subscriptionId: String(message.id),
        },
      },
    );
  }

  async sendChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelSendMessage>,
  ): Promise<void> {
    const { message } = request;
    await this.sessionStore.run(
      context,
      request,
      "subscription",
      undefined,
      (state, requestBytes) => {
        return this.sessionStore.sendChannel(
          state,
          message.id,
          message.event,
          message.payload,
          requestBytes,
        );
      },
      {
        identifiers: {
          requestId: String(message.id),
          subscriptionId: String(message.id),
        },
      },
    );
  }

  async query(context: SessionRuntimeContext, request: RuntimeRequest<QueryMessage>): Promise<unknown> {
    const { message } = request;
    let publication: RuntimePublication | undefined;
    return this.sessionStore.run(context, request, "query", message.ref, async (_state, requestBytes) => {
      const signal = this.operationSignal(context.signal);
      const result = await this.executeQuery(
        message.ref,
        message.args,
        context.principal,
        context.fairnessKey,
        signal,
        requestBytes,
      );
      if (!isResult(result)) throw new AckerDBError("internal", "query boundary returned no Result");
      publication = this.sessionStore.prepare(
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
      return await this.sessionStore.run(context, request, "procedure", message.ref, async (_state, requestBytes) => {
        const fn = this.expect(message.ref, "procedure");
        const signal = this.operationSignal(request.signal ?? context.signal);
        throwIfAborted(signal);
        const procedure = this.functions.createProcedureContext(
          context.principal,
          context.fairnessKey,
          signal,
          requestBytes,
          this.readNow(),
          invalidations.publish,
        );
        try {
          const result = await invokeSideEffectingHandler(
            signal,
            "procedure",
            (onAuthorized) =>
              invokeFunction(fn, procedure.value, message.args, { onAuthorized }),
          );
          if (!isResult(result)) throw new AckerDBError("internal", "procedure boundary returned no Result");
          publication = this.sessionStore.prepare(
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
    return this.sessionStore.run(context, request, "mutation", message.ref, async (state, requestBytes) => {
      const fn = this.expect(message.ref, "mutation");
      const signal = this.operationSignal(context.signal);
      let executedPublication: RuntimePublication | undefined;
      const result = await this.functions.commitMutation({
        fairnessKey: context.fairnessKey,
        requestBytes,
        admissionSignal: signal,
        subscriber: state.subscriber,
        idempotency: {
          sessionId: context.clientSessionId,
          requestId: message.mutationRequestId,
          issuedAt: message.issuedAt,
          principalFingerprint: digest(context.principal),
          functionRef: message.ref,
          argsFingerprint: digest(message.args),
        },
        fn,
        principal: context.principal,
        args: message.args,
        validate: (value, version, _writes, publication) => {
          executedPublication = this.sessionStore.prepare(
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
    await this.sessionStore.close(context);
  }

  /**
   * How every path-addressed call opens: an MCP credential is refused, the
   * transport's provenance is claimed exactly once, and admission, trace, and
   * fairness follow from it. The measured request is the surface's own — the
   * addressed function and its args, no protocol envelope — so the same args
   * cost the same admission bytes whichever kind serves them.
   */
  private claimHttpRequest(
    request: RuntimeExternalRequest,
    kind: ExposedHttpKind,
  ): ClaimedHttpRequest {
    if (request.principal.kind === "mcp") {
      throw new AckerDBError(
        "unauthorized",
        "MCP credentials cannot call AckerDB application functions",
      );
    }
    const provenance = claimHttpRequestProvenance(request);
    return {
      requestBytes: this.admittedRequestBytes(
        { ref: request.address, args: request.args },
        provenance?.bytes,
      ),
      codec: this.httpCodec(request.address),
      claimedTrace: claimHttpTrace(provenance?.trace, kind, request.address, String(request.id)),
      fairnessKey: request.fairnessKey
        ?? callerFairnessKey(request.principal, DIRECT_RUNTIME_SOURCE),
      invalidationScope: provenance?.invalidationScope,
    };
  }

  /**
   * The HTTP entry point for a query. It owns transport concerns only: the
   * evaluation itself is the same transport-free `executeQuery` boundary the
   * WebSocket session uses, so neither path can drift from the other.
   */
  async runQuery(request: RuntimeHttpRequest): Promise<Response> {
    const { requestBytes, codec, claimedTrace, fairnessKey } =
      this.claimHttpRequest(request, "query");
    return this.operations.run(null, "query", request.address, requestBytes, () =>
      this.executeQuery(
        request.address,
        request.args,
        request.principal,
        fairnessKey,
        this.operationSignal(request.signal),
        requestBytes,
      ), {
      identifiers: { requestId: String(request.id) },
      finalize: (outcome) => this.httpResponses.respond(request, codec, "query", outcome),
      claimedTrace,
      fairnessKey,
    });
  }

  /**
   * The HTTP entry point for a mutation. Replay protection is opt-in: given an
   * `Idempotency-Key` the coordinator owns the same replay store the WebSocket
   * protocol uses, and without one the mutation simply executes. The receipt is
   * state at response time — no later durability transition reaches this caller.
   */
  async runMutation(request: RuntimeHttpMutationRequest): Promise<Response> {
    const { requestBytes, codec, claimedTrace, fairnessKey } =
      this.claimHttpRequest(request, "mutation");
    let committed: CommittedHttpMutation | undefined;
    return this.operations.run(null, "mutation", request.address, requestBytes, async () => {
      const fn = this.expect(request.address, "mutation");
      const signal = this.operationSignal(request.signal);
      throwIfAborted(signal);
      let encoded: EncodedHttpBody | undefined;
      const result = await this.functions.commitMutation({
        fairnessKey,
        requestBytes,
        admissionSignal: signal,
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotency: this.httpIdempotency(request, fairnessKey) }),
        fn,
        principal: request.principal,
        args: request.args,
        // Encoding the body is the mutation's last fallible step, so it happens
        // inside the transaction exactly as the session path frames its result:
        // a value that cannot cross this surface, or cannot fit one frame, rolls
        // the write back rather than committing it and answering a failure.
        // `Idempotency-Key` is optional here, so that failure's natural retry
        // would otherwise write twice. `rollbackWhen` has already closed out
        // application errors, which never reach this.
        validate: (value) => {
          if (!isResult(value)) {
            throw new AckerDBError("internal", "mutation boundary returned no Result");
          }
          encoded = this.httpResponses.encodeBody(
            value.data,
            codec.encodeValue,
            "mutation",
            null,
          );
        },
      });
      committed = Object.freeze({
        receipt: Object.freeze({
          commitVersion: result.commitVersion,
          durability: result.durability,
          replay: result.replay,
          obligations: NO_OBLIGATIONS,
        }),
        // Absent for a replay, whose stored bytes this caller never proved, and
        // for an application error, which never reached `validate`.
        ...(encoded === undefined ? {} : { encoded }),
      });
      return restoreMutationResult(result.value);
    }, {
      identifiers: {
        requestId: String(request.id),
        ...(request.idempotencyKey === undefined
          ? {}
          : { mutationId: request.idempotencyKey }),
      },
      synthesizeHandler: false,
      finalize: (outcome) =>
        this.httpResponses.respond(request, codec, "mutation", outcome, committed),
      claimedTrace,
      fairnessKey,
    });
  }

  /**
   * The caller's `Idempotency-Key` becomes a coordinator identity, so the same
   * key replays for that caller alone and conflicts on a different function or
   * different args. `issuedAt` is the key's own UUIDv7 timestamp, which the
   * existing retention window bounds.
   *
   * HTTP has no session, so the caller fingerprint is the fairness key — the
   * runtime's existing durable answer to "which caller is this". It names a
   * user's Identity rather than the credential instance, so a retry carrying a
   * refreshed token still replays instead of writing twice.
   */
  private httpIdempotency(
    request: RuntimeHttpMutationRequest,
    fairnessKey: string,
  ): IdempotencyIdentity {
    const requestId = request.idempotencyKey!;
    let issuedAt: number;
    try {
      issuedAt = uuidV7Timestamp(requestId);
    } catch (cause) {
      throw new AckerDBError("validation", "Idempotency-Key must be a UUIDv7", {
        cause,
        resource: "idempotency",
      });
    }
    return {
      sessionId: fairnessKey,
      requestId,
      issuedAt,
      principalFingerprint: fairnessKey,
      functionRef: request.address,
      argsFingerprint: digest(request.args),
    };
  }

  async runProcedure(request: RuntimeHttpRequest): Promise<Response> {
    const { requestBytes, codec, claimedTrace, fairnessKey, invalidationScope } =
      this.claimHttpRequest(request, "procedure");
    const invalidations = this.procedureInvalidations(request.principal, invalidationScope);
    return this.operations.run(null, "procedure", request.address, requestBytes, async () => {
      const fn = this.expect(request.address, "procedure");
      const signal = this.operationSignal(request.signal);
      throwIfAborted(signal);
      const context = this.functions.createProcedureContext(
        request.principal,
        fairnessKey,
        signal,
        requestBytes,
        this.readNow(),
        invalidations.publish,
      );
      try {
        return await invokeSideEffectingHandler(
          signal,
          "procedure",
          (onAuthorized) =>
            invokeFunction(fn, context.value, request.args, { onAuthorized }),
        );
      } finally {
        context.release();
      }
    }, {
      identifiers: { requestId: String(request.id) },
      finalize: (outcome) => {
        try {
          return this.httpResponses.respond(request, codec, "procedure", outcome);
        } finally {
          invalidations.finish();
        }
      },
      claimedTrace,
      fairnessKey,
    });
  }

  private runSystem<R>(
    name: string,
    work: (ctx: SystemCtx) => R | PromiseLike<R>,
    options: SystemRunOptions | undefined,
  ): Promise<Awaited<R>> {
    if (!isSystemOperationName(name)) {
      return Promise.reject(new TypeError(
        "system operation name must contain at most 128 letters, digits, dots, colons, hyphens, or underscores, with every segment starting with a letter and no UUID segments",
      ));
    }
    const signal = AbortSignal.any([
      this.shutdownController.signal,
      this.systemDrainController.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    const writerOwnedByCaller = inTransaction();
    try {
      throwIfAborted(signal);
    } catch (error) {
      if (this.telemetry.enabled) {
        this.telemetry.recordSpan({
          operation: "system",
          stage: "admission",
          outcome: outcomeFromError(error).code,
          functionName: name,
          resource: "operation",
          durationMs: 0,
          sizeBytes: 1,
        });
      }
      return Promise.reject(error);
    }
    return this.systemRoot(() => this.operations.run(
      null,
      "system",
      name,
      1,
      async () => {
        const context = this.functions.createProcedureContext(
          SYSTEM_PRINCIPAL,
          SYSTEM_FAIRNESS_KEY,
          signal,
          1,
          this.readNow(),
          this.immediateProcedureInvalidations.publish,
        );
        const startedAt = this.telemetry.enabled ? performance.now() : 0;
        try {
          const value = await invokeSideEffectingHandler(
            signal,
            "system callback",
            (onAuthorized) => runInInvocationRoot(
              SYSTEM_PRINCIPAL,
              () => {
                onAuthorized();
                return work(context.value as SystemCtx);
              },
              writerOwnedByCaller,
            ),
          );
          if (this.telemetry.enabled) {
            this.tracing.span({
              stage: "handler",
              outcome: isResult(value) && !value.ok ? "application_error" : "ok",
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes: 1,
            }, "system");
          }
          return value;
        } catch (error) {
          if (this.telemetry.enabled) {
            this.tracing.span({
              stage: "handler",
              outcome: outcomeFromError(error).code,
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes: 1,
            }, "system");
          }
          throw error;
        } finally {
          context.release();
        }
      },
      {
        fairnessKey: SYSTEM_FAIRNESS_KEY,
        synthesizeHandler: false,
      },
    ));
  }

  /** The single deep MCP execution path used by every present and future adapter. */
  async runMcpTool(request: RuntimeMcpToolRequest): Promise<McpCallToolResult> {
    const provenance = claimHttpRequestProvenance(request);
    const tool = authorizedMcpTool(request.authorization);
    const requestBytes = this.admittedRequestBytes({
      jsonrpc: "2.0",
      id: request.id,
      method: "tools/call",
      params: { name: tool.name, arguments: request.args },
    }, provenance?.bytes);
    const functionName = `${tool.mcp.name}:${tool.name}`;
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
    return this.operations.run(null, "procedure", functionName, requestBytes, async () => {
      const signal = this.operationSignal(request.signal);
      return this.dispatchMcpTool(
        tool,
        request.args,
        this.functions.createMcpTransactionContext(
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
  authorizeMcpTool(
    mcp: string,
    name: string,
    principal: Principal,
  ): RuntimeMcpToolAuthorization {
    const endpoint = this.registry.mcps.get(mcp);
    // A token is bound to the provider, not to one endpoint: two endpoints
    // sharing a provider accept the same credentials and scopes are the only
    // thing separating them.
    const providerMatches = principal.kind !== "mcp" ||
      (endpoint !== undefined && principal.mcp === endpoint.auth.name);
    const tool = providerMatches ? this.registry.mcpTool(mcp, name) : undefined;
    // `mcpLocalGrant` returns undefined only when no local authority is active,
    // which is exactly "this call came from outside the app". EMPTY_SCOPES means
    // a local authority exists for a *different* principal or endpoint, and that
    // must count as remote: otherwise one endpoint's AI context could reach
    // another's private tool whenever its access is public or authenticated.
    const grant = tool === undefined ? undefined : mcpLocalGrant(principal, tool.mcp);
    const local = grant !== undefined && grant.length > 0;
    if (
      tool !== undefined &&
      !(tool.private && !local) &&
      isMcpToolAuthorized(tool.accessPolicy, principal, grant)
    ) return mcpToolAuthorization(tool);
    if (principal.kind === "anonymous") {
      return mcpToolAuthorizationFailure(
        new AckerDBError("unauthenticated", "authentication required"),
      );
    }
    // A private tool refused from outside answers exactly as a missing one, so
    // discovery cannot be used to enumerate what the app keeps to itself. Every
    // other refusal keeps saying "denied": the endpoint is discoverable anyway,
    // and hiding it would only make a real misconfiguration harder to read.
    if (tool !== undefined && tool.private && !local) {
      return mcpToolAuthorizationFailure(new AckerDBError("not_found", "MCP tool not found"));
    }
    if (!providerMatches || tool !== undefined) {
      return mcpToolAuthorizationFailure(new AckerDBError("unauthorized", "access denied"));
    }
    return mcpToolAuthorizationFailure(new AckerDBError("not_found", "MCP tool not found"));
  }

  private async dispatchMcpTool(
    tool: AnyRegisteredMcpTool,
    args: unknown,
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): Promise<McpCallToolResult> {
    const toolContext = Object.freeze({
      auth: context.auth,
      abortSignal: context.abortSignal,
      timestamp: context.timestamp,
    });
    const release = bindMcpAiContext(
      toolContext,
      this.mcpAiCapability(toolContext, fairnessKey, requestBytes),
    );
    try {
      throwIfAborted(toolContext.abortSignal);
      const result = await runInInvocationRoot(
        toolContext.auth,
        () => this.executeMcpTool(
          tool,
          tool.codec.decodeArgs(args),
          toolContext,
          fairnessKey,
          requestBytes,
        ),
      );
      const finalized = finalizeMcpToolResult(tool, result);
      if (toolContext.abortSignal.aborted) {
        throw canceledHandlerOutcome(
          toolContext.abortSignal,
          "MCP tool",
          toolContext.abortSignal.reason,
        );
      }
      return finalized;
    } finally {
      release();
    }
  }

  /**
   * A tool executes as the kind it is. A query gets a read transaction and a
   * `ctx.db` reader; a mutation goes through the one commit every write goes
   * through; a procedure gets a procedure context. There is no MCP-specific
   * execution path, which is the whole point of a tool being a function.
   *
   * A mutation's receipt is discarded rather than smuggled into `_meta`: an MCP
   * caller holds no subscriptions, so it owes no convergence obligation.
   */
  private async executeMcpTool(
    tool: AnyRegisteredMcpTool,
    args: unknown,
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): Promise<Result<unknown, unknown>> {
    const fn = tool.fn;
    const signal = this.operationSignal(context.abortSignal);
    throwIfAborted(signal);
    if (fn.kind === "query") {
      const value = await this.reads.execute(
        "query",
        fairnessKey,
        signal,
        requestBytes,
        null,
        (execution) => this.functions.invokeQuery(fn, args, context.auth, execution),
      );
      return this.expectMcpResult(tool, value);
    }
    if (fn.kind === "mutation") {
      const committed = await this.functions.commitMutation({
        fairnessKey,
        requestBytes,
        admissionSignal: signal,
        fn,
        principal: context.auth,
        args,
      });
      return restoreMutationResult(committed.value);
    }
    const procedure = this.functions.createProcedureContext(
      context.auth,
      fairnessKey,
      signal,
      requestBytes,
      context.timestamp,
      this.immediateProcedureInvalidations.publish,
    );
    try {
      const value = await invokeSideEffectingHandler(
        signal,
        "MCP tool",
        (onAuthorized) => invokeFunction(fn, procedure.value, args, { onAuthorized }),
      );
      return this.expectMcpResult(tool, value);
    } finally {
      procedure.release();
    }
  }

  private expectMcpResult(
    tool: AnyRegisteredMcpTool,
    value: unknown,
  ): Result<unknown, unknown> {
    if (!isResult(value)) {
      throw new AckerDBError(
        "internal",
        `MCP tool "${tool.name}" boundary returned no Result`,
      );
    }
    return value;
  }

  private recordHttpResponseFailure(
    error: unknown,
    operation: HttpValueOperation,
    stage: "encoding" | "delivery",
  ): void {
    if (!this.telemetry.enabled) return;
    const scope = this.tracing.currentScope();
    const invocation = currentInvocationTelemetryContext();
    const functionName = invocation === undefined
      ? scope?.rootFunction
      : this.registry.invocationNameOf(invocation.fn) ?? scope?.rootFunction;
    this.tracing.event({
      name: "failure",
      level: "error",
      operation,
      stage,
      outcome: outcomeFromError(error).code,
      ...(functionName === undefined ? {} : { functionName }),
      resource: "operation",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  }

  async runSse(request: RuntimeSseRequest): Promise<RuntimeSseResponse> {
    const { requestBytes, codec, claimedTrace, fairnessKey } = this.claimHttpRequest(request, "sse");
    const runtimeScope = this.tracing.open(
      undefined,
      "sse",
      request.address,
      { requestId: String(request.id) },
      claimedTrace?.context,
    );
    const observedScope = this.telemetry.enabled ? runtimeScope : undefined;
    let traceFinished = false;
    const finishOperationTrace = (): void => {
      if (traceFinished) return;
      traceFinished = true;
      if (claimedTrace !== undefined) {
        finishClaimedHttpTrace(claimedTrace);
        return;
      }
      if (observedScope !== undefined) {
        this.telemetry[FINISH_OPERATION_TRACE](observedScope.trace);
      }
    };
    const admittedAt = observedScope === undefined ? 0 : performance.now();
    let release: () => void;
    try {
      release = this.admitOperation(null, fairnessKey).release;
      if (observedScope !== undefined) {
        this.telemetry[RECORD_OPERATION_SPAN](
          observedScope.trace,
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
      if (observedScope !== undefined) {
        const outcome = outcomeFromError(safeError).code;
        this.telemetry[RECORD_OPERATION_SPAN](
          observedScope.trace,
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
    const startedAt = observedScope === undefined ? 0 : performance.now();
    const execute = async (): Promise<RuntimeSseResponse> => {
      let producer: BoundedSseProducer | null = null;
      let streamId: string | null = null;
      let lifecycle: Promise<void> | null = null;
      let procedure: OwnedProcedureContext | null = null;
      let deliveryObserver: DeliveryObserver | undefined;
      try {
        const fn = this.expect(request.address, "sse") as AnyRegisteredSse;
        if (fn.yields === undefined) {
          throw new AckerDBError("internal", `sse "${request.address}" has no yields validator`);
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
        procedure = this.functions.createProcedureContext(
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
            const source = validatedSseSource(codec, result, handlerContext);
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
          if (observedScope !== undefined) {
            const safeError = transportError(error);
            this.tracing.event({
              name: "failure",
              level: "error",
              operation: "sse",
              outcome: outcomeFromError(safeError).code,
              functionName: request.address,
              errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
            }, observedScope);
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
        if (observedScope !== undefined) {
          const outcome = outcomeFromError(safeError).code;
          if (observedScope.invocations === 0) {
            this.tracing.span({
              operation: "sse",
              stage: "handler",
              outcome,
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes: requestBytes,
            }, "sse");
          }
          this.tracing.event({
            name: outcome === "overloaded" ? "overload" : "failure",
            level: outcome === "overloaded" ? "warn" : "error",
            operation: "sse",
            outcome,
            functionName: request.address,
            errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
          }, observedScope);
        }
        throw safeError;
      }
    };
    return this.tracing.runOperation(runtimeScope, execute);
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
    const execution = this.operations.run(null, "scheduled", undefined, 1, async () => {
      let handled = 0;
      for (let attempts = 0; attempts < this.limits.schedulerBatchSize; attempts++) {
        const candidate = await this.schedulerCandidates.next(now);
        if (candidate === null) break;
        if (await this.functions.executeScheduledMutation(
          candidate,
          now,
          this.shutdownController.signal,
        )) handled++;
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
    void this.schedulerCandidates.nextAt().then(
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
      connections: this.sessionStore.size,
      activeOperations: this.activeOperations,
      activeOperationCallers: this.externalOperations.size,
      activeSse: this.sseProducers.size,
      realtime: this.realtime?.snapshot() ?? null,
      scheduledHandlers: this.scheduled.size,
      schedulerArmed: this.schedulerTimer !== null,
      reader: this.reads.snapshot(),
      writer: this.functions.snapshot(),
      reactive: this.reactive.snapshot(),
      publication: this.reactive.publication.snapshot(),
      authCaptureBudget: this.authCaptureBudget.snapshot(),
      sseBudget: this.sseBudget.snapshot(),
      telemetry: this.telemetry.snapshot(),
      telemetryAggregates: this.telemetry.aggregateSnapshot(),
      telemetryJournal: this.telemetryJournal.snapshot(),
      telemetryExporters: this.telemetryExporters?.snapshot() ?? null,
      storage: this.engine.status(),
    });
  }

  realtimeDiagnostic(
    sessionId: string,
    owner: string,
  ): Promise<RealtimePeerDiagnostic> {
    if (this.realtime === undefined) {
      return Promise.reject(
        new AckerDBError("not_found", "realtime service is not configured"),
      );
    }
    return this.realtime.diagnostic(sessionId, owner);
  }

  drain(deadlineAtMs = Date.now() + this.limits.gracefulShutdownMs): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (!Number.isFinite(deadlineAtMs)) {
      throw new RangeError("runtime shutdown deadline must be finite");
    }
    this.lifecycle = "draining";
    this.releaseTelemetryJournalFailure();
    this.schedulerGeneration++;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    this.sampler.stop();
    this.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "draining",
    });
    const draining = new AckerDBError("draining", "runtime is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "operation",
    });
    this.systemDrainController.abort(draining);
    const sessionDrains = [...this.sessionStore.values()].map((state) => this.sessionStore.startClose(state));
    const realtimeDrain = this.realtime?.drain() ?? Promise.resolve();
    for (const producer of this.sseProducers.values()) producer.fail(draining);

    // Close every internal admission boundary before the first await. Existing
    // handlers get one finite grace period; queued and future work cannot grow.
    this.functions.close();
    this.reads.close();
    if (this.ownsTelemetry) this.telemetry.stop();
    const reactiveDrain = this.reactive.close();
    let deadlineReached = false;
    const coreShutdown = (async () => {
      const settled = await Promise.allSettled([
        this.waitForActiveOperations(),
        this.functions.drain(),
        reactiveDrain,
        this.reads.drain(),
        realtimeDrain,
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
    const shutdownWork = coreShutdown.then(async () => {
      // A core that outlives the Runtime deadline must not start a detached
      // telemetry tail after drain has already failed.
      if (deadlineReached) return;
      this.deliveryTelemetry.flush();
      this.telemetry.recordEvent({
        name: "lifecycle",
        level: "info",
        operation: "lifecycle",
        lifecycleState: "stopped",
      });
      await this.telemetryExporters?.drain();
      if (this.ownsTelemetryJournal) await this.telemetryJournal.drain();
      else await this.telemetryJournal.flush();
      return this.ownsTelemetry ? this.telemetry.drain(deadlineAtMs) : this.telemetry.flush();
    });

    const deadlineError = new AckerDBError(
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
        const cleanupErrors: unknown[] = [];
        try {
          await this.telemetryExporters?.drain();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          if (this.ownsTelemetryJournal) await this.telemetryJournal.drain();
          else await this.telemetryJournal.flush();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        if (this.ownsTelemetry) {
          try {
            await this.telemetry.drain(deadlineAtMs);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length === 0) throw error;
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Runtime shutdown and telemetry cleanup both failed",
        );
      },
    );
    return this.drainPromise;
  }

  /**
   * The exposed function's compiled standard-JSON boundary. Every HTTP entry
   * point serves the exposed surface, so a function without one has no HTTP
   * form at all — the same answer the listener gives an unexposed path.
   */
  private httpCodec(address: string): ExposedHttpCodec {
    const exposed = this.registry.exposedFunction(address);
    if (exposed === undefined) {
      throw new AckerDBError("not_found", `"${address}" is not exposed over HTTP`);
    }
    return exposed.codec;
  }

  private expect(address: string, kind: "query" | "mutation" | "procedure" | "sse"): AnyRegistered {
    const fn = this.registry.get(address);
    if (fn === undefined) throw new AckerDBError("not_found", `unknown function "${address}"`);
    if (fn.kind !== kind) {
      throw new AckerDBError("validation", `"${address}" is a ${fn.kind}, expected a ${kind}`);
    }
    return fn;
  }

  private realtimeApplication() {
    return createRealtimeRuntimeApplication({
      addressOf: (definition) => this.registry.addressOf(definition),
      createAuthorizationContext: (
        principal,
        fairnessKey,
        signal,
        requestBytes,
      ) => this.functions.createProcedureContext(
        principal,
        fairnessKey,
        signal,
        requestBytes,
        this.readNow(),
        this.immediateProcedureInvalidations.publish,
      ),
      createSessionContext: (principal, fairnessKey, signal) => {
        const invalidations = this.immediateProcedureInvalidations;
        const owned = this.functions.createProcedureContext(
          principal,
          fairnessKey,
          signal,
          1,
          () => this.readNow(),
          invalidations.publish,
        );
        return Object.freeze({
          value: owned.value,
          release: () => {
            owned.release();
            invalidations.finish();
          },
        });
      },
      run: (
        address,
        fairnessKey,
        signal,
        requestBytes,
        work,
      ) => this.operations.run(
        null,
        "realtime",
        address,
        requestBytes,
        work,
        {
          fairnessKey,
          synthesizeHandler: false,
          abortSignal: signal,
        },
      ),
    });
  }

  private channelProcedureContext(
    state: RuntimeSession,
    signal: AbortSignal,
    requestBytes: number,
  ): OwnedProcedureContext {
    const invalidations = this.procedureInvalidations(
      state.context.principal,
      state.context.invalidationScope,
    );
    const procedure = this.functions.createProcedureContext(
      state.context.principal,
      state.context.fairnessKey,
      signal,
      requestBytes,
      this.readNow(),
      invalidations.publish,
    );
    let active = true;
    return Object.freeze({
      value: procedure.value,
      release: () => {
        if (!active) return;
        active = false;
        try {
          procedure.release();
        } finally {
          invalidations.finish();
        }
      },
    });
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
    return this.reads.execute(
      "query",
      fairnessKey,
      signal,
      requestBytes,
      null,
      (execution) => this.functions.invokeQuery(fn, args, principal, execution),
    );
  }

  private evaluateSubscription(
    input: QueryEvaluationInput<RuntimeReactiveContext>,
  ): Promise<QueryEvaluation> {
    const execute = () => {
      const fn = this.expect(input.address, "query");
      const readSet = new Set<string>();
      const reads: ReadRecorder = { add: (key) => readSet.add(key) };
      return this.reads.execute(
        "subscription",
        input.fairnessKey,
        this.shutdownController.signal,
        byteLength(input.args),
        reads,
        async (execution, commitVersion) => {
          const value = await this.functions.invokeQuery(
            fn,
            input.args,
            input.context.principal,
            execution,
          );
          return Object.freeze({ value, readSet, commitVersion });
        },
      ).then((execution) => this.encodeQueryEvaluation(execution));
    };
    const scope = this.tracing.currentScope();
    if (scope === undefined) {
      const evaluationScope = this.tracing.open(
        undefined,
        "subscription",
        input.address,
        {},
      );
      const evaluation = this.tracing.runOperation(evaluationScope, execute);
      return evaluation.finally(() => {
        this.telemetry[FINISH_OPERATION_TRACE](evaluationScope.trace);
      });
    }
    return this.tracing.runScope({
      ...scope,
      operation: "subscription",
      rootFunction: input.address,
    }, execute);
  }

  private encodeQueryEvaluation(execution: QueryExecution): QueryEvaluation {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    try {
      if (!isResult(execution.value)) {
        throw new AckerDBError("internal", "subscription query boundary returned no Result");
      }
      const wireValue = execution.value.ok
        ? execution.value.data
        : execution.value.error;
      const encoded = encode(wireValue);
      if (this.telemetry.enabled) {
        this.tracing.span({
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
        this.tracing.span({
          stage: "encoding",
          outcome: outcomeFromError(transportError(error)).code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
        }, "subscription");
      }
      throw error;
    }
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
        () => {
          const authorization = this.authorizeMcpTool(mcp.name, tool.name, context.auth);
          return this.dispatchMcpTool(
            authorizedMcpTool(authorization),
            args,
            this.functions.createMcpTransactionContext(
              context.auth,
              fairnessKey,
              signal,
              requestBytes,
              context.timestamp,
            ),
            fairnessKey,
            requestBytes,
          );
        },
      ),
    } satisfies McpAiRuntimeCapability);
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
      publication = this.sessionStore.prepare(this.mutationFrame(
        message,
        value,
        result.commitVersion,
        result.durability,
        result.replay,
        obligations,
      ), "mutation result");
    } else if (result.replay === "replayed") {
      try {
        publication = this.sessionStore.prepare(this.mutationFrame(
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
    if (!isResult(value)) throw new AckerDBError("internal", "mutation boundary returned no Result");
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
      throw new AckerDBError("convergence_unavailable", "mutation committed but subscription convergence failed", {
        committed: true,
        cause: failure.error,
      });
    }
  }

  readonly [CAPTURE_DELIVERY_OBSERVER] = (
    lane: OutboundLane = "application",
    clientSessionId?: string,
  ): DeliveryObserver | undefined =>
    this.deliveryTelemetry.capture(lane, clientSessionId);

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
      throw new AckerDBError("overloaded", "per-caller operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    if (this.activeOperations >= this.limits.maxOperations) {
      throw new AckerDBError("overloaded", "operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    const sessionAdmission = session === null
      ? undefined
      : this.sessionStore.admit(session, sessionOrder);
    this.activeOperations++;
    if (fairnessKey !== undefined) this.externalOperations.set(fairnessKey, callerOperations + 1);

    let active = true;
    return {
      predecessor: sessionAdmission?.predecessor,
      release: () => {
        if (!active) return;
        active = false;
        sessionAdmission?.release();
        this.activeOperations--;
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
      throw new AckerDBError("draining", "runtime is not accepting operations", {
        retryable: true,
        retryAfterMs: DRAIN_RETRY_AFTER_MS,
        resource: "operation",
      });
    }
    throw new AckerDBError("unavailable", "runtime is not available", { resource: "operation" });
  }

  /** Trusts only package-owned transport provenance; direct callers are re-encoded canonically. */
  private admittedRequestBytes(request: unknown, receivedBytes?: number): number {
    let bytes = receivedBytes;
    if (bytes === undefined) {
      try {
        bytes = byteLength(request);
      } catch (cause) {
        throw new AckerDBError("validation", "request is not wire-representable", { cause });
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
      throw new AckerDBError("overloaded", "request exceeds maxRequestBytes", {
        resource: "operation",
      });
    }
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.shutdownController.signal
      : AbortSignal.any([signal, this.shutdownController.signal]);
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}
