import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { encode } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  verifyBearerCredential,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { credentials } from "../../src/auth/credential-context.ts";
import { CREDENTIAL_ISSUER } from "../../src/auth/credential-token.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { mcp as mcpDeclaration } from "../../src/mcp/index.ts";
import { query } from "../../src/app/functions.ts";
import { v } from "../../src/validation/v.ts";
import { serve } from "../../src/transport/server.ts";
import type { SessionApplicationMessage } from "../../src/subscriptions/session/contract.ts";
import {
  agentMcp,
  cleanupMcpTokenFixtures,
  databasePath,
  fixture,
  FIXTURE_SCOPES,
  mutationMessage,
  queryMessage,
  request,
  retainedOwnerContext,
  scopedMcp,
  session,
  subscribeMessage,
  trackCleanup,
  user,
} from "../support/mcp-token-fixture.ts";

afterEach(cleanupMcpTokenFixtures);

function mcpHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

function rpc(base: string, path: string, method: string, params: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function listedToolNames(response: Response): Promise<readonly string[]> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly result: { readonly tools: readonly { readonly name: string }[] };
  };
  return body.result.tools.map(({ name }) => name).sort();
}

interface CreatedValue {
  readonly id: string;
  readonly identity: bigint;
  readonly token: string;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

describe("Identity credentials", () => {
  test("creates one-time secrets in an ordinary mutation without persisting replayable plaintext", async () => {
    const { engine, runtime } = fixture(databasePath("ackerdb-credential-create-"));
    const alice = await user(runtime, "alice");
    const aliceSession = session(alice, "alice-session");
    await runtime.openSession(aliceSession);

    const firstMessage = mutationMessage(1, "1", {
      name: "Laptop",
      metadata: { device: "mac", sequence: 1n },
    });
    const first = await runtime.mutation(aliceSession, request(firstMessage));
    const created = first.value as CreatedValue;
    expect(created).toMatchObject({
      name: "Laptop",
      metadata: { device: "mac", sequence: 1n },
      scopes: [],
    });
    expect(created.token).toMatch(/^ackerdb_credential\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(created.token.split(".")[1]).toBe(created.id);
    expect(created).not.toHaveProperty("expiresAt");
    // The credential IS an Identity — a fresh child of its issuer.
    expect(created.identity).toBeGreaterThan(0n);
    expect(created.identity).not.toBe(alice.identity);

    const stored = engine.writer.query(
      "SELECT token_id, identity, parent_identity, secret_digest, name, metadata, scopes, created_at, updated_at FROM _ackerdb_credentials",
    ).get() as {
      token_id: string;
      identity: bigint;
      parent_identity: bigint;
      secret_digest: Uint8Array;
      name: string;
      metadata: string;
      scopes: string;
      created_at: number;
      updated_at: number;
    };
    const secret = created.token.split(".")[2]!;
    expect(stored).toMatchObject({
      token_id: created.id,
      identity: created.identity,
      parent_identity: alice.identity,
      name: "Laptop",
      scopes: "[]",
    });
    expect(Buffer.from(stored.secret_digest).toString("hex")).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    const storedText = JSON.stringify({
      ...stored,
      identity: stored.identity.toString(),
      parent_identity: stored.parent_identity.toString(),
    });
    expect(storedText).not.toContain(created.token);
    expect(storedText).not.toContain(secret);
    expect(
      engine.writer.query("SELECT result_disposition, result, result_bytes FROM _ackerdb_mutations").get(),
    ).toEqual({ result_disposition: "one-time", result: null, result_bytes: 0n });
    expect(() => credentials.create(retainedOwnerContext()!, {
      name: "Escaped context",
      metadata: {},
    })).toThrow("credential operations require an AckerDB invocation context");
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 1n });

    await expect(runtime.mutation(aliceSession, request(firstMessage))).rejects.toMatchObject({
      code: "conflict",
      message: "mutation committed, but its one-time result is no longer available",
    });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 1n });

    const second = await runtime.mutation(aliceSession, request(mutationMessage(2, "2", {
      name: "Desktop",
      metadata: {},
    })));
    expect((second.value as { token: string }).token).not.toBe(created.token);
    const listed = await runtime.query(aliceSession, request(queryMessage(3))) as readonly Record<string, unknown>[];
    expect(listed.map(({ name }) => name)).toEqual(["Laptop", "Desktop"]);
    expect(listed.every((token) => !("token" in token) && !("expiresAt" in token))).toBe(true);
    expect(encode(listed)).not.toContain(secret);

    const bob = await user(runtime, "bob");
    const bobSession = session(bob, "bob-session");
    await runtime.openSession(bobSession);
    expect(await runtime.query(bobSession, request(queryMessage(4)))).toEqual([]);
    await expect(runtime.mutation(aliceSession, request(mutationMessage(5, "3", {
      name: "x".repeat(PRODUCTION_LIMITS.credentials.maxNameBytes + 1),
      metadata: {},
    })))).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.mutation(aliceSession, request(mutationMessage(6, "4", {
      name: "Too much metadata",
      metadata: { value: "x".repeat(PRODUCTION_LIMITS.credentials.maxMetadataBytes) },
    })))).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.mutation(aliceSession, request(mutationMessage(7, "5", {
      name: "Over capacity",
      metadata: {},
    })))).rejects.toMatchObject({ code: "overloaded" });
  });

  test("reactively edits and revokes only the owner's descriptors", async () => {
    const { engine, runtime } = fixture(databasePath("ackerdb-credential-lifecycle-"));
    const alice = await user(runtime, "lifecycle-alice");
    const publications: SessionApplicationMessage[] = [];
    const aliceSession = session(alice, "lifecycle-alice-session", publications);
    await runtime.openSession(aliceSession);
    await runtime.subscribe(aliceSession, request(subscribeMessage(100)));

    const lifecycleTransitions = () => publications.filter((message) =>
      message.t === "transition" && message.id === 100 &&
      (message.transition.kind === "reset" || message.transition.kind === "update")
    );
    expect(lifecycleTransitions()).toHaveLength(1);
    expect(lifecycleTransitions()[0]).toMatchObject({ transition: { kind: "reset", value: [] } });

    const created = (await runtime.mutation(aliceSession, request(mutationMessage(101, "101", {
      name: "Laptop",
      metadata: { device: "mac" },
    })))).value as CreatedValue;
    expect(lifecycleTransitions()).toHaveLength(2);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: { kind: "update", value: [{ id: created.id, name: "Laptop" }] },
    });

    const before = engine.reader.query(
      "SELECT secret_digest, scopes FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(created.id) as { readonly secret_digest: Uint8Array; readonly scopes: string };
    const active = await runtime.authenticateCredential(created.token, "before-edit");

    await runtime.mutation(aliceSession, request(mutationMessage(
      102,
      "102",
      { id: created.id, name: "Personal Codex" },
      "tokens.renameAgentToken",
    )));
    expect(lifecycleTransitions()).toHaveLength(3);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: { kind: "update", value: [{ name: "Personal Codex", metadata: { device: "mac" } }] },
    });

    await runtime.mutation(aliceSession, request(mutationMessage(
      103,
      "103",
      { id: created.id, metadata: { device: "mac", color: "blue", generation: 2n } },
      "tokens.updateAgentTokenMetadata",
    )));
    expect(lifecycleTransitions()).toHaveLength(4);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: {
        kind: "update",
        value: [{ name: "Personal Codex", metadata: { device: "mac", color: "blue", generation: 2n } }],
      },
    });

    const after = engine.reader.query(
      "SELECT secret_digest, scopes FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(created.id) as { readonly secret_digest: Uint8Array; readonly scopes: string };
    expect(Buffer.from(after.secret_digest)).toEqual(Buffer.from(before.secret_digest));
    expect(after.scopes).toBe(before.scopes);
    expect(await runtime.authenticateCredential(created.token, "after-edit"))
      .toMatchObject({ identity: created.identity, tokenId: created.id });
    const activeResult = await runtime.runMcpTool({
      id: "active-through-descriptor-edit",
      authorization: runtime.authorizeMcpTool("agent", "write_owned_record", active),
      args: { value: "still-active" },
      principal: active,
    });
    expect(activeResult.structuredContent).toMatchObject({
      principal: `user:${created.identity}`,
    });

    for (const [id, args, ref] of [
      [104, { id: created.id, metadata: { value: "x".repeat(PRODUCTION_LIMITS.credentials.maxMetadataBytes) } }, "tokens.updateAgentTokenMetadata"],
      [105, { id: created.id, kind: "empty" }, "tokens.invalidAgentTokenUpdate"],
      [106, { id: created.id, kind: "undefined" }, "tokens.invalidAgentTokenUpdate"],
    ] as const) {
      await expect(runtime.mutation(aliceSession, request(mutationMessage(id, String(id), args, ref))))
        .rejects.toMatchObject({ code: "validation" });
    }
    expect(lifecycleTransitions()).toHaveLength(4);

    const bob = await user(runtime, "lifecycle-bob");
    const bobSession = session(bob, "lifecycle-bob-session");
    await runtime.openSession(bobSession);
    expect(await runtime.query(bobSession, request(queryMessage(107)))).toEqual([]);
    for (const [id, context, args, ref] of [
      [109, bobSession, { id: created.id, name: "Stolen" }, "tokens.renameAgentToken"],
      [110, bobSession, { id: created.id }, "tokens.revokeAgentToken"],
    ] as const) {
      await expect(runtime.mutation(context, request(mutationMessage(id, String(id), args, ref))))
        .rejects.toMatchObject({ code: "not_found" });
    }
    expect(lifecycleTransitions()).toHaveLength(4);
    const unchanged = await runtime.query(
      aliceSession,
      request(queryMessage(113)),
    ) as readonly Record<string, unknown>[];
    expect(unchanged).toMatchObject([{
      id: created.id,
      name: "Personal Codex",
      metadata: { device: "mac", color: "blue", generation: 2n },
    }]);
    expect(unchanged[0]).not.toHaveProperty("token");
    expect(await runtime.authenticateCredential(created.token, "after-isolation-checks"))
      .toMatchObject({ identity: created.identity, tokenId: created.id });

    await runtime.mutation(aliceSession, request(mutationMessage(
      114,
      "114",
      { id: created.id },
      "tokens.revokeAgentToken",
    )));
    expect(lifecycleTransitions()).toHaveLength(5);
    expect(lifecycleTransitions().at(-1)).toMatchObject({ transition: { kind: "update", value: [] } });
    await expect(runtime.authenticateCredential(created.token, "after-revoke"))
      .rejects.toMatchObject({ code: "unauthenticated" });

    const server = serve({ runtime, port: 0 });
    trackCleanup(async () => server.drain());
    const response = await rpc(
      `http://127.0.0.1:${server.port}`,
      "/agent/mcp",
      "ping",
      {},
      created.token,
    );
    expect(response.status).toBe(401);
  });

  test("stores exact immutable grants and enforces explicit authenticated, any-of, and all-of policy", async () => {
    const { engine, runtime } = fixture(databasePath("ackerdb-credential-scopes-"));
    const alice = await user(runtime, "scoped-alice", FIXTURE_SCOPES);
    const aliceSession = session(alice, "scoped-alice-session");
    await runtime.openSession(aliceSession);

    // Tool access requirements share the one structural shape every
    // function's `scopes` uses; malformed policies fail at declaration.
    const policyProbe = query({
      description: "Runtime validation cannot be bypassed by a cast.",
      access: "public",
      args: {},
      returns: v.object({}),
      handler: () => ({}),
    });
    const invalidEndpoint = (name: string, access: unknown) => mcpDeclaration({
      name,
      path: `/${name}`,
      tools: { runtime_policy: { fn: policyProbe, access } },
    } as never);
    expect(() => invalidEndpoint("runtime_ambiguous_scope", ["orders.get"]))
      .toThrow("must be public, authenticated");
    expect(() => invalidEndpoint("runtime_empty_scope_policy", { allOf: [] }))
      .toThrow("non-empty array of unique concrete scopes");
    expect(() => invalidEndpoint("runtime_two_kinds", { anyOf: ["a"], allOf: ["b"] }))
      .toThrow("exactly one of anyOf or allOf");

    await expect(runtime.mutation(aliceSession, request(mutationMessage(
      19,
      "19",
      { name: "No null sentinel", scopes: null },
      "tokens.createScopedToken",
    )))).rejects.toMatchObject({ code: "validation" });
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 0n });

    const created = (await runtime.mutation(aliceSession, request(mutationMessage(
      20,
      "20",
      { name: "Least privilege", scopes: ["orders.get"] },
      "tokens.createScopedToken",
    )))).value as CreatedValue;
    expect(created.scopes).toEqual(["orders.get"]);
    expect(Object.isFrozen(created.scopes)).toBe(true);
    const principal = await runtime.authenticateCredential(created.token, "scope-auth") as UserPrincipal;
    expect(principal.scopes).toEqual(["orders.get"]);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(principal.issuer).toBe(CREDENTIAL_ISSUER);
    expect(principal.subject).toBe(created.id);

    const invoke = (tool: string, current = principal) => runtime.runMcpTool({
      id: `scope-${tool}`,
      authorization: runtime.authorizeMcpTool("scoped", tool, current),
      args: {},
      principal: current,
    });
    expect(await runtime.runMcpTool({
      id: "scope-public",
      authorization: runtime.authorizeMcpTool(
        "scoped",
        "public_status",
        ANONYMOUS_PRINCIPAL,
      ),
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).toMatchObject({ structuredContent: { status: "public" } });
    await expect(runtime.runMcpTool({
      id: "scope-authenticated-anonymous",
      authorization: runtime.authorizeMcpTool(
        "scoped",
        "authenticated_status",
        ANONYMOUS_PRINCIPAL,
      ),
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(runtime.runMcpTool({
      id: "scope-unknown-anonymous",
      authorization: runtime.authorizeMcpTool(
        "scoped",
        "private_or_unknown",
        ANONYMOUS_PRINCIPAL,
      ),
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject({
      code: "unauthenticated",
      message: "authentication required",
    });
    expect(await invoke("authenticated_status")).toMatchObject({
      structuredContent: { status: "authenticated" },
    });
    expect(await invoke("read_orders")).toMatchObject({ structuredContent: { status: "orders" } });
    await expect(invoke("read_reports")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(invoke("admin_orders")).rejects.toMatchObject({ code: "unauthorized" });

    await runtime.mutation(aliceSession, request(mutationMessage(
      21,
      "21",
      { id: created.id, scopes: ["reports.all", "orders.get"] },
      "tokens.updateScopedToken",
    )));
    const listed = await runtime.query(
      aliceSession,
      request(queryMessage(22, "tokens.listScopedTokens")),
    ) as readonly [{ readonly scopes: readonly string[] }];
    // A grant is stored as requested: patterns have no place in the
    // vocabulary's order, so only their expansion is canonically ordered.
    expect(listed[0].scopes).toEqual(["reports.all", "orders.get"]);
    const expanded = await runtime.authenticateCredential(
      created.token,
      "scope-auth-expanded",
    ) as UserPrincipal;
    expect(await invoke("read_reports", expanded)).toMatchObject({
      structuredContent: { status: "reports" },
    });
    await expect(invoke("admin_orders", expanded)).rejects.toMatchObject({
      code: "unauthorized",
    });

    for (const [id, scopes] of [
      [23, ["orders.create"]],
      [24, null],
      [25, ["orders.get", "orders.get"]],
    ] as const) {
      await expect(runtime.mutation(aliceSession, request(mutationMessage(
        id,
        String(id),
        { id: created.id, scopes },
        "tokens.updateScopedToken",
      )))).rejects.toMatchObject({ code: "validation" });
    }
    expect((await runtime.query(
      aliceSession,
      request(queryMessage(26, "tokens.listScopedTokens")),
    ) as readonly [{ readonly scopes: readonly string[] }])[0].scopes).toEqual([
      "reports.all",
      "orders.get",
    ]);

    await runtime.mutation(aliceSession, request(mutationMessage(
      27,
      "27",
      { id: created.id, scopes: [] },
      "tokens.updateScopedToken",
    )));
    const emptyPrincipal = await runtime.authenticateCredential(
      created.token,
      "scope-auth-empty",
    ) as UserPrincipal;
    expect(emptyPrincipal.scopes).toEqual([]);
    expect(await invoke("authenticated_status", emptyPrincipal)).toMatchObject({
      structuredContent: { status: "authenticated" },
    });
    await expect(invoke("read_orders", emptyPrincipal)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(engine.reader.query(
      "SELECT scopes FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(created.id)).toEqual({ scopes: "[]" });
    // A grant persisted outside the vocabulary can never authorize anything:
    // the intersection with the issuer's declared grant drops it.
    engine.writer.query(
      "UPDATE _ackerdb_credentials SET scopes = ? WHERE token_id = ?",
    ).run(encode(["orders.create"]), created.id);
    const undeclared = await runtime.authenticateCredential(
      created.token,
      "scope-auth-undeclared-persisted",
    ) as UserPrincipal;
    expect(undeclared.scopes).toEqual([]);
  });

  test("filters discovery and reauthorizes every HTTP call against the current exact grant", async () => {
    const { runtime } = fixture(databasePath("ackerdb-credential-discovery-"));
    const alice = await user(runtime, "discovery-alice", FIXTURE_SCOPES);
    const aliceSession = session(alice, "discovery-alice-session");
    await runtime.openSession(aliceSession);
    const created = (await runtime.mutation(aliceSession, request(mutationMessage(
      30,
      "30",
      { name: "Least privilege", scopes: ["orders.get"] },
      "tokens.createScopedToken",
    )))).value as CreatedValue;

    const server = serve({ runtime, port: 0 });
    trackCleanup(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;
    const authorizeMcpTool = spyOn(runtime, "authorizeMcpTool");

    expect(await listedToolNames(await rpc(base, scopedMcp.path, "tools/list", {}))).toEqual([
      "public_status",
    ]);
    const publicCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "public_status",
      arguments: {},
    });
    expect(publicCall.status).toBe(200);
    expect(authorizeMcpTool).toHaveBeenCalledTimes(1);

    const protectedCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    });
    expect(protectedCall.status).toBe(401);
    expect(protectedCall.headers.get("www-authenticate")).toBe('Bearer realm="scoped"');
    expect(protectedCall.headers.get("access-control-expose-headers"))
      .toContain("www-authenticate");
    const protectedBody = await protectedCall.json();
    expect(protectedBody).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "authentication required" },
      id: null,
    });
    const unknownCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "private_or_unknown",
      arguments: {},
    });
    expect(unknownCall.status).toBe(protectedCall.status);
    expect(unknownCall.headers.get("www-authenticate")).toBe(
      protectedCall.headers.get("www-authenticate"),
    );
    expect(await unknownCall.json()).toEqual(protectedBody);
    const malformedProtectedCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: "invalid",
    });
    expect(malformedProtectedCall.status).toBe(401);
    expect(await malformedProtectedCall.json()).toEqual(protectedBody);

    const notification = await fetch(`${base}${scopedMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "read_reports", arguments: {} },
      }),
    });
    expect(notification.status).toBe(202);
    const batchedCall = await fetch(`${base}${scopedMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_reports", arguments: {} },
      }]),
    });
    expect(batchedCall.status).toBe(401);
    expect(await batchedCall.json()).toEqual(protectedBody);
    const malformedBatch = await fetch(`${base}${scopedMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read_reports", arguments: {} },
      }, { invalid: true }]),
    });
    expect(malformedBatch.status).toBe(400);

    const invalidToken = `ackerdb_credential.${"A".repeat(22)}.${"B".repeat(43)}`;
    const invalid = await rpc(base, scopedMcp.path, "tools/list", {}, invalidToken);
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(
      'Bearer realm="scoped", error="invalid_token"',
    );
    expect(JSON.stringify(await invalid.json())).not.toContain("read_reports");

    expect(await listedToolNames(
      await rpc(base, scopedMcp.path, "tools/list", {}, created.token),
    )).toEqual(["authenticated_status", "public_status", "read_orders"]);
    const anyOf = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_orders",
      arguments: {},
    }, created.token);
    expect(anyOf.status).toBe(200);
    const insufficient = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    }, created.token);
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toBe(
      'Bearer realm="scoped", error="insufficient_scope"',
    );
    const insufficientBody = await insufficient.json();
    expect(insufficientBody).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "access denied" },
      id: null,
    });
    expect(JSON.stringify(insufficientBody)).not.toContain("reports.all");

    await runtime.mutation(aliceSession, request(mutationMessage(
      31,
      "31",
      { id: created.id, scopes: ["reports.all", "orders.get"] },
      "tokens.updateScopedToken",
    )));
    const cachedNames = await listedToolNames(
      await rpc(base, scopedMcp.path, "tools/list", {}, created.token),
    );
    expect(cachedNames).toEqual([
      "authenticated_status",
      "public_status",
      "read_orders",
      "read_reports",
    ]);
    const allOf = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    }, created.token);
    expect(allOf.status).toBe(200);

    await runtime.mutation(aliceSession, request(mutationMessage(
      32,
      "32",
      { id: created.id, scopes: [] },
      "tokens.updateScopedToken",
    )));
    expect(cachedNames).toContain("read_reports");
    const cachedCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    }, created.token);
    expect(cachedCall.status).toBe(403);
    expect(await cachedCall.json()).toEqual(insufficientBody);
    expect(await listedToolNames(
      await rpc(base, scopedMcp.path, "tools/list", {}, created.token),
    )).toEqual(["authenticated_status", "public_status"]);
  });

  test("preserves same-timestamp creation order across restart", async () => {
    const path = databasePath("ackerdb-credential-order-");
    const timestamp = Date.now();
    const now = () => timestamp;
    const first = fixture(path, undefined, {}, { now });
    const alice = await user(first.runtime, "creation-order-alice");
    const firstSession = session(alice, "creation-order-first-session");
    await first.runtime.openSession(firstSession);
    const firstCreated = (await first.runtime.mutation(
      firstSession,
      request(mutationMessage(1, "1", { name: "First", metadata: {} })),
    )).value as { readonly id: string };
    const secondCreated = (await first.runtime.mutation(
      firstSession,
      request(mutationMessage(2, "2", { name: "Second", metadata: {} })),
    )).value as { readonly id: string };
    const firstId = "z".repeat(22);
    const secondId = "A".repeat(22);
    first.engine.writer.query("UPDATE _ackerdb_credentials SET token_id = ? WHERE token_id = ?")
      .run(firstId, firstCreated.id);
    first.engine.writer.query("UPDATE _ackerdb_credentials SET token_id = ? WHERE token_id = ?")
      .run(secondId, secondCreated.id);
    expect(first.engine.reader.query(
      "SELECT creation_seq, token_id FROM _ackerdb_credentials ORDER BY creation_seq",
    ).all()).toEqual([
      { creation_seq: 1n, token_id: firstId },
      { creation_seq: 2n, token_id: secondId },
    ]);
    await first.close();

    const second = fixture(path, undefined, {}, { now });
    const reopenedAlice = await user(second.runtime, "creation-order-alice");
    const secondSession = session(reopenedAlice, "creation-order-second-session");
    await second.runtime.openSession(secondSession);
    const listed = await second.runtime.query(secondSession, request(queryMessage(3))) as readonly {
      readonly id: string;
      readonly name: string;
      readonly createdAt: number;
    }[];
    expect(listed).toEqual([
      expect.objectContaining({ id: firstId, name: "First", createdAt: timestamp }),
      expect.objectContaining({ id: secondId, name: "Second", createdAt: timestamp }),
    ]);
  });

  test("survives restart as a first-class identity with bounded delegation", async () => {
    const path = databasePath("ackerdb-credential-auth-");
    const verifierCalls: string[] = [];
    const permissiveVerifier: CredentialVerifier = {
      revocationBound: { kind: "token-expiration" },
      subscribeInvalidation: (_listener: (invalidation: PrincipalInvalidation) => void) => () => {},
      verify: async (credential) => {
        verifierCalls.push(credential);
        return {
          kind: "user",
          issuer: "https://external.test/",
          subject: "accepted-by-test-verifier",
          claims: {},
          expiresAt: Date.now() + 60_000,
          tokenId: null,
        };
      },
    };

    const first = fixture(path, permissiveVerifier);
    const firstAlice = await user(first.runtime, "alice");
    const firstSession = session(firstAlice, "first-session");
    await first.runtime.openSession(firstSession);
    const created = (await first.runtime.mutation(
      firstSession,
      request(mutationMessage(1, "10", { name: "Codex", metadata: { host: "codex" } })),
    )).value as CreatedValue;
    const secondCreated = (await first.runtime.mutation(
      firstSession,
      request(mutationMessage(2, "11", { name: "Claude", metadata: { host: "claude" } })),
    )).value as CreatedValue;
    await first.close();

    const second = fixture(path, permissiveVerifier);
    const secondAlice = await user(second.runtime, "alice");
    expect(secondAlice.identity).toBe(firstAlice.identity);
    const principal = await second.runtime.authenticateCredential(
      created.token,
      "test-credential-auth",
    );
    expect(principal).toEqual({
      kind: "user",
      identity: created.identity as never,
      scopes: [],
      issuer: CREDENTIAL_ISSUER,
      subject: created.id,
      claims: {},
      expiresAt: Number.POSITIVE_INFINITY,
      tokenId: created.id,
    });
    expect(await second.runtime.authenticateCredential(
      secondCreated.token,
      "test-second-credential-auth",
    )).toMatchObject({
      kind: "user",
      identity: secondCreated.identity,
      tokenId: secondCreated.id,
      scopes: [],
    });
    // Credentials are not endpoint-bound: an unknown tool on another endpoint
    // is a not-found, not a provider mismatch.
    await expect(second.runtime.runMcpTool({
      id: "wrong-endpoint",
      authorization: second.runtime.authorizeMcpTool(
        "operations",
        "write_owned_record",
        principal,
      ),
      args: { value: "forbidden" },
      principal,
    })).rejects.toMatchObject({ code: "not_found" });
    // Agents are first-class users: the client API and ordinary
    // authenticated functions serve them like any other identity.
    const agentSession = session(principal as UserPrincipal, "agent-session");
    await second.runtime.openSession(agentSession);
    expect(await second.runtime.query(agentSession, request(queryMessage(50)))).toEqual([]);
    // A vault credential can never fall through to an application verifier.
    await expect(verifyBearerCredential(created.token, permissiveVerifier)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    // Nor can one the vault itself refuses: the prefix claims the vault, so a
    // malformed, truncated, or oversized bearer under it is unauthenticated
    // rather than an external user this permissive verifier would accept.
    const composed = second.runtime.credentialVerifier!;
    for (const malformed of [
      "ackerdb_credential.",
      "ackerdb_credential.short.secret",
      `${created.token}x`,
      `ackerdb_credential.${"a".repeat(22)}.${"b".repeat(44)}`,
    ]) {
      await expect(verifyBearerCredential(malformed, composed)).rejects.toMatchObject({
        code: "unauthenticated",
      });
    }
    expect(verifierCalls).toEqual([]);

    const server = serve({ runtime: second.runtime, port: 0 });
    trackCleanup(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;
    const called = await rpc(base, "/agent/mcp", "tools/call", {
      name: "write_owned_record",
      arguments: { value: "delegated-codex" },
    }, created.token);
    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({
      result: {
        structuredContent: {
          principal: `user:${created.identity}`,
          record: "ackerdb://records/1",
          tokenId: created.id,
        },
      },
    });
    const secondCalled = await rpc(base, "/agent/mcp", "tools/call", {
      name: "write_owned_record",
      arguments: { value: "delegated-claude" },
    }, secondCreated.token);
    expect(secondCalled.status).toBe(200);
    expect(second.engine.reader.query("SELECT owner, value FROM records ORDER BY id").all()).toEqual([
      { owner: created.identity, value: "delegated-codex" },
      { owner: secondCreated.identity, value: "delegated-claude" },
    ]);

    // The same credential works on every endpoint; only tools gate access.
    const crossEndpoint = await rpc(base, "/operations/mcp", "ping", {}, created.token);
    expect(crossEndpoint.status).toBe(200);
    for (const token of [
      `ackerdb_credential.${"A".repeat(22)}.${"B".repeat(43)}`,
      "ackerdb_credential.bad",
      "external-provider-token",
    ] as const) {
      const rejected = await rpc(base, "/agent/mcp", "ping", {}, token);
      expect(rejected.status).toBe(401);
    }
    expect(verifierCalls).toEqual([]);

    const selfAdmin = await rpc(base, "/agent/mcp", "tools/call", {
      name: "attempt_self_administration",
      arguments: {},
    }, created.token);
    expect(await selfAdmin.json()).toMatchObject({ result: { isError: true } });
    expect(second.engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 2n });

    const anonymous = await rpc(base, "/agent/mcp", "tools/call", {
      name: "write_owned_record",
      arguments: { value: "forbidden" },
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { message: "authentication required" },
    });
  });
});
