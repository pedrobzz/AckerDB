/**
 * `ctx.credentials.manage`: global credential administration, owned by the
 * application.
 *
 * The framework imposes no authorization here at all, so every test drives it
 * through an ordinary registered function and lets that function's own access
 * policy be the whole admission decision — public, authenticated, system, and
 * custom policy alike. What the framework still owns is the invariants: an
 * Identity per credential, digest-only storage, one-time disclosure, the
 * descendant cascade, and invalidations that publish only after commit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, Err, Status, type Identity } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { CREDENTIALS_TABLE } from "../../src/credentials/tables.ts";
import { IDENTITIES_TABLE } from "../../src/auth/tables.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import type {
  RuntimePublication,
  SessionRuntimeContext,
} from "../../src/subscriptions/session/contract.ts";
import { request } from "../support/credential-fixture.ts";

const schema = defineSchema({
  audit: defineTable({ id: v.primaryKey(), line: v.string() }),
});
const VOCABULARY = ["orders.all", "orders.get", "reports.all"] as const;

const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

const credentialShape = v.object({
  id: v.string(),
  identity: v.identity(),
  parentIdentity: v.identity().nullable(),
  name: v.string(),
  scopes: v.array(v.string()),
});

/**
 * The bootstrap door an application would write for a fresh deployment:
 * `access: "public"` and nothing else, which is exactly the point — the
 * framework adds no second check behind it.
 */
const bootstrapRoot = typedMutation({
  access: "public",
  args: { name: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => ctx.credentials.manage.issueRoot(args),
});

const issueForIdentity = typedMutation({
  access: "system",
  args: { identity: v.identity(), name: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => ctx.credentials.manage.issueFor(args.identity, {
    name: args.name,
    scopes: args.scopes,
  }),
});

const everyCredential = typedQuery({
  access: "public",
  args: {},
  returns: v.array(credentialShape),
  handler: async (ctx) => (await ctx.credentials.manage.query().collect()).map((credential) => ({
    id: credential.id,
    identity: credential.identity,
    parentIdentity: credential.parentIdentity,
    name: credential.name,
    scopes: [...credential.scopes],
  })),
});

const rootCredentials = typedQuery({
  access: "public",
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const roots = await ctx.credentials.manage.query()
      .where((row) => row.parentIdentity.isNull())
      .orderBy((row) => row.name.asc())
      .collect();
    return roots.map((credential) => credential.name);
  },
});

const countCredentials = typedQuery({
  access: "public",
  args: {},
  returns: v.int(),
  handler: (ctx) => ctx.credentials.manage.query().count(),
});

const renameAny = typedMutation({
  access: "public",
  args: { id: v.string(), name: v.string() },
  handler: (ctx, args) => ctx.credentials.manage.update(args.id, { name: args.name }),
});

const rescopeAny = typedMutation({
  access: "public",
  args: { id: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => ctx.credentials.manage.updateScopes(args.id, args.scopes),
});

const revokeAny = typedMutation({
  access: "public",
  args: { id: v.string() },
  handler: (ctx, args) => ctx.credentials.manage.revoke(args.id),
});

const revokeManyThenFail = typedProcedure({
  description: "Revoke a set, then discard the whole transaction.",
  access: "public",
  http: true,
  args: { ids: v.array(v.string()) },
  returns: v.object({ rolledBack: v.boolean() }),
  handler: async (ctx, args) => {
    const attempt = await ctx.tx(async (tx) => {
      await tx.credentials.manage.revokeMany(args.ids);
      return Err("rolled-back", {}, Status.Conflict);
    });
    return { rolledBack: !attempt.ok };
  },
});

const revokeMany = typedMutation({
  access: "public",
  args: { ids: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => [...await ctx.credentials.manage.revokeMany(args.ids)],
});

/**
 * The same global capability behind two other admission decisions. Neither
 * changes what `manage` may do — that is the point of testing all three.
 */
const authenticatedIssue = typedMutation({
  access: "authenticated",
  args: { name: v.string() },
  handler: (ctx, args) => ctx.credentials.manage.issueRoot({ name: args.name, scopes: [] }),
});

const customPolicyIssue = typedMutation({
  access: (_ctx, args: { readonly name: string }) => args.name.startsWith("allowed-"),
  args: { name: v.string() },
  handler: (ctx, args) => ctx.credentials.manage.issueRoot({ name: args.name, scopes: [] }),
});

/** The public token id a caller was handed must be the one it can filter on. */
const byPublicId = typedQuery({
  access: "public",
  args: { id: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const found = await ctx.credentials.manage.query()
      .where((row) => row.id.eq(args.id))
      .orderBy((row) => row.createdAt.asc())
      .thenBy((row) => row.name.desc())
      .collect();
    return found.map((credential) => credential.name);
  },
});

/** Aggregates address the same safe row a predicate does. */
const newestCreatedAt = typedQuery({
  access: "public",
  args: {},
  returns: v.float().nullable(),
  handler: async (ctx) => await ctx.credentials.manage.query().max((row) => row.createdAt) ?? null,
});

const issueChild = typedMutation({
  access: "authenticated",
  args: { name: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => ctx.credentials.issue(args),
});

/** What each database capability can see: the boundary of user story 41. */
const visibleTables = typedQuery({
  access: "public",
  args: {},
  returns: v.object({ application: v.array(v.string()), internal: v.array(v.string()) }),
  handler: (ctx) => ({
    application: Object.keys(ctx.db as Record<string, unknown>).sort(),
    internal: Object.keys(
      (ctx as unknown as { readonly internal: { readonly db: Record<string, unknown> } })
        .internal.db,
    ).sort(),
  }),
});

const modules = {
  admin: {
    bootstrapRoot,
    countCredentials,
    everyCredential,
    issueForIdentity,
    renameAny,
    rescopeAny,
    revokeAny,
    revokeMany,
    revokeManyThenFail,
    rootCredentials,
  },
  gated: { authenticatedIssue, customPolicyIssue },
  inspect: { byPublicId, newestCreatedAt, visibleTables },
  own: { issueChild },
};

const cleanups: Array<() => Promise<void>> = [];
const directories: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

interface Harness {
  readonly runtime: Runtime;
  readonly engine: Engine;
  readonly session: SessionRuntimeContext;
  readonly invalidated: string[];
}

async function start(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-credential-manage-"));
  directories.push(directory);
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    scopes: VOCABULARY,
    resolveScopes: () => VOCABULARY,
  });
  await runtime.start();
  const invalidated: string[] = [];
  runtime.credentialVerifier!.subscribeInvalidation((invalidation) => {
    if (invalidation.subject !== undefined) invalidated.push(invalidation.subject);
  });
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
  });
  return { runtime, engine, session: anonymousSession(), invalidated };
}

function anonymousSession(): SessionRuntimeContext {
  return sessionFor(ANONYMOUS_PRINCIPAL as Principal, "manage");
}

function sessionFor(
  principal: Principal,
  name: string,
  publications?: RuntimePublication[],
): SessionRuntimeContext {
  return Object.freeze({
    clientSessionId: name,
    principal,
    fairnessKey: callerFairnessKey(principal, { family: "test", address: name }),
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async (publication: RuntimePublication) => {
      publications?.push(publication);
      return true;
    },
  }) as SessionRuntimeContext;
}

async function userSession(
  runtime: Runtime,
  subject: string,
  name: string,
): Promise<{ readonly principal: UserPrincipal; readonly session: SessionRuntimeContext }> {
  const identity = await runtime.resolveIdentity({ issuer: "https://issuer.test/", subject });
  const principal: UserPrincipal = Object.freeze({
    kind: "user",
    scopes: Object.freeze([...VOCABULARY]),
    identity,
    issuer: "https://issuer.test/",
    subject,
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: `external-${subject}`,
  });
  const session = sessionFor(principal, name);
  await runtime.openSession(session);
  return { principal, session };
}

let messageId = 0;
function call(args: unknown, ref: string) {
  messageId += 1;
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return request({
    t: "m" as const,
    id: messageId,
    ref,
    args,
    mutationRequestId:
      `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${String(messageId).padStart(12, "0")}`,
    issuedAt: Date.now(),
  });
}

function read(ref: string) {
  messageId += 1;
  return request({ t: "q" as const, id: messageId, ref, args: {} });
}

describe("global credential administration", () => {
  test("issues a root credential through a public function, once and only once", async () => {
    const { runtime, engine, session } = await start();
    await runtime.openSession(session);

    const created = (await runtime.mutation(session, call(
      { name: "Operator", scopes: ["*"] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string; readonly token: string; readonly identity: Identity };

    // A credential IS an Identity, and a root has no parent to bound it.
    expect(created.identity).toBeGreaterThan(0n);
    const listed = (await runtime.query(session, read("api.admin.everyCredential"))) as
      readonly { readonly id: string; readonly parentIdentity: Identity | null }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, parentIdentity: null });

    // The plaintext exists in the issuance answer and nowhere else.
    const stored = engine.reader
      .query(`SELECT secretDigest FROM "${CREDENTIALS_TABLE}"`)
      .all() as { secretDigest: Uint8Array }[];
    expect(stored).toHaveLength(1);
    const rendered = listed.map((credential) => JSON.stringify({ ...credential, identity: "" }));
    expect(rendered.join("")).not.toContain(created.token);
    expect(await runtime.authenticateCredential(created.token, "root"))
      .toMatchObject({ identity: created.identity, scopes: [...VOCABULARY] });
  });

  test("issues for a chosen Identity, parenting the new credential's own Identity", async () => {
    const { runtime, engine, session } = await start();
    await runtime.openSession(session);
    const parent = (engine.writer
      .query(`INSERT INTO "${IDENTITIES_TABLE}" DEFAULT VALUES RETURNING id`)
      .get() as { id: bigint }).id as Identity;

    const created = await runtime.system.run("issue", (ctx) =>
      ctx.tx((tx) => tx.credentials.manage.issueFor(parent, {
        name: "Delegate",
        scopes: ["orders.get"],
      })));
    expect(created.ok).toBe(true);
    const issued = (created as { data: { identity: Identity; parentIdentity: Identity | null } }).data;
    expect(issued.parentIdentity).toBe(parent);
    expect(issued.identity).not.toBe(parent);
  });

  test("filters, orders, and counts through the ordinary query interface", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    for (const name of ["Zeta", "Alpha"]) {
      await runtime.mutation(session, call({ name, scopes: [] }, "api.admin.bootstrapRoot"));
    }
    expect(await runtime.query(session, read("api.admin.rootCredentials")))
      .toEqual(["Alpha", "Zeta"]);
    expect(await runtime.query(session, read("api.admin.countCredentials"))).toBe(2);
  });

  test("descriptive updates change nothing about authority", async () => {
    const { runtime, session, invalidated } = await start();
    await runtime.openSession(session);
    const created = (await runtime.mutation(session, call(
      { name: "Before", scopes: ["orders.get"] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string; readonly token: string };

    await runtime.mutation(session, call(
      { id: created.id, name: "After" },
      "api.admin.renameAny",
    ));
    expect(invalidated).toEqual([]);
    expect(await runtime.authenticateCredential(created.token, "renamed"))
      .toMatchObject({ scopes: ["orders.get"] });
  });

  test("a scope change invalidates the credential it reaches, after the commit", async () => {
    const { runtime, session, invalidated } = await start();
    await runtime.openSession(session);
    const created = (await runtime.mutation(session, call(
      { name: "Narrowing", scopes: ["orders.all", "orders.get"] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string; readonly token: string };
    expect(invalidated).toEqual([]);

    await runtime.mutation(session, call(
      { id: created.id, scopes: ["orders.get"] },
      "api.admin.rescopeAny",
    ));
    expect(invalidated).toEqual([created.id]);
    expect(await runtime.authenticateCredential(created.token, "narrowed"))
      .toMatchObject({ scopes: ["orders.get"] });
  });

  test("revokeMany is atomic, ignores missing ids, and reports what it revoked", async () => {
    const { runtime, session, invalidated } = await start();
    await runtime.openSession(session);
    const first = (await runtime.mutation(session, call(
      { name: "First", scopes: [] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string; readonly token: string };
    const second = (await runtime.mutation(session, call(
      { name: "Second", scopes: [] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string; readonly token: string };
    const missing = "z".repeat(22);

    // Rolled back: the rows survive and nothing is published.
    const response = await runtime.runProcedure({
      id: 900,
      address: "api.admin.revokeManyThenFail",
      args: { ids: [first.id, second.id] },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: { body: string; status: number }) =>
        new Response(body, { status }),
    });
    const rolledBack = decode(await response.text()) as { readonly rolledBack: boolean };
    expect(rolledBack.rolledBack).toBe(true);
    expect(invalidated).toEqual([]);
    expect(await runtime.query(session, read("api.admin.countCredentials"))).toBe(2);

    const revoked = (await runtime.mutation(session, call(
      { ids: [first.id, missing, first.id, second.id] },
      "api.admin.revokeMany",
    ))).value as readonly string[];
    expect([...revoked].sort()).toEqual([first.id, second.id].sort());
    expect([...invalidated].sort()).toEqual([first.id, second.id].sort());
    expect(await runtime.query(session, read("api.admin.countCredentials"))).toBe(0);

    // Repeating it is safe: every id is now missing.
    expect((await runtime.mutation(session, call(
      { ids: [first.id, second.id] },
      "api.admin.revokeMany",
    ))).value).toEqual([]);
  });

  test("a caller filters, orders, and aggregates on the credential it was handed", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    const issued = (await runtime.mutation(session, call(
      { name: "Findable", scopes: [] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string };
    await runtime.mutation(session, call({ name: "Other", scopes: [] }, "api.admin.bootstrapRoot"));

    // `id` is the public token id, not the stored primary key: a caller who
    // filters on the id it was given must reach the row it was given.
    messageId += 1;
    expect(await runtime.query(session, request({
      t: "q" as const,
      id: messageId,
      ref: "api.inspect.byPublicId",
      args: { id: issued.id },
    }))).toEqual(["Findable"]);
    expect(await runtime.query(session, read("api.inspect.newestCreatedAt")))
      .toBeGreaterThan(0);
  });

  test("owner scope refuses a system principal as firmly as an anonymous one", async () => {
    const { runtime } = await start();
    // Neither has a user Identity to own anything, and neither may be guessed
    // into one: system authority is the framework's own rather than a
    // credential holder's, so it fails as unauthenticated instead of reading
    // somebody else's empty list.
    await expect(runtime.system.run("owner-read", (ctx) =>
      ctx.tx((tx) => tx.credentials.query().collect())))
      .rejects.toMatchObject({
        code: "unauthenticated",
        message: "owner-scoped credential operations require a user identity",
      });
    await expect(runtime.system.run("owner-write", (ctx) =>
      ctx.tx((tx) => tx.credentials.issue({ name: "system-owned" }))))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("manage answers to whatever policy the containing function declares", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    const { session: alice } = await userSession(runtime, "policy-alice", "policy-alice");

    // Authenticated: admitted for a user, refused for anonymous.
    expect((await runtime.mutation(alice, call(
      { name: "Behind authentication" },
      "api.gated.authenticatedIssue",
    ))).value).toMatchObject({ name: "Behind authentication" });
    await expect(runtime.mutation(session, call(
      { name: "Anonymous" },
      "api.gated.authenticatedIssue",
    ))).rejects.toMatchObject({ code: "unauthenticated" });

    // Custom policy: the callback is the whole decision, on both answers.
    expect((await runtime.mutation(session, call(
      { name: "allowed-one" },
      "api.gated.customPolicyIssue",
    ))).value).toMatchObject({ name: "allowed-one" });
    await expect(runtime.mutation(session, call(
      { name: "refused-one" },
      "api.gated.customPolicyIssue",
    ))).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("a child never exceeds its parent, however it was issued", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    const { session: aliceSession } = await userSession(runtime, "bound-alice", "bound-alice");
    // Alice holds the whole vocabulary; `narrow` deliberately does not, so it
    // is the parent whose bound is worth testing.
    const narrow = (await runtime.mutation(aliceSession, call(
      { name: "Narrow", scopes: ["orders.get"] },
      "api.own.issueChild",
    ))).value as { readonly id: string; readonly identity: Identity };

    // `issueFor` is global administration and carries no access check, and it
    // still cannot mint a child that outruns the parent it names.
    await expect(runtime.system.run("escalate", (ctx) =>
      ctx.tx((tx) => tx.credentials.manage.issueFor(narrow.identity, {
        name: "Escalated",
        scopes: ["reports.all"],
      })))).rejects.toMatchObject({ code: "unauthorized" });
    const bounded = await runtime.system.run("delegate", (ctx) =>
      ctx.tx((tx) => tx.credentials.manage.issueFor(narrow.identity, {
        name: "Bounded",
        scopes: ["orders.get"],
      })));
    expect(bounded.ok).toBe(true);
    const grandchild = (bounded as { data: { id: string } }).data;

    // `manage.updateScopes` is bounded by the addressed credential's parent,
    // which for the grandchild is `narrow` rather than Alice.
    await expect(runtime.mutation(session, call(
      { id: grandchild.id, scopes: ["reports.all"] },
      "api.admin.rescopeAny",
    ))).rejects.toMatchObject({ code: "unauthorized" });
    // Alice holds everything, so widening her own child stays inside her grant.
    await runtime.mutation(session, call(
      { id: narrow.id, scopes: ["orders.all"] },
      "api.admin.rescopeAny",
    ));

    // A root has no parent to be bounded by; only the vocabulary holds it.
    const root = (await runtime.mutation(session, call(
      { name: "Root", scopes: ["reports.all"] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly id: string };
    await runtime.mutation(session, call(
      { id: root.id, scopes: ["orders.all", "reports.all"] },
      "api.admin.rescopeAny",
    ));
    await expect(runtime.mutation(session, call(
      { id: root.id, scopes: ["never.declared"] },
      "api.admin.rescopeAny",
    ))).rejects.toMatchObject({ code: "validation" });
  });

  test("revokeMany reports an overlapping parent and child exactly once", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    const { session: aliceSession } = await userSession(runtime, "bulk-alice", "bulk-alice");
    const parent = (await runtime.mutation(aliceSession, call(
      { name: "Parent", scopes: [] },
      "api.own.issueChild",
    ))).value as { readonly id: string; readonly identity: Identity };
    const child = await runtime.system.run("child", (ctx) =>
      ctx.tx((tx) => tx.credentials.manage.issueFor(parent.identity, {
        name: "Child",
        scopes: [],
      })));
    const childId = (child as { data: { id: string } }).data.id;

    // The child is reachable twice: named directly, and through the cascade.
    const revoked = (await runtime.mutation(session, call(
      { ids: [parent.id, childId] },
      "api.admin.revokeMany",
    ))).value as readonly string[];
    expect([...revoked].sort()).toEqual([parent.id, childId].sort());
    expect(revoked).toHaveLength(2);
    expect(await runtime.query(session, read("api.admin.countCredentials"))).toBe(0);
  });

  test("a subscribed global query reruns on a credential write and on nothing else", async () => {
    const { runtime, engine } = await start();
    const published: RuntimePublication[] = [];
    const watcher = sessionFor(ANONYMOUS_PRINCIPAL as Principal, "watcher", published);
    await runtime.openSession(watcher);
    messageId += 1;
    await runtime.subscribe(watcher, request({
      t: "sub" as const,
      id: messageId,
      ref: "api.admin.countCredentials",
      args: {},
    }));
    const initial = published.length;

    await runtime.mutation(watcher, call(
      { name: "Watched", scopes: [] },
      "api.admin.bootstrapRoot",
    ));
    expect(published.length).toBeGreaterThan(initial);
    const afterCredential = published.length;

    // An unrelated table's write reaches no credential subscription.
    await runtime.system.run("unrelated", (ctx) =>
      ctx.tx((tx) => (tx.db as unknown as {
        audit: { insert(row: { line: string }): PromiseLike<bigint> };
      }).audit.insert({ line: "noise" })));
    void engine;
    expect(published.length).toBe(afterCredential);
  });

  test("runtime authentication reads a snapshot and records no reactive dependency", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    const issued = (await runtime.mutation(session, call(
      { name: "Bearer", scopes: [] },
      "api.admin.bootstrapRoot",
    ))).value as { readonly token: string };

    // Authentication precedes an invocation: there is no subscription waiting
    // on its read, so it opens a snapshot with no recorder. Anything else would
    // build reactive machinery for a read nobody re-runs.
    const before = runtime.status().reactive;
    for (let attempt = 0; attempt < 3; attempt++) {
      await runtime.authenticateCredential(issued.token, `snapshot-${attempt}`);
    }
    const after = runtime.status().reactive;
    expect(after.dependencyKeys).toBe(before.dependencyKeys);
    expect(after.dependencyEdges).toBe(before.dependencyEdges);
    expect(after.sharedEntries).toBe(before.sharedEntries);
  });

  test("framework tables are absent from ctx.db and present on ctx.internal.db", async () => {
    const { runtime, session } = await start();
    await runtime.openSession(session);
    const visible = await runtime.query(session, read("api.inspect.visibleTables")) as {
      readonly application: readonly string[];
      readonly internal: readonly string[];
    };
    expect(visible.application).toEqual(["_ackerdb_job_runs", "_ackerdb_jobs", "audit"]);
    expect(visible.internal).toContain(CREDENTIALS_TABLE);
    expect(visible.internal).toContain(IDENTITIES_TABLE);
    expect(visible.application).not.toContain(CREDENTIALS_TABLE);
    expect(visible.application).not.toContain(IDENTITIES_TABLE);
  });
});
