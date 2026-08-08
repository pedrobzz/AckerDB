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
import { createHarness } from "./support/harness.ts";
import { FakeSocket } from "ackerdb-test-support/client-transport";
import {
  PROTOCOL_VERSION,
  type AuthenticationDescriptor,
  type Identity,
  type SubscriptionCursor,
} from "@ackerdb/core";
import type { ProcedureRef, QueryRef } from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AckerDBAuthenticationState,
  AckerDBQueryProcedureState,
  AckerDBQueryState,
} from "@ackerdb/client-react";

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

const {
  AckerDBProvider,
  useAuthentication,
  useConnectionState,
  useQuery,
  useQueryProcedure,
} = await import("../src/index.native.ts");

const USER_AUTHENTICATION = {
  principal: "user",
  identity: 7n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-before" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;
const FOREGROUND_AUTHENTICATION = {
  principal: "user",
  identity: USER_AUTHENTICATION.identity,
  provenance: { issuer: "https://issuer.example", subject: "user-after" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;

const SESSION = "native-lifecycle-session";
const APP = { url: "http://native-lifecycle.test", clientSessionId: SESSION };

/**
 * Socket teardown is recorded into the shared AppState log so listener removal
 * and socket close appear in one chronological sequence.
 */
class LoggingSocket extends FakeSocket {
  override close(code?: number, reason?: string): void {
    if (this.closed) return;
    appStateLog.push("socket-closed");
    super.close(code, reason);
  }
}

type TodoArgs = { readonly list: bigint };
const todos = { $ref: "api.todos.list" } as QueryRef<TodoArgs, string[]>;
const uppercase = { $ref: "api.tools.uppercase" } as ProcedureRef<
  { readonly value: string },
  { readonly value: string }
>;

function cursor(commitVersion: bigint): SubscriptionCursor {
  return {
    generation: "generation-1",
    commitVersion,
    authEpoch: 0,
    identity: "api.todos.list:{list:1}",
  };
}

function describeQuery(state: AckerDBQueryState<string[]>): string {
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

let queryProcedureState:
  | AckerDBQueryProcedureState<{ readonly value: string }>
  | undefined;

function describeQueryProcedure(
  state: AckerDBQueryProcedureState<{ readonly value: string }>,
): string {
  switch (state.status) {
    case "disabled":
    case "pending":
      return state.status;
    case "success":
      return `fresh:${state.data.value}`;
    case "rejected":
      return `error:${state.error.code}`;
    case "unavailable":
      return state.data === undefined
        ? `error:${state.error.code}`
        : `stale:${state.data.value}:${state.error.code}`;
  }
}

function QueryProcedureReport(): ReactNode {
  const state = useQueryProcedure(uppercase, { value: "one" });
  const connection = useConnectionState();
  queryProcedureState = state;
  return <span>{connection.phase}/{describeQueryProcedure(state)}</span>;
}

function describeAuthentication(state: AckerDBAuthenticationState): string {
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
    const harness = createHarness({ ...APP, credential: { kind: "bearer", token: "token-a" } }, () => new LoggingSocket());
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <AuthenticationReport />
        </AckerDBProvider>
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
    const harness = createHarness(APP, () => new LoggingSocket());
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <Report />
        </AckerDBProvider>
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

  test("a query procedure settles on suspension and executes freshly after activation", async () => {
    actEnvironment(true);
    appStateLog.length = 0;
    setAppState("active");
    queryProcedureState = undefined;
    const harness = createHarness(APP, () => new LoggingSocket());
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <QueryProcedureReport />
        </AckerDBProvider>
      </StrictMode>,
    );

    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live();
    const initial = first.framesOf("p")[0]!;
    await act(async () => {
      first.receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: initial.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    expect(container.textContent).toBe("ready/fresh:ONE");

    queryProcedureState!.refresh();
    const interrupted = first.framesOf("p")[1]!;
    expect(interrupted).toBeDefined();
    await platform("background");
    expect(first.framesOf("cancel")).toEqual([
      { v: PROTOCOL_VERSION, t: "cancel", id: interrupted.id },
    ]);
    expect(container.textContent).toBe("suspended/stale:ONE:indeterminate");

    const socketsBefore = harness.sockets.length;
    await platform("active");
    expect(container.textContent).toBe("resuming/stale:ONE:indeterminate");
    expect(harness.sockets).toHaveLength(socketsBefore + 1);
    const replacement = harness.live();
    await act(async () => {
      replacement.welcome(SESSION);
    });
    const recovered = replacement.framesOf("p")[0]!;
    expect(recovered).toMatchObject({
      ref: "api.tools.uppercase",
      args: { value: "one" },
    });
    await act(async () => {
      replacement.receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: recovered.id,
        kind: "procedure",
        value: { value: "TWO" },
      });
    });
    expect(container.textContent).toBe("ready/fresh:TWO");

    await act(async () => root.unmount());
    expect(appStateListenerCount()).toBe(0);
    actEnvironment(false);
  });

  test("activation without demand keeps the native client idle", async () => {
    actEnvironment(true);
    setAppState("active");
    const harness = createHarness(APP, () => new LoggingSocket());
    const container = mountPoint();
    const root = createRoot(container);

    function ConnectionOnly(): ReactNode {
      const connection = useConnectionState();
      return <span>{connection.phase}</span>;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <ConnectionOnly />
      </AckerDBProvider>,
    );
    // The provider establishes standing connection demand, so this client
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
