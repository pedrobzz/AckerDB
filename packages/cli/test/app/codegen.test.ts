import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { Registry } from "@ackerdb/server";
import { importFunctionModules, loadConfig, runCodegen } from "@ackerdb/cli";
import { applicationAddresses } from "ackerdb-test-support/framework-functions";
import { FIXTURE_ADMIN_USERS, FIXTURE_APP, FIXTURE_JOBS, FIXTURE_MESSAGES, makeFixture } from "../support/fixture.ts";

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
    "jobs/notes.ts": FIXTURE_JOBS,
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
    expect(server).toContain("QueryBuilder<Schema, QueryJobs, Scope>");
    expect(server).toContain("MutationBuilder<Schema, MutationJobs, Scope>");
    expect(server).toContain("ProcedureBuilder<Schema, ProcedureJobs, MutationJobs, Scope>");
    expect(server).toContain("SseBuilder<Schema, ProcedureJobs, MutationJobs, Scope>");
    expect(server).toContain("GenericQueryCtx<Schema, QueryJobs>");
    expect(server).toContain("GenericMutationCtx<Schema, MutationJobs>");
    expect(server).toContain("GenericProcedureCtx<Schema, ProcedureJobs, MutationJobs>");
    expect(server).toContain("GenericSseCtx<Schema, ProcedureJobs, MutationJobs>");
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
    const registry = new Registry(modules, ["internal"]);
    expect([...registry.functions.keys()].sort()).toEqual([
      // The framework's own group is registered in every application.
      "admin.credentials.list",
      "admin.credentials.rotate",
      "admin.system.info",
      "api.admin.users.count",
      "api.messages.enqueueNote",
      "api.messages.list",
      "api.messages.send",
      "api.messages.tail",
      "internal.admin.users.compact",
    ]);
    // the group is the address's first segment, and the URL is the address
    expect(registry.exposed.get("/api/messages/tail")?.address).toBe("api.messages.tail");
    expect(registry.get("internal.admin.users.compact")?.apiPath).toBe("internal");
    // `functions/admin/` is a module directory, not a group: a directory named
    // after a declared group still publishes into the group each function
    // declares.
    expect(registry.get("api.admin.users.count")?.apiPath).toBe("api");
    // the api object produces exactly these addresses
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    expect(api).toContain("messages: typeof _m_messages;");
    expect(api).toContain("admin: {");
    expect(api).toContain("users: typeof _m_admin_users;");
    expect(api).toContain(
      'typingEvents: _EventRef<import("./types.ts").TypingEventArgs, import("./types.ts").TypingEvent>;',
    );
  });

  test("emits one binding per API path the manifest declares", async () => {
    const dir = fixture();
    const config = loadConfig(dir);
    await runCodegen(config);
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    expect(api).toContain(
      "export const api = _anyApi as unknown as _ApiFromModules<_Modules> & {",
    );
    expect(api).toContain(
      'export const internal = _apiGroup("internal") as unknown as _ApiFromModules<_Modules, "internal">;',
    );
    // The framework's two groups earn a binding without the manifest naming
    // them, and `admin` takes the framework's own tree rather than selecting
    // from modules that could never hold it.
    expect(api).toContain(
      'export const admin = _adminApi as unknown as typeof _adminApi & _ApiFromModules<_Modules, "admin">;',
    );
    // An undeclared group earns none: the manifest is the only list, and code
    // generation never imports the function modules that would hold one.
    expect(api).not.toContain("export const reports =");
    // Every name the module needs for itself carries the reserved `_`, which a
    // group's name can never begin with — so `api`, `admin` and `events` are
    // the whole of what a group must not be called, and the manifest refuses
    // all three.
    for (const line of api.split("\n")) {
      const owned = /^export const ([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
      if (owned !== undefined) expect(["admin", "api", "events", "internal"]).toContain(owned);
    }
    expect(typecheckFixture(dir)).toBe("");
  });

  test("an index module publishes its directory's name beside its siblings", async () => {
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "functions/orders/index.ts": `
import { query } from "../../_generated/server.ts";

export const list = query({ access: "public", args: {}, handler: () => [] });
`,
      "functions/orders/refunds.ts": `
import { query } from "../../_generated/server.ts";

export const pending = query({ access: "public", args: {}, handler: () => [] });
`,
    });
    dirs.push(dir);
    const config = loadConfig(dir);
    await runCodegen(config);

    const registry = new Registry(await importFunctionModules(config), ["internal"]);
    expect(applicationAddresses(registry))
      .toEqual(["api.orders.list", "api.orders.refunds.pending"]);

    // `orders` is a module and a namespace at once, so the generated tree is
    // the intersection: dropping either half would leave a registered address
    // with no binding to import.
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    expect(api).toContain("orders: typeof _m_orders & {");
    expect(api).toContain("refunds: typeof _m_orders_refunds;");
    expect(typecheckFixture(dir)).toBe("");
  });

  test("binds MCP declarations to the schema while keeping them server-only", async () => {
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "functions/agent.ts": `
import { v } from "@ackerdb/server";
import { mcp, query } from "../_generated/server.ts";

export const echo = query({
  description: "Echo text.",
  access: "public",
  args: { text: v.string() },
  returns: v.object({ text: v.string() }),
  handler: (_ctx, args) => ({ text: args.text }),
});
export const agentMcp = mcp({
  name: "agent",
  tools: { echo_text: { fn: echo, access: "public" } },
});
`,
    });
    dirs.push(dir);
    const config = loadConfig(dir);
    await runCodegen(config);

    const generatedServer = readFileSync(join(config.generatedDir, "server.ts"), "utf8");
    expect(generatedServer).toContain('import type app from "../app.ts";');
    expect(generatedServer).toContain("export type Schema = AppSchema<typeof app>;");
    expect(generatedServer).toContain("mcp as mcpGeneric");
    expect(generatedServer).toContain("export type Scope = AppScope<typeof app>;");
    expect(generatedServer).toContain("export const mcp = mcpGeneric as McpBuilder<Schema, Scope>;");

    const registry = new Registry(await importFunctionModules(config), ["internal"]);
    // The tool is an ordinary function and keeps its address; the endpoint is
    // the only server-only export.
    expect(applicationAddresses(registry)).toEqual(["api.agent.echo"]);
    expect([...registry.serverOnly.keys()]).toEqual(["api.agent.agentMcp"]);
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
    expect(types).toContain("export type { FileGrantId, FileId, Identity };");
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
