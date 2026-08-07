/**
 * Delegation lineage: what happens to a credential's descendants when its own
 * authority changes. The subset invariant only holds if a live descendant
 * hears about it — a vault principal never expires, so an authority it kept
 * would be an authority it kept forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ackerdb/core";
import type { UserPrincipal } from "../../src/auth/credentials.ts";
import {
  CREDENTIAL_ISSUER,
  parseCredentialToken,
} from "../../src/auth/credential-token.ts";
import { credentialVaultOwner } from "../../src/auth/credential-vault.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  cleanupMcpTokenFixtures,
  databasePath,
  fixture,
  FIXTURE_SCOPES,
  mutationMessage,
  request,
  session,
  trackCleanup,
  user,
  type McpTokenFixture,
} from "../support/mcp-token-fixture.ts";

interface CreatedToken {
  readonly id: string;
  readonly token: string;
}

afterEach(async () => {
  await cleanupMcpTokenFixtures();
});

function start(): McpTokenFixture {
  const value = fixture(databasePath("ackerdb-credential-lineage-"));
  trackCleanup(value.close);
  return value;
}

/** Issue a credential from one live session, whoever that session belongs to. */
async function issue(
  runtime: Runtime,
  owner: ReturnType<typeof session>,
  id: number,
  name: string,
  scopes: readonly string[],
): Promise<CreatedToken> {
  return (await runtime.mutation(
    owner,
    request(mutationMessage(id, String(id), { name, scopes }, "tokens.createScopedToken")),
  )).value as CreatedToken;
}

/** Open a session for a credential's own first-class Identity. */
async function credentialSession(
  runtime: Runtime,
  token: string,
  name: string,
): Promise<ReturnType<typeof session>> {
  const principal = await runtime.authenticateCredential(token, name) as UserPrincipal;
  expect(principal.issuer).toBe(CREDENTIAL_ISSUER);
  const context = session(principal, name);
  await runtime.openSession(context);
  return context;
}

describe("credential delegation lineage", () => {
  test("revoking a credential revokes everything delegated beneath it", async () => {
    const { runtime, engine } = start();
    const alice = await user(runtime, "lineage-owner", FIXTURE_SCOPES);
    const aliceSession = session(alice, "lineage-owner");
    await runtime.openSession(aliceSession);

    const child = await issue(runtime, aliceSession, 1, "Child", ["orders.all"]);
    const childSession = await credentialSession(runtime, child.token, "child");
    const grandchild = await issue(runtime, childSession, 2, "Grandchild", ["orders.all"]);
    const grandchildSession = await credentialSession(runtime, grandchild.token, "grandchild");
    // The grandchild authenticates before the revocation, holding real authority.
    const grandchildPrincipal = grandchildSession.principal as UserPrincipal;
    expect(grandchildPrincipal.scopes).toEqual(["orders.all"]);

    await runtime.mutation(
      aliceSession,
      request(mutationMessage(3, "3", { id: child.id }, "tokens.revokeAgentToken")),
    );

    // Both rows are gone: a surviving grandchild would read as an application
    // root and be resolved by the application's own scope resolver.
    const remaining = engine.reader
      .query("SELECT COUNT(*) AS count FROM _ackerdb_credentials")
      .get() as { count: bigint };
    expect(remaining.count).toBe(0n);
    await expect(runtime.authenticateCredential(grandchild.token, "grandchild-after"))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("narrowing a parent's grant reaches the descendants it bounds", async () => {
    const { runtime, engine } = start();
    const alice = await user(runtime, "narrow-owner", FIXTURE_SCOPES);
    const aliceSession = session(alice, "narrow-owner");
    await runtime.openSession(aliceSession);

    const child = await issue(runtime, aliceSession, 1, "Child", ["orders.all", "orders.get"]);
    const childSession = await credentialSession(runtime, child.token, "narrow-child");
    const grandchild = await issue(runtime, childSession, 2, "Grandchild", ["orders.all"]);

    await runtime.mutation(
      aliceSession,
      request(mutationMessage(3, "3", { id: child.id, scopes: ["orders.get"] },
        "tokens.updateScopedToken")),
    );

    // The stored grandchild grant is untouched; its live authority is not.
    const descendant = await runtime.authenticateCredential(
      grandchild.token,
      "narrow-grandchild",
    ) as UserPrincipal;
    expect(descendant.scopes).toEqual([]);
    const stored = engine.reader
      .query("SELECT scopes FROM _ackerdb_credentials WHERE token_id = ?")
      .get(grandchild.id) as { scopes: string };
    expect(stored.scopes).toContain("orders.all");
  });

  test("a revocation that rolls back invalidates nothing", async () => {
    const { runtime, engine } = start();
    const alice = await user(runtime, "rollback-owner", FIXTURE_SCOPES);
    const aliceSession = session(alice, "rollback-owner");
    await runtime.openSession(aliceSession);
    const child = await issue(runtime, aliceSession, 1, "Child", ["orders.all"]);

    const lease = await runtime.acquireCredentialLease(
      parseCredentialToken(child.token)!,
      "rollback-lease",
    );
    try {
      const attempt = await runtime.procedure(aliceSession, request({
        v: PROTOCOL_VERSION,
        t: "p" as const,
        id: 1,
        ref: "tokens.revokeThenRollback",
        args: { id: child.id },
      })) as { readonly rolledBack: boolean };
      expect(attempt.rolledBack).toBe(true);

      // The row survived the savepoint rollback, and so did the live lease:
      // an invalidation for a revocation that never committed would have
      // terminated a credential that is still perfectly valid.
      expect(engine.reader
        .query("SELECT COUNT(*) AS count FROM _ackerdb_credentials WHERE token_id = ?")
        .get(child.id)).toEqual({ count: 1n });
      expect(lease.signal.aborted).toBe(false);

      // The same operation, committed, does cancel it.
      await runtime.mutation(
        aliceSession,
        request(mutationMessage(2, "2", { id: child.id }, "tokens.revokeAgentToken")),
      );
      expect(lease.signal.aborted).toBe(true);
    } finally {
      lease.release();
    }
  });

  test("the lineage walk names the credential and every delegate under it", () => {
    const { runtime, engine } = start();
    void runtime;
    const vault = engine[credentialVaultOwner];
    const identity = (engine.writer
      .query("INSERT INTO _ackerdb_identities DEFAULT VALUES RETURNING identity")
      .get() as { identity: bigint }).identity;
    engine.writer.exec("BEGIN IMMEDIATE");
    const root = vault.create(identity as never, { name: "Root" }, FIXTURE_SCOPES, {
      maxPerIdentity: 8,
      maxNameBytes: 128,
      maxMetadataBytes: 1024,
    }, Date.now());
    const leaf = vault.create(root.identity, { name: "Leaf" }, FIXTURE_SCOPES, {
      maxPerIdentity: 8,
      maxNameBytes: 128,
      maxMetadataBytes: 1024,
    }, Date.now());
    engine.writer.exec("COMMIT");

    expect([...vault.lineage(engine.reader, root.id)].sort())
      .toEqual([root.id, leaf.id].sort());
    expect(vault.lineage(engine.reader, leaf.id)).toEqual([leaf.id]);
  });
});
