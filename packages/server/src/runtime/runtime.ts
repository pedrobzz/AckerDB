import {
  EVENTS_ADDRESS_PREFIX,
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
  type Principal,
  type ScopeResolver,
} from "../auth/credentials.ts";
import {
  CREDENTIAL_ISSUER,
  parseCredentialToken,
} from "../auth/credential-token.ts";
import { RuntimeCredentials } from "./credentials/runtime.ts";
import {
  AuthInvalidationBoundary,
  type AuthInvalidationPublisher,
} from "../auth/invalidation.ts";
import { assertCredentialVerifier } from "../auth/lease.ts";
import { externalAccountFairnessKey } from "./caller.ts";
import { OutboundBudget } from "../subscriptions/delivery/budget.ts";
import type { SseDeliverySnapshot } from "../subscriptions/delivery/sse.ts";
import type { Engine } from "../database/engine.ts";
import { AckerDBError } from "../shared/errors.ts";
import type { OwnedProcedureContext } from "../app/functions.ts";
import type { SystemRunner } from "../app/system.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import { OrderedReactive } from "../subscriptions/reactive/ordered.ts";
import type { Registry } from "../app/registry.ts";
import {
  ChannelHub,
} from "../channels/hub.ts";
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
  RuntimeHttpMutationRequest,
  RuntimeHttpRequest,
  RuntimeHttpHandlerRequest,
  RuntimeSseRequest,
  RuntimeSseResponse,
} from "./contracts/requests.ts";
import type { RuntimeStatus } from "./contracts/status.ts";
import { RuntimeOperationRunner } from "./execution/operation-runner.ts";
import { RuntimeReadExecutor } from "./execution/read.ts";
import {
  RuntimeFunctionExecutor,
} from "./execution/functions.ts";
import { RuntimeHttp } from "./http/runtime.ts";
import {
  RuntimeSessionStore,
  type RuntimeReactiveContext,
  type RuntimeSession,
} from "./sessions/store.ts";
import { RuntimeSessionApplication } from "./sessions/application.ts";
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

/**
 * Composes the Runtime's domain owners and exposes the public server lifecycle.
 * Construction wires; `start()` is what begins work. Engine lifetime remains
 * with the caller so storage closes exactly once.
 */
export class Runtime implements RuntimePort {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly credentialVerifier: CredentialVerifier | undefined;
  readonly limits: ServiceLimits;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly channels: ChannelHub;
  readonly system: SystemRunner;

  private readonly now: () => number;
  private readonly files: RuntimeFiles;
  readonly fileMaxBytes: number;
  private readonly fileHttp: FileHttpRuntime;
  private readonly fileCleanup: FileCleanupRuntime;
  private readonly credentials: RuntimeCredentials;
  /** The application's declared scopes: what every grant expands against. */
  private readonly vocabulary: readonly string[];
  /**
   * Package-internal: the transport builds one origin-aware publisher per
   * request from it, because the transport is what owns the response handoff a
   * self-invalidation must wait for. It is absent from the public index.
   */
  readonly authInvalidation: AuthInvalidationBoundary;
  private readonly immediateProcedureInvalidations: AuthInvalidationPublisher;
  private readonly reads: RuntimeReadExecutor;
  private readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  private readonly queries: RuntimeQueries;
  readonly jobs: RuntimeJobs;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly sessionApplication: RuntimeSessionApplication;
  private readonly authCaptureBudget: OutboundBudget;
  private readonly http: RuntimeHttp;
  private readonly operations: RuntimeOperationRunner<RuntimeSession>;
  private readonly control: RuntimeControl;

  constructor(options: RuntimeOptions) {
    this.engine = options.engine;
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
    this.files = new RuntimeFiles(options.files);
    this.fileMaxBytes = this.files.maxBytes;
    this.limits = options.limits === undefined ? PRODUCTION_LIMITS : defineServiceLimits(options.limits);
    this.channels = new ChannelHub({
      registry: this.registry,
      maxMembers: this.limits.maxSubscriptions,
      maxMembersPerSession: this.limits.maxSubscriptionsPerConnection,
      disconnectTimeoutMs: Math.min(5_000, this.limits.gracefulShutdownMs),
    });
    if (options.verifier !== undefined) {
      assertCredentialVerifier(options.verifier, this.limits.auth.revocationDeadlineMs);
    }
    if (options.resolveScopes !== undefined && typeof options.resolveScopes !== "function") {
      throw new TypeError("Runtime resolveScopes must be a function");
    }
    this.vocabulary = Object.freeze([...options.scopes ?? []]);
    // The Runtime's one credential authority: AckerDB's own credentials compose
    // with the application verifier, and both invalidate through one boundary.
    this.credentials = new RuntimeCredentials({
      engine: this.engine,
      reads: () => this.reads,
      now: this.now,
      assertReady: () => this.control.assertReady(),
      operationSignal: (signal) => this.control.operationSignal(signal),
      ...(options.verifier === undefined ? {} : { appVerifier: options.verifier }),
      ...(options.resolveScopes === undefined ? {} : { resolveAppScopes: options.resolveScopes }),
      vocabulary: this.vocabulary,
      subscribeInvalidation: (listener) =>
        this.authInvalidation.subscribeDirect(listener),
      revocationDeadlineMs: this.limits.auth.revocationDeadlineMs,
    });
    this.authInvalidation = new AuthInvalidationBoundary(this.credentials.verifier);
    this.immediateProcedureInvalidations = this.authInvalidation.publisher(SYSTEM_PRINCIPAL);
    this.credentialVerifier = this.authInvalidation.verifier;
    this.operations = new RuntimeOperationRunner({
      assertRequestBytes: (bytes) => this.control.assertRequestBytes(bytes),
      admit: (session, fairnessKey, sessionOrder) =>
        this.control.admit(session, fairnessKey, sessionOrder),
    });
    this.reads = new RuntimeReadExecutor({
      engine: this.engine,
      limits: this.limits,
      now: this.now,
    });
    this.reactive = new OrderedReactive<RuntimeReactiveContext>({
      limits: this.limits,
      initialVersion: this.engine.commitVersion(),
      now: this.now,
      evaluate: (input) => this.queries.evaluate(input),
    });
    this.functions = new RuntimeFunctionExecutor({
      engine: this.engine,
      registry: this.registry,
      limits: this.limits,
      reads: this.reads,
      reactive: this.reactive,
      credentialVerifier: this.credentialVerifier,
      vocabulary: this.vocabulary,
      resolveIdentityGrant: this.credentials.resolveIdentityGrant,
      publishAuthInvalidation: this.immediateProcedureInvalidations.publish,
      files: this.files,
      armJobs: () => this.jobs.arm(),
      jobs: () => this.jobs,
      fileLifecycleSignal: () => this.control.shutdownSignal,
      hooks: options.hooks,
      now: this.now,
    });
    this.queries = new RuntimeQueries({
      registry: this.registry,
      reads: this.reads,
      functions: this.functions,
      shutdownSignal: () => this.control.shutdownSignal,
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
      immediateInvalidations: this.immediateProcedureInvalidations,
      admittedRequestBytes: (request, receivedBytes) =>
        this.control.admittedRequestBytes(request, receivedBytes),
      operationSignal: (signal) => this.control.operationSignal(signal),
      admit: (fairnessKey) => this.control.admit(null, fairnessKey),
      now: this.now,
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
      createChannelContext: (state, signal, requestBytes) =>
        this.channelProcedureContext(state, signal, requestBytes),
    });
    this.system = new RuntimeSystem({
      functions: this.functions,
      operations: this.operations,
      invalidations: this.immediateProcedureInvalidations,
      signal: (signal) => this.control.systemSignal(signal),
      now: this.now,
    });
    this.jobs = new RuntimeJobs({
      declared: options.jobs ?? [],
      executor: this.functions,
      registry: this.registry,
      reads: this.reads,
      system: this.system,
      limits: this.limits.jobs,
      now: this.now,
      signal: () => this.control.shutdownSignal,
      isReady: () => this.control.isReady,
    });
    this.control = new RuntimeControl({
      limits: this.limits,
      engine: this.engine,
      reads: this.reads,
      functions: this.functions,
      reactive: this.reactive,
      sessions: this.sessionStore,
      jobs: this.jobs,
      fileCleanup: this.fileCleanup,
      authCaptureBudget: this.authCaptureBudget,
      sseBudget: this.http.sseBudget,
      sseProducers: this.http.sseProducers,
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
  }

  get state(): RuntimeLifecycleState {
    return this.control.state;
  }

  /** created → ready; nothing runs on the Runtime's own initiative before this. */
  start(): Promise<void> {
    return this.control.start();
  }

  get connectionCount(): number {
    return this.sessionStore.size;
  }

  kindOf(address: string): string | null {
    if (address.startsWith(EVENTS_ADDRESS_PREFIX)) return "event";
    return this.registry.kindOf(address) ?? null;
  }

  async resolveIdentity(
    account: ExternalAccount,
    signal?: AbortSignal,
  ): Promise<Identity> {
    // An AckerDB credential is already an Identity; it is resolved from the
    // credential table, never provisioned as an external account.
    if (account.issuer === CREDENTIAL_ISSUER) {
      return this.credentials.identityFor(account, signal);
    }
    const requestBytes = this.control.admittedRequestBytes(account);
    const operationSignal = this.control.operationSignal(signal);
    const fairnessKey = externalAccountFairnessKey(account);
    return this.operations.run(
      null,
      requestBytes,
      () => this.functions.resolveIdentity(
        account,
        fairnessKey,
        operationSignal,
        requestBytes,
      ),
      { fairnessKey },
    );
  }

  /** Scope grants ride the same re-verification: an auth-epoch change re-reads them. */
  readonly resolveScopes: ScopeResolver = (identity, account) =>
    this.credentials.resolveScopes(identity, account);

  /** Authenticate one raw AckerDB credential into its full first-class principal. */
  async authenticateCredential(
    rawToken: string,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<Principal> {
    const parsed = parseCredentialToken(rawToken);
    if (parsed === null) {
      throw new AckerDBError("unauthenticated", "invalid credential");
    }
    return this.credentials.authenticate(parsed, fairnessKey, signal);
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

  drain(deadlineAtMs = Date.now() + this.limits.gracefulShutdownMs): Promise<void> {
    return this.control.drain(deadlineAtMs);
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
    const value = this.functions.createProcedureContext(
      state.context.principal,
      state.context.fairnessKey,
      signal,
      requestBytes,
      this.readNow(),
      invalidations.publish,
    );
    let active = true;
    return Object.freeze({
      value,
      release: () => {
        if (!active) return;
        active = false;
        invalidations.finish();
      },
    });
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}
