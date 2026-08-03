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
  uuidV7Timestamp,
  type ApplicationErrorMessage,
  type ChannelEventMessage,
  type ChannelJoinMessage,
  type ChannelLeaveMessage,
  type ChannelReadyMessage,
  type ChannelRejectedMessage,
  type ChannelSendMessage,
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
} from "@ackerdb/core";
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
  type CommitRequest,
  type CommitResult,
  type IdempotencyIdentity,
} from "./coordinator.ts";
import type { Identity } from "../validation/v.ts";
import type { ExposedHttpCodec } from "../transport/http-codec.ts";
import type { ExposedHttpKind } from "../transport/http-surface.ts";
import {
  makeDbReader,
  type ReadRecorder,
  type WriteCollector,
} from "../database/access.ts";
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
  MutationCtx,
  OwnedProcedureContext,
  ProcedureCtx,
  QueryCtx,
  SseCtx,
  SseSource,
  TxCtx,
} from "../app/functions.ts";
import {
  isSystemOperationName,
  type SystemCtx,
  type SystemRunner,
  type SystemRunOptions,
} from "../app/system.ts";
import {
  authorizeInvocation,
  currentInvocationTelemetryContext,
  invokeFunction,
  poisonCurrentInvocation,
} from "../app/invocation.ts";
import {
  assertWriterAvailable,
  runInInvocationRoot,
  withTransactionAnalytics,
  withMutationAccess,
} from "./invocation-state.ts";
import { createMutationInvocationScope } from "./mutation-scope.ts";
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
import { withMcpTokenContext as withMcpTokenCapability } from "../mcp/token-context.ts";
import {
  McpTokenInvalidationBoundary,
  takeMcpTokenInvalidations,
} from "../mcp/token-invalidation.ts";
import { mcpTokenVaultOwner } from "../mcp/token-vault.ts";
import { emitWriteKeys } from "../database/keys.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import { outcomeFromError } from "./outcome.ts";
import {
  PluginRuntime,
  type PluginInvocationCapabilities,
  type PluginReadExecution,
  type PluginWriteExecution,
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
  type ChannelSessionAdapter,
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
import type {
  AnalyticsEventRecord,
  ApplicationLogger,
} from "../telemetry/application-signals/types.ts";
import {
  TelemetryJournalExporters,
  validateTelemetryJournalExportersOptions,
} from "../telemetry/application-signals/exporters.ts";
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
} from "../subscriptions/session.ts";
import {
  canceledHandlerOutcome,
  invokeSideEffectingHandler,
} from "./side-effecting-handler.ts";
import type { RuntimeHooks, RuntimeLifecycleState } from "./contracts/lifecycle.ts";
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
import {
  RuntimeTraceBridge,
  type RuntimeTraceIdentifiers as TraceIdentifiers,
} from "./telemetry/trace-bridge.ts";
import {
  RuntimeOperationRunner,
  transportError,
  type OperationAdmission,
  type RuntimeOperationOutcome,
  type SessionOperationOrder,
} from "./execution/operation-runner.ts";
import { RuntimeReadExecutor } from "./execution/read.ts";
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
  type AuthTransitionCapture,
  type RuntimeSession,
} from "./sessions/store.ts";
import { RuntimeSampler } from "./telemetry/sampler.ts";
import { RuntimeDeliveryTelemetry } from "./telemetry/delivery-observer.ts";
import {
  RuntimeScheduledCandidates,
  quoteSqlIdentifier,
} from "./scheduler/candidate.ts";

const utf8 = new TextEncoder();
const SCHEDULER_RETRY_MS = 1_000;
const STALE_SCHEDULED_CANDIDATE = Symbol("staleScheduledCandidate");
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

interface ReactiveContext {
  readonly principal: Principal;
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
interface RuntimeCommitRequest<T> {
  readonly operation: "mutation" | "transaction";
  readonly fairnessKey: string;
  readonly requestBytes: number;
  /** Cancels this work only while it is waiting for the single writer. */
  readonly admissionSignal: AbortSignal;
  /** Cancels a request-owned transaction before BEGIN or COMMIT. */
  readonly transactionSignal?: AbortSignal;
  readonly idempotency?: IdempotencyIdentity;
  /** The caller whose own live queries the publication must name; HTTP callers hold none. */
  readonly subscriber?: Subscriber;
  readonly work: (db: MutationCtx["db"], writes: WriteCollector) => T | Promise<T>;
  readonly validate?: CommitRequest<T, ReactiveCommit>["validate"];
}

interface SessionOperationOptions<T> {
  readonly identifiers?: TraceIdentifiers;
  readonly synthesizeHandler?: boolean;
  readonly successPublication?: (value: T) => RuntimePublication;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const releaseNothing = (): void => {};

function byteLength(value: unknown): number {
  return utf8.encode(encode(value)).byteLength;
}

function snapshotValue(value: unknown): unknown {
  return decode(encode(value));
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
  readonly reactive: OrderedReactive<ReactiveContext>;
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
  private readonly schedulerCandidates: RuntimeScheduledCandidates;
  private readonly coordinator: CommitCoordinator<ReactiveCommit>;
  private readonly scheduled: Map<string, string>;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly authCaptureBudget: OutboundBudget;
  private readonly sseBudget: OutboundBudget;
  private readonly sseProducers = new Map<string, BoundedSseProducer>();
  private readonly externalOperations = new Map<string, number>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly analyticsByWrites = new WeakMap<WriteCollector, AnalyticsEventRecord[]>();
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
    this.reactive = new OrderedReactive<ReactiveContext>({
      limits: this.limits,
      initialVersion: this.engine.commitVersion(),
      now: this.now,
      evaluate: (input) => this.evaluateSubscription(input),
      ...(this.telemetry.enabled ? { observer: this.tracing.observeReactive } : {}),
    });
    this.coordinator = new CommitCoordinator({
      engine: this.engine,
      limits: this.limits,
      reservePublication: (bytes) => this.reactive.publication.reserve(bytes),
      afterCommit: (writes: WriteCollector, commitVersion: bigint) => {
        if (this.hasMcpCapabilities) {
          for (const invalidation of takeMcpTokenInvalidations(writes)) {
            this.mcpTokenInvalidation.publish(invalidation);
          }
        }
        const analytics = this.analyticsByWrites.get(writes);
        if (analytics !== undefined) {
          this.analyticsByWrites.delete(writes);
          this.applicationSignals.commitAnalytics(analytics, commitVersion);
        }
      },
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
    this.sessionStore = new RuntimeSessionStore({
      limits: this.limits,
      ...(this.telemetry.enabled
        ? { telemetryConnectionId: (clientSessionId) => digest(clientSessionId) }
        : {}),
      createSubscriber: (state, authEpoch) =>
        this.makeSubscriber(state, authEpoch),
      createChannelAdapter: (state) => this.makeChannelAdapter(state),
      disconnectChannels: (adapter) =>
        this.channels.disconnect(adapter, "disconnect"),
      disconnectSubscriber: (subscriber) => this.reactive.disconnect(subscriber),
      releaseCapture: (capture) => this.releaseCapture(capture),
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
        writer: this.coordinator.snapshot(),
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
      async () => {
        const existing = await this.reads.submit(
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

  private async linkAccount(
    principal: Principal,
    rawBearerToken: string,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): Promise<void> {
    if (principal.kind !== "user") {
      throw new AckerDBError("unauthorized", "account linking requires a user identity");
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
          throw new AckerDBError("unauthenticated", "invalid credential");
        }
        if (!this.engine.attachIdentityAccount(
          principal.identity,
          account.issuer,
          account.subject,
        )) {
          throw new AckerDBError("conflict", "external account is already linked");
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
      throw new AckerDBError("unauthorized", "account unlinking requires ownership");
    }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.issuer !== "string" ||
      candidate.issuer.length === 0 ||
      typeof candidate.subject !== "string" ||
      candidate.subject.length === 0
    ) {
      throw new AckerDBError("validation", "external account must have an issuer and subject");
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
      throw new AckerDBError("unauthorized", "account unlinking requires ownership");
    }
    if (result === "last_account") {
      throw new AckerDBError("conflict", "cannot unlink the final external account");
    }
  }

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.assertReady();
    this.sessionStore.open(context);
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch> {
    this.assertReady();
    const state = this.sessionStore.current(transition.from, true);
    return this.operations.run(state, "subscription", undefined, 1, async () => {
      if (
        transition.to.clientSessionId !== transition.from.clientSessionId ||
        transition.to.authEpoch !== transition.from.authEpoch + 1
      ) {
        throw new AckerDBError("validation", "authentication transition is not monotonic");
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
        const channels = this.channels.descriptions(state.channelAdapter);
        await this.channels.disconnect(
          state.channelAdapter,
          "authentication-change",
        );
        const rotation = await this.reactive.rotateAuth(state.subscriber, transition.to.authEpoch);
        if (rotation.deliveryFailures.length > 0) {
          throw new AckerDBError("unavailable", "subscription revocation could not be delivered", {
            resource: "subscription",
            cause: rotation.deliveryFailures[0]?.error,
          });
        }
        if (
          state.capture !== captured ||
          this.sessionStore.get(transition.from.clientSessionId) !== state
        ) {
          throw new AckerDBError("auth_stale", "authentication state changed");
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
        for (const definition of channels) {
          try {
            const publication = await this.attachChannel(
              state,
              definition.id,
              definition.address,
              definition.args,
              definition.hasRoom,
              definition.room,
              byteLength(definition),
            );
            this.captureFrame(captured, publication);
          } catch (error) {
            this.sessionStore.releaseSubscription(state, definition.id, "channel");
            this.captureFrame(captured, this.prepareFrame({
              v: PROTOCOL_VERSION,
              t: "err",
              id: definition.id,
              outcome: outcomeFromError(transportError(error)),
            }, "channel frame", "subscription"));
          }
        }
        return this.finishCapture(captured);
      } catch (error) {
        // A failed transition is terminal, but ownership stays attached until
        // this and every other already-admitted operation have finalized.
        void this.sessionStore.startClose(state);
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
      this.sessionStore.claimSubscription(state, message.id, "reactive");
      try {
        await this.attachSubscription(
          state,
          message.id,
          message.ref,
          snapshotValue(message.args),
          message.cursor === undefined ? undefined : Object.freeze({ ...message.cursor }),
        );
      } catch (error) {
        this.sessionStore.releaseSubscription(state, message.id, "reactive");
        throw error;
      }
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async unsubscribe(context: SessionRuntimeContext, request: RuntimeRequest<UnsubscribeMessage>): Promise<void> {
    const { message } = request;
    await this.runSessionOperation(context, request, "subscription", undefined, (state) => {
      this.sessionStore.expectSubscription(state, message.id, "reactive");
      this.reactive.unsubscribe(state.subscriber, message.id);
      this.sessionStore.releaseSubscription(state, message.id, "reactive");
    }, { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } });
  }

  async reset(context: SessionRuntimeContext, request: RuntimeRequest<ResetRequestMessage>): Promise<void> {
    const { message } = request;
    await this.runSessionOperation(context, request, "subscription", undefined, (state) => {
      this.sessionStore.expectSubscription(state, message.id, "reactive");
      return this.reactive.reset(state.subscriber, message.id, message.cursor);
    }, {
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
    await this.runSessionOperation(
      context,
      request,
      "subscription",
      message.ref,
      async (state, requestBytes) => {
        this.sessionStore.claimSubscription(state, message.id, "channel");
        try {
          return await this.attachChannel(
            state,
            message.id,
            message.ref,
            snapshotValue(message.args),
            Object.hasOwn(message, "room"),
            message.room,
            requestBytes,
          );
        } catch (error) {
          this.sessionStore.releaseSubscription(state, message.id, "channel");
          throw error;
        }
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
    await this.runSessionOperation(
      context,
      request,
      "subscription",
      undefined,
      async (state, requestBytes) => {
        this.sessionStore.expectSubscription(state, message.id, "channel");
        await this.channels.leave(
          state.channelAdapter,
          message.id,
          "leave",
          requestBytes,
        );
        this.sessionStore.releaseSubscription(state, message.id, "channel");
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
    await this.runSessionOperation(
      context,
      request,
      "subscription",
      undefined,
      (state, requestBytes) => {
        this.sessionStore.expectSubscription(state, message.id, "channel");
        return this.channels.handle(
          state.channelAdapter,
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
      if (!isResult(result)) throw new AckerDBError("internal", "query boundary returned no Result");
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
          const result = await invokeSideEffectingHandler(
            signal,
            "procedure",
            (onAuthorized) =>
              invokeFunction(fn, procedure.value, message.args, { onAuthorized }),
          );
          if (!isResult(result)) throw new AckerDBError("internal", "procedure boundary returned no Result");
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
      let executedPublication: RuntimePublication | undefined;
      const result = await this.commitWrite({
        operation: "mutation",
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
        work: this.mutationWork(fn, context.principal, message.args),
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
      const result = await this.commitWrite({
        operation: "mutation",
        fairnessKey,
        requestBytes,
        admissionSignal: signal,
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotency: this.httpIdempotency(request, fairnessKey) }),
        work: this.mutationWork(fn, request.principal, request.args),
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
      const context = this.procedureContext(
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
        const context = this.procedureContext(
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
        (execution) => this.invokeQuery(fn, args, context.auth, execution),
      );
      return this.expectMcpResult(tool, value);
    }
    if (fn.kind === "mutation") {
      const committed = await this.commitWrite({
        operation: "mutation",
        fairnessKey,
        requestBytes,
        admissionSignal: signal,
        work: this.mutationWork(fn, context.auth, args),
      });
      return restoreMutationResult(committed.value);
    }
    const procedure = this.procedureContext(
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
        let row: Record<string, unknown> | null = null;
        try {
          await this.coordinator.execute({
            operation: "scheduled",
            fairnessKey: "system:scheduler",
            requestBytes: 1,
            admissionSignal: this.shutdownController.signal,
            ...(this.telemetry.enabled
              ? {
                  telemetry: this.tracing.observeCommit,
                  statementTelemetry: this.tracing.observeStatement,
                  run: AsyncLocalStorage.snapshot(),
                }
              : {}),
            work: (db, writes) => this.withStagedAnalytics(writes, async () => {
              const plan = this.engine.plan(candidate.table);
              const raw = this.tracing.measureStatement("read", candidate.table, "scheduledGet", () =>
                this.engine.writer.query(
                  `SELECT ${plan.readProjection} FROM ${quoteSqlIdentifier(candidate.table)} WHERE ${quoteSqlIdentifier(plan.pk)} = ? AND ${quoteSqlIdentifier(plan.scheduleAt!)} <= ?`,
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
                throw new AckerDBError(
                  "conflict",
                  `scheduled mutation returned application error ${result.error.code}`,
                );
              }
            }),
            finalize: (writes) => {
              const scheduledRow = row;
              if (scheduledRow === null) {
                throw new Error("scheduled row disappeared during its writer turn");
              }
              const plan = this.engine.plan(candidate.table);
              this.tracing.measureStatement("write", candidate.table, "scheduledDelete", () =>
                this.engine.writer
                  .query(`DELETE FROM ${quoteSqlIdentifier(candidate.table)} WHERE ${quoteSqlIdentifier(plan.pk)} = ?`)
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
      writer: this.coordinator.snapshot(),
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
    this.coordinator.close();
    this.reads.close();
    if (this.ownsTelemetry) this.telemetry.stop();
    const reactiveDrain = this.reactive.close();
    let deadlineReached = false;
    const coreShutdown = (async () => {
      const settled = await Promise.allSettled([
        this.waitForActiveOperations(),
        this.coordinator.drain(),
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

  private runSessionOperation<T>(
    context: SessionRuntimeContext,
    request: RuntimeRequest<
      SubscribeMessage | UnsubscribeMessage | ResetRequestMessage | QueryMessage | ProcedureMessage | MutationMessage
      | ChannelJoinMessage | ChannelLeaveMessage | ChannelSendMessage
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
    const state = this.sessionStore.matching(context);
    const execute = () => {
      if (state === null) throw new AckerDBError("auth_stale", "authentication state changed");
      throwIfAborted(context.signal);
      return work(state, requestBytes);
    };
    const sessionOrder: SessionOperationOrder | undefined = operation === "subscription"
      ? { kind: "subscription-control", id: message.id }
      : operation === "mutation"
        ? { kind: "subscription-frontier" }
        : undefined;
    return this.operations.run(
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

  private realtimeApplication() {
    return createRealtimeRuntimeApplication({
      addressOf: (definition) => this.registry.addressOf(definition),
      createAuthorizationContext: (
        principal,
        fairnessKey,
        signal,
        requestBytes,
      ) => this.procedureContext(
        principal,
        fairnessKey,
        signal,
        requestBytes,
        this.readNow(),
        this.immediateProcedureInvalidations.publish,
      ),
      createSessionContext: (principal, fairnessKey, signal) => {
        const invalidations = this.immediateProcedureInvalidations;
        const owned = this.procedureContext(
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

  private makeChannelAdapter(state: () => RuntimeSession): ChannelSessionAdapter {
    return Object.freeze({
      get principal(): Principal {
        return state().context.principal;
      },
      createContext: (
        signal: AbortSignal,
        requestBytes: number,
      ): OwnedProcedureContext =>
        this.channelProcedureContext(state(), signal, requestBytes),
      send: async (id: number, event: string, payload: unknown): Promise<boolean> => {
        const current = state();
        try {
          await this.publishSession(current, current.context.authEpoch, {
            v: PROTOCOL_VERSION,
            t: "channel_event",
            id,
            event,
            payload,
          } satisfies ChannelEventMessage);
          return true;
        } catch {
          return false;
        }
      },
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
    const procedure = this.procedureContext(
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
          this.tracing.currentScope()?.operation === "subscription"
        ? "subscription"
        : "operation",
    );
    if (!await state.context.publish(publication)) {
      throw new AckerDBError("auth_stale", "authentication state changed");
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
      message.t === "channel_ready" ||
      message.t === "channel_event" ||
      message.t === "channel_rejected" ||
      message.t === "err"
    );
  }

  private async attachChannel(
    state: RuntimeSession,
    id: number,
    address: string,
    args: unknown,
    hasRoom: boolean,
    room: unknown,
    requestBytes: number,
  ): Promise<RuntimePublication> {
    const result = await this.channels.join({
      session: state.channelAdapter,
      id,
      address,
      args,
      hasRoom,
      ...(hasRoom ? { room: snapshotValue(room) } : {}),
      requestBytes,
    });
    const message = result.ok
      ? {
          v: PROTOCOL_VERSION,
          t: "channel_ready",
          id,
          authEpoch: state.context.authEpoch,
        } satisfies ChannelReadyMessage
      : {
          v: PROTOCOL_VERSION,
          t: "channel_rejected",
          id,
          authEpoch: state.context.authEpoch,
          error: result.error,
        } satisfies ChannelRejectedMessage;
    if (!result.ok) this.sessionStore.releaseSubscription(state, id, "channel");
    return this.prepareFrame(message, "channel frame", "subscription");
  }

  private captureFrame(
    capture: AuthTransitionCapture,
    publication: RuntimePublication,
  ): void {
    if (!capture.active) throw new AckerDBError("auth_stale", "authentication state changed");
    const maxItems = Math.min(Number.MAX_SAFE_INTEGER, this.limits.maxSubscriptionsPerConnection * 2);
    const maxBytes = this.limits.webSocket.maxBytesPerConnection - this.limits.maxFrameBytes;
    if (capture.frames.length >= maxItems || publication.bytes > maxBytes - capture.bytes) {
      throw new AckerDBError("overloaded", "authentication transition exceeds capture capacity", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    const reservation = this.authCaptureBudget.reserve(publication.bytes, "application");
    if (reservation === null) {
      throw new AckerDBError("overloaded", "authentication transition exceeds global capture capacity", {
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
    if (!capture.active) throw new AckerDBError("auth_stale", "authentication state changed");
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
        throw new AckerDBError("not_found", `unknown event table "${table}"`);
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
          this.tracing.span({
            stage: "policy",
            outcome: "ok",
            functionName: address,
            resource: "subscription",
            durationMs: Math.max(0, performance.now() - policyAt),
          }, "subscription");
        }
      } catch (error) {
        if (this.telemetry.enabled) {
          this.tracing.span({
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
    return this.reads.execute(
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

  private evaluateSubscription(input: QueryEvaluationInput<ReactiveContext>): Promise<QueryEvaluation> {
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

  private hostQueryContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    execution: Readonly<PluginReadExecution>,
  ): QueryCtx {
    const plugins = this.pluginRuntime?.bindQuery({
      ...execution,
      invocation: this.pluginInvocationCapabilities(principal, timestamp),
    }) ?? {};
    return Object.freeze({ db, auth: principal, log: this.log, timestamp, ...plugins }) as QueryCtx;
  }

  private hostMutationContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    writes: WriteCollector,
  ): MutationCtx {
    const analytics = this.applicationSignals.analyticsFor(principal);
    const plugins = this.pluginRuntime?.bindMutation({
      writes,
      invocation: this.pluginInvocationCapabilities(principal, timestamp),
      ...(this.telemetry.enabled ? { statementObserver: this.tracing.observeStatement } : {}),
    }) ?? {};
    return Object.freeze({
      db,
      auth: principal,
      analytics,
      log: this.log,
      timestamp,
      ...plugins,
    }) as MutationCtx;
  }

  /**
   * One registered mutation's invocation inside the writer's transaction. The
   * WebSocket session and the HTTP path hand the same closure to the
   * coordinator, so neither transport owns a second execution model.
   */
  private mutationWork(
    fn: AnyRegistered,
    principal: Principal,
    args: unknown,
  ): (db: MutationCtx["db"], writes: WriteCollector) => unknown {
    return (db, writes) => {
      const invocation = this.hostMutationContext(db, principal, this.readNow(), writes);
      const scope = createMutationInvocationScope(this.engine.writer, writes);
      return scope.runRoot((mutationAccess) =>
        this.hasMcpCapabilities
          ? withMcpTokenCapability(
              invocation,
              this.mcpTokenCapability(principal, this.engine.writer, null, writes),
              (ctx) => invokeFunction(fn, ctx, args, { mutationAccess }),
            )
          : invokeFunction(fn, invocation, args, { mutationAccess }));
    };
  }

  /**
   * The one commit every write goes through. Two invariants belong to the
   * commit itself rather than to whoever asked for it: a handled application
   * failure closes its transaction with a rollback instead of a commit, and a
   * commit that touched the scheduled table arms the scheduler. Stating them
   * here once is what keeps the session mutation, the HTTP mutation, and a
   * framework transaction from drifting apart.
   */
  private async commitWrite<T>(
    request: RuntimeCommitRequest<T>,
  ): Promise<CommitResult<T, ReactiveCommit>> {
    let scheduledTouched = false;
    const result = await this.coordinator.execute({
      operation: request.operation,
      fairnessKey: request.fairnessKey,
      requestBytes: request.requestBytes,
      admissionSignal: request.admissionSignal,
      transactionSignal: request.transactionSignal,
      idempotency: request.idempotency,
      validate: request.validate,
      ...(this.telemetry.enabled
        ? {
            telemetry: this.tracing.observeCommit,
            statementTelemetry: this.tracing.observeStatement,
          }
        : {}),
      run: AsyncLocalStorage.snapshot(),
      work: (db, writes) => this.withStagedAnalytics(
        writes,
        () => request.work(db, writes),
      ),
      rollbackWhen: (value) => isResult(value) && !value.ok,
      publication: (_version, writes) => {
        scheduledTouched = writes.scheduledTouched;
        return this.publicationFor(writes, request.subscriber);
      },
    });
    if (scheduledTouched) this.armScheduler();
    return result;
  }

  private withStagedAnalytics<T>(
    writes: WriteCollector,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const analytics: AnalyticsEventRecord[] = [];
    this.analyticsByWrites.set(writes, analytics);
    return withTransactionAnalytics(analytics, async () => {
      try {
        const value = await work();
        if (isResult(value) && !value.ok) analytics.length = 0;
        return value;
      } catch (error) {
        analytics.length = 0;
        throw error;
      }
    });
  }

  private async executeWrite<T>(
    operation: "mutation" | "transaction",
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (db: MutationCtx["db"], writes: WriteCollector) => T | Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    assertWriterAvailable();
    const result = await this.commitWrite({
      operation,
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work,
    });
    return result.value;
  }

  private inTransactionTrace<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.tracing.currentScope();
    return scope === undefined
      ? work()
      : this.tracing.runScope({ ...scope, operation: "transaction" }, work);
  }

  /** MCP gets the ordinary transaction capability, never mounted Plugins. */
  private transactionalContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number,
  ): McpAiContext & Pick<ProcedureCtx, "timestamp"> {
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
            const context = Object.freeze({
              db,
              auth: principal,
              analytics: this.applicationSignals.analyticsFor(principal),
              log: this.log,
              timestamp,
            }) as TxCtx;
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
    return this.reads.execute("query", fairnessKey, signal, requestBytes, null, work);
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
        ...(this.telemetry.enabled ? { statementObserver: this.tracing.observeStatement } : {}),
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
    timestamp: number | (() => number),
    accountUnlinked: (account: ExternalAccount) => void,
  ): OwnedProcedureContext {
    const currentTimestamp = typeof timestamp === "function"
      ? timestamp
      : () => timestamp;
    const initialTimestamp = currentTimestamp();
    const plugins = this.pluginRuntime?.bindProcedure({
      invocation: this.pluginInvocationCapabilities(principal, initialTimestamp),
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
      log: this.log,
      get timestamp(): number {
        return currentTimestamp();
      },
      ...plugins,
      tx: <R>(work: (ctx: TxCtx) => R) =>
        this.inTransactionTrace(() => this.executeWrite(
          "transaction",
          fairnessKey,
          signal,
          requestBytes,
          (db, writes) => {
            const context = this.hostMutationContext(
              db,
              principal,
              currentTimestamp(),
              writes,
            ) as TxCtx;
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

  private pluginInvocationCapabilities(
    principal: Principal,
    timestamp: number,
  ): Readonly<PluginInvocationCapabilities> {
    return Object.freeze({
      timestamp,
      log: (functionAddress, functionKind) =>
        this.applicationSignals.forFunction(functionAddress, functionKind),
      analytics: (functionAddress, functionKind) =>
        this.applicationSignals.analyticsFor(principal, { functionAddress, functionKind }),
    } satisfies PluginInvocationCapabilities);
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
            this.transactionalContext(
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
      const failure = new AckerDBError("validation", `${label} is not wire-representable`, {
        cause: error,
      });
      if (this.telemetry.enabled) {
        this.tracing.span({
          stage: "encoding",
          outcome: failure.code,
          resource: "outbound",
          durationMs: Math.max(0, performance.now() - startedAt),
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (publication.bytes > this.limits.maxFrameBytes) {
      const failure = new AckerDBError("overloaded", `${label} exceeds maxFrameBytes`, { resource });
      if (this.telemetry.enabled) {
        this.tracing.span({
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
      this.tracing.span({
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
    if (session !== null && session.phase !== "open") {
      throw new AckerDBError("auth_stale", "session is closing");
    }
    if (session !== null && session.activeOperations >= this.limits.maxOperationsPerConnection) {
      throw new AckerDBError("overloaded", "per-connection operation capacity is full", {
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
            this.sessionStore.tryRemove(session);
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
