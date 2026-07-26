import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
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
} from "@ackerdb/core";
import type {
  AckerDBAuthentication,
  AckerDBAuthenticationState,
  AckerDBClientClock,
  AckerDBClientError,
  AckerDBWebSocket,
} from "@ackerdb/client";
import { StrictMode, act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AckerDBProvider,
  useAuthentication,
  useConnectionState,
  type AckerDBProviderConfig,
  type UseAuthenticationResult,
} from "@ackerdb/client-react";

const SESSION_ID = "react-auth-session";
const USER_AUTHENTICATION = {
  principal: "user",
  identity: 42n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1" },
} satisfies AuthenticationDescriptor;
const REFRESHED_USER_AUTHENTICATION = {
  principal: "user",
  identity: USER_AUTHENTICATION.identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1-refreshed" },
} satisfies AuthenticationDescriptor;

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

  get taskCount(): number {
    return this.tasks.size;
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
  config(credential: Credential, url?: string): AckerDBProviderConfig;
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

function welcome(
  socket: FakeSocket,
  descriptor: AuthenticationDescriptor = { principal: "anonymous" },
  authEpoch = 0,
): void {
  socket.open();
  socket.receive({
    v: PROTOCOL_VERSION,
    t: "welcome",
    clientSessionId: SESSION_ID,
    authEpoch,
    ...descriptor,
  });
}

function describeAuthentication(state: AckerDBAuthenticationState): string {
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

// An operation initiated from an effect: Strict Mode replays the effect, so
// this is the doubled-invocation scenario single-flight must absorb.
const effectSignOuts: Promise<AckerDBAuthentication>[] = [];

function AutoSignOut(): ReactNode {
  const { signOut } = useAuthentication();
  useEffect(() => {
    effectSignOuts.push(signOut());
  }, [signOut]);
  return null;
}

function app(config: AckerDBProviderConfig): ReactNode {
  return (
    <StrictMode>
      <AckerDBProvider config={config}>
        <AuthProbe />
        <ConnectionProbe />
      </AckerDBProvider>
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
      welcome(harness.live(), USER_AUTHENTICATION, 3);
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
      welcome(harness.live(), USER_AUTHENTICATION);
    });

    operationIdentities.length = 0;
    let refresh!: Promise<AckerDBAuthentication>;
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
        ...REFRESHED_USER_AUTHENTICATION,
      });
    });
    expect(await refresh).toEqual({ authEpoch: 5, ...REFRESHED_USER_AUTHENTICATION });
    const state = operations().state;
    if (state.phase !== "authenticated" || state.authentication.principal !== "user") {
      throw new Error(`unexpected ${state.phase}`);
    }
    expect(state.authentication.identity).toBe(USER_AUTHENTICATION.identity);
    expect(state.authentication.provenance).toEqual(REFRESHED_USER_AUTHENTICATION.provenance);
    expect(Object.keys(state.authentication).sort()).toEqual([
      "authEpoch",
      "identity",
      "principal",
      "provenance",
    ]);
    expect(container.textContent).toBe("authenticated:user@5|ready");

    // Every committed render of this lifetime observed the same callable.
    expect(new Set(operationIdentities).size).toBe(1);
    await act(async () => {
      root.unmount();
    });
    expect(harness.clock.taskCount).toBe(0);
  });

  test("a Strict Mode-replayed effect sign-out coalesces into one protocol attempt", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const config = harness.config({ kind: "bearer", token: "token-a" });
    const tree = (auto: boolean): ReactNode => (
      <StrictMode>
        <AckerDBProvider config={config}>
          <AuthProbe />
          <ConnectionProbe />
          {auto ? <AutoSignOut /> : null}
        </AckerDBProvider>
      </StrictMode>
    );
    await render(root, tree(false));
    await act(async () => {
      welcome(harness.live(), USER_AUTHENTICATION);
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");

    effectSignOuts.length = 0;
    await render(root, tree(true));
    // Strict Mode ran the effect twice; both invocations joined one attempt
    // and one auth frame, with no auth_stale rejection for the first caller.
    expect(effectSignOuts).toHaveLength(2);
    expect(effectSignOuts[1]).toBe(effectSignOuts[0]!);
    expect(harness.authFrames()).toHaveLength(1);
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
    expect(await effectSignOuts[0]).toEqual({ authEpoch: 1, principal: "anonymous" });
    expect(container.textContent).toBe("unauthenticated@1|ready");
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
      welcome(harness.live(), USER_AUTHENTICATION);
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
    expect(state.error).toBe(rejection as AckerDBClientError);
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
      welcome(harness.live(), USER_AUTHENTICATION);
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");

    let signOut!: Promise<AckerDBAuthentication>;
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
    const signedOut = operations().state;
    if (signedOut.phase !== "unauthenticated") throw new Error(`unexpected ${signedOut.phase}`);
    expect("identity" in signedOut.authentication).toBe(false);
    expect("provenance" in signedOut.authentication).toBe(false);

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
      welcome(harness.live(), USER_AUTHENTICATION);
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

    let refresh!: Promise<AckerDBAuthentication>;
    await act(async () => {
      refresh = operations().refresh({ kind: "bearer", token: "token-fresh" });
    });
    expect(container.textContent).toBe("authenticating:bearer|reconnecting");
    const recovered = harness.live();
    await act(async () => {
      welcome(recovered, USER_AUTHENTICATION);
    });
    // The recovery hello presented the fresh credential, so its welcome is
    // the verification: one round-trip, no separate auth frame.
    const hello = recovered.frames().find((frame) => frame.t === "hello");
    if (hello?.t !== "hello") throw new Error("expected a hello frame");
    expect(hello.credential).toEqual({ kind: "bearer", token: "token-fresh" });
    expect(recovered.frames().some((frame) => frame.t === "auth")).toBe(false);
    expect(await refresh).toEqual({ authEpoch: 0, ...USER_AUTHENTICATION });
    expect(container.textContent).toBe("authenticated:user@0|ready");
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
      welcome(harness.live(), USER_AUTHENTICATION);
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
    }).toThrow("useAuthentication requires a <AckerDBProvider> ancestor");
  });
});
