/**
 * Delegation lineage: what happens to a credential's descendants when its own
 * authority changes. The subset invariant only holds if a live descendant
 * hears about it — a vault principal never expires, so an authority it kept
 * would be an authority it kept forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ackerdb/core";
import {
  verifyClientCredential,
  type PrincipalInvalidation,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { invalidationReaches } from "../../src/auth/invalidation.ts";
import {
  CREDENTIAL_ISSUER,
  parseCredentialToken,
} from "../../src/auth/credential-token.ts";
import { credentialVaultOwner } from "../../src/auth/credential-vault.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  cleanupCredentialFixtures,
  databasePath,
  fixture,
  FIXTURE_SCOPES,
  mutationMessage,
  request,
  session,
  trackCleanup,
  user,
  type CredentialFixture,
} from "../support/credential-fixture.ts";

interface CreatedToken {
  readonly id: string;
  readonly token: string;
}

afterEach(async () => {
  await cleanupCredentialFixtures();
});

function start(): CredentialFixture {
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

  test("an external issuer's invalidation reaches the credentials delegated from it", async () => {
    // The delegated credential is live under `ackerdb:credentials` with its own
    // subject, so nothing about its own account resembles the external one it
    // was minted from. It carries that account instead, recorded when the
    // lineage was walked — which is why an application narrowing or revoking a
    // grant upstream terminates the delegate now. A vault principal never
    // expires, so "at its next authentication" would have meant never.
    const { runtime } = start();
    const alice = await user(runtime, "alice", FIXTURE_SCOPES);
    const aliceSession = session(alice, "alice");
    await runtime.openSession(aliceSession);
    const child = await issue(runtime, aliceSession, 1, "Agent", ["orders.all"]);

    const principal = await runtime.authenticateCredential(
      child.token,
      "delegated",
    ) as UserPrincipal;
    expect(principal.issuer).toBe(CREDENTIAL_ISSUER);
    expect(principal.subject).toBe(child.id);
    expect(principal.derivedFrom).toEqual([
      { issuer: "https://issuer.test/", subject: "alice" },
    ]);

    const reaches = (invalidation: PrincipalInvalidation): boolean =>
      invalidationReaches(principal, invalidation);
    // The account upstream, whole or by issuer alone.
    expect(reaches({ issuer: "https://issuer.test/", subject: "alice" })).toBe(true);
    expect(reaches({ issuer: "https://issuer.test/" })).toBe(true);
    // Its own account, as before.
    expect(reaches({ issuer: CREDENTIAL_ISSUER, subject: child.id })).toBe(true);
    // A different subject at the same issuer, and an unrelated issuer.
    expect(reaches({ issuer: "https://issuer.test/", subject: "bob" })).toBe(false);
    expect(reaches({ issuer: "https://other.test/" })).toBe(false);
    // An invalidation naming an exact token names one credential. It must not
    // travel down the lineage, or revoking a parent's token would revoke
    // descendants the vault deliberately keeps.
    expect(reaches({
      issuer: "https://issuer.test/",
      subject: "alice",
      tokenId: "external-alice",
    })).toBe(false);
  });

  test("both authentication doors hand back the same lineage", async () => {
    // A vault token reaches the server two ways: the MCP door authenticates it
    // directly, and every ordinary HTTP call and WebSocket handshake goes
    // through the generic verifier contract, which resolves identity and scopes
    // as separate steps. Two doors that build the principal differently are two
    // chances to drop the lineage, and a principal that drops it is one an
    // upstream invalidation cannot reach. They must agree.
    const { runtime } = start();
    const alice = await user(runtime, "two-doors", FIXTURE_SCOPES);
    const aliceSession = session(alice, "two-doors");
    await runtime.openSession(aliceSession);
    const child = await issue(runtime, aliceSession, 1, "Agent", ["orders.all"]);
    const upstream = [{ issuer: "https://issuer.test/", subject: "two-doors" }];

    const direct = await runtime.authenticateCredential(child.token, "direct") as UserPrincipal;
    expect(direct.derivedFrom).toEqual(upstream);

    const generic = await verifyClientCredential(
      { kind: "bearer", token: child.token },
      runtime.credentialVerifier,
      (account, signal) => runtime.resolveIdentity(account, signal),
      Date.now,
      runtime.resolveScopes,
    ) as UserPrincipal;
    expect(generic.derivedFrom).toEqual(upstream);
    expect(generic.identity).toBe(direct.identity);
    expect(generic.scopes).toEqual(direct.scopes);
  });

  test("an in-flight credential lease hears the provider revoke its parent account", async () => {
    // The sequence that motivates the whole lineage: an external identity
    // delegates a credential, the credential is in the middle of an operation
    // holding a lease, and the *application's* provider revokes the parent
    // account. That event is published by the provider, never by this
    // boundary — so a lease subscribed only to what the boundary publishes
    // carries a correct predicate over events it never receives, and the
    // in-flight holder goes on using authority its parent has already lost.
    let fire: ((invalidation: PrincipalInvalidation) => void) | undefined;
    const provider = {
      revocationBound: { kind: "invalidation" as const, deadlineMs: 5_000 },
      subscribeInvalidation: (listener: (i: PrincipalInvalidation) => void) => {
        fire = listener;
        return () => { fire = undefined; };
      },
      verify: async () => { throw new Error("no provider bearer in this test"); },
    };
    const { runtime } = fixture(databasePath("ackerdb-credential-upstream-"), provider);
    const alice = await user(runtime, "upstream-parent", FIXTURE_SCOPES);
    const aliceSession = session(alice, "upstream-parent");
    await runtime.openSession(aliceSession);
    const child = await issue(runtime, aliceSession, 1, "Agent", ["orders.all"]);

    const lease = await runtime.acquireCredentialLease(
      parseCredentialToken(child.token)!,
      "upstream",
    );
    expect(lease.signal.aborted).toBe(false);
    expect(lease.principal.derivedFrom)
      .toEqual([{ issuer: "https://issuer.test/", subject: "upstream-parent" }]);

    // The provider revokes the parent account, not the credential.
    fire?.({ issuer: "https://issuer.test/", subject: "upstream-parent" });

    expect(lease.signal.aborted).toBe(true);
    lease.release();
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
