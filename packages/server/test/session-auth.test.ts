import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  type ClientAuthMessage,
  type Credential,
  type ErrorMessage,
  type MutationMessage,
  type Outcome,
  type QueryMessage,
  type ServerMessage,
  type SubscriptionCursor,
  type TransitionMessage,
} from "../../core/src/protocol.ts";
import { encode } from "../../core/src/wire.ts";
import {
  ANONYMOUS_PRINCIPAL,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type RevocationBound,
  type UserPrincipal,
  type VerifiedPrincipal,
} from "../src/auth.ts";
import { DbzzError } from "../src/errors.ts";
import {
  Session,
  type RuntimeAuthTransition,
  type RuntimeMutationResult,
  type RuntimePort,
  type RuntimePublication,
  type SessionApplicationMessage,
  type SessionClock,
  type SessionControlMessage,
  type SessionLimits,
  type SessionRuntimeContext,
  type SessionSink,
} from "../src/session.ts";

const utf8 = new TextEncoder();

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

type VerifierResult = VerifiedPrincipal | Error | Promise<VerifiedPrincipal>;

class FakeVerifier implements CredentialVerifier {
  readonly revocationBound: RevocationBound = { kind: "invalidation", deadlineMs: 5_000 };
  readonly calls: string[] = [];
  readonly results = new Map<string, VerifierResult>();
  unsubscribeCalls = 0;
  private listener: ((invalidation: PrincipalInvalidation) => void) | null = null;

  async verify(credential: string): Promise<VerifiedPrincipal> {
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
}

class FakeSink implements SessionSink {
  readonly controls: SessionControlMessage[] = [];
  readonly applications: SinkApplication[] = [];
  readonly drops: number[] = [];
  readonly closes: Outcome[] = [];

  constructor(private readonly order: string[] = []) {}

  async sendControl(message: SessionControlMessage): Promise<void> {
    this.order.push(`control:${message.t}${message.t === "auth" ? `:${message.attemptId}` : ""}`);
    this.controls.push(message);
  }

  async sendApplication(authEpoch: number, message: SessionApplicationMessage): Promise<void> {
    this.order.push(`application:${message.t}:${authEpoch}`);
    this.applications.push({ authEpoch, message });
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
  readonly opens: SessionRuntimeContext[] = [];
  readonly transitions: RuntimeAuthTransition[] = [];
  readonly subscriptions: number[] = [];
  readonly unsubscriptions: number[] = [];
  readonly resets: number[] = [];
  readonly queries: QueryMessage[] = [];
  readonly mutations: MutationMessage[] = [];
  readonly closes: Outcome[] = [];
  subscribeHook: ((context: SessionRuntimeContext, id: number) => Promise<void>) | null = null;
  queryHook: ((context: SessionRuntimeContext, message: QueryMessage) => Promise<unknown>) | null = null;

  constructor(private readonly order: string[] = []) {}

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.order.push("runtime:open");
    this.opens.push(context);
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<readonly RuntimePublication[]> {
    this.order.push(`runtime:transition:${transition.attemptId}`);
    this.transitions.push(transition);
    if (transition.to.signal.aborted) throw transition.to.signal.reason;
    return [resetTransition(transition.to.authEpoch)];
  }

  async subscribe(context: SessionRuntimeContext, message: { id: number }): Promise<void> {
    this.subscriptions.push(message.id);
    if (this.subscribeHook !== null) await this.subscribeHook(context, message.id);
    await context.publish(resetTransition(context.authEpoch, message.id));
  }

  async unsubscribe(_context: SessionRuntimeContext, message: { id: number }): Promise<void> {
    this.unsubscriptions.push(message.id);
  }

  async reset(context: SessionRuntimeContext, message: { id: number }): Promise<void> {
    this.resets.push(message.id);
    await context.publish(resetTransition(context.authEpoch, message.id));
  }

  async query(context: SessionRuntimeContext, message: QueryMessage): Promise<unknown> {
    this.queries.push(message);
    return this.queryHook === null ? { ref: message.ref, principal: context.principal.kind } : this.queryHook(context, message);
  }

  async mutation(context: SessionRuntimeContext, message: MutationMessage): Promise<RuntimeMutationResult> {
    this.mutations.push(message);
    return {
      value: { ref: message.ref, principal: context.principal.kind },
      receipt: {
        mutationRequestId: message.mutationRequestId,
        commitVersion: 1n,
        durability: "production",
        replay: "executed",
        obligations: [],
      },
    };
  }

  async closeSession(_context: SessionRuntimeContext, outcome: Outcome): Promise<void> {
    this.order.push(`runtime:close:${outcome.code}`);
    this.closes.push(outcome);
  }
}

function principal(subject: string, expiresAt = 60_000): UserPrincipal {
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
  return utf8.encode(encode(value)).byteLength;
}

function sessionLimits(
  readQueue: SessionLimits["readQueue"],
  maxFrameBytes = 1_024,
  maxRequestBytes = maxFrameBytes,
): SessionLimits {
  return { readQueue, maxRequestBytes, maxFrameBytes };
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
    const session = new Session({ runtime, sink });

    await session.handle(query(1));
    // Termination starts from inside this admitted ingress handler. Awaiting
    // the resulting close proves that handler can leave the executor and
    // satisfy its own drain without a promise cycle.
    await session.close();

    expect(session.snapshot()).toMatchObject({
      phase: "closed",
      ingress: { active: 0, queue: { queuedItems: 0, closed: true } },
    });
    expect(runtime.queries).toHaveLength(0);
    expect(sink.controls).toEqual([
      {
        v: 2,
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
    const session = new Session({ runtime, sink });

    await session.handle(hello());
    await session.handle({ v: 2, t: "sub", id: 1, ref: "messages.list", args: {} });
    await session.handle({ v: 2, t: "reset", id: 1, cursor: cursor(0) });
    await session.handle(query(2));
    await session.handle(mutation(3));
    await session.handle({ v: 2, t: "unsub", id: 1 });
    await session.handle({ v: 2, t: "ping" });
    await settle();

    expect(session.snapshot()).toMatchObject({
      phase: "active",
      clientSessionId: "client-1",
      principal: ANONYMOUS_PRINCIPAL,
      authEpoch: 0,
    });
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
    expect(messagesOfType(sink.controls, "welcome")[0]).toMatchObject({ authEpoch: 0, principal: "anonymous" });
    expect(messagesOfType(sink.controls, "pong")).toHaveLength(1);
    expect(messagesOfType(sink.applications.map((entry) => entry.message), "transition")).toHaveLength(2);
    expect(messagesOfType(sink.applications.map((entry) => entry.message), "ok")).toHaveLength(2);
  });

  test("awaits each runtime dispatch so subscription state cannot be overtaken", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const session = new Session({ runtime, sink });
    const subscriptionGate = deferred<void>();
    runtime.subscribeHook = async () => subscriptionGate.promise;
    await session.handle(hello());

    const subscribing = session.handle({
      v: 2,
      t: "sub",
      id: 1,
      ref: "messages.list",
      args: {},
    });
    const mutating = session.handle(mutation(2));
    await settle();

    expect(runtime.subscriptions).toEqual([1]);
    expect(runtime.mutations).toHaveLength(0);
    subscriptionGate.resolve(undefined);
    await Promise.all([subscribing, mutating]);
    expect(runtime.mutations).toHaveLength(1);
  });

  test("bounds a blocked serialized ingress by exact queued item count", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const gate = deferred<void>();
    runtime.queryHook = async () => gate.promise;
    const queuedFrames = [query(2), query(3)];
    const queuedBytes = queuedFrames.reduce((total, frame) => total + wireBytes(frame), 0);
    const session = new Session({
      runtime,
      sink,
      limits: sessionLimits({ maxItems: 2, maxBytes: queuedBytes + 1_000, maxAgeMs: 1_000 }),
    });
    await session.handle(hello());

    const admitted = session.handle(query(1));
    await settle();
    const queued = queuedFrames.map((frame) => session.handle(frame));
    expect(session.snapshot().ingress).toMatchObject({
      active: 1,
      queue: { queuedItems: 2, queuedBytes, oldestAgeMs: 0 },
    });

    const rejected = session.handle(query(4));
    await expect(rejected).rejects.toMatchObject({
      reason: "items",
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
    });
    for (const frame of queued) {
      await expect(frame).rejects.toMatchObject({ reason: "closed", code: "draining" });
    }
    expect(sink.closes[0]).toMatchObject({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
      message: "Admission rejected: items",
    });

    gate.resolve(undefined);
    await admitted;
    await session.close();
    expect(runtime.queries.map((message) => message.id)).toEqual([1]);
    expect(runtime.closes[0]?.code).toBe("overloaded");
    expect(session.snapshot().ingress).toMatchObject({
      active: 0,
      queue: { queuedItems: 0, queuedBytes: 0, closed: true },
    });
  });

  test("bounds a blocked serialized ingress by exact queued UTF-8 bytes", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const gate = deferred<void>();
    runtime.queryHook = async () => gate.promise;
    const queuedFrames = [query(2), query(3)];
    const queuedBytes = queuedFrames.reduce((total, frame) => total + wireBytes(frame), 0);
    const session = new Session({
      runtime,
      sink,
      limits: sessionLimits({ maxItems: 3, maxBytes: queuedBytes, maxAgeMs: 1_000 }),
    });
    await session.handle(hello());

    const admitted = session.handle(query(1));
    await settle();
    const queued = queuedFrames.map((frame) => session.handle(frame));
    expect(session.snapshot().ingress.queue).toMatchObject({ queuedItems: 2, queuedBytes });

    const rejected = session.handle(query(4));
    await expect(rejected).rejects.toMatchObject({
      reason: "bytes",
      code: "overloaded",
      resource: "connection",
    });
    for (const frame of queued) {
      await expect(frame).rejects.toMatchObject({ reason: "closed", code: "draining" });
    }
    expect(sink.closes[0]?.message).toBe("Admission rejected: bytes");

    gate.resolve(undefined);
    await admitted;
    await session.close();
  });

  test("expires queued ingress at the exact age limit and releases its capacity", async () => {
    const clock = new ManualClock();
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const gate = deferred<void>();
    runtime.queryHook = async () => gate.promise;
    const session = new Session({
      runtime,
      sink,
      clock,
      limits: sessionLimits({ maxItems: 2, maxBytes: 1_024, maxAgeMs: 10 }),
    });
    await session.handle(hello());

    const admitted = session.handle(query(1));
    await settle();
    const queued = session.handle(query(2));
    expect(session.snapshot().ingress.queue).toMatchObject({
      queuedItems: 1,
      queuedBytes: wireBytes(query(2)),
      oldestAgeMs: 0,
      nextExpiryAtMs: 10,
    });
    await clock.advance(9);
    expect(session.snapshot().ingress.queue).toMatchObject({ queuedItems: 1, oldestAgeMs: 9 });
    await clock.advance(1);

    await expect(queued).rejects.toMatchObject({
      reason: "age",
      code: "deadline_exceeded",
      resource: "connection",
    });
    expect(session.snapshot()).toMatchObject({
      phase: "closed",
      ingress: { queue: { queuedItems: 0, queuedBytes: 0, closed: true } },
    });
    expect(sink.closes[0]?.code).toBe("deadline_exceeded");
    expect(runtime.closes).toHaveLength(0);

    gate.resolve(undefined);
    await admitted;
    await session.close();
    expect(runtime.closes[0]?.code).toBe("deadline_exceeded");
  });

  test("rejects an oversized frame before ingress retention", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const maxFrameBytes = Math.max(wireBytes(hello()), wireBytes(query(1))) + 8;
    const session = new Session({
      runtime,
      sink,
      limits: sessionLimits({ maxItems: 2, maxBytes: 1_024, maxAgeMs: 1_000 }, maxFrameBytes),
    });
    await session.handle(hello());
    const oversized = { ...query(1), args: { value: "x".repeat(maxFrameBytes) } };

    await expect(session.handle(oversized)).rejects.toMatchObject({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
      message: "client frame exceeds maxFrameBytes",
    });
    await session.close();

    expect(runtime.queries).toEqual([]);
    expect(sink.closes[0]).toMatchObject({ code: "overloaded", resource: "connection" });
    expect(session.snapshot().ingress).toMatchObject({
      admitted: 1,
      active: 0,
      queue: { queuedItems: 0, queuedBytes: 0, closed: true },
    });
  });

  test("rejects an oversized request below the transport frame ceiling before ingress retention", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const minimumRequestBytes = Math.max(wireBytes(hello()), wireBytes(query(1)));
    const maxRequestBytes = minimumRequestBytes + 8;
    const maxFrameBytes = maxRequestBytes + 256;
    const session = new Session({
      runtime,
      sink,
      limits: sessionLimits(
        { maxItems: 2, maxBytes: 1_024, maxAgeMs: 1_000 },
        maxFrameBytes,
        maxRequestBytes,
      ),
    });
    await session.handle(hello());
    const oversized = { ...query(1), args: { value: "x".repeat(maxRequestBytes) } };
    const oversizedBytes = wireBytes(oversized);
    expect(oversizedBytes).toBeGreaterThan(maxRequestBytes);
    expect(oversizedBytes).toBeLessThanOrEqual(maxFrameBytes);

    await expect(session.handle(oversized)).rejects.toMatchObject({
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
    expect(session.snapshot().ingress).toMatchObject({
      admitted: 1,
      active: 0,
      queue: { queuedItems: 0, queuedBytes: 0, closed: true },
    });
  });

  test("close rejects queued frames and waits for the admitted handler to finish", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const gate = deferred<void>();
    runtime.queryHook = async () => gate.promise;
    const session = new Session({
      runtime,
      sink,
      limits: sessionLimits({ maxItems: 2, maxBytes: 1_024, maxAgeMs: 1_000 }),
    });
    await session.handle(hello());

    let admittedFinished = false;
    const admitted = session.handle(query(1)).then(() => {
      admittedFinished = true;
    });
    await settle();
    const queued = [session.handle(query(2)), session.handle(query(3))];
    const closing = session.close(new DbzzError("draining", "server draining"));

    for (const frame of queued) {
      await expect(frame).rejects.toMatchObject({ reason: "closed", code: "draining" });
    }
    await settle();
    expect(admittedFinished).toBe(false);
    expect(runtime.closes).toEqual([]);
    expect(sink.closes[0]).toMatchObject({ code: "draining", message: "server draining" });

    gate.resolve(undefined);
    await Promise.all([admitted, closing]);
    expect(admittedFinished).toBe(true);
    expect(runtime.queries.map((message) => message.id)).toEqual([1]);
    expect(runtime.closes).toEqual([
      { code: "draining", retryable: false, message: "server draining" },
    ]);
    expect(session.snapshot().ingress).toMatchObject({
      active: 0,
      queue: { queuedItems: 0, queuedBytes: 0, closed: true },
    });
  });

  test("latest auth attempt wins, pauses operations, and exposes transitions before auth success", async () => {
    const order: string[] = [];
    const runtime = new FakeRuntime(order);
    const sink = new FakeSink(order);
    const verifier = new FakeVerifier();
    const first = deferred<VerifiedPrincipal>();
    const second = deferred<VerifiedPrincipal>();
    verifier.results.set("first", first.promise);
    verifier.results.set("second", second.promise);
    const session = new Session({ runtime, sink, verifier, clock: new ManualClock() });
    await session.handle(hello());
    order.length = 0;

    await session.handle(auth(1, { kind: "bearer", token: "first" }));
    expect(runtime.opens[0]!.signal.aborted).toBe(true);
    await session.handle(query(9));
    expect(runtime.queries).toHaveLength(0);
    expect((sink.controls.at(-1) as ErrorMessage).outcome.code).toBe("auth_stale");
    await session.handle(auth(2, { kind: "bearer", token: "second" }));

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

    first.resolve(principal("first"));
    await settle();
    expect(runtime.transitions).toHaveLength(1);
    expect(messagesOfType(sink.controls, "auth").map((message) => message.attemptId)).toEqual([2]);
    expect(verifier.calls).toEqual(["first", "second"]);
  });

  test("sign-out rotates subscriptions, drops old frames, and rejects old-epoch queued work", async () => {
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("user", principal("user"));
    const session = new Session({ runtime, sink, verifier, clock: new ManualClock() });
    await session.handle(hello({ kind: "bearer", token: "user" }));

    const authHandle = session.handle(auth(1, { kind: "anonymous" }));
    const oldEpochQuery = session.handle(query(4));
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
    const failure = deferred<VerifiedPrincipal>();
    verifier.results.set("invalid", failure.promise);
    const session = new Session({ runtime, sink, verifier, clock: new ManualClock() });
    await session.handle(hello({ kind: "bearer", token: "valid" }));

    await session.handle(auth(1, { kind: "bearer", token: "invalid" }));
    failure.reject(new DbzzError("unauthenticated", "invalid credential"));
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
    const session = new Session({ runtime, sink, verifier, clock });
    await session.handle(hello({ kind: "bearer", token: "short" }));

    await clock.advance(99);
    expect(session.snapshot().phase).toBe("active");
    await clock.advance(1);

    expect(session.snapshot().phase).toBe("closed");
    expect(sink.closes[0]?.code).toBe("unauthenticated");
    expect(sink.closes[0]?.message).toBe("credential expired");
  });

  test("matching verifier invalidation uses the reserved fail-closed path within the bound", async () => {
    const clock = new ManualClock(5_000);
    const runtime = new FakeRuntime();
    const sink = new FakeSink();
    const verifier = new FakeVerifier();
    verifier.results.set("valid", principal("user", 20_000));
    const session = new Session({
      runtime,
      sink,
      verifier,
      clock,
      revocationDeadlineMs: 5_000,
    });
    await session.handle(hello({ kind: "bearer", token: "valid" }));

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

  test("operation DbzzError is forwarded without closing the session", async () => {
    const runtime = new FakeRuntime();
    runtime.queryHook = async () => {
      throw new DbzzError("unauthorized", "access denied");
    };
    const sink = new FakeSink();
    const session = new Session({ runtime, sink });
    await session.handle(hello());
    await session.handle(query(7));
    await settle();

    const error = messagesOfType(
      sink.applications.map((entry) => entry.message),
      "err",
    )[0];
    expect(error).toEqual({
      v: 2,
      t: "err",
      id: 7,
      outcome: { code: "unauthorized", retryable: false, message: "access denied" },
    });
    expect(session.snapshot().phase).toBe("active");
    expect(sink.closes).toHaveLength(0);
  });
});
