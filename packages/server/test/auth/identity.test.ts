import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, encode, type MutationMessage, type QueryMessage } from "@ackerdb/core";
import {
  verifyClientCredential,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type UserPrincipal,
  type VerifiedUserCredential,
} from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v, type Identity } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { mutation, query } from "../../src/app/functions.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import type {
  RuntimePort,
  RuntimeRequest,
  SessionRuntimeContext,
} from "../../src/subscriptions/session/contract.ts";

const directories: string[] = [];
const instances = new Map<Runtime, Engine>();

afterEach(async () => {
  await Promise.all([...instances].map(async ([runtime, engine]) => {
    await runtime.drain().catch(() => {});
    try {
      engine.close("clean");
    } catch {
      // The assertion failure remains primary; test cleanup is best effort.
    }
  }));
  instances.clear();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

const schema = defineSchema({
  owned: defineTable({
    id: v.primaryKey(),
    userId: v.identity(),
    value: v.string(),
  }).index(["userId"], { unique: true }),
});

// Runtime behavior is exercised here; identity.check.ts proves the public generic context.
type Ctx = any;

const functions = {
  owned: {
    create: mutation({
      args: { value: v.string() },
      access: (ctx) => ctx.auth.kind === "user",
      handler: (ctx: Ctx, args: { value: string }) => ctx.db.owned.insert({
        userId: ctx.auth.identity,
        value: args.value,
      }),
    }),
    current: query({
      args: {},
      access: (ctx) => ctx.auth.kind === "user",
      handler: (ctx: Ctx) => ctx.db.owned
        .query()
        .where((row: Ctx) => row.userId.eq(ctx.auth.identity))
        .unique(),
    }),
  },
};

function open(path: string): { engine: Engine; runtime: Runtime } {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    telemetry: false,
  });
  instances.set(runtime, engine);
  return { engine, runtime };
}

function verifier(subject: string, claims: Record<string, unknown>): CredentialVerifier {
  return {
    revocationBound: { kind: "token-expiration" },
    subscribeInvalidation: (_listener: (invalidation: PrincipalInvalidation) => void) => () => {},
    verify: async (): Promise<VerifiedUserCredential> => ({
      kind: "user",
      issuer: "https://issuer.example/",
      subject,
      claims,
      expiresAt: Date.now() + 60_000,
      tokenId: null,
    }),
  };
}

function authenticate(
  runtime: RuntimePort,
  credentialVerifier: CredentialVerifier,
): Promise<UserPrincipal> {
  return verifyClientCredential(
    { kind: "bearer", token: "verified-token" },
    credentialVerifier,
    (account) => runtime.resolveIdentity(account),
  ).then((principal) => {
    if (principal.kind !== "user") throw new Error("expected a user principal");
    return principal;
  });
}

function request<Message>(message: Message): RuntimeRequest<Message> {
  return Object.freeze({ message, bytes: Buffer.byteLength(encode(message)) });
}

function uuidV7(sequence: number): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function session(principal: UserPrincipal, clientSessionId: string): SessionRuntimeContext {
  return Object.freeze({
    clientSessionId,
    principal,
    fairnessKey: callerFairnessKey(principal, { family: "test", address: clientSessionId }),
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async () => true,
  });
}

describe("durable provider-neutral Identity", () => {
  test("concurrent misses converge and committed accounts stay on the bounded reader hot path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-identity-race-"));
    directories.push(directory);
    const { engine, runtime } = open(join(directory, "data.db"));
    const alice = { issuer: "https://issuer.example/", subject: "alice" } as const;
    const bob = { issuer: "https://issuer.example/", subject: "bob" } as const;

    const resolved = await Promise.all(
      Array.from({ length: 32 }, (_, index) => {
        const account = index % 3 === 0 ? bob : alice;
        return runtime.resolveIdentity(account);
      }),
    );
    const aliceIds = resolved.filter((_identity, index) => index % 3 !== 0);
    const bobIds = resolved.filter((_identity, index) => index % 3 === 0);
    expect(new Set(aliceIds).size).toBe(1);
    expect(new Set(bobIds).size).toBe(1);
    expect(aliceIds[0]).not.toBe(bobIds[0]);

    const accounts = engine.writer
      .query("SELECT issuer, subject, identity FROM _ackerdb_identity_accounts ORDER BY subject")
      .all() as { issuer: string; subject: string; identity: bigint }[];
    expect(accounts).toEqual([
      { ...alice, identity: aliceIds[0] as bigint },
      { ...bob, identity: bobIds[0] as bigint },
    ]);
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_identities").get())
      .toEqual({ count: 2n });

    const writerAdmissions = runtime.status().writer.admitted;
    expect(await runtime.resolveIdentity(alice)).toBe(aliceIds[0]!);
    expect(runtime.status().writer.admitted).toBe(writerAdmissions);

    expect(Object.keys(schema.tables)).toEqual(["owned"]);
    expect([...engine.plans.keys()]).toEqual(["owned"]);
    expect(runtime.kindOf("_ackerdb_identities")).toBeNull();
    expect(runtime.kindOf("_ackerdb_identity_accounts")).toBeNull();
    expect(
      (engine.writer.query("PRAGMA table_info('_ackerdb_identity_accounts')").all() as { name: string }[])
        .map(({ name }) => name),
    ).toEqual(["issuer", "subject", "identity"]);
  });

  test("an authenticated mutation owns rows by Identity across reconnect and restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-identity-restart-"));
    directories.push(directory);
    const path = join(directory, "data.db");

    const first = open(path);
    const firstPrincipal = await authenticate(first.runtime, verifier("alice", {
      email: "first@example.test",
    }));
    expect(Object.isFrozen(firstPrincipal)).toBe(true);
    expect(Object.isFrozen(firstPrincipal.claims)).toBe(true);
    const firstSession = session(firstPrincipal, "first-session");
    await first.runtime.openSession(firstSession);
    const issuedAt = Date.now();
    const mutationMessage: MutationMessage = {
      v: PROTOCOL_VERSION,
      t: "m",
      id: 1,
      ref: "owned.create",
      args: { value: "persisted" },
      mutationRequestId: uuidV7(1),
      issuedAt,
    };
    await first.runtime.mutation(firstSession, request(mutationMessage));
    await first.runtime.closeSession(firstSession, {
      code: "unavailable",
      retryable: false,
      message: "test restart",
    });
    await first.runtime.drain();
    instances.delete(first.runtime);
    first.engine.close("clean");

    const second = open(path);
    const secondPrincipal = await authenticate(second.runtime, verifier("alice", {
      email: "changed@example.test",
      displayName: "Changed claim",
    }));
    expect(secondPrincipal.identity).toBe(firstPrincipal.identity);
    const secondSession = session(secondPrincipal, "second-session");
    await second.runtime.openSession(secondSession);
    const queryMessage: QueryMessage = {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "owned.current",
      args: {},
    };
    expect(await second.runtime.query(secondSession, request(queryMessage))).toEqual({
      id: 1n,
      userId: firstPrincipal.identity,
      value: "persisted",
    });

    const next = await second.runtime.resolveIdentity({
      issuer: "https://issuer.example/",
      subject: "next-user",
    });
    expect((next as bigint) > (firstPrincipal.identity as bigint)).toBe(true);
    expect(second.engine.identityForAccount(
      second.engine.reader,
      "https://issuer.example/",
      "alice",
    )).toBe(firstPrincipal.identity);

    second.engine.writer.exec("BEGIN IMMEDIATE");
    second.engine.writer
      .query("DELETE FROM _ackerdb_identity_accounts WHERE issuer = ? AND subject = ?")
      .run("https://issuer.example/", "next-user");
    second.engine.writer
      .query("DELETE FROM _ackerdb_identities WHERE identity = ?")
      .run(next);
    second.engine.writer.exec("COMMIT");
    const reprovisioned = await second.runtime.resolveIdentity({
      issuer: "https://issuer.example/",
      subject: "next-user",
    });
    expect((reprovisioned as bigint) > (next as bigint)).toBe(true);
  });

  test("non-user credentials never invoke the Identity resolver", async () => {
    let resolutions = 0;
    const workloadVerifier: CredentialVerifier = {
      revocationBound: { kind: "token-expiration" },
      subscribeInvalidation: () => () => {},
      verify: async () => ({
        kind: "workload",
        issuer: "https://issuer.example/",
        subject: "service",
        claims: {},
        expiresAt: Date.now() + 60_000,
        tokenId: null,
      }),
    };
    const principal = await verifyClientCredential(
      { kind: "bearer", token: "service-token" },
      workloadVerifier,
      async () => {
        resolutions++;
        return 1n as Identity;
      },
    );

    expect(principal.kind).toBe("workload");
    expect(resolutions).toBe(0);
    expect("identity" in principal).toBe(false);
  });
});
