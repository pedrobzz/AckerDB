import {
  PROTOCOL_VERSION,
  ProtocolError,
  decode,
  encode,
  parseClientMessage,
  type AuthenticationDescriptor,
  type AuthenticatedMessage,
  type ClientAuthMessage,
  type ClientMessage,
  type Credential,
  type ErrorMessage,
  type EventMessage,
  type MutationMessage,
  type MutationOkMessage,
  type MutationReceipt,
  type Outcome,
  type PongMessage,
  type QueryMessage,
  type QueryOkMessage,
  type ResetRequestMessage,
  type SubscribeMessage,
  type TransitionMessage,
  type UnsubscribeMessage,
  type WelcomeMessage,
} from "@dbzz/core";
import {
  verifyClientCredential,
  type ClientPrincipal,
  type CredentialVerifier,
  type ExternalAccount,
  type Principal,
  type PrincipalInvalidation,
} from "./auth.ts";
import {
  MAX_REVOCATION_DEADLINE_MS,
  validateCredentialVerifierRevocation,
} from "./auth-lease.ts";
import {
  callerFairnessKey,
  transportSource,
  type TransportSource,
} from "./caller.ts";
import { DbzzError, isDbzzError } from "./errors.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "./limits.ts";
import { outcomeFromError } from "./outcome.ts";
import type { Identity } from "./dbz.ts";

export type SubscriptionServerMessage = TransitionMessage | EventMessage;
export type SessionApplicationMessage =
  | SubscriptionServerMessage
  | QueryOkMessage
  | MutationOkMessage
  | ErrorMessage;
const RUNTIME_PUBLICATION_BRAND: unique symbol = Symbol("dbzz.runtimePublication");
const runtimePublications = new WeakSet<object>();

export interface RuntimePublication {
  readonly message: SessionApplicationMessage;
  readonly text: string;
  readonly bytes: number;
  readonly [RUNTIME_PUBLICATION_BRAND]: true;
}

export function prepareRuntimePublication(message: SessionApplicationMessage): RuntimePublication {
  Object.freeze(message);
  const text = encode(message);
  const publication = Object.freeze({
    message,
    text,
    bytes: Buffer.byteLength(text),
    [RUNTIME_PUBLICATION_BRAND]: true as const,
  });
  runtimePublications.add(publication);
  return publication;
}

export function assertRuntimePublication(publication: RuntimePublication): void {
  if (!runtimePublications.has(publication)) {
    throw new TypeError("application publication was not prepared by dbzz");
  }
}
/**
 * Exact-byte ownership for publications captured during an auth transition.
 * Frames are valid only until `release()`; release is idempotent and empties
 * the batch so terminal Session cleanup cannot retain obsolete publications.
 */
export interface RuntimePublicationBatch {
  readonly frames: readonly RuntimePublication[];
  readonly bytes: number;
  release(): void;
}
export type SessionControlMessage = WelcomeMessage | AuthenticatedMessage | PongMessage | ErrorMessage;

function authenticationDescriptor(principal: ClientPrincipal): AuthenticationDescriptor {
  if (principal.kind === "anonymous") return Object.freeze({ principal: "anonymous" });
  const provenance = Object.freeze({ issuer: principal.issuer, subject: principal.subject });
  return principal.kind === "user"
    ? Object.freeze({ principal: "user", identity: principal.identity, provenance })
    : Object.freeze({ principal: "workload", provenance });
}

/**
 * A bounded transport queue. Control writes use reserved capacity, while
 * application writes are epoch-tagged and remain removable until accepted in
 * order. A resolved write must not be overtaken by a later write.
 */
export interface SessionSink {
  sendControl(message: SessionControlMessage): Promise<void>;
  sendApplication(authEpoch: number, publication: RuntimePublication): Promise<void>;
  dropApplicationFramesBefore(authEpoch: number): Promise<void>;
  close(outcome: Outcome): Promise<void>;
}

export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SessionAuthAttemptKind = "hello" | "refresh" | "sign-out";

export interface SessionAuthAttemptInput {
  readonly kind: SessionAuthAttemptKind;
  readonly clientSessionId: string;
  readonly attemptId?: number;
}

export interface SessionAuthAttemptObservation {
  finish(error?: unknown): void;
}

export type SessionAuthObserver = (
  input: SessionAuthAttemptInput,
) => SessionAuthAttemptObservation | undefined;

const SESSION_AUTH_OBSERVER: unique symbol = Symbol("dbzz.sessionAuthObserver");

interface InternalSessionOptions {
  readonly [SESSION_AUTH_OBSERVER]?: SessionAuthObserver;
}

interface PendingAuthObservation {
  readonly owner: object;
  readonly observation: SessionAuthAttemptObservation;
}

export interface SessionRuntimeContext {
  readonly clientSessionId: string;
  readonly principal: Principal;
  /** Fixed-width caller ownership shared with HTTP and immutable for this auth epoch. */
  readonly fairnessKey: string;
  readonly authEpoch: number;
  /** Aborted as soon as an auth refresh, expiry, invalidation, or close starts. */
  readonly signal: AbortSignal;
  /** Publishes an application frame only while this exact epoch is current. */
  publish(message: RuntimePublication): Promise<boolean>;
}

export interface RuntimeAuthTransition {
  readonly attemptId: number;
  readonly reason: "refresh" | "sign-out";
  readonly from: SessionRuntimeContext;
  readonly to: SessionRuntimeContext;
}

export interface RuntimeMutationResult {
  readonly value: unknown;
  readonly receipt: MutationReceipt;
}

/** One raw WebSocket message whose byte ownership remains inside Session. */
export type SessionWireFrame = string | Uint8Array;

/** One validated operation paired with the byte count owned by its transport. */
export interface RuntimeRequest<Message> {
  readonly message: Message;
  readonly bytes: number;
}

const runtimeRequestBytes = new WeakMap<object, number>();

function prepareRuntimeRequest<Message>(message: Message, bytes: number): RuntimeRequest<Message> {
  const request = Object.freeze({ message, bytes });
  runtimeRequestBytes.set(request, bytes);
  return request;
}

/** Claims exact Session-owned transport bytes once; intentionally absent from the public index. */
export function claimRuntimeRequestBytes(request: RuntimeRequest<unknown>): number | undefined {
  const bytes = runtimeRequestBytes.get(request);
  if (bytes !== undefined) runtimeRequestBytes.delete(request);
  return bytes;
}

/** Transport-independent adapter implemented by the database runtime. */
export interface RuntimePort {
  readonly credentialVerifier: CredentialVerifier | undefined;
  resolveIdentity(account: ExternalAccount, signal?: AbortSignal): Promise<Identity>;
  openSession(context: SessionRuntimeContext): Promise<void>;
  transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch>;
  subscribe(context: SessionRuntimeContext, request: RuntimeRequest<SubscribeMessage>): Promise<void>;
  unsubscribe(context: SessionRuntimeContext, request: RuntimeRequest<UnsubscribeMessage>): Promise<void>;
  reset(context: SessionRuntimeContext, request: RuntimeRequest<ResetRequestMessage>): Promise<void>;
  /** Publishes the success or error frame before settling. */
  query(context: SessionRuntimeContext, request: RuntimeRequest<QueryMessage>): Promise<unknown>;
  /** Publishes the success or error frame before settling. */
  mutation(context: SessionRuntimeContext, request: RuntimeRequest<MutationMessage>): Promise<RuntimeMutationResult>;
  closeSession(context: SessionRuntimeContext, outcome: Outcome): Promise<void>;
}

export type SessionPhase = "awaiting_hello" | "opening" | "active" | "refreshing" | "closed";

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly clientSessionId: string | null;
  readonly principal: Principal | null;
  readonly authEpoch: number;
  readonly latestAttemptId: number;
}

export type SessionLimits = Pick<
  ServiceLimits,
  "maxRequestBytes" | "maxFrameBytes"
>;

export interface SessionOptions {
  readonly runtime: RuntimePort;
  readonly sink: SessionSink;
  /** Actual peer address captured by the transport; forwarded headers are not trusted. */
  readonly source: TransportSource;
  readonly clock?: SessionClock;
  readonly revocationDeadlineMs?: number;
  /** Per-session request and transport-frame limits. */
  readonly limits?: SessionLimits;
}

/** Attach package-internal auth observation without expanding Session's public options. */
export function withSessionAuthObserver<T extends SessionOptions>(
  options: T,
  observer: SessionAuthObserver | undefined,
): T {
  if (observer !== undefined) Object.assign(options, { [SESSION_AUTH_OBSERVER]: observer });
  return options;
}

const MAX_TIMER_DELAY_MS = 0x7fff_ffff;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

const SYSTEM_CLOCK: SessionClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function internalError(cause: unknown): DbzzError {
  return new DbzzError("internal", "internal error", { cause });
}

function verifierError(cause: unknown): DbzzError {
  return isDbzzError(cause)
    ? cause
    : new DbzzError("auth_unavailable", "credential verification is temporarily unavailable", {
        retryable: true,
        cause,
      });
}

function operationError(cause: unknown): DbzzError {
  return isDbzzError(cause) ? cause : internalError(cause);
}

function protocolError(error: ProtocolError): DbzzError {
  return new DbzzError(error.code, error.message, { cause: error });
}

function authStale(): DbzzError {
  return new DbzzError("auth_stale", "authentication state changed");
}

function aborted(controller: AbortController, reason: DbzzError): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export class Session {
  readonly revocationDeadlineMs: number;
  readonly maxRequestBytes: number;
  readonly maxFrameBytes: number;

  private readonly runtime: RuntimePort;
  private readonly sink: SessionSink;
  private readonly observeAuth: SessionAuthObserver | undefined;
  private readonly clock: SessionClock;
  private readonly source: TransportSource;
  private phase: SessionPhase = "awaiting_hello";
  private clientSessionId: string | null = null;
  private principal: Principal | null = null;
  private context: SessionRuntimeContext | null = null;
  private authEpoch = 0;
  private latestAttemptId = 0;
  private paused = true;
  private epochController = new AbortController();
  private pendingAuthController: AbortController | null = null;
  private pendingAuthObservation: PendingAuthObservation | null = null;
  private lastAuthAck: AuthenticatedMessage | null = null;
  private expiryTimer: unknown;
  private authTail: Promise<void> = Promise.resolve();
  private authPublications: RuntimePublicationBatch | null = null;
  private opening: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private unsubscribeInvalidation: (() => void) | null = null;

  constructor(options: SessionOptions) {
    const revocationDeadlineMs = options.revocationDeadlineMs ?? MAX_REVOCATION_DEADLINE_MS;
    validateCredentialVerifierRevocation(options.runtime.credentialVerifier, revocationDeadlineMs);
    this.runtime = options.runtime;
    this.sink = options.sink;
    this.observeAuth = (options as SessionOptions & InternalSessionOptions)[SESSION_AUTH_OBSERVER];
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.source = transportSource(options.source);
    const limits = options.limits ?? PRODUCTION_LIMITS;
    this.maxRequestBytes = positiveInteger(limits.maxRequestBytes, "maxRequestBytes");
    this.maxFrameBytes = positiveInteger(limits.maxFrameBytes, "maxFrameBytes");
    this.revocationDeadlineMs = revocationDeadlineMs;
    if (this.runtime.credentialVerifier !== undefined) {
      this.unsubscribeInvalidation = this.runtime.credentialVerifier.subscribeInvalidation((invalidation) => {
        this.onInvalidation(invalidation);
      });
    }
  }

  snapshot(): SessionSnapshot {
    return Object.freeze({
      phase: this.phase,
      clientSessionId: this.clientSessionId,
      principal: this.principal,
      authEpoch: this.authEpoch,
      latestAttemptId: this.latestAttemptId,
    });
  }

  get currentClientSessionId(): string | null {
    return this.clientSessionId;
  }

  /** Owns exact byte admission and Protocol-2 decoding for one raw WebSocket message. */
  handle(raw: SessionWireFrame): Promise<void> {
    let bytes: number;
    if (typeof raw === "string") {
      bytes = Buffer.byteLength(raw);
    } else if (raw instanceof Uint8Array) {
      bytes = raw.byteLength;
    } else {
      return this.rejectFrame(new DbzzError("malformed", "client frame must be text or binary"));
    }
    if (bytes > this.maxFrameBytes) {
      return this.rejectFrame(new DbzzError("overloaded", "client frame exceeds maxFrameBytes", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      }));
    }
    if (bytes > this.maxRequestBytes) {
      return this.rejectFrame(new DbzzError("overloaded", "client request exceeds maxRequestBytes", {
        resource: "operation",
      }));
    }

    let text: string;
    try {
      text = typeof raw === "string" ? raw : STRICT_UTF8.decode(raw);
    } catch (cause) {
      return this.rejectFrame(new DbzzError("malformed", "client frame is not valid UTF-8", { cause }));
    }
    let message: ClientMessage;
    try {
      message = parseClientMessage(decode(text));
    } catch (cause) {
      const error = cause instanceof ProtocolError
        ? protocolError(cause)
        : new DbzzError("malformed", "malformed client frame", { cause });
      return this.rejectFrame(error);
    }

    let result: Promise<void>;
    try {
      result = Promise.resolve(this.dispatchFrame(message, bytes));
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.catch((error) => {
      void this.terminate(operationError(error));
    });
    return result;
  }

  private rejectFrame(error: DbzzError): Promise<never> {
    const rejected = Promise.reject(error);
    // Keep the transport outcome owned by Session even when its caller does
    // not observe the returned rejection.
    void rejected.catch(() => {});
    void this.terminate(error);
    return rejected;
  }

  close(error: DbzzError = new DbzzError("draining", "session closed")): Promise<void> {
    return this.terminate(error);
  }

  private dispatchFrame(message: ClientMessage, bytes: number): void | Promise<void> {
    if (this.phase === "closed") return;

    if (this.phase === "awaiting_hello") {
      if (message.t !== "hello") {
        void this.terminate(new DbzzError("malformed", "hello must be the first frame"));
        return;
      }
      this.phase = "opening";
      this.opening = this.open(message.clientSessionId, message.credential);
      return this.opening;
    }
    if (this.phase === "opening") {
      void this.terminate(new DbzzError("malformed", "welcome must precede further client frames"));
      return;
    }
    if (message.t === "hello") {
      void this.terminate(new DbzzError("malformed", "hello has already been received"));
      return;
    }

    switch (message.t) {
      case "auth":
        return this.acceptAuth(message);
      case "ping":
        return this.sendControl({ v: PROTOCOL_VERSION, t: "pong" });
      case "sub":
      case "unsub":
      case "reset":
      case "q":
      case "m":
        if (this.paused) {
          return this.sendControlError(message.id, authStale());
        }
        return this.runOperation(prepareRuntimeRequest(message, bytes));
    }
  }

  private async open(clientSessionId: string, credential: Credential): Promise<void> {
    const authController = new AbortController();
    this.pendingAuthController = authController;
    const observationOwner = this.observeAuth === undefined ? undefined : authController;
    if (observationOwner !== undefined) {
      this.setPendingAuthObservation(
        observationOwner,
        this.beginAuthObservation({ kind: "hello", clientSessionId }),
      );
    }
    let principal: ClientPrincipal;
    try {
      principal = await this.verifyCredential(credential, authController.signal);
    } catch (error) {
      const failure = verifierError(error);
      if (this.pendingAuthController === authController) this.pendingAuthController = null;
      if (observationOwner !== undefined) {
        this.finishPendingAuthObservation(observationOwner, failure);
      }
      void this.terminate(failure);
      return;
    }
    if (this.pendingAuthController === authController) this.pendingAuthController = null;
    if (observationOwner !== undefined) this.finishPendingAuthObservation(observationOwner);
    if (this.isClosed()) return;
    try {
      this.clientSessionId = clientSessionId;
      this.principal = principal;
      this.authEpoch = 0;
      this.paused = true;
      this.epochController = new AbortController();
      this.scheduleExpiry(principal, this.authEpoch);
      if (this.isClosed()) return;
      const context = this.createRuntimeContext(principal, this.authEpoch, this.epochController);
      this.context = context;
      await this.runtime.openSession(context);
      if (this.isClosed()) return;
      await this.sendControl({
        v: PROTOCOL_VERSION,
        t: "welcome",
        clientSessionId,
        authEpoch: this.authEpoch,
        ...authenticationDescriptor(principal),
      });
      if (this.isClosed()) return;
      this.paused = false;
      this.phase = "active";
    } catch (error) {
      void this.terminate(operationError(error));
    }
  }

  private acceptAuth(message: ClientAuthMessage): Promise<void> {
    if (message.attemptId < this.latestAttemptId) return Promise.resolve();
    if (message.attemptId === this.latestAttemptId) {
      if (this.lastAuthAck?.attemptId === message.attemptId && this.phase === "active") {
        return this.sendControl(this.lastAuthAck);
      }
      return Promise.resolve();
    }

    this.latestAttemptId = message.attemptId;
    this.paused = true;
    this.phase = "refreshing";
    aborted(this.epochController, authStale());
    const stale = authStale();
    if (this.pendingAuthController !== null) aborted(this.pendingAuthController, stale);
    this.finishPendingAuthObservation(undefined, stale);
    const transitionController = new AbortController();
    this.pendingAuthController = transitionController;
    const clientSessionId = this.clientSessionId;
    const observation = clientSessionId === null || this.observeAuth === undefined
      ? undefined
      : this.beginAuthObservation({
          kind: message.credential.kind === "anonymous" ? "sign-out" : "refresh",
          clientSessionId,
          attemptId: message.attemptId,
        });
    this.setPendingAuthObservation(transitionController, observation);

    void this.verifyCredential(message.credential, transitionController.signal).then(
      (principal) => {
        this.finishPendingAuthObservation(transitionController);
        this.queueAuthCompletion(message, transitionController, principal);
      },
      (error) => {
        const failure = verifierError(error);
        this.finishPendingAuthObservation(transitionController, failure);
        this.queueAuthCompletion(message, transitionController, failure);
      },
    );
    return Promise.resolve();
  }

  private enqueueAuth(task: () => Promise<void>): Promise<void> {
    const run = this.authTail.then(task, task);
    const safe = run.catch((error) => {
      void this.terminate(operationError(error));
    });
    this.authTail = safe;
    return safe;
  }

  private queueAuthCompletion(
    message: ClientAuthMessage,
    controller: AbortController,
    result: ClientPrincipal | DbzzError,
  ): void {
    void this.enqueueAuth(() => this.completeAuth(message, controller, result));
  }

  private async completeAuth(
    message: ClientAuthMessage,
    transitionController: AbortController,
    result: ClientPrincipal | DbzzError,
  ): Promise<void> {
    if (this.isClosed() || message.attemptId !== this.latestAttemptId) return;
    if (isDbzzError(result)) {
      void this.terminate(result);
      return;
    }
    if (this.principal === null || this.clientSessionId === null) {
      void this.terminate(internalError(new Error("auth completed before hello")));
      return;
    }
    if (result.kind !== "anonymous" && result.expiresAt <= this.readNow()) {
      void this.terminate(new DbzzError("unauthenticated", "credential expired"));
      return;
    }
    if (this.authEpoch >= Number.MAX_SAFE_INTEGER) {
      void this.terminate(internalError(new Error("auth epoch exhausted")));
      return;
    }

    const fromContext = this.context;
    if (fromContext === null) {
      void this.terminate(internalError(new Error("auth completed before runtime context")));
      return;
    }
    const nextEpoch = this.authEpoch + 1;
    const toContext = this.createRuntimeContext(result, nextEpoch, transitionController);

    try {
      await this.sink.dropApplicationFramesBefore(nextEpoch);
      if (this.isClosed() || transitionController.signal.aborted) return;
      const publications = await this.runtime.transitionAuth({
        attemptId: message.attemptId,
        reason: message.credential.kind === "anonymous" ? "sign-out" : "refresh",
        from: fromContext,
        to: toContext,
      });
      this.authPublications = publications;
      try {
        if (this.isClosed()) {
          aborted(transitionController, authStale());
          return;
        }

        // A resolved runtime transition is committed even if a newer attempt
        // arrived while it was running. Keep internal state aligned, but expose
        // it only if this attempt is still latest.
        this.principal = result;
        this.context = toContext;
        this.authEpoch = nextEpoch;
        this.epochController = transitionController;
        this.scheduleExpiry(result, nextEpoch);

        if (message.attemptId !== this.latestAttemptId || transitionController.signal.aborted) {
          aborted(transitionController, authStale());
          return;
        }
        for (const publication of publications.frames) {
          assertRuntimePublication(publication);
          await this.sink.sendApplication(nextEpoch, publication);
          if (this.isClosed() || message.attemptId !== this.latestAttemptId) return;
        }
        const ack: AuthenticatedMessage = {
          v: PROTOCOL_VERSION,
          t: "auth",
          attemptId: message.attemptId,
          authEpoch: nextEpoch,
          ...authenticationDescriptor(result),
        };
        await this.sendControl(ack);
        if (this.isClosed() || message.attemptId !== this.latestAttemptId) return;
        this.lastAuthAck = ack;
        this.paused = false;
        this.phase = "active";
        if (this.pendingAuthController === transitionController) this.pendingAuthController = null;
      } finally {
        if (this.authPublications === publications) this.authPublications = null;
        publications.release();
      }
    } catch (error) {
      const obsolete =
        this.isClosed() ||
        message.attemptId !== this.latestAttemptId ||
        transitionController.signal.aborted;
      aborted(transitionController, authStale());
      if (obsolete) return;
      void this.terminate(operationError(error));
    }
  }

  private async runOperation(
    request: RuntimeRequest<
      SubscribeMessage | UnsubscribeMessage | ResetRequestMessage | QueryMessage | MutationMessage
    >,
  ): Promise<void> {
    const { message } = request;
    const context = this.context;
    if (this.principal === null || this.clientSessionId === null || context === null) {
      void this.terminate(internalError(new Error("operation started before hello")));
      return;
    }
    const epoch = this.authEpoch;
    if (context.signal.aborted || !this.isCurrent(epoch)) return;
    try {
      switch (message.t) {
        case "sub":
          await this.runtime.subscribe(context, request as RuntimeRequest<SubscribeMessage>);
          return;
        case "unsub":
          await this.runtime.unsubscribe(context, request as RuntimeRequest<UnsubscribeMessage>);
          return;
        case "reset":
          await this.runtime.reset(context, request as RuntimeRequest<ResetRequestMessage>);
          return;
        case "q": {
          await this.runtime.query(context, request as RuntimeRequest<QueryMessage>);
          return;
        }
        case "m": {
          await this.runtime.mutation(context, request as RuntimeRequest<MutationMessage>);
          return;
        }
      }
    } catch {
      // Runtime publishes every application outcome before rejecting. Session
      // has no second outcome to publish.
    }
  }

  private createRuntimeContext(
    principal: Principal,
    authEpoch: number,
    controller: AbortController,
  ): SessionRuntimeContext {
    const clientSessionId = this.clientSessionId;
    if (clientSessionId === null) throw new Error("runtime context requires hello");
    return Object.freeze({
      clientSessionId,
      principal,
      fairnessKey: callerFairnessKey(principal, this.source),
      authEpoch,
      signal: controller.signal,
      publish: (publication: RuntimePublication) => this.sendApplication(authEpoch, publication),
    });
  }

  private async sendApplication(
    authEpoch: number,
    publication: RuntimePublication,
  ): Promise<boolean> {
    if (!this.isCurrent(authEpoch) || this.paused) return false;
    try {
      assertRuntimePublication(publication);
      await this.sink.sendApplication(authEpoch, publication);
      return this.isCurrent(authEpoch) && !this.paused;
    } catch (error) {
      void this.terminate(operationError(error));
      return false;
    }
  }

  private sendControlError(id: number, error: DbzzError): Promise<void> {
    return this.sendControl({
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: outcomeFromError(error),
    });
  }

  private async sendControl(message: SessionControlMessage): Promise<void> {
    if (this.phase === "closed") return;
    try {
      await this.sink.sendControl(message);
    } catch (error) {
      void this.terminate(operationError(error));
    }
  }

  private async verifyCredential(
    credential: Credential,
    signal?: AbortSignal,
  ): Promise<ClientPrincipal> {
    const principal = await verifyClientCredential(
      credential,
      this.runtime.credentialVerifier,
      (account) => this.runtime.resolveIdentity(account, signal),
      () => this.readNow(),
    );
    if (signal?.aborted) throw signal.reason;
    return principal;
  }

  private beginAuthObservation(
    input: SessionAuthAttemptInput,
  ): SessionAuthAttemptObservation | undefined {
    try {
      return this.observeAuth?.(input);
    } catch {
      return undefined;
    }
  }

  private finishAuthObservation(
    observation: SessionAuthAttemptObservation | undefined,
    error?: unknown,
  ): void {
    try {
      observation?.finish(error);
    } catch {
      // Authentication owns application progress; observation is fail-open.
    }
  }

  private setPendingAuthObservation(
    owner: object,
    observation: SessionAuthAttemptObservation | undefined,
  ): void {
    this.pendingAuthObservation = observation === undefined ? null : { owner, observation };
  }

  private finishPendingAuthObservation(owner?: object, error?: unknown): void {
    const pending = this.pendingAuthObservation;
    if (pending === null || (owner !== undefined && pending.owner !== owner)) return;
    this.pendingAuthObservation = null;
    this.finishAuthObservation(pending.observation, error);
  }

  private isCurrent(authEpoch: number): boolean {
    return this.phase !== "closed" && this.authEpoch === authEpoch;
  }

  private isClosed(): boolean {
    return this.phase === "closed";
  }

  private readNow(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now)) throw new RangeError("session clock must return a finite value");
    return now;
  }

  private scheduleExpiry(principal: Principal, authEpoch: number): void {
    this.clearExpiry();
    if (
      principal.kind === "anonymous" ||
      principal.kind === "system" ||
      principal.kind === "mcp"
    ) return;
    const schedule = () => {
      if (this.phase === "closed" || this.authEpoch !== authEpoch || this.principal !== principal) return;
      const remaining = principal.expiresAt - this.readNow();
      if (remaining <= 0) {
        void this.terminate(new DbzzError("unauthenticated", "credential expired"));
        return;
      }
      this.expiryTimer = this.clock.setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    schedule();
  }

  private clearExpiry(): void {
    if (this.expiryTimer === undefined) return;
    this.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private onInvalidation(invalidation: PrincipalInvalidation): void {
    const error = new DbzzError("unauthenticated", "credential revoked");
    if (this.pendingAuthController !== null) {
      aborted(this.pendingAuthController, error);
      void this.terminate(error);
      return;
    }
    const principal = this.principal;
    if (
      this.phase === "closed" ||
      principal === null ||
      (principal.kind !== "user" && principal.kind !== "workload") ||
      principal.issuer !== invalidation.issuer ||
      (invalidation.subject !== undefined && principal.subject !== invalidation.subject) ||
      (invalidation.tokenId !== undefined && principal.tokenId !== invalidation.tokenId)
    ) {
      return;
    }
    // Immediate fail-closed is stronger than the configured maximum deadline
    // and uses the sink's reserved control path.
    void this.terminate(error);
  }

  private terminate(error: DbzzError): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    const context = this.context;
    const outcome = outcomeFromError(error);
    this.phase = "closed";
    this.paused = true;
    let resolveClose!: () => void;
    this.closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    aborted(this.epochController, error);
    if (this.pendingAuthController !== null) aborted(this.pendingAuthController, error);
    this.finishPendingAuthObservation(undefined, error);
    const authPublications = this.authPublications;
    this.authPublications = null;
    authPublications?.release();
    this.clearExpiry();
    const unsubscribe = this.unsubscribeInvalidation;
    this.unsubscribeInvalidation = null;
    try {
      unsubscribe?.();
    } catch {
      // Session state is already closed; cleanup remains best effort.
    }

    const closeRuntime = this.opening.catch(() => {}).then(() =>
      context === null
        ? undefined
        : Promise.resolve(this.runtime.closeSession(context, outcome)).catch(() => {}));
    const closeSink = (async () => {
      try {
        await this.sink.sendControl({
          v: PROTOCOL_VERSION,
          t: "err",
          id: null,
          outcome,
        });
      } catch {
        // The terminal frame is best effort; close must still progress.
      }
      try {
        await this.sink.close(outcome);
      } catch {
        // The transport is already considered closed by the Session owner.
      }
    })();
    void Promise.all([closeRuntime, closeSink]).then(resolveClose, resolveClose);
    return this.closePromise;
  }
}
