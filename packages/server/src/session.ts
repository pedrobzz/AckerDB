import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseClientMessage,
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
  ANONYMOUS_PRINCIPAL,
  isPrincipal,
  type AnonymousPrincipal,
  type CredentialVerifier,
  type Principal,
  type PrincipalInvalidation,
  type VerifiedPrincipal,
} from "./auth.ts";
import { DbzzError, isDbzzError } from "./errors.ts";
import { outcomeFromError } from "./outcome.ts";

export type SubscriptionServerMessage = TransitionMessage | EventMessage;
export type RuntimePublication = SubscriptionServerMessage | ErrorMessage;
export type SessionApplicationMessage =
  | SubscriptionServerMessage
  | QueryOkMessage
  | MutationOkMessage
  | ErrorMessage;
export type SessionControlMessage = WelcomeMessage | AuthenticatedMessage | PongMessage | ErrorMessage;

/**
 * A bounded transport queue. Control writes use reserved capacity, while
 * application writes are epoch-tagged and remain removable until accepted in
 * order. A resolved write must not be overtaken by a later write.
 */
export interface SessionSink {
  sendControl(message: SessionControlMessage): Promise<void>;
  sendApplication(authEpoch: number, message: SessionApplicationMessage): Promise<void>;
  dropApplicationFramesBefore(authEpoch: number): Promise<void>;
  close(outcome: Outcome): Promise<void>;
}

export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionRuntimeContext {
  readonly clientSessionId: string;
  readonly principal: Principal;
  readonly authEpoch: number;
  /** Aborted as soon as an auth refresh, expiry, invalidation, or close starts. */
  readonly signal: AbortSignal;
  /** Publishes a subscription frame only while this exact epoch is current. */
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

/** Transport-independent adapter implemented by the database runtime. */
export interface RuntimePort {
  openSession(context: SessionRuntimeContext): Promise<void>;
  transitionAuth(transition: RuntimeAuthTransition): Promise<readonly RuntimePublication[]>;
  subscribe(context: SessionRuntimeContext, message: SubscribeMessage): Promise<void>;
  unsubscribe(context: SessionRuntimeContext, message: UnsubscribeMessage): Promise<void>;
  reset(context: SessionRuntimeContext, message: ResetRequestMessage): Promise<void>;
  query(context: SessionRuntimeContext, message: QueryMessage): Promise<unknown>;
  mutation(context: SessionRuntimeContext, message: MutationMessage): Promise<RuntimeMutationResult>;
  closeSession(context: SessionRuntimeContext, outcome: Outcome): Promise<void>;
}

export type SessionPhase = "awaiting_hello" | "active" | "refreshing" | "closed";

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly clientSessionId: string | null;
  readonly principal: Principal | null;
  readonly authEpoch: number;
  readonly latestAttemptId: number;
}

export interface SessionOptions {
  readonly runtime: RuntimePort;
  readonly sink: SessionSink;
  readonly verifier?: CredentialVerifier;
  readonly clock?: SessionClock;
  readonly revocationDeadlineMs?: number;
}

const DEFAULT_REVOCATION_DEADLINE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 0x7fff_ffff;
type ClientPrincipal = AnonymousPrincipal | VerifiedPrincipal;

const SYSTEM_CLOCK: SessionClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
    Object.freeze(current);
  }
}

function immutableVerifiedPrincipal(principal: VerifiedPrincipal): VerifiedPrincipal {
  if (!isPrincipal(principal) || (principal.kind !== "user" && principal.kind !== "workload")) {
    throw new DbzzError("auth_unavailable", "credential verifier returned an invalid principal", {
      retryable: true,
    });
  }
  deepFreeze(principal.claims);
  return Object.freeze({
    kind: principal.kind,
    issuer: principal.issuer,
    subject: principal.subject,
    claims: principal.claims,
    expiresAt: principal.expiresAt,
    tokenId: principal.tokenId,
  });
}

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

export class Session {
  readonly revocationDeadlineMs: number;

  private readonly runtime: RuntimePort;
  private readonly sink: SessionSink;
  private readonly verifier: CredentialVerifier | undefined;
  private readonly clock: SessionClock;
  private phase: SessionPhase = "awaiting_hello";
  private clientSessionId: string | null = null;
  private principal: Principal | null = null;
  private authEpoch = 0;
  private latestAttemptId = 0;
  private paused = true;
  private epochController = new AbortController();
  private pendingAuthController: AbortController | null = null;
  private lastAuthAck: AuthenticatedMessage | null = null;
  private expiryTimer: unknown;
  private handleTail: Promise<void> = Promise.resolve();
  private authTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private unsubscribeInvalidation: (() => void) | null = null;

  constructor(options: SessionOptions) {
    const revocationDeadlineMs = options.revocationDeadlineMs ?? DEFAULT_REVOCATION_DEADLINE_MS;
    if (
      !Number.isSafeInteger(revocationDeadlineMs) ||
      revocationDeadlineMs <= 0 ||
      revocationDeadlineMs > DEFAULT_REVOCATION_DEADLINE_MS
    ) {
      throw new RangeError(`revocationDeadlineMs must be an integer from 1 through ${DEFAULT_REVOCATION_DEADLINE_MS}`);
    }
    this.runtime = options.runtime;
    this.sink = options.sink;
    this.verifier = options.verifier;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.revocationDeadlineMs = revocationDeadlineMs;
    if (this.verifier !== undefined) {
      this.unsubscribeInvalidation = this.verifier.subscribeInvalidation((invalidation) => {
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

  /** Accepts one decoded or undecoded Protocol-2 frame and serializes dispatch. */
  handle(frame: unknown): Promise<void> {
    const run = this.handleTail.then(
      () => this.dispatchFrame(frame),
      () => this.dispatchFrame(frame),
    );
    this.handleTail = run.catch(() => {});
    return run;
  }

  close(error: DbzzError = new DbzzError("draining", "session closed")): Promise<void> {
    return this.terminate(error);
  }

  private async dispatchFrame(frame: unknown): Promise<void> {
    if (this.phase === "closed") return;
    let message: ClientMessage;
    try {
      message = parseClientMessage(frame);
    } catch (error) {
      await this.terminate(error instanceof ProtocolError ? protocolError(error) : internalError(error));
      return;
    }

    if (this.phase === "awaiting_hello") {
      if (message.t !== "hello") {
        await this.terminate(new DbzzError("malformed", "hello must be the first frame"));
        return;
      }
      await this.open(message.clientSessionId, message.credential);
      return;
    }
    if (message.t === "hello") {
      await this.terminate(new DbzzError("malformed", "hello has already been received"));
      return;
    }

    switch (message.t) {
      case "auth":
        await this.beginAuth(message);
        return;
      case "ping":
        await this.sendControl({ v: PROTOCOL_VERSION, t: "pong" });
        return;
      case "sub":
      case "unsub":
      case "reset":
      case "q":
      case "m":
        if (this.paused) {
          await this.sendControlError(message.id, authStale());
          return;
        }
        await this.runOperation(message);
        return;
    }
  }

  private async open(clientSessionId: string, credential: Credential): Promise<void> {
    let principal: ClientPrincipal;
    try {
      principal = await this.verifyCredential(credential);
    } catch (error) {
      await this.terminate(verifierError(error));
      return;
    }
    if (this.isClosed()) return;
    try {
      this.clientSessionId = clientSessionId;
      this.principal = principal;
      this.authEpoch = 0;
      this.paused = true;
      this.epochController = new AbortController();
      this.scheduleExpiry(principal, this.authEpoch);
      await this.runtime.openSession(this.runtimeContext(principal, this.authEpoch, this.epochController));
      if (this.isClosed()) return;
      await this.sendControl({
        v: PROTOCOL_VERSION,
        t: "welcome",
        clientSessionId,
        authEpoch: this.authEpoch,
        principal: principal.kind,
      });
      if (this.isClosed()) return;
      this.paused = false;
      this.phase = "active";
    } catch (error) {
      await this.terminate(operationError(error));
    }
  }

  private async beginAuth(message: ClientAuthMessage): Promise<void> {
    await this.enqueueAuth(() => this.startAuth(message));
  }

  private async startAuth(message: ClientAuthMessage): Promise<void> {
    if (message.attemptId < this.latestAttemptId) return;
    if (message.attemptId === this.latestAttemptId) {
      if (this.lastAuthAck?.attemptId === message.attemptId && this.phase === "active") {
        await this.sendControl(this.lastAuthAck);
      }
      return;
    }

    this.latestAttemptId = message.attemptId;
    this.paused = true;
    this.phase = "refreshing";
    aborted(this.epochController, authStale());
    if (this.pendingAuthController !== null) aborted(this.pendingAuthController, authStale());
    const transitionController = new AbortController();
    this.pendingAuthController = transitionController;

    void this.verifyCredential(message.credential).then(
      (principal) => this.queueAuthCompletion(message, transitionController, principal),
      (error) => this.queueAuthCompletion(message, transitionController, verifierError(error)),
    );
  }

  private enqueueAuth(task: () => Promise<void>): Promise<void> {
    const run = this.authTail.then(task, task);
    const safe = run.catch(async (error) => {
      await this.terminate(operationError(error));
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
    if (result instanceof DbzzError) {
      await this.terminate(result);
      return;
    }
    if (this.principal === null || this.clientSessionId === null) {
      await this.terminate(internalError(new Error("auth completed before hello")));
      return;
    }
    if (result.kind !== "anonymous" && result.expiresAt <= this.readNow()) {
      await this.terminate(new DbzzError("unauthenticated", "credential expired"));
      return;
    }
    if (this.authEpoch >= Number.MAX_SAFE_INTEGER) {
      await this.terminate(internalError(new Error("auth epoch exhausted")));
      return;
    }

    const fromPrincipal = this.principal;
    const fromEpoch = this.authEpoch;
    const nextEpoch = fromEpoch + 1;
    const fromContext = this.runtimeContext(fromPrincipal, fromEpoch, this.epochController);
    const toContext = this.runtimeContext(result, nextEpoch, transitionController);

    try {
      await this.sink.dropApplicationFramesBefore(nextEpoch);
      if (this.isClosed() || transitionController.signal.aborted) return;
      const transitions = await this.runtime.transitionAuth({
        attemptId: message.attemptId,
        reason: message.credential.kind === "anonymous" ? "sign-out" : "refresh",
        from: fromContext,
        to: toContext,
      });
      if (this.isClosed()) {
        aborted(transitionController, authStale());
        return;
      }

      // A resolved runtime transition is committed even if a newer attempt
      // arrived while it was running. Keep internal state aligned, but expose
      // it only if this attempt is still latest.
      this.principal = result;
      this.authEpoch = nextEpoch;
      this.epochController = transitionController;
      this.scheduleExpiry(result, nextEpoch);

      if (message.attemptId !== this.latestAttemptId || transitionController.signal.aborted) {
        aborted(transitionController, authStale());
        return;
      }
      for (const transition of transitions) {
        await this.sink.sendApplication(nextEpoch, transition);
        if (this.isClosed() || message.attemptId !== this.latestAttemptId) return;
      }
      const ack: AuthenticatedMessage = {
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: message.attemptId,
        authEpoch: nextEpoch,
        principal: result.kind,
      };
      await this.sendControl(ack);
      if (this.isClosed() || message.attemptId !== this.latestAttemptId) return;
      this.lastAuthAck = ack;
      this.paused = false;
      this.phase = "active";
      if (this.pendingAuthController === transitionController) this.pendingAuthController = null;
    } catch (error) {
      aborted(transitionController, authStale());
      if (
        this.isClosed() ||
        message.attemptId !== this.latestAttemptId ||
        transitionController.signal.aborted
      ) {
        return;
      }
      await this.terminate(operationError(error));
    }
  }

  private async runOperation(
    message: SubscribeMessage | UnsubscribeMessage | ResetRequestMessage | QueryMessage | MutationMessage,
  ): Promise<void> {
    if (this.principal === null || this.clientSessionId === null) {
      await this.terminate(internalError(new Error("operation started before hello")));
      return;
    }
    const epoch = this.authEpoch;
    const context = this.runtimeContext(this.principal, epoch, this.epochController);
    if (context.signal.aborted || !this.isCurrent(epoch)) return;
    try {
      switch (message.t) {
        case "sub":
          await this.runtime.subscribe(context, message);
          return;
        case "unsub":
          await this.runtime.unsubscribe(context, message);
          return;
        case "reset":
          await this.runtime.reset(context, message);
          return;
        case "q": {
          const value = await this.runtime.query(context, message);
          await this.sendApplication(epoch, {
            v: PROTOCOL_VERSION,
            t: "ok",
            id: message.id,
            kind: "query",
            value,
          });
          return;
        }
        case "m": {
          const result = await this.runtime.mutation(context, message);
          await this.sendApplication(epoch, {
            v: PROTOCOL_VERSION,
            t: "ok",
            id: message.id,
            kind: "mutation",
            value: result.value,
            receipt: result.receipt,
          });
          return;
        }
      }
    } catch (error) {
      if (!context.signal.aborted && this.isCurrent(epoch)) {
        await this.sendApplicationError(epoch, message.id, operationError(error));
      }
    }
  }

  private runtimeContext(
    principal: Principal,
    authEpoch: number,
    controller: AbortController,
  ): SessionRuntimeContext {
    const clientSessionId = this.clientSessionId;
    if (clientSessionId === null) throw new Error("runtime context requires hello");
    return Object.freeze({
      clientSessionId,
      principal,
      authEpoch,
      signal: controller.signal,
      publish: (message: RuntimePublication) => this.publish(authEpoch, message),
    });
  }

  private publish(authEpoch: number, message: RuntimePublication): Promise<boolean> {
    return this.sendApplication(authEpoch, message);
  }

  private async sendApplication(
    authEpoch: number,
    message: SessionApplicationMessage,
  ): Promise<boolean> {
    if (!this.isCurrent(authEpoch) || this.paused) return false;
    try {
      await this.sink.sendApplication(authEpoch, message);
      return this.isCurrent(authEpoch) && !this.paused;
    } catch (error) {
      await this.terminate(operationError(error));
      return false;
    }
  }

  private async sendApplicationError(
    authEpoch: number,
    id: number,
    error: DbzzError,
  ): Promise<void> {
    if (!this.isCurrent(authEpoch) || this.paused) return;
    try {
      await this.sink.sendApplication(authEpoch, {
        v: PROTOCOL_VERSION,
        t: "err",
        id,
        outcome: outcomeFromError(error),
      });
    } catch (sinkError) {
      await this.terminate(operationError(sinkError));
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
      await this.terminate(operationError(error));
    }
  }

  private async verifyCredential(credential: Credential): Promise<ClientPrincipal> {
    if (credential.kind === "anonymous") return ANONYMOUS_PRINCIPAL;
    if (this.verifier === undefined) {
      throw new DbzzError("unauthenticated", "invalid credential");
    }
    let verified: VerifiedPrincipal;
    try {
      verified = await this.verifier.verify(credential.token);
    } catch (error) {
      throw verifierError(error);
    }
    const principal = immutableVerifiedPrincipal(verified);
    if (principal.expiresAt <= this.readNow()) {
      throw new DbzzError("unauthenticated", "credential expired");
    }
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
    if (principal.kind === "anonymous" || principal.kind === "system") return;
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
    void this.terminate(new DbzzError("unauthenticated", "credential revoked"));
  }

  private terminate(error: DbzzError): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    const context =
      this.principal === null || this.clientSessionId === null
        ? null
        : this.runtimeContext(this.principal, this.authEpoch, this.epochController);
    const outcome = outcomeFromError(error);
    this.phase = "closed";
    this.paused = true;
    let resolveClose!: () => void;
    this.closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    aborted(this.epochController, error);
    if (this.pendingAuthController !== null) aborted(this.pendingAuthController, error);
    this.clearExpiry();
    const unsubscribe = this.unsubscribeInvalidation;
    this.unsubscribeInvalidation = null;
    try {
      unsubscribe?.();
    } catch {
      // Session state is already closed; cleanup remains best effort.
    }

    const closeRuntime =
      context === null
        ? Promise.resolve()
        : Promise.resolve(this.runtime.closeSession(context, outcome)).catch(() => {});
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
