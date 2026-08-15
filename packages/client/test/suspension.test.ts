import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACKERDB_VERSION,
  type AuthenticationDescriptor,
  type Identity,
  type ServerMessage,
  type SubscriptionCursor,
} from "@ackerdb/core";
import {
  AckerDBClient,
  AckerDBClientError,
  type AckerDBLifecyclePort,
  type AckerDBWebSocket,
} from "@ackerdb/client";
import { ManualClock } from "ackerdb-test-support/client-transport";
import { createHarness, cursor, mustErr } from "./support/harness.ts";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineTable,
  query,
  reconcile,
  serve,
} from "@ackerdb/server";
import { until, within } from "ackerdb-test-support/async";

const USER_AUTHENTICATION = {
  principal: "user",
  identity: 1n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;

function transition(
  id: number,
  to: SubscriptionCursor,
  value: unknown,
  from: SubscriptionCursor | null = null,
): ServerMessage {
  return {
    t: "transition",
    id,
    transition:
      from === null
        ? { kind: "reset", from: null, to, value }
        : { kind: "update", from, to, value },
  };
}

describe("AckerDBClient lifecycle port", () => {
  test("registers one observer per client lifetime and removes it before teardown", () => {
    const sequence: string[] = [];
    let registrations = 0;
    const { client, sockets } = createHarness({
      lifecycle: (port) => {
        registrations++;
        void port;
        return () => {
          sequence.push("observer-removed");
        };
      },
    });
    expect(registrations).toBe(1);
    const socket = sockets[0]!;
    const originalClose = socket.close.bind(socket);
    socket.close = (code?: number, reason?: string) => {
      sequence.push("socket-closed");
      originalClose(code, reason);
    };
    client.close();
    expect(sequence).toEqual(["observer-removed", "socket-closed"]);
    client.close();
    expect(sequence).toEqual(["observer-removed", "socket-closed"]);
    expect(registrations).toBe(1);
  });

  test("notifications after close are inert", () => {
    const { client, sockets, port, phases } = createHarness();
    client.close();
    const socketCount = sockets.length;
    port.suspend();
    port.resume();
    expect(sockets.length).toBe(socketCount);
    expect(client.currentConnectionState.phase).toBe("closed");
    expect(phases).toEqual(["closed"]);
  });
});

describe("AckerDBClient suspension", () => {
  test("background during ready atomically publishes suspended, retires socket and timers, and keeps logical state", () => {
    const { client, clock, sockets, port, phases } = createHarness();
    const updates: unknown[] = [];
    client.subscribe("api.todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    first.receive(transition(subscription.id, cursor(5n), ["one"]));
    expect(updates).toEqual([["one"]]);
    expect(clock.taskCount).toBe(2); // stable-open timeout + heartbeat interval

    port.suspend();
    expect(phases).toEqual(["ready", "suspended"]);
    expect(client.currentConnectionState.phase).toBe("suspended");
    expect(first.closes).toEqual([{ code: 4001, reason: "client suspended" }]);
    expect(clock.taskCount).toBe(0);

    // Duplicate background notifications coalesce.
    port.suspend();
    expect(phases).toEqual(["ready", "suspended"]);

    // The retired generation cannot deliver anything.
    first.receive(transition(subscription.id, cursor(6n), ["stale"], cursor(5n)));
    expect(updates).toEqual([["one"]]);

    // Activation redials immediately and resumes from the exact held cursor.
    port.resume();
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(phases).toEqual(["ready", "suspended", "resuming", "ready"]);
    expect(second.lastFrame("sub").cursor).toEqual(cursor(5n));
    client.close();
  });

  test("background during connecting retires the pre-open socket without scheduling reconnect", () => {
    const { client, clock, sockets, port } = createHarness();
    const first = sockets[0]!;
    expect(first.closed).toBe(false);
    port.suspend();
    expect(first.closes).toEqual([{ code: 4001, reason: "client suspended" }]);
    expect(clock.taskCount).toBe(0);
    expect(client.currentConnectionState.phase).toBe("suspended");
    port.resume();
    expect(sockets).toHaveLength(2);
    expect(client.currentConnectionState.phase).toBe("resuming");
    client.close();
  });

  test("background during subscription application resumes with a fresh cursorless subscribe", () => {
    const { client, sockets, port } = createHarness();
    const updates: unknown[] = [];
    client.subscribe("api.todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    expect(subscription.cursor).toBeUndefined();

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const resent = second.lastFrame("sub");
    expect(resent.id).toBe(subscription.id);
    expect(resent.cursor).toBeUndefined();
    second.receive(transition(subscription.id, cursor(1n), ["fresh"]));
    expect(updates).toEqual([["fresh"]]);
    client.close();
  });

  test("background pauses the credential deadline and activation re-arms the remainder", async () => {
    const { client, clock, sockets, port } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    sockets[0]!.welcome(client.clientSessionId);
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(sockets[0]!.lastFrame("auth").credential).toEqual({ kind: "bearer", token: "token-b" });

    port.suspend();
    expect(clock.taskCount).toBe(0);
    clock.advance(10_000);

    port.resume();
    // 30s deadline, 10s elapsed while suspended: 20s remain on the re-armed timer.
    expect(clock.nextDueIn()).toBe(20_000);
    const second = sockets[1]!;
    second.open();
    expect(second.lastFrame("hello").credential).toEqual({ kind: "bearer", token: "token-b" });
    second.receive({
      v: ACKERDB_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    // The fresh hello presented the refreshed credential, so the welcome
    // resolves the attempt without a second auth round-trip.
    expect(second.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await refresh).toEqual({ authEpoch: 1, ...USER_AUTHENTICATION });
    expect(clock.taskCount).toBe(2); // only the fresh connection's timers remain
    client.close();
  });

  test("pending request deadlines stay absolute across suspension", async () => {
    const { client, clock, port } = createHarness();
    const result = client.query("api.todos.list", { list: 1n }).then(mustErr);
    port.suspend();
    clock.advance(30_000);
    const rejection = (await result) as AckerDBClientError;
    expect(rejection).toBeInstanceOf(AckerDBClientError);
    expect(rejection.code).toBe("deadline_exceeded");
    client.close();
  });
});

describe("AckerDBClient activation", () => {
  test("activation with demand dials in the same event turn regardless of prior backoff depth", () => {
    const { client, clock, sockets, port, phases } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    sockets[0]!.welcome(client.clientSessionId);
    // Deepen the backoff shape before suspending.
    sockets[0]!.close();
    clock.advance(100);
    sockets[1]!.close();
    expect(clock.nextDueIn()).toBe(100);
    port.suspend();
    // Suspension retires the pending backoff: nothing dials before activation.
    expect(clock.taskCount).toBe(0);
    clock.advance(60_000);
    expect(sockets).toHaveLength(2);

    const before = sockets.length;
    port.resume();
    // The dial happened inside the resume call itself: same event turn.
    expect(sockets.length).toBe(before + 1);
    sockets[2]!.welcome(client.clientSessionId);
    expect(phases).toEqual(["ready", "reconnecting", "suspended", "resuming", "ready"]);
    client.close();
  });

  test("retired-generation callbacks cannot mutate or close the replacement connection", () => {
    const { client, sockets, port } = createHarness();
    const updates: unknown[] = [];
    const errors: string[] = [];
    client.subscribe(
      "api.todos.list",
      { list: 1n },
      (value) => updates.push(value),
      (error) => errors.push(error.code),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    first.receive(transition(subscription.id, cursor(1n), ["one"]));

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    second.receive(transition(subscription.id, cursor(2n), ["two"]));
    expect(updates).toEqual([["one"], ["two"]]);
    const ready = client.currentConnectionState;
    expect(ready.phase).toBe("ready");

    // Late callbacks from the retired generation: open, welcome, data,
    // session-level errors, auth completions, close, error.
    first.open();
    first.receive({
      v: ACKERDB_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 9,
      ...USER_AUTHENTICATION,
    });
    first.receive(transition(subscription.id, cursor(3n), ["evil"], cursor(2n)));
    first.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "stale" },
    });
    first.receive({
      t: "auth",
      attemptId: 99,
      authEpoch: 9,
      ...USER_AUTHENTICATION,
    });
    first.onclose?.();
    first.onerror?.();

    expect(client.currentConnectionState).toBe(ready);
    expect(updates).toEqual([["one"], ["two"]]);
    expect(errors).toEqual([]);
    expect(second.closed).toBe(false);

    // The replacement generation still works normally afterwards.
    second.receive(transition(subscription.id, cursor(3n), ["three"], cursor(2n)));
    expect(updates).toEqual([["one"], ["two"], ["three"]]);
    client.close();
  });

  test("rapid background/active cycles coalesce to one active generation with no parallel sockets", () => {
    const { client, clock, sockets, port, phases } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    sockets[0]!.welcome(client.clientSessionId);

    for (let cycle = 0; cycle < 3; cycle++) {
      port.suspend();
      port.suspend();
      port.resume();
      port.resume();
    }
    expect(sockets).toHaveLength(4); // the original dial plus one per coalesced cycle
    expect(sockets.filter((socket) => !socket.closed)).toHaveLength(1);
    expect(phases).toEqual([
      "ready",
      "suspended",
      "resuming",
      "suspended",
      "resuming",
      "suspended",
      "resuming",
    ]);
    sockets[3]!.welcome(client.clientSessionId);
    expect(client.currentConnectionState.phase).toBe("ready");
    expect(clock.taskCount).toBe(2);
    client.close();
    expect(clock.taskCount).toBe(0);
  });

  test("activation with the dial failing outright enters ordinary reconnect and recovers", () => {
    const { client, clock, sockets, port, phases, failNextDial } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    sockets[0]!.welcome(client.clientSessionId);
    port.suspend();

    failNextDial();
    port.resume();
    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    const delay = clock.nextDueIn();
    expect(delay).toBeGreaterThan(0);
    clock.advance(delay!);
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome(client.clientSessionId);
    expect(phases).toEqual(["ready", "suspended", "reconnecting", "ready"]);
    client.close();
  });

  test("activation with the server down enters ordinary reconnect and recovers when it returns", () => {
    const { client, clock, sockets, port, phases } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    sockets[0]!.welcome(client.clientSessionId);
    port.suspend();

    port.resume();
    expect(client.currentConnectionState.phase).toBe("resuming");
    // The immediate attempt dies before its handshake: ordinary reconnect.
    sockets[1]!.close();
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    const delay = clock.nextDueIn();
    expect(delay).toBeGreaterThan(0);
    clock.advance(delay!);
    // The server has returned: recovery completes without any restart.
    sockets[2]!.welcome(client.clientSessionId);
    expect(phases).toEqual(["ready", "suspended", "resuming", "reconnecting", "ready"]);
    client.close();
  });

  test("a server retry hint that elapsed during suspension no longer delays activation", () => {
    const { client, clock, sockets, port } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 5_000,
        message: "connection admission is full",
        resource: "connection",
      },
    });
    port.suspend();
    clock.advance(6_000);
    port.resume();
    // The admission deadline expired by clock while suspended: the first
    // attempt begins in the activation turn as usual.
    expect(sockets).toHaveLength(2);
    expect(client.currentConnectionState.phase).toBe("resuming");
    sockets[1]!.welcome(client.clientSessionId);
    expect(client.currentConnectionState.phase).toBe("ready");
    client.close();
  });

  test("new demand during a Retry-After window defers to the deadline instead of dialing", () => {
    const { client, clock, sockets } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    sockets[0]!.welcome(client.clientSessionId);
    sockets[0]!.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 5_000,
        message: "connection admission is full",
        resource: "connection",
      },
    });
    expect(clock.nextDueIn()).toBe(5_000);
    clock.advance(2_000);

    // Every demand path funnels through the same dial boundary: none of them
    // may open a socket before the server's admission deadline, and the
    // already-scheduled floor timer is preserved rather than restarted.
    client.subscribe("api.todos.list", { list: 2n }, () => {});
    expect(sockets).toHaveLength(1);
    expect(clock.nextDueIn()).toBe(3_000);
    expect(sockets).toHaveLength(1);
    void client.mutation("api.todos.add", { text: "milk" }).catch(() => {});
    expect(sockets).toHaveLength(1);
    expect(clock.nextDueIn()).toBe(3_000);

    clock.advance(3_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome(client.clientSessionId);
    expect(sockets[1]!.frames().filter((frame) => frame.t === "sub")).toHaveLength(2);
    client.close();
  });

  test("late frames after an authentication timeout cannot revive or terminally fail the client", async () => {
    const { client, clock, sockets, phases } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    const socket = sockets[0]!;
    socket.welcome(client.clientSessionId);
    // Real transports close asynchronously: queued frames can still arrive
    // after the client issued close().
    socket.deferClose = true;
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);
    clock.advance(30_000);
    const rejection = (await refresh) as AckerDBClientError;
    expect(rejection.code).toBe("auth_unavailable");
    expect(socket.closes).toEqual([{ code: 4008, reason: "authentication timed out" }]);
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    const blocked = client.currentConnectionState;
    const sentBefore = socket.sent.length;

    // The retired generation delivers everything it had queued: a welcome, an
    // auth confirmation, data, and finally its close event. None of it may
    // mutate the blocked client, flush retained work, or fail it permanently.
    socket.receive({
      v: ACKERDB_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 7,
      ...USER_AUTHENTICATION,
    });
    socket.receive({
      t: "auth",
      attemptId: 2,
      authEpoch: 7,
      ...USER_AUTHENTICATION,
    });
    socket.receive(transition(1, cursor(9n), ["late"]));
    socket.onclose?.();
    expect(client.currentConnectionState).toBe(blocked);
    expect(socket.sent.length).toBe(sentBefore);
    expect(sockets).toHaveLength(1);
    expect(clock.taskCount).toBe(0);

    // A new credential still recovers the ordinary way.
    const recovered = client.refreshCredential({ kind: "bearer", token: "token-c" });
    sockets[1]!.welcome(client.clientSessionId, { principal: "anonymous" }, 2);
    expect(await recovered).toEqual({ authEpoch: 2, principal: "anonymous" });
    expect(phases.at(-1)).toBe("ready");
    client.close();
  });

  test("late frames after a server credential rejection stay inert until the deferred close lands", () => {
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    const socket = sockets[0]!;
    socket.welcome(client.clientSessionId);
    socket.deferClose = true;
    socket.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    const blocked = client.currentConnectionState;

    socket.receive({
      v: ACKERDB_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 9,
      ...USER_AUTHENTICATION,
    });
    socket.onclose?.();
    expect(client.currentConnectionState).toBe(blocked);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  test("a synchronous refreshCredential from onError dials a replacement in the same turn", async () => {
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    let refresh: Promise<unknown> | undefined;
    client.subscribe(
      "api.todos.list",
      { list: 1n },
      () => {},
      () => {
        // The application reacts to the auth rejection inside the callback
        // itself — the rejected socket must already be retired so this
        // recovery dial can happen.
        refresh ??= client.refreshCredential({ kind: "bearer", token: "token-b" });
      },
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    first.deferClose = true;
    first.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.open();
    expect(second.lastFrame("hello").credential).toEqual({ kind: "bearer", token: "token-b" });
    second.receive({
      v: ACKERDB_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    expect(await refresh!).toEqual({ authEpoch: 1, ...USER_AUTHENTICATION });
    expect(client.currentConnectionState.phase).toBe("ready");
    // The rejected socket's deferred close event stays inert.
    first.onclose?.();
    expect(client.currentConnectionState.phase).toBe("ready");
    expect(second.closed).toBe(false);
    client.close();
  });

  test("released operation demand does not cancel standing connection demand", () => {
    const { client, sockets, port } = createHarness();
    const unsubscribe = client.subscribe("api.todos.list", { list: 1n }, () => {});
    expect(sockets).toHaveLength(1);
    unsubscribe();
    port.suspend();
    port.resume();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
    client.close();
  });
});

function waitForPhase(client: AckerDBClient, phase: string): Promise<void> {
  if (client.currentConnectionState.phase === phase) return Promise.resolve();
  const waiting = Promise.withResolvers<void>();
  const stop = client.subscribeConnectionState((state) => {
    if (state.phase !== phase) return;
    stop();
    waiting.resolve(undefined);
  });
  return within(waiting.promise, `the ${phase} phase`);
}

const realSchema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
  }).index(["channelId"]),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

describe("suspension against a real ackerdb server", () => {
  test("the first foreground attempt begins in the activation turn and ready needs no client timer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-suspension-real-"));
    const engine = new Engine(realSchema, join(directory, "data.db"));
    reconcile(engine);
    const registry = new Registry({
      messages: {
        list: query({
          access: "public",
          args: { channelId: v.bigint() },
          handler: (ctx: Ctx, args: Ctx) =>
            ctx.db.messages
              .query()
              .where((message: Ctx) => message.channelId.eq(args.channelId))
              .collect(),
        }),
      },
    });
    const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS });
    const server = serve({ runtime, port: 0 });
    // A fake clock against the real server: every timer the client sets is
    // inert unless advanced, so recovery reaching ready proves the whole
    // resume progression runs on socket events alone — no timer, no backoff.
    const clock = new ManualClock(Date.now());
    let port: AckerDBLifecyclePort | undefined;
    let dials = 0;
    const updates: unknown[] = [];
    let confirmations = 0;
    const client = new AckerDBClient({
      url: `http://127.0.0.1:${server.port}`,
      credential: { kind: "anonymous" },
      clock,
      createWebSocket: (url) => {
        dials++;
        return new WebSocket(url) as unknown as AckerDBWebSocket;
      },
      lifecycle: (livePort) => {
        port = livePort;
        return () => {};
      },
    });
    try {
      client.subscribe(
        "api.messages.list",
        { channelId: 1n },
        (value) => updates.push(value),
        undefined,
        { onCursorConfirmed: () => confirmations++ },
      );
      await waitForPhase(client, "ready");
      await until(() => updates.length >= 1, "the initial query snapshot");
      expect(dials).toBe(1);

      port!.suspend();
      expect(client.currentConnectionState.phase).toBe("suspended");
      const confirmationsBefore = confirmations;

      port!.resume();
      // The first attempt began inside the activation turn itself.
      expect(dials).toBe(2);
      expect(client.currentConnectionState.phase).toBe("resuming");
      await waitForPhase(client, "ready");
      // Authoritative confirmation of the held cursor arrives on the fresh
      // connection: the exact resume protocol, no redelivery required.
      await until(() => confirmations > confirmationsBefore, "the resume confirmation");
      expect(dials).toBe(2);
    } finally {
      client.close();
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
