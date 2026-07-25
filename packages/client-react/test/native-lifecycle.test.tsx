import { describe, expect, mock, test } from "bun:test";
// Registers happy-dom before any React module loads — every test file in this
// suite must do this first (see ./support/dom.ts).
import { actEnvironment, mountPoint } from "./support/dom.ts";
import {
  FakeAppState,
  appStateListenerCount,
  appStateLog,
  setAppState,
} from "./support/app-state.ts";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type AuthenticationDescriptor,
  type ClientMessage,
  type Credential,
  type Identity,
  type ServerMessage,
  type SubscriptionCursor,
} from "@dbzz/core";
import type { DbzzClientClock, DbzzWebSocket, QueryRef } from "@dbzz/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  DbzzAuthenticationState,
  DbzzProviderConfig,
  DbzzQueryState,
} from "@dbzz/client-react";

// The native entry composes the Expo/React Native platform modules, which
// only exist inside a React Native app; mocks stand in for all three. The
// AppState fake is shared with native-entry.test.ts so both files register
// the same module identity.
mock.module("react-native", () => ({ AppState: FakeAppState }));
mock.module("expo/fetch", () => ({
  fetch: () => Promise.reject(new Error("expo fetch is unused in this suite")),
}));
mock.module("expo-crypto", () => ({
  getRandomValues: (array: Uint32Array) => {
    array[0] = 0;
    return array;
  },
}));

const { DbzzProvider, useAuthentication, useConnectionState, useQuery } = await import(
  "../src/index.native.ts"
);

const USER_AUTHENTICATION = {
  principal: "user",
  identity: 7n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-before" },
} satisfies AuthenticationDescriptor;
const FOREGROUND_AUTHENTICATION = {
  principal: "user",
  identity: USER_AUTHENTICATION.identity,
  provenance: { issuer: "https://issuer.example", subject: "user-after" },
} satisfies AuthenticationDescriptor;

interface ClockTask {
  at: number;
  callback: () => void;
  intervalMs?: number;
}

class ManualClock implements DbzzClientClock {
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

class FakeSocket implements DbzzWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closeEvents: string[];
  closed = false;

  constructor(closeEvents: string[]) {
    this.closeEvents = closeEvents;
  }

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    parseClientMessage(decode(data));
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeEvents.push("socket-closed");
    this.onclose?.();
  }

  welcome(
    clientSessionId: string,
    descriptor: AuthenticationDescriptor = { principal: "anonymous" },
  ): void {
    this.onopen?.();
    this.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId,
      authEpoch: 0,
      ...descriptor,
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

const SESSION = "native-lifecycle-session";

interface Harness {
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  readonly closeOrder: string[];
  readonly config: DbzzProviderConfig;
  live(): FakeSocket;
}

function createHarness(credential: Credential = { kind: "anonymous" }): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  // Socket closes are recorded into the shared AppState log so listener
  // removal and socket teardown appear in one chronological sequence.
  const closeOrder = appStateLog;
  return {
    clock,
    sockets,
    closeOrder,
    config: {
      url: "http://native-lifecycle.test",
      credential,
      clientSessionId: SESSION,
      clock,
      random: () => 0,
      createWebSocket: () => {
        const socket = new FakeSocket(closeOrder);
        sockets.push(socket);
        return socket;
      },
    },
    live() {
      const socket = sockets.findLast((candidate) => !candidate.closed);
      if (!socket) throw new Error("no live socket");
      return socket;
    },
  };
}

type TodoArgs = { readonly list: bigint };
const todos = { $ref: "todos.list" } as QueryRef<TodoArgs, string[]>;

function cursor(commitVersion: bigint): SubscriptionCursor {
  return {
    generation: "generation-1",
    commitVersion,
    authEpoch: 0,
    identity: "todos.list:{list:1}",
  };
}

function describeQuery(state: DbzzQueryState<string[]>): string {
  switch (state.status) {
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    case "success":
      return `fresh:${state.data.join(",")}`;
    case "rejected":
      return `error:${state.error.code}`;
    case "unavailable":
      return state.data === undefined
        ? `error:${state.error.code}`
        : `stale:${state.data.join(",")}`;
  }
}

function Report(): ReactNode {
  const query = useQuery(todos, { list: 1n });
  const connection = useConnectionState();
  return (
    <span>
      {connection.phase}/{describeQuery(query)}
    </span>
  );
}

function describeAuthentication(state: DbzzAuthenticationState): string {
  if (state.phase === "authenticated" && state.authentication.principal === "user") {
    return `${state.authentication.identity}:${state.authentication.provenance.subject}`;
  }
  return state.phase;
}

function AuthenticationReport(): ReactNode {
  const authentication = useAuthentication();
  const connection = useConnectionState();
  return <span>{connection.phase}/{describeAuthentication(authentication.state)}</span>;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

async function platform(state: Parameters<typeof setAppState>[0]): Promise<void> {
  await act(async () => {
    setAppState(state);
  });
}

describe("native AppState lifecycle through the provider", () => {
  test("foreground reauthentication restores the same Identity before ready", async () => {
    actEnvironment(true);
    appStateLog.length = 0;
    setAppState("active");
    const harness = createHarness({ kind: "bearer", token: "token-a" });
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <DbzzProvider config={harness.config}>
          <AuthenticationReport />
        </DbzzProvider>
      </StrictMode>,
    );

    await act(async () => {
      harness.live().welcome(SESSION, USER_AUTHENTICATION);
    });
    expect(container.textContent).toBe("ready/7:user-before");

    await platform("background");
    expect(container.textContent).toBe("suspended/authenticating");
    await platform("active");
    expect(container.textContent).toBe("resuming/authenticating");
    const replacement = harness.live();
    await act(async () => {
      replacement.welcome(SESSION, FOREGROUND_AUTHENTICATION);
    });
    expect(container.textContent).toBe("ready/7:user-after");
    expect(replacement.framesOf("hello")[0]?.credential).toEqual({
      kind: "bearer",
      token: "token-a",
    });

    await act(async () => root.unmount());
    expect(appStateListenerCount()).toBe(0);
    actEnvironment(false);
  });

  test("a mounted query survives background suspension with one replacement socket", async () => {
    actEnvironment(true);
    appStateLog.length = 0;
    setAppState("active");
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <DbzzProvider config={harness.config}>
          <Report />
        </DbzzProvider>
      </StrictMode>,
    );

    // Strict Mode created and closed one probe lifetime; the surviving client
    // owns exactly one AppState listener.
    expect(appStateListenerCount()).toBe(1);

    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live();
    const subscription = first.framesOf("sub")[0]!;
    await act(async () => {
      first.receive({
        v: PROTOCOL_VERSION,
        t: "transition",
        id: subscription.id,
        transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
      });
    });
    expect(container.textContent).toBe("ready/fresh:one");

    // iOS inactive is observable but never retires the transport.
    await platform("inactive");
    expect(container.textContent).toBe("ready/fresh:one");
    expect(first.closed).toBe(false);

    // Background: suspended is published, data goes stale, the socket closes.
    const socketsBefore = harness.sockets.length;
    await platform("background");
    expect(container.textContent).toBe("suspended/stale:one");
    expect(first.closed).toBe(true);
    expect(harness.sockets.length).toBe(socketsBefore);

    // Duplicate active events coalesce into one replacement socket, dialed in
    // the activation turn.
    await platform("active");
    await platform("active");
    expect(harness.sockets.length).toBe(socketsBefore + 1);
    expect(container.textContent).toBe("resuming/stale:one");

    // Fresh handshake first; the held rows stay stale until the server
    // authoritatively confirms the resumed cursor.
    const second = harness.live();
    await act(async () => {
      second.welcome(SESSION);
    });
    expect(container.textContent).toBe("ready/stale:one");
    expect(second.framesOf("sub")[0]!.cursor).toEqual(cursor(1n));
    await act(async () => {
      second.receive({
        v: PROTOCOL_VERSION,
        t: "transition",
        id: subscription.id,
        transition: { kind: "resume", from: cursor(1n), to: cursor(1n) },
      });
    });
    expect(container.textContent).toBe("ready/fresh:one");

    // Unmount removes the AppState listener before the client closes its
    // socket: both events land in one chronological log.
    appStateLog.length = 0;
    await act(async () => {
      root.unmount();
    });
    expect(appStateListenerCount()).toBe(0);
    expect(appStateLog).toEqual(["listener-removed", "socket-closed"]);
    actEnvironment(false);
  });

  test("activation without demand keeps the native client idle", async () => {
    actEnvironment(true);
    setAppState("active");
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    function ConnectionOnly(): ReactNode {
      const connection = useConnectionState();
      return <span>{connection.phase}</span>;
    }

    await render(
      root,
      <DbzzProvider config={harness.config}>
        <ConnectionOnly />
      </DbzzProvider>,
    );
    // The provider establishes standing connect() demand, so this client
    // always redials on activation; the no-demand case is a base-client
    // behavior (see packages/client/test/suspension.test.ts). Here the
    // React-visible fact is the suspended -> resuming -> ready progression.
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    expect(container.textContent).toBe("ready");
    await platform("background");
    expect(container.textContent).toBe("suspended");
    await platform("active");
    expect(container.textContent).toBe("resuming");
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    expect(container.textContent).toBe("ready");
    await act(async () => {
      root.unmount();
    });
    actEnvironment(false);
  });
});
