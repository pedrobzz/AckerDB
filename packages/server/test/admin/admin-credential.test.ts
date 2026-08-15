/**
 * The Admin Credential: what makes one, how boot decides whether to mint, and
 * how an operator who is locked out clears them from a stopped database.
 *
 * There is one definition of "administrative", it lives in the vault, and every
 * path here reads it — which is what these tests are mostly about. Boot-mint
 * and the offline reset run in different processes with different amounts of
 * the framework loaded, and the first time they disagreed the database would
 * either never re-mint or lose credentials nobody counted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "@ackerdb/core";
import { ADMIN_CREDENTIAL_NAME, ensureAdminCredential } from "../../src/admin/credentials.ts";
import { ADMIN_SCOPES } from "../../src/admin/scopes.ts";
import { Registry } from "../../src/app/registry.ts";
import { resetAdminCredentials } from "../../src/auth/credential-reset.ts";
import { parseCredentialToken } from "../../src/auth/credential-token.ts";
import {
  credentialVaultOwner,
  type CredentialLimits,
} from "../../src/auth/credential-vault.ts";
import {
  ADMINISTRATIVE_GRANT,
  knownScopeVocabulary,
} from "../../src/auth/scopes.ts";
import { Engine } from "../../src/database/engine.ts";
import { DatabaseAlreadyOpenError } from "../../src/database/ownership.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { v } from "../../src/validation/v.ts";

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
});

const APP_SCOPES = ["records:read", "records:write"] as const;
const VOCABULARY = knownScopeVocabulary(APP_SCOPES);
const LIMITS: CredentialLimits = PRODUCTION_LIMITS.credentials;
const MINT = { vocabulary: VOCABULARY, limits: LIMITS, now: Date.now };

interface Fixture {
  readonly path: string;
  readonly engine: Engine;
  readonly runtime: Runtime;
  close(): void;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-admin-credential-"));
  const path = join(directory, "data.db");
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry({}),
    scopes: APP_SCOPES,
  });
  await runtime.start();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    engine.close("clean");
  };
  const value: Fixture = { path, engine, runtime, close };
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  return value;
}

/** Every id the vault currently calls administrative. */
function administrative(value: Fixture): readonly string[] {
  return value.engine[credentialVaultOwner]
    .listAdministrative(value.engine.reader)
    .map((credential) => credential.id);
}

describe("what the vault calls an Admin Credential", () => {
  test("is a root credential holding exactly the administrative grant", async () => {
    const value = await fixture();
    const vault = value.engine[credentialVaultOwner];
    const master = value.engine.writer.transaction(() =>
      vault.create(null, { name: "master", scopes: ADMINISTRATIVE_GRANT }, VOCABULARY, LIMITS, 1))();

    expect(administrative(value)).toEqual([master.id]);
  });

  test("does not depend on the order the two patterns were stored in", async () => {
    const value = await fixture();
    const vault = value.engine[credentialVaultOwner];
    const master = value.engine.writer.transaction(() =>
      vault.create(null, { name: "reversed", scopes: ["_*", "*"] }, VOCABULARY, LIMITS, 1))();

    expect(administrative(value)).toEqual([master.id]);
  });

  test("is not a root credential whose grant is anything else", async () => {
    const value = await fixture();
    const vault = value.engine[credentialVaultOwner];
    value.engine.writer.transaction(() => {
      // Everything the framework has, and the whole application vocabulary
      // named outright: today this expands to the same set as the
      // administrative grant, and it is still not one.
      vault.create(null, { name: "framework only", scopes: ["_*"] }, VOCABULARY, LIMITS, 1);
      vault.create(
        null,
        { name: "enumerated", scopes: ["_admin:*", ...APP_SCOPES] },
        VOCABULARY,
        LIMITS,
        1,
      );
    })();

    expect(administrative(value)).toEqual([]);
  });

  test("is not a child credential, however generous its own patterns", async () => {
    const value = await fixture();
    const vault = value.engine[credentialVaultOwner];
    const created = value.engine.writer.transaction(() => {
      const master = vault.create(
        null,
        { name: "master", scopes: ADMINISTRATIVE_GRANT },
        VOCABULARY,
        LIMITS,
        1,
      );
      const delegate = vault.create(
        master.identity,
        { name: "delegate", scopes: ADMINISTRATIVE_GRANT },
        VOCABULARY,
        LIMITS,
        1,
      );
      return { master, delegate };
    })();

    // A delegate's authority is intersected with its parent's at use, so it is
    // bounded by a master rather than being one. Counting it would make a
    // rotation revoke credentials that were never masters.
    expect(administrative(value)).toEqual([created.master.id]);
  });
});

describe("boot-mint", () => {
  test("issues one master on a fresh vault and discloses the plaintext once", async () => {
    const value = await fixture();
    const minted = ensureAdminCredential(value.engine, MINT);

    expect(minted.token).toBeString();
    expect(administrative(value)).toEqual([minted.id]);
    expect(minted.token!.startsWith(`ackerdb_credential.${minted.id}.`)).toBe(true);
  });

  test("holds the whole vocabulary, application scopes and framework scopes alike", async () => {
    const value = await fixture();
    const minted = ensureAdminCredential(value.engine, MINT);
    const parsed = parseCredentialToken(minted.token!);
    if (parsed === null) throw new Error("a minted credential must parse");

    // No authentication authority is configured on this Runtime at all: the
    // vault verifier is what admits the bearer, and the grant it expands to is
    // the point of the credential existing.
    const lease = await value.runtime.acquireCredentialLease(parsed, "test:boot-mint");
    try {
      expect(lease.principal.kind).toBe("user");
      expect([...lease.principal.scopes].sort())
        .toEqual([...APP_SCOPES, ...ADMIN_SCOPES].sort());
    } finally {
      lease.release();
    }
  });

  test("mints nothing, and discloses nothing, when one already exists", async () => {
    const value = await fixture();
    const first = ensureAdminCredential(value.engine, MINT);
    const before = value.engine.commitVersion();
    const second = ensureAdminCredential(value.engine, MINT);

    expect(second).toEqual({ id: first.id });
    expect(administrative(value)).toEqual([first.id]);
    // A boot with nothing to do writes nothing, exactly as every other
    // conditional startup step does.
    expect(value.engine.commitVersion()).toBe(before);
  });

  test("names every master the same, because the product manages one", async () => {
    const value = await fixture();
    ensureAdminCredential(value.engine, MINT);

    expect(
      value.engine[credentialVaultOwner]
        .listAdministrative(value.engine.reader)
        .map((credential) => credential.name),
    ).toEqual([ADMIN_CREDENTIAL_NAME]);
  });
});

describe("break-glass", () => {
  test("clears the masters and everything delegated beneath them", async () => {
    const value = await fixture();
    const minted = ensureAdminCredential(value.engine, MINT);
    const vault = value.engine[credentialVaultOwner];
    const masterIdentity = vault.listAdministrative(value.engine.reader)[0]!.identity as Identity;
    const delegate = value.engine.writer.transaction(() =>
      vault.create(masterIdentity, { name: "agent", scopes: ["records:read"] }, VOCABULARY, LIMITS, 1))();
    value.close();

    const result = resetAdminCredentials(value.path);

    expect([...result.cleared].sort()).toEqual([minted.id, delegate.id].sort());
    // The canonical path the ownership lock resolved, which is what any other
    // holder of this database would have had to name too.
    expect(result.database).toEndWith("/data.db");
  });

  test("refuses while the database is open, and clears nothing", async () => {
    const value = await fixture();
    const minted = ensureAdminCredential(value.engine, MINT);

    // The stopped-server guarantee is the ownership lock, not a check of its
    // own that could disagree with one.
    expect(() => resetAdminCredentials(value.path)).toThrow(DatabaseAlreadyOpenError);
    expect(administrative(value)).toEqual([minted.id]);
  });

  test("leaves the next boot to mint a fresh master", async () => {
    const value = await fixture();
    const first = ensureAdminCredential(value.engine, MINT);
    value.close();
    resetAdminCredentials(value.path);

    const restarted = await fixtureAt(value.path);
    const second = ensureAdminCredential(restarted.engine, MINT);

    expect(second.token).toBeString();
    expect(second.id).not.toBe(first.id);
  });

  test("treats a database that does not exist as nothing to clear", () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-admin-credential-absent-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "data.db");

    const result = resetAdminCredentials(path);

    expect(result.cleared).toEqual([]);
    // The recovery command must not conjure the database it was asked about:
    // the next start is what creates and reconciles one.
    expect(existsSync(path)).toBe(false);
  });
});

/** A second Runtime over a database that already exists, for restart cases. */
async function fixtureAt(path: string): Promise<Fixture> {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry({}),
    scopes: APP_SCOPES,
  });
  await runtime.start();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    engine.close("clean");
  };
  const value: Fixture = { path, engine, runtime, close };
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    close();
  });
  return value;
}
