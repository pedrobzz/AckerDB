import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { mcp } from "../../src/mcp/index.ts";
import { query } from "../../src/app/functions.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import { AckerDBServer, serve, type McpHttpOptions } from "../../src/transport/server.ts";
import type { TelemetryRecord } from "../../src/telemetry/telemetry.ts";

const ACKERDB_VERSION = "2025-11-25";
const ARGUMENT_CANARY = "private-mcp-argument-canary";
const RESULT_CANARY = "private-mcp-result-canary";
const HANDLER_ERROR_CANARY = "private-mcp-handler-error-canary";
const TOKEN_CANARY = `ackerdb_credential.${"A".repeat(22)}.${"B".repeat(43)}`;
const PROVIDER_CREDENTIAL_CANARY = "private-provider-credential-canary";

const schema = defineSchema({});
const echoSecret = query({
  description: "Return one private fixture without observing its contents.",
  access: "public",
  args: { secret: v.string(), crash: v.boolean() },
  returns: v.object({ echoed: v.string() }),
  handler: (_ctx, args) => {
    if (args.crash) throw new Error(`${HANDLER_ERROR_CANARY}:${args.secret}`);
    return { echoed: `${RESULT_CANARY}:${args.secret}` };
  },
});
const protectedTool = query({
  description: "Require an MCP Identity.",
  access: "authenticated",
  args: {},
  returns: v.object({ status: v.string() }),
  handler: () => ({ status: "protected" }),
});
const securityMcp = mcp({
  name: "security",
  tools: {
    echo_secret: { fn: echoSecret, access: "public" },
    protected_tool: { fn: protectedTool, access: "authenticated" },
  },
});
const modules = { security: { securityMcp, echoSecret, protectedTool } };

interface Fixture {
  readonly directory: string;
  readonly engine: Engine;
  readonly runtime: Runtime;
  readonly server: AckerDBServer;
  readonly base: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function fixture(options: {
  readonly hostname?: string;
  readonly limits?: ServiceLimits;
  readonly mcpHttp?: McpHttpOptions;
  readonly telemetry?: ConstructorParameters<typeof Runtime>[0]["telemetry"];
} = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-security-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    limits: options.limits,
    telemetry: options.telemetry ?? false,
  });
  const server = serve({
    runtime,
    port: 0,
    hostname: options.hostname,
    mcpHttp: options.mcpHttp,
  });
  const value = {
    directory,
    engine,
    runtime,
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
  cleanups.push(async () => {
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });
  return value;
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": ACKERDB_VERSION,
    ...overrides,
  };
}

function rpc(
  value: Fixture,
  method: string,
  params?: unknown,
  overrides?: Record<string, string>,
): Promise<Response> {
  return fetch(`${value.base}${securityMcp.path}`, {
    method: "POST",
    headers: headers(overrides),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

describe("MCP HTTP security boundary", () => {
  test("derives loopback Host and same-origin policy while allowing native clients", async () => {
    const value = fixture({ mcpHttp: { allowedOrigins: ["https://agent.example"] } });

    const native = await rpc(value, "ping");
    expect(native.status).toBe(200);
    expect(native.headers.get("vary")).toBe("Origin");
    expect(native.headers.get("access-control-allow-origin")).toBeNull();

    const sameOrigin = await rpc(value, "ping", undefined, { origin: value.base });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(value.base);

    const configuredOrigin = await rpc(value, "ping", undefined, {
      origin: "https://agent.example",
    });
    expect(configuredOrigin.status).toBe(200);
    expect(configuredOrigin.headers.get("access-control-allow-origin"))
      .toBe("https://agent.example");

    for (const [name, requestHeaders] of [
      ["origin", { origin: "https://evil.example" }],
      ["host", { host: "evil.example" }],
      ["forwarded host", { host: "evil.example", "x-forwarded-host": `127.0.0.1:${value.server.port}` }],
    ] as const) {
      const rejected = await rpc(value, "ping", undefined, requestHeaders);
      expect(rejected.status, name).toBe(403);
      expect(rejected.headers.get("www-authenticate"), name).toBeNull();
      expect(await rejected.json(), name).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "MCP request rejected." },
        id: null,
      });
    }
  });

  test("validates the exact browser preflight without authenticating OPTIONS", async () => {
    const value = fixture({ mcpHttp: { allowedOrigins: ["https://agent.example"] } });
    const preflight = (method: string, requestedHeaders: string) =>
      fetch(`${value.base}${securityMcp.path}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://agent.example",
          "access-control-request-method": method,
          "access-control-request-headers": requestedHeaders,
        },
      });

    const accepted = await preflight(
      "POST",
      "authorization, content-type, mcp-protocol-version",
    );
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(accepted.headers.get("access-control-allow-headers"))
      .toBe("authorization, content-type, mcp-protocol-version");
    expect(accepted.headers.get("access-control-allow-origin"))
      .toBe("https://agent.example");

    for (const [method, requestedHeaders] of [
      ["GET", "content-type"],
      ["POST", "authorization"],
      ["POST", "content-type, x-secret"],
      ["POST", "content-type, content-type"],
    ]) {
      expect((await preflight(method!, requestedHeaders!)).status).toBe(403);
    }
  });

  test("requires an explicit trusted HTTPS proxy posture only when MCP is exported", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-deployment-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    const runtime = new Runtime({ engine, registry: new Registry(modules), telemetry: false });
    expect(() => serve({ runtime, port: 0, hostname: "0.0.0.0" })).toThrow(
      'mcpHttp.transport "trusted-https-proxy"',
    );

    const server = serve({
      runtime,
      port: 0,
      hostname: "0.0.0.0",
      mcpHttp: {
        transport: "trusted-https-proxy",
        allowedHosts: ["mcp.example.test"],
        allowedOrigins: ["https://app.example.test"],
      },
    });
    const value = {
      directory,
      engine,
      runtime,
      server,
      base: `http://127.0.0.1:${server.port}`,
    };
    cleanups.push(async () => {
      await server.drain().catch(() => {});
      await runtime.drain().catch(() => {});
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    });

    expect((await rpc(value, "ping", undefined, { host: "mcp.example.test" })).status).toBe(200);
    expect((await rpc(value, "ping", undefined, {
      host: "wrong.example.test",
      forwarded: "host=mcp.example.test;proto=https",
      "x-forwarded-host": "mcp.example.test",
      "x-forwarded-proto": "https",
    })).status).toBe(403);

    const noMcpDirectory = mkdtempSync(join(tmpdir(), "ackerdb-no-mcp-deployment-"));
    const noMcpEngine = new Engine(schema, join(noMcpDirectory, "data.db"));
    reconcile(noMcpEngine);
    const noMcpRuntime = new Runtime({
      engine: noMcpEngine,
      registry: new Registry({}),
      telemetry: false,
    });
    const noMcpServer = serve({ runtime: noMcpRuntime, port: 0, hostname: "0.0.0.0" });
    cleanups.push(async () => {
      await noMcpServer.drain().catch(() => {});
      await noMcpRuntime.drain().catch(() => {});
      noMcpEngine.close("clean");
      rmSync(noMcpDirectory, { recursive: true, force: true });
    });
  });

  test("fails malformed policy and oversized headers without reflecting their values", async () => {
    for (const mcpHttp of [
      { allowedHosts: ["https://example.test"] },
      { allowedHosts: ["EXAMPLE.test", "example.test"] },
      { allowedOrigins: ["http://remote.example"] },
      { allowedOrigins: ["https://app.example/path"] },
      { transport: "plaintext" },
      { unknown: true },
    ]) {
      expect(() => new AckerDBServer({
        limits: PRODUCTION_LIMITS,
        port: 0,
        mcpHttp: mcpHttp as never,
      })).toThrow();
    }

    const limits = {
      ...PRODUCTION_LIMITS,
      mcp: { ...PRODUCTION_LIMITS.mcp, maxHeaderBytes: 256 },
    };
    const value = fixture({ limits });
    const canary = "private-oversized-header-canary";
    const rejected = await rpc(value, "ping", undefined, {
      "x-padding": `${canary}:${"x".repeat(512)}`,
    });
    expect(rejected.status).toBe(431);
    expect(await rejected.text()).not.toContain(canary);
  });

  test("bounds registered tools and every attacker-controlled telemetry dimension", async () => {
    const emptyReturns = v.object({});
    const one = query({
      description: "First.",
      access: "public",
      args: {},
      returns: emptyReturns,
      handler: () => ({}),
    });
    const two = query({
      description: "Second.",
      access: "public",
      args: {},
      returns: emptyReturns,
      handler: () => ({}),
    });
    const limitedMcp = mcp({
      name: "limited",
      path: "/limited",
      tools: { one: { fn: one }, two: { fn: two } },
    });
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-tool-limit-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    expect(() => new Runtime({
      engine,
      registry: new Registry({ limited: { limitedMcp, one, two } }),
      limits: {
        ...PRODUCTION_LIMITS,
        mcp: { ...PRODUCTION_LIMITS.mcp, maxToolsPerEndpoint: 1 },
      },
      telemetry: false,
    })).toThrow("mcp.maxToolsPerEndpoint");
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });

    const longTitle = query({
      title: "x".repeat(257),
      description: "Too long.",
      access: "public",
      args: {},
      returns: emptyReturns,
      handler: () => ({}),
    });
    const longDescription = query({
      description: "x".repeat(4 * 1_024 + 1),
      access: "public",
      args: {},
      returns: emptyReturns,
      handler: () => ({}),
    });
    expect(() => mcp({
      name: "invalid_name",
      path: "/invalid-name",
      tools: { [`a${"b".repeat(63)}`]: { fn: one } },
    })).toThrow("at most 63 UTF-8 bytes");
    expect(() => mcp({
      name: "invalid_title",
      path: "/invalid-title",
      tools: { long_title: { fn: longTitle } },
    })).toThrow("title exceeds 256 UTF-8 bytes");
    expect(() => mcp({
      name: "invalid_description",
      path: "/invalid-description",
      tools: { long_description: { fn: longDescription } },
    })).toThrow("description exceeds 4096 UTF-8 bytes");
  });

  test("admits concurrent POSTs independently and never treats an MCP session header as identity", async () => {
    const limits = {
      ...PRODUCTION_LIMITS,
      maxOperations: 1,
      maxOperationsPerCaller: 1,
      maxOperationsPerConnection: 1,
    };
    const value = fixture({ limits });
    const controller = new AbortController();
    const stalled = fetch(`${value.base}${securityMcp.path}`, {
      method: "POST",
      headers: headers(),
      body: new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("{"));
        },
      }),
      signal: controller.signal,
    }).catch(() => undefined);
    await eventually(() => value.server.status().httpIngress === 1);

    const excess = await rpc(value, "ping");
    expect(excess.status).toBe(503);
    expect(await excess.json()).toMatchObject({ error: { message: "HTTP source capacity is full" } });
    controller.abort();
    await stalled;
    await eventually(() => value.server.status().httpIngress === 0);

    for (const credential of [undefined, PROVIDER_CREDENTIAL_CANARY]) {
      const response = await rpc(value, "tools/call", {
        name: "protected_tool",
        arguments: {},
      }, {
        "mcp-session-id": "attacker-selected-session",
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect(await response.text()).not.toContain(PROVIDER_CREDENTIAL_CANARY);
    }
  });

  test("keeps bearer credentials, arguments, results, and errors out of logs and telemetry", async () => {
    const exported: TelemetryRecord[] = [];
    const localLines: string[] = [];
    const value = fixture({
      telemetry: {
        enabled: true,
        exporter: { export: (batch) => void exported.push(...batch) },
        localSink: (line) => void localLines.push(line),
        limits: {
          ...PRODUCTION_LIMITS.telemetry,
          maxMetricSeries: 16,
          slowOperationMs: 0,
          sampleIntervalMs: 60_000,
          batchIntervalMs: 60_000,
        },
      },
    });

    const success = await rpc(value, "tools/call", {
      name: "echo_secret",
      arguments: { secret: ARGUMENT_CANARY, crash: false },
    });
    expect(await success.text()).toContain(RESULT_CANARY);
    const failure = await rpc(value, "tools/call", {
      name: "echo_secret",
      arguments: { secret: ARGUMENT_CANARY, crash: true },
    });
    expect(await failure.text()).not.toContain(HANDLER_ERROR_CANARY);
    const invalidToken = await rpc(value, "ping", undefined, {
      authorization: `Bearer ${TOKEN_CANARY}`,
    });
    expect(invalidToken.status).toBe(401);
    expect(await invalidToken.text()).not.toContain(TOKEN_CANARY);
    const providerToken = await rpc(value, "ping", undefined, {
      authorization: `Bearer ${PROVIDER_CREDENTIAL_CANARY}`,
    });
    expect(providerToken.status).toBe(401);
    expect(await providerToken.text()).not.toContain(PROVIDER_CREDENTIAL_CANARY);

    await value.runtime.telemetry.flush();
    await eventually(() => localLines.length > 0);
    const observed = JSON.stringify({
      exported,
      localLines,
      aggregates: value.runtime.status().telemetryAggregates,
      snapshot: value.runtime.status().telemetry,
    });
    for (const secret of [
      TOKEN_CANARY,
      PROVIDER_CREDENTIAL_CANARY,
      ARGUMENT_CANARY,
      RESULT_CANARY,
      HANDLER_ERROR_CANARY,
    ]) {
      expect(observed).not.toContain(secret);
    }
    expect(observed).toContain("security:echo_secret");
    expect(value.runtime.status().telemetry.metricSeries).toBeLessThanOrEqual(16);
  });
});
