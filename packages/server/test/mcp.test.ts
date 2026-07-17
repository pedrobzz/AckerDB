import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANONYMOUS_PRINCIPAL } from "../src/auth.ts";
import { dbz, type Identity } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { DbzzError } from "../src/errors.ts";
import {
  mutation,
  query,
  type MutationBuilder,
  type QueryBuilder,
} from "../src/functions.ts";
import { DBZZ_HTTP_ROUTES } from "../src/http-routes.ts";
import {
  createMcp,
  finalizeMcpToolResult,
  type McpBuilder,
  type McpToolResult,
} from "../src/mcp.ts";
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
const valuesMcp = typedMcp({ name: "values", path: "/mcp/values" });
const contentMcp = typedMcp({ name: "content", path: "/mcp/content" });
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

const echoValues = valuesMcp.tool({
  name: "echo_values",
  description: "Round-trip DBZZ-native values without losing precision or bytes.",
  args: {
    minimum: dbz.bigint(),
    maximum: dbz.bigint(),
    negative: dbz.bigint(),
    large: dbz.bigint(),
    identity: dbz.identity(),
    bytes: dbz.bytes(),
    nested: dbz.array(dbz.nullable(dbz.bigint())),
    literal: dbz.literal(7n),
    opaque: dbz.jsonb<unknown>(),
    poisonOutput: dbz.boolean(),
  },
  output: dbz.object({
    minimum: dbz.bigint(),
    maximum: dbz.bigint(),
    negative: dbz.bigint(),
    large: dbz.bigint(),
    identity: dbz.identity(),
    bytes: dbz.bytes(),
    nested: dbz.array(dbz.nullable(dbz.bigint())),
    literal: dbz.literal(7n),
    opaque: dbz.jsonb<unknown>(),
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

const renderContent = contentMcp.tool({
  name: "render_content",
  title: "Render rich content",
  description: "Return one stable MCP rich-content fixture.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  args: { kind: dbz.string() },
  handler: (ctx, args) => richContentResult(args.kind, ctx.auth.kind),
});

const invalidResult = contentMcp.tool({
  name: "invalid_result",
  description: "Exercise runtime rejection of arbitrary results.",
  args: { kind: dbz.string() },
  handler: (_ctx, args) => invalidContentValue(args.kind) as never,
});

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
        content: [{ text: "output.length: expected finite number, got string" }],
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
      type: "string",
      pattern: "^(?:0|-?[1-9][0-9]*)$",
    });
    expect(discovered.inputSchema.properties.identity).toEqual({
      type: "string",
      pattern: "^(?:0|-?[1-9][0-9]*)$",
    });
    expect(discovered.inputSchema.properties.bytes).toEqual({
      type: "string",
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
      contentEncoding: "base64",
    });
    expect(discovered.outputSchema.properties.maximum).toEqual(
      discovered.inputSchema.properties.maximum,
    );

    const standardResult = echoValues.inputCodec["~standard"].validate(protocolValues());
    expect(standardResult).toMatchObject({
      value: {
        minimum: -(2n ** 63n),
        maximum: 2n ** 63n - 1n,
        large: 9_007_199_254_740_993n,
        identity: 9_223_372_036_854_775_806n,
        literal: 7n,
      },
    });

    const minimumValidator = echoValues.args.minimum;
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

  test("rejects malformed decimal/base64 and non-JSON opaque values", async () => {
    for (const invalid of ["01", "+1", "-0", "9223372036854775808", 1]) {
      expect(() => echoValues.inputCodec.decode(protocolValues({ minimum: invalid }), "args"))
        .toThrow();
    }
    for (const invalid of ["AQI", "AQI===", "!!=="]) {
      expect(() => echoValues.inputCodec.decode(protocolValues({ bytes: invalid }), "args"))
        .toThrow("canonical base64");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const nativeValues = echoValues.inputCodec.decode(protocolValues(), "args");
    expect(() => echoValues.outputCodec.encode({
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
      expect(() => finalizeMcpToolResult(invalidResult, invalidContentValue(kind)))
        .toThrow(message);

      const response = await rpcAt(contentMcp.path, "tools/call", {
        name: "invalid_result",
        arguments: { kind },
      }, index + 1);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { isError: true } });
    }

    expect(() => contentMcp.tool({
      name: "invalid_hint",
      description: "Invalid runtime fixture.",
      args: {},
      annotations: { readOnlyHint: "yes" } as never,
      handler: () => ({ content: [] }),
    })).toThrow("MCP tool annotation readOnlyHint must be a boolean");
    expect(() => contentMcp.tool({
      name: "unknown_hint",
      description: "Invalid runtime fixture.",
      args: {},
      annotations: { authorization: true } as never,
      handler: () => ({ content: [] }),
    })).toThrow('unknown MCP tool annotation "authorization"');
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
  test("rejects every unsupported or contradictory nested validator shape", () => {
    const unsupported = { ...dbz.string(), kind: "custom" } as never;
    const contradictoryArray = { ...dbz.string(), kind: "array" } as never;
    const cases = [
      [dbz.array(dbz.primaryKey()), "dbz.primaryKey() is not an MCP value"],
      [dbz.array(dbz.scheduleAt()), "dbz.scheduleAt() is not an MCP value"],
      [dbz.array(dbz.tag()), "dbz.tag() is valid only as a direct dbz.union() member"],
      [unsupported, "dbz.custom() has no lossless standard-JSON protocol representation"],
      [contradictoryArray, "dbz.array() has no element validator"],
    ] as const;
    for (const [value, message] of cases) {
      expect(() => agentMcp.tool({
        name: "invalid_shape",
        description: "This declaration must fail before registration.",
        args: { value },
        handler: () => ({ content: [{ type: "text", text: "never" }] }),
      })).toThrow(message);
    }

    expect(() => agentMcp.tool({
      name: "invalid_output",
      description: "Nested output validators compile at declaration time too.",
      args: {},
      output: dbz.object({ value: dbz.array(dbz.scheduleAt()) }),
      handler: () => ({ value: [] }),
    })).toThrow("$.value[]: dbz.scheduleAt() is not an MCP value");
  });

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
