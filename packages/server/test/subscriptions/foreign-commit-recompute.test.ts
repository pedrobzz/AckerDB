import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "@ackerdb/core";
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
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/subscriptions/session/contract.ts";
import { until } from "ackerdb-test-support/async";
import { exposedHttpCodec } from "../support/http.ts";

// A live subscription must survive a commit made by a DIFFERENT principal
// through a dispatch path that commits INSIDE its handler (a procedure, via
// ctx.tx). Post-commit recomputation on the subscriber's behalf then runs while
// the mutating invocation's async context is still ambient; the recompute is
// top-level work for the subscriber and must not be mistaken for a nested
// invocation of the mutator (whose principal differs). ADR-0002.

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
});

const typedQuery = query as QueryBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

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

async function fixture(): Promise<{ runtime: Runtime }> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-foreign-commit-"));
  directories.push(directory);
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry({ records: { listRecords, commitRecord } }),
    limits: PRODUCTION_LIMITS,
  });
  await runtime.start();
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

test("a subscription recomputes cleanly after another principal's procedure ctx.tx commit", async () => {
  const { runtime } = await fixture();

  const alice = await user(runtime, "alice");
  const publications: SessionApplicationMessage[] = [];
  const aliceSession = session(alice, "alice-session", publications);
  await runtime.openSession(aliceSession);
  await runtime.subscribe(
    aliceSession,
    request({ t: "sub", id: 7, ref: "api.records.listRecords", args: {} }),
  );
  await until(() => publications.length >= 1, "initial snapshot");

  // Bob's procedure commits INSIDE its handler through ctx.tx: the ambient
  // context of his invocation must not turn Alice's recompute into a foreign
  // nested invocation.
  const bob = await user(runtime, "bob");
  const response = await runtime.runProcedure({
    id: 1,
    address: "api.records.commitRecord",
    args: { value: "burger" },
    codec: exposedHttpCodec(runtime, "api.records.commitRecord"),
    principal: bob,
    respond: ({ body, status }) => new Response(body, { status }),
  });
  expect(response.status).toBe(200);

  // The subscriber must receive the new row — never an authorization outcome.
  await until(
    () => publications.some((message) => encode(message).includes("burger")),
    "post-commit delivery",
  );
  const delivered = publications.map((message) => encode(message)).join("\n");
  expect(delivered).not.toContain("access denied");
  expect(delivered).not.toContain("unauthorized");
});
