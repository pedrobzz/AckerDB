import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  type ClientAuthMessage,
  type ChannelJoinMessage,
  type ChannelLeaveMessage,
  type ChannelSendMessage,
  type Credential,
  type ErrorMessage,
  type MutationMessage,
  type Outcome,
  type ProcedureMessage,
  type QueryMessage,
  type ServerMessage,
  type SubscriptionCursor,
  type TransitionMessage,
} from "../../../core/src/protocol.ts";
import { encode } from "../../../core/src/wire.ts";
import {
  ANONYMOUS_PRINCIPAL,
  type CredentialVerifier,
  type ExternalAccount,
  type PrincipalInvalidation,
  type RevocationBound,
  type VerifiedCredential,
  type VerifiedUserCredential,
} from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import type { Identity } from "../../src/validation/v.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { outcomeFromError } from "../../src/runtime/outcome.ts";
import {
  prepareRuntimePublication,
  type RuntimeAuthTransition,
  type RuntimeMutationResult,
  type RuntimePort,
  type RuntimePublication,
  type RuntimePublicationBatch,
  type RuntimeRequest,
  type SessionApplicationMessage,
  type SessionClock,
  type SessionControlMessage,
  type SessionLimits,
  type SessionRuntimeContext,
  type SessionSink,
} from "../../src/subscriptions/session/contract.ts";
import { Session } from "../../src/subscriptions/session/session.ts";
import { deferred } from "ackerdb-test-support/async";

const TEST_SOURCE = Object.freeze({ family: "test", address: "session-auth" });

async function settle(): Promise<void> {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

class ManualClock implements SessionClock {
  nowMs: number;
  private nextId = 0;
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  constructor(nowMs = 0) {
    this.nowMs = nowMs;
  }

  now = (): number => this.nowMs;

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.nowMs = next[1].at;
      next[1].callback();
      await settle();
    }
    this.nowMs = target;
    await settle();
  }
}

type VerifierResult = VerifiedCredential | Error | Promise<VerifiedCredential>;

class FakeVerifier implements CredentialVerifier {
  readonly calls: string[] = [];
  readonly results = new Map<string, VerifierResult>();
  unsubscribeCalls = 0;
  private listener: ((invalidation: PrincipalInvalidation) => void) | null = null;

  constructor(readonly revocationBound: RevocationBound = { kind: "invalidation", deadlineMs: 5_000 }) {}

  async verify(credential: string): Promise<VerifiedCredential> {
    this.calls.push(credential);
    const result = this.results.get(credential);
    if (result === undefined) throw new Error("unconfigured fake credential");
    if (result instanceof Error) throw result;
    return result;
  }

  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      this.listener = null;
    };
  }

  emit(invalidation: PrincipalInvalidation): void {
    this.listener?.(invalidation);
  }
}

interface SinkApplication {
  readonly authEpoch: number;
  readonly message: SessionApplicationMessage;
  readonly publication: RuntimePublication;
}

class FakeSink implements SessionSink {
  readonly controls: SessionControlMessage[] = [];
  readonly applications: SinkApplication[] = [];
  readonly drops: number[] = [];
  readonly closes: Outcome[] = [];
  controlHook: ((message: SessionControlMessage) => Promise<void>) | null = null;
  applicationHook: ((authEpoch: number, message: SessionApplicationMessage) => Promise<void>) | null = null;

  constructor(private readonly order: string[] = []) {}

  async sendControl(message: SessionControlMessage): Promise<void> {
    this.order.push(`control:${message.t}${message.t === "auth" ? `:${message.attemptId}` : ""}`);
    this.controls.push(message);
    if (this.controlHook !== null) await this.controlHook(message);
  }

  async sendApplication(authEpoch: number, publication: RuntimePublication): Promise<void> {
    const { message } = publication;
    this.order.push(`application:${message.t}:${authEpoch}`);
    this.applications.push({ authEpoch, message, publication });
    if (this.applicationHook !== null) await this.applicationHook(authEpoch, message);
  }

  async dropApplicationFramesBefore(authEpoch: number): Promise<void> {
    this.order.push(`drop:${authEpoch}`);
    this.drops.push(authEpoch);
    for (let index = this.applications.length - 1; index >= 0; index--) {
      if (this.applications[index]!.authEpoch < authEpoch) this.applications.splice(index, 1);
    }
  }

  async close(outcome: Outcome): Promise<void> {
    this.order.push(`close:${outcome.code}`);
    this.closes.push(outcome);
  }
}

function cursor(authEpoch: number, generation = `g${authEpoch}`): SubscriptionCursor {
  return { generation, commitVersion: 0n, authEpoch, identity: `identity-${authEpoch}` };
}

function resetTransition(authEpoch: number, id = 1): TransitionMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "transition",
    id,
    transition: {
      kind: "reset",
      from: null,
      to: cursor(authEpoch),
      value: { authEpoch },
    },
  };
}

class FakeRuntime implements RuntimePort {
  credentialVerifier: CredentialVerifier | undefined;
  readonly opens: SessionRuntimeContext[] = [];
  readonly transitions: RuntimeAuthTransition[] = [];
  readonly subscriptions: number[] = [];
  readonly unsubscriptions: number[] = [];
  readonly resets: number[] = [];
  readonly queries: QueryMessage[] = [];
  readonly queryRequests: RuntimeRequest<QueryMessage>[] = [];
  readonly procedures: ProcedureMessage[] = [];
  readonly procedureRequests: RuntimeRequest<ProcedureMessage>[] = [];
  readonly mutations: MutationMessage[] = [];
  readonly channelJoins: ChannelJoinMessage[] = [];
  readonly channelLeaves: ChannelLeaveMessage[] = [];
  readonly channelSends: ChannelSendMessage[] = [];
  readonly operationContexts: SessionRuntimeContext[] = [];
  readonly closes: Outcome[] = [];
  readonly transitionPublications: RuntimePublication[] = [];
  transitionCaptureBytes = 0;
  transitionReleaseCount = 0;
  subscribeHook: ((context: SessionRuntimeContext, id: number) => Promise<void>) | null = null;
  queryHook: ((context: SessionRuntimeContext, message: QueryMessage) => Promise<unknown>) | null = null;
  procedureHook: (
    (context: SessionRuntimeContext, request: RuntimeRequest<ProcedureMessage>) => Promise<unknown>
  ) | null = null;
  resolveIdentityHook: (
    (account: ExternalAccount, signal?: AbortSignal) => Promise<Identity>
  ) | null = null;
  private readonly identities = new Map<string, Identity>();
  private nextIdentity = 0n;

  constructor(
    private readonly order: string[] = [],
    credentialVerifier?: CredentialVerifier,
  ) {
    this.credentialVerifier = credentialVerifier;
  }

  async resolveIdentity(account: ExternalAccount, signal?: AbortSignal): Promise<Identity> {
    if (this.resolveIdentityHook !== null) return this.resolveIdentityHook(account, signal);
    const key = `${account.issuer}\0${account.subject}`;
    const existing = this.identities.get(key);
    if (existing !== undefined) return existing;
    const identity = (++this.nextIdentity) as Identity;
    this.identities.set(key, identity);
    return identity;
  }

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.order.push("runtime:open");
    this.opens.push(context);
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch> {
    this.order.push(`runtime:transition:${transition.attemptId}`);
    this.transitions.push(transition);
    if (transition.to.signal.aborted) throw transition.to.signal.reason;
    const frames = [prepareRuntimePublication(resetTransition(transition.to.authEpoch))];
    this.transitionPublications.push(frames[0]!);
    const bytes = frames.reduce((total, frame) => total + frame.bytes, 0);
    this.transitionCaptureBytes += bytes;
    let released = false;
    return Object.freeze({
      frames,
      bytes,
      release: () => {
        if (released) return;
        released = true;
        frames.length = 0;
        this.transitionCaptureBytes -= bytes;
        this.transitionReleaseCount += 1;
      },
    });
  }

  async subscribe(context: SessionRuntimeContext, request: Parameters<RuntimePort["subscribe"]>[1]): Promise<void> {
    const { message } = request;
    this.operationContexts.push(context);
    this.subscriptions.push(message.id);
    if (this.subscribeHook !== null) await this.subscribeHook(context, message.id);
    await context.publish(prepareRuntimePublication(resetTransition(context.authEpoch, message.id)));
  }

  async unsubscribe(
    context: SessionRuntimeContext,
    request: Parameters<RuntimePort["unsubscribe"]>[1],
  ): Promise<void> {
    const { message } = request;
    this.operationContexts.push(context);
    this.unsubscriptions.push(message.id);
  }

  async reset(context: SessionRuntimeContext, request: Parameters<RuntimePort["reset"]>[1]): Promise<void> {
    const { message } = request;
    this.operationContexts.push(context);
    this.resets.push(message.id);
    await context.publish(prepareRuntimePublication(resetTransition(context.authEpoch, message.id)));
  }

  async joinChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelJoinMessage>,
  ): Promise<void> {
    this.operationContexts.push(context);
    this.channelJoins.push(request.message);
  }

  async leaveChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelLeaveMessage>,
  ): Promise<void> {
    this.operationContexts.push(context);
    this.channelLeaves.push(request.message);
  }

  async sendChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelSendMessage>,
  ): Promise<void> {
    this.operationContexts.push(context);
    this.channelSends.push(request.message);
  }

  async query(context: SessionRuntimeContext, request: RuntimeRequest<QueryMessage>): Promise<unknown> {
    const { message } = request;
    this.operationContexts.push(context);
    this.queryRequests.push(request);
    this.queries.push(message);
    try {
      const value = this.queryHook === null
        ? { ref: message.ref, principal: context.principal.kind }
        : await this.queryHook(context, message);
      await context.publish(prepareRuntimePublication({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: message.id,
        kind: "query",
        value,
      }));
      return value;
    } catch (error) {
      await context.publish(prepareRuntimePublication({
        v: PROTOCOL_VERSION,
        t: "err",
        id: message.id,
        outcome: outcomeFromError(error),
      }));
      throw error;
    }
  }

  async procedure(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ProcedureMessage>,
  ): Promise<unknown> {
    const { message } = request;
    this.operationContexts.push(context);
    this.procedures.push(message);
    this.procedureRequests.push(request);
    if (this.procedureHook !== null) return this.procedureHook(context, request);
    const value = { ref: message.ref, principal: context.principal.kind };
    await context.publish(prepareRuntimePublication({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: message.id,
      kind: "procedure",
      value,
    }));
    return value;
  }

  async mutation(
    context: SessionRuntimeContext,
    request: RuntimeRequest<MutationMessage>,
  ): Promise<RuntimeMutationResult> {
    const { message } = request;
    this.operationContexts.push(context);
    this.mutations.push(message);
    const result: RuntimeMutationResult = {
      value: { ref: message.ref, principal: context.principal.kind },
      receipt: {
        mutationRequestId: message.mutationRequestId,
        commitVersion: 1n,
        durability: "production",
        replay: "executed",
        obligations: [],
      },
    };
    await context.publish(prepareRuntimePublication({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: message.id,
      kind: "mutation",
      value: result.value,
      receipt: result.receipt,
    }));
    return result;
  }

  async closeSession(_context: SessionRuntimeContext, outcome: Outcome): Promise<void> {
    this.order.push(`runtime:close:${outcome.code}`);
    this.closes.push(outcome);
  }
}

function principal(subject: string, expiresAt = 60_000): VerifiedUserCredential {
  return {
    kind: "user",
    issuer: "https://issuer.example/",
    subject,
    claims: { roles: ["reader"] },
    expiresAt,
    tokenId: `token-${subject}`,
  };
}

function hello(credential: Credential = { kind: "anonymous" }): unknown {
  return { v: PROTOCOL_VERSION, t: "hello", clientSessionId: "client-1", credential };
}

function auth(attemptId: number, credential: Credential): ClientAuthMessage {
  return { v: PROTOCOL_VERSION, t: "auth", attemptId, credential };
}

function query(id: number): QueryMessage {
  return { v: PROTOCOL_VERSION, t: "q", id, ref: "messages.list", args: {} };
}

function mutation(id: number): MutationMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "m",
    id,
    ref: "messages.send",
    args: {},
    mutationRequestId: "018f0f00-0000-7000-8000-000000000001",
    issuedAt: 1,
  };
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(encode(value));
}

function wireWithBytes(value: unknown, bytes: number): string {
  const text = encode(value);
  const padding = bytes - Buffer.byteLength(text);
  if (padding < 0) throw new RangeError("wire target is smaller than its encoded value");
  return " ".repeat(padding) + text;
}

function handle(session: Session, frame: unknown): Promise<void> {
  return session.handle(encode(frame));
}

function sessionLimits(maxFrameBytes = 1_024, maxRequestBytes = maxFrameBytes): SessionLimits {
  return { maxRequestBytes, maxFrameBytes };
}

function messagesOfType<T extends ServerMessage["t"]>(
  messages: readonly ServerMessage[],
  type: T,
): Extract<ServerMessage, { t: T }>[] {
  return messages.filter((message): message is Extract<ServerMessage, { t: T }> => message.t === type);
}

describe("Session Protocol-2 ownership", () => {
  test("requires hello first and forwards a structured terminal outcome", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const session = new Session({ runtime, sink, source: TEST_SOURCE });

    await handle(session, query(1));
    await session.close();

    expect(session.snapshot()).toMatchObject({ phase: "closed" });
    expect(runtime.queries).toHaveLength(0);
    expect(sink.controls).toEqual([
      {
        v: 5,
        t: "err",
        id: null,
        outcome: { code: "malformed", retryable: false, message: "hello must be the first frame" },
      },
    ]);
    expect(sink.closes[0]?.code).toBe("malformed");
  });

  test("owns anonymous hello and dispatches every non-auth frame with one epoch context", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const session = new Session({ runtime, sink, source: TEST_SOURCE });
    expect(session.currentClientSessionId).toBeNull();

    await handle(session, hello());
    await handle(session, { v: 5, t: "sub", id: 1, ref: "messages.list", args: {} });
    await handle(session, { v: 5, t: "reset", id: 1, cursor: cursor(0) });
    await handle(session, query(2));
    await handle(session, mutation(3));
    await handle(session, { v: 5, t: "unsub", id: 1 });
    await handle(session, { v: 5, t: "ping" });
    await settle();

    expect(session.snapshot()).toMatchObject({
      phase: "active",
      clientSessionId: "client-1",
      principal: ANONYMOUS_PRINCIPAL,
      authEpoch: 0,
    });
    expect(session.currentClientSessionId).toBe("client-1");
    expect(runtime.opens[0]).toMatchObject({
      clientSessionId: "client-1",
      principal: ANONYMOUS_PRINCIPAL,
      authEpoch: 0,
    });
    expect(runtime.subscriptions).toEqual([1]);
    expect(runtime.resets).toEqual([1]);
    expect(runtime.unsubscriptions).toEqual([1]);
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.mutations).toHaveLength(1);
    expect(runtime.operationContexts).toHaveLength(5);
    expect(runtime.operationContexts.every((context) => context === runtime.opens[0])).toBe(true);
    expect(messagesOfType(sink.controls, "welcome")[0]).toMatchObject({ authEpoch: 0, principal: "anonymous" });
    expect(messagesOfType(sink.controls, "pong")).toHaveLength(1);
    expect(messagesOfType(sink.applications.map((entry) => entry.message), "transition")).toHaveLength(2);
    expect(messagesOfType(sink.applications.map((entry) => entry.message), "ok")).toHaveLength(2);
  });

  test("admits independent queries without a Session-wide data-plane queue", async () => {
    const runtime = new FakeRuntime();
    const gate = deferred<void>();
    runtime.queryHook = async () => gate.promise;
    const session = new Session({ runtime, sink: new FakeSink(), source: TEST_SOURCE });
    await handle(session, hello());

    const queries = Array.from({ length: 8 }, (_, index) => handle(session, query(index + 1)));
    await settle();
    expect(runtime.queries.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    gate.resolve(undefined);
    await Promise.all(queries);
    await session.close();
  });

  test("cancels only the matching in-flight procedure", async () => {
    const runtime = new FakeRuntime();
    const started = deferred<void>();
    let abortReason: unknown;
    runtime.procedureHook = async (_context, request) => {
      const signal = request.signal;
      if (signal === undefined) throw new Error("procedure request has no cancellation signal");
      started.resolve(undefined);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      abortReason = signal.reason;
      throw signal.reason;
    };
    const session = new Session({ runtime, sink: new FakeSink(), source: TEST_SOURCE });
    await handle(session, hello());

    const running = handle(session, {
      v: PROTOCOL_VERSION,
      t: "p",
      id: 41,
      ref: "messages.hold",
      args: {},
    });
    await started.promise;
    await handle(session, { v: PROTOCOL_VERSION, t: "cancel", id: 42 });
    expect(runtime.procedureRequests[0]!.signal?.aborted).toBe(false);
    await handle(session, { v: PROTOCOL_VERSION, t: "cancel", id: 41 });
    await running;

    expect(runtime.procedureRequests[0]!.signal?.aborted).toBe(true);
    expect(abortReason).toBeInstanceOf(AckerDBError);
    expect(outcomeFromError(abortReason)).toMatchObject({
      code: "unavailable",
      message: "procedure request was canceled",
      resource: "operation",
    });
    await session.close();
  });

  test("admits distinct subscription ids concurrently", async () => {
    const runtime = new FakeRuntime();
    const gate = deferred<void>();
    runtime.subscribeHook = async () => gate.promise;
    const session = new Session({ runtime, sink: new FakeSink(), source: TEST_SOURCE });
    await handle(session, hello());

    const subscriptions = [1, 2].map((id) => handle(session, {
      v: 5,
      t: "sub",
      id,
      ref: "messages.list",
      args: {},
    }));
    await settle();
    expect(runtime.subscriptions).toEqual([1, 2]);

    gate.resolve(undefined);
    await Promise.all(subscriptions);
    await session.close();
  });

  test("auth pauses and aborts the old epoch synchronously", async () => {
    const runtime = new FakeRuntime();
    const procedureStarted = deferred<void>();
    runtime.procedureHook = async (_context, request) => {
      const signal = request.signal;
      if (signal === undefined) throw new Error("procedure request has no cancellation signal");
      procedureStarted.resolve(undefined);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal.reason;
    };
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    const verified = deferred<VerifiedCredential>();
    verifier.results.set("next", verified.promise);
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello());

    const runningProcedure = handle(session, {
      v: PROTOCOL_VERSION,
      t: "p",
      id: 8,
      ref: "messages.hold",
      args: {},
    });
    await procedureStarted.promise;
    const refreshing = handle(session, auth(1, { kind: "bearer", token: "next" }));
    expect(runtime.opens[0]!.signal.aborted).toBe(true);
    expect(runtime.procedureRequests[0]!.signal?.aborted).toBe(true);
    expect(session.snapshot().phase).toBe("refreshing");
    const blockedData = handle(session, query(9));
    expect(runtime.queries).toHaveLength(0);
    expect((sink.controls.at(-1) as ErrorMessage).outcome.code).toBe("auth_stale");

    await Promise.all([runningProcedure, refreshing, blockedData]);
    await settle();
    expect(runtime.transitions).toHaveLength(0);

    verified.resolve(principal("next"));
    await settle();
    expect(runtime.transitions).toHaveLength(1);
    expect(session.snapshot()).toMatchObject({ phase: "active", authEpoch: 1 });
    await session.close();
  });

  test("keeps data paused until the auth acknowledgment handoff is accepted", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    const acknowledgmentStarted = deferred<void>();
    const acknowledgmentAccepted = deferred<void>();
    verifier.results.set("next", principal("next"));
    runtime.credentialVerifier = verifier;
    sink.controlHook = async (message) => {
      if (message.t !== "auth" || message.attemptId !== 1) return;
      acknowledgmentStarted.resolve(undefined);
      await acknowledgmentAccepted.promise;
    };
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello());

    await handle(session, auth(1, { kind: "bearer", token: "next" }));
    await acknowledgmentStarted.promise;
    expect(session.snapshot()).toMatchObject({ phase: "refreshing", authEpoch: 1 });

    await handle(session, query(9));
    expect(runtime.queries).toHaveLength(0);
    expect((sink.controls.at(-1) as ErrorMessage).outcome.code).toBe("auth_stale");

    acknowledgmentAccepted.resolve(undefined);
    await settle();
    expect(session.snapshot()).toMatchObject({ phase: "active", authEpoch: 1 });
    await handle(session, query(10));
    expect(runtime.queries.map(({ id }) => id)).toEqual([10]);
    await session.close();
  });

  test("rejects an oversized frame before Runtime admission", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const maxFrameBytes = Math.max(wireBytes(hello()), wireBytes(query(1))) + 8;
    const session = new Session({
      runtime,
      sink,
      source: TEST_SOURCE,
      limits: sessionLimits(maxFrameBytes),
    });
    await handle(session, hello());

    await expect(session.handle(wireWithBytes(query(1), maxFrameBytes + 1))).rejects.toMatchObject({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
      message: "client frame exceeds maxFrameBytes",
    });
    await session.close();

    expect(runtime.queries).toEqual([]);
    expect(sink.closes[0]).toMatchObject({ code: "overloaded", resource: "connection" });
    expect(session.snapshot().phase).toBe("closed");
  });

  test("rejects an oversized request below the transport frame ceiling before Runtime admission", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const minimumRequestBytes = Math.max(wireBytes(hello()), wireBytes(query(1)));
    const maxRequestBytes = minimumRequestBytes + 8;
    const maxFrameBytes = maxRequestBytes + 256;
    const session = new Session({
      runtime,
      sink,
      source: TEST_SOURCE,
      limits: sessionLimits(maxFrameBytes, maxRequestBytes),
    });
    await handle(session, hello());
    const oversizedBytes = maxRequestBytes + 1;
    expect(oversizedBytes).toBeLessThanOrEqual(maxFrameBytes);

    await expect(session.handle(wireWithBytes(query(1), oversizedBytes))).rejects.toMatchObject({
      code: "overloaded",
      retryable: false,
      resource: "operation",
      message: "client request exceeds maxRequestBytes",
    });
    await session.close();

    expect(runtime.queries).toEqual([]);
    expect(sink.closes).toEqual([{
      code: "overloaded",
      retryable: false,
      resource: "operation",
      message: "client request exceeds maxRequestBytes",
    }]);
    expect(session.snapshot().phase).toBe("closed");
  });

  test("accepts the exact UTF-8 request boundary and preserves its byte count", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const message = { ...query(1), args: { value: "é".repeat(32) } };
    const text = encode(message);
    const bytes = Buffer.byteLength(text);
    expect(bytes).toBeGreaterThan(text.length);
    expect(bytes).toBeGreaterThan(wireBytes(hello()));
    const session = new Session({
      runtime,
      sink,
      source: TEST_SOURCE,
      limits: sessionLimits(bytes, bytes),
    });

    await handle(session, hello());
    await expect(session.handle(text)).resolves.toBeUndefined();

    expect(runtime.queryRequests).toHaveLength(1);
    expect(runtime.queryRequests[0]).toMatchObject({ message, bytes });
    expect(Object.isFrozen(runtime.queryRequests[0])).toBe(true);
    await session.close();
  });

  test("cannot receive a decoded frame with a caller-claimed byte count", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const session = new Session({ runtime, sink, source: TEST_SOURCE });
    const forged = { frame: hello(), bytes: 1 };

    // @ts-expect-error Session accepts only raw text or binary wire input.
    await expect(session.handle(forged)).rejects.toMatchObject({
      code: "malformed",
      message: "client frame must be text or binary",
    });
    await session.close();

    expect(runtime.opens).toEqual([]);
    expect(session.snapshot().phase).toBe("closed");
  });

  test("latest auth attempt wins, pauses operations, and exposes transitions before auth success", async () => {
    const order: string[] = [];
    const runtime = new FakeRuntime(order);
    const sink = new FakeSink(order);
    const verifier = new FakeVerifier();
    const first = deferred<VerifiedCredential>();
    const second = deferred<VerifiedCredential>();
    verifier.results.set("first", first.promise);
    verifier.results.set("second", second.promise);
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello());
    order.length = 0;

    await handle(session, auth(1, { kind: "bearer", token: "first" }));
    expect(runtime.opens[0]!.signal.aborted).toBe(true);
    await handle(session, query(9));
    expect(runtime.queries).toHaveLength(0);
    expect((sink.controls.at(-1) as ErrorMessage).outcome.code).toBe("auth_stale");
    await handle(session, auth(2, { kind: "bearer", token: "second" }));

    second.resolve(principal("second"));
    await settle();
    expect(session.snapshot()).toMatchObject({
      phase: "active",
      authEpoch: 1,
      latestAttemptId: 2,
      principal: { kind: "user", subject: "second" },
    });
    expect(order).toEqual([
      "control:err",
      "drop:1",
      "runtime:transition:2",
      "application:transition:1",
      "control:auth:2",
    ]);
    const accepted = messagesOfType(sink.controls, "auth")[0]!;
    expect(accepted).toEqual({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 2,
      authEpoch: 1,
      principal: "user",
      identity: 1n as Identity,
      provenance: { issuer: "https://issuer.example/", subject: "second" },
    });
    expect(Object.keys(accepted).sort()).toEqual([
      "attemptId",
      "authEpoch",
      "identity",
      "principal",
      "provenance",
      "t",
      "v",
    ]);

    first.resolve(principal("first"));
    await settle();
    expect(runtime.transitions).toHaveLength(1);
    expect(sink.applications[0]?.publication).toBe(runtime.transitionPublications[0]);
    expect(messagesOfType(sink.controls, "auth").map((message) => message.attemptId)).toEqual([2]);
    expect(verifier.calls).toEqual(["first", "second"]);
    expect(runtime.transitionCaptureBytes).toBe(0);
    expect(runtime.transitionReleaseCount).toBe(1);
  });

  test("cancels obsolete refresh Identity resolution while the winning refresh succeeds", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("first", principal("first"));
    verifier.results.set("second", principal("second"));
    verifier.results.set("closing", principal("closing"));
    const signals = new Map<string, AbortSignal>();
    runtime.resolveIdentityHook = async (account, signal) => {
      if (signal === undefined) throw new Error("Identity resolution requires auth cancellation");
      signals.set(account.subject, signal);
      if (account.subject === "second") return 2n as Identity;
      return new Promise<Identity>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello());

    await handle(session, auth(1, { kind: "bearer", token: "first" }));
    await settle();
    expect(signals.get("first")?.aborted).toBe(false);

    await handle(session, auth(2, { kind: "bearer", token: "second" }));
    await settle();
    expect(signals.get("first")?.aborted).toBe(true);
    expect(session.snapshot()).toMatchObject({
      phase: "active",
      authEpoch: 1,
      principal: { kind: "user", subject: "second", identity: 2n },
    });

    await handle(session, auth(3, { kind: "bearer", token: "closing" }));
    await settle();
    expect(signals.get("closing")?.aborted).toBe(false);
    await session.close(new AckerDBError("draining", "server draining"));
    expect(signals.get("closing")?.aborted).toBe(true);
  });

  test("cancels blocked hello Identity resolution when the Session closes", async () => {
    const runtime = new FakeRuntime();
    const verifier = new FakeVerifier();
    verifier.results.set("hello", principal("hello"));
    let resolutionSignal: AbortSignal | undefined;
    runtime.resolveIdentityHook = async (_account, signal) => {
      if (signal === undefined) throw new Error("Identity resolution requires auth cancellation");
      resolutionSignal = signal;
      return new Promise<Identity>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    runtime.credentialVerifier = verifier;
    const session = new Session({
      runtime,
      sink: new FakeSink(),
      source: TEST_SOURCE,
      clock: new ManualClock(),
    });

    const opening = handle(session, hello({ kind: "bearer", token: "hello" }));
    await settle();
    expect(resolutionSignal?.aborted).toBe(false);
    const closing = session.close(new AckerDBError("draining", "server draining"));
    expect(resolutionSignal?.aborted).toBe(true);
    await Promise.all([opening, closing]);
    expect(runtime.opens).toHaveLength(0);
    expect(runtime.closes).toHaveLength(0);
  });

  test("never opens a Runtime session when expiry lands at the Session boundary", async () => {
    const expiryTimes = [0, 999, 1_000];
    const expiryClock = new ManualClock();
    expiryClock.now = () => expiryTimes.shift() ?? 1_000;
    const expiryRuntime = new FakeRuntime();
    const expiryVerifier = new FakeVerifier();
    expiryVerifier.results.set("boundary", principal("boundary", 1_000));
    expiryRuntime.credentialVerifier = expiryVerifier;
    const expirySession = new Session({
      runtime: expiryRuntime,
      sink: new FakeSink(),
      source: TEST_SOURCE,
      clock: expiryClock,
    });
    await handle(expirySession, hello({ kind: "bearer", token: "boundary" }));
    await expirySession.close();
    expect(expirySession.snapshot().phase).toBe("closed");
    expect(expiryRuntime.opens).toHaveLength(0);
    expect(expiryRuntime.closes).toHaveLength(0);
  });

  test("switches immutable epoch fairness ownership on refresh and sign-out", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    const alice = principal("alice");
    const refreshedAlice = Object.freeze({
      ...principal("alice", 90_000),
      claims: Object.freeze({ roles: ["admin"], private: "claim-canary" }),
      tokenId: "refreshed-token-canary",
    });
    const bob = principal("bob");
    verifier.results.set("alice", alice);
    verifier.results.set("alice-refreshed", refreshedAlice);
    verifier.results.set("bob", bob);
    runtime.credentialVerifier = verifier;
    const session = new Session({
      runtime,
      sink,
      source: TEST_SOURCE,
      clock: new ManualClock(),
    });

    await handle(session, hello({ kind: "bearer", token: "alice" }));
    const opened = runtime.opens[0]!;
    await handle(session, auth(1, { kind: "bearer", token: "alice-refreshed" }));
    await settle();
    const sameOwner = runtime.transitions[0]!;
    expect(sameOwner.from).toBe(opened);

    expect(Object.isFrozen(opened)).toBe(true);
    expect(Object.isFrozen(sameOwner.to)).toBe(true);
    expect(sameOwner.from).toMatchObject({ authEpoch: 0, fairnessKey: opened.fairnessKey });
    expect(sameOwner.from.signal).toBe(opened.signal);
    expect(sameOwner.to.authEpoch).toBe(1);
    expect(sameOwner.to.fairnessKey).toBe(opened.fairnessKey);
    expect(sameOwner.to.fairnessKey).toBe(callerFairnessKey(sameOwner.to.principal, TEST_SOURCE));

    await handle(session, auth(2, { kind: "bearer", token: "bob" }));
    await settle();
    const changedOwner = runtime.transitions[1]!;
    expect(changedOwner.from).toBe(sameOwner.to);
    expect(changedOwner.from).toMatchObject({
      authEpoch: sameOwner.to.authEpoch,
      fairnessKey: sameOwner.to.fairnessKey,
    });
    expect(changedOwner.from.signal).toBe(sameOwner.to.signal);
    expect(changedOwner.to.fairnessKey).not.toBe(sameOwner.to.fairnessKey);
    expect(changedOwner.to.fairnessKey).toBe(callerFairnessKey(changedOwner.to.principal, TEST_SOURCE));

    await handle(session, auth(3, { kind: "anonymous" }));
    await settle();
    const signedOut = runtime.transitions[2]!;
    expect(signedOut.from).toBe(changedOwner.to);
    expect(signedOut.from).toMatchObject({
      authEpoch: changedOwner.to.authEpoch,
      fairnessKey: changedOwner.to.fairnessKey,
    });
    expect(signedOut.from.signal).toBe(changedOwner.to.signal);
    expect(signedOut.to.authEpoch).toBe(3);
    expect(signedOut.to.fairnessKey).toBe(callerFairnessKey(ANONYMOUS_PRINCIPAL, TEST_SOURCE));
    expect(opened.fairnessKey).toBe(callerFairnessKey(opened.principal, TEST_SOURCE));
  });

  test("releases captured auth publications immediately when close races blocked delivery", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    const delivery = deferred<void>();
    verifier.results.set("next", principal("next"));
    sink.applicationHook = async () => delivery.promise;
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello());

    await handle(session, auth(1, { kind: "bearer", token: "next" }));
    await settle();
    expect(runtime.transitionCaptureBytes).toBeGreaterThan(0);
    expect(runtime.transitionReleaseCount).toBe(0);

    const closing = session.close(new AckerDBError("draining", "server draining"));
    expect(runtime.transitionCaptureBytes).toBe(0);
    expect(runtime.transitionReleaseCount).toBe(1);
    delivery.resolve(undefined);
    await closing;
    await settle();

    expect(runtime.transitionCaptureBytes).toBe(0);
    expect(runtime.transitionReleaseCount).toBe(1);
    expect(messagesOfType(sink.controls, "auth")).toHaveLength(0);
  });

  test("releases captured auth publications and fails closed when delivery rejects", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("next", principal("next"));
    sink.applicationHook = async () => {
      throw new Error("transport failed");
    };
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello());

    await handle(session, auth(1, { kind: "bearer", token: "next" }));
    await settle();

    expect(runtime.transitionCaptureBytes).toBe(0);
    expect(runtime.transitionReleaseCount).toBe(1);
    expect(session.snapshot().phase).toBe("closed");
    expect(sink.closes[0]?.code).toBe("internal");
  });

  test("sign-out rotates subscriptions, drops old frames, and rejects old-epoch queued work", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("user", principal("user"));
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello({ kind: "bearer", token: "user" }));

    const authHandle = handle(session, auth(1, { kind: "anonymous" }));
    const oldEpochQuery = handle(session, query(4));
    await Promise.all([authHandle, oldEpochQuery]);
    await settle();

    expect(runtime.queries).toHaveLength(0);
    expect(
      sink.controls.some(
        (message) => message.t === "err" && message.id === 4 && message.outcome.code === "auth_stale",
      ),
    ).toBe(true);
    expect(session.snapshot()).toMatchObject({
      phase: "active",
      authEpoch: 1,
      principal: ANONYMOUS_PRINCIPAL,
    });
    expect(runtime.transitions[0]).toMatchObject({ reason: "sign-out", attemptId: 1 });
    expect(sink.drops).toEqual([1]);
    expect(
      sink.applications.some(
        ({ message }) => message.t === "ok" && message.kind === "query" && message.id === 4,
      ),
    ).toBe(false);
  });

  test("failed refresh hard-closes instead of restoring the old identity", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("valid", principal("user"));
    const failure = deferred<VerifiedCredential>();
    verifier.results.set("invalid", failure.promise);
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new ManualClock() });
    await handle(session, hello({ kind: "bearer", token: "valid" }));

    await handle(session, auth(1, { kind: "bearer", token: "invalid" }));
    failure.reject(new AckerDBError("unauthenticated", "invalid credential"));
    await settle();

    expect(session.snapshot().phase).toBe("closed");
    expect(runtime.closes[0]?.code).toBe("unauthenticated");
    expect(sink.closes[0]?.code).toBe("unauthenticated");
    expect((sink.controls.at(-1) as ErrorMessage).outcome).toEqual({
      code: "unauthenticated",
      retryable: false,
      message: "invalid credential",
    });
  });

  test("hard token expiry closes exactly at expiresAt", async () => {
    const clock = new ManualClock(1_000);
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("short", principal("short", 1_100));
    runtime.credentialVerifier = verifier;
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock });
    await handle(session, hello({ kind: "bearer", token: "short" }));

    await clock.advance(99);
    expect(session.snapshot().phase).toBe("active");
    await clock.advance(1);

    expect(session.snapshot().phase).toBe("closed");
    expect(sink.closes[0]?.code).toBe("unauthenticated");
    expect(sink.closes[0]?.message).toBe("credential expired");
  });

  test("accepts invalidation guarantees equal to or lower than the configured revocation bound", () => {
    for (const advertisedDeadlineMs of [5_000, 1_000]) {
      const session = new Session({
        runtime: new FakeRuntime(
          [],
          new FakeVerifier({ kind: "invalidation", deadlineMs: advertisedDeadlineMs }),
        ),
        sink: new FakeSink(),
        source: TEST_SOURCE,
        revocationDeadlineMs: 5_000,
      });

      expect(session.revocationDeadlineMs).toBe(5_000);
    }

    expect(() => new Session({
      runtime: new FakeRuntime([], new FakeVerifier({ kind: "token-expiration" })),
      sink: new FakeSink(),
      source: TEST_SOURCE,
      revocationDeadlineMs: 1,
    })).not.toThrow();
  });

  test("rejects an invalid invalidation guarantee before opening the session", () => {
    for (const deadlineMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const revocationBound = { kind: "invalidation", deadlineMs } as unknown as RevocationBound;

      expect(() => new Session({
        runtime: new FakeRuntime([], new FakeVerifier(revocationBound)),
        sink: new FakeSink(),
        source: TEST_SOURCE,
      })).toThrow("verifier invalidation deadlineMs must be a positive finite number");
    }

    const missingBound = new FakeVerifier();
    Object.defineProperty(missingBound, "revocationBound", { value: undefined });
    expect(() => new Session({
      runtime: new FakeRuntime([], missingBound),
      sink: new FakeSink(),
      source: TEST_SOURCE,
    })).toThrow("verifier must declare a revocationBound");
  });

  test("rejects an invalidation guarantee above the configured revocation bound", () => {
    expect(() => new Session({
      runtime: new FakeRuntime(
        [],
        new FakeVerifier({ kind: "invalidation", deadlineMs: 5_000 }),
      ),
      sink: new FakeSink(),
      source: TEST_SOURCE,
      revocationDeadlineMs: 4_999,
    })).toThrow("verifier invalidation deadlineMs cannot exceed revocationDeadlineMs");
  });

  test("matching verifier invalidation uses the reserved fail-closed path within the bound", async () => {
    const clock = new ManualClock(5_000);
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("valid", principal("user", 20_000));
    runtime.credentialVerifier = verifier;
    const session = new Session({
      runtime,
      sink,
      source: TEST_SOURCE,
      clock,
      revocationDeadlineMs: 5_000,
    });
    await handle(session, hello({ kind: "bearer", token: "valid" }));

    verifier.emit({ issuer: "https://issuer.example/", subject: "someone-else" });
    expect(session.snapshot().phase).toBe("active");
    const invalidatedAt = clock.nowMs;
    verifier.emit({ issuer: "https://issuer.example/", tokenId: "token-user" });
    await settle();

    expect(clock.nowMs - invalidatedAt).toBeLessThanOrEqual(session.revocationDeadlineMs);
    expect(session.snapshot().phase).toBe("closed");
    expect(sink.closes[0]?.message).toBe("credential revoked");
    expect(verifier.unsubscribeCalls).toBe(1);
  });

  test("operation AckerDBError is forwarded without closing the session", async () => {
    const runtime = new FakeRuntime();
    runtime.queryHook = async () => {
      throw new AckerDBError("unauthorized", "access denied");
    };
    const sink = new FakeSink();
    const session = new Session({ runtime, sink, source: TEST_SOURCE });
    await handle(session, hello());
    await handle(session, query(7));
    await settle();

    const error = messagesOfType(
      sink.applications.map((entry) => entry.message),
      "err",
    )[0];
    expect(error).toEqual({
      v: 5,
      t: "err",
      id: 7,
      outcome: { code: "unauthorized", retryable: false, message: "access denied" },
    });
    expect(session.snapshot().phase).toBe("active");
    expect(sink.closes).toHaveLength(0);
  });
});
