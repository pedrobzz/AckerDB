import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type AuthenticationDescriptor,
  type ClientMessage,
  type Identity,
  type ServerMessage,
  type SubscriptionCursor,
} from "@dbzz/core";
import {
  DbzzClient,
  DbzzClientError,
  type DbzzClientClock,
  type DbzzClientOptions,
  type DbzzLifecyclePort,
  type DbzzWebSocket,
} from "@dbzz/client";
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
} from "@dbzz/server";

const USER_AUTHENTICATION = {
  principal: "user",
  identity: 1n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1" },
} satisfies AuthenticationDescriptor;

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
  /** Real socket close is asynchronous; set this to hold the close event back. */
  deferClose = false;
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
    if (!this.deferClose) this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: ServerMessage): void {
    this.onmessage?.({ data: encode(frame) });
  }

  drop(): void {
    this.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => parseClientMessage(decode(text)));
  }
}

interface Harness {
  readonly client: DbzzClient;
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  readonly port: DbzzLifecyclePort;
  readonly phases: string[];
  stops(): number;
  failNextDial(): void;
}

function harness(overrides: Partial<DbzzClientOptions> = {}): Harness {
  const clock = overrides.clock instanceof ManualClock ? overrides.clock : new ManualClock();
  const sockets: FakeSocket[] = [];
  let port: DbzzLifecyclePort | undefined;
  let stops = 0;
  let failDials = 0;
  const client = new DbzzClient({
    url: "http://dbzz.test",
    credential: { kind: "anonymous" },
    clientSessionId: "suspension-session",
    clock,
    random: () => 0,
    createWebSocket: () => {
      if (failDials > 0) {
        failDials--;
        throw new Error("dial refused");
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    lifecycle: (livePort) => {
      port = livePort;
      return () => {
        stops++;
      };
    },
    ...overrides,
  });
  const phases: string[] = [];
  client.subscribeConnectionState((state) => phases.push(state.phase));
  return {
    client,
    clock,
    sockets,
    get port(): DbzzLifecyclePort {
      if (!port) throw new Error("the harness lifecycle source was overridden");
      return port;
    },
    phases,
    stops: () => stops,
    failNextDial: () => {
      failDials++;
    },
  };
}

function mustErr<E>(result: { readonly ok: true; readonly data: unknown } | {
  readonly ok: false;
  readonly error: E;
}): E {
  if (result.ok) throw new Error("expected a failed Result");
  return result.error;
}

function welcome(client: DbzzClient, socket: FakeSocket, authEpoch = 0): void {
  socket.open();
  socket.receive({
    v: PROTOCOL_VERSION,
    t: "welcome",
    clientSessionId: client.clientSessionId,
    authEpoch,
    principal: "anonymous",
  });
}

function cursor(commitVersion: bigint): SubscriptionCursor {
  return {
    generation: "generation-1",
    commitVersion,
    authEpoch: 0,
    identity: "todos.list:{list:1}",
  };
}

function lastFrame<T extends ClientMessage["t"]>(
  socket: FakeSocket,
  type: T,
): Extract<ClientMessage, { t: T }> {
  const frame = socket.frames().findLast((candidate) => candidate.t === type);
  if (!frame) throw new Error(`No ${type} frame`);
  return frame as Extract<ClientMessage, { t: T }>;
}

function transition(
  id: number,
  to: SubscriptionCursor,
  value: unknown,
  from: SubscriptionCursor | null = null,
): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "transition",
    id,
    transition:
      from === null
        ? { kind: "reset", from: null, to, value }
        : { kind: "update", from, to, value },
  };
}

describe("DbzzClient lifecycle port", () => {
  test("registers one observer per client lifetime and removes it before teardown", () => {
    const sequence: string[] = [];
    let registrations = 0;
    const { client, sockets } = harness({
      lifecycle: (port) => {
        registrations++;
        void port;
        return () => {
          sequence.push("observer-removed");
        };
      },
    });
    client.connect();
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
    const { client, sockets, port, phases } = harness();
    client.connect();
    client.close();
    const socketCount = sockets.length;
    port.suspend();
    port.resume();
    expect(sockets.length).toBe(socketCount);
    expect(client.currentConnectionState.phase).toBe("closed");
    expect(phases).toEqual(["closed"]);
  });
});

describe("DbzzClient suspension", () => {
  test("background during ready atomically publishes suspended, retires socket and timers, and keeps logical state", () => {
    const { client, clock, sockets, port, phases } = harness();
    const updates: unknown[] = [];
    client.subscribe("todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
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
    welcome(client, second);
    expect(phases).toEqual(["ready", "suspended", "resuming", "ready"]);
    expect(lastFrame(second, "sub").cursor).toEqual(cursor(5n));
    client.close();
  });

  test("background during connecting retires the pre-open socket without scheduling reconnect", () => {
    const { client, clock, sockets, port } = harness();
    client.connect();
    const first = sockets[0]!;
    expect(first.isClosed()).toBe(false);
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
    const { client, sockets, port } = harness();
    const updates: unknown[] = [];
    client.subscribe("todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
    expect(subscription.cursor).toBeUndefined();

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    welcome(client, second);
    const resent = lastFrame(second, "sub");
    expect(resent.id).toBe(subscription.id);
    expect(resent.cursor).toBeUndefined();
    second.receive(transition(subscription.id, cursor(1n), ["fresh"]));
    expect(updates).toEqual([["fresh"]]);
    client.close();
  });

  test("background clears a stale reconnect backoff so nothing dials before activation", () => {
    const { client, clock, sockets, port } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    const first = sockets[0]!;
    welcome(client, first);
    first.drop();
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    expect(clock.nextDueIn()).toBe(100);

    port.suspend();
    expect(clock.taskCount).toBe(0);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);

    port.resume();
    expect(sockets).toHaveLength(2);
    welcome(client, sockets[1]!);
    expect(client.currentConnectionState.phase).toBe("ready");
    client.close();
  });

  test("background pauses the credential deadline and activation re-arms the remainder", async () => {
    const { client, clock, sockets, port } = harness({
      credential: { kind: "bearer", token: "token-a" },
    });
    client.connect();
    welcome(client, sockets[0]!);
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    expect(lastFrame(sockets[0]!, "auth").credential).toEqual({ kind: "bearer", token: "token-b" });

    port.suspend();
    expect(clock.taskCount).toBe(0);
    clock.advance(10_000);

    port.resume();
    // 30s deadline, 10s elapsed while suspended: 20s remain on the re-armed timer.
    expect(clock.nextDueIn()).toBe(20_000);
    const second = sockets[1]!;
    second.open();
    expect(lastFrame(second, "hello").credential).toEqual({ kind: "bearer", token: "token-b" });
    second.receive({
      v: PROTOCOL_VERSION,
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

  test("a credential deadline that elapsed during suspension expires on activation without dialing", async () => {
    const { client, clock, sockets, port, phases } = harness({
      credential: { kind: "bearer", token: "token-a" },
    });
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);

    port.suspend();
    clock.advance(30_001);
    port.resume();

    const rejection = (await refresh) as DbzzClientError;
    expect(rejection).toBeInstanceOf(DbzzClientError);
    expect(rejection.code).toBe("auth_unavailable");
    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    expect(phases).toEqual(["ready", "suspended", "authentication-blocked"]);

    // A new credential recovers the ordinary way now that the app is active.
    const recovered = client.refreshCredential({ kind: "bearer", token: "token-c" });
    expect(sockets).toHaveLength(2);
    welcome(client, sockets[1]!, 2);
    expect(await recovered).toEqual({ authEpoch: 2, principal: "anonymous" });
    client.close();
  });

  test("pending request deadlines stay absolute across suspension", async () => {
    const { client, clock, port } = harness();
    const result = client.query("todos.list", { list: 1n }).then(mustErr);
    port.suspend();
    clock.advance(30_000);
    const rejection = (await result) as DbzzClientError;
    expect(rejection).toBeInstanceOf(DbzzClientError);
    expect(rejection.code).toBe("deadline_exceeded");
    client.close();
  });

  test("in-flight procedures settle promptly at suspension and never restart", async () => {
    const { client, sockets, port } = harness();
    const call = client.procedure("todos.tally", {}).then(mustErr);
    expect(sockets).toHaveLength(1);
    welcome(client, sockets[0]!);
    const request = lastFrame(sockets[0]!, "p");
    port.suspend();
    const rejection = (await call) as DbzzClientError;
    expect(rejection).toBeInstanceOf(DbzzClientError);
    expect(rejection.code).toBe("indeterminate");
    expect(lastFrame(sockets[0]!, "cancel").id).toBe(request.id);
    port.resume();
    // A settled procedure is not demand: activation does not dial or replay it.
    expect(sockets).toHaveLength(1);
    client.close();
  });

  test("in-flight SSE streams settle promptly at suspension and never restart", async () => {
    let fetches = 0;
    const { client, port } = harness({
      fetch: () => {
        fetches++;
        return new Promise<Response>(() => {});
      },
    });
    const stream = client.sse("todos.watch", {});
    const first = stream.next().catch((error) => error);
    await Promise.resolve();
    port.suspend();
    const rejection = (await first) as DbzzClientError;
    expect(rejection).toBeInstanceOf(DbzzClientError);
    expect(rejection.code).toBe("unavailable");
    port.resume();
    expect(fetches).toBe(1);
    client.close();
  });
});

describe("DbzzClient activation", () => {
  test("activation with demand dials in the same event turn regardless of prior backoff depth", () => {
    const { client, clock, sockets, port, phases } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    // Deepen the backoff shape before suspending.
    sockets[0]!.drop();
    clock.advance(100);
    sockets[1]!.drop();
    expect(clock.nextDueIn()).toBe(100);
    port.suspend();
    clock.advance(60_000);
    expect(sockets).toHaveLength(2);

    const before = sockets.length;
    port.resume();
    // The dial happened inside the resume call itself: same event turn.
    expect(sockets.length).toBe(before + 1);
    welcome(client, sockets[2]!);
    expect(phases).toEqual(["ready", "reconnecting", "suspended", "resuming", "ready"]);
    client.close();
  });

  test("retired-generation callbacks cannot mutate or close the replacement connection", () => {
    const { client, sockets, port } = harness();
    const updates: unknown[] = [];
    const errors: string[] = [];
    client.subscribe(
      "todos.list",
      { list: 1n },
      (value) => updates.push(value),
      (error) => errors.push(error.code),
    );
    const first = sockets[0]!;
    welcome(client, first);
    const subscription = lastFrame(first, "sub");
    first.receive(transition(subscription.id, cursor(1n), ["one"]));

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    welcome(client, second);
    second.receive(transition(subscription.id, cursor(2n), ["two"]));
    expect(updates).toEqual([["one"], ["two"]]);
    const ready = client.currentConnectionState;
    expect(ready.phase).toBe("ready");

    // Late callbacks from the retired generation: open, welcome, data,
    // session-level errors, auth completions, close, error.
    first.open();
    first.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 9,
      ...USER_AUTHENTICATION,
    });
    first.receive(transition(subscription.id, cursor(3n), ["evil"], cursor(2n)));
    first.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "stale" },
    });
    first.receive({
      v: PROTOCOL_VERSION,
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
    expect(second.isClosed()).toBe(false);

    // The replacement generation still works normally afterwards.
    second.receive(transition(subscription.id, cursor(3n), ["three"], cursor(2n)));
    expect(updates).toEqual([["one"], ["two"], ["three"]]);
    client.close();
  });

  test("rapid background/active cycles coalesce to one active generation with no parallel sockets", () => {
    const { client, clock, sockets, port, phases } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);

    for (let cycle = 0; cycle < 3; cycle++) {
      port.suspend();
      port.suspend();
      port.resume();
      port.resume();
    }
    expect(sockets).toHaveLength(4); // the original dial plus one per coalesced cycle
    expect(sockets.filter((socket) => !socket.isClosed())).toHaveLength(1);
    expect(phases).toEqual([
      "ready",
      "suspended",
      "resuming",
      "suspended",
      "resuming",
      "suspended",
      "resuming",
    ]);
    welcome(client, sockets[3]!);
    expect(client.currentConnectionState.phase).toBe("ready");
    expect(clock.taskCount).toBe(2);
    client.close();
    expect(clock.taskCount).toBe(0);
  });

  test("activation with the dial failing outright enters ordinary reconnect and recovers", () => {
    const { client, clock, sockets, port, phases, failNextDial } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    port.suspend();

    failNextDial();
    port.resume();
    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    const delay = clock.nextDueIn();
    expect(delay).toBeGreaterThan(0);
    clock.advance(delay!);
    expect(sockets).toHaveLength(2);
    welcome(client, sockets[1]!);
    expect(phases).toEqual(["ready", "suspended", "reconnecting", "ready"]);
    client.close();
  });

  test("activation with the server down enters ordinary reconnect and recovers when it returns", () => {
    const { client, clock, sockets, port, phases } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    port.suspend();

    port.resume();
    expect(client.currentConnectionState.phase).toBe("resuming");
    // The immediate attempt dies before its handshake: ordinary reconnect.
    sockets[1]!.drop();
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    const delay = clock.nextDueIn();
    expect(delay).toBeGreaterThan(0);
    clock.advance(delay!);
    // The server has returned: recovery completes without any restart.
    welcome(client, sockets[2]!);
    expect(phases).toEqual(["ready", "suspended", "resuming", "reconnecting", "ready"]);
    client.close();
  });

  test("a server retry hint outlives suspension: activation honors the remaining pushback", () => {
    const { client, clock, sockets, port, phases } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    // The server sheds load with an explicit admission deadline.
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
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

    port.suspend();
    expect(clock.taskCount).toBe(0);
    clock.advance(2_000);
    port.resume();
    // A lifecycle transition cannot bypass admission control: no immediate
    // dial, the ordinary reconnect policy holds the remaining three seconds.
    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    expect(clock.nextDueIn()).toBe(3_000);
    clock.advance(3_000);
    expect(sockets).toHaveLength(2);
    welcome(client, sockets[1]!);
    expect(phases).toEqual(["ready", "reconnecting", "suspended", "reconnecting", "ready"]);
    client.close();
  });

  test("a server retry hint that elapsed during suspension no longer delays activation", () => {
    const { client, clock, sockets, port } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
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
    welcome(client, sockets[1]!);
    expect(client.currentConnectionState.phase).toBe("ready");
    client.close();
  });

  test("new demand during a Retry-After window defers to the deadline instead of dialing", () => {
    const { client, clock, sockets } = harness();
    client.subscribe("todos.list", { list: 1n }, () => {});
    welcome(client, sockets[0]!);
    sockets[0]!.receive({
      v: PROTOCOL_VERSION,
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
    client.subscribe("todos.list", { list: 2n }, () => {});
    expect(sockets).toHaveLength(1);
    expect(clock.nextDueIn()).toBe(3_000);
    client.connect();
    expect(sockets).toHaveLength(1);
    void client.mutation("todos.add", { text: "milk" }).catch(() => {});
    expect(sockets).toHaveLength(1);
    expect(clock.nextDueIn()).toBe(3_000);

    clock.advance(3_000);
    expect(sockets).toHaveLength(2);
    welcome(client, sockets[1]!);
    expect(sockets[1]!.frames().filter((frame) => frame.t === "sub")).toHaveLength(2);
    client.close();
  });

  test("late frames after an authentication timeout cannot revive or terminally fail the client", async () => {
    const { client, clock, sockets, phases } = harness({
      credential: { kind: "bearer", token: "token-a" },
    });
    client.subscribe("todos.list", { list: 1n }, () => {});
    const socket = sockets[0]!;
    welcome(client, socket);
    // Real transports close asynchronously: queued frames can still arrive
    // after the client issued close().
    socket.deferClose = true;
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);
    clock.advance(30_000);
    const rejection = (await refresh) as DbzzClientError;
    expect(rejection.code).toBe("auth_unavailable");
    expect(socket.closes).toEqual([{ code: 4008, reason: "authentication timed out" }]);
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    const blocked = client.currentConnectionState;
    const sentBefore = socket.sent.length;

    // The retired generation delivers everything it had queued: a welcome, an
    // auth confirmation, data, and finally its close event. None of it may
    // mutate the blocked client, flush retained work, or fail it permanently.
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 7,
      ...USER_AUTHENTICATION,
    });
    socket.receive({
      v: PROTOCOL_VERSION,
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
    welcome(client, sockets[1]!, 2);
    expect(await recovered).toEqual({ authEpoch: 2, principal: "anonymous" });
    expect(phases.at(-1)).toBe("ready");
    client.close();
  });

  test("late frames after a server credential rejection stay inert until the deferred close lands", () => {
    const { client, sockets } = harness({
      credential: { kind: "bearer", token: "token-a" },
    });
    client.subscribe("todos.list", { list: 1n }, () => {});
    const socket = sockets[0]!;
    welcome(client, socket);
    socket.deferClose = true;
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    const blocked = client.currentConnectionState;

    socket.receive({
      v: PROTOCOL_VERSION,
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
    const { client, sockets } = harness({
      credential: { kind: "bearer", token: "token-a" },
    });
    let refresh: Promise<unknown> | undefined;
    client.subscribe(
      "todos.list",
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
    welcome(client, first);
    first.deferClose = true;
    first.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.open();
    expect(lastFrame(second, "hello").credential).toEqual({ kind: "bearer", token: "token-b" });
    second.receive({
      v: PROTOCOL_VERSION,
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
    expect(second.isClosed()).toBe(false);
    client.close();
  });

  test("activation without demand leaves the client idle", () => {
    const { client, sockets, port, phases } = harness();
    port.suspend();
    port.resume();
    expect(sockets).toHaveLength(0);
    expect(client.currentConnectionState.phase).toBe("connecting");
    expect(phases).toEqual(["suspended", "connecting"]);
    client.close();
  });

  test("demand released before suspension stays released: activation does not redial", () => {
    const { client, sockets, port } = harness();
    const unsubscribe = client.subscribe("todos.list", { list: 1n }, () => {});
    expect(sockets).toHaveLength(1);
    unsubscribe();
    port.suspend();
    port.resume();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.isClosed()).toBe(true);
    client.close();
  });

  test("work created during suspension is demand for the activation dial, not an immediate one", async () => {
    const { client, sockets, port } = harness();
    port.suspend();
    client.connect();
    expect(sockets).toHaveLength(0);
    const result = client.mutation("todos.add", { text: "milk" });
    expect(sockets).toHaveLength(0);

    port.resume();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    welcome(client, socket);
    const frame = lastFrame(socket, "m");
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: frame.id,
      kind: "mutation",
      value: 7n,
      receipt: {
        mutationRequestId: frame.mutationRequestId,
        commitVersion: 1n,
        durability: "production",
        replay: "executed",
        obligations: [],
      },
    });
    const mutationResult = await result;
    if (!mutationResult.ok) throw mutationResult.error;
    expect(mutationResult.data).toBe(7n);
    client.close();
  });

  test("a mutation pending across suspension keeps its original identity on the fresh connection", () => {
    const { client, sockets, port } = harness();
    client.connect();
    welcome(client, sockets[0]!);
    void client.mutation("todos.add", { text: "milk" }).catch(() => {});
    const issued = lastFrame(sockets[0]!, "m");

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    welcome(client, second);
    const replayed = lastFrame(second, "m");
    expect(replayed.id).toBe(issued.id);
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);
    client.close();
  });
});

const WAIT_DEADLINE_MS = 5_000;

function withDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), WAIT_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function waitForPhase(client: DbzzClient, phase: string): Promise<void> {
  if (client.currentConnectionState.phase === phase) return Promise.resolve();
  const waiting = Promise.withResolvers<void>();
  const stop = client.subscribeConnectionState((state) => {
    if (state.phase !== phase) return;
    stop();
    waiting.resolve(undefined);
  });
  return withDeadline(waiting.promise, `the ${phase} phase`);
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
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

describe("suspension against a real dbzz server", () => {
  test("the first foreground attempt begins in the activation turn and ready needs no client timer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-suspension-real-"));
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
    const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS, telemetry: false });
    const server = serve({ runtime, port: 0 });
    // A fake clock against the real server: every timer the client sets is
    // inert unless advanced, so recovery reaching ready proves the whole
    // resume progression runs on socket events alone — no timer, no backoff.
    const clock = new ManualClock(Date.now());
    let port: DbzzLifecyclePort | undefined;
    let dials = 0;
    const updates: unknown[] = [];
    let confirmations = 0;
    const client = new DbzzClient({
      url: `http://127.0.0.1:${server.port}`,
      credential: { kind: "anonymous" },
      clock,
      createWebSocket: (url) => {
        dials++;
        return new WebSocket(url) as unknown as DbzzWebSocket;
      },
      lifecycle: (livePort) => {
        port = livePort;
        return () => {};
      },
    });
    try {
      client.subscribe(
        "messages.list",
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
