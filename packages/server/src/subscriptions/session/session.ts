import {
  PROTOCOL_VERSION,
  type AuthenticationDescriptor,
  type AuthenticatedMessage,
  type ChannelJoinMessage,
  type ChannelLeaveMessage,
  type ChannelSendMessage,
  type ClientAuthMessage,
  type ClientMessage,
  type Credential,
  type MutationMessage,
  type ProcedureCancelMessage,
  type ProcedureMessage,
  type QueryMessage,
  type ResetRequestMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
} from "@ackerdb/core";
import { positiveSafeInteger } from "../../shared/numbers.ts";
import {
  verifyClientCredential,
  type ClientPrincipal,
  type Principal,
  type PrincipalInvalidation,
} from "../../auth/credentials.ts";
import {
  MAX_REVOCATION_DEADLINE_MS,
  validateCredentialVerifierRevocation,
} from "../../auth/lease.ts";
import {
  invalidationReaches,
  subscribeAuthInvalidation,
  type AuthInvalidationScope,
} from "../../auth/invalidation.ts";
import {
  callerFairnessKey,
  transportSource,
  type TransportSource,
} from "../../runtime/caller.ts";
import { AckerDBError, isAckerDBError } from "../../shared/errors.ts";
import { PRODUCTION_LIMITS } from "../../runtime/limits.ts";
import { outcomeFromError } from "../../runtime/outcome.ts";
import {
  assertRuntimePublication,
  prepareRuntimeRequest,
  type RuntimePort,
  type RuntimePublication,
  type RuntimePublicationBatch,
  type RuntimeRequest,
  type SessionClock,
  type SessionControlMessage,
  type SessionOptions,
  type SessionPhase,
  type SessionRuntimeContext,
  type SessionSink,
  type SessionSnapshot,
} from "./contract.ts";
import {
  decodeClientFrame,
  type DecodedClientFrame,
  type SessionWireFrame,
} from "./frame.ts";
import { PendingAuthObservations } from "./observation.ts";

function authenticationDescriptor(
  principal: ClientPrincipal,
  nowMs: number,
): AuthenticationDescriptor {
  if (principal.kind === "anonymous") return Object.freeze({ principal: "anonymous" });
  const provenance = Object.freeze({ issuer: principal.issuer, subject: principal.subject });
  const credentialTtlMs = Math.max(0, Math.floor(principal.expiresAt - nowMs));
  return principal.kind === "user"
    ? Object.freeze({ principal: "user", identity: principal.identity, provenance, credentialTtlMs })
    : Object.freeze({ principal: "workload", provenance, credentialTtlMs });
}

const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

const SYSTEM_CLOCK: SessionClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function internalError(cause: unknown): AckerDBError {
  return new AckerDBError("internal", "internal error", { cause });
}

function verifierError(cause: unknown): AckerDBError {
  return isAckerDBError(cause)
    ? cause
    : new AckerDBError("auth_unavailable", "credential verification is temporarily unavailable", {
        retryable: true,
        cause,
      });
}

function operationError(cause: unknown): AckerDBError {
  return isAckerDBError(cause) ? cause : internalError(cause);
}


function authStale(): AckerDBError {
  return new AckerDBError("auth_stale", "authentication state changed");
}

function aborted(controller: AbortController, reason: AckerDBError): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

export class Session {
  readonly revocationDeadlineMs: number;
  readonly maxRequestBytes: number;
  readonly maxFrameBytes: number;

  private readonly runtime: RuntimePort;
  private readonly sink: SessionSink;
  private readonly authObservations: PendingAuthObservations;
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
  private lastAuthAck: AuthenticatedMessage | null = null;
  private expiryTimer: unknown;
  private authTail: Promise<void> = Promise.resolve();
  private authPublications: RuntimePublicationBatch | null = null;
  private opening: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private unsubscribeInvalidation: (() => void) | null = null;
  private invalidationScope: AuthInvalidationScope | undefined;
  private readonly activeProcedures = new Map<number, AbortController>();

  constructor(options: SessionOptions) {
    const revocationDeadlineMs = options.revocationDeadlineMs ?? MAX_REVOCATION_DEADLINE_MS;
    validateCredentialVerifierRevocation(options.runtime.credentialVerifier, revocationDeadlineMs);
    this.runtime = options.runtime;
    this.sink = options.sink;
    this.authObservations = new PendingAuthObservations(options);
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.source = transportSource(options.source);
    const limits = options.limits ?? PRODUCTION_LIMITS;
    this.maxRequestBytes = positiveSafeInteger(limits.maxRequestBytes, "maxRequestBytes");
    this.maxFrameBytes = positiveSafeInteger(limits.maxFrameBytes, "maxFrameBytes");
    this.revocationDeadlineMs = revocationDeadlineMs;
    if (this.runtime.credentialVerifier !== undefined) {
      const subscription = subscribeAuthInvalidation(this.runtime.credentialVerifier, (invalidation) => {
        this.onInvalidation(invalidation);
      });
      this.unsubscribeInvalidation = subscription.unsubscribe;
      this.invalidationScope = subscription.scope;
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
    let frame: DecodedClientFrame;
    try {
      frame = decodeClientFrame(raw, this.maxFrameBytes, this.maxRequestBytes);
    } catch (error) {
      return this.rejectFrame(error as AckerDBError);
    }

    let result: Promise<void>;
    try {
      result = Promise.resolve(this.dispatchFrame(frame.message, frame.bytes));
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.catch((error) => {
      void this.terminate(operationError(error));
    });
    return result;
  }

  private rejectFrame(error: AckerDBError): Promise<never> {
    const rejected = Promise.reject(error);
    // Keep the transport outcome owned by Session even when its caller does
    // not observe the returned rejection.
    void rejected.catch(() => {});
    void this.terminate(error);
    return rejected;
  }

  close(error: AckerDBError = new AckerDBError("draining", "session closed")): Promise<void> {
    return this.terminate(error);
  }

  private dispatchFrame(message: ClientMessage, bytes: number): void | Promise<void> {
    if (this.phase === "closed") return;

    if (this.phase === "awaiting_hello") {
      if (message.t !== "hello") {
        void this.terminate(new AckerDBError("malformed", "hello must be the first frame"));
        return;
      }
      this.phase = "opening";
      this.opening = this.open(message.clientSessionId, message.credential);
      return this.opening;
    }
    if (this.phase === "opening") {
      void this.terminate(new AckerDBError("malformed", "welcome must precede further client frames"));
      return;
    }
    if (message.t === "hello") {
      void this.terminate(new AckerDBError("malformed", "hello has already been received"));
      return;
    }

    switch (message.t) {
      case "auth":
        return this.acceptAuth(message);
      case "ping":
        return this.sendControl({ v: PROTOCOL_VERSION, t: "pong" });
      case "cancel":
        return this.cancelProcedure(message);
      case "sub":
      case "unsub":
      case "reset":
      case "channel_join":
      case "channel_leave":
      case "channel_send":
      case "q":
      case "m":
        if (this.paused) {
          return this.sendControlError(message.id, authStale());
        }
        return this.runOperation(prepareRuntimeRequest(message, bytes));
      case "p":
        if (this.paused) {
          return this.sendControlError(message.id, authStale());
        }
        return this.runProcedure(message, bytes);
    }
  }

  private cancelProcedure(message: ProcedureCancelMessage): void {
    const controller = this.activeProcedures.get(message.id);
    if (controller !== undefined) {
      aborted(
        controller,
        new AckerDBError("unavailable", "procedure request was canceled", {
          resource: "operation",
        }),
      );
    }
  }

  private async runProcedure(message: ProcedureMessage, bytes: number): Promise<void> {
    const context = this.context;
    if (this.principal === null || this.clientSessionId === null || context === null) {
      void this.terminate(internalError(new Error("procedure started before hello")));
      return;
    }
    if (this.activeProcedures.has(message.id)) {
      await this.sendControlError(
        message.id,
        new AckerDBError("conflict", "procedure request ID is already active"),
      );
      return;
    }
    if (context.signal.aborted || !this.isCurrent(this.authEpoch)) return;

    const controller = new AbortController();
    this.activeProcedures.set(message.id, controller);
    try {
      await this.runtime.procedure(
        context,
        prepareRuntimeRequest(message, bytes, controller.signal),
      );
    } catch {
      // Runtime publishes every application outcome before rejecting.
    } finally {
      if (this.activeProcedures.get(message.id) === controller) {
        this.activeProcedures.delete(message.id);
      }
    }
  }

  private async open(clientSessionId: string, credential: Credential): Promise<void> {
    const authController = new AbortController();
    this.pendingAuthController = authController;
    const observationOwner = this.authObservations.enabled ? authController : undefined;
    if (observationOwner !== undefined) {
      this.authObservations.begin(observationOwner, { kind: "hello", clientSessionId });
    }
    let principal: ClientPrincipal;
    try {
      principal = await this.verifyCredential(credential, authController.signal);
    } catch (error) {
      const failure = verifierError(error);
      if (this.pendingAuthController === authController) this.pendingAuthController = null;
      if (observationOwner !== undefined) {
        this.authObservations.finish(observationOwner, failure);
      }
      void this.terminate(failure);
      return;
    }
    if (this.pendingAuthController === authController) this.pendingAuthController = null;
    if (observationOwner !== undefined) this.authObservations.finish(observationOwner);
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
        ...authenticationDescriptor(principal, this.readNow()),
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
    const stale = authStale();
    aborted(this.epochController, stale);
    this.abortActiveProcedures(stale);
    if (this.pendingAuthController !== null) aborted(this.pendingAuthController, stale);
    this.authObservations.finish(undefined, stale);
    const transitionController = new AbortController();
    this.pendingAuthController = transitionController;
    const clientSessionId = this.clientSessionId;
    this.authObservations.begin(
      transitionController,
      clientSessionId === null
        ? undefined
        : {
            kind: message.credential.kind === "anonymous" ? "sign-out" : "refresh",
            clientSessionId,
            attemptId: message.attemptId,
          },
    );

    void this.verifyCredential(message.credential, transitionController.signal).then(
      (principal) => {
        this.authObservations.finish(transitionController);
        this.queueAuthCompletion(message, transitionController, principal);
      },
      (error) => {
        const failure = verifierError(error);
        this.authObservations.finish(transitionController, failure);
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
    result: ClientPrincipal | AckerDBError,
  ): void {
    void this.enqueueAuth(() => this.completeAuth(message, controller, result));
  }

  private async completeAuth(
    message: ClientAuthMessage,
    transitionController: AbortController,
    result: ClientPrincipal | AckerDBError,
  ): Promise<void> {
    if (this.isClosed() || message.attemptId !== this.latestAttemptId) return;
    if (isAckerDBError(result)) {
      void this.terminate(result);
      return;
    }
    if (this.principal === null || this.clientSessionId === null) {
      void this.terminate(internalError(new Error("auth completed before hello")));
      return;
    }
    if (result.kind !== "anonymous" && result.expiresAt <= this.readNow()) {
      void this.terminate(new AckerDBError("unauthenticated", "credential expired"));
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
          ...authenticationDescriptor(result, this.readNow()),
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
      | ChannelJoinMessage | ChannelLeaveMessage | ChannelSendMessage
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
        case "channel_join":
          await this.runtime.joinChannel(
            context,
            request as RuntimeRequest<ChannelJoinMessage>,
          );
          return;
        case "channel_leave":
          await this.runtime.leaveChannel(
            context,
            request as RuntimeRequest<ChannelLeaveMessage>,
          );
          return;
        case "channel_send":
          await this.runtime.sendChannel(
            context,
            request as RuntimeRequest<ChannelSendMessage>,
          );
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
      ...(this.invalidationScope === undefined
        ? {}
        : { invalidationScope: this.invalidationScope }),
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

  private sendControlError(id: number, error: AckerDBError): Promise<void> {
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
      this.runtime.resolveScopes,
    );
    if (signal?.aborted) throw signal.reason;
    return principal;
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
      // Vault credentials never expire; invalidation revokes them instead.
      !Number.isFinite(principal.expiresAt)
    ) return;
    const schedule = () => {
      if (this.phase === "closed" || this.authEpoch !== authEpoch || this.principal !== principal) return;
      const remaining = principal.expiresAt - this.readNow();
      if (remaining <= 0) {
        void this.terminate(new AckerDBError("unauthenticated", "credential expired"));
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
    const error = new AckerDBError("unauthenticated", "credential revoked");
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
      !invalidationReaches(principal, invalidation)
    ) {
      return;
    }
    // Immediate fail-closed is stronger than the configured maximum deadline
    // and uses the sink's reserved control path.
    void this.terminate(error);
  }

  private abortActiveProcedures(error: AckerDBError): void {
    for (const controller of this.activeProcedures.values()) aborted(controller, error);
  }

  private terminate(error: AckerDBError): Promise<void> {
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
    this.abortActiveProcedures(error);
    if (this.pendingAuthController !== null) aborted(this.pendingAuthController, error);
    this.authObservations.finish(undefined, error);
    const authPublications = this.authPublications;
    this.authPublications = null;
    authPublications?.release();
    this.clearExpiry();
    const unsubscribe = this.unsubscribeInvalidation;
    this.unsubscribeInvalidation = null;
    this.invalidationScope = undefined;
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
