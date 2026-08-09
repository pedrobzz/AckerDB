import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "ackerdb-test-support/dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AckerDBAuthentication, AckerDBWebSocket, QueryRef } from "@ackerdb/client";
import { anyApi } from "@ackerdb/client";
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
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedUserCredential,
} from "../../server/src/auth/credentials.ts";
import { StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AckerDBProvider,
  useAuthentication,
  useConnectionState,
  useQuery,
  type Credential,
  type AckerDBAuthenticationState,
  type UseAuthenticationResult,
} from "@ackerdb/client-react";
import { until } from "ackerdb-test-support/async";

const WAIT_DEADLINE_MS = 5_000;

const schema = defineSchema({
  notes: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const listRef = anyApi.notes.list as QueryRef<
  Record<string, never>,
  readonly { id: bigint; body: string }[]
>;

// The Runtime-owned lease fixture: every bearer token verifies as a user whose
// lease expires at the token's configured deadline.
class LeaseVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "invalidation", deadlineMs: 1 } as const;
  readonly expirations = new Map<string, number>();
  private readonly listeners = new Set<(invalidation: PrincipalInvalidation) => void>();

  async verify(token: string): Promise<VerifiedUserCredential> {
    return {
      kind: "user",
      issuer: "https://issuer.example",
      subject: token,
      claims: {},
      expiresAt: this.expirations.get(token) ?? Date.now() + 60_000,
      tokenId: `id-${token}`,
    };
  }

  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

interface App {
  readonly base: string;
  readonly verifier: LeaseVerifier;
  close(): Promise<void>;
}

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-auth-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
    notes: {
      list: query({
        access: "authenticated",
        args: {},
        handler: (ctx: Ctx) => ctx.db.notes.query().collect(),
      }),
    },
  });
  const verifier = new LeaseVerifier();
  const runtime = new Runtime({
    engine,
    registry,
    verifier,
    limits: PRODUCTION_LIMITS,
    telemetry: false,
  });
  const server = serve({ runtime, port: 0 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    verifier,
    async close() {
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
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

const captured: { auth?: UseAuthenticationResult; text?: string; query?: string } = {};

function AuthReport(): ReactNode {
  const result = useAuthentication();
  const connection = useConnectionState();
  captured.auth = result;
  captured.text = `${describeAuthentication(result.state)}|${connection.phase}`;
  return <span>{captured.text}</span>;
}

// Authenticated live-query demand rendered next to the authentication surface:
// its recovery proves the reconnect handshake completes before work restores.
function QueryReport(): ReactNode {
  const state = useQuery(listRef, {});
  captured.query = state.status;
  return <span>{state.status}</span>;
}

function mount(app: App, credential: Credential): Root {
  captured.auth = undefined;
  captured.text = undefined;
  captured.query = undefined;
  const container = mountPoint();
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <AckerDBProvider
        config={{
          url: app.base,
          credential,
          reconnect: { baseDelayMs: 1, maxDelayMs: 10, stableOpenMs: 60_000 },
          createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
        }}
      >
        <AuthReport />
        <QueryReport />
      </AckerDBProvider>
    </StrictMode>,
  );
  return root;
}

function operations(): UseAuthenticationResult {
  if (!captured.auth) throw new Error("No captured authentication result");
  return captured.auth;
}

let app: App;
beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());

describe("useAuthentication against a real ackerdb server", () => {
  test("authenticates a bearer connection, signs out, and refreshes identities", async () => {
    const root = mount(app, { kind: "bearer", token: "user-a" });
    await until(
      () => captured.text === "authenticated:user@0|ready" && captured.query === "success",
      "the authenticated ready state with live data",
    );
    const initial = operations().state;
    if (initial.phase !== "authenticated" || initial.authentication.principal !== "user") {
      throw new Error(`unexpected ${initial.phase}`);
    }
    expect(initial.authentication.provenance).toEqual({
      issuer: "https://issuer.example",
      subject: "user-a",
    });

    // Sign-out is a server-observed auth transition to the anonymous principal.
    const signedOut: AckerDBAuthentication = await operations().signOut();
    expect(signedOut).toEqual({ authEpoch: 1, principal: "anonymous" });
    await until(
      () => captured.text === "unauthenticated@1|ready",
      "the signed-out anonymous state",
    );
    // The authenticated query lost access with the retired epoch.
    await until(() => captured.query === "rejected", "the revoked authenticated query");

    const refreshed = await operations().refresh({ kind: "bearer", token: "user-b" });
    expect(refreshed).toMatchObject({
      authEpoch: 2,
      principal: "user",
      provenance: { issuer: "https://issuer.example", subject: "user-b" },
    });
    if (refreshed.principal !== "user") throw new Error("expected user authentication");
    expect(refreshed.identity).not.toBe(initial.authentication.identity);
    await until(
      () => captured.text === "authenticated:user@2|ready",
      "the refreshed authenticated state",
    );
    root.unmount();
  }, 15_000);

  test("server-side lease expiry blocks the session until a fresh credential arrives", async () => {
    app.verifier.expirations.set("expiring", Date.now() + 1_000);
    const root = mount(app, { kind: "bearer", token: "expiring" });
    await until(
      () => captured.text === "authenticated:user@0|ready" && captured.query === "success",
      "the authenticated ready state before expiry",
    );

    // The server terminates the session when the lease expires; the client
    // must hold refresh-required and not reconnect on its own.
    await until(
      () => captured.text === "refresh-required:unauthenticated|authentication-blocked",
      "the expired lease to block the session",
    );
    await Bun.sleep(50);
    expect(captured.text).toBe("refresh-required:unauthenticated|authentication-blocked");

    // A fresh credential replays the connect handshake and only then restores
    // the authenticated live query.
    const refreshed = await operations().refresh({ kind: "bearer", token: "fresh" });
    expect(refreshed.principal).toBe("user");
    await until(
      () => captured.text === `authenticated:user@${refreshed.authEpoch}|ready`,
      "the refreshed session after expiry",
    );
    await until(() => captured.query === "success", "the authenticated query to recover");
    root.unmount();
  }, 15_000);
});
