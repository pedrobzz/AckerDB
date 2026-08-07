/**
 * Delegation lineage: authority never outlives its source.
 *
 * A chain user → parent credential → child → grandchild must die as one
 * subtree when any ancestor is revoked — fresh authentication fails, live
 * leases abort immediately, and no orphaned credential remains that its
 * owner can no longer administer. A grant change on an ancestor re-authorizes
 * every live descendant immediately, not at reconnect.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CREDENTIAL_ISSUER, parseCredentialToken } from "../../src/auth/credential-token.ts";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  UserPrincipal,
} from "../../src/auth/credentials.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { SessionRuntimeContext } from "../../src/subscriptions/session/contract.ts";
import {
  cleanupMcpTokenFixtures,
  databasePath,
  fixture,
  FIXTURE_SCOPES,
  mutationMessage,
  request,
  session,
  user,
} from "../support/mcp-token-fixture.ts";

afterEach(cleanupMcpTokenFixtures);

interface CreatedValue {
  readonly id: string;
  readonly identity: bigint;
  readonly token: string;
  readonly scopes: readonly string[];
}

let nextMutation = 1;

async function createCredential(
  runtime: Runtime,
  owner: SessionRuntimeContext,
  name: string,
  scopes: readonly string[],
): Promise<CreatedValue> {
  const id = nextMutation++;
  const result = await runtime.mutation(
    owner,
    request(mutationMessage(id, String(id), { name, scopes }, "tokens.createScopedToken")),
  );
  return result.value as CreatedValue;
}

/** user → parent → child → grandchild, each level authenticated for real. */
async function chain(
  runtime: Runtime,
  scopes: readonly string[],
): Promise<{
  readonly owner: SessionRuntimeContext;
  readonly parent: CreatedValue;
  readonly child: CreatedValue;
  readonly grandchild: CreatedValue;
}> {
  const principal = await user(runtime, "lineage-owner", FIXTURE_SCOPES);
  const owner = session(principal, "lineage-owner");
  await runtime.openSession(owner);
  const parent = await createCredential(runtime, owner, "parent", scopes);

  const parentPrincipal = await runtime.authenticateCredential(parent.token, "lineage-parent");
  const parentSession = session(parentPrincipal as UserPrincipal, "lineage-parent");
  await runtime.openSession(parentSession);
  const child = await createCredential(runtime, parentSession, "child", scopes);

  const childPrincipal = await runtime.authenticateCredential(child.token, "lineage-child");
  const childSession = session(childPrincipal as UserPrincipal, "lineage-child");
  await runtime.openSession(childSession);
  const grandchild = await createCredential(runtime, childSession, "grandchild", scopes);

  return { owner, parent, child, grandchild };
}

function credentialCount(engine: { readonly reader: { query(sql: string): { get(): unknown } } }): bigint {
  return (engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get() as {
    readonly count: bigint;
  }).count;
}

describe("credential delegation lineage", () => {
  test("revoking an ancestor removes and invalidates the whole descendant subtree", async () => {
    const { runtime, engine } = fixture(databasePath("ackerdb-credential-lineage-"));
    const { owner, parent, child, grandchild } = await chain(runtime, ["orders.all", "orders.get"]);
    expect(credentialCount(engine)).toBe(3n);

    // Fresh grandchild authentication carries the intersected grant.
    const fresh = await runtime.authenticateCredential(grandchild.token, "lineage-fresh");
    expect((fresh as UserPrincipal).scopes).toEqual(["orders.all", "orders.get"]);

    // A live lease on the deepest descendant, held across the revocation.
    const lease = await runtime.acquireCredentialLease(
      parseCredentialToken(grandchild.token)!,
      "lineage-lease",
    );
    expect(lease.signal.aborted).toBe(false);

    const id = nextMutation++;
    await runtime.mutation(
      owner,
      request(mutationMessage(id, String(id), { id: parent.id }, "tokens.revokeAgentToken")),
    );

    // The subtree is gone atomically: no orphan a deleted identity owns.
    expect(credentialCount(engine)).toBe(0n);
    // Live descendant authority dies immediately, not at reconnect.
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    // Fresh authentication after revoke fails closed at every level.
    for (const token of [parent.token, child.token, grandchild.token]) {
      await expect(runtime.authenticateCredential(token, "lineage-revoked"))
        .rejects.toMatchObject({ code: "unauthenticated" });
    }
  });

  test("narrowing an ancestor grant re-authorizes live descendants immediately", async () => {
    const { runtime, engine } = fixture(databasePath("ackerdb-credential-narrow-"));
    const { owner, parent, grandchild } = await chain(runtime, ["orders.all", "orders.get"]);

    const lease = await runtime.acquireCredentialLease(
      parseCredentialToken(grandchild.token)!,
      "narrow-lease",
    );
    expect(lease.principal.scopes).toEqual(["orders.all", "orders.get"]);

    const id = nextMutation++;
    await runtime.mutation(
      owner,
      request(mutationMessage(
        id,
        String(id),
        { id: parent.id, scopes: ["orders.get"] },
        "tokens.updateScopedToken",
      )),
    );

    // The stale wide grant cannot ride a live session past the change.
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    // The subtree survives a grant change; only its authority narrows.
    expect(credentialCount(engine)).toBe(3n);
    const fresh = await runtime.authenticateCredential(grandchild.token, "narrow-fresh");
    expect((fresh as UserPrincipal).scopes).toEqual(["orders.get"]);
  });

  test("an external ancestor invalidation reaches every live credential descendant", async () => {
    const externalListeners = new Set<(invalidation: PrincipalInvalidation) => void>();
    const external = (invalidation: PrincipalInvalidation): void => {
      for (const listener of [...externalListeners]) listener(invalidation);
    };
    const appVerifier: CredentialVerifier = {
      revocationBound: { kind: "invalidation", deadlineMs: 1_000 },
      subscribeInvalidation: (listener) => {
        externalListeners.add(listener);
        return () => externalListeners.delete(listener);
      },
      verify: async () => {
        throw new Error("no external bearer is verified in this test");
      },
    };
    const { runtime } = fixture(databasePath("ackerdb-credential-external-"), appVerifier);
    const { child, grandchild } = await chain(runtime, ["orders.all", "orders.get"]);

    const published: PrincipalInvalidation[] = [];
    runtime.credentialVerifier!.subscribeInvalidation((invalidation) => {
      published.push(invalidation);
    });

    // Live delegated authority at two depths, held across the change.
    const childLease = await runtime.acquireCredentialLease(
      parseCredentialToken(child.token)!,
      "external-child-lease",
    );
    const grandchildLease = await runtime.acquireCredentialLease(
      parseCredentialToken(grandchild.token)!,
      "external-grandchild-lease",
    );

    // The application narrows the ancestor's resolver grant and publishes the
    // account invalidation live sessions and leases re-authorize on.
    external({ issuer: "https://issuer.test/", subject: "lineage-owner" });
    const deadline = Date.now() + 2_000;
    while (!grandchildLease.signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    // Both descendants abort immediately; matching is by their own synthetic
    // account, so the propagation must have re-published per token id.
    expect(childLease.signal.aborted).toBe(true);
    expect(grandchildLease.signal.aborted).toBe(true);
    childLease.release();
    grandchildLease.release();
    const subjects = published
      .filter((invalidation) => invalidation.issuer === CREDENTIAL_ISSUER)
      .map((invalidation) => invalidation.subject)
      .sort();
    expect(subjects).toContain(child.id);
    expect(subjects).toContain(grandchild.id);

    // An issuer-wide invalidation (no subject) reaches descendants too.
    const fresh = await runtime.acquireCredentialLease(
      parseCredentialToken(grandchild.token)!,
      "external-issuer-wide-lease",
    );
    external({ issuer: "https://issuer.test/" });
    const wideDeadline = Date.now() + 2_000;
    while (!fresh.signal.aborted && Date.now() < wideDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(fresh.signal.aborted).toBe(true);
    fresh.release();
  });

  test("scope resolution fails closed for a revoked vault credential", async () => {
    const { runtime } = fixture(databasePath("ackerdb-credential-closed-"));
    const principal = await user(runtime, "closed-owner", FIXTURE_SCOPES);
    const owner = session(principal, "closed-owner");
    await runtime.openSession(owner);
    const credential = await createCredential(runtime, owner, "revoked", ["orders.get"]);
    const account = Object.freeze({ issuer: CREDENTIAL_ISSUER, subject: credential.id });

    const id = nextMutation++;
    await runtime.mutation(
      owner,
      request(mutationMessage(id, String(id), { id: credential.id }, "tokens.revokeAgentToken")),
    );

    // The fixture resolver grants the full vocabulary to ANY identity: a
    // revoked credential's identity must never fall back to it.
    await expect(runtime.resolveScopes(credential.identity as never, account))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });
});
