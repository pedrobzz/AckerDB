import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallRequest,
  parseClientMessage,
  parseSseAckRequest,
  type ClientMessage,
  type Credential,
  type ServerMessage,
  type SseAckRequest,
  type SubscriptionCursor,
} from "@dbzz/core";
import {
  DbzzClient,
  DbzzClientError,
  type DbzzClientClock,
  type DbzzClientOptions,
  type DbzzLiveEvent,
  type DbzzConnectionState,
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
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

async function eventually(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function settlesPromptly(promise: Promise<unknown>, description: string): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await eventually(() => settled, description);
}

function adversarialCancellation(behavior: "pending" | "reject"): Promise<void> {
  return behavior === "pending"
    ? new Promise<void>(() => {})
    : Promise.reject(new Error("external cancellation rejected"));
}

const sseUtf8 = new TextEncoder();

function sseEvent(frame: unknown): string {
  return `data: ${encode(frame)}\n\n`;
}

function sseResponse(
  content: string | readonly unknown[],
  options: {
    readonly stream?: string | null;
    readonly stallMs?: string | null;
    readonly close?: boolean;
    readonly status?: number;
    readonly onCancel?: () => unknown;
  } = {},
): Response {
  const headers = new Headers({ "content-type": "text/event-stream" });
  const stream = options.stream === undefined ? "stream-1" : options.stream;
  const stallMs = options.stallMs === undefined ? "5000" : options.stallMs;
  if (stream !== null) headers.set("x-dbzz-sse-stream", stream);
  if (stallMs !== null) headers.set("x-dbzz-sse-max-stall-ms", stallMs);
  const text = typeof content === "string" ? content : content.map(sseEvent).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text.length !== 0) controller.enqueue(sseUtf8.encode(text));
        if (options.close ?? true) controller.close();
      },
      cancel() {
        return Promise.resolve(options.onCancel?.()).then(() => {});
      },
    }),
    { status: options.status ?? 200, headers },
  );
}

function openResponse(
  content: string,
  onCancel: () => unknown,
  init?: ResponseInit,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseUtf8.encode(content));
      },
      cancel() {
        return Promise.resolve(onCancel()).then(() => {});
      },
    }),
    init,
  );
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

  test("releases an event subscription exactly once across repeated unsubscribe and close", () => {
    const { client, sockets } = harness();
    const events: DbzzLiveEvent<{ x: number }>[] = [];
    const unsubscribe = client.subscribeEvent<Record<never, never>, { x: number }>(
      "events.cursor",
      {},
      (event) => events.push(event),
    );
    welcome(client, sockets[0]!);
    const id = lastFrame(sockets[0]!, "sub").id;
    unsubscribe();
    unsubscribe();
    expect(
      sockets[0]!.frames().filter((frame) => frame.t === "unsub"),
    ).toEqual([{ v: 2, t: "unsub", id }]);
    sockets[0]!.receive({
      v: 2,
      t: "event",
      id,
      event: { kind: "reset", cursor: { generation: "g", commitVersion: 0n, sequence: 0n } },
    });
    expect(events).toHaveLength(0);

    // close() releases surviving subscriptions itself; a hook cleanup running
    // afterwards must find nothing left to release and send nothing.
    const second = harness();
    const release = second.client.subscribeEvent("events.cursor", {}, () => {});
    welcome(second.client, second.sockets[0]!);
    second.client.close();
    expect(() => release()).not.toThrow();
    expect(
      second.sockets[0]!.frames().filter((frame) => frame.t === "unsub"),
    ).toHaveLength(0);
  });

  test("uses strict authenticated HTTP procedure envelopes", async () => {
    let authorization: string | null = null;
    const fetcher: DbzzClientOptions["fetch"] = async (url, init) => {
      expect(url.endsWith("/api/call")).toBe(true);
      authorization = new Headers(init?.headers).get("authorization");
      const request = parseCallRequest(decode(String(init?.body)));
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
    };
    const { client, sockets } = harness({
      credential: { kind: "bearer", token: "http-token" } satisfies Credential,
      fetch: fetcher,
    });

    expect(await client.procedure<{}, { count: number }>("todos.stats", {})).toEqual({ count: 2 });
    expect(authorization as string | null).toBe("Bearer http-token");
    expect(await client.procedure("todos.denied", {}).catch((error) => error)).toMatchObject({
      code: "unauthorized",
      message: "denied",
    });
    expect(sockets).toHaveLength(0);
    client.close();
  });

  test("keeps procedure completion indeterminate when response reading aborts or times out", async () => {
    for (const mode of ["abort", "timeout"] as const) {
      const abort = new AbortController();
      const cancellationNeverSettles = new Promise<void>(() => {});
      const pullNeverSettles = new Promise<void>(() => {});
      let calls = 0;
      let cancellations = 0;
      let pulls = 0;
      const { client, clock } = harness({
        limits: { maxPendingItems: 1, maxQueryAgeMs: 50 },
        fetch: async (_url, init) => {
          calls++;
          if (calls === 1) {
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull() {
                    pulls++;
                    return pullNeverSettles;
                  },
                  cancel() {
                    cancellations++;
                    return cancellationNeverSettles;
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          }
          const request = parseCallRequest(decode(String(init?.body)));
          return new Response(
            encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
          );
        },
      });
      const completion = client.procedure("procedure.response-interrupted", {}, {
        signal: abort.signal,
      }).catch((error) => error);
      await eventually(() => pulls === 1, `${mode} procedure response read`);

      if (mode === "abort") abort.abort();
      else clock.advance(50);
      await settlesPromptly(completion, `${mode} procedure response interruption`);
      expect(await completion).toMatchObject({ code: "indeterminate", resource: "operation" });
      expect(cancellations).toBe(1);
      expect(await client.procedure<{}, string>("procedure.after-interruption", {})).toBe("available");
      client.close();
    }
  });

  test("acknowledges a chunk only after iteration resumes and before yielding the next chunk", async () => {
    const acknowledgmentGate = deferred<Response>();
    const acknowledgments: SseAckRequest[] = [];
    const acknowledgmentAuthorizations: Array<string | null> = [];
    const acknowledgmentContentTypes: Array<string | null> = [];
    let streamAuthorization: string | null = null;
    const fetcher: DbzzClientOptions["fetch"] = async (url, init) => {
      if (url.endsWith("/api/sse")) {
        streamAuthorization = new Headers(init?.headers).get("authorization");
        return sseResponse([
          { v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: { delta: "a" } },
          { v: 2, t: "sse_chunk", seq: 2, proof: "proof-2", value: { delta: "b" } },
        ]);
      }
      expect(url.endsWith("/api/sse/ack")).toBe(true);
      const headers = new Headers(init?.headers);
      acknowledgmentAuthorizations.push(headers.get("authorization"));
      acknowledgmentContentTypes.push(headers.get("content-type"));
      acknowledgments.push(parseSseAckRequest(decode(String(init?.body))));
      return acknowledgmentGate.promise;
    };
    const { client, sockets } = harness({
      credential: { kind: "bearer", token: "receiver-token" },
      fetch: fetcher,
    });
    const iterator = client.sse<{}, { delta: string }>("stream.ordered", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: { delta: "a" }, done: false });
    expect(acknowledgments).toEqual([]);
    let secondSettled = false;
    const second = iterator.next().then(
      (result) => {
        secondSettled = true;
        return result;
      },
      (error) => {
        secondSettled = true;
        throw error;
      },
    );
    await eventually(() => acknowledgments.length === 1, "the first chunk acknowledgment");
    expect(secondSettled).toBe(false);
    expect(acknowledgments).toEqual([
      { v: 2, t: "sse_ack", stream: "stream-1", seq: 1, proof: "proof-1" },
    ]);
    expect(streamAuthorization as string | null).toBe("Bearer receiver-token");
    expect(acknowledgmentAuthorizations).toEqual([null]);
    expect(acknowledgmentContentTypes).toEqual(["text/plain;charset=UTF-8"]);

    acknowledgmentGate.resolve(new Response(null, { status: 204 }));
    expect(await second).toEqual({ value: { delta: "b" }, done: false });
    await iterator.return(undefined);
    expect(acknowledgments).toHaveLength(1);
    expect(sockets).toHaveLength(0);
    client.close();
  });

  test("retries network and retryable overload acknowledgments with full jitter and Retry-After", async () => {
    const acknowledgments: SseAckRequest[] = [];
    const acknowledgmentAuthorizations: Array<string | null> = [];
    const acknowledgmentContentTypes: Array<string | null> = [];
    let streamAuthorization: string | null = null;
    let firstSequenceAttempts = 0;
    const randomValues = [0.5, 0];
    const fetcher: DbzzClientOptions["fetch"] = async (url, init) => {
      if (url.endsWith("/api/sse")) {
        streamAuthorization = new Headers(init?.headers).get("authorization");
        return sseResponse([
          { v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" },
          { v: 2, t: "sse_done", seq: 2, proof: "proof-2" },
        ]);
      }
      const acknowledgment = parseSseAckRequest(decode(String(init?.body)));
      acknowledgments.push(acknowledgment);
      const headers = new Headers(init?.headers);
      acknowledgmentAuthorizations.push(headers.get("authorization"));
      acknowledgmentContentTypes.push(headers.get("content-type"));
      if (acknowledgment.seq === 1) {
        firstSequenceAttempts++;
        if (firstSequenceAttempts === 1) throw new TypeError("network unavailable");
        if (firstSequenceAttempts === 2) {
          return new Response(
            encode({
              v: 2,
              t: "err",
              id: null,
              outcome: {
                code: "overloaded",
                retryable: true,
                retryAfterMs: 200,
                message: "retry acknowledgment",
                resource: "sse",
              },
            }),
            { status: 503, headers: { "retry-after": "1" } },
          );
        }
      }
      return new Response(null, { status: 204 });
    };
    const { client, clock, sockets } = harness({
      credential: { kind: "bearer", token: "old-token" },
      fetch: fetcher,
      random: () => randomValues.shift() ?? 0,
      limits: { maxSseAckAgeMs: 5_000 },
    });
    const iterator = client.sse<{}, string>("stream.retry", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    const completion = iterator.next();
    await eventually(
      () => acknowledgments.length === 1 && clock.nextDueIn() === 50,
      "the first jitter delay",
    );
    const refresh = client.refreshCredential({ kind: "bearer", token: "current-token" });
    welcome(client, sockets[0]!, "user");
    const auth = lastFrame(sockets[0]!, "auth");
    sockets[0]!.receive({
      v: 2,
      t: "auth",
      attemptId: auth.attemptId,
      authEpoch: 1,
      principal: "user",
    });
    await refresh;
    expect(clock.nextDueIn()).toBe(50);
    clock.advance(49);
    await Promise.resolve();
    expect(acknowledgments).toHaveLength(1);
    clock.advance(1);
    await eventually(
      () => acknowledgments.length === 2 && clock.nextDueIn() === 1_000,
      "the structured overload delay",
    );
    expect(clock.nextDueIn()).toBe(1_000);
    clock.advance(999);
    await Promise.resolve();
    expect(acknowledgments).toHaveLength(2);
    clock.advance(1);

    expect(await completion).toEqual({ value: undefined, done: true });
    expect(acknowledgments.map(({ seq }) => seq)).toEqual([1, 1, 1, 2]);
    expect(streamAuthorization as string | null).toBe("Bearer old-token");
    expect(acknowledgmentAuthorizations).toEqual([null, null, null, null]);
    expect(acknowledgmentContentTypes).toEqual([
      "text/plain;charset=UTF-8",
      "text/plain;charset=UTF-8",
      "text/plain;charset=UTF-8",
      "text/plain;charset=UTF-8",
    ]);
    client.close();
  });

  test("acknowledges terminal done and error frames before resolving them", async () => {
    const cases = [
      {
        name: "done",
        frame: { v: 2, t: "sse_done", seq: 1, proof: "done-proof" },
      },
      {
        name: "error",
        frame: {
          v: 2,
          t: "sse_error",
          seq: 1,
          proof: "error-proof",
          outcome: {
            code: "slow_consumer",
            retryable: false,
            message: "receiver stalled",
            resource: "sse",
          },
        },
      },
    ] as const;

    for (const terminal of cases) {
      const acknowledgmentGate = deferred<Response>();
      const acknowledgments: SseAckRequest[] = [];
      const { client } = harness({
        fetch: async (url, init) => {
          if (url.endsWith("/api/sse")) return sseResponse([terminal.frame]);
          acknowledgments.push(parseSseAckRequest(decode(String(init?.body))));
          return acknowledgmentGate.promise;
        },
      });
      const iterator = client.sse(`stream.${terminal.name}`, {})[Symbol.asyncIterator]();
      let settled = false;
      const result = iterator.next();
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await eventually(() => acknowledgments.length === 1, `${terminal.name} acknowledgment`);
      expect(settled).toBe(false);
      expect(acknowledgments[0]).toMatchObject({
        t: "sse_ack",
        seq: 1,
        proof: terminal.frame.proof,
      });

      acknowledgmentGate.resolve(new Response(null, { status: 204 }));
      if (terminal.name === "done") {
        expect(await result).toEqual({ value: undefined, done: true });
      } else {
        expect(await result.catch((error) => error)).toMatchObject({
          code: "slow_consumer",
          resource: "sse",
        });
      }
      client.close();
    }
  });

  test("rejects malformed protocol-2 SSE responses and cancels their bodies", async () => {
    const malformedCases: ReadonlyArray<{
      readonly name: string;
      readonly response: (onCancel: () => void) => Response;
    }> = [
      {
        name: "missing stream header",
        response: (onCancel) =>
          sseResponse([{ v: 2, t: "sse_done", seq: 1, proof: "proof" }], {
            stream: null,
            close: false,
            onCancel,
          }),
      },
      {
        name: "oversized stream header",
        response: (onCancel) =>
          sseResponse([{ v: 2, t: "sse_done", seq: 1, proof: "proof" }], {
            stream: "x".repeat(129),
            close: false,
            onCancel,
          }),
      },
      {
        name: "missing stall header",
        response: (onCancel) =>
          sseResponse([{ v: 2, t: "sse_done", seq: 1, proof: "proof" }], {
            stallMs: null,
            close: false,
            onCancel,
          }),
      },
      {
        name: "raw application payload",
        response: (onCancel) =>
          sseResponse(`data: ${encode({ delta: "raw" })}\n\n`, { close: false, onCancel }),
      },
      {
        name: "legacy done sentinel",
        response: (onCancel) => sseResponse("data: [DONE]\n\n", { close: false, onCancel }),
      },
      {
        name: "sequence does not begin at one",
        response: (onCancel) =>
          sseResponse([{ v: 2, t: "sse_done", seq: 2, proof: "proof-2" }], {
            close: false,
            onCancel,
          }),
      },
      {
        name: "empty proof",
        response: (onCancel) =>
          sseResponse([{ v: 2, t: "sse_done", seq: 1, proof: "" }], {
            close: false,
            onCancel,
          }),
      },
      {
        name: "unexpected successful status",
        response: (onCancel) =>
          sseResponse([{ v: 2, t: "sse_done", seq: 1, proof: "proof" }], {
            status: 201,
            close: false,
            onCancel,
          }),
      },
    ];

    for (const malformedCase of malformedCases) {
      let cancellations = 0;
      const { client } = harness({
        fetch: async () => malformedCase.response(() => cancellations++),
      });
      const iterator = client.sse(`stream.${malformedCase.name}`, {})[Symbol.asyncIterator]();
      expect(await iterator.next().catch((error) => error)).toMatchObject({
        code: "malformed",
        resource: "sse",
      });
      expect(cancellations).toBe(1);
      client.close();
    }
  });

  test("requires an exact 204 acknowledgment response", async () => {
    let cancellations = 0;
    const { client } = harness({
      fetch: async (url) =>
        url.endsWith("/api/sse")
          ? sseResponse(
              [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
              { close: false, onCancel: () => cancellations++ },
            )
          : new Response("", { status: 200 }),
    });
    const iterator = client.sse<{}, string>("stream.bad-ack", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    expect(await iterator.next().catch((error) => error)).toMatchObject({
      code: "malformed",
      resource: "sse",
    });
    expect(cancellations).toBe(1);
    client.close();
  });

  test("rejects and cancels a body-bearing fake 204 acknowledgment", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      let acknowledgmentCancellations = 0;
      let streamCancellations = 0;
      const fake204 = {
        status: 204,
        body: {
          cancel() {
            acknowledgmentCancellations++;
            return adversarialCancellation(behavior);
          },
        },
        headers: new Headers(),
      } as unknown as Response;
      const { client } = harness({
        limits: { maxPendingItems: 1 },
        fetch: async (url, init) => {
          if (url.endsWith("/api/sse")) {
            return sseResponse(
              [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
              { close: false, onCancel: () => streamCancellations++ },
            );
          }
          if (url.endsWith("/api/sse/ack")) return fake204;
          const request = parseCallRequest(decode(String(init?.body)));
          return new Response(
            encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
          );
        },
      });
      const iterator = client.sse<{}, string>(`stream.body-204.${behavior}`, {})[
        Symbol.asyncIterator
      ]();

      expect(await iterator.next()).toEqual({ value: "chunk", done: false });
      const completion = iterator.next().catch((error) => error);
      await settlesPromptly(completion, `${behavior} body-bearing 204 rejection`);
      expect(await completion).toMatchObject({ code: "malformed", resource: "sse" });
      expect(acknowledgmentCancellations).toBe(1);
      expect(streamCancellations).toBe(1);
      expect(await client.procedure<{}, string>("procedure.after-body-204", {})).toBe("available");
      client.close();
    }
  });

  test("bounds the SSE parser before decoding a frame", async () => {
    let cancellations = 0;
    const { client } = harness({
      fetch: async () => sseResponse("x".repeat(257), {
        close: false,
        onCancel: () => cancellations++,
      }),
      limits: { maxSseBufferBytes: 256 },
    });

    const error = await client.sse("stream.large", {})[Symbol.asyncIterator]().next().catch((caught) => caught);
    expect(error).toMatchObject({ code: "overloaded", resource: "sse" });
    expect(cancellations).toBe(1);
    client.close();
  });

  test("bounds one-byte SSE pulls with linear scanning and exact BOM accounting", async () => {
    const maxBufferBytes = 4_096;
    const prefix = sseUtf8.encode("\uFEFF:\n\n");
    let pulls = 0;
    let cancellations = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const byte = pulls < prefix.byteLength ? prefix[pulls]! : 0x78;
            pulls++;
            controller.enqueue(Uint8Array.of(byte));
          },
          cancel() {
            cancellations++;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: {
          "content-type": "text/event-stream",
          "x-dbzz-sse-stream": "stream-1",
          "x-dbzz-sse-max-stall-ms": "5000",
        },
      },
    );
    const { client } = harness({
      limits: { maxSseBufferBytes: maxBufferBytes },
      fetch: async () => response,
    });

    expect(await client.sse("stream.bytewise", {})[Symbol.asyncIterator]().next().catch((error) => error))
      .toMatchObject({ code: "overloaded", resource: "sse" });
    expect(pulls).toBe(prefix.byteLength + maxBufferBytes + 1);
    expect(cancellations).toBe(1);
    client.close();
  });

  test("never yields a synchronously enqueued SSE frame after its read aborts", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      const abort = new AbortController();
      const bytes = sseUtf8.encode(sseEvent({
        v: 2,
        t: "sse_chunk",
        seq: 1,
        proof: "proof-1",
        value: "must-not-yield",
      }));
      let acknowledgments = 0;
      let cancellations = 0;
      let pulls = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(bytes);
              abort.abort();
            },
            cancel() {
              cancellations++;
              return adversarialCancellation(behavior);
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-dbzz-sse-stream": "stream-1",
            "x-dbzz-sse-max-stall-ms": "5000",
          },
        },
      );
      const { client } = harness({
        fetch: async (url) => {
          if (url.endsWith("/api/sse")) return response;
          acknowledgments++;
          return new Response(null, { status: 204 });
        },
      });
      const completion = client.sse("stream.sync-abort", {}, { signal: abort.signal })[
        Symbol.asyncIterator
      ]().next().catch((error) => error);

      await settlesPromptly(completion, `${behavior} synchronous read abort`);
      expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
      expect(pulls).toBe(1);
      expect(cancellations).toBe(1);
      expect(acknowledgments).toBe(0);
      client.close();
    }
  });

  test("aborts an open non-success SSE body without awaiting cancellation", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      const abort = new AbortController();
      const pullNeverSettles = new Promise<void>(() => {});
      let cancellations = 0;
      let pulls = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              pulls++;
              return pullNeverSettles;
            },
            cancel() {
              cancellations++;
              return adversarialCancellation(behavior);
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 503 },
      );
      const { client } = harness({
        limits: { maxPendingItems: 1 },
        fetch: async (url, init) => {
          if (url.endsWith("/api/sse")) return response;
          const request = parseCallRequest(decode(String(init?.body)));
          return new Response(
            encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
          );
        },
      });
      const completion = client.sse("stream.open-error", {}, { signal: abort.signal })[
        Symbol.asyncIterator
      ]().next().catch((error) => error);
      await eventually(() => pulls === 1, `${behavior} open error response read`);

      abort.abort();
      await settlesPromptly(completion, `${behavior} open error response abort`);
      expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
      expect(cancellations).toBe(1);
      expect(await client.procedure<{}, string>("procedure.after-open-error", {})).toBe("available");
      client.close();
    }
  });

  test("skips the SSE fetch when its signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    let streamFetches = 0;
    const { client, clock } = harness({
      limits: { maxPendingItems: 1, maxQueryAgeMs: 1 },
      fetch: async (url, init) => {
        if (url.endsWith("/api/sse")) {
          streamFetches++;
          return sseResponse([], { close: false });
        }
        const request = parseCallRequest(decode(String(init?.body)));
        return new Response(
          encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
        );
      },
    });
    const occupied = client.query("query.occupies-capacity", {}).catch((error) => error);
    const completion = client.sse("stream.pre-aborted", {}, { signal: abort.signal })[
      Symbol.asyncIterator
    ]().next().catch((error) => error);

    await settlesPromptly(completion, "pre-aborted SSE completion");
    expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
    expect(streamFetches).toBe(0);
    clock.advance(1);
    expect(await occupied).toMatchObject({ code: "deadline_exceeded" });
    expect(await client.procedure<{}, string>("procedure.after-pre-abort", {})).toBe("available");
    client.close();
  });

  test("aborts a hanging SSE fetch and cancels its late response exactly once", async () => {
    const abort = new AbortController();
    const hanging = deferred<Response>();
    const neverSettles = new Promise<void>(() => {});
    let streamFetches = 0;
    let lateCancellations = 0;
    const { client } = harness({
      limits: { maxPendingItems: 1 },
      fetch: async (url, init) => {
        if (url.endsWith("/api/sse")) {
          streamFetches++;
          return hanging.promise;
        }
        const request = parseCallRequest(decode(String(init?.body)));
        return new Response(
          encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
        );
      },
    });
    const completion = client.sse("stream.hanging-abort", {}, { signal: abort.signal })[
      Symbol.asyncIterator
    ]().next().catch((error) => error);
    await eventually(() => streamFetches === 1, "the hanging SSE fetch");

    abort.abort();
    await settlesPromptly(completion, "aborted hanging SSE fetch");
    expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
    expect(await client.procedure<{}, string>("procedure.after-hanging-abort", {})).toBe("available");

    hanging.resolve(sseResponse([], {
      close: false,
      onCancel: () => {
        lateCancellations++;
        return neverSettles;
      },
    }));
    await eventually(() => lateCancellations === 1, "late SSE response cancellation");
    expect(lateCancellations).toBe(1);
    client.close();
  });

  test("closes a hanging SSE fetch and observes its late rejection", async () => {
    const hanging = deferred<Response>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let streamFetches = 0;
    const { client } = harness({
      limits: { maxPendingItems: 1 },
      fetch: async (url) => {
        if (url.endsWith("/api/sse")) {
          streamFetches++;
          return hanging.promise;
        }
        throw new Error("closed client unexpectedly fetched another operation");
      },
    });
    process.on("unhandledRejection", onUnhandled);
    try {
      const completion = client.sse("stream.hanging-close", {})[
        Symbol.asyncIterator
      ]().next().catch((error) => error);
      await eventually(() => streamFetches === 1, "the close-owned SSE fetch");

      client.close();
      await settlesPromptly(completion, "closed hanging SSE fetch");
      expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
      hanging.reject(new Error("late injected fetch rejection"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      client.close();
    }
  });

  test("does not await rejecting or never-settling SSE cancellation", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      for (const mode of ["return", "abort", "close"] as const) {
        let acknowledgments = 0;
        let cancellations = 0;
        const abort = new AbortController();
        const { client } = harness({
          limits: { maxPendingItems: 1 },
          fetch: async (url, init) => {
            if (url.endsWith("/api/sse")) {
              return sseResponse(
                [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: mode }],
                {
                  close: false,
                  onCancel: () => {
                    cancellations++;
                    return adversarialCancellation(behavior);
                  },
                },
              );
            }
            if (url.endsWith("/api/sse/ack")) {
              acknowledgments++;
              return new Response(null, { status: 204 });
            }
            const request = parseCallRequest(decode(String(init?.body)));
            return new Response(
              encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
            );
          },
        });
        const iterator = client.sse<{}, string>(`stream.${behavior}.${mode}`, {}, {
          signal: abort.signal,
        })[Symbol.asyncIterator]();
        expect(await iterator.next()).toEqual({ value: mode, done: false });

        if (mode === "abort") abort.abort();
        else if (mode === "close") client.close();
        const completion = iterator.return(undefined);
        await settlesPromptly(completion, `${behavior} ${mode} iterator cleanup`);
        expect(await completion).toEqual({ value: undefined, done: true });
        expect(cancellations).toBe(1);
        expect(acknowledgments).toBe(0);
        if (mode !== "close") {
          expect(await client.procedure<{}, string>("procedure.after-sse", {})).toBe("available");
        }
        client.close();
      }
    }
  });

  test("external abort releases suspended SSE ownership without waiting for iterator return", async () => {
    let acknowledgments = 0;
    let cancellations = 0;
    const abort = new AbortController();
    const { client } = harness({
      limits: { maxPendingItems: 1 },
      fetch: async (url, init) => {
        if (url.endsWith("/api/sse")) {
          return sseResponse(
            [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
            { close: false, onCancel: () => cancellations++ },
          );
        }
        if (url.endsWith("/api/sse/ack")) {
          acknowledgments++;
          return new Response(null, { status: 204 });
        }
        const request = parseCallRequest(decode(String(init?.body)));
        return new Response(
          encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
        );
      },
    });
    const iterator = client.sse<{}, string>("stream.abort-owner", {}, {
      signal: abort.signal,
    })[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    abort.abort();
    await eventually(() => cancellations === 1, "suspended SSE cleanup");
    expect(await client.procedure<{}, string>("procedure.after-abort", {})).toBe("available");
    expect(cancellations).toBe(1);
    expect(acknowledgments).toBe(0);
    client.close();
  });

  test("does not await rejecting or never-settling oversized procedure cancellation", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      let calls = 0;
      let cancellations = 0;
      const { client } = harness({
        limits: { maxFrameBytes: 256, maxPendingItems: 1 },
        fetch: async (_url, init) => {
          calls++;
          if (calls === 1) {
            return openResponse("x".repeat(257), () => {
              cancellations++;
              return adversarialCancellation(behavior);
            });
          }
          const request = parseCallRequest(decode(String(init?.body)));
          return new Response(
            encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
          );
        },
      });
      const oversized = client.procedure("procedure.oversized", {}).catch((error) => error);

      await settlesPromptly(oversized, `${behavior} oversized procedure cancellation`);
      expect(await oversized).toMatchObject({ code: "overloaded", resource: "operation" });
      expect(cancellations).toBe(1);
      expect(await client.procedure<{}, string>("procedure.after-oversized", {})).toBe("available");
      client.close();
    }
  });

  test("does not await rejecting or never-settling oversized ACK cancellation", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      let acknowledgmentCancellations = 0;
      let streamCancellations = 0;
      const { client } = harness({
        limits: { maxFrameBytes: 256, maxPendingItems: 1 },
        fetch: async (url, init) => {
          if (url.endsWith("/api/sse")) {
            return sseResponse(
              [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
              { close: false, onCancel: () => streamCancellations++ },
            );
          }
          if (url.endsWith("/api/sse/ack")) {
            return openResponse("x".repeat(257), () => {
              acknowledgmentCancellations++;
              return adversarialCancellation(behavior);
            });
          }
          const request = parseCallRequest(decode(String(init?.body)));
          return new Response(
            encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
          );
        },
      });
      const iterator = client.sse<{}, string>(`stream.oversized-ack.${behavior}`, {})[
        Symbol.asyncIterator
      ]();

      expect(await iterator.next()).toEqual({ value: "chunk", done: false });
      const completion = iterator.next().catch((error) => error);
      await settlesPromptly(completion, `${behavior} oversized ACK cancellation`);
      expect(await completion).toMatchObject({ code: "overloaded", resource: "sse" });
      expect(acknowledgmentCancellations).toBe(1);
      expect(streamCancellations).toBe(1);
      expect(await client.procedure<{}, string>("procedure.after-ack", {})).toBe("available");
      client.close();
    }
  });

  test("interrupts an open non-204 ACK body on deadline and external abort", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      for (const mode of ["deadline", "abort"] as const) {
        const abort = new AbortController();
        const pullNeverSettles = new Promise<void>(() => {});
        let acknowledgmentAttempts = 0;
        let bodyCancellations = 0;
        let bodyPulls = 0;
        let streamCancellations = 0;
        const open503 = new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                bodyPulls++;
                return pullNeverSettles;
              },
              cancel() {
                bodyCancellations++;
                return adversarialCancellation(behavior);
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 503 },
        );
        const { client, clock } = harness({
          limits: { maxPendingItems: 1, maxSseAckAgeMs: 50 },
          fetch: async (url, init) => {
            if (url.endsWith("/api/sse")) {
              return sseResponse(
                [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
                {
                  stallMs: "100",
                  close: false,
                  onCancel: () => streamCancellations++,
                },
              );
            }
            if (url.endsWith("/api/sse/ack")) {
              acknowledgmentAttempts++;
              return open503;
            }
            const request = parseCallRequest(decode(String(init?.body)));
            return new Response(
              encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
            );
          },
        });
        const iterator = client.sse<{}, string>(`stream.open-ack.${behavior}.${mode}`, {}, {
          signal: abort.signal,
        })[Symbol.asyncIterator]();

        expect(await iterator.next()).toEqual({ value: "chunk", done: false });
        const completion = iterator.next().catch((error) => error);
        await eventually(() => bodyPulls === 1, `${behavior} ${mode} ACK body read`);
        if (mode === "deadline") clock.advance(50);
        else abort.abort();
        await settlesPromptly(completion, `${behavior} ${mode} open ACK interruption`);
        expect(await completion).toMatchObject({
          code: mode === "deadline" ? "deadline_exceeded" : "unavailable",
          resource: "sse",
        });
        expect(acknowledgmentAttempts).toBe(1);
        expect(bodyCancellations).toBe(1);
        expect(streamCancellations).toBe(1);
        expect(await client.procedure<{}, string>("procedure.after-open-ack", {})).toBe("available");
        client.close();
      }
    }
  });

  test("cancels a late 503 ACK response after deadline and external abort", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      for (const mode of ["deadline", "abort"] as const) {
        const abort = new AbortController();
        const late = deferred<Response>();
        let acknowledgmentAttempts = 0;
        let lateCancellations = 0;
        const { client, clock } = harness({
          limits: { maxPendingItems: 1, maxSseAckAgeMs: 50 },
          fetch: async (url, init) => {
            if (url.endsWith("/api/sse")) {
              return sseResponse(
                [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
                { stallMs: "100", close: false },
              );
            }
            if (url.endsWith("/api/sse/ack")) {
              acknowledgmentAttempts++;
              return late.promise;
            }
            const request = parseCallRequest(decode(String(init?.body)));
            return new Response(
              encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
            );
          },
        });
        const iterator = client.sse<{}, string>(`stream.late-ack.${behavior}.${mode}`, {}, {
          signal: abort.signal,
        })[Symbol.asyncIterator]();

        expect(await iterator.next()).toEqual({ value: "chunk", done: false });
        const completion = iterator.next().catch((error) => error);
        await eventually(() => acknowledgmentAttempts === 1, `${behavior} ${mode} late ACK fetch`);
        if (mode === "deadline") clock.advance(50);
        else abort.abort();
        await settlesPromptly(completion, `${behavior} ${mode} late ACK interruption`);
        expect(await completion).toMatchObject({
          code: mode === "deadline" ? "deadline_exceeded" : "unavailable",
          resource: "sse",
        });
        expect(await client.procedure<{}, string>("procedure.after-late-ack", {})).toBe("available");

        late.resolve(openResponse(
          encode({
            v: 2,
            t: "err",
            id: null,
            outcome: {
              code: "overloaded",
              retryable: true,
              retryAfterMs: 1,
              message: "late overload",
              resource: "sse",
            },
          }),
          () => {
            lateCancellations++;
            return adversarialCancellation(behavior);
          },
          { status: 503 },
        ));
        await eventually(() => lateCancellations === 1, `${behavior} ${mode} late ACK cancellation`);
        expect(acknowledgmentAttempts).toBe(1);
        expect(lateCancellations).toBe(1);
        client.close();
      }
    }
  });

  test("enforces the injected-clock acknowledgment deadline and aborts a hanging attempt", async () => {
    let attempts = 0;
    let acknowledgmentSignal: AbortSignal | undefined;
    const hanging = new Promise<Response>(() => {});
    const { client, clock } = harness({
      fetch: async (url, init) => {
        if (url.endsWith("/api/sse")) {
          return sseResponse(
            [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
            { stallMs: "100", close: false },
          );
        }
        attempts++;
        acknowledgmentSignal = init?.signal ?? undefined;
        return hanging;
      },
      limits: { maxSseAckAgeMs: 50 },
    });
    const iterator = client.sse<{}, string>("stream.deadline", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    let settled = false;
    const completion = iterator.next();
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await eventually(() => attempts === 1, "the hanging acknowledgment attempt");
    expect(clock.nextDueIn()).toBe(50);
    clock.advance(49);
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(await completion.catch((error) => error)).toMatchObject({
      code: "deadline_exceeded",
      resource: "sse",
    });
    expect(acknowledgmentSignal?.aborted).toBe(true);
    client.close();
  });

  test("bounds zero-delay network acknowledgment retries", async () => {
    let attempts = 0;
    const { client } = harness({
      fetch: async (url) => {
        if (url.endsWith("/api/sse")) {
          return sseResponse(
            [{ v: 2, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
            { close: false },
          );
        }
        attempts++;
        throw new TypeError("network unavailable");
      },
    });
    const iterator = client.sse<{}, string>("stream.retry-limit", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    expect(await iterator.next().catch((error) => error)).toMatchObject({
      code: "deadline_exceeded",
      resource: "sse",
    });
    expect(attempts).toBe(8);
    client.close();
  });

  test("skips the procedure fetch when its signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const { client } = harness({
      fetch: async (_url, init) => {
        calls++;
        const request = parseCallRequest(decode(String(init?.body)));
        return new Response(
          encode({ v: 2, t: "ok", id: request.id, kind: "procedure", value: "available" }),
        );
      },
    });
    const completion = client
      .procedure("procedure.pre-aborted", {}, { signal: abort.signal })
      .catch((error) => error);

    await settlesPromptly(completion, "pre-aborted procedure completion");
    expect(await completion).toMatchObject({ code: "unavailable", resource: "operation" });
    expect(calls).toBe(0);
    expect(await client.procedure<{}, string>("procedure.after-pre-abort", {})).toBe("available");
    expect(calls).toBe(1);
    client.close();
  });

  test("settles a procedure whose fetch ignores its abort signal, on abort and on close", async () => {
    for (const shutdown of ["abort", "close"] as const) {
      const abort = new AbortController();
      const hanging = deferred<Response>();
      let lateCancellations = 0;
      const { client } = harness({
        // A hostile transport: never settles until released, ignores the signal.
        fetch: async () => hanging.promise,
      });
      const completion = client
        .procedure("procedure.hanging-fetch", {}, { signal: abort.signal })
        .catch((error) => error);
      await Promise.resolve();

      if (shutdown === "abort") abort.abort();
      else client.close();
      await settlesPromptly(completion, `${shutdown} of a signal-ignoring procedure fetch`);
      expect(await completion).toMatchObject({ code: "indeterminate", resource: "operation" });

      hanging.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              lateCancellations++;
            },
          }),
        ),
      );
      await eventually(() => lateCancellations === 1, `${shutdown} late response disposal`);
      client.close();
    }
  });
});

describe("DbzzClient connection state", () => {
  test("publishes connecting, ready, reconnecting, and closed with stable snapshots", () => {
    const { client, sockets } = harness();
    const phases: string[] = [];
    const unsubscribe = client.subscribeConnectionState((state) => phases.push(state.phase));

    const initial = client.currentConnectionState;
    expect(initial).toEqual({ phase: "connecting" });
    expect(client.currentConnectionState).toBe(initial);

    client.connect();
    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState).toBe(initial);
    client.connect();
    expect(sockets).toHaveLength(1);

    welcome(client, sockets[0]!);
    const ready = client.currentConnectionState;
    expect(ready).toEqual({
      phase: "ready",
      authentication: { authEpoch: 0, principal: "anonymous" },
    });
    expect(client.currentConnectionState).toBe(ready);

    sockets[0]!.drop();
    expect(client.currentConnectionState).toEqual({ phase: "reconnecting" });
    expect(sockets).toHaveLength(1);

    client.connect();
    expect(sockets).toHaveLength(2);
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    welcome(client, sockets[1]!);
    expect(client.currentConnectionState.phase).toBe("ready");

    client.close();
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    client.connect();
    expect(sockets).toHaveLength(2);
    expect(phases).toEqual(["ready", "reconnecting", "ready", "closed"]);
    unsubscribe();
  });

  test("connect establishes standing demand that survives drops without operations", () => {
    const { client, clock, sockets } = harness();
    client.connect();
    welcome(client, sockets[0]!);
    sockets[0]!.drop();
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    expect(sockets).toHaveLength(1);
    clock.advance(100);
    expect(sockets).toHaveLength(2);
    welcome(client, sockets[1]!);
    expect(client.currentConnectionState.phase).toBe("ready");
    client.close();
    expect(clock.taskCount).toBe(0);
  });

  test("keeps the connecting snapshot when the first attempt drops before welcome", () => {
    const { client, sockets } = harness();
    const phases: string[] = [];
    client.subscribeConnectionState((state) => phases.push(state.phase));
    const initial = client.currentConnectionState;
    client.connect();
    sockets[0]!.drop();
    expect(client.currentConnectionState).toBe(initial);
    expect(phases).toEqual([]);
    client.close();
    expect(phases).toEqual(["closed"]);
  });

  test("reports authentication-blocked with the exact error and recovers through refreshCredential", async () => {
    const { client, sockets } = harness();
    const states: DbzzConnectionState[] = [];
    client.subscribeConnectionState((state) => states.push(state));
    client.connect();
    welcome(client, sockets[0]!);

    const blocking = new DbzzClientError({
      code: "unauthenticated",
      retryable: false,
      message: "credential expired",
    });
    sockets[0]!.receive({
      v: 2,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    const blocked = client.currentConnectionState;
    if (blocked.phase !== "authentication-blocked") throw new Error(`unexpected ${blocked.phase}`);
    expect(blocked.error).toBeInstanceOf(DbzzClientError);
    expect(blocked.error.code).toBe(blocking.code);
    expect(client.currentConnectionState).toBe(blocked);

    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    const second = sockets[1]!;
    second.open();
    second.receive({
      v: 2,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      principal: "anonymous",
    });
    expect(client.currentConnectionState.phase).toBe("ready");
    const auth = lastFrame(second, "auth");
    second.receive({ v: 2, t: "auth", attemptId: auth.attemptId, authEpoch: 2, principal: "user" });
    expect(await refresh).toEqual({ authEpoch: 2, principal: "user" });
    const upgraded = client.currentConnectionState;
    if (upgraded.phase !== "ready") throw new Error(`unexpected ${upgraded.phase}`);
    expect(upgraded.authentication).toEqual({ authEpoch: 2, principal: "user" });
    expect(states.map((state) => state.phase)).toEqual([
      "ready",
      "authentication-blocked",
      "reconnecting",
      "ready",
      "ready",
    ]);
    client.close();
  });

  test("reports terminal-error with the failure that stopped the client", () => {
    const { client, sockets } = harness();
    client.connect();
    welcome(client, sockets[0]!);
    sockets[0]!.receiveRaw("not json");
    const terminal = client.currentConnectionState;
    if (terminal.phase !== "terminal-error") throw new Error(`unexpected ${terminal.phase}`);
    expect(terminal.error).toBeInstanceOf(DbzzClientError);
    expect(terminal.error.code).toBe("malformed");
    expect(client.currentConnectionState).toBe(terminal);
    client.close();
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
  });

  test("a ready listener that reenters close releases every timer", () => {
    const { client, clock, sockets } = harness();
    client.subscribeConnectionState((state) => {
      if (state.phase === "ready") client.close();
    });
    client.connect();
    welcome(client, sockets[0]!);
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(clock.taskCount).toBe(0);
    expect(sockets[0]!.closes).toHaveLength(1);
  });

  test("a recovery listener that reenters close releases the authentication attempt", async () => {
    const { client, clock, sockets } = harness();
    client.connect();
    welcome(client, sockets[0]!);
    sockets[0]!.receive({
      v: 2,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    client.subscribeConnectionState((state) => {
      if (state.phase === "reconnecting") client.close();
    });
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(clock.taskCount).toBe(0);
    expect(sockets.filter((socket) => socket.closes.length === 0)).toHaveLength(0);
    expect(await refresh).toBeInstanceOf(DbzzClientError);
  });

  test("a nested close during notification never delivers stale state", () => {
    const { client, clock, sockets } = harness();
    const observed: string[] = [];
    client.subscribeConnectionState((state) => {
      if (state.phase === "ready") client.close();
    });
    client.subscribeConnectionState((state) => observed.push(state.phase));
    client.connect();
    welcome(client, sockets[0]!);
    expect(observed).toEqual(["closed"]);
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(clock.taskCount).toBe(0);
  });

  test("close notifies once and later subscriptions stay silent", () => {
    const { client } = harness();
    let notified = 0;
    client.subscribeConnectionState(() => notified++);
    client.close();
    client.close();
    expect(notified).toBe(1);
    let late = 0;
    const unsubscribe = client.subscribeConnectionState(() => late++);
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(late).toBe(0);
    unsubscribe();
  });
});

describe("subscription cursor confirmations", () => {
  test("confirms applied resume and checkpoint transitions but never value deliveries", () => {
    const { client, clock, sockets } = harness();
    const updates: unknown[] = [];
    let confirmations = 0;
    client.subscribe(
      "todos.list",
      { list: 1n },
      (value) => updates.push(value),
      undefined,
      { onCursorConfirmed: () => confirmations++ },
    );
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);

    // Value deliveries keep flowing through onUpdate alone.
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: ["one"] },
    });
    expect(updates).toEqual([["one"]]);
    expect(confirmations).toBe(0);

    // A checkpoint silently advances the cursor and confirms the held value.
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "checkpoint", from: c1, to: c2 },
    });
    expect(confirmations).toBe(1);
    expect(updates).toEqual([["one"]]);

    // Reconnect resumes from the retained cursor; the server's positive
    // resume lands exactly on the held cursor and confirms it.
    first.drop();
    clock.advance(100);
    const second = sockets[1]!;
    welcome(client, second);
    expect(lastFrame(second, "sub").cursor).toEqual(c2);
    second.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "resume", from: c2, to: c2 },
    });
    expect(confirmations).toBe(2);
    expect(updates).toEqual([["one"]]);
    client.close();
  });

  test("withholds held-cursor confirmation while a reset is demanded", () => {
    const { client, sockets } = harness();
    const updates: unknown[] = [];
    let confirmations = 0;
    client.subscribe(
      "todos.list",
      { list: 1n },
      (value) => updates.push(value),
      undefined,
      { onCursorConfirmed: () => confirmations++ },
    );
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
    const c0 = cursor(0n);
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    const c3 = cursor(3n);

    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: ["one"] },
    });

    // A mismatched predecessor makes the client demand a reset; deliveries
    // landing on the held cursor are no longer trusted as confirmations.
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
      transition: { kind: "update", from: c0, to: c1, value: ["one-too-late"] },
    });
    expect(confirmations).toBe(0);

    // The authoritative reset delivers through onUpdate; a duplicate of it
    // landing on the now-held cursor confirms again.
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c3, value: ["three-authoritative"] },
    });
    expect(updates).toEqual([["one"], ["three-authoritative"]]);
    expect(confirmations).toBe(0);
    first.receive({
      v: 2,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c3, value: ["three-authoritative"] },
    });
    expect(confirmations).toBe(1);
    expect(updates).toEqual([["one"], ["three-authoritative"]]);
    client.close();
  });
});

describe("subscription argument encoding", () => {
  test("rejects unencodable arguments with the exact validation error", () => {
    const { client } = harness();
    try {
      client.subscribe("todos.byScore", { score: Number.NaN }, () => {});
      throw new Error("subscribe must reject NaN arguments");
    } catch (error) {
      expect(error).toBeInstanceOf(DbzzClientError);
      expect(error).toMatchObject({
        code: "validation",
        retryable: false,
        message: "cannot encode non-finite number NaN",
        resource: "subscription",
      });
    }
    client.close();
  });
});

describe("DbzzClient close-time mutation settlement", () => {
  test("close settles sent mutations as indeterminate and unsent mutations as unavailable", async () => {
    const { client, sockets } = harness();
    const sent = client.mutation("todos.add", { text: "sent" }).catch((error) => error);
    welcome(client, sockets[0]!);
    expect(lastFrame(sockets[0]!, "m").args).toEqual({ text: "sent" });

    // Written to a connection that dropped: the server may have committed.
    sockets[0]!.drop();
    // Created while disconnected: provably never reached the server.
    const unsent = client.mutation("todos.add", { text: "unsent" }).catch((error) => error);

    client.close();
    expect(await sent).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
      message: "mutation completion is unknown",
    });
    expect(await unsent).toMatchObject({
      code: "unavailable",
      resource: "operation",
      message: "client closed",
    });
  });
});
