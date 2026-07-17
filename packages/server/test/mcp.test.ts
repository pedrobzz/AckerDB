import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANONYMOUS_PRINCIPAL } from "../src/auth.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { DbzzError } from "../src/errors.ts";
import {
  mutation,
  query,
  type MutationBuilder,
  type QueryBuilder,
} from "../src/functions.ts";
import { createMcp, type McpBuilder } from "../src/mcp.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../src/limits.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { carryHttpRequestProvenance } from "../src/request-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { serve } from "../src/serve.ts";

const PROTOCOL_VERSION = "2025-11-25";

const schema = defineSchema({
  notes: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
  }),
});

const typedQuery = query as QueryBuilder<typeof schema>;
const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;

const listNotes = typedQuery({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.notes.scan().collect(),
});

const insertNote = typedMutation({
  access: "public",
  args: { body: dbz.string() },
  handler: (ctx, args) => ctx.db.notes.insert(args),
});

const agentMcp = typedMcp({ name: "agent" });
let handlerCalls = 0;
let lastHandlerContext: { readonly auth: string; readonly aborted: boolean } | undefined;

const writeNote = agentMcp.tool({
  name: "write_note",
  description: "Write one note and report the committed note count.",
  args: { body: dbz.string() },
  handler: async (ctx, args) => {
    handlerCalls++;
    lastHandlerContext = { auth: ctx.auth.kind, aborted: ctx.abortSignal.aborted };
    return ctx.tx(async (tx) => {
      await insertNote(tx, { body: args.body });
      if (args.body === "reject") throw new DbzzError("conflict", "note rejected");
      if (args.body === "secret-crash") throw new Error("sensitive implementation detail");
      const rows = await listNotes(tx, {});
      return { content: [{ type: "text", text: `${ctx.auth.kind}:${rows.length}` }] };
    });
  },
});

const modules = {
  agent: { agentMcp },
  notes: { insertNote, listNotes, writeNote },
};

interface Harness {
  readonly directory: string;
  readonly engine: Engine;
  readonly registry: Registry;
  readonly runtime: Runtime;
  readonly server: ReturnType<typeof serve>;
  readonly base: string;
}

let harness: Harness;

function startHarness(limits?: ServiceLimits): Harness {
  const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry(modules);
  const runtime = new Runtime({ engine, registry, limits, telemetry: false });
  const server = serve({ runtime, port: 0 });
  return {
    directory,
    engine,
    registry,
    runtime,
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

async function stopHarness(value: Harness): Promise<void> {
  await value.server.drain().catch(() => {});
  await value.runtime.drain().catch(() => {});
  value.engine.close("clean");
  rmSync(value.directory, { recursive: true, force: true });
}

function mcpHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
}

function rpc(method: string, params?: unknown, id = 1): Promise<Response> {
  return fetch(`${harness.base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

function noteCount(): bigint {
  return (harness.engine.reader.query('SELECT COUNT(*) AS count FROM "notes"').get() as {
    readonly count: bigint;
  }).count;
}

beforeEach(() => {
  handlerCalls = 0;
  lastHandlerContext = undefined;
  harness = startHarness();
});

afterEach(async () => {
  await stopHarness(harness);
});

describe("public stateless MCP endpoint", () => {
  test("discovers explicit server-only declarations at the default route", async () => {
    expect(agentMcp.path).toBe("/mcp");
    expect(harness.registry.functions.has("agent.agentMcp")).toBe(false);
    expect(harness.registry.functions.has("notes.writeNote")).toBe(false);
    expect([...harness.registry.serverOnly.keys()]).toEqual([
      "agent.agentMcp",
      "notes.writeNote",
    ]);
    expect(harness.registry.addressOf(writeNote)).toBe("notes.writeNote");

    const initialize = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "raw-test", version: "1" },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    expect(await initialize.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agent", version: "1" },
      },
    });

    const initialized = await fetch(`${harness.base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe("");

    const ping = await rpc("ping", undefined, 2);
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

    const listed = await rpc("tools/list", {}, 3);
    expect(await listed.json()).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        tools: [{
          name: "write_note",
          description: "Write one note and report the committed note count.",
          inputSchema: {
            type: "object",
            properties: { body: { type: "string" } },
            required: ["body"],
            additionalProperties: false,
          },
        }],
      },
    });
  });

  test("validates before the handler and commits or rolls back normal transactions", async () => {
    const invalid = await rpc("tools/call", {
      name: "write_note",
      arguments: { body: 42 },
    });
    expect(await invalid.json()).toMatchObject({
      result: { isError: true },
    });
    expect(handlerCalls).toBe(0);
    expect(noteCount()).toBe(0n);

    const committed = await rpc("tools/call", {
      name: "write_note",
      arguments: { body: "first" },
    }, 2);
    expect(await committed.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "anonymous:1" }] },
    });
    expect(lastHandlerContext).toEqual({ auth: "anonymous", aborted: false });
    expect(noteCount()).toBe(1n);

    const rejected = await rpc("tools/call", {
      name: "write_note",
      arguments: { body: "reject" },
    }, 3);
    expect(await rejected.json()).toMatchObject({
      result: { content: [{ type: "text", text: "note rejected" }], isError: true },
    });
    expect(noteCount()).toBe(1n);

    const crashed = await rpc("tools/call", {
      name: "write_note",
      arguments: { body: "secret-crash" },
    }, 4);
    const crashBody = await crashed.json() as {
      readonly result: { readonly content: readonly { readonly text: string }[]; readonly isError: boolean };
    };
    expect(crashBody.result.isError).toBe(true);
    expect(crashBody.result.content[0]?.text).toBe("internal server error");
    expect(JSON.stringify(crashBody)).not.toContain("sensitive implementation detail");
    expect(noteCount()).toBe(1n);
  });

  test("works through the official SDK client without an HTTP session", async () => {
    const client = new Client({ name: "sdk-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${harness.base}/mcp`));
    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      expect(await client.ping()).toEqual({});
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["write_note"]);
      expect(await client.callTool({
        name: "write_note",
        arguments: { body: "sdk" },
      })).toMatchObject({
        content: [{ type: "text", text: "anonymous:1" }],
      });
      expect(noteCount()).toBe(1n);
    } finally {
      await client.close();
    }
  });

  test("gives explicit stateless method and bounded-body responses", async () => {
    const preflight = await fetch(`${harness.base}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://agent.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, mcp-protocol-version",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${harness.base}/mcp`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }

    await stopHarness(harness);
    harness = startHarness({ ...PRODUCTION_LIMITS, maxRequestBytes: 256 });
    const oversized = await fetch(`${harness.base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "write_note", arguments: { body: "x".repeat(1_024) } },
      }),
    });
    // Bun rejects a declared over-limit body before DBZZ allocates or parses it.
    expect(oversized.status).toBe(413);
    expect(handlerCalls).toBe(0);
  });

  test("rejects malformed JSON without using DBZZ's tagged wire codec", async () => {
    const malformed = await fetch(`${harness.base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "malformed JSON request body" },
      id: null,
    });

    await harness.runtime.drain();
    const unavailable = await rpc("ping");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "server is not ready" },
      id: null,
    });
  });

  test("propagates abort state through the shared Runtime dispatcher", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller canceled"));
    await expect(harness.runtime.runMcpTool(carryHttpRequestProvenance({
      id: 1,
      mcp: "agent",
      tool: "write_note",
      args: { body: "never" },
      principal: ANONYMOUS_PRINCIPAL,
      signal: controller.signal,
    }, 1, undefined))).rejects.toMatchObject({ code: "unavailable" });
    expect(handlerCalls).toBe(0);
    expect(noteCount()).toBe(0n);
  });
});

describe("MCP startup invariants", () => {
  test("rejects duplicate tool names within one MCP", () => {
    const duplicate = agentMcp.tool({
      name: "write_note",
      description: "A duplicate wire name.",
      args: {},
      handler: () => ({ content: [{ type: "text", text: "duplicate" }] }),
    });
    expect(() => new Registry({
      agent: { agentMcp },
      one: { writeNote },
      two: { duplicate },
    })).toThrow('duplicate MCP tool name "write_note" in MCP "agent"');
  });

  test("rejects two declarations that claim the default route", () => {
    const other = createMcp({ name: "other" });
    expect(() => new Registry({ agent: { agentMcp }, other: { other } })).toThrow(
      'both use path "/mcp"',
    );
  });
});
