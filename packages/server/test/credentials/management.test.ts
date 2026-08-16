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
import { ANONYMOUS_PRINCIPAL, type Principal } from "../../src/auth/credentials.ts";
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
  inspect: { visibleTables },
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
  return Object.freeze({
    clientSessionId: "manage",
    principal: ANONYMOUS_PRINCIPAL as Principal,
    fairnessKey: callerFairnessKey(ANONYMOUS_PRINCIPAL, { family: "test", address: "manage" }),
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async (_publication: RuntimePublication) => true,
  }) as SessionRuntimeContext;
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
