import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encode } from "@ackerdb/core";
import {
  verifyBearerCredential,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { CREDENTIAL_ISSUER } from "../../src/auth/credential-token.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import type { SessionApplicationMessage } from "../../src/subscriptions/session/contract.ts";
import {
  cleanupCredentialFixtures,
  databasePath,
  fixture,
  FIXTURE_SCOPES,
  mutationMessage,
  queryMessage,
  request,
  session,
  subscribeMessage,
  trackCleanup,
  user,
} from "../support/credential-fixture.ts";
import { listen } from "ackerdb-test-support/listen";

afterEach(cleanupCredentialFixtures);

/** One exposed-HTTP call, optionally bearing an AckerDB credential. */
function call(
  base: string,
  address: string,
  options: { readonly token?: string; readonly args?: unknown } = {},
): Promise<Response> {
  const headers = options.token === undefined
    ? undefined
    : { authorization: `Bearer ${options.token}` };
  return fetch(`${base}/${address.replaceAll(".", "/")}`, {
    method: "POST",
    ...(headers === undefined ? {} : { headers }),
    body: JSON.stringify(options.args ?? {}),
  });
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
    const { engine, runtime } = await fixture(databasePath("ackerdb-credential-create-"));
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
      "SELECT tokenId, identity, parentIdentity, secretDigest, name, metadataJson, scopesJson, createdAt, updatedAt FROM _ackerdb_credentials",
    ).get() as {
      tokenId: string;
      identity: bigint;
      parentIdentity: bigint;
      secretDigest: Uint8Array;
      name: string;
      metadataJson: string;
      scopesJson: string;
      createdAt: number;
      updatedAt: number;
    };
    const secret = created.token.split(".")[2]!;
    expect(stored).toMatchObject({
      tokenId: created.id,
      identity: created.identity,
      parentIdentity: alice.identity,
      name: "Laptop",
      scopesJson: "[]",
    });
    expect(Buffer.from(stored.secretDigest).toString("hex")).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    const storedText = JSON.stringify({
      ...stored,
      identity: stored.identity.toString(),
      parentIdentity: stored.parentIdentity.toString(),
    });
    expect(storedText).not.toContain(created.token);
    expect(storedText).not.toContain(secret);
    expect(
      engine.writer.query("SELECT result_disposition, result, result_bytes FROM _ackerdb_mutations").get(),
    ).toEqual({ result_disposition: "one-time", result: null, result_bytes: 0n });
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
    const { engine, runtime } = await fixture(databasePath("ackerdb-credential-lifecycle-"));
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
      "SELECT secretDigest, scopesJson FROM _ackerdb_credentials WHERE tokenId = ?",
    ).get(created.id) as { readonly secretDigest: Uint8Array; readonly scopesJson: string };
    const active = await runtime.authenticateCredential(created.token, "before-edit");

    await runtime.mutation(aliceSession, request(mutationMessage(
      102,
      "102",
      { id: created.id, name: "Personal Codex" },
      "api.tokens.renameAgentToken",
    )));
    expect(lifecycleTransitions()).toHaveLength(3);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: { kind: "update", value: [{ name: "Personal Codex", metadata: { device: "mac" } }] },
    });

    await runtime.mutation(aliceSession, request(mutationMessage(
      103,
      "103",
      { id: created.id, metadata: { device: "mac", color: "blue", generation: 2n } },
      "api.tokens.updateAgentTokenMetadata",
    )));
    expect(lifecycleTransitions()).toHaveLength(4);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: {
        kind: "update",
        value: [{ name: "Personal Codex", metadata: { device: "mac", color: "blue", generation: 2n } }],
      },
    });

    const after = engine.reader.query(
      "SELECT secretDigest, scopesJson FROM _ackerdb_credentials WHERE tokenId = ?",
    ).get(created.id) as { readonly secretDigest: Uint8Array; readonly scopesJson: string };
    expect(Buffer.from(after.secretDigest)).toEqual(Buffer.from(before.secretDigest));
    expect(after.scopesJson).toBe(before.scopesJson);
    expect(await runtime.authenticateCredential(created.token, "after-edit"))
      .toMatchObject({ identity: created.identity, tokenId: created.id });
    const activeResult = await runtime.runProcedure({
      id: 1,
      address: "api.records.writeOwnedRecord",
      args: { value: "still-active" },
      principal: active,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(activeResult.status).toBe(200);
    expect(await activeResult.json()).toMatchObject({
      principal: `user:${created.identity}`,
    });

    for (const [id, args, ref] of [
      [104, { id: created.id, metadata: { value: "x".repeat(PRODUCTION_LIMITS.credentials.maxMetadataBytes) } }, "api.tokens.updateAgentTokenMetadata"],
      [105, { id: created.id, kind: "empty" }, "api.tokens.invalidAgentTokenUpdate"],
      [106, { id: created.id, kind: "undefined" }, "api.tokens.invalidAgentTokenUpdate"],
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
      [109, bobSession, { id: created.id, name: "Stolen" }, "api.tokens.renameAgentToken"],
      [110, bobSession, { id: created.id }, "api.tokens.revokeAgentToken"],
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
      "api.tokens.revokeAgentToken",
    )));
    expect(lifecycleTransitions()).toHaveLength(5);
    expect(lifecycleTransitions().at(-1)).toMatchObject({ transition: { kind: "update", value: [] } });
    await expect(runtime.authenticateCredential(created.token, "after-revoke"))
      .rejects.toMatchObject({ code: "unauthenticated" });

    const server = listen(runtime);
    trackCleanup(async () => server.drain());
    const response = await call(
      `http://127.0.0.1:${server.port}`,
      "api.records.writeOwnedRecord",
      { token: created.token, args: { value: "revoked" } },
    );
    expect(response.status).toBe(401);
  });

  test("stores exact immutable grants and enforces explicit authenticated, any-of, and all-of policy", async () => {
    const { engine, runtime } = await fixture(databasePath("ackerdb-credential-scopes-"));
    const alice = await user(runtime, "scoped-alice", FIXTURE_SCOPES);
    const aliceSession = session(alice, "scoped-alice-session");
    await runtime.openSession(aliceSession);

    await expect(runtime.mutation(aliceSession, request(mutationMessage(
      19,
      "19",
      { name: "No null sentinel", scopes: null },
      "api.tokens.createScopedToken",
    )))).rejects.toMatchObject({ code: "validation" });
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 0n });

    const created = (await runtime.mutation(aliceSession, request(mutationMessage(
      20,
      "20",
      { name: "Least privilege", scopes: ["orders.get"] },
      "api.tokens.createScopedToken",
    )))).value as CreatedValue;
    expect(created.scopes).toEqual(["orders.get"]);
    expect(Object.isFrozen(created.scopes)).toBe(true);
    const principal = await runtime.authenticateCredential(created.token, "scope-auth") as UserPrincipal;
    expect(principal.scopes).toEqual(["orders.get"]);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(principal.issuer).toBe(CREDENTIAL_ISSUER);
    expect(principal.subject).toBe(created.id);

    // Every scope decision is re-taken on the exposed HTTP surface, against
    // the credential the request bears rather than a cached authorization.
    const server = listen(runtime);
    trackCleanup(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;
    const invoke = (address: string, token = created.token) =>
      call(base, address, { token });

    const anonymousPublic = await call(base, "api.records.publicScopedTool");
    expect(anonymousPublic.status).toBe(200);
    expect(await anonymousPublic.json()).toEqual({ status: "public" });
    expect((await call(base, "api.records.authenticatedScopedTool")).status).toBe(401);

    const authenticated = await invoke("api.records.authenticatedScopedTool");
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ status: "authenticated" });
    const anyOfBefore = await invoke("api.records.anyScopedTool");
    expect(anyOfBefore.status).toBe(200);
    expect(await anyOfBefore.json()).toEqual({ status: "orders" });
    expect((await invoke("api.records.allScopedTool")).status).toBe(403);
    expect((await invoke("api.records.exactAllTool")).status).toBe(403);

    await runtime.mutation(aliceSession, request(mutationMessage(
      21,
      "21",
      { id: created.id, scopes: ["reports.all", "orders.get"] },
      "api.tokens.updateScopedToken",
    )));
    const listed = await runtime.query(
      aliceSession,
      request(queryMessage(22, "api.tokens.listScopedTokens")),
    ) as readonly [{ readonly scopes: readonly string[] }];
    // A grant is stored as requested: patterns have no place in the
    // vocabulary's order, so only their expansion is canonically ordered.
    expect(listed[0].scopes).toEqual(["reports.all", "orders.get"]);
    const expanded = await runtime.authenticateCredential(
      created.token,
      "scope-auth-expanded",
    ) as UserPrincipal;
    expect(expanded.scopes).toEqual(["orders.get", "reports.all"]);
    const allOf = await invoke("api.records.allScopedTool");
    expect(allOf.status).toBe(200);
    expect(await allOf.json()).toEqual({ status: "reports" });
    expect((await invoke("api.records.exactAllTool")).status).toBe(403);

    for (const [id, scopes] of [
      [23, ["orders.create"]],
      [24, null],
      [25, ["orders.get", "orders.get"]],
    ] as const) {
      await expect(runtime.mutation(aliceSession, request(mutationMessage(
        id,
        String(id),
        { id: created.id, scopes },
        "api.tokens.updateScopedToken",
      )))).rejects.toMatchObject({ code: "validation" });
    }
    expect((await runtime.query(
      aliceSession,
      request(queryMessage(26, "api.tokens.listScopedTokens")),
    ) as readonly [{ readonly scopes: readonly string[] }])[0].scopes).toEqual([
      "reports.all",
      "orders.get",
    ]);

    await runtime.mutation(aliceSession, request(mutationMessage(
      27,
      "27",
      { id: created.id, scopes: [] },
      "api.tokens.updateScopedToken",
    )));
    const emptyPrincipal = await runtime.authenticateCredential(
      created.token,
      "scope-auth-empty",
    ) as UserPrincipal;
    expect(emptyPrincipal.scopes).toEqual([]);
    // The narrowed grant takes effect on the very next call: nothing caches an
    // earlier authorization for the same credential.
    expect((await invoke("api.records.authenticatedScopedTool")).status).toBe(200);
    expect((await invoke("api.records.anyScopedTool")).status).toBe(403);
    expect(engine.reader.query(
      "SELECT scopesJson FROM _ackerdb_credentials WHERE tokenId = ?",
    ).get(created.id)).toEqual({ scopesJson: "[]" });
    // A grant persisted outside the vocabulary can never authorize anything:
    // the intersection with the issuer's declared grant drops it.
    engine.writer.query(
      "UPDATE _ackerdb_credentials SET scopesJson = ? WHERE tokenId = ?",
    ).run(encode(["orders.create"]), created.id);
    const undeclared = await runtime.authenticateCredential(
      created.token,
      "scope-auth-undeclared-persisted",
    ) as UserPrincipal;
    expect(undeclared.scopes).toEqual([]);
  });

  test("preserves same-timestamp creation order across restart", async () => {
    const path = databasePath("ackerdb-credential-order-");
    const timestamp = Date.now();
    const now = () => timestamp;
    const first = await fixture(path, undefined, {}, { now });
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
    first.engine.writer.query("UPDATE _ackerdb_credentials SET tokenId = ? WHERE tokenId = ?")
      .run(firstId, firstCreated.id);
    first.engine.writer.query("UPDATE _ackerdb_credentials SET tokenId = ? WHERE tokenId = ?")
      .run(secondId, secondCreated.id);
    expect(first.engine.reader.query(
      "SELECT id, tokenId FROM _ackerdb_credentials ORDER BY id",
    ).all()).toEqual([
      { id: 1n, tokenId: firstId },
      { id: 2n, tokenId: secondId },
    ]);
    await first.close();

    const second = await fixture(path, undefined, {}, { now });
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

    const first = await fixture(path, permissiveVerifier);
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

    const second = await fixture(path, permissiveVerifier);
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
      // The issuing account travels with the principal: it is what an
      // invalidation for alice matches on to reach this delegated credential.
      derivedFrom: [{ issuer: "https://issuer.test/", subject: "alice" }],
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

    const server = listen(second.runtime);
    trackCleanup(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;
    const called = await call(base, "api.records.writeOwnedRecord", {
      token: created.token,
      args: { value: "delegated-codex" },
    });
    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({
      principal: `user:${created.identity}`,
      record: "ackerdb://records/1",
      tokenId: created.id,
    });
    const secondCalled = await call(base, "api.records.writeOwnedRecord", {
      token: secondCreated.token,
      args: { value: "delegated-claude" },
    });
    expect(secondCalled.status).toBe(200);
    expect(second.engine.reader.query("SELECT owner, value FROM records ORDER BY id").all()).toEqual([
      { owner: created.identity, value: "delegated-codex" },
      { owner: secondCreated.identity, value: "delegated-claude" },
    ]);

    // The vault owns its prefix outright: an unknown or malformed bearer under
    // it is unauthenticated and never falls through to the application verifier.
    for (const token of [
      `ackerdb_credential.${"A".repeat(22)}.${"B".repeat(43)}`,
      "ackerdb_credential.bad",
    ] as const) {
      const rejected = await call(base, "api.records.writeOwnedRecord", {
        token,
        args: { value: "forbidden" },
      });
      expect(rejected.status).toBe(401);
    }
    expect(verifierCalls).toEqual([]);

    // Delegation is bounded: a credential cannot mint a grant wider than its own.
    const selfAdmin = await call(base, "api.security.attemptSelfAdministration", {
      token: created.token,
    });
    expect(selfAdmin.status).toBe(403);
    expect(second.engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 2n });

    const anonymous = await call(base, "api.records.writeOwnedRecord", {
      args: { value: "forbidden" },
    });
    expect(anonymous.status).toBe(401);
  });
});
