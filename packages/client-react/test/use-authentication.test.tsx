import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type ClientMessage,
  type Credential,
  type ServerMessage,
} from "@dbzz/core";
import type {
  DbzzAuthentication,
  DbzzAuthenticationState,
  DbzzClientClock,
  DbzzClientError,
  DbzzWebSocket,
} from "@dbzz/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DbzzProvider,
  useAuthentication,
  useConnectionState,
  type DbzzProviderConfig,
  type UseAuthenticationResult,
} from "@dbzz/client-react";

const SESSION_ID = "react-auth-session";

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

  open(): void {
    this.onopen?.();
  }

  receive(frame: ServerMessage): void {
    this.onmessage?.({ data: encode(frame) });
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => parseClientMessage(decode(text)));
  }
}

function lastAuthFrame(socket: FakeSocket): Extract<ClientMessage, { t: "auth" }> {
  const frame = socket.frames().findLast((candidate) => candidate.t === "auth");
  if (!frame) throw new Error("No auth frame");
  return frame as Extract<ClientMessage, { t: "auth" }>;
}

interface Harness {
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  config(credential: Credential, url?: string): DbzzProviderConfig;
  live(): FakeSocket;
  authFrames(): Extract<ClientMessage, { t: "auth" }>[];
}

function createHarness(): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  return {
    clock,
    sockets,
    config(credential, url = "http://auth.test") {
      return {
        url,
        credential,
        clientSessionId: SESSION_ID,
        clock,
        random: () => 0,
        createWebSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      };
    },
    live() {
      const open = sockets.filter((socket) => !socket.closed);
      if (open.length !== 1) throw new Error(`expected one live socket, found ${open.length}`);
      return open[0]!;
    },
    authFrames() {
      return sockets.flatMap(
        (socket) =>
          socket.frames().filter((frame) => frame.t === "auth") as Extract<
            ClientMessage,
            { t: "auth" }
          >[],
      );
    },
  };
}

function welcome(socket: FakeSocket, principal: "anonymous" | "user" = "anonymous", authEpoch = 0): void {
  socket.open();
  socket.receive({ v: PROTOCOL_VERSION, t: "welcome", clientSessionId: SESSION_ID, authEpoch, principal });
}

function describeAuthentication(state: DbzzAuthenticationState): string {
  switch (state.phase) {
    case "authenticating":
      return `authenticating:${state.credential}`;
    case "unauthenticated":
      return `unauthenticated@${state.authentication.authEpoch}`;
    case "authenticated":
      return `authenticated:${state.authentication.principal}@${state.authentication.authEpoch}`;
    case "refresh-required":
      return `refresh-required:${state.error.code}`;
    case "failed":
      return `failed:${state.error.code}`;
    case "closed":
      return "closed";
  }
}

const captured: { auth?: UseAuthenticationResult } = {};
const operationIdentities: UseAuthenticationResult["refresh"][] = [];

function AuthProbe(): ReactNode {
  const result = useAuthentication();
  captured.auth = result;
  operationIdentities.push(result.refresh);
  return <span>{describeAuthentication(result.state)}</span>;
}

// Rendered next to AuthProbe so every assertion on the combined text content
// is a coherence assertion across the two public state surfaces.
function ConnectionProbe(): ReactNode {
  const state = useConnectionState();
  return <span>|{state.phase}</span>;
}

function app(config: DbzzProviderConfig): ReactNode {
  return (
    <StrictMode>
      <DbzzProvider config={config}>
        <AuthProbe />
        <ConnectionProbe />
      </DbzzProvider>
    </StrictMode>
  );
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function operations(): UseAuthenticationResult {
  if (!captured.auth) throw new Error("No captured authentication result");
  return captured.auth;
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useAuthentication", () => {
  test("an anonymous connection reports authenticating then unauthenticated, coherently", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "anonymous" })));
    expect(container.textContent).toBe("authenticating:anonymous|connecting");

    await act(async () => {
      welcome(harness.live());
    });
    expect(container.textContent).toBe("unauthenticated@0|ready");

    await act(async () => {
      root.unmount();
    });
    expect(harness.sockets.every((socket) => socket.closed)).toBe(true);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("a bearer connection reports authenticated with the confirmed principal", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "bearer", token: "token-a" })));
    expect(container.textContent).toBe("authenticating:bearer|connecting");

    await act(async () => {
      welcome(harness.live(), "user", 3);
    });
    expect(container.textContent).toBe("authenticated:user@3|ready");
    await act(async () => {
      root.unmount();
    });
  });

  test("refresh runs once under Strict Mode with stable operation identities", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "bearer", token: "token-a" })));
    await act(async () => {
      welcome(harness.live(), "user");
    });

    operationIdentities.length = 0;
    let refresh!: Promise<DbzzAuthentication>;
    await act(async () => {
      refresh = operations().refresh({ kind: "bearer", token: "token-b" });
    });
    // One user action produced exactly one protocol attempt across every
    // socket of the Strict Mode double-mounted tree.
    expect(harness.authFrames()).toHaveLength(1);
    expect(container.textContent).toBe("authenticating:bearer|ready");

    const attempt = lastAuthFrame(harness.live());
    expect(attempt.credential).toEqual({ kind: "bearer", token: "token-b" });
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: attempt.attemptId,
        authEpoch: 5,
        principal: "user",
      });
    });
    expect(await refresh).toEqual({ authEpoch: 5, principal: "user" });
    expect(container.textContent).toBe("authenticated:user@5|ready");

    // Every committed render of this lifetime observed the same callable.
    expect(new Set(operationIdentities).size).toBe(1);
    await act(async () => {
      root.unmount();
    });
    expect(harness.clock.taskCount).toBe(0);
  });

  test("refresh failure preserves the exact error in the state and the rejection", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "bearer", token: "token-a" })));
    await act(async () => {
      welcome(harness.live(), "user");
    });

    let refresh!: Promise<unknown>;
    await act(async () => {
      refresh = operations()
        .refresh({ kind: "bearer", token: "token-bad" })
        .catch((error: unknown) => error);
    });
    // The server rejects the refreshed credential by terminating the session.
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "err",
        id: null,
        outcome: { code: "unauthenticated", retryable: false, message: "invalid credential" },
      });
    });
    const rejection = await refresh;
    expect(rejection).toMatchObject({ code: "unauthenticated", message: "invalid credential" });
    expect(container.textContent).toBe("refresh-required:unauthenticated|authentication-blocked");
    const state = operations().state;
    if (state.phase !== "refresh-required") throw new Error(`unexpected ${state.phase}`);
    expect(state.error).toBe(rejection as DbzzClientError);
    await act(async () => {
      root.unmount();
    });
    expect(harness.clock.taskCount).toBe(0);
  });

  test("sign-out presents the anonymous credential and reconnects signed out", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "bearer", token: "token-a" })));
    await act(async () => {
      welcome(harness.live(), "user");
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");

    let signOut!: Promise<DbzzAuthentication>;
    await act(async () => {
      signOut = operations().signOut();
    });
    expect(container.textContent).toBe("authenticating:anonymous|ready");
    const attempt = lastAuthFrame(harness.live());
    expect(attempt.credential).toEqual({ kind: "anonymous" });
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: attempt.attemptId,
        authEpoch: 1,
        principal: "anonymous",
      });
    });
    expect(await signOut).toEqual({ authEpoch: 1, principal: "anonymous" });
    expect(container.textContent).toBe("unauthenticated@1|ready");

    // The stored credential is now anonymous: the reconnect handshake presents
    // it before any authenticated work is restored.
    await act(async () => {
      harness.live().close();
    });
    expect(container.textContent).toBe("authenticating:anonymous|reconnecting");
    await act(async () => {
      harness.clock.advance(100);
    });
    const replacement = harness.live();
    await act(async () => {
      welcome(replacement);
    });
    const hello = replacement.frames().find((frame) => frame.t === "hello");
    if (hello?.t !== "hello") throw new Error("expected a hello frame");
    expect(hello.credential).toEqual({ kind: "anonymous" });
    expect(container.textContent).toBe("unauthenticated@0|ready");
    await act(async () => {
      root.unmount();
    });
  });

  test("credential expiry during reconnect blocks until a new credential is presented", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "bearer", token: "token-expired" })));
    await act(async () => {
      welcome(harness.live(), "user");
    });

    await act(async () => {
      harness.live().close();
    });
    expect(container.textContent).toBe("authenticating:bearer|reconnecting");
    await act(async () => {
      harness.clock.advance(100);
    });
    // The reconnect handshake presents the stored credential; the server
    // rejects the expired token before welcome.
    const reconnecting = harness.live();
    await act(async () => {
      reconnecting.open();
      reconnecting.receive({
        v: PROTOCOL_VERSION,
        t: "err",
        id: null,
        outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
      });
    });
    expect(container.textContent).toBe("refresh-required:unauthenticated|authentication-blocked");

    let refresh!: Promise<DbzzAuthentication>;
    await act(async () => {
      refresh = operations().refresh({ kind: "bearer", token: "token-fresh" });
    });
    expect(container.textContent).toBe("authenticating:bearer|reconnecting");
    const recovered = harness.live();
    await act(async () => {
      welcome(recovered);
    });
    const attempt = lastAuthFrame(recovered);
    expect(attempt.credential).toEqual({ kind: "bearer", token: "token-fresh" });
    await act(async () => {
      recovered.receive({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: attempt.attemptId,
        authEpoch: 1,
        principal: "user",
      });
    });
    expect(await refresh).toEqual({ authEpoch: 1, principal: "user" });
    expect(container.textContent).toBe("authenticated:user@1|ready");
    await act(async () => {
      root.unmount();
    });
    expect(harness.clock.taskCount).toBe(0);
  });

  test("provider reconfiguration closes the old lifetime and starts a detached one", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ kind: "bearer", token: "token-a" })));
    await act(async () => {
      welcome(harness.live(), "user");
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");
    const firstLifetime = harness.live();
    const firstRefresh = operations().refresh;

    // A changed configuration is the React form of provider close: the old
    // client closes and the new lifetime starts unconfirmed.
    await render(root, app(harness.config({ kind: "anonymous" }, "http://replacement.test")));
    expect(firstLifetime.closed).toBe(true);
    expect(container.textContent).toBe("authenticating:anonymous|connecting");
    expect(operations().refresh).not.toBe(firstRefresh);

    // Operations bound to the closed lifetime reject with the exact error.
    const stale = await firstRefresh({ kind: "bearer", token: "token-b" }).catch(
      (error: unknown) => error,
    );
    expect(stale).toMatchObject({ code: "unavailable", message: "client is closed" });

    await act(async () => {
      welcome(harness.live());
    });
    expect(container.textContent).toBe("unauthenticated@0|ready");
    await act(async () => {
      root.unmount();
    });
    expect(harness.sockets.every((socket) => socket.closed)).toBe(true);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("useAuthentication outside a provider fails loudly", () => {
    expect(() => {
      const container = mountPoint();
      const root = createRoot(container);
      act(() => {
        root.render(<AuthProbe />);
      });
    }).toThrow("useAuthentication requires a <DbzzProvider> ancestor");
  });
});
