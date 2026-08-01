import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { Registry } from "@ackerdb/server";
import { importFunctionModules, loadConfig, runCodegen } from "@ackerdb/cli";
import { FIXTURE_ADMIN_USERS, FIXTURE_APP, FIXTURE_MESSAGES, makeFixture } from "../support/fixture.ts";

const REPO = new URL("../../../..", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fixture = () => {
  const dir = makeFixture({
    "app.ts": FIXTURE_APP,
    "functions/messages.ts": FIXTURE_MESSAGES,
    "functions/admin/users.ts": FIXTURE_ADMIN_USERS,
  });
  dirs.push(dir);
  return dir;
};

function typecheckFixture(dir: string): string {
  const configPath = join(dir, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ESNext"],
        types: ["bun"],
        typeRoots: [join(REPO, "node_modules", "@types")],
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ["./**/*.ts"],
    }),
  );
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.formatDiagnostics(
    [
      ...(config.error === undefined ? [] : [config.error]),
      ...parsed.errors,
      ...ts.getPreEmitDiagnostics(program),
    ],
    {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => dir,
      getNewLine: () => "\n",
    },
  );
}

describe("codegen", () => {
  test("bootstraps a fresh project in one pass and is deterministic", async () => {
    const dir = fixture();
    const config = loadConfig(dir);
    // fresh project: functions import ../_generated/server.ts which does not
    // exist yet — the single pass must still succeed
    const first = await runCodegen(config);
    expect(first.written.sort()).toEqual(["api.ts", "server.ts", "types.ts"]);
    const bytes = ["api.ts", "server.ts", "types.ts"].map((f) =>
      readFileSync(join(config.generatedDir, f), "utf8"),
    );
    const server = bytes[1]!;
    expect(server).toContain("AppPluginCapabilities,");
    expect(server).toContain(
      'type QueryPlugins = AppPluginCapabilities<typeof app, "query">;',
    );
    expect(server).toContain(
      'type MutationPlugins = AppPluginCapabilities<typeof app, "mutation">;',
    );
    expect(server).toContain(
      'type ProcedurePlugins = AppPluginCapabilities<typeof app, "procedure">;',
    );
    expect(server).toContain("QueryBuilder<Schema, QueryPlugins>");
    expect(server).toContain("MutationBuilder<Schema, MutationPlugins>");
    expect(server).toContain(
      "ProcedureBuilder<Schema, ProcedurePlugins, MutationPlugins>",
    );
    expect(server).toContain(
      "unknown as RealtimeBuilder<Schema, ProcedurePlugins, MutationPlugins>",
    );
    expect(server).toContain("SseBuilder<Schema, ProcedurePlugins, MutationPlugins>");
    expect(server).toContain("GenericQueryCtx<Schema, QueryPlugins>");
    expect(server).toContain("GenericMutationCtx<Schema, MutationPlugins>");
    expect(server).toContain(
      "GenericProcedureCtx<Schema, ProcedurePlugins, MutationPlugins>",
    );
    expect(server).toContain(
      "GenericSseCtx<Schema, ProcedurePlugins, MutationPlugins>",
    );
    expect(server).toContain("GenericMcpToolCtx<Schema>");
    expect(server).not.toContain("GenericMcpToolCtx<Schema, ");
    // second run: identical output, nothing rewritten
    const second = await runCodegen(config);
    expect(second.written).toEqual([]);
    expect(
      ["api.ts", "server.ts", "types.ts"].map((f) =>
        readFileSync(join(config.generatedDir, f), "utf8"),
      ),
    ).toEqual(bytes);
  });

  test("binds programmatic system work to the exact generated application context", async () => {
    const dir = fixture();
    const config = loadConfig(dir);
    await runCodegen(config);
    writeFileSync(join(dir, "host.ts"), `
import { loadConfig, startApp } from "@ackerdb/cli";
import app from "./app.ts";

const acker = await startApp(loadConfig("."), { app });
await acker.system.run("fixture.typed", async (ctx) => {
  const principal: "system" = ctx.auth.kind;
  const inserted = await ctx.tx((tx) => {
    const transactionPrincipal: "system" = tx.auth.kind;
    return tx.db.messages.insert({
      channelId: 1n,
      body: transactionPrincipal,
      role: "admin",
      payload: { tag: "nothing", value: null },
    });
  });
  // @ts-expect-error SystemCtx is bound to this application's tables.
  await ctx.tx((tx) => tx.db.unknown.insert({}));
  return inserted;
});
`);

    expect(readFileSync(join(config.generatedDir, "server.ts"), "utf8")).toContain(
      "export type SystemCtx",
    );
    expect(typecheckFixture(dir)).toBe("");
  });

  test("generated addresses line up with the runtime registry", async () => {
    const dir = fixture();
    const config = loadConfig(dir);
    await runCodegen(config);
    const modules = await importFunctionModules(config);
    const registry = new Registry(modules);
    expect([...registry.functions.keys()].sort()).toEqual([
      "admin.users.count",
      "messages.list",
      "messages.runJob",
      "messages.send",
      "messages.tail",
    ]);
    // the api object produces exactly these addresses
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    expect(api).toContain("messages: typeof m_messages;");
    expect(api).toContain("admin: {");
    expect(api).toContain("users: typeof m_admin_users;");
    expect(api).toContain(
      'typingEvents: EventRef<import("./types.ts").TypingEventArgs, import("./types.ts").TypingEvent>;',
    );
  });

  test("binds MCP declarations to the schema while keeping them server-only", async () => {
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "functions/agent.ts": `
import { v } from "@ackerdb/server";
import { createMcp, mcpTool } from "../_generated/server.ts";

export const echo = mcpTool({
  description: "Echo text.",
  args: { text: v.string() },
  handler: (_ctx, args) => ({ content: [{ type: "text", text: args.text }] }),
});
export const agentMcp = createMcp({
  name: "agent",
  tools: { echo_text: echo },
});
`,
    });
    dirs.push(dir);
    const config = loadConfig(dir);
    await runCodegen(config);

    const generatedServer = readFileSync(join(config.generatedDir, "server.ts"), "utf8");
    expect(generatedServer).toContain('import type app from "../app.ts";');
    expect(generatedServer).toContain("export type Schema = AppSchema<typeof app>;");
    expect(generatedServer).toContain("createMcp as createMcpGeneric");
    expect(generatedServer).toContain("mcpTool as mcpToolGeneric");
    expect(generatedServer).toContain("export const createMcp = createMcpGeneric as McpBuilder<Schema>;");
    expect(generatedServer).toContain("export const mcpTool = mcpToolGeneric as McpToolBuilder<Schema>;");

    const registry = new Registry(await importFunctionModules(config));
    expect([...registry.functions.keys()]).toEqual([]);
    expect([...registry.serverOnly.keys()]).toEqual([
      "agent.agentMcp",
      "agent.echo",
    ]);
  });

  test("derives exact local Plugin capabilities without exposing them remotely or to MCP", async () => {
    const dir = makeFixture({
      "app.ts": `
import { defineApp, definePlugin, defineSchema, v } from "@ackerdb/server";

const cachePlugin = definePlugin({
  id: "@fixture/cache",
  schema: defineSchema({}),
  create: ({ query, mutation, procedure }) => ({
    exports: {
      get: query({
        args: { key: v.string() },
        returns: v.string().optional(),
        expose: (call) => (key: string) => call({ key }),
        handler: () => undefined,
      }),
      set: mutation({
        args: { key: v.string(), value: v.string() },
        returns: v.boolean(),
        expose: (call) => (key: string, value: string) => call({ key, value }),
        handler: () => true,
      }),
      flush: procedure({
        args: {},
        returns: v.boolean(),
        expose: (call) => () => call({}),
        handler: () => true,
      }),
    },
  }),
});

const workerPlugin = definePlugin({
  id: "@fixture/worker",
  schema: defineSchema({}),
  create: ({ procedure }) => ({
    exports: {
      run: procedure({
        args: {},
        returns: v.boolean(),
        expose: (call) => () => call({}),
        handler: () => true,
      }),
    },
  }),
});

const writerPlugin = definePlugin({
  id: "@fixture/writer",
  schema: defineSchema({}),
  create: ({ mutation }) => ({
    exports: {
      bump: mutation({
        args: {},
        returns: v.boolean(),
        expose: (call) => () => call({}),
        handler: () => true,
      }),
    },
  }),
});

export default defineApp({
  schema: defineSchema({}),
  plugins: {
    cache: cachePlugin(),
    worker: workerPlugin(),
    writer: writerPlugin(),
  },
});
`,
      "functions/surface.ts": `
import { v } from "@ackerdb/server";
import {
  mcpTool,
  mutation,
  procedure,
  query,
  sseProcedure,
  type MutationCtx,
  type ProcedureCtx,
  type QueryCtx,
  type SseCtx,
  type SystemCtx,
} from "../_generated/server.ts";

const checkQuery = (ctx: QueryCtx) => {
  const get: Promise<string | undefined> = ctx.cache.get("key");
  // @ts-expect-error mutations are absent from query contexts
  ctx.cache.set;
  // @ts-expect-error procedure-only mounts are omitted from query contexts
  ctx.worker;
  // @ts-expect-error mutation-only mounts are omitted from query contexts
  ctx.writer;
  // @ts-expect-error Plugins are mounted directly, never behind ctx.plugins
  ctx.plugins;
  return get;
};

const checkMutation = async (ctx: MutationCtx) => {
  await ctx.cache.get("key");
  await ctx.cache.set("key", "value");
  await ctx.writer.bump();
  // @ts-expect-error procedures are absent from mutation contexts
  ctx.cache.flush;
  // @ts-expect-error procedure-only mounts are omitted from mutation contexts
  ctx.worker;
};

const checkProcedure = async (ctx: ProcedureCtx) => {
  await ctx.cache.get("key");
  await ctx.cache.set("key", "value");
  await ctx.cache.flush();
  await ctx.worker.run();
  await ctx.writer.bump();
  await ctx.tx(async (tx) => {
    await tx.cache.get("key");
    await tx.cache.set("key", "value");
    await tx.writer.bump();
    // @ts-expect-error procedure operations are absent from explicit tx
    tx.cache.flush;
    // @ts-expect-error procedure-only mounts are omitted from explicit tx
    tx.worker;
  });
};

const checkSse = async (ctx: SseCtx) => {
  await ctx.cache.flush();
  await ctx.worker.run();
  await ctx.writer.bump();
  await ctx.tx(async (tx) => {
    await tx.cache.set("key", "value");
    await tx.writer.bump();
    // @ts-expect-error procedure-only mounts are omitted from explicit tx
    tx.worker;
  });
};

const checkSystem = async (ctx: SystemCtx) => {
  const principal: "system" = ctx.auth.kind;
  await ctx.cache.get("key");
  await ctx.cache.set("key", "value");
  await ctx.cache.flush();
  await ctx.worker.run();
  await ctx.writer.bump();
  await ctx.tx(async (tx) => {
    const transactionPrincipal: "system" = tx.auth.kind;
    await tx.cache.get(principal);
    await tx.cache.set(transactionPrincipal, "value");
    await tx.writer.bump();
    // @ts-expect-error procedure operations are absent from explicit tx
    tx.cache.flush;
    // @ts-expect-error procedure-only mounts are omitted from explicit tx
    tx.worker;
  });
};

void checkSystem;

export const read = query({
  access: "public",
  args: {},
  handler: (ctx) => checkQuery(ctx),
});

export const write = mutation({
  access: "public",
  args: {},
  handler: (ctx) => checkMutation(ctx),
});

export const run = procedure({
  access: "public",
  args: {},
  handler: (ctx) => checkProcedure(ctx),
});

export const stream = sseProcedure({
  access: "public",
  args: {},
  yields: v.string(),
  handler: async function* (ctx) {
    await checkSse(ctx);
    yield "done";
  },
});

export const echo = mcpTool({
  description: "Echo.",
  args: {},
  handler: (ctx) => {
    // @ts-expect-error MCP tools never receive Plugin mounts
    ctx.cache;
    return { content: [{ type: "text" as const, text: "ok" }] };
  },
});
`,
      "client.ts": `
import { api } from "./_generated/api.ts";
void api.surface.read;
void api.surface.write;
void api.surface.run;
void api.surface.stream;
// @ts-expect-error Plugin mounts are not remotely addressable
api.cache;
// @ts-expect-error MCP tools remain server-only
api.surface.echo;
`,
    });
    dirs.push(dir);
    const config = loadConfig(dir);

    await runCodegen(config);

    expect(typecheckFixture(dir)).toBe("");
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    expect(api).not.toContain("AppPluginCapabilities");
    expect(api).not.toContain("cache:");
    expect(api).not.toContain("worker:");
    expect(api).not.toContain("writer:");
  });

  test("types.ts carries enum namespaces, union constructors and row types", async () => {
    const dir = fixture();
    const config = loadConfig(dir);
    await runCodegen(config);
    const types = readFileSync(join(config.generatedDir, "types.ts"), "utf8");
    expect(types).toContain('import type app from "../app.ts";');
    expect(types).toContain("type Schema = AppSchema<typeof app>;");
    expect(types).toContain('export type Role = "admin" | "member";');
    expect(types).toContain("export const Role = {");
    expect(types).toContain(
      '  text: (value: string): { tag: "text"; value: string } => ({ tag: "text", value }),',
    );
    expect(types).toContain(
      '  nothing: (): { tag: "nothing"; value: null } => ({ tag: "nothing", value: null }),',
    );
    expect(types).toContain('export type Message = RowOf<Schema, "messages">;');
    expect(types).toContain('export type TypingEvent = RowOf<Schema, "typingEvents">;');
    expect(types).toContain(
      'export type TypingEventArgs = EventArgsOf<Schema, "typingEvents">;',
    );
    expect(types).toContain("export type { Identity };");
    // no runtime import of @ackerdb/server anywhere in client-facing files
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    for (const file of [types, api]) {
      for (const line of file.split("\n")) {
        if (line.startsWith("import ") && !line.startsWith("import type")) {
          expect(line).toContain("@ackerdb/core");
        }
      }
    }
  });

  test("does not import the configured credential verifier", async () => {
    const dir = fixture();
    const marker = join(dir, "verifier-imported");
    const verifierPath = join(dir, "credential-verifier.ts");
    writeFileSync(
      verifierPath,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export default {};
`,
    );
    writeFileSync(
      join(dir, ".ackerdb.config.json"),
      JSON.stringify({ credentialVerifier: "./credential-verifier.ts" }),
    );

    await runCodegen(loadConfig(dir));
    expect(existsSync(marker)).toBe(false);
  });

  test("loads the configured manifest without executing discovered function modules", async () => {
    const dir = makeFixture({
      "backend.ts": FIXTURE_APP,
      "functions/sideEffect.ts": `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("../../function-imported", import.meta.url), "imported");
`,
      ".ackerdb.config.json": JSON.stringify({ app: "./backend.ts" }),
    });
    dirs.push(dir);

    const config = loadConfig(dir);
    await runCodegen(config);

    expect(existsSync(join(dir, "function-imported"))).toBe(false);
    expect(readFileSync(join(config.generatedDir, "server.ts"), "utf8")).toContain(
      'import type app from "../backend.ts";',
    );
  });
});
