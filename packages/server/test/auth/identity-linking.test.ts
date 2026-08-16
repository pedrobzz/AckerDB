import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  verifyClientCredential,
  type CredentialVerifier,
  type Principal,
  type PrincipalInvalidation,
  type UserPrincipal,
  type VerifiedCredential,
} from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { procedure } from "../../src/app/functions.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { storedIdentityForAccount } from "../support/identities.ts";

const NOW = 2_000_000;
const ISSUER_A = "https://issuer-a.identity.test/";
const ISSUER_B = "https://issuer-b.identity.test/";
const ROLLBACK_ISSUER = "https://rollback.identity.test/";
const SHARED_CLAIMS = Object.freeze({
  email: "shared@example.test",
  phone: "+15550000000",
  name: "Shared Person",
});

const schema = defineSchema({
  owned: defineTable({
    id: v.primaryKey(),
    userId: v.identity(),
    value: v.string(),
  }).index(["userId"], { unique: true }),
});

// Runtime behavior is under test; generated application types are irrelevant here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  accounts: {
    link: procedure({
      access: "public",
      http: true,
      args: { rawBearerToken: v.string() },
      handler: async (ctx: Ctx, args: { rawBearerToken: string }) => {
        await ctx.linkAccount(args.rawBearerToken);
        return true;
      },
    }),
  },
  owned: {
    create: procedure({
      access: (ctx) => ctx.auth.kind === "user",
      http: true,
      args: { value: v.string() },
      handler: (ctx: Ctx, args: { value: string }) => {
        if (ctx.auth.kind !== "user") throw new Error("user required");
        return ctx.tx((tx: Ctx) => tx.db.owned.insert({
          userId: ctx.auth.identity,
          value: args.value,
        }));
      },
    }),
    current: procedure({
      access: (ctx) => ctx.auth.kind === "user",
      http: true,
      args: {},
      handler: (ctx: Ctx) => {
        if (ctx.auth.kind !== "user") throw new Error("user required");
        return ctx.tx((tx: Ctx) => tx.db.owned
          .query()
          .where((row: Ctx) => row.userId.eq(ctx.auth.identity))
          .unique());
      },
    }),
  },
};

function user(issuer: string, subject: string): VerifiedCredential {
  return {
    kind: "user",
    issuer,
    subject,
    claims: SHARED_CLAIMS,
    expiresAt: NOW + 60_000,
    tokenId: `${issuer}:${subject}`,
  };
}

class LinkingVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;
  readonly calls: string[] = [];
  readonly verifiedInsideWriter: boolean[] = [];
  readonly credentials = new Map<string, VerifiedCredential>([
    ["alice-a", user(ISSUER_A, "alice")],
    ["alice-b", user(ISSUER_B, "alice")],
    ["bob-a", user(ISSUER_A, "bob")],
    ["rollback", user(ROLLBACK_ISSUER, "alice")],
    ["workload", {
      kind: "workload",
      issuer: "https://workloads.identity.test/",
      subject: "worker",
      claims: SHARED_CLAIMS,
      expiresAt: NOW + 60_000,
      tokenId: "workload-token",
    }],
  ]);

  constructor(private readonly engine: Engine) {}

  async verify(rawBearerToken: string): Promise<VerifiedCredential> {
    this.calls.push(rawBearerToken);
    this.verifiedInsideWriter.push(this.engine.writer.inTransaction);
    const credential = this.credentials.get(rawBearerToken);
    if (credential === undefined) {
      throw new AckerDBError("unauthenticated", "invalid credential");
    }
    return credential;
  }

  subscribeInvalidation(_listener: (invalidation: PrincipalInvalidation) => void): () => void {
    return () => {};
  }
}

interface Harness {
  readonly directory: string;
  readonly engine: Engine;
  readonly runtime: Runtime;
  readonly verifier: LinkingVerifier;
}

const harnesses: Harness[] = [];

async function open(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-identity-linking-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const verifier = new LinkingVerifier(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    verifier,
    now: () => NOW,
  });
  await runtime.start();
  const harness = { directory, engine, runtime, verifier };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ directory, engine, runtime }) => {
    await runtime.drain().catch(() => {});
    try {
      engine.close("clean");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }));
});

async function authenticate(
  runtime: Runtime,
  verifier: CredentialVerifier,
  rawBearerToken: string,
): Promise<UserPrincipal> {
  const principal = await verifyClientCredential(
    { kind: "bearer", token: rawBearerToken },
    verifier,
    (account) => runtime.resolveIdentity(account),
    () => NOW,
  );
  if (principal.kind !== "user") throw new Error("expected user principal");
  return principal;
}

async function invoke(
  runtime: Runtime,
  principal: Principal,
  id: number,
  address: string,
  args: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await runtime.runProcedure({
    id,
    address,
    args,
    principal,
    respond: ({ body, status }) => new Response(body, { status }),
  });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

function directoryCounts(engine: Engine): { identities: bigint; accounts: bigint } {
  return engine.writer
    .query(`SELECT
      (SELECT COUNT(*) FROM _ackerdb_identities) AS identities,
      (SELECT COUNT(*) FROM _ackerdb_identity_accounts) AS accounts`)
    .get() as { identities: bigint; accounts: bigint };
}

describe("explicit provider-neutral account linking", () => {
  test("links two exact issuers to one Identity and both credentials own the same row", async () => {
    const { engine, runtime, verifier } = await open();
    const aliceA = await authenticate(runtime, verifier, "alice-a");
    expect(directoryCounts(engine)).toEqual({ identities: 1n, accounts: 1n });

    expect(await invoke(runtime, aliceA, 1, "api.owned.create", { value: "same owner" }))
      .toMatchObject({ status: 200 });
    expect(await invoke(runtime, aliceA, 2, "api.accounts.link", { rawBearerToken: "alice-b" }))
      .toEqual({ status: 200, body: true });
    expect(directoryCounts(engine)).toEqual({ identities: 1n, accounts: 2n });

    const aliceB = await authenticate(runtime, verifier, "alice-b");
    expect(aliceB.identity).toBe(aliceA.identity);
    const throughA = await invoke(runtime, aliceA, 3, "api.owned.current", {});
    const throughB = await invoke(runtime, aliceB, 4, "api.owned.current", {});
    expect(throughA).toMatchObject({
      status: 200,
      body: { userId: String(aliceA.identity), value: "same owner" },
    });
    expect(throughB).toMatchObject({
      status: 200,
      body: { userId: String(aliceA.identity), value: "same owner" },
    });

    expect(await invoke(runtime, aliceA, 5, "api.accounts.link", { rawBearerToken: "alice-b" }))
      .toEqual({ status: 200, body: true });
    expect(directoryCounts(engine)).toEqual({ identities: 1n, accounts: 2n });
    expect(verifier.verifiedInsideWriter.every((inside) => !inside)).toBe(true);
  });

  test("rejects callers without user proof and never merges a conflicting Identity", async () => {
    const { engine, runtime, verifier } = await open();
    const alice = await authenticate(runtime, verifier, "alice-a");
    const bob = await authenticate(runtime, verifier, "bob-a");
    expect(alice.identity).not.toBe(bob.identity);

    const callsBeforeAnonymous = verifier.calls.length;
    expect(await invoke(
      runtime,
      ANONYMOUS_PRINCIPAL,
      10,
      "api.accounts.link",
      { rawBearerToken: "alice-b" },
    )).toMatchObject({ status: 403, body: { code: "unauthorized" } });
    expect(verifier.calls).toHaveLength(callsBeforeAnonymous);
    expect(storedIdentityForAccount(engine, ISSUER_B, "alice")).toBeNull();

    for (const [id, rawBearerToken] of [
      [11, "shared@example.test"],
      [12, "invalid-token"],
      [13, "workload"],
    ] as const) {
      expect(await invoke(runtime, alice, id, "api.accounts.link", { rawBearerToken }))
        .toMatchObject({ status: 401, body: { code: "unauthenticated" } });
    }
    expect(storedIdentityForAccount(engine, ISSUER_B, "alice")).toBeNull();

    const conflict = await invoke(
      runtime,
      alice,
      14,
      "api.accounts.link",
      { rawBearerToken: "bob-a" },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      code: "conflict",
      retryable: false,
      message: "external account is already linked",
    });
    expect(storedIdentityForAccount(engine, ISSUER_A, "bob")).toBe(bob.identity);
    expect(directoryCounts(engine)).toEqual({ identities: 2n, accounts: 2n });
    expect(verifier.verifiedInsideWriter.every((inside) => !inside)).toBe(true);
  });

  test("rolls back a failed canonical writer turn without leaving an account link", async () => {
    const { engine, runtime, verifier } = await open();
    const alice = await authenticate(runtime, verifier, "alice-a");
    engine.writer.exec(`CREATE TEMP TRIGGER fail_identity_link
      AFTER INSERT ON _ackerdb_identity_accounts
      WHEN NEW.issuer = '${ROLLBACK_ISSUER}'
      BEGIN
        SELECT RAISE(FAIL, 'forced identity link failure');
      END`);

    const failed = await invoke(
      runtime,
      alice,
      20,
      "api.accounts.link",
      { rawBearerToken: "rollback" },
    );
    expect(failed.status).toBe(500);
    expect(storedIdentityForAccount(engine, ROLLBACK_ISSUER, "alice")).toBeNull();
    expect(directoryCounts(engine)).toEqual({ identities: 1n, accounts: 1n });
    expect(engine.writer.inTransaction).toBe(false);

    engine.writer.exec("DROP TRIGGER fail_identity_link");
    expect(await invoke(runtime, alice, 21, "api.accounts.link", { rawBearerToken: "rollback" }))
      .toEqual({ status: 200, body: true });
    expect(storedIdentityForAccount(engine, ROLLBACK_ISSUER, "alice"))
      .toBe(alice.identity);
    expect(verifier.verifiedInsideWriter.every((inside) => !inside)).toBe(true);
  });
});
