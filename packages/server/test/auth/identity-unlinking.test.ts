import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, decode, encode, type Outcome } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  verifyClientCredential,
  type CredentialVerifier,
  type ExternalAccount,
  type Principal,
  type PrincipalInvalidation,
  type UserPrincipal,
  type VerifiedCredential,
} from "../../src/auth/credentials.ts";
import { acquireAuthLease, type AuthLease } from "../../src/auth/lease.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { procedure } from "../../src/app/functions.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { carryHttpRequestProvenance } from "../../src/runtime/request-provenance.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeHttpResponse } from "../../src/runtime/contracts/requests.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import {
  Session,
  type RuntimePublication,
  type SessionControlMessage,
  type SessionSink,
} from "../../src/subscriptions/session.ts";
import { deferred, type Deferred } from "ackerdb-test-support/async";

const NOW = 2_000_000;
const ISSUER_A = "https://issuer-a.identity.test/";
const ISSUER_B = "https://issuer-b.identity.test/";
const ISSUER_C = "https://issuer-c.identity.test/";
const ROLLBACK_ISSUER = "https://rollback.identity.test/";
const TEST_SOURCE = Object.freeze({ family: "test", address: "identity-unlinking" });
const CLOCK = Object.freeze({
  now: () => NOW,
  setTimeout: (_callback: () => void, _delayMs: number) => 1,
  clearTimeout: (_handle: unknown) => {},
});

const ALICE_A = Object.freeze({ issuer: ISSUER_A, subject: "alice" });
const ALICE_B = Object.freeze({ issuer: ISSUER_B, subject: "alice" });
const ALICE_C = Object.freeze({ issuer: ISSUER_C, subject: "alice" });
const ALICE_ROLLBACK = Object.freeze({ issuer: ROLLBACK_ISSUER, subject: "alice" });
const BOB_A = Object.freeze({ issuer: ISSUER_A, subject: "bob" });

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

interface UnlinkStall {
  readonly committed: Deferred<void>;
  readonly release: Deferred<void>;
}

let unlinkStall: UnlinkStall | undefined;

const functions = {
  accounts: {
    link: procedure({
      access: "public",
      http: true,
      args: { rawBearerToken: v.string() },
      handler: (ctx: Ctx, args: { rawBearerToken: string }) =>
        ctx.linkAccount(args.rawBearerToken),
    }),
    unlink: procedure({
      access: "public",
      http: true,
      args: { issuer: v.string(), subject: v.string() },
      handler: async (ctx: Ctx, account: ExternalAccount) => {
        await ctx.unlinkAccount(account);
        return true;
      },
    }),
    unlinkThenFail: procedure({
      access: "public",
      http: true,
      args: { issuer: v.string(), subject: v.string() },
      handler: async (ctx: Ctx, account: ExternalAccount) => {
        await ctx.unlinkAccount(account);
        throw new Error("handler failed after committed unlink");
      },
    }),
    unlinkAndWait: procedure({
      access: "public",
      http: true,
      args: { issuer: v.string(), subject: v.string() },
      handler: async (ctx: Ctx, account: ExternalAccount) => {
        const stall = unlinkStall;
        if (stall === undefined) throw new Error("unlink stall is not installed");
        await ctx.unlinkAccount(account);
        stall.committed.resolve(undefined);
        await stall.release.promise;
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

function user(account: ExternalAccount, tokenId: string): VerifiedCredential {
  return Object.freeze({
    kind: "user",
    ...account,
    claims: Object.freeze({ role: "member" }),
    expiresAt: NOW + 60_000,
    tokenId,
  });
}

interface VerificationBlock {
  readonly entered: Promise<void>;
  release(): void;
}

class UnlinkVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "invalidation", deadlineMs: 1 } as const;
  readonly credentials = new Map<string, VerifiedCredential>([
    ["alice-a", user(ALICE_A, "alice-a")],
    ["alice-b", user(ALICE_B, "alice-b")],
    ["alice-c", user(ALICE_C, "alice-c")],
    ["alice-rollback", user(ALICE_ROLLBACK, "alice-rollback")],
    ["bob-a", user(BOB_A, "bob-a")],
  ]);
  private readonly blocks = new Map<string, {
    readonly entered: Deferred<void>;
    readonly released: Deferred<void>;
  }>();
  private readonly listeners = new Set<(invalidation: PrincipalInvalidation) => void>();

  block(token: string): VerificationBlock {
    const entered = deferred<void>();
    const released = deferred<void>();
    this.blocks.set(token, { entered, released });
    return { entered: entered.promise, release: () => released.resolve(undefined) };
  }

  async verify(token: string): Promise<VerifiedCredential> {
    const block = this.blocks.get(token);
    if (block !== undefined) {
      block.entered.resolve(undefined);
      await block.released.promise;
      if (this.blocks.get(token) === block) this.blocks.delete(token);
    }
    const credential = this.credentials.get(token);
    if (credential === undefined) throw new AckerDBError("unauthenticated", "invalid credential");
    return credential;
  }

  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

interface Harness {
  readonly directory: string;
  readonly engine: Engine;
  readonly runtime: Runtime;
  readonly verifier: UnlinkVerifier;
}

const directories = new Set<string>();
const harnesses = new Set<Harness>();

function open(directory = mkdtempSync(join(tmpdir(), "ackerdb-identity-unlinking-"))): Harness {
  directories.add(directory);
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const verifier = new UnlinkVerifier();
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    verifier,
    telemetry: false,
    now: () => NOW,
  });
  const harness = { directory, engine, runtime, verifier };
  harnesses.add(harness);
  return harness;
}

async function shutdown(harness: Harness): Promise<void> {
  if (!harnesses.delete(harness)) return;
  await harness.runtime.drain().catch(() => {});
  harness.engine.close("clean");
}

afterEach(async () => {
  unlinkStall = undefined;
  await Promise.all([...harnesses].map(shutdown));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

async function authenticate(harness: Harness, token: string): Promise<UserPrincipal> {
  const principal = await verifyClientCredential(
    { kind: "bearer", token },
    harness.runtime.credentialVerifier,
    (account, signal) => harness.runtime.resolveIdentity(account, signal),
    () => NOW,
  );
  if (principal.kind !== "user") throw new Error("expected user principal");
  return principal;
}

async function acquire(harness: Harness, token: string) {
  return acquireAuthLease({
    credential: { kind: "bearer", token },
    verifier: harness.runtime.credentialVerifier,
    resolveIdentity: (account, signal) => harness.runtime.resolveIdentity(account, signal),
    revocationDeadlineMs: 5_000,
    clock: CLOCK,
  });
}

let requestId = 0;

async function invoke(
  harness: Harness,
  principal: Principal,
  address: string,
  args: unknown,
  options: {
    readonly signal?: AbortSignal;
    readonly lease?: AuthLease;
    handoff?(): void;
  } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const signal = options.lease?.signal ?? options.signal;
  const request = {
    id: ++requestId,
    address,
    args,
    principal,
    ...(signal === undefined ? {} : { signal }),
    respond: ({ body, status }: RuntimeHttpResponse) => {
      options.handoff?.();
      return new Response(body, { status });
    },
  };
  const carried = options.lease?.invalidationScope === undefined
    ? request
    : carryHttpRequestProvenance(request, 1, undefined, options.lease.invalidationScope);
  const response = await harness.runtime.runProcedure(carried);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

async function link(harness: Harness, principal: UserPrincipal, token: string): Promise<void> {
  expect(await invoke(harness, principal, "accounts.link", { rawBearerToken: token }))
    .toMatchObject({ status: 200 });
}

function directoryCounts(engine: Engine): { identities: bigint; accounts: bigint; owned: bigint } {
  return engine.writer.query(`SELECT
    (SELECT COUNT(*) FROM _ackerdb_identities) AS identities,
    (SELECT COUNT(*) FROM _ackerdb_identity_accounts) AS accounts,
    (SELECT COUNT(*) FROM owned) AS owned`).get() as {
      identities: bigint;
      accounts: bigint;
      owned: bigint;
    };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

class RecordingSink implements SessionSink {
  readonly controls: SessionControlMessage[] = [];
  readonly closes: Outcome[] = [];

  async sendControl(message: SessionControlMessage): Promise<void> {
    this.controls.push(message);
  }

  async sendApplication(_authEpoch: number, _publication: RuntimePublication): Promise<void> {}
  async dropApplicationFramesBefore(_authEpoch: number): Promise<void> {}

  async close(outcome: Outcome): Promise<void> {
    this.closes.push(outcome);
  }
}

function hello(session: Session, token: string, clientSessionId: string): Promise<void> {
  return session.handle(encode({
    v: PROTOCOL_VERSION,
    t: "hello",
    clientSessionId,
    credential: { kind: "bearer", token },
  }));
}

describe("transactional external-account unlinking", () => {
  test("returns a truthful self-unlink response, retains application ownership, and stays detached across restart", async () => {
    let harness = open();
    const aliceA = await authenticate(harness, "alice-a");
    await link(harness, aliceA, "alice-b");
    expect(await invoke(harness, aliceA, "owned.create", { value: "durable owner" }))
      .toMatchObject({ status: 200 });

    const lease = await acquire(harness, "alice-a");
    let handedOff = false;
    const invalidationOrder: boolean[] = [];
    const unsubscribe = harness.runtime.credentialVerifier!.subscribeInvalidation((event) => {
      if (event.issuer === ALICE_A.issuer && event.subject === ALICE_A.subject) {
        invalidationOrder.push(handedOff);
      }
    });
    const unlinked = await invoke(harness, lease.principal, "accounts.unlink", ALICE_A, {
      lease,
      handoff: () => {
        expect(lease.signal.aborted).toBe(false);
        handedOff = true;
      },
    });
    unsubscribe();

    expect(unlinked).toEqual({ status: 200, body: true });
    expect(invalidationOrder).toEqual([false]);
    expect(lease.signal).toMatchObject({ aborted: true });
    expect(harness.engine.identityForAccount(harness.engine.reader, ISSUER_A, "alice")).toBeNull();
    expect(directoryCounts(harness.engine)).toEqual({ identities: 1n, accounts: 1n, owned: 1n });

    const directory = harness.directory;
    await shutdown(harness);
    harness = open(directory);
    const aliceB = await authenticate(harness, "alice-b");
    expect(aliceB.identity).toBe(aliceA.identity);
    expect(harness.engine.identityForAccount(harness.engine.reader, ISSUER_A, "alice")).toBeNull();
    expect(await invoke(harness, aliceB, "owned.current", {})).toMatchObject({
      status: 200,
      body: { userId: String(aliceA.identity), value: "durable owner" },
    });

    const freshAliceA = await authenticate(harness, "alice-a");
    expect(freshAliceA.identity).not.toBe(aliceA.identity);
    expect(directoryCounts(harness.engine)).toEqual({ identities: 2n, accounts: 2n, owned: 1n });
  });

  test("uses one safe ownership denial and blocks removal of the final account", async () => {
    const harness = open();
    const alice = await authenticate(harness, "alice-a");
    await link(harness, alice, "alice-b");
    const bob = await authenticate(harness, "bob-a");

    const denied = await Promise.all([
      invoke(harness, ANONYMOUS_PRINCIPAL, "accounts.unlink", ALICE_A),
      invoke(harness, alice, "accounts.unlink", BOB_A),
      invoke(harness, alice, "accounts.unlink", { issuer: ISSUER_C, subject: "missing" }),
    ]);
    expect(denied.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(denied.map(({ body }) => body)).toEqual([
        { code: "unauthorized", retryable: false, message: "account unlinking requires ownership" },
        { code: "unauthorized", retryable: false, message: "account unlinking requires ownership" },
        { code: "unauthorized", retryable: false, message: "account unlinking requires ownership" },
      ]);

    expect(await invoke(harness, bob, "accounts.unlink", BOB_A)).toMatchObject({
      status: 409,
      body: { code: "conflict", message: "cannot unlink the final external account" },
    });
    expect(harness.engine.identityForAccount(harness.engine.reader, ISSUER_A, "bob"))
      .toBe(bob.identity);
    expect(directoryCounts(harness.engine)).toEqual({ identities: 2n, accounts: 3n, owned: 0n });
  });

  test("publishes only committed deletes, including a committed unlink followed by handler failure", async () => {
    const harness = open();
    const alice = await authenticate(harness, "alice-a");
    await link(harness, alice, "alice-b");
    await link(harness, alice, "alice-c");
    await link(harness, alice, "alice-rollback");
    const invalidations: PrincipalInvalidation[] = [];
    const unsubscribe = harness.runtime.credentialVerifier!.subscribeInvalidation((event) => {
      invalidations.push(event);
    });

    harness.engine.writer.exec(`CREATE TEMP TRIGGER fail_identity_unlink
      AFTER DELETE ON _ackerdb_identity_accounts
      WHEN OLD.issuer = '${ROLLBACK_ISSUER}'
      BEGIN
        SELECT RAISE(FAIL, 'forced identity unlink failure');
      END`);
    expect(await invoke(harness, alice, "accounts.unlink", ALICE_ROLLBACK))
      .toMatchObject({ status: 500 });
    expect(invalidations).toEqual([]);
    expect(harness.engine.identityForAccount(harness.engine.reader, ROLLBACK_ISSUER, "alice"))
      .toBe(alice.identity);
    harness.engine.writer.exec("DROP TRIGGER fail_identity_unlink");

    expect(await invoke(harness, alice, "accounts.unlink", ALICE_ROLLBACK))
      .toMatchObject({ status: 200 });
    expect(await invoke(harness, alice, "accounts.unlinkThenFail", ALICE_C))
      .toMatchObject({ status: 500 });
    unsubscribe();
    expect(invalidations).toEqual([
      { issuer: ROLLBACK_ISSUER, subject: "alice" },
      { issuer: ISSUER_C, subject: "alice" },
    ]);
    expect(harness.engine.identityForAccount(harness.engine.reader, ROLLBACK_ISSUER, "alice"))
      .toBeNull();
    expect(harness.engine.identityForAccount(harness.engine.reader, ISSUER_C, "alice"))
      .toBeNull();
    expect(directoryCounts(harness.engine)).toEqual({ identities: 1n, accounts: 2n, owned: 0n });
  });

  test("invalidates a live Session and the exact credential lease after commit", async () => {
    const harness = open();
    const alice = await authenticate(harness, "alice-a");
    await link(harness, alice, "alice-b");
    const lease = await acquire(harness, "alice-a");
    const sink = new RecordingSink();
    const session = new Session({
      runtime: harness.runtime,
      sink,
      source: TEST_SOURCE,
      clock: CLOCK,
    });
    await hello(session, "alice-a", "active-account-session");
    expect(session.snapshot().phase).toBe("active");

    expect(await invoke(harness, alice, "accounts.unlink", ALICE_A))
      .toMatchObject({ status: 200 });
    await settle();
    expect(lease.signal).toMatchObject({ aborted: true });
    expect(session.snapshot().phase).toBe("closed");
    expect(sink.closes[0]).toMatchObject({ code: "unauthenticated", message: "credential revoked" });
  });

  test("revokes every other consumer at commit while the one-shot origin survives through handoff", async () => {
    const harness = open();
    const alice = await authenticate(harness, "alice-a");
    await link(harness, alice, "alice-b");
    const origin = await acquire(harness, "alice-a");
    const otherLease = await acquire(harness, "alice-a");
    const sink = new RecordingSink();
    const session = new Session({
      runtime: harness.runtime,
      sink,
      source: TEST_SOURCE,
      clock: CLOCK,
    });
    await hello(session, "alice-a", "stalled-unlink-session");
    expect(session.snapshot().phase).toBe("active");

    const committed = deferred<void>();
    const release = deferred<void>();
    unlinkStall = { committed, release };
    let handedOff = false;
    const response = invoke(harness, origin.principal, "accounts.unlinkAndWait", ALICE_A, {
      lease: origin,
      handoff: () => {
        handedOff = true;
      },
    });
    await committed.promise;
    await settle();

    expect(handedOff).toBe(false);
    expect(origin.signal.aborted).toBe(false);
    expect(otherLease.signal).toMatchObject({ aborted: true });
    expect(session.snapshot().phase).toBe("closed");
    expect(sink.closes[0]).toMatchObject({ code: "unauthenticated", message: "credential revoked" });

    release.resolve(undefined);
    expect(await response).toEqual({ status: 200, body: true });
    expect(handedOff).toBe(true);
    expect(origin.signal).toMatchObject({ aborted: true });
  });

  test("fails pending HTTP and Session authentication closed without reprovisioning", async () => {
    const harness = open();
    const alice = await authenticate(harness, "alice-a");
    await link(harness, alice, "alice-b");
    await link(harness, alice, "alice-c");

    const httpBlock = harness.verifier.block("alice-a");
    let resolverSawCanceledAccount = false;
    const pendingLease = acquireAuthLease({
      credential: { kind: "bearer", token: "alice-a" },
      verifier: harness.runtime.credentialVerifier,
      resolveIdentity: (account, signal) => {
        resolverSawCanceledAccount = signal?.aborted === true;
        return harness.runtime.resolveIdentity(account, signal);
      },
      revocationDeadlineMs: 5_000,
      clock: CLOCK,
    });
    await httpBlock.entered;
    expect(await invoke(harness, alice, "accounts.unlink", ALICE_A))
      .toMatchObject({ status: 200 });
    await expect(pendingLease).rejects.toMatchObject({ code: "unauthenticated" });
    httpBlock.release();
    await settle();
    expect(resolverSawCanceledAccount).toBe(true);
    expect(harness.engine.identityForAccount(harness.engine.reader, ISSUER_A, "alice")).toBeNull();

    const sessionBlock = harness.verifier.block("alice-c");
    const sink = new RecordingSink();
    const session = new Session({
      runtime: harness.runtime,
      sink,
      source: TEST_SOURCE,
      clock: CLOCK,
    });
    const pendingHello = hello(session, "alice-c", "pending-account-session");
    await sessionBlock.entered;
    expect(await invoke(harness, alice, "accounts.unlink", ALICE_C))
      .toMatchObject({ status: 200 });
    expect(session.snapshot().phase).toBe("closed");
    sessionBlock.release();
    await pendingHello;
    await settle();
    expect(sink.controls.some((message) => message.t === "welcome")).toBe(false);
    expect(sink.closes[0]).toMatchObject({ code: "unauthenticated", message: "credential revoked" });
    expect(harness.engine.identityForAccount(harness.engine.reader, ISSUER_C, "alice")).toBeNull();
    expect(directoryCounts(harness.engine)).toEqual({ identities: 1n, accounts: 1n, owned: 0n });
  });
});
