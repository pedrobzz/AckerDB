import { createHash } from "node:crypto";
import {
  stableEncode,
  type ChannelJoinMessage,
  type ChannelLeaveMessage,
  type ChannelSendMessage,
  type MutationMessage,
  type Outcome,
  type ProcedureMessage,
  type QueryMessage,
  type ResetRequestMessage,
  type SseAckRequest,
  type SubscribeMessage,
  type UnsubscribeMessage,
  type Identity,
} from "@ackerdb/core";
import {
  SYSTEM_PRINCIPAL,
  type CredentialVerifier,
  type ExternalAccount,
  type McpPrincipal,
  type Principal,
} from "../auth/credentials.ts";
import {
  AuthInvalidationBoundary,
  type AuthInvalidationPublisher,
} from "../auth/invalidation.ts";
import { assertCredentialVerifier } from "../auth/lease.ts";
import { externalAccountFairnessKey } from "./caller.ts";
import {
  OutboundBudget,
  type OutboundLane,
} from "../subscriptions/delivery/budget.ts";
import type { DeliveryObserver } from "../subscriptions/delivery/observation.ts";
import type { SseDeliverySnapshot } from "../subscriptions/delivery/sse.ts";
import type { Engine } from "../database/engine.ts";
import { telemetryJournalPath } from "../database/artifacts.ts";
import { AckerDBError } from "../shared/errors.ts";
import type { OwnedProcedureContext } from "../app/functions.ts";
import type { SystemRunner } from "../app/system.ts";
import type { McpCallToolResult } from "../mcp/content.ts";
import type { ParsedMcpToken } from "../mcp/credential.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import {
  PluginRuntime,
} from "../plugins/runtime.ts";
import { OrderedReactive } from "../subscriptions/reactive/ordered.ts";
import type { Registry } from "../app/registry.ts";
import {
  ChannelHub,
} from "../channels/hub.ts";
import type { RealtimePeerDiagnostic, RealtimeRuntime } from "../realtime/host.ts";
import { createRealtimeRuntimeApplication } from "../realtime/runtime-application.ts";
import { Telemetry } from "../telemetry/telemetry.ts";
import { ApplicationSignals } from "../telemetry/application-signals/application-signals.ts";
import {
  TelemetryJournal,
} from "../telemetry/application-signals/journal.ts";
import { TelemetryStore } from "../telemetry/storage/store.ts";
import { TelemetryFlushInvalidation } from "../telemetry/storage/invalidation.ts";
import { TelemetrySpanStore } from "../telemetry/storage/spans.ts";
import type { ApplicationLogger } from "../telemetry/application-signals/types.ts";
import {
  TelemetryJournalExporters,
  validateTelemetryJournalExportersOptions,
} from "../telemetry/application-signals/exporters.ts";
import {
  type RuntimeAuthTransition,
  type RuntimeMutationResult,
  type RuntimePort,
  type RuntimePublicationBatch,
  type RuntimeRequest,
  type SessionRuntimeContext,
} from "../subscriptions/session/contract.ts";
import type { RuntimeLifecycleState } from "./contracts/lifecycle.ts";
import type { RuntimeOptions } from "./contracts/options.ts";
import type {
  McpCredentialLease,
  RuntimeHttpMutationRequest,
  RuntimeHttpRequest,
  RuntimeMcpToolRequest,
  RuntimeHttpHandlerRequest,
  RuntimeSseRequest,
  RuntimeSseResponse,
} from "./contracts/requests.ts";
import type { RuntimeStatus } from "./contracts/status.ts";
import { RuntimeTraceBridge } from "./telemetry/trace-bridge.ts";
import { RuntimeOperationRunner } from "./execution/operation-runner.ts";
import { RuntimeReadExecutor } from "./execution/read.ts";
import {
  RuntimeFunctionExecutor,
} from "./execution/functions.ts";
import { RuntimeMcp } from "./mcp/runtime.ts";
import {
  type RuntimeMcpToolAuthorization,
} from "./mcp/authorization.ts";
import { RuntimeHttp } from "./http/runtime.ts";
import {
  RuntimeSessionStore,
  type RuntimeReactiveContext,
  type RuntimeSession,
} from "./sessions/store.ts";
import { RuntimeSessionApplication } from "./sessions/application.ts";
import { RuntimeSampler } from "./telemetry/sampler.ts";
import { FileObservability } from "../files/observability.ts";
import { RuntimeDeliveryTelemetry } from "./telemetry/delivery-observer.ts";
import { RuntimeJobs } from "./jobs/runtime.ts";
import { RuntimeControl } from "./lifecycle/control.ts";
import { RuntimeQueries } from "./queries/runtime.ts";
import { RuntimeSystem } from "./system/runtime.ts";
import { RuntimeFiles } from "../files/namespace.ts";
import {
  FileHttpRuntime,
  type RuntimeFileRequest,
} from "../files/http.ts";
import { FileCleanupRuntime } from "../files/cleanup.ts";

/** Package-private transport hook; intentionally absent from the public index. */
export const CAPTURE_DELIVERY_OBSERVER = Symbol("ackerdb.captureDeliveryObserver");

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("base64url");
}

/**
 * Composes the Runtime's domain owners and exposes the public server lifecycle.
 * Engine lifetime remains with the caller so storage closes exactly once.
 */
export class Runtime implements RuntimePort {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly credentialVerifier: CredentialVerifier | undefined;
  readonly limits: ServiceLimits;
  readonly telemetry: Telemetry;
  readonly telemetryStore: TelemetryStore;
  readonly telemetryJournal: TelemetryJournal;
  readonly telemetrySpans: TelemetrySpanStore;
  /** Studio's reactive `_studio.*` reads subscribe here for flush invalidation. */
  readonly telemetryInvalidation = new TelemetryFlushInvalidation();
  readonly telemetryExporters: TelemetryJournalExporters | undefined;
  readonly log: ApplicationLogger;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly channels: ChannelHub;
  readonly realtime: RealtimeRuntime | undefined = undefined;
  readonly system: SystemRunner;
  readonly deliveryObserver: DeliveryObserver;

  private readonly now: () => number;
  private readonly files: RuntimeFiles;
  readonly fileMaxBytes: number;
  private readonly fileHttp: FileHttpRuntime;
  private readonly fileCleanup: FileCleanupRuntime;
  private readonly pluginRuntime: PluginRuntime | undefined;
  private readonly authInvalidation: AuthInvalidationBoundary;
  private readonly immediateProcedureInvalidations: AuthInvalidationPublisher;
  private readonly reads: RuntimeReadExecutor;
  private readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  private readonly queries: RuntimeQueries;
  private readonly mcp: RuntimeMcp;
  readonly jobs: RuntimeJobs;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly sessionApplication: RuntimeSessionApplication;
  private readonly authCaptureBudget: OutboundBudget;
  private readonly http: RuntimeHttp;
  private readonly tracing: RuntimeTraceBridge;
  private readonly deliveryTelemetry: RuntimeDeliveryTelemetry;
  private readonly operations: RuntimeOperationRunner<RuntimeSession>;
  private readonly sampler: RuntimeSampler;
  private readonly control: RuntimeControl;
  private readonly applicationSignals: ApplicationSignals;

  constructor(options: RuntimeOptions) {
    if (options.telemetryExporters !== undefined) {
      // Fail before opening the journal; the exporter owns the same validation at direct construction.
      validateTelemetryJournalExportersOptions(options.telemetryExporters);
    }
    this.engine = options.engine;
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
    this.files = new RuntimeFiles(
      options.files,
      new FileObservability(this.engine, this.now),
    );
    this.fileMaxBytes = this.files.maxBytes;
    if (options.pluginRuntime !== undefined && options.pluginRuntime.state !== "ready") {
      throw new TypeError("Runtime requires a ready Plugin runtime");
    }
    this.pluginRuntime = options.pluginRuntime;
    const hasMcpCapabilities = this.registry.mcps.size > 0;
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
    this.immediateProcedureInvalidations = this.authInvalidation.publisher(SYSTEM_PRINCIPAL);
    this.credentialVerifier = this.authInvalidation.verifier;
    const ownsTelemetry = !(options.telemetry instanceof Telemetry);
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
            // Framework events become durable journal rows and every span
            // persists durably; the closures bind lazily because the
            // read-model owners construct after telemetry.
            durableSink: {
              span: (record) => void this.telemetrySpans.append(record),
              event: (record) => this.applicationSignals.framework(record),
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
      assertRequestBytes: (bytes) => this.control.assertRequestBytes(bytes),
      admit: (session, fairnessKey, sessionOrder) =>
        this.control.admit(session, fairnessKey, sessionOrder),
    });
    if (
      options.telemetryJournal instanceof TelemetryJournal &&
      options.telemetryStore instanceof TelemetryStore &&
      options.telemetryJournal.store !== options.telemetryStore
    ) {
      throw new TypeError("Runtime telemetryJournal must live in the provided telemetryStore");
    }
    const ownsTelemetryStore = !(options.telemetryStore instanceof TelemetryStore) &&
      !(options.telemetryJournal instanceof TelemetryJournal);
    this.telemetryStore = options.telemetryJournal instanceof TelemetryJournal
      ? options.telemetryJournal.store
      : options.telemetryStore instanceof TelemetryStore
        ? options.telemetryStore
        : new TelemetryStore({
            path: this.engine.path === ":memory:"
              ? ":memory:"
              : telemetryJournalPath(this.engine.path),
            now: this.now,
            ...options.telemetryStore,
          });
    const ownsTelemetryJournal = !(options.telemetryJournal instanceof TelemetryJournal);
    this.telemetryJournal = options.telemetryJournal instanceof TelemetryJournal
      ? options.telemetryJournal
      : new TelemetryJournal({
          store: this.telemetryStore,
          ...options.telemetryJournal,
        });
    if (this.telemetryJournal.snapshot().state !== "ready") {
      throw new TypeError("Runtime requires a ready telemetry journal");
    }
    this.telemetryJournal.onPersist(() => this.telemetryInvalidation.notify());
    this.telemetrySpans = new TelemetrySpanStore({ store: this.telemetryStore });
    this.telemetrySpans.onPersist(() => this.telemetryInvalidation.notify());
    this.applicationSignals = new ApplicationSignals(
      this.telemetryJournal,
      this.now,
      () => this.tracing.applicationLogContext(),
    );
    this.log = this.applicationSignals.log;
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
    this.reactive = new OrderedReactive<RuntimeReactiveContext>({
      limits: this.limits,
      initialVersion: this.engine.commitVersion(),
      now: this.now,
      evaluate: (input) => this.queries.evaluate(input),
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
      ...(hasMcpCapabilities
        ? {
            mcp: {
              bindTokenContext: (context, principal, connection, reads, writes, work) =>
                this.mcp.bindTokenContext(
                  context,
                  principal,
                  connection,
                  reads,
                  writes,
                  work,
                ),
              bindAiContext: (context, fairnessKey, requestBytes) =>
                this.mcp.bindAiContext(context, fairnessKey, requestBytes),
              publishCommittedInvalidations: (writes) =>
                this.mcp.publishCommittedInvalidations(writes),
            },
          }
        : {}),
      armJobs: () => this.jobs.arm(),
      jobs: () => this.jobs,
      files: this.files,
      fileLifecycleSignal: () => this.control.shutdownSignal,
      hooks: options.hooks,
      now: this.now,
    });
    this.queries = new RuntimeQueries({
      registry: this.registry,
      reads: this.reads,
      functions: this.functions,
      shutdownSignal: () => this.control.shutdownSignal,
      telemetry: this.telemetry,
      tracing: this.tracing,
    });
    this.fileHttp = new FileHttpRuntime({
      files: this.files,
      now: this.now,
      lifecycleSignal: () => this.control.shutdownSignal,
      read: (signal, work) => this.functions.filesRead(signal, work),
      write: (signal, work) => this.functions.filesWrite(signal, work),
      authorize: (address, args, principal, fairnessKey, signal) =>
        this.queries.execute(address, args, principal, fairnessKey, signal, 1),
    });
    this.fileCleanup = new FileCleanupRuntime({
      files: this.files,
      now: this.now,
      read: (signal, work) => this.functions.filesRead(signal, work),
      write: (signal, work) => this.functions.filesWrite(signal, work, { waitForRecovery: false }),
    });
    this.http = new RuntimeHttp({
      registry: this.registry,
      limits: this.limits,
      operations: this.operations,
      functions: this.functions,
      queries: this.queries,
      authInvalidation: this.authInvalidation,
      telemetry: this.telemetry,
      tracing: this.tracing,
      admittedRequestBytes: (request, receivedBytes) =>
        this.control.admittedRequestBytes(request, receivedBytes),
      operationSignal: (signal) => this.control.operationSignal(signal),
      admit: (fairnessKey) => this.control.admit(null, fairnessKey),
      captureDeliveryObserver: () => this.deliveryTelemetry.capture(),
      now: this.now,
    });
    this.mcp = new RuntimeMcp({
      engine: this.engine,
      registry: this.registry,
      limits: this.limits,
      reads: this.reads,
      functions: this.functions,
      operations: this.operations,
      now: this.now,
      assertReady: () => this.control.assertReady(),
      operationSignal: (signal) => this.control.operationSignal(signal),
      admittedRequestBytes: (request, receivedBytes) =>
        this.control.admittedRequestBytes(request, receivedBytes),
      publishAccountInvalidation: this.immediateProcedureInvalidations.publish,
    });
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
    this.system = new RuntimeSystem({
      functions: this.functions,
      operations: this.operations,
      telemetry: this.telemetry,
      tracing: this.tracing,
      invalidations: this.immediateProcedureInvalidations,
      signal: (signal) => this.control.systemSignal(signal),
      now: this.now,
    });
    this.jobs = new RuntimeJobs({
      declared: options.jobs ?? [],
      executor: this.functions,
      reads: this.reads,
      system: this.system,
      telemetry: this.telemetry,
      limits: this.limits.jobs,
      now: this.now,
      signal: () => this.control.shutdownSignal,
      isReady: () => this.control.isReady,
    });
    this.control = new RuntimeControl({
      limits: this.limits,
      engine: this.engine,
      telemetry: this.telemetry,
      telemetryStore: this.telemetryStore,
      telemetryJournal: this.telemetryJournal,
      telemetrySpans: this.telemetrySpans,
      ...(this.telemetryExporters === undefined
        ? {}
        : { telemetryExporters: this.telemetryExporters }),
      ownsTelemetry,
      ownsTelemetryStore,
      ownsTelemetryJournal,
      ...(this.pluginRuntime === undefined ? {} : { pluginRuntime: this.pluginRuntime }),
      ...(this.realtime === undefined ? {} : { realtime: this.realtime }),
      reads: this.reads,
      functions: this.functions,
      reactive: this.reactive,
      sessions: this.sessionStore,
      jobs: this.jobs,
      fileCleanup: this.fileCleanup,
      files: this.files,
      authCaptureBudget: this.authCaptureBudget,
      sseBudget: this.http.sseBudget,
      sseProducers: this.http.sseProducers,
      stopPeriodicTelemetry: () => {
        this.sampler.stop();
        this.telemetryInvalidation.stop();
      },
      flushDeliveryFailures: () => this.deliveryTelemetry.flush(),
    });
    this.sessionApplication = new RuntimeSessionApplication({
      engine: this.engine,
      registry: this.registry,
      store: this.sessionStore,
      functions: this.functions,
      queries: this.queries,
      reactive: this.reactive,
      authInvalidation: this.authInvalidation,
      operationSignal: (signal) => this.control.operationSignal(signal),
      now: this.now,
    });
    this.sampler = new RuntimeSampler({
      telemetry: this.telemetry,
      isReady: () => this.control.isReady,
      state: () => ({
        connections: this.sessionStore.size,
        activeOperations: this.control.activeOperationCount,
        activeOperationCallers: this.control.activeCallerCount,
        activeSse: this.http.sseProducers.size,
        realtime: this.realtime?.snapshot() ?? null,
        reader: this.reads.snapshot(),
        writer: this.functions.snapshot(),
        reactive: this.reactive.metricsSnapshot(),
        publication: this.reactive.publication.snapshot(),
        authCaptureBudget: this.authCaptureBudget.snapshot(),
        sseBudget: this.http.sseBudget.snapshot(),
        telemetry: this.telemetry.snapshot(),
        files: this.files.observability.snapshot(),
        storage: this.engine.status(),
      }),
      sampleRealtime: () => {
        void this.realtime?.sampleHealth(8);
      },
      flushDeliveryFailures: () => this.deliveryTelemetry.flush(),
    });
    this.sampler.start();
    this.functions.bindFileRecoveryBarrier(this.fileCleanup.activate());
    void this.jobs.activate();
  }

  get state(): RuntimeLifecycleState {
    return this.control.state;
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
    const requestBytes = this.control.admittedRequestBytes(account);
    const operationSignal = this.control.operationSignal(signal);
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
    return this.mcp.authenticateToken(mcp, rawToken, fairnessKey, signal);
  }

  /** Own one exact non-expiring MCP credential from verification through HTTP completion. */
  async acquireMcpTokenLease(
    mcp: string,
    parsed: ParsedMcpToken,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<McpCredentialLease> {
    return this.mcp.acquireTokenLease(mcp, parsed, fairnessKey, signal);
  }

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.control.assertReady();
    this.sessionStore.open(context);
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch> {
    this.control.assertReady();
    return this.sessionStore.transitionAuth(transition);
  }

  async subscribe(context: SessionRuntimeContext, request: RuntimeRequest<SubscribeMessage>): Promise<void> {
    return this.sessionApplication.subscribe(context, request);
  }

  async unsubscribe(context: SessionRuntimeContext, request: RuntimeRequest<UnsubscribeMessage>): Promise<void> {
    return this.sessionApplication.unsubscribe(context, request);
  }

  async reset(context: SessionRuntimeContext, request: RuntimeRequest<ResetRequestMessage>): Promise<void> {
    return this.sessionApplication.reset(context, request);
  }

  async joinChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelJoinMessage>,
  ): Promise<void> {
    return this.sessionApplication.joinChannel(context, request);
  }

  async leaveChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelLeaveMessage>,
  ): Promise<void> {
    return this.sessionApplication.leaveChannel(context, request);
  }

  async sendChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelSendMessage>,
  ): Promise<void> {
    return this.sessionApplication.sendChannel(context, request);
  }

  async query(context: SessionRuntimeContext, request: RuntimeRequest<QueryMessage>): Promise<unknown> {
    return this.sessionApplication.query(context, request);
  }

  async procedure(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ProcedureMessage>,
  ): Promise<unknown> {
    return this.sessionApplication.procedure(context, request);
  }

  async mutation(
    context: SessionRuntimeContext,
    request: RuntimeRequest<MutationMessage>,
  ): Promise<RuntimeMutationResult> {
    return this.sessionApplication.mutation(context, request);
  }

  async closeSession(context: SessionRuntimeContext, outcome: Outcome): Promise<void> {
    return this.sessionApplication.close(context, outcome);
  }

  async runQuery(request: RuntimeHttpRequest): Promise<Response> {
    return this.http.runQuery(request);
  }

  async runMutation(request: RuntimeHttpMutationRequest): Promise<Response> {
    return this.http.runMutation(request);
  }

  async runProcedure(request: RuntimeHttpRequest): Promise<Response> {
    return this.http.runProcedure(request);
  }

  async runHttpHandler(input: RuntimeHttpHandlerRequest): Promise<Response> {
    return this.http.runHttpHandler(input);
  }

  /** Streaming built-in Upload Session and File Grant routes. */
  runFileRequest(input: RuntimeFileRequest): Promise<Response> {
    this.control.assertReady();
    return this.fileHttp.handle(input);
  }

  /** The single deep MCP execution path used by every present and future adapter. */
  async runMcpTool(request: RuntimeMcpToolRequest): Promise<McpCallToolResult> {
    return this.mcp.runTool(request);
  }

  /** Resolve one callable tool without trusting discovery or revealing inaccessible names. */
  authorizeMcpTool(
    mcp: string,
    name: string,
    principal: Principal,
  ): RuntimeMcpToolAuthorization {
    return this.mcp.authorizeTool(mcp, name, principal);
  }

  async runSse(request: RuntimeSseRequest): Promise<RuntimeSseResponse> {
    return this.http.runSse(request);
  }

  /** Receiver credit is capability-authenticated and remains routable during drain. */
  ackSse(request: SseAckRequest): boolean {
    return this.http.ackSse(request);
  }

  /** Delivery snapshot of one active stream, or null once it finished. */
  sseSnapshot(streamId: string): SseDeliverySnapshot | null {
    return this.http.sseSnapshot(streamId);
  }

  /** Drive one runner batch now — deterministic tests advance work this way. */
  runJobs(): Promise<void> {
    return this.jobs.run();
  }

  status(): RuntimeStatus {
    return this.control.status();
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
    return this.control.drain(deadlineAtMs);
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
    const invalidations = this.authInvalidation.publisher(
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

  readonly [CAPTURE_DELIVERY_OBSERVER] = (
    lane: OutboundLane = "application",
    clientSessionId?: string,
  ): DeliveryObserver | undefined =>
    this.deliveryTelemetry.capture(lane, clientSessionId);

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}
