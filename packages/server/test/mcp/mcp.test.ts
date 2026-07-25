import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v, type Identity } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { DbzzError } from "../../src/shared/errors.ts";
import {
  mutation,
  query,
  type MutationBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { DBZZ_HTTP_ROUTES } from "../../src/transport/http-routes.ts";
import {
  createMcp,
  finalizeMcpToolResult,
  mcpTool,
  type McpBuilder,
  type McpToolBuilder,
  type McpToolResult,
} from "../../src/mcp/index.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { carryHttpRequestProvenance } from "../../src/runtime/request-provenance.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { serve } from "../../src/transport/server.ts";

const PROTOCOL_VERSION = "2025-11-25";

const schema = defineSchema({
  notes: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

const typedQuery = query as QueryBuilder<typeof schema>;
const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;
const typedMcpTool = mcpTool as McpToolBuilder<typeof schema>;

const listNotes = typedQuery({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.notes.query().collect(),
});

const insertNote = typedMutation({
  access: "public",
  args: { body: v.string() },
  handler: (ctx, args) => ctx.db.notes.insert(args),
});

let handlerCalls = 0;
let summaryHandlerCalls = 0;
let valueHandlerCalls = 0;
let lastHandlerContext: { readonly auth: string; readonly aborted: boolean } | undefined;
let lastNativeValues: {
  readonly minimum: bigint;
  readonly maximum: bigint;
  readonly negative: bigint;
  readonly large: bigint;
  readonly identity: Identity;
  readonly bytes: readonly number[];
} | undefined;

const writeNote = typedMcpTool({
  description: "Write one note and report the committed note count.",
  args: { body: v.string() },
  handler: async (ctx, args) => {
    handlerCalls++;
    lastHandlerContext = { auth: ctx.auth.kind, aborted: ctx.abortSignal.aborted };
    return ctx.tx(async (tx) => {
      await insertNote(tx, { body: args.body });
      if (args.body === "reject") throw new DbzzError("conflict", "note rejected");
      if (args.body === "secret-crash") throw new Error("sensitive implementation detail");
      const rows = await listNotes(tx, {});
      return { content: [{ type: "text", text: `${ctx.auth.kind}:${rows.data.length}` }] };
    });
  },
});

const writeNoteSummary = typedMcpTool({
  description: "Summarize one note as structured data.",
  args: {
    body: v.string().describe("The note text to summarize."),
    label: v.string().optional().describe("An optional human label."),
  },
  output: v.object({
    body: v.string().describe("The original note text."),
    length: v.int().describe("The number of UTF-16 code units."),
    label: v.string().nullable().describe("The normalized label."),
  }),
  handler: (_ctx, args) => {
    summaryHandlerCalls++;
    if (args.body === "invalid-output") {
      return { body: args.body, length: "wrong", label: args.label } as never;
    }
    return { body: args.body, length: args.body.length, label: args.label ?? null };
  },
});

const readStatus = typedMcpTool({
  description: "Read the current service status.",
  args: {},
  handler: () => ({ content: [{ type: "text", text: "ready" }] }),
});

const echoValues = typedMcpTool({
  description: "Round-trip DBZZ-native values without losing precision or bytes.",
  args: {
    minimum: v.bigint(),
    maximum: v.bigint(),
    negative: v.bigint(),
    large: v.bigint(),
    identity: v.identity(),
    bytes: v.bytes(),
    nested: v.array(v.bigint().nullable()),
    literal: v.literal(7n),
    opaque: v.jsonb<unknown>(),
    poisonOutput: v.boolean(),
  },
  output: v.object({
    minimum: v.bigint(),
    maximum: v.bigint(),
    negative: v.bigint(),
    large: v.bigint(),
    identity: v.identity(),
    bytes: v.bytes(),
    nested: v.array(v.bigint().nullable()),
    literal: v.literal(7n),
    opaque: v.jsonb<unknown>(),
  }),
  handler: (_ctx, args) => {
    valueHandlerCalls++;
    const identity: Identity = args.identity;
    lastNativeValues = {
      minimum: args.minimum,
      maximum: args.maximum,
      negative: args.negative,
      large: args.large,
      identity,
      bytes: [...args.bytes],
    };
    return {
      minimum: args.minimum,
      maximum: args.maximum,
      negative: args.negative,
      large: args.large,
      identity,
      bytes: args.bytes,
      nested: args.nested,
      literal: args.literal,
      opaque: args.poisonOutput ? 1n : args.opaque,
    };
  },
});

function richContentResult(kind: string, auth: string): McpToolResult {
  switch (kind) {
    case "text":
      return {
        content: [{
          type: "text",
          text: "hello agent",
          annotations: {
            audience: ["assistant"],
            priority: 0.75,
            lastModified: "2026-07-17T09:30:00Z",
          },
          _meta: { source: "notes" },
        }],
      };
    case "image":
      return {
        content: [{
          type: "image",
          data: "AQID",
          mimeType: "image/png",
          annotations: { audience: ["user"] },
          _meta: { width: 1, height: 1 },
        }],
      };
    case "audio":
      return {
        content: [{
          type: "audio",
          data: "BAUG",
          mimeType: "audio/wav",
          annotations: { priority: 0.5 },
          _meta: { seconds: 1 },
        }],
      };
    case "resource_text":
      return {
        content: [{
          type: "resource",
          resource: {
            uri: "dbzz://notes/1",
            mimeType: "text/plain",
            text: "embedded note",
            _meta: { encoding: "utf-8" },
          },
          annotations: { audience: ["assistant", "user"] },
          _meta: { embedded: true },
        }],
      };
    case "resource_blob":
      return {
        content: [{
          type: "resource",
          resource: {
            uri: "dbzz://notes/2",
            mimeType: "application/octet-stream",
            blob: "AQID",
            _meta: { checksum: "010203" },
          },
        }],
      };
    case "resource_link":
      return {
        content: [{
          type: "resource_link",
          uri: "https://dbzz.dev/notes/1",
          name: "note-one",
          title: "Note one",
          description: "The first durable note.",
          mimeType: "text/plain",
          size: 13,
          icons: [{
            src: "https://dbzz.dev/note.png",
            mimeType: "image/png",
            sizes: ["48x48", "any"],
            theme: "light",
          }],
          annotations: { priority: 1, lastModified: "2026-07-17T09:30:00+00:00" },
          _meta: { durable: true },
        }],
      };
    case "mixed":
      return {
        content: [{ type: "text", text: "mixed" }, {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
        }, {
          type: "resource_link",
          uri: "dbzz://notes/1",
          name: "note-one",
        }],
        _meta: { auth, nested: { values: [true, 1, null] } },
      };
    case "error":
      return {
        content: [{ type: "text", text: "The note could not be rendered." }],
        isError: true,
        _meta: { reason: "unsupported_note" },
      };
    default:
      throw new Error(`unknown rich content fixture ${kind}`);
  }
}

function invalidContentValue(kind: string): unknown {
  switch (kind) {
    case "arbitrary":
      return { value: "not a content result" };
    case "base64":
      return { content: [{ type: "image", data: "not base64!", mimeType: "image/png" }] };
    case "annotations":
      return { content: [{ type: "text", text: "bad", annotations: { priority: 2 } }] };
    case "annotations_audience":
      return { content: [{ type: "text", text: "bad", annotations: { audience: ["model"] } }] };
    case "annotations_date":
      return {
        content: [{
          type: "text",
          text: "bad",
          annotations: { lastModified: "not-a-date" },
        }],
      };
    case "annotations_calendar":
      return {
        content: [{
          type: "text",
          text: "bad",
          annotations: { lastModified: "2026-02-31T09:30:00Z" },
        }],
      };
    case "metadata":
      return { content: [], _meta: { invalid: 1n } };
    case "resource":
      return { content: [{ type: "resource_link", uri: "relative", name: "bad" }] };
    case "resource_shape":
      return {
        content: [{
          type: "resource",
          resource: { uri: "dbzz://notes/1", text: "text", blob: "AQID" },
        }],
      };
    case "unknown_field":
      return { content: [{ type: "text", text: "bad", arbitrary: true }] };
    default:
      throw new Error(`unknown invalid content fixture ${kind}`);
  }
}

const renderContent = typedMcpTool({
  title: "Render rich content",
  description: "Return one stable MCP rich-content fixture.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  args: { kind: v.string() },
  handler: (ctx, args) => richContentResult(args.kind, ctx.auth.kind),
});

const invalidResult = typedMcpTool({
  description: "Exercise runtime rejection of arbitrary results.",
  args: { kind: v.string() },
  handler: (_ctx, args) => invalidContentValue(args.kind) as never,
});

const agentMcp = typedMcp({
  name: "agent",
  instructions: "Use the note tools for durable user notes.",
  metadata: {
    title: "Notes Agent",
    description: "A focused notes endpoint.",
    websiteUrl: "https://dbzz.dev/agents/notes",
  },
  tools: {
    summarize_note: writeNoteSummary,
    write_note: writeNote,
  },
});
const operationsMcp = typedMcp({
  name: "operations",
  path: "/agents/operations",
  instructions: "Use the operations tools only for service status.",
  metadata: { title: "Operations Agent" },
  tools: { read_status: readStatus },
});
const valuesMcp = typedMcp({
  name: "values",
  path: "/mcp/values",
  tools: { echo_values: echoValues },
});
const contentMcp = typedMcp({
  name: "content",
  path: "/mcp/content",
  tools: {
    invalid_result: invalidResult,
    render_content: renderContent,
  },
});
const registeredEchoValues = valuesMcp.tools.echo_values;

const modules = {
  agent: { agentMcp },
  content: { contentMcp, invalidResult, renderContent },
  notes: { insertNote, listNotes, writeNote, writeNoteSummary },
  operations: { readStatus, renamedEndpoint: operationsMcp },
  values: { echoValues, valuesMcp },
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
  const server = serve({
    runtime,
    port: 0,
    mcpHttp: { allowedOrigins: ["https://agent.example"] },
  });
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

function protocolValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    minimum: "-9223372036854775808",
    maximum: "9223372036854775807",
    negative: "-42",
    large: "9007199254740993",
    identity: "9223372036854775806",
    bytes: "AAEC/v8=",
    nested: ["0", null, "-1"],
    literal: "7",
    opaque: { $: "b", v: "5" },
    poisonOutput: false,
    ...overrides,
  };
}

function noteCount(): bigint {
  return (harness.engine.reader.query('SELECT COUNT(*) AS count FROM "notes"').get() as {
    readonly count: bigint;
  }).count;
}

beforeEach(() => {
  handlerCalls = 0;
  summaryHandlerCalls = 0;
  valueHandlerCalls = 0;
  lastHandlerContext = undefined;
  lastNativeValues = undefined;
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
      "content.contentMcp",
      "operations.renamedEndpoint",
      "values.valuesMcp",
      "content.invalidResult",
      "content.renderContent",
      "notes.writeNote",
      "notes.writeNoteSummary",
      "operations.readStatus",
      "values.echoValues",
    ]);
    expect(harness.registry.addressOf(writeNote)).toBeUndefined();
    expect(harness.registry.addressOf(agentMcp.tools.write_note)).toBeUndefined();

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
          name: "summarize_note",
          description: "Summarize one note as structured data.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              body: { type: "string", description: "The note text to summarize." },
              label: {
                type: "string",
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
              length: {
                type: "integer",
                minimum: Number.MIN_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
                description: "The number of UTF-16 code units.",
              },
              label: {
                type: ["string", "null"],
                description: "The normalized label.",
              },
            },
            required: ["body", "length", "label"],
            additionalProperties: false,
          },
        }, {
          name: "write_note",
          description: "Write one note and report the committed note count.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { body: { type: "string" } },
            required: ["body"],
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
    }).result.tools.map(({ name }) => name)).toEqual(["summarize_note", "write_note"]);

    const operationsTools = await rpcAt(operationsMcp.path, "tools/list", {}, 3);
    expect((await operationsTools.json() as {
      readonly result: { readonly tools: readonly { readonly name: string }[] };
    }).result.tools.map(({ name }) => name)).toEqual(["read_status"]);

    const unavailableAcrossEndpoints = await rpcAt(agentMcp.path, "tools/call", {
      name: "read_status",
      arguments: {},
    }, 4);
    expect(unavailableAcrossEndpoints.status).toBe(401);
    expect(await unavailableAcrossEndpoints.json()).toMatchObject({
      error: { message: "authentication required" },
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
        content: [{ text: "output.length: expected safe integer, got string" }],
        isError: true,
      },
    });
    expect(summaryHandlerCalls).toBe(2);
  });

  test("round-trips bigint, Identity, and bytes through one lossless protocol codec", async () => {
    const listed = await rpcAt(valuesMcp.path, "tools/list", {}, 1);
    const listedBody = await listed.json() as {
      readonly result: {
        readonly tools: readonly {
          readonly inputSchema: { readonly properties: Record<string, unknown> };
          readonly outputSchema: { readonly properties: Record<string, unknown> };
        }[];
      };
    };
    const discovered = listedBody.result.tools[0]!;
    expect(discovered.inputSchema.properties.minimum).toEqual({
      type: ["integer", "string"],
      pattern: "^(?:0|-?[1-9][0-9]*)$",
    });
    expect(discovered.inputSchema.properties.identity).toEqual({
      type: ["integer", "string"],
      pattern: "^(?:0|-?[1-9][0-9]*)$",
    });
    expect(discovered.inputSchema.properties.nested).toEqual({
      type: "array",
      items: {
        type: ["integer", "string", "null"],
        pattern: "^(?:0|-?[1-9][0-9]*)$",
      },
    });
    expect(discovered.inputSchema.properties.bytes).toEqual({
      type: "string",
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
      contentEncoding: "base64",
    });
    expect(discovered.outputSchema.properties.maximum).toEqual({
      type: "string",
      pattern: "^(?:0|-?[1-9][0-9]*)$",
    });

    const standardResult = registeredEchoValues.inputCodec["~standard"].validate(protocolValues());
    expect(standardResult).toMatchObject({
      value: {
        minimum: -(2n ** 63n),
        maximum: 2n ** 63n - 1n,
        large: 9_007_199_254_740_993n,
        identity: 9_223_372_036_854_775_806n,
        literal: 7n,
      },
    });

    const minimumValidator = registeredEchoValues.args.minimum;
    const originalCheck = minimumValidator.check;
    let minimumChecks = 0;
    Object.defineProperty(minimumValidator, "check", {
      configurable: true,
      writable: true,
      value(value: unknown, path: string) {
        minimumChecks++;
        return originalCheck(value, path);
      },
    });
    const response = await rpcAt(valuesMcp.path, "tools/call", {
      name: "echo_values",
      arguments: protocolValues(),
    }, 2).finally(() => {
      Object.defineProperty(minimumValidator, "check", {
        configurable: true,
        writable: true,
        value: originalCheck,
      });
    });
    expect(minimumChecks).toBe(1);
    const expected = {
      minimum: "-9223372036854775808",
      maximum: "9223372036854775807",
      negative: "-42",
      large: "9007199254740993",
      identity: "9223372036854775806",
      bytes: "AAEC/v8=",
      nested: ["0", null, "-1"],
      literal: "7",
      opaque: { $: "b", v: "5" },
    };
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: JSON.stringify(expected) }],
        structuredContent: expected,
      },
    });
    expect(lastNativeValues).toEqual({
      minimum: -(2n ** 63n),
      maximum: 2n ** 63n - 1n,
      negative: -42n,
      large: 9_007_199_254_740_993n,
      identity: 9_223_372_036_854_775_806n as Identity,
      bytes: [0, 1, 2, 254, 255],
    });
  });

  test("accepts JSON-number bigints (proto3-style) while forcing unsafe magnitudes to strings", () => {
    const decode = (overrides: Record<string, unknown>) =>
      registeredEchoValues.inputCodec.decode(protocolValues(overrides), "args") as {
        readonly minimum: bigint;
        readonly negative: bigint;
        readonly large: bigint;
        readonly identity: bigint;
      };
    expect(decode({ minimum: 9 }).minimum).toBe(9n);
    expect(decode({ minimum: "9" }).minimum).toBe(9n);
    expect(decode({ negative: -3 }).negative).toBe(-3n);
    expect(decode({ minimum: -0 }).minimum).toBe(0n);
    expect(decode({ large: "9007199254740993" }).large).toBe(9_007_199_254_740_993n);
    expect(decode({ identity: 42 }).identity).toBe(42n);

    for (const [invalid, message] of [
      [9.5, "safe integer"],
      [9_007_199_254_740_992, "safe integer"],
      [Number.NaN, "standard JSON value"],
      [Number.POSITIVE_INFINITY, "standard JSON value"],
      [true, "canonical decimal string"],
      ['"9"', "canonical decimal string"],
      ["09", "canonical decimal string"],
    ] as const) {
      expect(() => registeredEchoValues.inputCodec.decode(protocolValues({ minimum: invalid }), "args"))
        .toThrow(message);
    }
  });

  test("rejects malformed decimal/base64 and non-JSON opaque values", async () => {
    for (const invalid of ["01", "+1", "-0", "9223372036854775808"]) {
      expect(() => registeredEchoValues.inputCodec.decode(protocolValues({ minimum: invalid }), "args"))
        .toThrow();
    }
    for (const invalid of ["AQI", "AQI===", "!!=="]) {
      expect(() => registeredEchoValues.inputCodec.decode(protocolValues({ bytes: invalid }), "args"))
        .toThrow("canonical base64");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const nativeValues = registeredEchoValues.inputCodec.decode(protocolValues(), "args");
    expect(() => registeredEchoValues.outputCodec.encode({
      ...nativeValues,
      poisonOutput: undefined,
      opaque: cyclic,
    }, "output")).toThrow("output.opaque.self: cyclic JSON value");
    expect(valueHandlerCalls).toBe(0);

    const malformed = await rpcAt(valuesMcp.path, "tools/call", {
      name: "echo_values",
      arguments: protocolValues({ negative: "00" }),
    }, 1);
    expect(await malformed.json()).toMatchObject({ result: { isError: true } });
    expect(valueHandlerCalls).toBe(0);

    const poisoned = await rpcAt(valuesMcp.path, "tools/call", {
      name: "echo_values",
      arguments: protocolValues({ poisonOutput: true }),
    }, 2);
    expect(await poisoned.json()).toMatchObject({
      result: {
        content: [{ text: "output.opaque: expected a standard JSON value" }],
        isError: true,
      },
    });
    expect(valueHandlerCalls).toBe(1);
  });

  test("advertises tool titles and host hints without treating them as authorization", async () => {
    const listed = await rpcAt(contentMcp.path, "tools/list", {});
    const body = await listed.json() as {
      readonly result: { readonly tools: readonly Record<string, unknown>[] };
    };
    expect(body.result.tools).toHaveLength(2);
    expect(body.result.tools[0]).toMatchObject({
      name: "invalid_result",
      description: "Exercise runtime rejection of arbitrary results.",
    });
    expect(body.result.tools[1]).toMatchObject({
      name: "render_content",
      title: "Render rich content",
      description: "Return one stable MCP rich-content fixture.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });

    const anonymousCall = await rpcAt(contentMcp.path, "tools/call", {
      name: "render_content",
      arguments: { kind: "mixed" },
    }, 2);
    expect(await anonymousCall.json()).toMatchObject({ result: { _meta: { auth: "anonymous" } } });
  });

  test("preserves every rich content block, mixed content, metadata, and intentional errors", async () => {
    const kinds = [
      "text",
      "image",
      "audio",
      "resource_text",
      "resource_blob",
      "resource_link",
      "mixed",
      "error",
    ] as const;
    for (let index = 0; index < kinds.length; index++) {
      const kind = kinds[index]!;
      const response = await rpcAt(contentMcp.path, "tools/call", {
        name: "render_content",
        arguments: { kind },
      }, index + 1);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: index + 1,
        result: richContentResult(kind, "anonymous"),
      });
    }

    const malformed = await fetch(`${harness.base}${contentMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: "{",
    });
    const malformedBody = await malformed.json();
    expect(malformedBody).toMatchObject({ jsonrpc: "2.0", error: {}, id: null });
    expect(malformedBody).not.toHaveProperty("result");
  });

  test("rejects arbitrary rich results and invalid annotations at compile-independent runtime boundaries", async () => {
    const invalid = [
      ["arbitrary", "unknown field"],
      ["base64", "base64-encoded data"],
      ["annotations", "priority must be between 0 and 1"],
      ["annotations_audience", "audience must contain only user or assistant"],
      ["annotations_date", "lastModified must be an ISO 8601 date-time"],
      ["annotations_calendar", "lastModified must be an ISO 8601 date-time"],
      ["metadata", "expected a standard JSON value"],
      ["resource", "must be an absolute URI"],
      ["resource_shape", "must contain exactly one of text or blob"],
      ["unknown_field", "unknown field"],
    ] as const;
    for (let index = 0; index < invalid.length; index++) {
      const [kind, message] = invalid[index]!;
      expect(() => finalizeMcpToolResult(contentMcp.tools.invalid_result, invalidContentValue(kind)))
        .toThrow(message);

      const response = await rpcAt(contentMcp.path, "tools/call", {
        name: "invalid_result",
        arguments: { kind },
      }, index + 1);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { isError: true } });
    }

    const invalidAnnotations = (name: string, annotations: unknown) => typedMcp({
      name,
      path: `/invalid/${name}`,
      tools: {
        invalid_hint: typedMcpTool({
          description: "Invalid runtime fixture.",
          args: {},
          annotations: annotations as never,
          handler: () => ({ content: [] }),
        }),
      },
    });
    expect(() => invalidAnnotations("invalid_hint", { readOnlyHint: "yes" }))
      .toThrow("MCP tool annotation readOnlyHint must be a boolean");
    expect(() => invalidAnnotations("unknown_hint", { authorization: true }))
      .toThrow('unknown MCP tool annotation "authorization"');
  });

  test("works through the official SDK client without an HTTP session", async () => {
    const client = new Client({ name: "sdk-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${harness.base}/mcp`));
    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      expect(await client.ping()).toEqual({});
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "summarize_note",
        "write_note",
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
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
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

  test("returns JSON-RPC method-not-found for unsupported methods", async () => {
    const unsupported = await rpc("resources/list");
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: 1,
    });
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
  test("round-trips prototype-named MCP fields as own Standard JSON properties", () => {
    const prototypeShape = {
      ["__proto__"]: v.string(),
      constructor: v.bigint().optional(),
    } as const;
    const prototypeFields = typedMcpTool({
      description: "Preserve legal prototype-named fields.",
      args: prototypeShape,
      output: v.object(prototypeShape),
      handler: (_ctx, args) => args,
    });
    const endpoint = typedMcp({
      name: "prototype_fields",
      path: "/prototype/fields",
      tools: { prototype_fields: prototypeFields },
    });
    const tool = endpoint.tools.prototype_fields;
    const inputProperties = tool.inputSchema.properties as Record<string, unknown>;
    const outputProperties = tool.outputSchema.properties as Record<string, unknown>;

    expect(Object.getPrototypeOf(inputProperties)).toBeNull();
    expect(Object.hasOwn(inputProperties, "__proto__")).toBe(true);
    expect(Object.hasOwn(outputProperties, "__proto__")).toBe(true);

    const decoded = tool.inputCodec.decode(
      JSON.parse('{"__proto__":"safe","constructor":7}'),
      "args",
    );
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(decoded.__proto__).toBe("safe");
    expect(decoded.constructor).toBe(7n);

    const encoded = tool.outputCodec.encode(decoded, "output") as Record<string, unknown>;
    expect(Object.getPrototypeOf(encoded)).toBeNull();
    expect(Object.hasOwn(encoded, "__proto__")).toBe(true);
    expect(JSON.stringify(encoded)).toBe('{"__proto__":"safe","constructor":"7"}');
  });

  test("rejects every unsupported or contradictory nested validator shape", () => {
    const unsupported = { ...v.string(), kind: "custom" } as never;
    const contradictoryArray = { ...v.string(), kind: "array" } as never;
    const cases = [
      [v.array(v.primaryKey()), "v.primaryKey() is not an MCP value"],
      [v.array(v.scheduleAt()), "v.scheduleAt() is not an MCP value"],
      [v.array(v.tag()), "v.tag() is valid only as a direct v.union() member"],
      [unsupported, "v.custom() has no lossless standard-JSON protocol representation"],
      [contradictoryArray, "v.array() has no element validator"],
    ] as const;
    for (const [index, [value, message]] of cases.entries()) {
      expect(() => typedMcp({
        name: `invalid_shape_${index}`,
        path: `/invalid/shape-${index}`,
        tools: {
          invalid_shape: typedMcpTool({
            description: "This declaration must fail before registration.",
            args: { value },
            handler: () => ({ content: [{ type: "text", text: "never" }] }),
          }),
        },
      })).toThrow(message);
    }

    expect(() => typedMcp({
      name: "invalid_output",
      path: "/invalid/output",
      tools: {
        invalid_output: typedMcpTool({
          description: "Nested output validators compile at declaration time too.",
          args: {},
          output: v.object({ value: v.array(v.scheduleAt()) }),
          handler: () => ({ value: [] }),
        }),
      },
    })).toThrow("$.value[]: v.scheduleAt() is not an MCP value");
  });

  test("snapshots and reuses inert blueprints without giving them registration identity", () => {
    const args = { value: v.string() };
    const annotations = { readOnlyHint: true };
    const access = { anyOf: ["read"] } as { anyOf: ["read"] };
    const reusable = typedMcpTool({
      description: "Reusable source definition.",
      args,
      annotations,
      access,
      handler: (_ctx, input) => ({ content: [{ type: "text", text: input.value }] }),
    });

    args.value = v.int() as never;
    annotations.readOnlyHint = false;
    (access.anyOf as string[])[0] = "admin";

    const first = typedMcp({
      name: "reuse_first",
      path: "/reuse/first",
      scopes: ["read"] as const,
      tools: { first_name: reusable, second_name: reusable },
    });
    const second = typedMcp({
      name: "reuse_second",
      path: "/reuse/second",
      scopes: ["read"] as const,
      tools: { third_name: reusable },
    });
    const registry = new Registry({
      blueprints: { again: reusable, reusable },
      endpoints: { first, second },
    });

    expect(first.tools.first_name).not.toBe(first.tools.second_name);
    expect(first.tools.first_name).not.toBe(second.tools.third_name);
    expect(first.tools.first_name.name).toBe("first_name");
    expect(first.tools.second_name.name).toBe("second_name");
    expect(second.tools.third_name.name).toBe("third_name");
    expect(first.tools.first_name.mcp).toBe(first);
    expect(second.tools.third_name.mcp).toBe(second);
    expect(first.tools.first_name.annotations).toEqual({ readOnlyHint: true });
    expect(first.tools.first_name.accessPolicy).toEqual({ kind: "anyOf", scopes: ["read"] });
    expect(first.tools.first_name.inputCodec.decode({ value: "kept" }, "args"))
      .toEqual({ value: "kept" });
    expect(() => first.tools.first_name.inputCodec.decode({ value: 1 }, "args")).toThrow();
    expect(registry.addressOf(reusable)).toBeUndefined();
    expect(registry.addressOf(first.tools.first_name)).toBeUndefined();
    expect(registry.registeredToolsFor(first)).toEqual([
      first.tools.first_name,
      first.tools.second_name,
    ]);
  });

  test("rejects two declarations that claim the default route", () => {
    const other = createMcp({ name: "other", tools: {} });
    expect(() => new Registry({ agent: { agentMcp }, other: { other } })).toThrow(
      'both use path "/mcp"',
    );
  });

  test("rejects duplicate stable names independently of paths and export order", () => {
    const duplicateName = createMcp({ name: "agent", path: "/other", tools: {} });
    expect(() => new Registry({ z: { duplicateName }, agent: { agentMcp } })).toThrow(
      'duplicate MCP name "agent"',
    );
  });

  test("rejects duplicate custom paths deterministically", () => {
    const alpha = createMcp({ name: "alpha", path: "/shared/mcp", tools: {} });
    const zeta = createMcp({ name: "zeta", path: "/shared/mcp", tools: {} });
    expect(() => new Registry({ z: { zeta }, a: { alpha } })).toThrow(
      'MCP "zeta" and "alpha" both use path "/shared/mcp"',
    );
  });

  test("rejects every path owned by the DBZZ listener", () => {
    for (const path of Object.values(DBZZ_HTTP_ROUTES)) {
      const collision = createMcp({ name: "collision", path, tools: {} });
      expect(() => new Registry({ endpoint: { collision } })).toThrow(
        `MCP "collision" path "${path}" collides with a DBZZ route`,
      );
    }
  });

  test("rejects non-canonical paths and bounds declaration guidance", () => {
    for (const path of ["mcp", "/", "//mcp", "/mcp/", "/mcp?mode=1", "/mcp tools", "/a/../mcp"]) {
      expect(() => createMcp({ name: "invalid", path, tools: {} })).toThrow(
        "MCP path must be an absolute static path",
      );
    }
    expect(() => createMcp({ name: "invalid", path: `/${"a".repeat(257)}`, tools: {} })).toThrow(
      "MCP path must be an absolute static path",
    );
    expect(() => createMcp({ name: "invalid", path: null, tools: {} } as never)).toThrow(
      "MCP path must be an absolute static path",
    );
    expect(() => createMcp({ name: "invalid", pth: "/custom", tools: {} } as never)).toThrow(
      'unknown MCP config field "pth"',
    );
    expect(() => createMcp({
      name: "invalid",
      instructions: "x".repeat(16 * 1_024 + 1),
      tools: {},
    })).toThrow("MCP instructions must be at most 16384 UTF-8 bytes");
    expect(() => createMcp({
      name: "invalid",
      metadata: { description: "x".repeat(4 * 1_024) },
      tools: {},
    })).toThrow("MCP metadata must be at most 4096 UTF-8 bytes");
    expect(() => createMcp({
      name: "invalid",
      metadata: { websiteUrl: "relative/path" },
      tools: {},
    })).toThrow("MCP metadata websiteUrl must be an absolute URL");
  });

  test("keeps stable identity independent from path changes", () => {
    const original = createMcp({ name: "stable", path: "/first", tools: {} });
    const moved = createMcp({ name: "stable", path: "/second", tools: {} });
    expect(original.name).toBe(moved.name);
    expect(original.path).not.toBe(moved.path);
  });
});
