import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  apiGroup,
  decode,
  encode,
  parseClientMessage,
  parseSseAckRequest,
  type ApplicationError,
  type AuthenticationDescriptor,
  type ClientMessage,
  type Credential,
  type Identity,
  type ServerMessage,
  type SseAckRequest,
  type SseRef,
  type SubscriptionCursor,
} from "@ackerdb/core";
import {
  AckerDBClient,
  AckerDBClientError,
  type AckerDBAuthenticationState,
  type ClientResult,
  type AckerDBClientOptions,
  type AckerDBLiveEvent,
  type AckerDBConnectionState,
} from "@ackerdb/client";
import { deferred } from "ackerdb-test-support/async";
import { FakeSocket, ManualClock } from "ackerdb-test-support/client-transport";
import { createHarness, cursor, mustErr, mustOk } from "./support/harness.ts";

const USER_AUTHENTICATION = {
  principal: "user",
  identity: 1n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;
const REFRESHED_USER_AUTHENTICATION = {
  principal: "user",
  identity: USER_AUTHENTICATION.identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1-refreshed" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;

function dispatchProcedure<Args extends object, Value>(
  client: AckerDBClient,
  sockets: FakeSocket[],
  ref: string,
  args: Args,
  options?: { readonly signal?: AbortSignal },
): {
  readonly completion: Promise<ClientResult<Value>>;
  readonly request: Extract<ClientMessage, { t: "p" }>;
  readonly socket: FakeSocket;
} {
  const completion = client.procedure<Args, Value>(ref, args, options);
  const socket = sockets.at(-1);
  if (!socket) throw new Error("procedure demand did not create a socket");
  if (!socket.frames().some((frame) => frame.t === "p")) socket.welcome(client.clientSessionId);
  return { completion, request: socket.lastFrame("p"), socket };
}

async function completeProcedure<Value>(
  client: AckerDBClient,
  sockets: FakeSocket[],
  ref: string,
  value: Value,
): Promise<Value> {
  const dispatched = dispatchProcedure<Record<never, never>, Value>(client, sockets, ref, {});
  dispatched.socket.receive({
    v: PROTOCOL_VERSION,
    t: "ok",
    id: dispatched.request.id,
    kind: "procedure",
    value,
  });
  return mustOk(await dispatched.completion);
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

/** The only AckerDB-owned HTTP route the client calls; everything else is a stream. */
const SSE_ACK_PATH = "/_sse/ack";

/** The group is the root: "api.stream.ordered" streams from "/api/stream/ordered". */
function ssePath(address: string): string {
  return `/${address.replaceAll(".", "/")}`;
}

function isSseCall(url: string): boolean {
  return !url.endsWith(SSE_ACK_PATH);
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
  if (stream !== null) headers.set("x-ackerdb-sse-stream", stream);
  if (stallMs !== null) headers.set("x-ackerdb-sse-max-stall-ms", stallMs);
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

describe("AckerDBClient protocol 2 ownership", () => {
  test("sends explicit hello, pauses for refresh, and keeps one session across reconnect", async () => {
    const { client, clock, sockets } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
      clientSessionId: "stable-session",
    });
    const firstResult = client.query("api.todos.list", { list: 1n }).then(mustErr);
    const first = sockets[0]!;
    first.open();
    expect(first.frames()).toEqual([
      {
        v: 5,
        t: "hello",
        clientSessionId: "stable-session",
        credential: { kind: "bearer", token: "token-a" },
      },
    ]);
    first.receive({
      v: 5,
      t: "welcome",
      clientSessionId: "stable-session",
      authEpoch: 4,
      ...USER_AUTHENTICATION,
    });
    expect(first.frames().some((frame) => frame.t === "q")).toBe(true);

    let refreshResolved = false;
    const refresh = client.refreshCredential({ kind: "anonymous" }).then((authentication) => {
      refreshResolved = true;
      return authentication;
    });
    const auth = first.lastFrame("auth");
    const secondResult = client.query("api.todos.list", { list: 2n }).then(mustErr);
    const sentQueriesBeforeConfirmation = first.frames().filter((frame) => frame.t === "q").length;
    first.receive({
      v: 5,
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
      v: 5,
      t: "auth",
      attemptId: auth.attemptId,
      authEpoch: 5,
      principal: "anonymous",
    });
    expect(await refresh).toEqual({ authEpoch: 5, principal: "anonymous" });
    expect(first.frames().filter((frame) => frame.t === "q")).toHaveLength(
      sentQueriesBeforeConfirmation + 1,
    );

    first.close();
    expect(sockets).toHaveLength(1);
    clock.advance(99);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    const second = sockets[1]!;
    second.open();
    expect(second.lastFrame("hello")).toEqual({
      v: 5,
      t: "hello",
      clientSessionId: "stable-session",
      credential: { kind: "anonymous" },
    });

    client.close();
    expect(await firstResult).toBeInstanceOf(AckerDBClientError);
    expect(await secondResult).toBeInstanceOf(AckerDBClientError);
  });

  test("replays a credential refresh that starts before the welcome handshake", async () => {
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    const query = client.query("api.todos.list", {}).then(mustErr);
    const socket = sockets[0]!;
    socket.open();
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(socket.frames().some((frame) => frame.t === "auth")).toBe(false);

    socket.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    const auth = socket.lastFrame("auth");
    expect(auth.credential).toEqual({ kind: "bearer", token: "token-b" });
    expect(socket.frames().some((frame) => frame.t === "q")).toBe(false);
    socket.receive({
      v: 5,
      t: "auth",
      attemptId: auth.attemptId,
      authEpoch: 2,
      ...USER_AUTHENTICATION,
    });
    expect(await refresh).toEqual({ authEpoch: 2, ...USER_AUTHENTICATION });
    expect(socket.frames().some((frame) => frame.t === "q")).toBe(true);

    client.close();
    expect(await query).toMatchObject({ code: "unavailable" });
  });

  test("applies only a matching cursor predecessor, ignores duplicates, and resumes from applied state", () => {
    const { client, clock, sockets } = createHarness();
    const updates: unknown[] = [];
    client.subscribe("api.todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    const c3 = cursor(3n);

    const initial: ServerMessage = {
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: ["one"] },
    };
    first.receive(initial);
    first.receive(initial);
    expect(updates).toEqual([["one"]]);

    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "update", from: c2, to: c3, value: ["three-untrusted"] },
    });
    expect(first.lastFrame("reset")).toEqual({ v: 5, t: "reset", id: subscription.id, cursor: c1 });
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "update", from: c1, to: c2, value: ["two-too-late"] },
    });
    expect(updates).toEqual([["one"]]);

    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c3, value: ["three-authoritative"] },
    });
    expect(updates).toEqual([["one"], ["three-authoritative"]]);

    first.close();
    clock.advance(100);
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(second.lastFrame("sub").cursor).toEqual(c3);
    client.close();
  });

  test("holds mutation results for convergence, discharges unsubscribe, and replays one UUIDv7", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const { client, sockets } = createHarness({ clock });
    const unsubscribe = client.subscribe("api.todos.list", { list: 1n }, () => {});
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: [] },
    });

    let resolved = false;
    const mutation = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      resolved = true;
      return value;
    });
    const firstMutation = first.lastFrame("m");
    expect(firstMutation.issuedAt).toBe(1_700_000_000_000);
    expect(firstMutation.mutationRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    first.receive({
      v: 5,
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
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "checkpoint", from: c1, to: c2 },
    });
    expect(mustOk(await mutation)).toBe(41n);

    const discharged = client.mutation("api.todos.add", { text: "bread" });
    const secondMutation = first.lastFrame("m");
    first.receive({
      v: 5,
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
    expect(mustOk(await discharged)).toBe(42n);

    const replayed = client.mutation("api.todos.add", { text: "lost-ack" });
    const lostFrame = first.lastFrame("m");
    first.close();
    clock.advance(100);
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const resent = second.lastFrame("m");
    expect(resent.mutationRequestId).toBe(lostFrame.mutationRequestId);
    expect(resent.issuedAt).toBe(lostFrame.issuedAt);
    second.receive({
      v: 5,
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
    expect(mustOk(await replayed)).toBe(43n);
    client.close();
  });

  test("surfaces exact outcomes and terminates on a malformed server frame", async () => {
    const { client, sockets } = createHarness();
    const rejected = client.query("api.todos.private", {});
    const socket = sockets[0]!;
    socket.welcome(client.clientSessionId);
    const query = socket.lastFrame("q");
    socket.receive({
      v: 5,
      t: "err",
      id: query.id,
      outcome: {
        code: "unauthorized",
        retryable: false,
        message: "not allowed",
        resource: "operation",
      },
    });
    const exact = mustErr(await rejected);
    expect(exact).toBeInstanceOf(AckerDBClientError);
    expect(exact).toMatchObject({
      code: "unauthorized",
      retryable: false,
      resource: "operation",
      message: "not allowed",
    });
    if (!(exact instanceof AckerDBClientError)) throw new Error("expected AckerDBClientError");
    expect(Object.isFrozen(exact.outcome)).toBe(true);

    const malformed = client.query("api.todos.list", {});
    const malformedFrame = socket.lastFrame("q");
    socket.receiveRaw(
      encode({
        v: 5,
        t: "ok",
        id: malformedFrame.id,
        kind: "query",
        value: [],
        unexpected: true,
      }),
    );
    expect(mustErr(await malformed)).toMatchObject({ code: "malformed" });
    expect(socket.closes.at(-1)?.code).toBe(4002);
    expect(mustErr(await client.query("api.todos.list", {}))).toMatchObject({
      code: "unavailable",
    });
    client.close();
  });

  test("resolves query and mutation application errors as typed Results", async () => {
    type Missing = ApplicationError<
      "todo.not-found",
      { readonly id: bigint },
      404
    >;
    const { client, sockets } = createHarness();
    const queryResult = client.query<Record<never, never>, { id: bigint }, Missing>(
      "api.todos.find",
      {},
    );
    const socket = sockets[0]!;
    socket.welcome(client.clientSessionId);
    const query = socket.lastFrame("q");
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "app_err",
      id: query.id,
      kind: "query",
      error: {
        kind: "application",
        code: "todo.not-found",
        body: { id: 7n },
        status: 404,
      },
    });
    const missing = await queryResult;
    if (missing.ok) throw new Error("expected the query to fail");
    expect(missing.error).toEqual({
      kind: "application",
      code: "todo.not-found",
      body: { id: 7n },
      status: 404,
    });

    const mutationResult = client.mutation<Record<never, never>, bigint, Missing>(
      "api.todos.remove",
      {},
    );
    const mutation = socket.lastFrame("m");
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "app_err",
      id: mutation.id,
      kind: "mutation",
      error: {
        kind: "application",
        code: "todo.not-found",
        body: { id: 8n },
        status: 404,
      },
      receipt: {
        mutationRequestId: mutation.mutationRequestId,
        commitVersion: 1n,
        durability: "production",
        replay: "executed",
        obligations: [],
      },
    });
    const removed = await mutationResult;
    if (removed.ok) throw new Error("expected the mutation to fail");
    if (removed.error.kind !== "application") {
      throw new Error("expected an application error");
    }
    expect(removed.error.body.id).toBe(8n);
    client.close();
  });

  test("enforces pending item, byte, age, and inbound frame limits", async () => {
    const { client, clock } = createHarness({
      limits: { maxPendingItems: 1, maxQueryAgeMs: 10 },
    });
    const aging = client.query("api.todos.list", {}).then(mustErr);
    expect(mustErr(await client.query("api.todos.list", {}))).toMatchObject({
      code: "overloaded",
      retryable: true,
    });
    clock.advance(10);
    expect(await aging).toMatchObject({ code: "deadline_exceeded" });
    client.close();

    const sentMutation = createHarness({ limits: { maxMutationAgeMs: 10 } });
    const unknown = sentMutation.client.mutation("api.todos.add", {}).then(mustErr);
    sentMutation.sockets[0]!.welcome(sentMutation.client.clientSessionId);
    sentMutation.clock.advance(10);
    expect(await unknown).toMatchObject({ code: "indeterminate", resource: "idempotency" });
    sentMutation.client.close();

    const byteBound = createHarness({ limits: { maxPendingBytes: 1 } }).client;
    expect(() => byteBound.subscribe("api.todos.list", {}, () => {})).toThrow(AckerDBClientError);
    byteBound.close();

    const inbound = createHarness({ limits: { maxFrameBytes: 256 } });
    const inboundResult = inbound.client.query("api.todos.list", {}).then(mustErr);
    inbound.sockets[0]!.welcome(inbound.client.clientSessionId);
    inbound.sockets[0]!.receiveRaw("x".repeat(257));
    expect(await inboundResult).toMatchObject({ code: "malformed" });
    inbound.client.close();
  });

  test("uses deterministic exponential jitter, retry floors, stable reset, and cancels timers", async () => {
    const randomValues = [0.5, 0.25, 0];
    const { client, clock, sockets } = createHarness({ random: () => randomValues.shift() ?? 0 });
    const result = client.query("api.todos.list", {}).then(mustErr);
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.close();
    expect(clock.nextDueIn()).toBe(150);
    clock.advance(149);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.welcome(client.clientSessionId);
    sockets[1]!.receive({
      v: 5,
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
    expect(sockets[1]!.closes).toContainEqual({
      code: 4000,
      reason: "retry later",
    });
    expect(clock.nextDueIn()).toBe(1_000);
    clock.advance(1_000);
    expect(sockets).toHaveLength(3);

    sockets[2]!.welcome(client.clientSessionId);
    clock.advance(10_000);
    sockets[2]!.close();
    expect(clock.nextDueIn()).toBe(100);
    client.close();
    expect(clock.taskCount).toBe(0);
    expect(await result).toBeInstanceOf(AckerDBClientError);
  });

  test("owns retryable subscription demand, cursor, backoff, and cancellation", () => {
    const { client, clock, sockets } = createHarness();
    const values: unknown[] = [];
    const stop = client.subscribe("api.todos.list", {}, (value) => values.push(value));
    sockets[0]!.welcome(client.clientSessionId);
    const subscription = sockets[0]!.lastFrame("sub");
    const held = cursor(4n);
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: held, value: ["held"] },
    });
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: subscription.id,
      outcome: { code: "overloaded", retryable: true, retryAfterMs: 50, message: "retry" },
    });
    expect(clock.nextDueIn()).toBe(100);
    clock.advance(99);
    expect(sockets[0]!.frames().filter((frame) => frame.t === "sub")).toHaveLength(1);
    clock.advance(1);
    const attempts = sockets[0]!.frames().filter((frame) => frame.t === "sub");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ id: subscription.id, cursor: held });
    stop();
    expect(clock.taskCount).toBe(2); // stable-open + heartbeat only
    client.close();
    expect(values).toEqual([["held"]]);
  });

  test("an onError release cannot leave a retry timer behind", () => {
    const { client, clock, sockets } = createHarness();
    let stop = (): void => {};
    stop = client.subscribe("api.todos.list", {}, () => {}, () => stop());
    sockets[0]!.welcome(client.clientSessionId);
    const id = sockets[0]!.lastFrame("sub").id;
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: { code: "overloaded", retryable: true, message: "retry" },
    });
    expect(clock.taskCount).toBe(2); // stable-open + heartbeat only
    clock.advance(1_000);
    expect(sockets[0]!.frames().filter((frame) => frame.t === "sub")).toHaveLength(1);
    client.close();
  });

  test("keeps event subscriptions live-only and reports sequence gaps", () => {
    const { client, clock, sockets } = createHarness();
    const events: AckerDBLiveEvent<{ x: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { x: number }>(
      "api.events.cursor",
      {},
      (event) => events.push(event),
    );
    sockets[0]!.welcome(client.clientSessionId);
    const subscription = sockets[0]!.lastFrame("sub");
    expect(subscription.args).toEqual({});
    expect(subscription.cursor).toBeUndefined();
    const firstCursor = { generation: "events-1", commitVersion: 1n, sequence: 1n };
    sockets[0]!.receive({
      v: 5,
      t: "event",
      id: subscription.id,
      event: { kind: "row", cursor: firstCursor, row: { x: 1 } },
    });
    sockets[0]!.receive({
      v: 5,
      t: "event",
      id: subscription.id,
      event: { kind: "row", cursor: firstCursor, row: { x: 1 } },
    });
    sockets[0]!.receive({
      v: 5,
      t: "event",
      id: subscription.id,
      event: {
        kind: "row",
        cursor: { generation: "events-1", commitVersion: 3n, sequence: 3n },
        row: { x: 3 },
      },
    });
    sockets[0]!.receive({
      v: 5,
      t: "event",
      id: subscription.id,
      event: {
        kind: "reset",
        cursor: { generation: "events-2", commitVersion: 3n, sequence: 0n },
      },
    });
    expect(events.map((event) => event.kind)).toEqual(["row", "gap", "reset"]);

    sockets[0]!.close();
    clock.advance(100);
    sockets[1]!.welcome(client.clientSessionId);
    expect(sockets[1]!.lastFrame("sub").cursor).toBeUndefined();
    client.close();
  });

  test("releases an event subscription exactly once across repeated unsubscribe and close", () => {
    const { client, sockets } = createHarness();
    const events: AckerDBLiveEvent<{ x: number }>[] = [];
    const unsubscribe = client.subscribeEvent<Record<never, never>, { x: number }>(
      "api.events.cursor",
      {},
      (event) => events.push(event),
    );
    sockets[0]!.welcome(client.clientSessionId);
    const id = sockets[0]!.lastFrame("sub").id;
    unsubscribe();
    unsubscribe();
    expect(
      sockets[0]!.frames().filter((frame) => frame.t === "unsub"),
    ).toEqual([{ v: 5, t: "unsub", id }]);
    sockets[0]!.receive({
      v: 5,
      t: "event",
      id,
      event: { kind: "reset", cursor: { generation: "g", commitVersion: 0n, sequence: 0n } },
    });
    expect(events).toHaveLength(0);

    // close() releases surviving subscriptions itself; a hook cleanup running
    // afterwards must find nothing left to release and send nothing.
    const second = createHarness();
    const release = second.client.subscribeEvent("api.events.cursor", {}, () => {});
    second.sockets[0]!.welcome(second.client.clientSessionId);
    second.client.close();
    expect(() => release()).not.toThrow();
    expect(
      second.sockets[0]!.frames().filter((frame) => frame.t === "unsub"),
    ).toHaveLength(0);
  });

  test("uses the authenticated session for strict procedure envelopes", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "session-token" } satisfies Credential,
      fetch: async () => {
        fetches++;
        throw new Error("unary procedures must not use HTTP");
      },
    });

    const stats = dispatchProcedure<{}, { count: number }>(client, sockets, "api.todos.stats", {});
    expect(stats.socket.lastFrame("hello").credential).toEqual({
      kind: "bearer",
      token: "session-token",
    });
    stats.socket.receive({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: stats.request.id,
      kind: "procedure",
      value: { count: 2 },
    });
    expect(mustOk(await stats.completion)).toEqual({ count: 2 });

    const denied = dispatchProcedure(client, sockets, "api.todos.denied", {});
    denied.socket.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: denied.request.id,
      outcome: { code: "unauthorized", retryable: false, message: "denied" },
    });
    expect(mustErr(await denied.completion)).toMatchObject({
      code: "unauthorized",
      message: "denied",
    });

    type Missing = ApplicationError<"todo.not-found", { readonly id: bigint }, 404>;
    const missing = dispatchProcedure<Record<never, never>, never>(
      client,
      sockets,
      "api.todos.missing",
      {},
    );
    missing.socket.receive({
      v: PROTOCOL_VERSION,
      t: "app_err",
      id: missing.request.id,
      kind: "procedure",
      error: {
        kind: "application",
        code: "todo.not-found",
        body: { id: 9n },
        status: 404,
      },
    });
    const missingResult = await missing.completion as ClientResult<never, Missing>;
    if (missingResult.ok) throw new Error("expected the procedure to fail");
    expect(missingResult.error).toEqual({
      kind: "application",
      code: "todo.not-found",
      body: { id: 9n },
      status: 404,
    });
    expect(fetches).toBe(0);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  test("cancels an in-flight procedure on caller abort or deadline without replaying it", async () => {
    for (const mode of ["abort", "timeout"] as const) {
      const abort = new AbortController();
      const { client, clock, sockets } = createHarness({
        limits: { maxPendingItems: 1, maxQueryAgeMs: 50 },
      });
      const dispatched = dispatchProcedure(
        client,
        sockets,
        "api.procedure.in-flight",
        {},
        { signal: abort.signal },
      );
      const completion = dispatched.completion.then(mustErr);

      if (mode === "abort") abort.abort();
      else clock.advance(50);
      await settlesPromptly(completion, `${mode} procedure response interruption`);
      expect(await completion).toMatchObject({ code: "indeterminate", resource: "operation" });
      expect(dispatched.socket.lastFrame("cancel")).toEqual({
        v: PROTOCOL_VERSION,
        t: "cancel",
        id: dispatched.request.id,
      });

      dispatched.socket.receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: dispatched.request.id,
        kind: "procedure",
        value: "late",
      });
      expect(
        await completeProcedure(client, sockets, "api.procedure.after-interruption", "available"),
      ).toBe("available");
      client.close();
    }
  });

  test("never dispatches an unsent canceled procedure after reconnect", async () => {
    const abort = new AbortController();
    const { client, clock, sockets } = createHarness();
    const completion = client.procedure(
      "api.procedure.before-welcome",
      {},
      { signal: abort.signal },
    ).then(mustErr);
    const first = sockets[0]!;
    first.open();
    expect(first.frames().some((frame) => frame.t === "p")).toBe(false);

    first.close();
    abort.abort();
    expect(await completion).toMatchObject({
      code: "unavailable",
      resource: "operation",
    });

    clock.advance(100);
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(second.frames().some((frame) => frame.t === "p")).toBe(false);
    client.close();
  });

  test("acknowledges a chunk only after iteration resumes and before yielding the next chunk", async () => {
    const acknowledgmentGate = deferred<Response>();
    const acknowledgments: SseAckRequest[] = [];
    const acknowledgmentAuthorizations: Array<string | null> = [];
    const acknowledgmentContentTypes: Array<string | null> = [];
    let streamAuthorization: string | null = null;
    let streamUrl: string | undefined;
    let streamBody: unknown;
    const fetcher: AckerDBClientOptions["fetch"] = async (url, init) => {
      if (isSseCall(url)) {
        streamAuthorization = new Headers(init?.headers).get("authorization");
        streamUrl = url;
        streamBody = decode(String(init?.body));
        return sseResponse([
          { v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: { delta: "a" } },
          { v: 5, t: "sse_chunk", seq: 2, proof: "proof-2", value: { delta: "b" } },
        ]);
      }
      expect(url.endsWith(SSE_ACK_PATH)).toBe(true);
      const headers = new Headers(init?.headers);
      acknowledgmentAuthorizations.push(headers.get("authorization"));
      acknowledgmentContentTypes.push(headers.get("content-type"));
      acknowledgments.push(parseSseAckRequest(decode(String(init?.body))));
      return acknowledgmentGate.promise;
    };
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "receiver-token" },
      fetch: fetcher,
    });
    const iterator = client.sse<{ topic: string }, { delta: string }>("api.stream.ordered", {
      topic: "weather",
    })[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: { delta: "a" }, done: false });
    // The address is the path and the body is the args object alone.
    expect(streamUrl).toBe(`http://ackerdb.test${ssePath("api.stream.ordered")}`);
    expect(streamBody).toEqual({ topic: "weather" });
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
      { v: 5, t: "sse_ack", stream: "stream-1", seq: 1, proof: "proof-1" },
    ]);
    expect(streamAuthorization as string | null).toBe("Bearer receiver-token");
    expect(acknowledgmentAuthorizations).toEqual([null]);
    expect(acknowledgmentContentTypes).toEqual(["text/plain;charset=UTF-8"]);

    acknowledgmentGate.resolve(new Response(null, { status: 204 }));
    expect(await second).toEqual({ value: { delta: "b" }, done: false });
    await iterator.return(undefined);
    expect(acknowledgments).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  test("retries network and retryable overload acknowledgments with full jitter and Retry-After", async () => {
    const acknowledgments: SseAckRequest[] = [];
    const acknowledgmentAuthorizations: Array<string | null> = [];
    const acknowledgmentContentTypes: Array<string | null> = [];
    let streamAuthorization: string | null = null;
    let firstSequenceAttempts = 0;
    const randomValues = [0.5, 0];
    const fetcher: AckerDBClientOptions["fetch"] = async (url, init) => {
      if (isSseCall(url)) {
        streamAuthorization = new Headers(init?.headers).get("authorization");
        return sseResponse([
          { v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" },
          { v: 5, t: "sse_done", seq: 2, proof: "proof-2" },
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
              v: 5,
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
    const { client, clock, sockets } = createHarness({
      credential: { kind: "bearer", token: "old-token" },
      fetch: fetcher,
      random: () => randomValues.shift() ?? 0,
      limits: { maxSseAckAgeMs: 5_000 },
    });
    const iterator = client.sse<{}, string>("api.stream.retry", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    const completion = iterator.next();
    await eventually(
      () => acknowledgments.length === 1 && clock.nextDueIn() === 50,
      "the first jitter delay",
    );
    const refresh = client.refreshCredential({ kind: "bearer", token: "current-token" });
    // The dialed hello presents the refreshed credential, so the welcome
    // resolves the attempt without a separate auth round-trip.
    sockets[0]!.welcome(client.clientSessionId, USER_AUTHENTICATION);
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
        frame: { v: 5, t: "sse_done", seq: 1, proof: "done-proof" },
      },
      {
        name: "error",
        frame: {
          v: 5,
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
      const { client, sockets } = createHarness({
        fetch: async (url, init) => {
          if (isSseCall(url)) return sseResponse([terminal.frame]);
          acknowledgments.push(parseSseAckRequest(decode(String(init?.body))));
          return acknowledgmentGate.promise;
        },
      });
      const iterator = client.sse(`api.stream.${terminal.name}`, {})[Symbol.asyncIterator]();
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
          sseResponse([{ v: 5, t: "sse_done", seq: 1, proof: "proof" }], {
            stream: null,
            close: false,
            onCancel,
          }),
      },
      {
        name: "oversized stream header",
        response: (onCancel) =>
          sseResponse([{ v: 5, t: "sse_done", seq: 1, proof: "proof" }], {
            stream: "x".repeat(129),
            close: false,
            onCancel,
          }),
      },
      {
        name: "missing stall header",
        response: (onCancel) =>
          sseResponse([{ v: 5, t: "sse_done", seq: 1, proof: "proof" }], {
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
          sseResponse([{ v: 5, t: "sse_done", seq: 2, proof: "proof-2" }], {
            close: false,
            onCancel,
          }),
      },
      {
        name: "empty proof",
        response: (onCancel) =>
          sseResponse([{ v: 5, t: "sse_done", seq: 1, proof: "" }], {
            close: false,
            onCancel,
          }),
      },
      {
        name: "unexpected successful status",
        response: (onCancel) =>
          sseResponse([{ v: 5, t: "sse_done", seq: 1, proof: "proof" }], {
            status: 201,
            close: false,
            onCancel,
          }),
      },
    ];

    for (const malformedCase of malformedCases) {
      let cancellations = 0;
      const { client, sockets } = createHarness({
        fetch: async () => malformedCase.response(() => cancellations++),
      });
      const iterator = client.sse(`api.stream.${malformedCase.name}`, {})[Symbol.asyncIterator]();
      expect(await iterator.next().catch((error) => error)).toMatchObject({
        code: "malformed",
        resource: "sse",
      });
      expect(cancellations).toBe(1);
      client.close();
    }
  });

  test("surfaces a refused stream's bare outcome and rejects a body that is not one", async () => {
    const outcome = {
      code: "unauthenticated",
      retryable: false,
      message: "authentication required",
      resource: "sse",
    } as const;
    const refused = createHarness({
      fetch: async () => new Response(encode(outcome), { status: 401 }),
    });
    expect(
      await refused.client.sse("api.stream.refused", {})[Symbol.asyncIterator]()
        .next().catch((error) => error),
    ).toMatchObject(outcome);
    refused.client.close();

    // The exposed surface never answers a frame, so one is not an outcome.
    const framed = createHarness({
      fetch: async () => new Response(
        encode({ v: 4, t: "err", id: null, outcome }),
        { status: 401 },
      ),
    });
    expect(
      await framed.client.sse("api.stream.framed", {})[Symbol.asyncIterator]()
        .next().catch((error) => error),
    ).toMatchObject({ code: "malformed", resource: "sse" });
    framed.client.close();
  });

  test("streams from the root of the group its reference was taken from", async () => {
    let streamUrl = "";
    const { client } = createHarness({
      fetch: async (url) => {
        streamUrl = url;
        return sseResponse([{ v: 5, t: "sse_chunk", seq: 1, proof: "p-1", value: "chunk" }]);
      },
    });
    // A generated binding seeds the address with its group, so the URL is the
    // address and the client needs nothing beside it.
    const ref = apiGroup("internal").ops.tail as SseRef<Record<string, never>, string>;
    await client.sse(ref, {})[Symbol.asyncIterator]().next();
    expect(streamUrl).toBe(`http://ackerdb.test${ssePath("internal.ops.tail")}`);

    // A hand-written address is the same one value, group segment included.
    await client.sse("api.ops.tail", {})[Symbol.asyncIterator]().next();
    expect(streamUrl).toBe(`http://ackerdb.test${ssePath("api.ops.tail")}`);
    client.close();
  });

  test("requires an exact 204 acknowledgment response", async () => {
    let cancellations = 0;
    const { client } = createHarness({
      fetch: async (url) =>
        isSseCall(url)
          ? sseResponse(
              [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
              { close: false, onCancel: () => cancellations++ },
            )
          : new Response("", { status: 200 }),
    });
    const iterator = client.sse<{}, string>("api.stream.bad-ack", {})[Symbol.asyncIterator]();

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
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(sseUtf8.encode("not empty"));
          },
          cancel() {
            acknowledgmentCancellations++;
            return adversarialCancellation(behavior);
          },
        }),
        headers: new Headers(),
      } as unknown as Response;
      const { client, sockets } = createHarness({
        limits: { maxPendingItems: 1 },
        fetch: async (url, init) => {
          if (isSseCall(url)) {
            return sseResponse(
              [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
              { close: false, onCancel: () => streamCancellations++ },
            );
          }
          if (url.endsWith("/_sse/ack")) return fake204;
          throw new Error(`unexpected HTTP route ${url}`);
        },
      });
      const iterator = client.sse<{}, string>(`api.stream.body-204.${behavior}`, {})[
        Symbol.asyncIterator
      ]();

      expect(await iterator.next()).toEqual({ value: "chunk", done: false });
      const completion = iterator.next().catch((error) => error);
      await settlesPromptly(completion, `${behavior} body-bearing 204 rejection`);
      expect(await completion).toMatchObject({ code: "malformed", resource: "sse" });
      expect(acknowledgmentCancellations).toBe(1);
      expect(streamCancellations).toBe(1);
      expect(await completeProcedure(client, sockets, "api.procedure.after-body-204", "available")).toBe("available");
      client.close();
    }
  });

  test("bounds the SSE parser before decoding a frame", async () => {
    let cancellations = 0;
    const { client } = createHarness({
      fetch: async () => sseResponse("x".repeat(257), {
        close: false,
        onCancel: () => cancellations++,
      }),
      limits: { maxSseBufferBytes: 256 },
    });

    const error = await client.sse("api.stream.large", {})[Symbol.asyncIterator]().next().catch((caught) => caught);
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
          "x-ackerdb-sse-stream": "stream-1",
          "x-ackerdb-sse-max-stall-ms": "5000",
        },
      },
    );
    const { client } = createHarness({
      limits: { maxSseBufferBytes: maxBufferBytes },
      fetch: async () => response,
    });

    expect(await client.sse("api.stream.bytewise", {})[Symbol.asyncIterator]().next().catch((error) => error))
      .toMatchObject({ code: "overloaded", resource: "sse" });
    expect(pulls).toBe(prefix.byteLength + maxBufferBytes + 1);
    expect(cancellations).toBe(1);
    client.close();
  });

  test("never yields a synchronously enqueued SSE frame after its read aborts", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      const abort = new AbortController();
      const bytes = sseUtf8.encode(sseEvent({
        v: 5,
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
            "x-ackerdb-sse-stream": "stream-1",
            "x-ackerdb-sse-max-stall-ms": "5000",
          },
        },
      );
      const { client, sockets } = createHarness({
        fetch: async (url) => {
          if (isSseCall(url)) return response;
          acknowledgments++;
          return new Response(null, { status: 204 });
        },
      });
      const completion = client.sse("api.stream.sync-abort", {}, { signal: abort.signal })[
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
      const { client, sockets } = createHarness({
        limits: { maxPendingItems: 1 },
        fetch: async (url, init) => {
          if (isSseCall(url)) return response;
          throw new Error(`unexpected HTTP route ${url}`);
        },
      });
      const completion = client.sse("api.stream.open-error", {}, { signal: abort.signal })[
        Symbol.asyncIterator
      ]().next().catch((error) => error);
      await eventually(() => pulls === 1, `${behavior} open error response read`);

      abort.abort();
      await settlesPromptly(completion, `${behavior} open error response abort`);
      expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
      expect(cancellations).toBe(1);
      expect(await completeProcedure(client, sockets, "api.procedure.after-open-error", "available")).toBe("available");
      client.close();
    }
  });

  test("skips the SSE fetch when its signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    let streamFetches = 0;
    const { client, clock, sockets } = createHarness({
      limits: { maxPendingItems: 1, maxQueryAgeMs: 1 },
      fetch: async (url, init) => {
        if (isSseCall(url)) {
          streamFetches++;
          return sseResponse([], { close: false });
        }
        throw new Error(`unexpected HTTP route ${url}`);
      },
    });
    const occupied = client.query("query.occupies-capacity", {}).then(mustErr);
    const completion = client.sse("api.stream.pre-aborted", {}, { signal: abort.signal })[
      Symbol.asyncIterator
    ]().next().catch((error) => error);

    await settlesPromptly(completion, "pre-aborted SSE completion");
    expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
    expect(streamFetches).toBe(0);
    clock.advance(1);
    expect(await occupied).toMatchObject({ code: "deadline_exceeded" });
    expect(await completeProcedure(client, sockets, "api.procedure.after-pre-abort", "available")).toBe("available");
    client.close();
  });

  test("aborts a hanging SSE fetch and cancels its late response exactly once", async () => {
    const abort = new AbortController();
    const hanging = deferred<Response>();
    const neverSettles = new Promise<void>(() => {});
    let streamFetches = 0;
    let lateCancellations = 0;
    const { client, sockets } = createHarness({
      limits: { maxPendingItems: 1 },
      fetch: async (url, init) => {
        if (isSseCall(url)) {
          streamFetches++;
          return hanging.promise;
        }
        throw new Error(`unexpected HTTP route ${url}`);
      },
    });
    const completion = client.sse("api.stream.hanging-abort", {}, { signal: abort.signal })[
      Symbol.asyncIterator
    ]().next().catch((error) => error);
    await eventually(() => streamFetches === 1, "the hanging SSE fetch");

    abort.abort();
    await settlesPromptly(completion, "aborted hanging SSE fetch");
    expect(await completion).toMatchObject({ code: "unavailable", resource: "sse" });
    expect(await completeProcedure(client, sockets, "api.procedure.after-hanging-abort", "available")).toBe("available");

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
    const { client } = createHarness({
      limits: { maxPendingItems: 1 },
      fetch: async (url) => {
        if (isSseCall(url)) {
          streamFetches++;
          return hanging.promise;
        }
        throw new Error("closed client unexpectedly fetched another operation");
      },
    });
    process.on("unhandledRejection", onUnhandled);
    try {
      const completion = client.sse("api.stream.hanging-close", {})[
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
        const { client, sockets } = createHarness({
          limits: { maxPendingItems: 1 },
          fetch: async (url, init) => {
            if (isSseCall(url)) {
              return sseResponse(
                [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: mode }],
                {
                  close: false,
                  onCancel: () => {
                    cancellations++;
                    return adversarialCancellation(behavior);
                  },
                },
              );
            }
            if (url.endsWith("/_sse/ack")) {
              acknowledgments++;
              return new Response(null, { status: 204 });
            }
            throw new Error(`unexpected HTTP route ${url}`);
          },
        });
        const iterator = client.sse<{}, string>(`api.stream.${behavior}.${mode}`, {}, {
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
          expect(await completeProcedure(client, sockets, "api.procedure.after-sse", "available")).toBe("available");
        }
        client.close();
      }
    }
  });

  test("external abort releases suspended SSE ownership without waiting for iterator return", async () => {
    let acknowledgments = 0;
    let cancellations = 0;
    const abort = new AbortController();
    const { client, sockets } = createHarness({
      limits: { maxPendingItems: 1 },
      fetch: async (url, init) => {
        if (isSseCall(url)) {
          return sseResponse(
            [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
            { close: false, onCancel: () => cancellations++ },
          );
        }
        if (url.endsWith("/_sse/ack")) {
          acknowledgments++;
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected HTTP route ${url}`);
      },
    });
    const iterator = client.sse<{}, string>("api.stream.abort-owner", {}, {
      signal: abort.signal,
    })[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    abort.abort();
    await eventually(() => cancellations === 1, "suspended SSE cleanup");
    expect(await completeProcedure(client, sockets, "api.procedure.after-abort", "available")).toBe("available");
    expect(cancellations).toBe(1);
    expect(acknowledgments).toBe(0);
    client.close();
  });

  test("rejects an oversized procedure before transport ownership", async () => {
    const { client, sockets } = createHarness({
      limits: { maxFrameBytes: 256, maxPendingItems: 1 },
    });
    const oversized = client
      .procedure("api.procedure.oversized", { value: "x".repeat(257) })
      .then(mustErr);

    await settlesPromptly(oversized, "oversized procedure rejection");
    expect(await oversized).toMatchObject({ code: "overloaded", resource: "operation" });
    expect(sockets).toHaveLength(1);
    expect(await completeProcedure(client, sockets, "api.procedure.after-oversized", "available")).toBe("available");
    client.close();
  });

  test("does not await rejecting or never-settling oversized ACK cancellation", async () => {
    for (const behavior of ["pending", "reject"] as const) {
      let acknowledgmentCancellations = 0;
      let streamCancellations = 0;
      const { client, sockets } = createHarness({
        limits: { maxFrameBytes: 256, maxPendingItems: 1 },
        fetch: async (url, init) => {
          if (isSseCall(url)) {
            return sseResponse(
              [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
              { close: false, onCancel: () => streamCancellations++ },
            );
          }
          if (url.endsWith("/_sse/ack")) {
            return openResponse("x".repeat(257), () => {
              acknowledgmentCancellations++;
              return adversarialCancellation(behavior);
            });
          }
          throw new Error(`unexpected HTTP route ${url}`);
        },
      });
      const iterator = client.sse<{}, string>(`api.stream.oversized-ack.${behavior}`, {})[
        Symbol.asyncIterator
      ]();

      expect(await iterator.next()).toEqual({ value: "chunk", done: false });
      const completion = iterator.next().catch((error) => error);
      await settlesPromptly(completion, `${behavior} oversized ACK cancellation`);
      expect(await completion).toMatchObject({ code: "overloaded", resource: "sse" });
      expect(acknowledgmentCancellations).toBe(1);
      expect(streamCancellations).toBe(1);
      expect(await completeProcedure(client, sockets, "api.procedure.after-ack", "available")).toBe("available");
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
        const { client, clock, sockets } = createHarness({
          limits: { maxPendingItems: 1, maxSseAckAgeMs: 50 },
          fetch: async (url, init) => {
            if (isSseCall(url)) {
              return sseResponse(
                [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
                {
                  stallMs: "100",
                  close: false,
                  onCancel: () => streamCancellations++,
                },
              );
            }
            if (url.endsWith("/_sse/ack")) {
              acknowledgmentAttempts++;
              return open503;
            }
            throw new Error(`unexpected HTTP route ${url}`);
          },
        });
        const iterator = client.sse<{}, string>(`api.stream.open-ack.${behavior}.${mode}`, {}, {
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
        expect(await completeProcedure(client, sockets, "api.procedure.after-open-ack", "available")).toBe("available");
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
        const { client, clock, sockets } = createHarness({
          limits: { maxPendingItems: 1, maxSseAckAgeMs: 50 },
          fetch: async (url, init) => {
            if (isSseCall(url)) {
              return sseResponse(
                [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
                { stallMs: "100", close: false },
              );
            }
            if (url.endsWith("/_sse/ack")) {
              acknowledgmentAttempts++;
              return late.promise;
            }
            throw new Error(`unexpected HTTP route ${url}`);
          },
        });
        const iterator = client.sse<{}, string>(`api.stream.late-ack.${behavior}.${mode}`, {}, {
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
        expect(await completeProcedure(client, sockets, "api.procedure.after-late-ack", "available")).toBe("available");

        late.resolve(openResponse(
          encode({
            v: 5,
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
    const { client, clock } = createHarness({
      fetch: async (url, init) => {
        if (isSseCall(url)) {
          return sseResponse(
            [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
            { stallMs: "100", close: false },
          );
        }
        attempts++;
        acknowledgmentSignal = init?.signal ?? undefined;
        return hanging;
      },
      limits: { maxSseAckAgeMs: 50 },
    });
    const iterator = client.sse<{}, string>("api.stream.deadline", {})[Symbol.asyncIterator]();

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
    const { client } = createHarness({
      fetch: async (url) => {
        if (isSseCall(url)) {
          return sseResponse(
            [{ v: 5, t: "sse_chunk", seq: 1, proof: "proof-1", value: "chunk" }],
            { close: false },
          );
        }
        attempts++;
        throw new TypeError("network unavailable");
      },
    });
    const iterator = client.sse<{}, string>("api.stream.retry-limit", {})[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "chunk", done: false });
    expect(await iterator.next().catch((error) => error)).toMatchObject({
      code: "deadline_exceeded",
      resource: "sse",
    });
    expect(attempts).toBe(8);
    client.close();
  });

  test("skips procedure transport ownership when its signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const { client, sockets } = createHarness();
    const completion = client
      .procedure("api.procedure.pre-aborted", {}, { signal: abort.signal })
      .then(mustErr);

    await settlesPromptly(completion, "pre-aborted procedure completion");
    expect(await completion).toMatchObject({ code: "unavailable", resource: "operation" });
    expect(sockets).toHaveLength(1);
    expect(await completeProcedure(client, sockets, "api.procedure.after-pre-abort", "available")).toBe("available");
    client.close();
  });

  test("settles an unanswered session procedure on abort and close", async () => {
    for (const shutdown of ["abort", "close"] as const) {
      const abort = new AbortController();
      const { client, sockets } = createHarness();
      const dispatched = dispatchProcedure(
        client,
        sockets,
        "api.procedure.unanswered",
        {},
        { signal: abort.signal },
      );
      const completion = dispatched.completion.then(mustErr);

      if (shutdown === "abort") abort.abort();
      else client.close();
      await settlesPromptly(completion, `${shutdown} of an unanswered session procedure`);
      expect(await completion).toMatchObject({ code: "indeterminate", resource: "operation" });
      if (shutdown === "abort") {
        expect(dispatched.socket.lastFrame("cancel").id).toBe(dispatched.request.id);
      }
      client.close();
    }
  });
});

describe("AckerDBClient connection state", () => {
  test("starts atomically and publishes connecting, ready, reconnecting, and closed with stable snapshots", () => {
    const { client, clock, sockets } = createHarness();
    const phases: string[] = [];
    const unsubscribe = client.subscribeConnectionState((state) => phases.push(state.phase));

    const initial = client.currentConnectionState;
    expect(initial).toEqual({ phase: "connecting" });
    expect(client.currentConnectionState).toBe(initial);

    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState).toBe(initial);
    expect(sockets).toHaveLength(1);

    sockets[0]!.welcome(client.clientSessionId);
    const ready = client.currentConnectionState;
    expect(ready).toEqual({
      phase: "ready",
      authentication: { authEpoch: 0, principal: "anonymous" },
    });
    expect(client.currentConnectionState).toBe(ready);

    sockets[0]!.close();
    expect(client.currentConnectionState).toEqual({ phase: "reconnecting" });
    expect(sockets).toHaveLength(1);

    clock.advance(100);
    expect(sockets).toHaveLength(2);
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    sockets[1]!.welcome(client.clientSessionId);
    expect(client.currentConnectionState.phase).toBe("ready");

    client.close();
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(sockets).toHaveLength(2);
    expect(phases).toEqual(["ready", "reconnecting", "ready", "closed"]);
    unsubscribe();
  });

  test("construction establishes standing demand that survives drops without operations", () => {
    const { client, clock, sockets } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.close();
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    expect(sockets).toHaveLength(1);
    clock.advance(100);
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome(client.clientSessionId);
    expect(client.currentConnectionState.phase).toBe("ready");
    client.close();
    expect(clock.taskCount).toBe(0);
  });

  test("keeps the connecting snapshot when the first attempt drops before welcome", () => {
    const { client, sockets } = createHarness();
    const phases: string[] = [];
    client.subscribeConnectionState((state) => phases.push(state.phase));
    const initial = client.currentConnectionState;
    sockets[0]!.close();
    expect(client.currentConnectionState).toBe(initial);
    expect(phases).toEqual([]);
    client.close();
    expect(phases).toEqual(["closed"]);
  });

  test("reports authentication-blocked with the exact error and recovers through refreshCredential", async () => {
    const { client, sockets } = createHarness();
    const states: AckerDBConnectionState[] = [];
    client.subscribeConnectionState((state) => states.push(state));
    sockets[0]!.welcome(client.clientSessionId);

    const blocking = new AckerDBClientError({
      code: "unauthenticated",
      retryable: false,
      message: "credential expired",
    });
    sockets[0]!.receive({
      v: 5,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    const blocked = client.currentConnectionState;
    if (blocked.phase !== "authentication-blocked") throw new Error(`unexpected ${blocked.phase}`);
    expect(blocked.error).toBeInstanceOf(AckerDBClientError);
    expect(blocked.error.code).toBe(blocking.code);
    expect(client.currentConnectionState).toBe(blocked);

    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    const second = sockets[1]!;
    second.open();
    expect(second.lastFrame("hello").credential).toEqual({ kind: "bearer", token: "token-b" });
    second.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    // The hello presented the refreshed credential, so this welcome is its
    // verification: the attempt resolves without a second auth round-trip.
    expect(second.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await refresh).toEqual({ authEpoch: 1, ...USER_AUTHENTICATION });
    const upgraded = client.currentConnectionState;
    if (upgraded.phase !== "ready") throw new Error(`unexpected ${upgraded.phase}`);
    expect(upgraded.authentication).toEqual({ authEpoch: 1, ...USER_AUTHENTICATION });
    expect(states.map((state) => state.phase)).toEqual([
      "ready",
      "authentication-blocked",
      "reconnecting",
      "ready",
    ]);
    client.close();
  });

  test("reports terminal-error with the failure that stopped the client", () => {
    const { client, sockets } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.receiveRaw("not json");
    const terminal = client.currentConnectionState;
    if (terminal.phase !== "terminal-error") throw new Error(`unexpected ${terminal.phase}`);
    expect(terminal.error).toBeInstanceOf(AckerDBClientError);
    expect(terminal.error.code).toBe("malformed");
    expect(client.currentConnectionState).toBe(terminal);
    client.close();
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
  });

  test("a ready listener that reenters close releases every timer", () => {
    const { client, clock, sockets } = createHarness();
    client.subscribeConnectionState((state) => {
      if (state.phase === "ready") client.close();
    });
    sockets[0]!.welcome(client.clientSessionId);
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(clock.taskCount).toBe(0);
    expect(sockets[0]!.closes).toHaveLength(1);
  });

  test("a recovery listener that reenters close releases the authentication attempt", async () => {
    const { client, clock, sockets } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.receive({
      v: 5,
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
    expect(await refresh).toBeInstanceOf(AckerDBClientError);
  });

  test("a nested close during notification never delivers stale state", () => {
    const { client, clock, sockets } = createHarness();
    const observed: string[] = [];
    client.subscribeConnectionState((state) => {
      if (state.phase === "ready") client.close();
    });
    client.subscribeConnectionState((state) => observed.push(state.phase));
    sockets[0]!.welcome(client.clientSessionId);
    expect(observed).toEqual(["closed"]);
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(clock.taskCount).toBe(0);
  });

  test("close notifies once and later subscriptions stay silent", () => {
    const { client } = createHarness();
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
    const { client, clock, sockets } = createHarness();
    const updates: unknown[] = [];
    let confirmations = 0;
    client.subscribe(
      "api.todos.list",
      { list: 1n },
      (value) => updates.push(value),
      undefined,
      { onCursorConfirmed: () => confirmations++ },
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);

    // Value deliveries keep flowing through onUpdate alone.
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: ["one"] },
    });
    expect(updates).toEqual([["one"]]);
    expect(confirmations).toBe(0);

    // A checkpoint silently advances the cursor and confirms the held value.
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "checkpoint", from: c1, to: c2 },
    });
    expect(confirmations).toBe(1);
    expect(updates).toEqual([["one"]]);

    // Reconnect resumes from the retained cursor; the server's positive
    // resume lands exactly on the held cursor and confirms it.
    first.close();
    clock.advance(100);
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(second.lastFrame("sub").cursor).toEqual(c2);
    second.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "resume", from: c2, to: c2 },
    });
    expect(confirmations).toBe(2);
    expect(updates).toEqual([["one"]]);
    client.close();
  });

  test("withholds held-cursor confirmation while a reset is demanded", () => {
    const { client, sockets } = createHarness();
    const updates: unknown[] = [];
    let confirmations = 0;
    client.subscribe(
      "api.todos.list",
      { list: 1n },
      (value) => updates.push(value),
      undefined,
      { onCursorConfirmed: () => confirmations++ },
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    const c0 = cursor(0n);
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    const c3 = cursor(3n);

    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c1, value: ["one"] },
    });

    // A mismatched predecessor makes the client demand a reset; deliveries
    // landing on the held cursor are no longer trusted as confirmations.
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "update", from: c2, to: c3, value: ["three-untrusted"] },
    });
    expect(first.lastFrame("reset")).toEqual({ v: 5, t: "reset", id: subscription.id, cursor: c1 });
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "update", from: c0, to: c1, value: ["one-too-late"] },
    });
    expect(confirmations).toBe(0);

    // The authoritative reset delivers through onUpdate; a duplicate of it
    // landing on the now-held cursor confirms again.
    first.receive({
      v: 5,
      t: "transition",
      id: subscription.id,
      transition: { kind: "reset", from: null, to: c3, value: ["three-authoritative"] },
    });
    expect(updates).toEqual([["one"], ["three-authoritative"]]);
    expect(confirmations).toBe(0);
    first.receive({
      v: 5,
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
    const { client } = createHarness();
    try {
      client.subscribe("api.todos.byScore", { score: Number.NaN }, () => {});
      throw new Error("subscribe must reject NaN arguments");
    } catch (error) {
      expect(error).toBeInstanceOf(AckerDBClientError);
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

describe("AckerDBClient close-time mutation settlement", () => {
  test("close settles sent mutations as indeterminate and unsent mutations as unavailable", async () => {
    const { client, sockets } = createHarness();
    const sent = client.mutation("api.todos.add", { text: "sent" }).then(mustErr);
    sockets[0]!.welcome(client.clientSessionId);
    expect(sockets[0]!.lastFrame("m").args).toEqual({ text: "sent" });

    // Written to a connection that dropped: the server may have committed.
    sockets[0]!.close();
    // Created while disconnected: provably never reached the server.
    const unsent = client.mutation("api.todos.add", { text: "unsent" }).then(mustErr);

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

describe("AckerDBClient authentication state", () => {
  test("publishes authenticating, unauthenticated, and closed with stable snapshots", () => {
    const { client, sockets } = createHarness();
    const phases: string[] = [];
    const unsubscribe = client.subscribeAuthenticationState((state) => phases.push(state.phase));

    const initial = client.currentAuthenticationState;
    expect(initial).toEqual({ phase: "authenticating", credential: "anonymous" });
    expect(client.currentAuthenticationState).toBe(initial);

    expect(client.currentAuthenticationState).toBe(initial);

    sockets[0]!.welcome(client.clientSessionId);
    const confirmed = client.currentAuthenticationState;
    expect(confirmed).toEqual({
      phase: "unauthenticated",
      authentication: { authEpoch: 0, principal: "anonymous" },
    });
    expect(client.currentAuthenticationState).toBe(confirmed);
    // Both surfaces publish from one transition and share the confirmation.
    const ready = client.currentConnectionState;
    if (
      ready.phase !== "ready" ||
      ready.authentication.principal !== "anonymous" ||
      confirmed.phase !== "unauthenticated"
    ) {
      throw new Error("expected a confirmed anonymous session");
    }
    expect(confirmed.authentication).toBe(ready.authentication);

    // A reconnect re-presents the stored credential before any confirmation.
    sockets[0]!.close();
    expect(client.currentAuthenticationState).toBe(initial);

    client.close();
    expect(client.currentAuthenticationState).toEqual({ phase: "closed" });
    expect(phases).toEqual(["unauthenticated", "authenticating", "closed"]);
    unsubscribe();
  });

  test("confirms a bearer connection as authenticated with the welcome principal", () => {
    const { client, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "bearer",
    });
    sockets[0]!.open();
    sockets[0]!.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 4,
      ...USER_AUTHENTICATION,
    });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticated",
      authentication: { authEpoch: 4, ...USER_AUTHENTICATION },
    });
    client.close();
  });

  test("replaces provenance atomically while preserving durable Identity", async () => {
    const { client, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    sockets[0]!.welcome(client.clientSessionId, USER_AUTHENTICATION);
    const before = client.currentAuthentication;
    expect(before).toEqual({ authEpoch: 0, ...USER_AUTHENTICATION });

    const refresh = client.refreshCredential({ kind: "bearer", token: "token-refreshed" });
    const attempt = sockets[0]!.lastFrame("auth");
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: 1,
      ...REFRESHED_USER_AUTHENTICATION,
    });

    const after = await refresh;
    expect(after).toEqual({ authEpoch: 1, ...REFRESHED_USER_AUTHENTICATION });
    if (after.principal !== "user") throw new Error(`unexpected ${after.principal}`);
    expect(before).toEqual({ authEpoch: 0, ...USER_AUTHENTICATION });
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.provenance)).toBe(true);
    const ready = client.currentConnectionState;
    if (ready.phase !== "ready") throw new Error(`unexpected ${ready.phase}`);
    const authenticationState = client.currentAuthenticationState;
    if (authenticationState.phase !== "authenticated") {
      throw new Error(`unexpected ${authenticationState.phase}`);
    }
    expect(ready.authentication).toBe(authenticationState.authentication);
    client.close();
  });

  test("tracks refresh and sign-out through the pending credential kind", async () => {
    const { client, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    const states: AckerDBAuthenticationState[] = [];
    client.subscribeAuthenticationState((state) => states.push(state));
    sockets[0]!.welcome(client.clientSessionId, USER_AUTHENTICATION);

    // An anonymous presentation on a live session is the protocol's sign-out.
    const signOut = client.refreshCredential({ kind: "anonymous" });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "anonymous",
    });
    // The transport session stays ready while the credential is re-verified;
    // only the authentication surface reports the in-flight presentation.
    expect(client.currentConnectionState.phase).toBe("ready");
    const signOutFrame = sockets[0]!.lastFrame("auth");
    expect(signOutFrame.credential).toEqual({ kind: "anonymous" });
    sockets[0]!.receive({
      v: 5,
      t: "auth",
      attemptId: signOutFrame.attemptId,
      authEpoch: 1,
      principal: "anonymous",
    });
    expect(await signOut).toEqual({ authEpoch: 1, principal: "anonymous" });
    expect(client.currentAuthenticationState).toEqual({
      phase: "unauthenticated",
      authentication: { authEpoch: 1, principal: "anonymous" },
    });

    // A superseded refresh rejects with auth_stale and the state reports the
    // newest pending credential kind until its confirmation arrives.
    const superseded = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-c" });
    expect(await superseded).toMatchObject({ code: "auth_stale" });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "bearer",
    });
    const refreshFrame = sockets[0]!.lastFrame("auth");
    expect(refreshFrame.credential).toEqual({ kind: "bearer", token: "token-c" });
    sockets[0]!.receive({
      v: 5,
      t: "auth",
      attemptId: refreshFrame.attemptId,
      authEpoch: 2,
      ...USER_AUTHENTICATION,
    });
    expect(await refresh).toEqual({ authEpoch: 2, ...USER_AUTHENTICATION });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticated",
      authentication: { authEpoch: 2, ...USER_AUTHENTICATION },
    });
    expect(states.map((state) => state.phase)).toEqual([
      "authenticated",
      "authenticating",
      "unauthenticated",
      "authenticating",
      "authenticated",
    ]);
    client.close();
  });

  test("coalesces an identical in-flight credential into a single attempt", async () => {
    const { client, sockets } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    const first = client.refreshCredential({ kind: "bearer", token: "token-b" });
    const second = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(second).toBe(first);
    expect(sockets[0]!.frames().filter((frame) => frame.t === "auth")).toHaveLength(1);
    const attempt = sockets[0]!.lastFrame("auth");
    sockets[0]!.receive({
      v: 5,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    expect(await first).toEqual({ authEpoch: 1, ...USER_AUTHENTICATION });

    // A doubled sign-out joins the in-flight attempt instead of rejecting the
    // first caller with auth_stale.
    const signOutFirst = client.refreshCredential({ kind: "anonymous" });
    const signOutSecond = client.refreshCredential({ kind: "anonymous" });
    expect(signOutSecond).toBe(signOutFirst);
    expect(sockets[0]!.frames().filter((frame) => frame.t === "auth")).toHaveLength(2);
    const signOutAttempt = sockets[0]!.lastFrame("auth");
    sockets[0]!.receive({
      v: 5,
      t: "auth",
      attemptId: signOutAttempt.attemptId,
      authEpoch: 2,
      principal: "anonymous",
    });
    expect(await signOutFirst).toEqual({ authEpoch: 2, principal: "anonymous" });
    client.close();
  });

  test("a same-value refresh between hello and welcome resolves without a second verification", async () => {
    const { client, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    const socket = sockets[0]!;
    socket.open();
    // The refresh presents the value the in-flight hello already carries; the
    // welcome verifies that value once for both.
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-a" });
    socket.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 2,
      ...USER_AUTHENTICATION,
    });
    expect(socket.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await refresh).toEqual({ authEpoch: 2, ...USER_AUTHENTICATION });
    client.close();
  });

  test("an A-B-A refresh interleaving matches the hello by value and supersedes the detour", async () => {
    const { client, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    const socket = sockets[0]!;
    socket.open();
    const detour = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);
    const back = client.refreshCredential({ kind: "bearer", token: "token-a" });
    socket.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    expect(await detour).toMatchObject({ code: "auth_stale" });
    // The surviving attempt's value is what the hello presented, so the
    // welcome resolves it without an auth frame.
    expect(socket.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await back).toEqual({ authEpoch: 1, ...USER_AUTHENTICATION });
    client.close();
  });

  test("a refresh whose auth frame exceeds the client limit rejects without installing an attempt", () => {
    const { client, clock, sockets } = createHarness({ limits: { maxFrameBytes: 256 } });
    sockets[0]!.welcome(client.clientSessionId);
    const confirmed = client.currentAuthenticationState;
    const timers = clock.taskCount;

    let caught: unknown;
    try {
      client.refreshCredential({ kind: "bearer", token: "t".repeat(300) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AckerDBClientError);
    expect(caught).toMatchObject({ code: "overloaded", resource: "connection" });
    // Nothing was installed: no attempt, no expiry timer, no state change,
    // and operations still flow on the untouched session.
    expect(clock.taskCount).toBe(timers);
    expect(client.currentAuthenticationState).toBe(confirmed);
    expect(client.currentConnectionState.phase).toBe("ready");
    const query = client.query("api.todos.list", {}).catch(() => {});
    expect(sockets[0]!.frames().some((frame) => frame.t === "q")).toBe(true);
    void query;
    client.close();
    expect(clock.taskCount).toBe(0);
  });

  test("a refresh in flight across a reconnect resolves from the replayed hello's welcome", async () => {
    const { client, clock, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    sockets[0]!.welcome(client.clientSessionId, USER_AUTHENTICATION);
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    sockets[0]!.close();
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "bearer",
    });
    clock.advance(100);
    const second = sockets[1]!;
    second.open();
    expect(second.lastFrame("hello").credential).toEqual({ kind: "bearer", token: "token-b" });
    second.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 3,
      ...USER_AUTHENTICATION,
    });
    // One verification: the hello carried the pending credential, so no
    // second auth frame follows the welcome.
    expect(second.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await refresh).toEqual({ authEpoch: 3, ...USER_AUTHENTICATION });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticated",
      authentication: { authEpoch: 3, ...USER_AUTHENTICATION },
    });
    client.close();
  });

  test("reports refresh-required with the exact error shared with the connection state", async () => {
    const { client, sockets } = createHarness({ credential: { kind: "bearer", token: "token-a" } });
    sockets[0]!.welcome(client.clientSessionId, USER_AUTHENTICATION);
    sockets[0]!.receive({
      v: 5,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    const blocked = client.currentAuthenticationState;
    if (blocked.phase !== "refresh-required") throw new Error(`unexpected ${blocked.phase}`);
    expect(blocked.error).toBeInstanceOf(AckerDBClientError);
    expect(blocked.error.code).toBe("unauthenticated");
    expect(client.currentAuthenticationState).toBe(blocked);
    const connection = client.currentConnectionState;
    if (connection.phase !== "authentication-blocked") throw new Error(`unexpected ${connection.phase}`);
    expect(connection.error).toBe(blocked.error);

    // A new credential leaves the blocked state and replays the handshake.
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "bearer",
    });
    const second = sockets[1]!;
    second.open();
    // The reconnect hello presents the refreshed credential, so its welcome
    // is the verification: one round-trip, no separate auth frame.
    second.receive({
      v: 5,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 0,
      ...USER_AUTHENTICATION,
    });
    expect(second.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await refresh).toEqual({ authEpoch: 0, ...USER_AUTHENTICATION });
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticated",
      authentication: { authEpoch: 0, ...USER_AUTHENTICATION },
    });
    client.close();
  });

  test("a refresh timeout blocks with auth_unavailable and rejects the attempt", async () => {
    const { client, clock, sockets } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);
    expect(client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "bearer",
    });
    clock.advance(30_000);
    const error = await refresh;
    expect(error).toMatchObject({ code: "auth_unavailable", message: "authentication timed out" });
    const blocked = client.currentAuthenticationState;
    if (blocked.phase !== "refresh-required") throw new Error(`unexpected ${blocked.phase}`);
    expect(blocked.error).toBe(error as AckerDBClientError);
    client.close();
  });

  test("failed mirrors the terminal connection error and close notifies once", () => {
    const { client, sockets } = createHarness();
    let notified = 0;
    client.subscribeAuthenticationState(() => notified++);
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.receiveRaw("not json");
    const failed = client.currentAuthenticationState;
    if (failed.phase !== "failed") throw new Error(`unexpected ${failed.phase}`);
    const terminal = client.currentConnectionState;
    if (terminal.phase !== "terminal-error") throw new Error(`unexpected ${terminal.phase}`);
    expect(failed.error).toBe(terminal.error);
    expect(client.currentAuthenticationState).toBe(failed);

    client.close();
    client.close();
    expect(client.currentAuthenticationState).toEqual({ phase: "closed" });
    expect(notified).toBe(3);
    let late = 0;
    const unsubscribe = client.subscribeAuthenticationState(() => late++);
    expect(late).toBe(0);
    unsubscribe();
  });

  test("an authentication listener that reenters close never observes stale state", () => {
    const { client, clock, sockets } = createHarness();
    const observed: string[] = [];
    client.subscribeAuthenticationState((state) => {
      if (state.phase === "unauthenticated") client.close();
    });
    client.subscribeAuthenticationState((state) => observed.push(state.phase));
    client.subscribeConnectionState((state) => observed.push(`connection:${state.phase}`));
    sockets[0]!.welcome(client.clientSessionId);
    expect(observed).toEqual(["closed", "connection:closed"]);
    expect(client.currentAuthenticationState).toEqual({ phase: "closed" });
    expect(client.currentConnectionState).toEqual({ phase: "closed" });
    expect(clock.taskCount).toBe(0);
  });
});
