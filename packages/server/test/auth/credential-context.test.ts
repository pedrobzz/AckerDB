import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { credentials } from "../../src/auth/credential-context.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import {
  mcp as mcpDeclaration,
  type McpBuilder,
} from "../../src/mcp/index.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeHttpResponse } from "../../src/runtime/contracts/requests.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import type { SessionRuntimeContext } from "../../src/subscriptions/session/contract.ts";
import { mutationMessage, queryMessage, request } from "../support/credential-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
const schema = defineSchema({});
const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function noMcpRuntime(): { readonly runtime: Runtime; readonly session: SessionRuntimeContext } {
  const hiddenMcp = typedMcp({ name: "hidden", tools: {} });
  void hiddenMcp;
  const list = typedQuery({
    access: "public",
    args: {},
    handler: (ctx) => credentials.list(ctx),
  });
  const create = typedMutation({
    access: "public",
    args: {},
    handler: (ctx) => credentials.create(ctx, { name: "hidden", metadata: {} }),
  });
  const transact = typedProcedure({
    access: "public",
    http: true,
    args: {},
    handler: (ctx) => ctx.tx((tx) => credentials.list(tx)),
  });
  const registry = new Registry({ ordinary: { create, list, transact } });
  expect(registry.mcps.size).toBe(0);

  const directory = mkdtempSync(join(tmpdir(), "ackerdb-no-mcp-context-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({ engine, registry, telemetry: false });
  const session = Object.freeze({
    clientSessionId: "no-mcp-context",
    principal: ANONYMOUS_PRINCIPAL,
    fairnessKey: "test:no-mcp-context",
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, session };
}

describe("credential operations without an MCP endpoint", () => {
  test("binds credential operations everywhere while denying anonymous administration", async () => {
    const { runtime, session } = noMcpRuntime();
    await runtime.openSession(session);

    await expect(runtime.query(
      session,
      request(queryMessage(1, "ordinary.list")),
    )).rejects.toMatchObject({
      code: "unauthorized",
      message: "credential administration requires a user identity",
    });
    await expect(runtime.mutation(
      session,
      request(mutationMessage(2, "2", {}, "ordinary.create")),
    )).rejects.toMatchObject({
      code: "unauthorized",
      message: "credential administration requires a user identity",
    });

    const response = await runtime.runProcedure({
      id: 3,
      address: "ordinary.transact",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
    });
    expect(decode(await response.text())).toMatchObject({
      code: "unauthorized",
      message: "credential administration requires a user identity",
    });
  });
});
