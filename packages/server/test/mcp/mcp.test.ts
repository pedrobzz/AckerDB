import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import type { Identity } from "@ackerdb/core";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { ACKERDB_HTTP_ROUTES } from "../../src/transport/http-surface.ts";
import {
  mcp as mcpDeclaration,
  finalizeMcpToolResult,
  mcpAuth,
  type McpBuilder,
  type McpAuthBuilder,
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
const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcpAuth = mcpAuth as McpAuthBuilder<typeof schema>;
/** Route and naming checks care about paths, not about authority. */
const rawAuth = mcpAuth({ name: "raw" });
const agentAuth = typedMcpAuth({ name: "agent" });
const operationsAuth = typedMcpAuth({ name: "operations" });
const valuesAuth = typedMcpAuth({ name: "values" });

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

const writeNote = typedProcedure({
  description: "Write one note and report the committed note count.",
  access: "public",
  args: { body: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    handlerCalls++;
    lastHandlerContext = { auth: ctx.auth.kind, aborted: ctx.abortSignal.aborted };
    const done = await ctx.tx(async (tx) => {
      await insertNote(tx, { body: args.body });
      if (args.body === "reject") throw new AckerDBError("conflict", "note rejected");
      if (args.body === "secret-crash") throw new Error("sensitive implementation detail");
      const rows = await listNotes(tx, {});
      return { status: `${ctx.auth.kind}:${rows.data.length}` };
    });
    if (!done.ok) throw new Error("note write failed");
    return done.data;
  },
});

const writeNoteSummary = typedQuery({
  description: "Summarize one note as structured data.",
  access: "public",
  args: {
    body: v.string().describe("The note text to summarize."),
    label: v.string().optional().describe("An optional human label."),
  },
  returns: v.object({
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

const readStatus = typedQuery({
  description: "Read the current service status.",
  access: "public",
  args: {},
  returns: v.object({ status: v.string() }),
  handler: () => ({ status: "ready" }),
});

const echoValues = typedQuery({
  description: "Round-trip AckerDB-native values without losing precision or bytes.",
  access: "public",
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
  returns: v.object({
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

const agentMcp = typedMcp({
  name: "agent",
  auth: agentAuth,
  instructions: "Use the note tools for durable user notes.",
  metadata: {
    title: "Notes Agent",
    description: "A focused notes endpoint.",
    websiteUrl: "https://ackerdb.dev/agents/notes",
  },
  tools: {
    summarize_note: { fn: writeNoteSummary, access: "public" },
    write_note: { fn: writeNote, access: "public" },
  },
});
const operationsMcp = typedMcp({
  name: "operations",
  auth: operationsAuth,
  path: "/agents/operations",
  instructions: "Use the operations tools only for service status.",
  metadata: { title: "Operations Agent" },
  tools: { read_status: { fn: readStatus, access: "public" } },
});
const titledStatus = typedQuery({
  title: "Render rich content",
  description: "Return one stable status fixture.",
  access: "public",
  args: {},
  returns: v.object({ status: v.string() }),
  handler: () => ({ status: "ok" }),
});
const titledMcp = typedMcp({
  name: "titled",
  auth: typedMcpAuth({ name: "titled" }),
  path: "/mcp/titled",
  tools: {
    titled_status: {
      fn: titledStatus,
      access: "public",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  },
});
const valuesMcp = typedMcp({
  name: "values",
  auth: valuesAuth,
  path: "/mcp/values",
  tools: { echo_values: { fn: echoValues, access: "public" } },
});
const registeredEchoValues = valuesMcp.tools.echo_values;

const modules = {
  agent: { agentMcp },
  titled: { titledMcp, titledStatus },
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
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-"));
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
    // An endpoint is server-only; the functions it publishes are ordinary
    // registered functions and keep their addresses.
    expect(harness.registry.functions.has("agent.agentMcp")).toBe(false);
    expect(harness.registry.functions.has("notes.writeNote")).toBe(true);
    expect([...harness.registry.serverOnly.keys()]).toEqual([
      "agent.agentMcp",
      "operations.renamedEndpoint",
      "titled.titledMcp",
      "values.valuesMcp",
    ]);
    expect(harness.registry.addressOf(writeNote)).toBe("notes.writeNote");
    // The tool wrapper itself is never addressed; only the function it names is.
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
          websiteUrl: "https://ackerdb.dev/agents/notes",
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
          outputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
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
      result: {
        content: [{ type: "text", text: '{"status":"anonymous:1"}' }],
        structuredContent: { status: "anonymous:1" },
      },
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
        content: [{ text: "returns.length: expected safe integer, got string" }],
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

    expect(registeredEchoValues.codec.decodeArgs(protocolValues())).toMatchObject({
      minimum: -(2n ** 63n),
      maximum: 2n ** 63n - 1n,
      large: 9_007_199_254_740_993n,
      identity: 9_223_372_036_854_775_806n,
      literal: 7n,
    });

    const minimumValidator = registeredEchoValues.fn.args.minimum!;
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
    // Twice: once decoding standard JSON at the surface boundary, once inside
    // the invocation path that every caller shares. The HTTP surface validates
    // the same way, so a tool and an `http: true` route behave identically.
    expect(minimumChecks).toBe(2);
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
      registeredEchoValues.codec.decodeArgs(protocolValues(overrides)) as {
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
      expect(() => registeredEchoValues.codec.decodeArgs(protocolValues({ minimum: invalid })))
        .toThrow(message);
    }
  });

  test("rejects malformed decimal/base64 and non-JSON opaque values", async () => {
    for (const invalid of ["01", "+1", "-0", "9223372036854775808"]) {
      expect(() => registeredEchoValues.codec.decodeArgs(protocolValues({ minimum: invalid })))
        .toThrow();
    }
    for (const invalid of ["AQI", "AQI===", "!!=="]) {
      expect(() => registeredEchoValues.codec.decodeArgs(protocolValues({ bytes: invalid })))
        .toThrow("canonical base64");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const nativeValues = registeredEchoValues.codec.decodeArgs(protocolValues()) as Record<string, unknown>;
    expect(() => registeredEchoValues.codec.encodeOutput({
      ...nativeValues,
      poisonOutput: undefined,
      opaque: cyclic,
    })).toThrow("returns.opaque.self: cyclic JSON value");
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
        content: [{ text: "returns.opaque: expected a standard JSON value" }],
        isError: true,
      },
    });
    expect(valueHandlerCalls).toBe(1);
  });

  test("advertises tool titles and host hints without treating them as authorization", async () => {
    const listed = await rpcAt(titledMcp.path!, "tools/list", {});
    const body = await listed.json() as {
      readonly result: { readonly tools: readonly Record<string, unknown>[] };
    };
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toMatchObject({
      name: "titled_status",
      title: "Render rich content",
      description: "Return one stable status fixture.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    // Hints are advice to a model, never authorization: the tool still answers
    // an anonymous caller because its entry says `public`.
    const anonymous = await rpcAt(titledMcp.path!, "tools/call", {
      name: "titled_status",
      arguments: {},
    }, 2);
    expect(await anonymous.json()).toMatchObject({
      result: { structuredContent: { status: "ok" } },
    });
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
        content: [{ type: "text", text: '{"status":"anonymous:1"}' }],
        structuredContent: { status: "anonymous:1" },
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
    // File uploads raise Bun's listener-wide ceiling, but this route still
    // rejects its own declared length before allocating or parsing it.
    expect(oversized.status).toBe(429);
    expect(await oversized.json()).toMatchObject({
      error: { message: "request exceeds maxRequestBytes" },
    });
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

  test("rejects malformed JSON without using AckerDB's tagged wire codec", async () => {
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
      authorization: harness.runtime.authorizeMcpTool(
        "agent",
        "write_note",
        ANONYMOUS_PRINCIPAL,
      ),
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
    const prototypeFields = typedQuery({
      description: "Preserve legal prototype-named fields.",
      access: "public",
      args: prototypeShape,
      returns: v.object(prototypeShape),
      handler: (_ctx, args) => args,
    });
    const endpoint = typedMcp({
      name: "prototype_fields",
      auth: typedMcpAuth({ name: "prototype_fields" }),
      path: "/prototype/fields",
      tools: { prototype_fields: { fn: prototypeFields, access: "public" } },
    });
    const tool = endpoint.tools.prototype_fields;
    const inputProperties = tool.inputSchema.properties as Record<string, unknown>;
    const outputProperties = tool.outputSchema!.properties as Record<string, unknown>;

    expect(Object.getPrototypeOf(inputProperties)).toBeNull();
    expect(Object.hasOwn(inputProperties, "__proto__")).toBe(true);
    expect(Object.hasOwn(outputProperties, "__proto__")).toBe(true);

    const decoded = tool.codec.decodeArgs(
      JSON.parse('{"__proto__":"safe","constructor":7}'),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(decoded["__proto__"]).toBe("safe");
    expect(decoded["constructor"]).toBe(7n);

    const encoded = tool.codec.encodeOutput(decoded) as Record<string, unknown>;
    expect(Object.getPrototypeOf(encoded)).toBeNull();
    expect(Object.hasOwn(encoded, "__proto__")).toBe(true);
    expect(JSON.stringify(encoded)).toBe('{"__proto__":"safe","constructor":"7"}');
  });

  test("rejects every unsupported or contradictory nested validator shape", () => {
    const unsupported = { ...v.string(), kind: "custom" } as never;
    const contradictoryArray = { ...v.string(), kind: "array" } as never;
    const cases = [
      [v.array(v.primaryKey()), "v.primaryKey() is not a standard-JSON value"],
      [v.array(v.scheduleAt()), "v.scheduleAt() is not a standard-JSON value"],
      [v.array(v.tag()), "v.tag() is valid only as a direct v.union() member"],
      [unsupported, "v.custom() has no lossless standard-JSON protocol representation"],
      [contradictoryArray, "v.array() has no element validator"],
    ] as const;
    for (const [index, [value, message]] of cases.entries()) {
      const invalidShape = typedQuery({
        description: "This declaration must fail before registration.",
        access: "public",
        args: { value },
        returns: v.object({}),
        handler: () => ({}),
      });
      expect(() => typedMcp({
        name: `invalid_shape_${index}`,
        auth: typedMcpAuth({ name: `invalid_shape_${index}` }),
        path: `/invalid/shape-${index}`,
        tools: { invalid_shape: { fn: invalidShape, access: "public" } },
      })).toThrow(message);
    }

    const invalidOutput = typedQuery({
      description: "Nested return validators compile at declaration time too.",
      access: "public",
      args: {},
      returns: v.object({ value: v.array(v.scheduleAt()) }),
      handler: () => ({ value: [] }),
    });
    expect(() => typedMcp({
      name: "invalid_output",
      auth: typedMcpAuth({ name: "invalid_output" }),
      path: "/invalid/output",
      tools: { invalid_output: { fn: invalidOutput, access: "public" } },
    })).toThrow("$.value[]: v.scheduleAt() is not a standard-JSON value");
  });

  test("rejects two declarations that claim the default route", () => {
    const other = mcpDeclaration({ auth: rawAuth, name: "other", tools: {} });
    expect(() => new Registry({ agent: { agentMcp }, other: { other } })).toThrow(
      'both use path "/mcp"',
    );
  });

  test("rejects duplicate stable names independently of paths and export order", () => {
    const duplicateName = mcpDeclaration({ auth: rawAuth, name: "agent", path: "/other", tools: {} });
    expect(() => new Registry({ z: { duplicateName }, agent: { agentMcp } })).toThrow(
      'duplicate MCP name "agent"',
    );
  });

  test("rejects duplicate custom paths deterministically", () => {
    const alpha = mcpDeclaration({ auth: rawAuth, name: "alpha", path: "/shared/mcp", tools: {} });
    const zeta = mcpDeclaration({ auth: rawAuth, name: "zeta", path: "/shared/mcp", tools: {} });
    expect(() => new Registry({ z: { zeta }, a: { alpha } })).toThrow(
      'MCP "zeta" and "alpha" both use path "/shared/mcp"',
    );
  });

  test("rejects every path owned by the AckerDB listener", () => {
    for (const path of Object.values(ACKERDB_HTTP_ROUTES)) {
      const declare = () => new Registry({
        endpoint: { collision: mcpDeclaration({ auth: rawAuth, name: "collision", path, tools: {} }) },
      });
      // A dotted route — the document endpoint's file extension — is not even a
      // spellable MCP path, so it is refused before a registry compares it.
      expect(declare).toThrow(
        path.includes(".")
          ? "MCP path must be an absolute static path"
          : `MCP "collision" path "${path}" collides with AckerDB route "${path}"`,
      );
    }
  });

  test("rejects non-canonical paths and bounds declaration guidance", () => {
    for (const path of ["mcp", "/", "//mcp", "/mcp/", "/mcp?mode=1", "/mcp tools", "/a/../mcp"]) {
      expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid", path, tools: {} })).toThrow(
        "MCP path must be an absolute static path",
      );
    }
    expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid", path: `/${"a".repeat(257)}`, tools: {} })).toThrow(
      "MCP path must be an absolute static path",
    );
    expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid", path: null, tools: {} } as never)).toThrow(
      "MCP path must be an absolute static path",
    );
    expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid", pth: "/custom", tools: {} } as never)).toThrow(
      'unknown MCP config field "pth"',
    );
    expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid",
      instructions: "x".repeat(16 * 1_024 + 1),
      tools: {},
    })).toThrow("MCP instructions must be at most 16384 UTF-8 bytes");
    expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid",
      metadata: { description: "x".repeat(4 * 1_024) },
      tools: {},
    })).toThrow("MCP metadata must be at most 4096 UTF-8 bytes");
    expect(() => mcpDeclaration({ auth: rawAuth, name: "invalid",
      metadata: { websiteUrl: "relative/path" },
      tools: {},
    })).toThrow("MCP metadata websiteUrl must be an absolute URL");
  });

  test("keeps stable identity independent from path changes", () => {
    const original = mcpDeclaration({ auth: rawAuth, name: "stable", path: "/first", tools: {} });
    const moved = mcpDeclaration({ auth: rawAuth, name: "stable", path: "/second", tools: {} });
    expect(original.name).toBe(moved.name);
    expect(original.path).not.toBe(moved.path);
  });
});
