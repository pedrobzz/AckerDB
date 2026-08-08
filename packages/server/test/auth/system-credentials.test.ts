import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  encode,
  type MutationMessage,
  type SubscribeMessage,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type ProcedureBuilder,
  type ProcedureCtx,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import {
  mcp as mcpDeclaration,
  type McpBuilder,
} from "../../src/mcp/index.ts";
import {
  credentials,
  systemCredentials,
} from "../../src/auth/credential-context.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { declareJobs, job } from "../../src/jobs/definition.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/subscriptions/session/contract.ts";

const action = v.enum("SystemCredentialAction", [
  "create_agent",
  "create_scoped",
  "create_root_scoped",
  "list_agent",
  "revoke_agent",
  "revoke_missing",
]);

const schema = defineSchema({
  audit: defineTable({ id: v.primaryKey(), line: v.string() }),
});

const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;
const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const VOCABULARY = ["orders.all", "orders.get", "reports.all"] as const;

let systemResult: unknown = null;

async function attemptSystemAdministration(
  ctx: ProcedureCtx<typeof schema>,
): Promise<{ readonly status: string }> {
  const done = await ctx.tx((tx) => {
    if (ctx.auth.kind !== "user" || ctx.auth.tokenId === null) {
      throw new Error("expected a credential-backed principal");
    }
    systemCredentials.list(tx, ctx.auth.identity);
    return { status: "unexpected" };
  });
  if (!done.ok) throw new Error("system administration unexpectedly failed");
  return done.data;
}

const attemptFromMcp = typedProcedure({
  description: "Exercise the system token-administration boundary.",
  access: "authenticated",
  args: {},
  returns: v.object({ status: v.string() }),
  handler: attemptSystemAdministration,
});

const agentMcp = typedMcp({
  name: "agent",
  tools: { attempt_system_administration: { fn: attemptFromMcp } },
});

/** Backend-only fixture: an external user can queue work only for its own Identity. */
const queue = typedMutation({
  access: "authenticated",
  args: {
    action,
    name: v.string().nullable(),
    metadata: v.jsonb<Readonly<Record<string, unknown>>>(),
    scopes: v.array(v.string()),
    tokenId: v.string().nullable(),
    at: v.int(),
  },
  handler: (ctx, args) => {
    if (ctx.auth.kind !== "user") throw new Error("expected external user");
    return (ctx.jobs as Record<string, Record<string, {
      enqueue(input: unknown, options: { at: number }): Promise<unknown>;
    }>>)["systemTokens"]!["run"]!.enqueue({
      action: args.action,
      name: args.name,
      metadata: args.metadata,
      scopes: args.scopes,
      tokenId: args.tokenId,
      identity: ctx.auth.identity,
    }, { at: args.at });
  },
});

let systemRunCount = 0;
const declaredJobs = () => declareJobs({
  systemTokens: {
    run: job({
      kind: "mutation",
      args: {
        action,
        identity: v.identity(),
        name: v.string().nullable(),
        metadata: v.jsonb<Readonly<Record<string, unknown>>>(),
        scopes: v.array(v.string()),
        tokenId: v.string().nullable(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (ctx: any, args: any) => {
        systemRunCount++;
        switch (args.action) {
          case "create_agent":
            systemResult = systemCredentials.create(ctx, args.identity, {
              name: args.name ?? "",
              metadata: args.metadata,
            });
            return;
          case "create_scoped":
            systemResult = systemCredentials.create(ctx, args.identity, {
              name: args.name ?? "",
              metadata: args.metadata,
              scopes: args.scopes as readonly string[],
            });
            return;
          case "create_root_scoped":
            systemResult = systemCredentials.create(ctx, null, {
              name: args.name ?? "",
              metadata: args.metadata,
              scopes: args.scopes as readonly string[],
            });
            return;
          case "list_agent":
            systemResult = systemCredentials.list(ctx, args.identity);
            return;
          case "revoke_agent":
            systemCredentials.revoke(ctx, args.identity, args.tokenId ?? "");
            systemResult = null;
            return;
          case "revoke_missing":
            systemCredentials.revoke(ctx, args.identity, "Q".repeat(22));
            systemResult = null;
        }
      },
    }),
  },
});

const attempt = typedMutation({
  access: "public",
  args: { identity: v.identity() },
  handler: (ctx, args) => systemCredentials.list(ctx, args.identity),
});

const listOwned = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => credentials.list(ctx),
});

const modules = {
  mcp: { agentMcp },
  ownerTokens: { listOwned },
  systemTokens: { attempt, attemptFromMcp, queue },
};
const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

let jobsClock: number | null = null;

/** Drive the runner at `at` and report how many system runs it performed. */
async function runJobsAt(runtime: Runtime, at: number): Promise<number> {
  const before = systemRunCount;
  jobsClock = at;
  try {
    await runtime.runJobs();
  } finally {
    jobsClock = null;
  }
  return systemRunCount - before;
}

/** The newest Job and the run its outcome is recorded on. */
function lastJobRow(engine: Engine): { state: string; errorText: string | null } {
  const job = engine.reader
    .query('SELECT id, state, runCount FROM "_ackerdb_jobs" ORDER BY id DESC LIMIT 1')
    .get() as { id: bigint; state: string; runCount: bigint };
  const run = engine.reader
    .query('SELECT errorText FROM "_ackerdb_job_runs" WHERE jobId = ? AND number = ?')
    .get(job.id, job.runCount) as { errorText: string | null } | null;
  return { state: job.state, errorText: run?.errorText ?? null };
}

afterEach(async () => {
  systemResult = null;
  systemRunCount = 0;
  jobsClock = null;
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(): { engine: Engine; runtime: Runtime } {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-system-credentials-"));
  directories.push(directory);
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    admin: { telemetry: { enabled: false } },
    scopes: VOCABULARY,
    jobs: declaredJobs(),
    now: () => jobsClock ?? Date.now(),
    limits: {
      ...PRODUCTION_LIMITS,
      credentials: { ...PRODUCTION_LIMITS.credentials, maxPerIdentity: 2 },
    },
  });
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
  });
  return { engine, runtime };
}

async function user(runtime: Runtime, subject: string): Promise<UserPrincipal> {
  const identity = await runtime.resolveIdentity({ issuer: "https://issuer.test/", subject });
  return Object.freeze({
    kind: "user",
    scopes: Object.freeze([]),
    identity,
    issuer: "https://issuer.test/",
    subject,
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: `external-${subject}`,
  });
}

function session(
  principal: Principal,
  name: string,
  publications?: SessionApplicationMessage[],
): SessionRuntimeContext {
  return Object.freeze({
    clientSessionId: name,
    principal,
    fairnessKey: callerFairnessKey(principal, { family: "test", address: name }),
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async (publication: RuntimePublication) => {
      publications?.push(publication.message);
      return true;
    },
  });
}

function request<Message>(message: Message): RuntimeRequest<Message> {
  return Object.freeze({ message, bytes: Buffer.byteLength(encode(message)) });
}

function mutationMessage(id: number, args: unknown, ref: string): MutationMessage {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return {
    v: PROTOCOL_VERSION,
    t: "m",
    id,
    ref,
    args,
    mutationRequestId: `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${String(id).padStart(12, "0")}`,
    issuedAt: Date.now(),
  };
}

function subscribeMessage(id: number): SubscribeMessage {
  return { v: PROTOCOL_VERSION, t: "sub", id, ref: "api.ownerTokens.listOwned", args: {} };
}

type Action = NonNullable<typeof action._type>;

async function queueJob(
  runtime: Runtime,
  context: SessionRuntimeContext,
  id: number,
  selectedAction: Action,
  input: {
    readonly name?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly scopes?: readonly string[];
    readonly tokenId?: string;
  } = {},
): Promise<number> {
  const at = Date.now() + 100_000 + id;
  await runtime.mutation(context, request(mutationMessage(id, {
    action: selectedAction,
    name: input.name ?? null,
    metadata: input.metadata ?? {},
    scopes: input.scopes ?? [],
    tokenId: input.tokenId ?? null,
    at,
  }, "api.systemTokens.queue")));
  return at;
}

async function createSystemAgentToken(
  runtime: Runtime,
  owner: SessionRuntimeContext,
  id: number,
): Promise<{ readonly id: string; readonly identity: bigint; readonly token: string }> {
  const at = await queueJob(runtime, owner, id, "create_agent", { name: "Backend Codex" });
  expect(await runJobsAt(runtime, at)).toBe(1);
  return systemResult as { readonly id: string; readonly identity: bigint; readonly token: string };
}

describe("system-managed identity credentials", () => {
  test("creates, lists, authenticates, and revokes once through scheduled system authority", async () => {
    const { engine, runtime } = fixture();
    const bob = await user(runtime, "backend-managed-bob");
    const publications: SessionApplicationMessage[] = [];
    const bobSession = session(bob, "backend-managed-bob-session", publications);
    await runtime.openSession(bobSession);

    const createAt = await queueJob(runtime, bobSession, 101, "create_agent", {
      name: "Backend Codex",
      metadata: { integration: "codex", generation: 1n },
    });
    expect(await runJobsAt(runtime, createAt)).toBe(1);
    const created = systemResult as {
      readonly id: string;
      readonly identity: bigint;
      readonly token: string;
      readonly name: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };
    expect(created).toMatchObject({
      name: "Backend Codex",
      metadata: { integration: "codex", generation: 1n },
    });
    expect(created).not.toHaveProperty("expiresAt");
    expect(created.token).toMatch(/^ackerdb_credential\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(await runJobsAt(runtime, createAt)).toBe(0);
    await runtime.subscribe(bobSession, request(subscribeMessage(90)));
    expect(publications.at(-1)).toMatchObject({
      transition: { kind: "reset", value: [{ id: created.id }] },
    });

    const secret = created.token.split(".")[2]!;
    const stored = engine.reader.query(
      "SELECT identity, parent_identity, secret_digest FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(created.id) as { identity: bigint; parent_identity: bigint; secret_digest: Uint8Array };
    expect(stored.identity).toBe(created.identity);
    expect(stored.parent_identity).toBe(bob.identity);
    expect(Buffer.from(stored.secret_digest).toString("hex")).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );

    expect(await runtime.authenticateCredential(created.token, "system-created"))
      .toMatchObject({ identity: created.identity, tokenId: created.id, scopes: [] });
    const listAt = await queueJob(runtime, bobSession, 102, "list_agent");
    expect(await runJobsAt(runtime, listAt)).toBe(1);
    const listed = systemResult as readonly Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, name: "Backend Codex" });
    expect(listed[0]).not.toHaveProperty("token");
    expect(encode(listed)).not.toContain(secret);

    const revokeAt = await queueJob(runtime, bobSession, 103, "revoke_agent", {
      tokenId: created.id,
    });
    expect(await runJobsAt(runtime, revokeAt)).toBe(1);
    expect(publications.at(-1)).toMatchObject({ transition: { kind: "update", value: [] } });
    await expect(runtime.authenticateCredential(created.token, "system-revoked"))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("rejects user, workload, anonymous, and MCP principals before target validation", async () => {
    const { engine, runtime } = fixture();
    const bob = await user(runtime, "target-bob");
    const bobSession = session(bob, "target-bob-session");
    await runtime.openSession(bobSession);
    const created = await createSystemAgentToken(runtime, bobSession, 111);
    const delegated = await runtime.authenticateCredential(created.token, "delegated");

    const alice = await user(runtime, "attacker-alice");
    const aliceSession = session(alice, "attacker-alice-session");
    const anonymousSession = session(ANONYMOUS_PRINCIPAL, "attacker-anonymous-session");
    const workloadSession = session(Object.freeze({
      kind: "workload" as const,
      issuer: "https://issuer.test/",
      subject: "attacker-workload",
      claims: Object.freeze({}),
      expiresAt: Date.now() + 60_000,
      tokenId: "attacker-workload-token",
    }), "attacker-workload-session");
    await runtime.openSession(aliceSession);
    await runtime.openSession(anonymousSession);
    await runtime.openSession(workloadSession);

    for (const [id, context, identity] of [
      [112, aliceSession, bob.identity],
      [113, anonymousSession, bob.identity],
      [114, workloadSession, bob.identity],
      [115, aliceSession, 0n],
    ] as const) {
      await expect(runtime.mutation(context, request(mutationMessage(
        id,
        { identity },
        "api.systemTokens.attempt",
      )))).rejects.toMatchObject({ code: "unauthorized" });
    }
    await expect(runtime.runMcpTool({
      id: "attacker-mcp",
      authorization: runtime.authorizeMcpTool(
        "agent",
        "attempt_system_administration",
        delegated,
      ),
      args: {},
      principal: delegated,
    })).rejects.toMatchObject({ code: "unauthorized" });
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 1n });
  });

  test("keeps system revocation bound to the exact credential and Identity", async () => {
    const endpoint = fixture();
    const endpointOwner = await user(endpoint.runtime, "endpoint-owner");
    const endpointSession = session(endpointOwner, "endpoint-owner-session");
    await endpoint.runtime.openSession(endpointSession);
    const endpointToken = await createSystemAgentToken(endpoint.runtime, endpointSession, 121);
    const wrongTokenAt = await queueJob(
      endpoint.runtime,
      endpointSession,
      122,
      "revoke_missing",
      {},
    );
    // The failed attempt settles as discarded; the runner never wedges.
    expect(await runJobsAt(endpoint.runtime, wrongTokenAt)).toBe(1);
    expect(lastJobRow(endpoint.engine)).toMatchObject({ state: "failed" });
    expect(lastJobRow(endpoint.engine).errorText).toContain("not_found");
    expect(await endpoint.runtime.authenticateCredential(
      endpointToken.token,
      "wrong-token",
    )).toMatchObject({ identity: endpointToken.identity, tokenId: endpointToken.id });

    const identity = fixture();
    const bob = await user(identity.runtime, "identity-owner-bob");
    const bobSession = session(bob, "identity-owner-bob-session");
    await identity.runtime.openSession(bobSession);
    const identityToken = await createSystemAgentToken(identity.runtime, bobSession, 126);
    const alice = await user(identity.runtime, "identity-other-alice");
    const aliceSession = session(alice, "identity-other-alice-session");
    await identity.runtime.openSession(aliceSession);
    const wrongIdentityAt = await queueJob(identity.runtime, aliceSession, 127, "revoke_agent", {
      tokenId: identityToken.id,
    });
    expect(await runJobsAt(identity.runtime, wrongIdentityAt)).toBe(1);
    expect(lastJobRow(identity.engine)).toMatchObject({ state: "failed" });
    expect(lastJobRow(identity.engine).errorText).toContain("not_found");
    expect(await identity.runtime.authenticateCredential(
      identityToken.token,
      "wrong-identity",
    )).toMatchObject({ identity: identityToken.identity, tokenId: identityToken.id });
  });

  test("validates exact declared scopes before system create mutates storage", async () => {
    const { engine, runtime } = fixture();
    const bob = await user(runtime, "scopes-owner");
    const bobSession = session(bob, "scopes-owner-session");
    await runtime.openSession(bobSession);
    const at = await queueJob(runtime, bobSession, 131, "create_scoped", {
      name: "Invalid scope",
      scopes: ["orders.create"],
    });
    expect(await runJobsAt(runtime, at)).toBe(1);
    expect(lastJobRow(engine)).toMatchObject({ state: "failed" });
    expect(lastJobRow(engine).errorText).toContain("validation");
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 0n });
  });

  test("system cannot store an open-ended grant under a parent it does not bound", async () => {
    // The child invariant is enforced at issuance and at use. System authority
    // has no grant of its own, so issuance cannot be checked the way the owner
    // surface checks it — and a stored wildcard under a parent is exactly the
    // grant that would start authorizing more the day the parent grows, with
    // nobody having granted the difference. Use-time intersection would hide
    // it: the child looks correctly narrow until it silently is not.
    const { engine, runtime } = fixture();
    const bob = await user(runtime, "wildcard-owner");
    const bobSession = session(bob, "wildcard-owner-session");
    await runtime.openSession(bobSession);
    const at = await queueJob(runtime, bobSession, 137, "create_scoped", {
      name: "Open-ended agent",
      scopes: ["orders.*"],
    });
    expect(await runJobsAt(runtime, at)).toBe(1);
    expect(lastJobRow(engine)).toMatchObject({ state: "failed" });
    expect(lastJobRow(engine).errorText).toContain("open-ended");
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 0n });
  });

  test("a root credential has no parent to outgrow, so it keeps its patterns", async () => {
    const { engine, runtime } = fixture();
    const bob = await user(runtime, "root-minter");
    const bobSession = session(bob, "root-minter-session");
    await runtime.openSession(bobSession);
    const at = await queueJob(runtime, bobSession, 139, "create_root_scoped", {
      name: "Root agent",
      scopes: ["orders.*"],
    });
    expect(await runJobsAt(runtime, at)).toBe(1);
    expect(lastJobRow(engine)).toMatchObject({ state: "completed" });
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _ackerdb_credentials").get())
      .toEqual({ count: 1n });
  });
});
