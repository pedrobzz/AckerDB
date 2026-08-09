import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { createHarness, type ProviderHarness } from "./support/harness.ts";
import type { FakeSocket } from "ackerdb-test-support/client-transport";
import {
  ACKERDB_VERSION,
  type AuthenticationDescriptor,
  type ClientMessage,
  type Identity,
} from "@ackerdb/core";
import {
  AckerDBClientError,
  type AckerDBAuthentication,
  type AckerDBAuthenticationState,
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
const APP = { url: "http://auth.test", clientSessionId: SESSION_ID };

/**
 * Re-authentication must replace the connection, never add one: every read of
 * the socket here asserts the client is holding exactly one.
 */
function onlyLive(harness: ProviderHarness): FakeSocket {
  const open = harness.open();
  if (open.length !== 1) throw new Error(`expected one live socket, found ${open.length}`);
  return open[0]!;
}
const USER_AUTHENTICATION = {
  principal: "user",
  identity: 42n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;
const REFRESHED_USER_AUTHENTICATION = {
  principal: "user",
  identity: USER_AUTHENTICATION.identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1-refreshed" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;

function lastAuthFrame(socket: FakeSocket): Extract<ClientMessage, { t: "auth" }> {
  const frame = socket.frames().findLast((candidate) => candidate.t === "auth");
  if (!frame) throw new Error("No auth frame");
  return frame as Extract<ClientMessage, { t: "auth" }>;
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "anonymous" } })));
    expect(container.textContent).toBe("authenticating:anonymous|connecting");

    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID);
    });
    expect(container.textContent).toBe("unauthenticated@0|ready");

    await act(async () => {
      root.unmount();
    });
    expect(harness.sockets.every((socket) => socket.closed)).toBe(true);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("a bearer connection reports authenticated with the confirmed principal", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "bearer", token: "token-a" } })));
    expect(container.textContent).toBe("authenticating:bearer|connecting");

    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION, 3);
    });
    expect(container.textContent).toBe("authenticated:user@3|ready");
    await act(async () => {
      root.unmount();
    });
  });

  test("refresh runs once under Strict Mode with stable operation identities", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "bearer", token: "token-a" } })));
    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION);
    });

    operationIdentities.length = 0;
    let refresh!: Promise<AckerDBAuthentication>;
    await act(async () => {
      refresh = operations().refresh({ kind: "bearer", token: "token-b" });
    });
    // One user action produced exactly one protocol attempt across every
    // socket of the Strict Mode double-mounted tree.
    expect(harness.frames("auth")).toHaveLength(1);
    expect(container.textContent).toBe("authenticating:bearer|ready");

    const attempt = lastAuthFrame(onlyLive(harness));
    expect(attempt.credential).toEqual({ kind: "bearer", token: "token-b" });
    await act(async () => {
      onlyLive(harness).receive({
        v: ACKERDB_VERSION,
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
      "credentialTtlMs",
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const config = harness.config({ credential: { kind: "bearer", token: "token-a" } });
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
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION);
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");

    effectSignOuts.length = 0;
    await render(root, tree(true));
    // Strict Mode ran the effect twice; both invocations joined one attempt
    // and one auth frame, with no auth_stale rejection for the first caller.
    expect(effectSignOuts).toHaveLength(2);
    expect(effectSignOuts[1]).toBe(effectSignOuts[0]!);
    expect(harness.frames("auth")).toHaveLength(1);
    const attempt = lastAuthFrame(onlyLive(harness));
    expect(attempt.credential).toEqual({ kind: "anonymous" });
    await act(async () => {
      onlyLive(harness).receive({
        v: ACKERDB_VERSION,
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "bearer", token: "token-a" } })));
    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION);
    });

    let refresh!: Promise<unknown>;
    await act(async () => {
      refresh = operations()
        .refresh({ kind: "bearer", token: "token-bad" })
        .catch((error: unknown) => error);
    });
    // The server rejects the refreshed credential by terminating the session.
    await act(async () => {
      onlyLive(harness).receive({
        v: ACKERDB_VERSION,
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "bearer", token: "token-a" } })));
    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION);
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");

    let signOut!: Promise<AckerDBAuthentication>;
    await act(async () => {
      signOut = operations().signOut();
    });
    expect(container.textContent).toBe("authenticating:anonymous|ready");
    const attempt = lastAuthFrame(onlyLive(harness));
    expect(attempt.credential).toEqual({ kind: "anonymous" });
    await act(async () => {
      onlyLive(harness).receive({
        v: ACKERDB_VERSION,
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
      onlyLive(harness).close();
    });
    expect(container.textContent).toBe("authenticating:anonymous|reconnecting");
    await act(async () => {
      harness.clock.advance(100);
    });
    const replacement = onlyLive(harness);
    await act(async () => {
      replacement.welcome(SESSION_ID);
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "bearer", token: "token-expired" } })));
    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION);
    });

    await act(async () => {
      onlyLive(harness).close();
    });
    expect(container.textContent).toBe("authenticating:bearer|reconnecting");
    await act(async () => {
      harness.clock.advance(100);
    });
    // The reconnect handshake presents the stored credential; the server
    // rejects the expired token before welcome.
    const reconnecting = onlyLive(harness);
    await act(async () => {
      reconnecting.open();
      reconnecting.receive({
        v: ACKERDB_VERSION,
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
    const recovered = onlyLive(harness);
    await act(async () => {
      recovered.welcome(SESSION_ID, USER_AUTHENTICATION);
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config({ credential: { kind: "bearer", token: "token-a" } })));
    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID, USER_AUTHENTICATION);
    });
    expect(container.textContent).toBe("authenticated:user@0|ready");
    const firstLifetime = onlyLive(harness);
    const firstRefresh = operations().refresh;

    // A changed configuration is the React form of provider close: the old
    // client closes and the new lifetime starts unconfirmed.
    await render(
      root,
      app(
        harness.config({
          credential: { kind: "anonymous" },
          url: "http://replacement.test",
        }),
      ),
    );
    expect(firstLifetime.closed).toBe(true);
    expect(container.textContent).toBe("authenticating:anonymous|connecting");
    expect(operations().refresh).not.toBe(firstRefresh);

    // Operations bound to the closed lifetime reject with the exact error.
    const stale = await firstRefresh({ kind: "bearer", token: "token-b" }).catch(
      (error: unknown) => error,
    );
    expect(stale).toMatchObject({ code: "unavailable", message: "client is closed" });

    await act(async () => {
      onlyLive(harness).welcome(SESSION_ID);
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

describe("credential-source provider", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  test("the provider forwards the source; refresh() re-pulls it and signOut() is the source's sign-out", async () => {
    let signedIn = false;
    let pulls = 0;
    const harness = createHarness({
      ...APP,
      credentialSource: async () => {
        pulls += 1;
        return signedIn
          ? { kind: "bearer", token: `token-${pulls}` }
          : { kind: "anonymous" };
      },
    });
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config()));
    // The commit's act() already flushed the first pull (Strict Mode's replay
    // makes it two clients, each pulling once): the source produced the
    // signed-out anonymous credential and it is being presented.
    expect(container.textContent).toContain("authenticating:anonymous");
    expect(pulls).toBeGreaterThanOrEqual(1);
    await act(flush);
    onlyLive(harness).welcome(SESSION_ID);
    await act(flush);
    expect(container.textContent).toContain("unauthenticated@0");

    // The identity SDK signed in; refresh() re-invokes the source with no
    // credential handling in the React tree.
    signedIn = true;
    let refreshed!: Promise<AckerDBAuthentication>;
    await act(async () => {
      refreshed = operations().refresh();
      await flush();
    });
    const socket = onlyLive(harness);
    const attempt = lastAuthFrame(socket);
    expect(attempt.credential).toEqual({ kind: "bearer", token: `token-${pulls}` });
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
      credentialTtlMs: 60_000,
    });
    await act(flush);
    expect((await refreshed).principal).toBe("user");
    expect(container.textContent).toContain("authenticated:user@1");

    // signOut() re-pulls the source too — the SDK signed out, so the source
    // produces the explicit anonymous credential.
    signedIn = false;
    let signedOut!: Promise<AckerDBAuthentication>;
    await act(async () => {
      signedOut = operations().signOut();
      await flush();
    });
    const outFrame = lastAuthFrame(onlyLive(harness));
    expect(outFrame.credential).toEqual({ kind: "anonymous" });
    onlyLive(harness).receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: outFrame.attemptId,
      authEpoch: 2,
      principal: "anonymous",
    });
    await act(flush);
    expect((await signedOut).principal).toBe("anonymous");
    expect(container.textContent).toContain("unauthenticated@2");
    await render(root, <></>);
  });
});

describe("honest sign-out", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  test("source-mode signOut rejects while the source still produces a signed-in credential", async () => {
    let signedIn = true;
    const harness = createHarness({
      ...APP,
      credentialSource: async () =>
        signedIn ? { kind: "bearer", token: "still-here" } : { kind: "anonymous" },
    });
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness.config()));
    await act(flush);
    onlyLive(harness).welcome(SESSION_ID, { ...USER_AUTHENTICATION, credentialTtlMs: 60_000 });
    await act(flush);
    expect(container.textContent).toContain("authenticated:user");

    // The app forgot to sign out of the identity SDK first: the source still
    // mints a signed-in credential, so signOut must not claim success.
    let outcome: unknown;
    await act(async () => {
      const attemptPromise = operations().signOut();
      await flush();
      const socket = onlyLive(harness);
      const attempt = lastAuthFrame(socket);
      expect(attempt.credential).toEqual({ kind: "bearer", token: "still-here" });
      socket.receive({
        v: ACKERDB_VERSION,
        t: "auth",
        attemptId: attempt.attemptId,
        authEpoch: 1,
        ...USER_AUTHENTICATION,
        credentialTtlMs: 60_000,
      });
      outcome = await attemptPromise.catch((error: unknown) => error);
    });
    expect(outcome).toBeInstanceOf(AckerDBClientError);
    expect((outcome as AckerDBClientError).code).toBe("conflict");
    expect(container.textContent).toContain("authenticated:user@1");

    // After the SDK sign-out, the same call resolves anonymous.
    signedIn = false;
    await act(async () => {
      const attemptPromise = operations().signOut();
      await flush();
      const socket = onlyLive(harness);
      const attempt = lastAuthFrame(socket);
      expect(attempt.credential).toEqual({ kind: "anonymous" });
      socket.receive({
        v: ACKERDB_VERSION,
        t: "auth",
        attemptId: attempt.attemptId,
        authEpoch: 2,
        principal: "anonymous",
      });
      outcome = await attemptPromise;
    });
    expect((outcome as { principal: string }).principal).toBe("anonymous");
    await render(root, <></>);
  });
});
