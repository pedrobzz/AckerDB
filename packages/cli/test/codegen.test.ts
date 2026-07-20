import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "@dbzz/server";
import { importFunctionModules, loadConfig, runCodegen } from "@dbzz/cli";
import { FIXTURE_ADMIN_USERS, FIXTURE_MESSAGES, FIXTURE_SCHEMA, makeFixture } from "./fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fixture = () => {
  const dir = makeFixture({
    "schema.ts": FIXTURE_SCHEMA,
    "functions/messages.ts": FIXTURE_MESSAGES,
    "functions/admin/users.ts": FIXTURE_ADMIN_USERS,
  });
  dirs.push(dir);
  return dir;
};

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
    // second run: identical output, nothing rewritten
    const second = await runCodegen(config);
    expect(second.written).toEqual([]);
    expect(
      ["api.ts", "server.ts", "types.ts"].map((f) =>
        readFileSync(join(config.generatedDir, f), "utf8"),
      ),
    ).toEqual(bytes);
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
      "schema.ts": FIXTURE_SCHEMA,
      "functions/agent.ts": `
import { v } from "@dbzz/server";
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

  test("types.ts carries enum namespaces, union constructors and row types", async () => {
    const dir = fixture();
    const config = loadConfig(dir);
    await runCodegen(config);
    const types = readFileSync(join(config.generatedDir, "types.ts"), "utf8");
    expect(types).toContain('export type Role = "admin" | "member";');
    expect(types).toContain("export const Role = {");
    expect(types).toContain(
      '  text: (value: string): { tag: "text"; value: string } => ({ tag: "text", value }),',
    );
    expect(types).toContain(
      '  nothing: (): { tag: "nothing"; value: null } => ({ tag: "nothing", value: null }),',
    );
    expect(types).toContain('export type Message = RowOf<typeof schema, "messages">;');
    expect(types).toContain('export type TypingEvent = RowOf<typeof schema, "typingEvents">;');
    expect(types).toContain(
      'export type TypingEventArgs = EventArgsOf<typeof schema, "typingEvents">;',
    );
    expect(types).toContain("export type { Identity };");
    // no runtime import of @dbzz/server anywhere in client-facing files
    const api = readFileSync(join(config.generatedDir, "api.ts"), "utf8");
    for (const file of [types, api]) {
      for (const line of file.split("\n")) {
        if (line.startsWith("import ") && !line.startsWith("import type")) {
          expect(line).toContain("@dbzz/core");
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
      join(dir, ".zdb.config.json"),
      JSON.stringify({ credentialVerifier: "./credential-verifier.ts" }),
    );

    await runCodegen(loadConfig(dir));
    expect(existsSync(marker)).toBe(false);
  });
});
