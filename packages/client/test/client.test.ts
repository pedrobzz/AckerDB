import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallRequest,
  parseClientMessage,
  type ClientMessage,
  type Credential,
  type ServerMessage,
  type SubscriptionCursor,
} from "@dbzz/core";
import {
  DbzzClient,
  DbzzClientError,
  type DbzzClientClock,
  type DbzzClientOptions,
  type DbzzLiveEvent,
  type DbzzWebSocket,
} from "@dbzz/client";

interface ClockTask {
  at: number;
  callback: () => void;
  intervalMs?: number;
}

class ManualClock implements DbzzClientClock {
  private nextId = 0;
  private readonly tasks = new Map<number, ClockTask>();

  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback, intervalMs: delayMs });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, ClockTask] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.intervalMs === undefined) this.tasks.delete(id);
      else task.at += task.intervalMs;
      task.callback();
    }
    this.time = target;
  }

  nextDueIn(): number | undefined {
    let due: number | undefined;
    for (const task of this.tasks.values()) {
      const delay = task.at - this.time;
      if (due === undefined || delay < due) due = delay;
    }
    return due;
  }

  get taskCount(): number {
    return this.tasks.size;
  }
}

class FakeSocket implements DbzzWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    parseClientMessage(decode(data));
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closes.push({ code, reason });
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: ServerMessage): void {
    this.receiveRaw(encode(frame));
  }

  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }

  drop(): void {
    this.close();
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => parseClientMessage(decode(text)));
  }
}

function harness(
  overrides: Partial<DbzzClientOptions> = {},
): { client: DbzzClient; clock: ManualClock; sockets: FakeSocket[] } {
  const clock = overrides.clock instanceof ManualClock ? overrides.clock : new ManualClock();
  const sockets: FakeSocket[] = [];
  const client = new DbzzClient({
    url: "http://dbzz.test",
    credential: { kind: "anonymous" },
    clientSessionId: "test-session",
    clock,
    random: () => 0,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  return { client, clock, sockets };
}

function welcome(client: DbzzClient, socket: FakeSocket, principal: "anonymous" | "user" = "anonymous"): void {
  socket.open();
  socket.receive({
    v: PROTOCOL_VERSION,
    t: "welcome",
    clientSessionId: client.clientSessionId,
    authEpoch: 0,
    principal,
  });
}

function cursor(
  commitVersion: bigint,
  generation = "generation-1",
  authEpoch = 0,
): SubscriptionCursor {
  return { generation, commitVersion, authEpoch, identity: "todos.list:{list:1}" };
}

function lastFrame<T extends ClientMessage["t"]>(
  socket: FakeSocket,
  type: T,
): Extract<ClientMessage, { t: T }> {
  const frame = socket.frames().findLast((candidate) => candidate.t === type);
  if (!frame) throw new Error(`No ${type} frame`);
  return frame as Extract<ClientMessage, { t: T }>;
}

describe("DbzzClient protocol 2 ownership", () => {
  test("sends explicit hello, pauses for refresh, and keeps one session across reconnect", async () => {
    const { client, clock, sockets } = harness({
      credential: { kind: "bearer", token: "token-a" },
      clientSessionId: "stable-session",
    });
    const firstResult = client.query("todos.list", { list: 1n }).catch((error) => error);
    const first = sockets[0]!;
    first.open();
    expect(first.frames()).toEqual([
      {
        v: 2,
        t: "hello",
        clientSessionId: "stable-session",
        credential: { kind: "bearer", token: "token-a" },
      },
    ]);
    first.receive({
      v: 2,
      t: "welcome",
      clientSessionId: "stable-session",
      authEpoch: 4,
      principal: "user",
    });
    expect(first.frames().some((frame) => frame.t === "q")).toBe(true);

    let refreshResolved = false;
    const refresh = client.refreshCredential({ kind: "anonymous" }).then((authentication) => {
      refreshResolved = true;
      return authentication;
    });
    const auth = lastFrame(first, "auth");
    const secondResult = client.query("todos.list", { list: 2n }).catch((error) => error);
    const sentQueriesBeforeConfirmation = first.frames().filter((frame) => frame.t === "q").length;
    first.receive({
      v: 2,
      t: "auth",
      attemptId: auth.attemptId + 10,
      authEpoch: 5,
      principal: "anonymous",
    });
    await Promise.resolve();
    expect(refreshResolved).toBe(false);
    expect(first.frames().filter((frame) => frame.t === "q")).toHaveLength(
      sentQueriesBeforeConfirmation,
    );

    first.receive({
      v: 2,
      t: "auth",
      attemptId: auth.attemptId,
      authEpoch: 5,
      principal: "anonymous",
    });
    expect(await refresh).toEqual({ authEpoch: 5, principal: "anonymous" });
    expect(first.frames().filter((frame) => frame.t === "q")).toHaveLength(
      sentQueriesBeforeConfirmation + 1,
    );

    first.drop();
    expect(sockets).toHaveLength(1);
    clock.advance(99);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    const second = sockets[1]!;
    second.open();
    expect(lastFrame(second, "hello")).toEqual({
      v: 2,
      t: "hello",
      clientSessionId: "stable-session",
      credential: { kind: "anonymous" },
    });

    client.close();
    expect(await firstResult).toBeInstanceOf(DbzzClientError);
    expect(await secondResult).toBeInstanceOf(DbzzClientError);
  });

  test("replays a credential refresh that starts before the welcome handshake", async () => {
    const { client, sockets } = harness({
      credential: { kind: "bearer", token: "token-a" },
    });
    const query = client.query("todos.list", {}).catch((error) => error);
    const socket = sockets[0]!;
    socket.open();
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(socket.frames().some((frame) => frame.t === "auth")).toBe(false);

    socket.receive({
      v: 2,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      principal: "user",
    });
    const auth = lastFrame(socket, "auth");
    expect(auth.credential).toEqual({ kind: "bearer", token: "token-b" });
    expect(socket.frames().some((frame) => frame.t === "q")).toBe(false);
    socket.receive({
      v: 2,
      t: "auth",
      attemptId: auth.attemptId,
      authEpoch: 2,
      principal: "user",
    });
    expect(await refresh).toEqual({ authEpoch: 2, principal: "user" });
    expect(socket.frames().some((frame) => frame.t === "q")).toBe(true);

    client.close();
    expect(await query).toMatchObject({ code: "unavailable" });
  });

  test("applies only a matching cursor predecessor, ignores duplicates, and resumes from applied state", () => {
    const { client, clock, sockets } = harness();
    const updates: unknown[] = [];
    client.subscribe("todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    const c3 = cursor(3n);

    const initial: ServerMessage = {
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: ["one"] },
    };
    first.receive(initial);
    first.receive(initial);
    expect(updates).toEqual([["one"]]);

    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "update", from: c2, to: c3, value: ["three-untrusted"] },
    });
    expect(lastFrame(first, "reset")).toEqual({ v: 2, t: "reset", id: subscription.id, cursor: c1 });
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "update", from: c1, to: c2, value: ["two-too-late"] },
    });
    expect(updates).toEqual([["one"]]);

    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c3, value: ["three-authoritative"] },
    });
    expect(updates).toEqual([["one"], ["three-authoritative"]]);

    first.drop();
    clock.advance(100);
    const second = sockets[1]!;
    welcome(client, second);
    expect(lastFrame(second, "sub").cursor).toEqual(c3);
    client.close();
  });

  test("holds mutation results for convergence, discharges unsubscribe, and replays one UUIDv7", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const { client, sockets } = harness({ clock });
    const unsubscribe = client.subscribe("todos.list", { list: 1n }, () => {});
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: [] },
    });

    let resolved = false;
    const mutation = client.mutation("todos.add", { text: "milk" }).then((value) => {
      resolved = true;
      return value;
    });
    const firstMutation = lastFrame(first, "m");
    expect(firstMutation.issuedAt).toBe(1_700_000_000_000);
    expect(firstMutation.mutationRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    first.receive({
      v: 2,
      t: "ok",
      id: firstMutation.id,
      kind: "mutation",
      value: 41n,
      receipt: {
        mutationRequestId: firstMutation.mutationRequestId,
        commitVersion: 2n,
        durability: "production",
        replay: "executed",
        obligations: [subscription.id],
      },
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "checkpoint", from: c1, to: c2 },
    });
    expect(await mutation).toBe(41n);

    const discharged = client.mutation("todos.add", { text: "bread" });
    const secondMutation = lastFrame(first, "m");
    first.receive({
      v: 2,
      t: "ok",
      id: secondMutation.id,
      kind: "mutation",
      value: 42n,
      receipt: {
        mutationRequestId: secondMutation.mutationRequestId,
        commitVersion: 3n,
        durability: "production",
        replay: "executed",
        obligations: [subscription.id],
      },
    });
    unsubscribe();
    expect(await discharged).toBe(42n);

    const replayed = client.mutation("todos.add", { text: "lost-ack" });
    const lostFrame = lastFrame(first, "m");
    first.drop();
    clock.advance(100);
    const second = sockets[1]!;
    welcome(client, second);
    const resent = lastFrame(second, "m");
    expect(resent.mutationRequestId).toBe(lostFrame.mutationRequestId);
    expect(resent.issuedAt).toBe(lostFrame.issuedAt);
    second.receive({
      v: 2,
      t: "ok",
      id: resent.id,
      kind: "mutation",
      value: 43n,
      receipt: {
        mutationRequestId: resent.mutationRequestId,
        commitVersion: 4n,
        durability: "production",
        replay: "replayed",
        obligations: [],
      },
    });
    expect(await replayed).toBe(43n);
    client.close();
  });

  test("surfaces exact outcomes and terminates on a malformed server frame", async () => {
    const { client, sockets } = harness();
    const rejected = client.query("todos.private", {});
    const socket = sockets[0]!;
    welcome(client, socket);
    const query = lastFrame(socket, "q");
    socket.receive({
      v: 2,
      t: "err",
      id: query.id,
      outcome: {
        code: "unauthorized",
        retryable: false,
        message: "not allowed",
        resource: "operation",
      },
    });
    const exact = await rejected.catch((error) => error);
    expect(exact).toBeInstanceOf(DbzzClientError);
    expect(exact).toMatchObject({
      code: "unauthorized",
      retryable: false,
      resource: "operation",
      message: "not allowed",
    });
    if (!(exact instanceof DbzzClientError)) throw new Error("expected DbzzClientError");
    expect(Object.isFrozen(exact.outcome)).toBe(true);

    const malformed = client.query("todos.list", {});
    const malformedFrame = lastFrame(socket, "q");
    socket.receiveRaw(
      encode({
        v: 2,
        t: "ok",
        id: malformedFrame.id,
        kind: "query",
        value: [],
        unexpected: true,
      }),
    );
    expect(await malformed.catch((error) => error)).toMatchObject({ code: "malformed" });
    expect(socket.closes.at(-1)?.code).toBe(1002);
    expect(await client.query("todos.list", {}).catch((error) => error)).toMatchObject({
      code: "unavailable",
    });
    client.close();
  });

  test("enforces pending item, byte, age, and inbound frame limits", async () => {
    const { client, clock } = harness({
      limits: { maxPendingItems: 1, maxQueryAgeMs: 10 },
    });
    const aging = client.query("todos.list", {}).catch((error) => error);
    expect(await client.query("todos.list", {}).catch((error) => error)).toMatchObject({
      code: "overloaded",
      retryable: true,
    });
    clock.advance(10);
    expect(await aging).toMatchObject({ code: "deadline_exceeded" });
    client.close();

    const sentMutation = harness({ limits: { maxMutationAgeMs: 10 } });
    const unknown = sentMutation.client.mutation("todos.add", {}).catch((error) => error);
    welcome(sentMutation.client, sentMutation.sockets[0]!);
    sentMutation.clock.advance(10);
    expect(await unknown).toMatchObject({ code: "indeterminate", resource: "idempotency" });
    sentMutation.client.close();

    const byteBound = harness({ limits: { maxPendingBytes: 1 } }).client;
    expect(() => byteBound.subscribe("todos.list", {}, () => {})).toThrow(DbzzClientError);
    byteBound.close();

    const inbound = harness({ limits: { maxFrameBytes: 256 } });
    const inboundResult = inbound.client.query("todos.list", {}).catch((error) => error);
    welcome(inbound.client, inbound.sockets[0]!);
    inbound.sockets[0]!.receiveRaw("x".repeat(257));
    expect(await inboundResult).toMatchObject({ code: "malformed" });
    inbound.client.close();
  });

  test("uses deterministic exponential jitter, retry floors, stable reset, and cancels timers", async () => {
    const randomValues = [0.5, 0.25, 0];
    const { client, clock, sockets } = harness({ random: () => randomValues.shift() ?? 0 });
    const result = client.query("todos.list", {}).catch((error) => error);
    welcome(client, sockets[0]!);
    sockets[0]!.drop();
    expect(clock.nextDueIn()).toBe(150);
    clock.advance(149);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);

    welcome(client, sockets[1]!);
    sockets[1]!.receive({
      v: 2,
      t: "err",
      id: null,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 1_000,
        message: "connection admission is full",
        resource: "connection",
      },
    });
    expect(clock.nextDueIn()).toBe(1_000);
    clock.advance(1_000);
    expect(sockets).toHaveLength(3);

    welcome(client, sockets[2]!);
    clock.advance(10_000);
    sockets[2]!.drop();
    expect(clock.nextDueIn()).toBe(100);
    client.close();
    expect(clock.taskCount).toBe(0);
    expect(await result).toBeInstanceOf(DbzzClientError);
  });

  test("keeps event subscriptions live-only and reports sequence gaps", () => {
    const { client, clock, sockets } = harness();
    const events: DbzzLiveEvent<{ x: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { x: number }>(
      "events.cursor",
      {},
      (event) => events.push(event),
    );
    welcome(client, sockets[0]!);
    const subscription = lastFrame(sockets[0]!, "sub");
    expect(subscription.args).toEqual({});
    expect(subscription.cursor).toBeUndefined();
    const firstCursor = { generation: "events-1", commitVersion: 1n, sequence: 1n };
    sockets[0]!.receive({
      v: 2,
      t: "event",
      id: subscription.id,
      event: { kind: "row", cursor: firstCursor, row: { x: 1 } },
    });
    sockets[0]!.receive({
      v: 2,
      t: "event",
      id: subscription.id,
      event: { kind: "row", cursor: firstCursor, row: { x: 1 } },
    });
    sockets[0]!.receive({
      v: 2,
      t: "event",
      id: subscription.id,
      event: {
        kind: "row",
        cursor: { generation: "events-1", commitVersion: 3n, sequence: 3n },
        row: { x: 3 },
      },
    });
    sockets[0]!.receive({
      v: 2,
      t: "event",
      id: subscription.id,
      event: {
        kind: "reset",
        cursor: { generation: "events-2", commitVersion: 3n, sequence: 0n },
      },
    });
    expect(events.map((event) => event.kind)).toEqual(["row", "gap", "reset"]);

    sockets[0]!.drop();
    clock.advance(100);
    welcome(client, sockets[1]!);
    expect(lastFrame(sockets[1]!, "sub").cursor).toBeUndefined();
    client.close();
  });

  test("uses strict authenticated HTTP/SSE envelopes and bounds the SSE parser", async () => {
    const utf8 = new TextEncoder();
    const stream = (text: string): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(utf8.encode(text));
            controller.close();
          },
        }),
      );
    let authorization: string | null = null;
    const fetcher: DbzzClientOptions["fetch"] = async (url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      const request = parseCallRequest(decode(String(init?.body)));
      if (url.endsWith("/api/call")) {
        if (request.ref === "todos.denied") {
          return new Response(
            encode({
              v: 2,
              t: "err",
              id: request.id,
              outcome: { code: "unauthorized", retryable: false, message: "denied" },
            }),
            { status: 403 },
          );
        }
        return new Response(
          encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: { count: 2 } }),
        );
      }
      if (request.ref === "stream.fail") {
        return stream(
          `event: dbzz-error\ndata: ${encode({
            code: "slow_consumer",
            retryable: false,
            message: "stream terminated",
            resource: "sse",
          })}\n\n`,
        );
      }
      if (request.ref === "stream.large") return stream("x".repeat(257));
      return stream(
        `data: ${encode({ delta: "a" })}\n\ndata: ${encode({ delta: "b" })}\n\ndata: [DONE]\n\n`,
      );
    };
    const { client, sockets } = harness({
      credential: { kind: "bearer", token: "http-token" } satisfies Credential,
      fetch: fetcher,
      limits: { maxSseBufferBytes: 256 },
    });

    expect(await client.procedure<{}, { count: number }>("todos.stats", {})).toEqual({ count: 2 });
    expect(authorization as string | null).toBe("Bearer http-token");
    expect(await client.procedure("todos.denied", {}).catch((error) => error)).toMatchObject({
      code: "unauthorized",
      message: "denied",
    });

    const chunks: unknown[] = [];
    for await (const chunk of client.sse("stream.ok", {})) chunks.push(chunk);
    expect(chunks).toEqual([{ delta: "a" }, { delta: "b" }]);
    let streamFailure: unknown;
    try {
      for await (const _chunk of client.sse("stream.fail", {})) {
        throw new Error("failure stream unexpectedly yielded");
      }
    } catch (error) {
      streamFailure = error;
    }
    expect(streamFailure).toMatchObject({ code: "slow_consumer", resource: "sse" });
    let overflow: unknown;
    try {
      for await (const _chunk of client.sse("stream.large", {})) {
        throw new Error("oversized stream unexpectedly yielded");
      }
    } catch (error) {
      overflow = error;
    }
    expect(overflow).toMatchObject({ code: "overloaded", resource: "sse" });
    expect(sockets).toHaveLength(0);
    client.close();
  });
});
