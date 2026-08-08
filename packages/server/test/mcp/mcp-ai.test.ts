import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  parseSseMessage,
  type SseMessage,
  type Identity,
} from "@ackerdb/core";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  procedure,
  sseProcedure,
  type ProcedureBuilder,
  type SseBuilder,
} from "../../src/app/functions.ts";
import {
  mcp as mcpDeclaration,
  type McpAiToolSet,
  type McpBuilder,
} from "../../src/mcp/index.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { credentialVaultOwner } from "../../src/auth/credential-vault.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type {
  RuntimeHttpResponse,
  RuntimeSseResponse,
} from "../../src/runtime/contracts/requests.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import type { TelemetryRecord, TelemetrySpanRecord } from "../../src/telemetry/telemetry.ts";

const schema = defineSchema({
  calls: defineTable({
    id: v.primaryKey(),
    label: v.string(),
  }),
});

const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedSse = sseProcedure as SseBuilder<typeof schema>;
const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
const choice = v.union("AiChoice", {
  text: v.string(),
  nothing: v.tag(),
  maybe: v.string().optional(),
});

const canonicalInput = Object.freeze({
  large: "9007199254740993",
  identity: "9223372036854775806",
  bytes: "AAEC/v8=",
  choice: { tag: "maybe" } as const,
});

let runtime: Runtime;
let nativeInput: {
  readonly large: bigint;
  readonly identity: Identity;
  readonly bytes: readonly number[];
  readonly optional: string | undefined;
  readonly choice: { readonly tag: string; readonly value?: unknown };
} | undefined;
let roundTripCalls = 0;
let retainedTools: McpAiToolSet | undefined;
let retainedSseTools: McpAiToolSet | undefined;
let parallelEntered = 0;
let parallelRelease = Promise.withResolvers<void>();
let operationCounts: number[] = [];

const roundTrip = typedProcedure({
  title: "Round trip canonical values",
  description: "Round-trip lossless AckerDB values through one local MCP dispatch.",
  access: "public",
  args: {
    large: v.bigint(),
    identity: v.identity(),
    bytes: v.bytes(),
    optional: v.string().optional(),
    choice,
  },
  returns: v.object({
    large: v.bigint(),
    identity: v.identity(),
    bytes: v.bytes(),
    optional: v.string().nullable(),
    choice,
  }),
  handler: async (ctx, args) => {
    roundTripCalls++;
    nativeInput = {
      large: args.large,
      identity: args.identity,
      bytes: [...args.bytes],
      optional: args.optional,
      choice: args.choice,
    };
    await ctx.tx((tx) => tx.db.calls.insert({ label: ctx.auth.kind }));
    return { ...args, optional: args.optional ?? null };
  },
});

const fail = typedProcedure({
  description: "Throw from the handler.",
  access: "public",
  args: {},
  returns: v.object({}),
  handler: () => {
    throw new Error("handler exploded");
  },
});

const parallelEcho = typedProcedure({
  description: "Wait until two local model calls have entered concurrently.",
  access: "public",
  args: { index: v.int() },
  returns: v.object({ index: v.int() }),
  handler: async (_ctx, args) => {
    operationCounts.push(runtime.status().activeOperations);
    parallelEntered++;
    if (parallelEntered === 2) parallelRelease.resolve();
    await parallelRelease.promise;
    return args;
  },
});

const hidden = typedProcedure({
  description: "A protected tool must not be materialized locally.",
  access: "authenticated",
  args: {},
  returns: v.object({ status: v.string() }),
  handler: () => ({ status: "hidden" }),
});

const agentMcp = typedMcp({
  name: "agent",
  path: "/agent/mcp",
  tools: {
    fail: { fn: fail, access: "public" },
    hidden: { fn: hidden, access: "authenticated" },
    parallel_echo: { fn: parallelEcho, access: "public" },
    round_trip: { fn: roundTrip, access: "public" },
  },
});

interface ModelCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

function modelFor(calls: readonly ModelCall[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          ...calls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.input),
          })),
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 0, reasoning: 0 },
            },
          },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

function callsFor(mode: string): readonly ModelCall[] {
  switch (mode) {
    case "structured":
      return [{ id: "structured", name: "round_trip", input: canonicalInput }];
    case "invalid":
      return [{ id: "invalid", name: "round_trip", input: { ...canonicalInput, large: 1.5 } }];
    case "failure":
      return [{ id: "failure", name: "fail", input: {} }];
    case "parallel":
      return [
        { id: "parallel-1", name: "parallel_echo", input: { index: 1 } },
        { id: "parallel-2", name: "parallel_echo", input: { index: 2 } },
      ];
    default:
      throw new Error(`unknown AI fixture ${mode}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const runAi = typedProcedure({
  access: "public",
  http: true,
  args: { mode: v.string() },
  handler: async (ctx, args) => {
    const available = agentMcp.aiTools(ctx);
    const { fail, parallel_echo, round_trip } = available;
    if (
      fail === undefined ||
      parallel_echo === undefined ||
      round_trip === undefined
    ) throw new Error("public MCP tools must be available");
    const tools = { fail, parallel_echo, round_trip } as const;
    retainedTools = tools;
    const result = streamText({
      model: modelFor(callsFor(args.mode)),
      prompt: "Use the requested fixture tool.",
      tools,
      abortSignal: ctx.abortSignal,
    });
    const events: unknown[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "tool-result") {
        events.push({ type: part.type, name: part.toolName, output: part.output });
      } else if (part.type === "tool-error") {
        events.push({ type: part.type, name: part.toolName, error: errorMessage(part.error) });
      }
    }
    return events;
  },
});

const runAiSse = typedSse({
  access: "public",
  http: true,
  args: {},
  yields: v.jsonb<unknown>(),
  handler: (ctx) => {
    const available = agentMcp.aiTools(ctx);
    const tool = available.round_trip;
    if (tool === undefined) throw new Error("round_trip must be available");
    const tools = { round_trip: tool } as const;
    retainedSseTools = tools;
    return (async function* () {
      yield await tools.round_trip!.execute(canonicalInput);
    })();
  },
});

const modules = {
  app: { runAi, runAiSse },
  mcp: { agentMcp },
  tools: { fail, hidden, parallelEcho, roundTrip },
};

let directory: string;
let engine: Engine;
let telemetry: TelemetryRecord[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-ai-"));
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  telemetry = [];
  runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    telemetry: {
      enabled: true,
      exporter: { export: (batch) => void telemetry.push(...batch) },
      localSink: false,
      limits: { ...PRODUCTION_LIMITS.telemetry, slowOperationMs: 0 },
    },
  });
  nativeInput = undefined;
  roundTripCalls = 0;
  retainedTools = undefined;
  retainedSseTools = undefined;
  parallelEntered = 0;
  parallelRelease = Promise.withResolvers<void>();
  operationCounts = [];
});

afterEach(async () => {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

async function callAi(mode: string): Promise<unknown> {
  const response = await runtime.runProcedure({
    id: 1,
    address: "api.app.runAi",
    args: { mode },
    principal: ANONYMOUS_PRINCIPAL,
    respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
  });
  const body = JSON.parse(await response.text());
  if (response.status !== 200) {
    const failure = body as { readonly code: string; readonly message?: string };
    throw new Error(failure.message ?? failure.code);
  }
  return body;
}

async function collectSse(response: RuntimeSseResponse): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const bytes of response.stream as unknown as AsyncIterable<Uint8Array>) {
    const text = new TextDecoder().decode(bytes);
    const message = parseSseMessage(JSON.parse(text.slice("data: ".length).trim()));
    messages.push(message);
    expect(runtime.ackSse({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: response.streamId,
      seq: message.seq,
      proof: message.proof,
    })).toBe(true);
  }
  return messages;
}

function spans(): TelemetrySpanRecord[] {
  return telemetry.filter((record): record is TelemetrySpanRecord => record.kind === "span");
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempts = 0; !check(); attempts++) {
    if (attempts === 100) throw new Error("condition did not become true");
    await Bun.sleep(0);
  }
}

describe("MCP zero-hop AI SDK tools", () => {
  test("passes the returned tools directly to AI SDK v7 with lossless structured values", async () => {
    const fetch = spyOn(globalThis, "fetch");
    const authenticate = spyOn(engine[credentialVaultOwner], "authenticate");
    try {
      const result = await callAi("structured");

      expect(result).toEqual([{
        type: "tool-result",
        name: "round_trip",
        output: {
          large: canonicalInput.large,
          identity: canonicalInput.identity,
          bytes: canonicalInput.bytes,
          optional: null,
          choice: { tag: "maybe" },
        },
      }]);
      expect(nativeInput).toEqual({
        large: 9_007_199_254_740_993n,
        identity: 9_223_372_036_854_775_806n as Identity,
        bytes: [0, 1, 2, 254, 255],
        optional: undefined,
        choice: { tag: "maybe" },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      expect(engine.reader.query('SELECT label FROM "calls"').all()).toEqual([{ label: "anonymous" }]);

      await runtime.telemetry.flush();
      const admission = spans().find((span) =>
        span.operation === "procedure" && span.stage === "admission" && span.requestId === "1"
      );
      // A tool executes as the function it names, so spans carry the function's
      // address rather than "<endpoint>:<tool>". The local adapter dispatches
      // straight to the tool, so no operation-level tool name is emitted here.
      const nested = spans().find((span) =>
        span.stage === "handler" && span.function === "api.tools.roundTrip" && span.requestId === "1"
      );
      expect(admission).toBeDefined();
      expect(nested).toBeDefined();
      expect(nested?.traceId).toBe(admission?.traceId);
    } finally {
      fetch.mockRestore();
      authenticate.mockRestore();
    }
  });

  test("exposes public registry tools and separate Draft-07 input/output schema views", async () => {
    await callAi("structured");
    const tools = retainedTools!;
    expect(Object.keys(tools)).toEqual(["fail", "parallel_echo", "round_trip"]);
    expect(tools.hidden).toBeUndefined();
    expect(tools.round_trip?.title).toBe("Round trip canonical values");

    const input = tools.round_trip!.inputSchema["~standard"];
    const output = tools.round_trip!.outputSchema!["~standard"];
    const firstInputSchema = input.jsonSchema.input({ target: "draft-07" });
    expect(firstInputSchema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      required: ["large", "identity", "bytes", "choice"],
      properties: {
        large: { type: ["integer", "string"] },
        identity: { type: ["integer", "string"] },
      },
    });
    expect(output.jsonSchema.input({ target: "draft-07" })).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      required: ["large", "identity", "bytes", "optional", "choice"],
      properties: {
        large: { type: "string" },
        identity: { type: "string" },
      },
    });
    (firstInputSchema as Record<string, unknown>).additionalProperties = true;
    expect(input.jsonSchema.input({ target: "draft-07" })).toMatchObject({
      additionalProperties: false,
    });
    expect(agentMcp.tools.round_trip.inputSchema).toMatchObject({ additionalProperties: false });
    expect(input.validate(canonicalInput)).toEqual({ value: canonicalInput });
    expect(input.validate({ ...canonicalInput, large: 1, identity: 2 })).toEqual({
      value: { ...canonicalInput, large: 1, identity: 2 },
    });
    expect(output.validate({
      ...canonicalInput,
      large: 1,
      optional: null,
    })).toMatchObject({ issues: expect.any(Array) });
    expect(output.validate({
      ...canonicalInput,
      optional: null,
      choice: { tag: "nothing" },
    })).toMatchObject({
      issues: expect.any(Array),
    });
    const structured = {
      ...canonicalInput,
      optional: null,
      choice: { tag: "maybe" },
    };
    expect(tools.round_trip!.toModelOutput({
      toolCallId: "structured",
      input: canonicalInput,
      output: structured,
    })).toEqual({ type: "json", value: structured });
  });

  test("reports validation and handler failures through AI SDK without invoking invalid input", async () => {
    const invalid = await callAi("invalid");
    expect(invalid).toMatchObject([{
      type: "tool-error",
      name: "round_trip",
      error: expect.stringContaining("InvalidToolInputError"),
    }]);
    expect(roundTripCalls).toBe(0);

    const failure = await callAi("failure");
    expect(failure).toMatchObject([{
      type: "tool-error",
      name: "fail",
      error: expect.stringContaining("handler exploded"),
    }]);
  });

  test("executes parallel tool calls inside the single parent Runtime operation", async () => {
    expect(await callAi("parallel")).toEqual([
      { type: "tool-result", name: "parallel_echo", output: { index: 1 } },
      { type: "tool-result", name: "parallel_echo", output: { index: 2 } },
    ]);
    expect(parallelEntered).toBe(2);
    expect(operationCounts).toEqual([1, 1]);
  });

  test("keeps SSE tools active after handler return and revokes every completed lifecycle", async () => {
    const response = await runtime.runSse({
      id: 2,
      address: "api.app.runAiSse",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });
    const messages = await collectSse(response);
    expect(messages[0]).toMatchObject({
      t: "sse_chunk",
      value: {
        large: canonicalInput.large,
        identity: canonicalInput.identity,
        bytes: canonicalInput.bytes,
        optional: null,
        choice: { tag: "maybe" },
      },
    });
    expect(messages.at(-1)?.t).toBe("sse_done");
    await eventually(() => runtime.status().activeOperations === 0);
    await expect(retainedSseTools!.round_trip!.execute(canonicalInput)).rejects.toThrow(
      "no longer active",
    );

    await callAi("structured");
    await expect(retainedTools!.round_trip!.execute(canonicalInput)).rejects.toThrow(
      "no longer active",
    );
    expect(() => agentMcp.aiTools({} as never)).toThrow("active AckerDB procedure context");
  });
});
