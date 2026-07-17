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
import { DBZZ_HTTP_ROUTES } from "../src/http-routes.ts";
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

const agentMcp = typedMcp({
  name: "agent",
  instructions: "Use the note tools for durable user notes.",
  metadata: {
    title: "Notes Agent",
    description: "A focused notes endpoint.",
    websiteUrl: "https://dbzz.dev/agents/notes",
  },
});
const operationsMcp = typedMcp({
  name: "operations",
  path: "/agents/operations",
  instructions: "Use the operations tools only for service status.",
  metadata: { title: "Operations Agent" },
});
let handlerCalls = 0;
let summaryHandlerCalls = 0;
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

const writeNoteSummary = agentMcp.tool({
  name: "summarize_note",
  description: "Summarize one note as structured data.",
  args: {
    body: dbz.string().describe("The note text to summarize."),
    label: dbz.nullable(dbz.string()).describe("An optional human label."),
  },
  output: dbz.object({
    body: dbz.string().describe("The original note text."),
    length: dbz.number().describe("The number of UTF-16 code units."),
    label: dbz.nullable(dbz.string()).describe("The normalized label."),
  }),
  handler: (_ctx, args) => {
    summaryHandlerCalls++;
    if (args.body === "invalid-output") {
      return { body: args.body, length: "wrong", label: args.label } as never;
    }
    return { body: args.body, length: args.body.length, label: args.label };
  },
});

const readStatus = operationsMcp.tool({
  name: "read_status",
  description: "Read the current service status.",
  args: {},
  handler: () => ({ content: [{ type: "text", text: "ready" }] }),
});

const modules = {
  agent: { agentMcp },
  notes: { insertNote, listNotes, writeNote, writeNoteSummary },
  operations: { readStatus, renamedEndpoint: operationsMcp },
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
  return rpcAt(agentMcp.path, method, params, id);
}

function rpcAt(path: string, method: string, params?: unknown, id = 1): Promise<Response> {
  return fetch(`${harness.base}${path}`, {
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
  summaryHandlerCalls = 0;
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
      "operations.renamedEndpoint",
      "notes.writeNote",
      "notes.writeNoteSummary",
      "operations.readStatus",
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
        serverInfo: {
          name: "agent",
          title: "Notes Agent",
          version: "1",
          description: "A focused notes endpoint.",
          websiteUrl: "https://dbzz.dev/agents/notes",
        },
        instructions: "Use the note tools for durable user notes.",
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
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { body: { type: "string" } },
            required: ["body"],
            additionalProperties: false,
          },
        }, {
          name: "summarize_note",
          description: "Summarize one note as structured data.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              body: { type: "string", description: "The note text to summarize." },
              label: {
                anyOf: [{ type: "string" }, { type: "null" }],
                description: "An optional human label.",
              },
            },
            required: ["body"],
            additionalProperties: false,
          },
          outputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              body: { type: "string", description: "The original note text." },
              length: { type: "number", description: "The number of UTF-16 code units." },
              label: {
                anyOf: [{ type: "string" }, { type: "null" }],
                description: "The normalized label.",
              },
            },
            required: ["body", "length", "label"],
            additionalProperties: false,
          },
        }],
      },
    });
  });

  test("routes independently named endpoints by path without coupling identity to exports", async () => {
    expect(agentMcp.path).toBe("/mcp");
    expect(operationsMcp.path).toBe("/agents/operations");
    expect(operationsMcp.name).toBe("operations");
    expect(harness.registry.addressOf(operationsMcp)).toBe("operations.renamedEndpoint");
    expect(harness.registry.mcps.get("operations")).toBe(operationsMcp);

    const initialized = await rpcAt(operationsMcp.path, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "route-test", version: "1" },
    });
    expect(await initialized.json()).toMatchObject({
      result: {
        serverInfo: { name: "operations", title: "Operations Agent", version: "1" },
        instructions: "Use the operations tools only for service status.",
      },
    });

    const agentTools = await rpcAt(agentMcp.path, "tools/list", {}, 2);
    expect((await agentTools.json() as {
      readonly result: { readonly tools: readonly { readonly name: string }[] };
    }).result.tools.map(({ name }) => name)).toEqual(["write_note", "summarize_note"]);

    const operationsTools = await rpcAt(operationsMcp.path, "tools/list", {}, 3);
    expect((await operationsTools.json() as {
      readonly result: { readonly tools: readonly { readonly name: string }[] };
    }).result.tools.map(({ name }) => name)).toEqual(["read_status"]);

    const unavailableAcrossEndpoints = await rpcAt(agentMcp.path, "tools/call", {
      name: "read_status",
      arguments: {},
    }, 4);
    expect(await unavailableAcrossEndpoints.json()).toMatchObject({ result: { isError: true } });
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

  test("validates and emits declared structured output with canonical JSON text", async () => {
    const invalidInput = await rpc("tools/call", {
      name: "summarize_note",
      arguments: { body: 42 },
    });
    expect(await invalidInput.json()).toMatchObject({ result: { isError: true } });
    expect(summaryHandlerCalls).toBe(0);

    const valid = await rpc("tools/call", {
      name: "summarize_note",
      arguments: { body: "tea" },
    }, 2);
    expect(await valid.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{
          type: "text",
          text: '{"body":"tea","length":3,"label":null}',
        }],
        structuredContent: { body: "tea", length: 3, label: null },
      },
    });
    expect(summaryHandlerCalls).toBe(1);

    const invalidOutput = await rpc("tools/call", {
      name: "summarize_note",
      arguments: { body: "invalid-output", label: "bad" },
    }, 3);
    expect(await invalidOutput.json()).toMatchObject({
      result: {
        content: [{ text: "output.length: expected finite number, got string" }],
        isError: true,
      },
    });
    expect(summaryHandlerCalls).toBe(2);
  });

  test("works through the official SDK client without an HTTP session", async () => {
    const client = new Client({ name: "sdk-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${harness.base}/mcp`));
    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      expect(await client.ping()).toEqual({});
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "write_note",
        "summarize_note",
      ]);
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

  test("rejects duplicate stable names independently of paths and export order", () => {
    const duplicateName = createMcp({ name: "agent", path: "/other" });
    expect(() => new Registry({ z: { duplicateName }, agent: { agentMcp } })).toThrow(
      'duplicate MCP name "agent"',
    );
  });

  test("rejects duplicate custom paths deterministically", () => {
    const alpha = createMcp({ name: "alpha", path: "/shared/mcp" });
    const zeta = createMcp({ name: "zeta", path: "/shared/mcp" });
    expect(() => new Registry({ z: { zeta }, a: { alpha } })).toThrow(
      'MCP "zeta" and "alpha" both use path "/shared/mcp"',
    );
  });

  test("rejects every path owned by the DBZZ listener", () => {
    for (const path of Object.values(DBZZ_HTTP_ROUTES)) {
      const collision = createMcp({ name: "collision", path });
      expect(() => new Registry({ endpoint: { collision } })).toThrow(
        `MCP "collision" path "${path}" collides with a DBZZ route`,
      );
    }
  });

  test("rejects non-canonical paths and bounds declaration guidance", () => {
    for (const path of ["mcp", "/", "//mcp", "/mcp/", "/mcp?mode=1", "/mcp tools", "/a/../mcp"]) {
      expect(() => createMcp({ name: "invalid", path })).toThrow(
        "MCP path must be an absolute static path",
      );
    }
    expect(() => createMcp({ name: "invalid", path: `/${"a".repeat(257)}` })).toThrow(
      "MCP path must be an absolute static path",
    );
    expect(() => createMcp({ name: "invalid", path: null } as never)).toThrow(
      "MCP path must be an absolute static path",
    );
    expect(() => createMcp({ name: "invalid", pth: "/custom" } as never)).toThrow(
      'unknown MCP config field "pth"',
    );
    expect(() => createMcp({
      name: "invalid",
      instructions: "x".repeat(16 * 1_024 + 1),
    })).toThrow("MCP instructions must be at most 16384 UTF-8 bytes");
    expect(() => createMcp({
      name: "invalid",
      metadata: { description: "x".repeat(4 * 1_024) },
    })).toThrow("MCP metadata must be at most 4096 UTF-8 bytes");
    expect(() => createMcp({
      name: "invalid",
      metadata: { websiteUrl: "relative/path" },
    })).toThrow("MCP metadata websiteUrl must be an absolute URL");
  });

  test("keeps stable identity independent from path changes", () => {
    const original = createMcp({ name: "stable", path: "/first" });
    const moved = createMcp({ name: "stable", path: "/second" });
    expect(original.name).toBe(moved.name);
    expect(original.path).not.toBe(moved.path);
  });
});
