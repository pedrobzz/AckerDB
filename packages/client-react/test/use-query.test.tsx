import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type ApplicationError,
  type ClientMessage,
  type ServerMessage,
  type SubscriptionCursor,
} from "@ackerdb/core";
import { AckerDBClient, type AckerDBClientClock, type AckerDBWebSocket, type QueryRef } from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AckerDBProvider,
  skip,
  useQuery,
  type AckerDBProviderConfig,
  type AckerDBQueryState,
} from "@ackerdb/client-react";
import { QueryStoreEntry } from "../src/query-store.ts";

interface ClockTask {
  at: number;
  callback: () => void;
  intervalMs?: number;
}

class ManualClock implements AckerDBClientClock {
  private nextId = 0;
  private readonly tasks = new Map<number, ClockTask>();
  private time = 0;

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
}

class FakeSocket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    parseClientMessage(decode(data));
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  welcome(clientSessionId: string): void {
    this.onopen?.();
    this.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId,
      authEpoch: 0,
      principal: "anonymous",
    });
  }

  receive(frame: ServerMessage): void {
    this.onmessage?.({ data: encode(frame) });
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => parseClientMessage(decode(text)));
  }

  framesOf<T extends ClientMessage["t"]>(type: T): Extract<ClientMessage, { t: T }>[] {
    return this.frames().filter((frame) => frame.t === type) as Extract<
      ClientMessage,
      { t: T }
    >[];
  }
}

const SESSION = "use-query-session";

interface Harness {
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  readonly config: AckerDBProviderConfig;
  live(): FakeSocket;
  subFrames<T extends ClientMessage["t"]>(type: T): Extract<ClientMessage, { t: T }>[];
}

function createHarness(): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  return {
    clock,
    sockets,
    config: {
      url: "http://use-query.test",
      credential: { kind: "anonymous" },
      clientSessionId: SESSION,
      clock,
      random: () => 0,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
    live() {
      const socket = sockets.findLast((candidate) => !candidate.closed);
      if (!socket) throw new Error("no live socket");
      return socket;
    },
    subFrames(type) {
      return sockets.flatMap((socket) => socket.framesOf(type));
    },
  };
}

type TodoArgs = { readonly list: bigint };
type TodoNotFound = ApplicationError<
  "todo.not-found",
  { readonly list: bigint },
  404
>;
const todos = { $ref: "todos.list" } as QueryRef<TodoArgs, string[], TodoNotFound>;

function cursor(commitVersion: bigint): SubscriptionCursor {
  return {
    generation: "generation-1",
    commitVersion,
    authEpoch: 0,
    identity: "todos.list:{list:1}",
  };
}

let observed: AckerDBQueryState<string[], TodoNotFound> | undefined;

function describeState(state: AckerDBQueryState<string[], TodoNotFound>): string {
  switch (state.status) {
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    case "success":
      return `fresh:${state.data.join(",")}`;
    case "application-error":
      return `application-error:${state.error.code}`;
    case "rejected":
      return `error:${state.error.code}:-`;
    case "unavailable":
      return state.data === undefined
        ? `error:${state.error.code}:-`
        : `stale:${state.data.join(",")}`;
  }
}

function TodoReport({ args }: { args: TodoArgs | typeof skip }): ReactNode {
  const state = useQuery(todos, args);
  observed = state;
  return <span>{describeState(state)}</span>;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function app(harness: Harness, args: TodoArgs | typeof skip, strict = false): ReactNode {
  const tree = (
    <AckerDBProvider config={harness.config}>
      <TodoReport args={args} />
    </AckerDBProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

async function receive(harness: Harness, frame: ServerMessage): Promise<void> {
  await act(async () => {
    harness.live().receive(frame);
  });
}

async function ready(harness: Harness): Promise<void> {
  await act(async () => {
    harness.live().welcome(SESSION);
  });
}

/** Boots to a fresh success showing ["one"] and returns the subscription id. */
async function bootToSuccess(harness: Harness, root: Root, container: HTMLElement): Promise<number> {
  await render(root, app(harness, { list: 1n }));
  await ready(harness);
  const id = harness.subFrames("sub")[0]!.id;
  await receive(harness, {
    v: PROTOCOL_VERSION,
    t: "transition",
    id,
    transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
  });
  expect(container.textContent).toBe("fresh:one");
  return id;
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useQuery state transitions", () => {
  test("skip renders disabled and never starts a subscription; real args start one", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, skip));
    expect(container.textContent).toBe("disabled");
    await ready(harness);
    expect(harness.subFrames("sub")).toHaveLength(0);

    // Replacing the sentinel with real arguments starts exactly one query.
    await render(root, app(harness, { list: 1n }));
    expect(container.textContent).toBe("pending");
    const subs = harness.subFrames("sub");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.args).toEqual({ list: 1n });

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("fresh:one");

    // Back to skip: disabled again and the subscription is released.
    await render(root, app(harness, skip));
    expect(container.textContent).toBe("disabled");
    expect(harness.subFrames("unsub").map((frame) => frame.id)).toEqual([subs[0]!.id]);
    await render(root, <></>);
  });

  test("disconnect keeps data stale; a resume delivery restores fresh with the same rows", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);
    const fresh = observed!;

    await act(async () => {
      harness.live().close();
    });
    expect(container.textContent).toBe("stale:one");
    const stale = observed!;
    expect(stale.status).toBe("unavailable");
    // Retained rows are the same authoritative array, only the marker moved.
    expect((stale as Extract<typeof stale, { status: "unavailable" }>).data).toBe(
      (fresh as Extract<typeof fresh, { status: "success" }>).data,
    );

    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    // Reconnect resumed from the retained cursor and stays stale until the
    // server's authoritative answer arrives.
    expect(harness.live().framesOf("sub")[0]!.cursor).toEqual(cursor(1n));
    expect(container.textContent).toBe("stale:one");

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "resume", from: cursor(1n), to: cursor(1n) },
    });
    expect(container.textContent).toBe("fresh:one");
    await render(root, <></>);
  });

  test("a checkpoint-only resume chain confirms freshness without redelivery", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await act(async () => {
      harness.live().close();
    });
    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    expect(container.textContent).toBe("stale:one");

    // The value did not change while disconnected but the commit version did:
    // the server replays its history as checkpoints, which is authoritative.
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "checkpoint", from: cursor(1n), to: cursor(2n) },
    });
    expect(container.textContent).toBe("fresh:one");
    await render(root, <></>);
  });

  test("a reset delivery after reconnect replaces rows and restores fresh", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await act(async () => {
      harness.live().close();
    });
    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    expect(container.textContent).toBe("stale:one");

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(5n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("fresh:one,two");
    await render(root, <></>);
  });

  test("a framework rejection clears prior rows and preserves the exact error", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthorized", retryable: false, message: "access denied" },
    });
    expect(container.textContent).toBe("error:unauthorized:-");
    const state = observed!;
    if (state.status !== "rejected") throw new Error("expected a rejected state");
    expect(state.error.message).toBe("access denied");
    expect(state.error.outcome).toMatchObject({ code: "unauthorized", retryable: false });
    await render(root, <></>);
  });

  test("an application error clears prior data, narrows its body, and can recover", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "application-error",
        from: cursor(1n),
        to: cursor(2n),
        error: {
          kind: "application",
          code: "todo.not-found",
          body: { list: 1n },
          status: 404,
        },
      },
    });
    expect(container.textContent).toBe("application-error:todo.not-found");
    const failed = observed!;
    if (failed.status !== "application-error") {
      throw new Error("expected an application-error state");
    }
    expect(failed.data).toBeUndefined();
    expect(failed.error.body.list).toBe(1n);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(3n), value: ["restored"] },
    });
    expect(container.textContent).toBe("fresh:restored");
    await render(root, <></>);
  });

  test("disconnect hides an application error until cursor confirmation restores it", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "application-error",
        from: cursor(1n),
        to: cursor(2n),
        error: {
          kind: "application",
          code: "todo.not-found",
          body: { list: 1n },
          status: 404,
        },
      },
    });
    expect(container.textContent).toBe("application-error:todo.not-found");

    await act(async () => {
      harness.live().close();
    });
    expect(container.textContent).toBe("error:unavailable:-");
    const disconnected = observed!;
    if (disconnected.status !== "unavailable") {
      throw new Error("expected unavailable application-error state");
    }
    expect(disconnected).toMatchObject({
      data: undefined,
      stale: false,
      error: { code: "unavailable" },
    });

    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    expect(harness.live().framesOf("sub")[0]!.cursor).toEqual(cursor(2n));
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "resume", from: cursor(2n), to: cursor(2n) },
    });
    expect(container.textContent).toBe("application-error:todo.not-found");
    await render(root, <></>);
  });

  test("a retryable rejection resubscribes on its own and recovers without remounting", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    // The server rejects the subscription with an explicitly retryable error;
    // the base client removes it, but the mounted consumer's demand stands.
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 10,
        message: "subscription rejected",
      },
    });
    expect(container.textContent).toBe("stale:one");

    const deadline = Date.now() + 2_000;
    while (harness.subFrames("sub").length < 2 && Date.now() < deadline) {
      await act(async () => {
        await Bun.sleep(20);
      });
    }
    const subs = harness.subFrames("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args).toEqual({ list: 1n });

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("fresh:one,two");
    await render(root, <></>);
  });

  test("unmounting cancels a scheduled retryable resubscribe", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: { code: "overloaded", retryable: true, message: "subscription rejected" },
    });
    await render(root, <></>);
    await Bun.sleep(300);
    expect(harness.subFrames("sub")).toHaveLength(1);
  });

  test("an error before any delivery retains nothing", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness, { list: 1n }));
    await ready(harness);
    const id = harness.subFrames("sub")[0]!.id;

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: { code: "validation", retryable: false, message: "bad query" },
    });
    expect(container.textContent).toBe("error:validation:-");
    await render(root, <></>);
  });

  test("a revoked transition clears prior rows, and a later reset recovers", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "revoked",
        from: cursor(1n),
        to: cursor(2n),
        outcome: { code: "unauthorized", retryable: false, message: "revoked" },
      },
    });
    expect(container.textContent).toBe("error:unauthorized:-");

    // A checkpoint cannot clear the revocation.
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "checkpoint", from: cursor(2n), to: cursor(3n) },
    });
    expect(container.textContent).toBe("error:unauthorized:-");

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(4n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("fresh:one,two");
    await render(root, <></>);
  });

  test("changed arguments start a new subscription; equal-valued literals continue the current one", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);
    const settled = observed!;

    // A new object with equal values is the same query: no resubscribe, and
    // the committed snapshot is the identical object.
    await render(root, app(harness, { list: 1n }));
    expect(harness.subFrames("sub")).toHaveLength(1);
    expect(observed!).toBe(settled);

    await render(root, app(harness, { list: 2n }));
    expect(container.textContent).toBe("pending");
    const subs = harness.subFrames("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args).toEqual({ list: 2n });
    expect(harness.subFrames("unsub").map((frame) => frame.id)).toEqual([id]);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(9n), value: ["two"] },
    });
    expect(container.textContent).toBe("fresh:two");
    await render(root, <></>);
  });

  test("duplicate deliveries leave the committed snapshot referentially unchanged", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);
    const settled = observed!;

    // A duplicate of the applied transition confirms the held cursor; a fresh
    // snapshot has nothing to change, including its identity.
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(observed!).toBe(settled);
    await render(root, <></>);
  });

  test("unmounting the consumer releases the single-consumer subscription", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    // The provider (and its client) stay mounted; only the query consumer
    // leaves, so the release must reach the server as an unsubscribe.
    await render(root, <AckerDBProvider config={harness.config} />);
    expect(harness.subFrames("unsub").map((frame) => frame.id)).toEqual([id]);
    await render(root, <></>);
  });

  test("Strict Mode leaves exactly one live subscription and updates flow", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness, { list: 1n }, true));
    await ready(harness);

    // Strict Mode ran subscribe, cleanup, subscribe before the socket was
    // ready, so only the surviving subscription was ever sent.
    const live = harness.live();
    const subs = live.framesOf("sub");
    expect(subs).toHaveLength(1);
    expect(live.framesOf("unsub")).toHaveLength(0);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("fresh:one");

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config} />
      </StrictMode>,
    );
    expect(live.framesOf("unsub").map((frame) => frame.id)).toEqual([subs[0]!.id]);
    await render(root, <></>);
  });

  // Driven through the store entry directly: authentication recovery has no
  // hook until ISSUE-08, and refreshCredential() lives on the private client.
  test("a deferred retry survives authentication blocking and resubscribes after recovery", async () => {
    const harness = createHarness();
    const client = new AckerDBClient(harness.config);
    const entry = new QueryStoreEntry<string[]>(client, "todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const first = harness.live();
    first.welcome(SESSION);
    const id = first.framesOf("sub")[0]!.id;
    first.receive({
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(entry.snapshot()).toMatchObject({ status: "success", stale: false });

    // The subscription is rejected retryably, then the credential expires
    // before the scheduled retry fires.
    first.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id,
      outcome: { code: "overloaded", retryable: true, retryAfterMs: 10, message: "rejected" },
    });
    first.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    await Bun.sleep(300);
    // The retry deferred against the blocked client instead of dying.
    expect(harness.subFrames("sub")).toHaveLength(1);

    // New credentials recover the client; the held demand resubscribes and
    // the query returns to fresh authoritative data.
    const refreshed = client.refreshCredential({ kind: "bearer", token: "token-b" });
    const second = harness.live();
    // The recovery hello presents the refreshed credential, so the welcome
    // resolves the attempt itself: no second auth round-trip precedes the
    // resubscription flush.
    second.welcome(SESSION);
    expect(second.framesOf("auth")).toHaveLength(0);
    await refreshed;
    const resubscribed = second.framesOf("sub");
    expect(resubscribed).toHaveLength(1);
    expect(resubscribed[0]!.args).toEqual({ list: 1n });
    second.receive({
      v: PROTOCOL_VERSION,
      t: "transition",
      id: resubscribed[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(entry.snapshot()).toMatchObject({
      status: "success",
      stale: false,
      data: ["one", "two"],
    });

    stopListening();
    client.close();
  });

  test("binary row payloads stay genuine platform typed arrays inside frozen rows", async () => {
    const harness = createHarness();
    const client = new AckerDBClient(harness.config);
    type BlobRow = { readonly name: string; readonly blob: Uint8Array };
    const entry = new QueryStoreEntry<BlobRow[]>(client, "todos.blobs", {});
    const stopListening = entry.listen(() => {});
    const first = harness.live();
    first.welcome(SESSION);
    const id = first.framesOf("sub")[0]!.id;
    first.receive({
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "reset",
        from: null,
        to: cursor(1n),
        value: [{ name: "a", blob: new Uint8Array([104, 105]) }],
      },
    });
    const state = entry.snapshot();
    if (state.status !== "success") throw new Error("expected success");
    const row = state.data[0]!;
    // The container structure is frozen, but byte leaves must remain real
    // ArrayBuffer views the platform accepts — no read-only wrapper survives
    // TextDecoder, Web Crypto, or Blob serialization.
    expect(Object.isFrozen(state.data)).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
    expect(row.blob).toBeInstanceOf(Uint8Array);
    expect(ArrayBuffer.isView(row.blob)).toBe(true);
    expect([...row.blob]).toEqual([104, 105]);
    expect(new TextDecoder().decode(row.blob)).toBe("hi");
    const blob = new Blob([row.blob as Uint8Array<ArrayBuffer>]);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([104, 105]));
    stopListening();
    client.close();
  });

  test("delivered rows are immutable through the snapshot", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await bootToSuccess(harness, root, container);

    const state = observed!;
    if (state.status !== "success") throw new Error("expected success");
    expect(Object.isFrozen(state.data)).toBe(true);
    expect(() => state.data.push("mutated")).toThrow(TypeError);
    expect(container.textContent).toBe("fresh:one");
    await render(root, <></>);
  });

  test("unencodable argument values become the exact validation error state", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const numbers = { $ref: "todos.byScore" } as QueryRef<{ score: number }, string[]>;
    let captured: AckerDBQueryState<string[]> | undefined;

    function BadArgs(): ReactNode {
      const state = useQuery(numbers, { score: Number.NaN });
      captured = state;
      return <span>{state.status === "rejected" ? `error:${state.error.code}` : state.status}</span>;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <BadArgs />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("error:validation");
    if (captured?.status !== "rejected") throw new Error("expected a rejected state");
    expect(captured.error.message).toBe("cannot encode non-finite number NaN");
    expect(captured.error.outcome).toMatchObject({ retryable: false, resource: "subscription" });
    expect(harness.subFrames("sub")).toHaveLength(0);
    await render(root, <></>);
  });
});
