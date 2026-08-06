import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, type Identity } from "@ackerdb/core";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  type Principal,
  type UserPrincipal,
  type WorkloadPrincipal,
} from "../../src/auth/credentials.ts";
import { CREDENTIAL_ISSUER } from "../../src/auth/credential-token.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { procedure, type ProcedureBuilder } from "../../src/app/functions.ts";
import {
  mcp as mcpDeclaration,
  type McpAiToolSet,
  type McpBuilder,
  type McpAiContext,
} from "../../src/mcp/index.ts";
import { handleMcpPost } from "../../src/mcp/http.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { credentialVaultOwner } from "../../src/auth/credential-vault.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeHttpResponse } from "../../src/runtime/contracts/requests.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import type { TelemetryRecord, TelemetrySpanRecord } from "../../src/telemetry/telemetry.ts";

const schema = defineSchema({
  calls: defineTable({
    id: v.primaryKey(),
    tool: v.string(),
  }),
});

const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
const VOCABULARY = ["orders.get", "reports.all", "orders.admin", "other.read"] as const;

interface ToolObservation {
  readonly name: string;
  readonly principal: Principal;
}

interface ModelCall {
  readonly id: string;
  readonly name: string;
}

let runtime: Runtime;
let observations: ToolObservation[] = [];
let retainedTools: McpAiToolSet | undefined;
let parallelEnabled = false;
let parallelEntered = 0;
let parallelRelease = Promise.withResolvers<void>();

function principalResult(name: string, principal: Principal) {
  observations.push({ name, principal });
  return {
    tool: name,
    kind: principal.kind,
    identity: principal.kind === "user" ? principal.identity : null,
  };
}

async function parallelPoint(): Promise<void> {
  if (!parallelEnabled) return;
  parallelEntered++;
  if (parallelEntered === 2) parallelRelease.resolve();
  await parallelRelease.promise;
}

const principalOutput = v.object({
  tool: v.string(),
  kind: v.string(),
  identity: v.identity().nullable(),
});

const publicStatus = typedProcedure({
  description: "Public local delegation fixture.",
  access: "public",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("public_status", ctx.auth),
});

const authenticatedStatus = typedProcedure({
  description: "Authenticated local delegation fixture.",
  access: "authenticated",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("authenticated_status", ctx.auth),
});

const readOrders = typedProcedure({
  description: "Any-of local scope fixture.",
  access: "authenticated",
  args: {},
  returns: principalOutput,
  handler: async (ctx) => {
    await parallelPoint();
    await ctx.tx((tx) => tx.db.calls.insert({ tool: "read_orders" }));
    return principalResult("read_orders", ctx.auth);
  },
});

const readReports = typedProcedure({
  description: "All-of local scope fixture.",
  access: "authenticated",
  args: {},
  returns: principalOutput,
  handler: async (ctx) => {
    await parallelPoint();
    return principalResult("read_reports", ctx.auth);
  },
});

const adminOrders = typedProcedure({
  description: "Denied exact local scope fixture.",
  access: "authenticated",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("admin_orders", ctx.auth),
});

const otherPublic = typedProcedure({
  description: "Cross-endpoint public fixture.",
  access: "public",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("other_public", ctx.auth),
});

const otherProtected = typedProcedure({
  description: "Cross-endpoint scoped fixture.",
  access: "authenticated",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("other_protected", ctx.auth),
});

const freePublic = typedProcedure({
  description: "Scope-free public fixture.",
  access: "public",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("free_public", ctx.auth),
});

const freeAuthenticated = typedProcedure({
  description: "Scope-free authenticated fixture.",
  access: "authenticated",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("free_authenticated", ctx.auth),
});

const internalStatus = typedProcedure({
  description: "Private in-app tool fixture.",
  access: "public",
  args: {},
  returns: principalOutput,
  handler: (ctx) => principalResult("internal_status", ctx.auth),
});

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
            input: "{}",
          })),
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
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

async function runModel(tools: McpAiToolSet, calls: readonly ModelCall[]): Promise<unknown[]> {
  const result = streamText({
    model: modelFor(calls),
    prompt: "Use the requested delegation fixture.",
    tools,
  });
  const events: unknown[] = [];
  for await (const part of result.fullStream) {
    if (part.type === "tool-result") {
      events.push({ type: part.type, name: part.toolName, output: part.output });
    } else if (part.type === "tool-error") {
      events.push({
        type: part.type,
        name: part.toolName,
        error: part.error instanceof Error ? part.error.message : String(part.error),
      });
    }
  }
  return events;
}

function errorMessage(work: () => unknown): string {
  try {
    work();
    return "no error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const runLocal = typedProcedure({
  access: "public",
  http: true,
  args: { mode: v.string() },
  handler: async (ctx, args) => {
    switch (args.mode) {
      case "scoped": {
        const tools = scopedMcp.aiTools(ctx, {
          scopes: ["orders.get", "reports.all"],
        });
        retainedTools = tools;
        return {
          names: Object.keys(tools),
          events: await runModel(tools, [
            { id: "authenticated", name: "authenticated_status" },
            { id: "orders", name: "read_orders" },
            { id: "reports", name: "read_reports" },
          ]),
        };
      }
      case "empty": {
        const tools = scopedMcp.aiTools(ctx);
        return { names: Object.keys(tools), events: [] };
      }
      case "anonymous_supplied": {
        const tools = scopedMcp.aiTools(ctx, {
          scopes: ["orders.get", "reports.all", "orders.admin"],
        });
        return { names: Object.keys(tools), events: [] };
      }
      case "anonymous_include": {
        const tools = scopedMcp.aiTools(ctx, {
          scopes: ["orders.admin"],
          includeUnavailable: true,
        });
        return {
          names: Object.keys(tools),
          events: await runModel(tools, [{ id: "admin", name: "admin_orders" }]),
        };
      }
      case "parallel": {
        const orders = scopedMcp.aiTools(ctx, {
          scopes: ["orders.get"],
          includeUnavailable: true,
        });
        const reports = scopedMcp.aiTools(ctx, {
          scopes: ["orders.get", "reports.all"],
          includeUnavailable: true,
        });
        retainedTools = orders;
        return Promise.all([
          orders.read_orders!.execute({}),
          reports.read_reports!.execute({}),
        ]);
      }
      case "scope_free": {
        const tools = scopeFreeMcp.aiTools(ctx);
        return { names: Object.keys(tools), events: [] };
      }
      case "internal_unscoped": {
        // An unscoped delegation is still LOCAL: private tools are exactly
        // the in-app surface it must reach.
        const tools = internalMcp.aiTools(ctx);
        return {
          names: Object.keys(tools).sort(),
          events: await runModel(tools, [
            { id: "internal-auth", name: "internal_authenticated" },
            { id: "internal", name: "internal_status" },
          ]),
        };
      }
      case "scope_free_include": {
        const tools = scopeFreeMcp.aiTools(ctx, { includeUnavailable: true });
        return {
          names: Object.keys(tools),
          events: await runModel(tools, [{ id: "free-auth", name: "free_authenticated" }]),
        };
      }
      case "validation":
        return {
          undeclared: errorMessage(() => scopedMcp.aiTools(ctx, {
            scopes: ["orders.create"],
          } as never)),
          duplicate: errorMessage(() => scopedMcp.aiTools(ctx, {
            scopes: ["orders.get", "orders.get"],
          } as never)),
          syntheticIdentity: errorMessage(() => scopedMcp.aiTools(ctx, {
            scopes: ["orders.get"],
            identity: 9_999n as Identity,
          } as never)),
        };
      default:
        throw new Error(`unknown local delegation mode ${args.mode}`);
    }
  },
});

async function handleDelegate(
  ctx: McpAiContext<typeof schema>,
  args: { readonly mode: string },
): Promise<{ readonly names: string[]; readonly events: unknown[] }> {
  switch (args.mode) {
    case "intersection": {
      const tools = scopedMcp.aiTools(ctx, {
        scopes: ["orders.get", "reports.all", "orders.admin"],
      });
      retainedTools = tools;
      const readOrdersTool = tools.read_orders;
      if (readOrdersTool === undefined) throw new Error("read_orders must be available");
      return {
        names: Object.keys(tools),
        events: await runModel({ read_orders: readOrdersTool }, [
          { id: "orders", name: "read_orders" },
        ]),
      };
    }
    case "include": {
      const tools = scopedMcp.aiTools(ctx, {
        scopes: ["orders.get", "reports.all"],
        includeUnavailable: true,
      });
      return {
        names: Object.keys(tools),
        events: await runModel(tools, [{ id: "reports", name: "read_reports" }]),
      };
    }
    case "cross_default": {
      const tools = otherMcp.aiTools(ctx, { scopes: ["other.read"] });
      return { names: Object.keys(tools), events: [] };
    }
    case "cross_include": {
      const tools = otherMcp.aiTools(ctx, {
        scopes: ["other.read"],
        includeUnavailable: true,
      });
      return {
        names: Object.keys(tools),
        events: await runModel(tools, [{ id: "other", name: "other_public" }]),
      };
    }
    case "shared_provider": {
      const tools = aliasMcp.aiTools(ctx);
      return {
        names: Object.keys(tools),
        events: await runModel(tools, [{ id: "alias", name: "alias_status" }]),
      };
    }
    default:
      throw new Error(`unknown MCP delegation mode ${args.mode}`);
  }
}

const delegate = typedProcedure({
  description: "Exercise local delegation from an existing MCP principal.",
  access: "authenticated",
  args: { mode: v.string() },
  returns: v.object({
    names: v.array(v.string()),
    events: v.jsonb<readonly unknown[]>(),
  }),
  handler: handleDelegate,
});

const scopedMcp = typedMcp({
  name: "delegated",
  path: "/delegated/mcp",
  tools: {
    admin_orders: { fn: adminOrders, access: { anyOf: ["orders.admin"] } },
    authenticated_status: { fn: authenticatedStatus, access: "authenticated" },
    delegate: { fn: delegate, access: "authenticated" },
    public_status: { fn: publicStatus, access: "public" },
    read_orders: { fn: readOrders, access: { anyOf: ["orders.get", "orders.admin"] } },
    read_reports: { fn: readReports, access: { allOf: ["orders.get", "reports.all"] } },
  },
});
const aliasMcp = typedMcp({
  name: "delegated-alias",
  path: "/delegated-alias/mcp",
  tools: {
    alias_status: { fn: publicStatus, access: "public" },
  },
});
const otherMcp = typedMcp({
  name: "other",
  path: "/other/mcp",
  tools: {
    other_protected: { fn: otherProtected, access: { anyOf: ["other.read"] } },
    other_public: { fn: otherPublic, access: "public" },
  },
});
const scopeFreeMcp = typedMcp({
  name: "scope_free",
  path: "/scope-free/mcp",
  tools: {
    free_authenticated: { fn: freeAuthenticated, access: "authenticated" },
    free_public: { fn: freePublic, access: "public" },
  },
});
// Private tools are the in-app-only surface: reachable exclusively through
// local delegation, whatever the size of the delegated grant.
const internalMcp = typedMcp({
  name: "internal",
  private: true,
  tools: {
    internal_authenticated: { fn: freeAuthenticated, access: "authenticated", private: true },
    internal_status: { fn: internalStatus, access: "public", private: true },
  },
});

const modules = {
  app: { runLocal },
  mcp: { aliasMcp, internalMcp, otherMcp, scopeFreeMcp, scopedMcp },
  tools: {
    adminOrders,
    authenticatedStatus,
    delegate,
    freeAuthenticated,
    freePublic,
    internalStatus,
    otherProtected,
    otherPublic,
    publicStatus,
    readOrders,
    readReports,
  },
};

let directory: string;
let engine: Engine;
let telemetry: TelemetryRecord[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-ai-delegation-"));
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  telemetry = [];
  runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    scopes: VOCABULARY,
    telemetry: {
      enabled: true,
      exporter: { export: (batch) => void telemetry.push(...batch) },
      localSink: false,
      limits: { ...PRODUCTION_LIMITS.telemetry, slowOperationMs: 0 },
    },
  });
  observations = [];
  retainedTools = undefined;
  parallelEnabled = false;
  parallelEntered = 0;
  parallelRelease = Promise.withResolvers<void>();
});

afterEach(async () => {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

function user(identity = 41n as Identity): UserPrincipal {
  return Object.freeze({
    kind: "user",
    scopes: Object.freeze([]),
    identity,
    issuer: "https://issuer.test/",
    subject: `user-${identity}`,
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: "external-user-token",
  });
}

function workload(): WorkloadPrincipal {
  return Object.freeze({
    kind: "workload",
    issuer: "https://issuer.test/",
    subject: "service",
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: "workload-token",
  });
}

function credentialPrincipal(
  scopes: readonly string[] = ["orders.get"],
): UserPrincipal {
  return Object.freeze({
    kind: "user",
    identity: 73n as Identity,
    scopes: Object.freeze([...scopes]),
    issuer: CREDENTIAL_ISSUER,
    subject: "manual-test-token",
    claims: Object.freeze({}),
    expiresAt: Number.POSITIVE_INFINITY,
    tokenId: "manual-test-token",
  });
}

async function callProcedure(principal: Principal, mode: string): Promise<unknown> {
  const response = await runtime.runProcedure({
    id: 1,
    address: "app.runLocal",
    args: { mode },
    principal,
    respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
  });
  const body = decode(await response.text());
  if (response.status !== 200) {
    const failure = body as { readonly code: string; readonly message?: string };
    throw new Error(failure.message ?? failure.code);
  }
  return body;
}

function spans(): TelemetrySpanRecord[] {
  return telemetry.filter((record): record is TelemetrySpanRecord => record.kind === "span");
}

async function httpToolCall(
  principal: Principal,
  tool: string,
): Promise<Response> {
  const body = {
    jsonrpc: "2.0",
    id: `http-${tool}`,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  };
  const encoded = JSON.stringify(body);
  return handleMcpPost({
    request: new Request("http://localhost/delegated/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: encoded,
    }),
    body,
    bytes: new TextEncoder().encode(encoded).byteLength,
    mcp: scopedMcp,
    runtime,
    principal,
    signal: new AbortController().signal,
    fairnessKey: "test:mcp-ai-delegation",
  });
}

describe("MCP identity-preserving local delegation", () => {
  test("retains the exact external user and grants only the requested declared scopes", async () => {
    const principal = user();
    const fetch = spyOn(globalThis, "fetch");
    const authenticate = spyOn(engine[credentialVaultOwner], "authenticate");
    try {
      const result = await callProcedure(principal, "scoped") as {
        readonly names: readonly string[];
        readonly events: readonly unknown[];
      };

      expect(result.names).toEqual([
        "authenticated_status",
        "delegate",
        "public_status",
        "read_orders",
        "read_reports",
      ]);
      expect([...result.events].sort((left, right) => {
        const leftName = (left as { readonly name: string }).name;
        const rightName = (right as { readonly name: string }).name;
        return leftName.localeCompare(rightName);
      })).toEqual([
        {
          type: "tool-result",
          name: "authenticated_status",
          output: { tool: "authenticated_status", kind: "user", identity: "41" },
        },
        {
          type: "tool-result",
          name: "read_orders",
          output: { tool: "read_orders", kind: "user", identity: "41" },
        },
        {
          type: "tool-result",
          name: "read_reports",
          output: { tool: "read_reports", kind: "user", identity: "41" },
        },
      ]);
      expect(observations).toHaveLength(3);
      expect(observations.every((entry) => entry.principal === principal)).toBe(true);
      expect(engine.reader.query('SELECT tool FROM "calls"').all()).toEqual([
        { tool: "read_orders" },
      ]);
      expect(fetch).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();

      await runtime.telemetry.flush();
      expect(spans()).toContainEqual(expect.objectContaining({
        function: "tools.readOrders",
        stage: "policy",
        outcome: "ok",
      }));
      await expect(retainedTools!.read_orders!.execute({})).rejects.toThrow(
        "no longer active",
      );
    } finally {
      fetch.mockRestore();
      authenticate.mockRestore();
    }
  });

  test("an unscoped delegation reaches private tools as a local caller", async () => {
    // Locality is the delegation itself, not the size of its grant: an
    // aiTools set with no scopes must still list AND execute private tools.
    expect(await callProcedure(user(), "internal_unscoped")).toEqual({
      names: ["internal_authenticated", "internal_status"],
      events: [
        {
          type: "tool-result",
          name: "internal_authenticated",
          output: { tool: "free_authenticated", kind: "user", identity: "41" },
        },
        {
          type: "tool-result",
          name: "internal_status",
          output: { tool: "internal_status", kind: "user", identity: "41" },
        },
      ],
    });
  });

  test("does not let anonymous scopes manufacture Identity or protected authority", async () => {
    expect(await callProcedure(ANONYMOUS_PRINCIPAL, "anonymous_supplied")).toEqual({
      names: ["public_status"],
      events: [],
    });

    const unavailable = await callProcedure(
      ANONYMOUS_PRINCIPAL,
      "anonymous_include",
    ) as { readonly names: readonly string[]; readonly events: readonly unknown[] };
    expect(unavailable.names).toEqual([
      "admin_orders",
      "authenticated_status",
      "delegate",
      "public_status",
      "read_orders",
      "read_reports",
    ]);
    expect(unavailable.events).toMatchObject([{
      type: "tool-error",
      name: "admin_orders",
      error: expect.stringContaining("authentication required"),
    }]);
    expect(observations).toEqual([]);
    await expect(runtime.runMcpTool({
      id: "anonymous-http-equivalent",
      authorization: runtime.authorizeMcpTool(
        scopedMcp.name,
        scopedMcp.tools.admin_orders.name,
        ANONYMOUS_PRINCIPAL,
      ),
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject({ code: "unauthenticated" });

    expect(await callProcedure(ANONYMOUS_PRINCIPAL, "scope_free")).toEqual({
      names: ["free_public"],
      events: [],
    });
    const scopeFreeUnavailable = await callProcedure(
      ANONYMOUS_PRINCIPAL,
      "scope_free_include",
    ) as { readonly names: readonly string[]; readonly events: readonly unknown[] };
    expect(scopeFreeUnavailable.names).toEqual(["free_authenticated", "free_public"]);
    expect(scopeFreeUnavailable.events).toMatchObject([{
      type: "tool-error",
      name: "free_authenticated",
      error: expect.stringContaining("authentication required"),
    }]);
  });

  test("preserves authenticated semantics but gives workload and system no scoped grant", async () => {
    for (const principal of [workload(), SYSTEM_PRINCIPAL]) {
      expect(await callProcedure(principal, "anonymous_supplied")).toEqual({
        names: ["authenticated_status", "delegate", "public_status"],
        events: [],
      });
    }
    expect(await callProcedure(user(), "scope_free")).toEqual({
      names: ["free_authenticated", "free_public"],
      events: [],
    });
  });

  test("rejects undeclared, duplicate, and synthetic-Identity options", async () => {
    expect(await callProcedure(user(), "validation")).toEqual({
      undeclared: expect.stringContaining("undeclared scope"),
      duplicate: expect.stringContaining("unique scope strings"),
      syntheticIdentity: expect.stringContaining("unknown MCP AI tools option \"identity\""),
    });
  });

  test("intersects a credential parent's request with its effective grant", async () => {
    const principal = credentialPrincipal();
    const fetch = spyOn(globalThis, "fetch");
    const authenticate = spyOn(engine[credentialVaultOwner], "authenticate");
    try {
      const intersection = await runtime.runMcpTool({
        id: "mcp-local-intersection",
        authorization: runtime.authorizeMcpTool(
          scopedMcp.name,
          scopedMcp.tools.delegate.name,
          principal,
        ),
        args: { mode: "intersection" },
        principal,
      });
      expect(intersection.structuredContent).toEqual({
        names: ["authenticated_status", "delegate", "public_status", "read_orders"],
        events: [{
          type: "tool-result",
          name: "read_orders",
          output: { tool: "read_orders", kind: "user", identity: "73" },
        }],
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.principal).toBe(principal);

      const unavailable = await runtime.runMcpTool({
        id: "mcp-local-unavailable",
        authorization: runtime.authorizeMcpTool(
          scopedMcp.name,
          scopedMcp.tools.delegate.name,
          principal,
        ),
        args: { mode: "include" },
        principal,
      });
      expect(unavailable.structuredContent).toMatchObject({
        names: [
          "admin_orders",
          "authenticated_status",
          "delegate",
          "public_status",
          "read_orders",
          "read_reports",
        ],
        events: [{
          type: "tool-error",
          name: "read_reports",
          error: expect.stringContaining("access denied"),
        }],
      });
      expect(observations.map(({ name }) => name)).toEqual(["read_orders"]);

      const httpSuccess = await httpToolCall(principal, scopedMcp.tools.read_orders.name);
      expect(httpSuccess.status).toBe(200);
      expect(await httpSuccess.json()).toMatchObject({
        result: {
          structuredContent: { tool: "read_orders", kind: "user", identity: "73" },
        },
      });
      await expect(httpToolCall(principal, scopedMcp.tools.read_reports.name)).rejects.toMatchObject({
        code: "unauthorized",
        message: "access denied",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      await expect(retainedTools!.read_orders!.execute({})).rejects.toThrow(
        "no longer active",
      );
    } finally {
      fetch.mockRestore();
      authenticate.mockRestore();
    }
  });

  test("serves the same credential on every endpoint that publishes a tool", async () => {
    const principal = credentialPrincipal();
    const result = await runtime.runMcpTool({
      id: "mcp-shared-provider",
      authorization: runtime.authorizeMcpTool(
        scopedMcp.name,
        scopedMcp.tools.delegate.name,
        principal,
      ),
      args: { mode: "shared_provider" },
      principal,
    });

    expect(result.structuredContent).toEqual({
      names: ["alias_status"],
      events: [{
        type: "tool-result",
        name: "alias_status",
        output: { tool: "public_status", kind: "user", identity: "73" },
      }],
    });
  });

  test("narrows cross-endpoint delegation to the credential's own grant", async () => {
    const principal = credentialPrincipal();
    // The requested "other.read" is not in this credential's grant, so the
    // scoped tool stays hidden; the public tool serves any principal.
    const hidden = await runtime.runMcpTool({
      id: "mcp-cross-default",
      authorization: runtime.authorizeMcpTool(
        scopedMcp.name,
        scopedMcp.tools.delegate.name,
        principal,
      ),
      args: { mode: "cross_default" },
      principal,
    });
    expect(hidden.structuredContent).toEqual({ names: ["other_public"], events: [] });

    const shown = await runtime.runMcpTool({
      id: "mcp-cross-include",
      authorization: runtime.authorizeMcpTool(
        scopedMcp.name,
        scopedMcp.tools.delegate.name,
        principal,
      ),
      args: { mode: "cross_include" },
      principal,
    });
    expect(shown.structuredContent).toMatchObject({
      names: ["other_protected", "other_public"],
      events: [{
        type: "tool-result",
        name: "other_public",
        output: { tool: "other_public", kind: "user", identity: "73" },
      }],
    });
    expect(observations.map(({ name }) => name)).toEqual(["other_public"]);
  });

  test("isolates parallel grants and removes authority after the parent lifecycle", async () => {
    const principal = user(99n as Identity);
    parallelEnabled = true;
    const result = await callProcedure(principal, "parallel");
    expect(result).toEqual([
      { tool: "read_orders", kind: "user", identity: "99" },
      { tool: "read_reports", kind: "user", identity: "99" },
    ]);
    expect(parallelEntered).toBe(2);
    expect(observations.every((entry) => entry.principal === principal)).toBe(true);
    await expect(retainedTools!.read_orders!.execute({})).rejects.toThrow(
      "no longer active",
    );
    await expect(runtime.runMcpTool({
      id: "post-local-authority",
      authorization: runtime.authorizeMcpTool(
        scopedMcp.name,
        scopedMcp.tools.read_orders.name,
        principal,
      ),
      args: {},
      principal,
    })).rejects.toMatchObject({ code: "unauthorized" });
  });
});
