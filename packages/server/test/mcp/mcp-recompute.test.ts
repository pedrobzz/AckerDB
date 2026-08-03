import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, encode } from "@ackerdb/core";
import type { UserPrincipal } from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  procedure,
  query,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import {
  mcp as mcpDeclaration,
  mcpAuth,
  type McpAuthBuilder,
  type McpBuilder,
} from "../../src/mcp/index.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../../src/schema/definition.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/subscriptions/session.ts";
import { until } from "ackerdb-test-support/async";

// A live subscription must survive a commit made by a DIFFERENT principal
// through any dispatch path that commits INSIDE its handler (an MCP tool or a
// procedure, both via ctx.tx). Post-commit recomputation on the subscriber's
// behalf then runs while the mutating invocation's async context is still
// ambient; the recompute is top-level work for the subscriber and must not be
// mistaken for a nested invocation of the mutator (whose principal differs).

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
  signals: defineEventTable({
    id: v.primaryKey(),
    label: v.string(),
  }, {
    args: {},
    access: (ctx) => ctx.auth.kind === "user",
    matches: () => true,
  }),
});

const typedQuery = query as QueryBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
const typedMcpAuth = mcpAuth as McpAuthBuilder<typeof schema>;

const statusReturns = v.object({ status: v.string() });

const addRecord = typedProcedure({
  description: "Insert one record transactionally.",
  access: "authenticated",
  args: { value: v.string() },
  returns: statusReturns,
  handler: async (ctx, args) => {
    const done = await ctx.tx(async (tx) => {
      await tx.db.records.insert({ value: args.value });
      return { status: "inserted" };
    });
    if (!done.ok) throw new Error("insert failed");
    return done.data;
  },
});

const emitSignal = typedProcedure({
  description: "Emit one live event transactionally.",
  access: "authenticated",
  args: { label: v.string() },
  returns: statusReturns,
  handler: async (ctx, args) => {
    const done = await ctx.tx(async (tx) => {
      await tx.db.signals.insert({ label: args.label });
      return { status: "emitted" };
    });
    if (!done.ok) throw new Error("emit failed");
    return done.data;
  },
});

const actionsAuth = typedMcpAuth({ name: "actions" });
const actionsMcp = typedMcp({
  name: "actions",
  auth: actionsAuth,
  path: "/actions/mcp",
  tools: {
    add_record: { fn: addRecord },
    emit_signal: { fn: emitSignal },
  },
});

const listRecords = typedQuery({
  access: (ctx) => ctx.auth.kind === "user",
  args: {},
  handler: (ctx) => ctx.db.records.query().collect(),
});

const commitRecord = typedProcedure({
  access: (ctx) => ctx.auth.kind === "user",
  http: true,
  args: { value: v.string() },
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      await tx.db.records.insert({ value: args.value });
      return "inserted";
    }),
});

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function fixture(): { runtime: Runtime } {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-recompute-"));
  directories.push(directory);
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry({
      mcp: { actionsMcp },
      records: { addRecord, listRecords, commitRecord, emitSignal },
    }),
    telemetry: false,
    limits: PRODUCTION_LIMITS,
  });
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
  });
  return { runtime };
}

async function user(runtime: Runtime, subject: string): Promise<UserPrincipal> {
  const identity = await runtime.resolveIdentity({
    issuer: "https://issuer.test/",
    subject,
  });
  return Object.freeze({
    kind: "user",
    identity,
    issuer: "https://issuer.test/",
    subject,
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: `external-${subject}`,
  });
}

function session(
  principal: UserPrincipal,
  name: string,
  publications: SessionApplicationMessage[],
): SessionRuntimeContext {
  return Object.freeze({
    clientSessionId: name,
    principal,
    fairnessKey: callerFairnessKey(principal, { family: "test", address: name }),
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async (publication: RuntimePublication) => {
      publications.push(publication.message);
      return true;
    },
  });
}

function request<Message>(message: Message): RuntimeRequest<Message> {
  return Object.freeze({ message, bytes: Buffer.byteLength(encode(message)) });
}

test("a subscription recomputes cleanly after another principal's MCP tool commit", async () => {
  const { runtime } = fixture();

  const alice = await user(runtime, "alice");
  const publications: SessionApplicationMessage[] = [];
  const aliceSession = session(alice, "alice-session", publications);
  await runtime.openSession(aliceSession);
  await runtime.subscribe(
    aliceSession,
    request({ v: PROTOCOL_VERSION, t: "sub", id: 7, ref: "records.listRecords", args: {} }),
  );
  await until(() => publications.length >= 1, "initial snapshot");

  const bob = await user(runtime, "bob");
  const result = await runtime.runMcpTool({
    id: 1,
    authorization: runtime.authorizeMcpTool("actions", "add_record", bob),
    args: { value: "burger" },
    principal: bob,
  });
  expect(result.isError ?? false).toBe(false);

  // The subscriber must receive the new row — never an authorization outcome.
  await until(
    () => publications.some((message) => encode(message).includes("burger")),
    "post-commit delivery",
  );
  const delivered = publications.map((message) => encode(message)).join("\n");
  expect(delivered).not.toContain("access denied");
  expect(delivered).not.toContain("unauthorized");
});

test("a subscription recomputes cleanly after another principal's procedure ctx.tx commit", async () => {
  const { runtime } = fixture();

  const alice = await user(runtime, "alice");
  const publications: SessionApplicationMessage[] = [];
  const aliceSession = session(alice, "alice-session", publications);
  await runtime.openSession(aliceSession);
  await runtime.subscribe(
    aliceSession,
    request({ v: PROTOCOL_VERSION, t: "sub", id: 7, ref: "records.listRecords", args: {} }),
  );
  await until(() => publications.length >= 1, "initial snapshot");

  // A procedure commits INSIDE its handler through ctx.tx, exactly like an MCP
  // tool: the same ambient-context leak must not turn the subscriber's
  // recompute into a foreign nested invocation.
  const bob = await user(runtime, "bob");
  const response = await runtime.runProcedure({
    id: 1,
    address: "records.commitRecord",
    args: { value: "burger" },
    principal: bob,
    respond: ({ body, status }) => new Response(body, { status }),
  });
  expect(response.status).toBe(200);

  await until(
    () => publications.some((message) => encode(message).includes("burger")),
    "post-commit delivery",
  );
  const delivered = publications.map((message) => encode(message)).join("\n");
  expect(delivered).not.toContain("access denied");
  expect(delivered).not.toContain("unauthorized");
});

test("an event subscription delivers cleanly after another principal's MCP tool commit", async () => {
  const { runtime } = fixture();

  const alice = await user(runtime, "alice");
  const publications: SessionApplicationMessage[] = [];
  const aliceSession = session(alice, "alice-session", publications);
  await runtime.openSession(aliceSession);
  await runtime.subscribe(
    aliceSession,
    request({ v: PROTOCOL_VERSION, t: "sub", id: 9, ref: "events.signals", args: {} }),
  );
  await until(() => publications.length >= 1, "event reset");

  // Event matching runs app code (listener.matches) during delivery of a
  // foreign principal's commit; delivery must stay clean under the reactive
  // root regardless of the mutator's ambient context.
  const bob = await user(runtime, "bob");
  const result = await runtime.runMcpTool({
    id: 1,
    authorization: runtime.authorizeMcpTool("actions", "emit_signal", bob),
    args: { label: "ping" },
    principal: bob,
  });
  expect(result.isError ?? false).toBe(false);

  await until(
    () => publications.some((message) => encode(message).includes("ping")),
    "post-commit event delivery",
  );
  const delivered = publications.map((message) => encode(message)).join("\n");
  expect(delivered).not.toContain("access denied");
  expect(delivered).not.toContain("unauthorized");
});
