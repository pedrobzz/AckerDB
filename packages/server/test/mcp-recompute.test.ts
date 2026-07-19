import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, encode } from "@dbzz/core";
import type { UserPrincipal } from "../src/auth.ts";
import { callerFairnessKey } from "../src/caller.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import {
  procedure,
  query,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../src/functions.ts";
import { PRODUCTION_LIMITS } from "../src/limits.ts";
import { createMcp, type McpBuilder } from "../src/mcp.ts";
import { reconcile } from "../src/schema/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime } from "../src/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../src/schema.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../src/session.ts";

// A live subscription must survive a commit made by a DIFFERENT principal
// through any dispatch path that commits INSIDE its handler (an MCP tool or a
// procedure, both via ctx.tx). Post-commit recomputation on the subscriber's
// behalf then runs while the mutating invocation's async context is still
// ambient; the recompute is top-level work for the subscriber and must not be
// mistaken for a nested invocation of the mutator (whose principal differs).

const schema = defineSchema({
  records: defineTable({
    id: dbz.primaryKey(),
    value: dbz.string(),
  }),
  signals: defineEventTable({
    id: dbz.primaryKey(),
    label: dbz.string(),
  }, {
    args: {},
    access: (ctx) => ctx.auth.kind === "user",
    matches: () => true,
  }),
});

const typedQuery = query as QueryBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;

const actionsMcp = typedMcp({ name: "actions", path: "/actions/mcp" });

const addRecord = actionsMcp.tool({
  name: "add_record",
  description: "Insert one record transactionally.",
  access: "authenticated",
  args: { value: dbz.string() },
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      await tx.db.records.insert({ value: args.value });
      return { content: [{ type: "text", text: "inserted" }] };
    }),
});

const emitSignal = actionsMcp.tool({
  name: "emit_signal",
  description: "Emit one live event transactionally.",
  access: "authenticated",
  args: { label: dbz.string() },
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      await tx.db.signals.insert({ label: args.label });
      return { content: [{ type: "text", text: "emitted" }] };
    }),
});

const listRecords = typedQuery({
  access: (ctx) => ctx.auth.kind === "user",
  args: {},
  handler: (ctx) => ctx.db.records.scan().collect(),
});

const commitRecord = typedProcedure({
  access: (ctx) => ctx.auth.kind === "user",
  args: { value: dbz.string() },
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
  const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-recompute-"));
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

async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5_000) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    mcp: "actions",
    tool: "add_record",
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
    mcp: "actions",
    tool: "emit_signal",
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
