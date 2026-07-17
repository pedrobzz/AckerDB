import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES } from "./lib.ts";
import {
  createPackedConsumer,
  type PackageManifest,
  readManifest,
  runCommand,
} from "./packed-consumer.ts";

function assertNoProductionAiDependency(manifest: PackageManifest): void {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (dependency === "ai" || dependency.startsWith("@ai-sdk/")) {
        throw new Error(`packed @dbzz/server has production AI dependency ${field}.${dependency}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const packed = await createPackedConsumer("dbzz-mcp-packed-consumer");
  const { consumerDir, root, version } = packed;
  mkdirSync(join(consumerDir, "functions"), { recursive: true });

  try {
    for (const pkg of PACKAGES) {
      const manifest = readManifest(
        join(consumerDir, "node_modules", "@dbzz", pkg, "package.json"),
      );
      if (manifest.name !== `@dbzz/${pkg}` || manifest.version !== version) {
        throw new Error(
          `packed @dbzz/${pkg} resolved as ${String(manifest.name)}@${String(manifest.version)}, expected ${version}`,
        );
      }
      for (const field of ["dependencies", "peerDependencies"] as const) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (name.startsWith("@dbzz/") && specifier !== version) {
            throw new Error(
              `packed @dbzz/${pkg} ${field}.${name} is ${specifier}, expected exact ${version}`,
            );
          }
        }
      }
    }

    const serverManifest = readManifest(
      join(consumerDir, "node_modules/@dbzz/server/package.json"),
    );
    if (serverManifest.exports?.["./mcp"] !== "./src/mcp.ts") {
      throw new Error("packed @dbzz/server does not expose ./mcp from ./src/mcp.ts");
    }
    if (serverManifest.dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0") {
      throw new Error("packed @dbzz/server must pin @modelcontextprotocol/sdk exactly to 1.29.0");
    }
    const sdkManifest = readManifest(
      join(consumerDir, "node_modules/@modelcontextprotocol/sdk/package.json"),
    );
    if (sdkManifest.version !== "1.29.0") {
      throw new Error(
        `clean consumer resolved @modelcontextprotocol/sdk ${String(sdkManifest.version)}, expected 1.29.0`,
      );
    }
    assertNoProductionAiDependency(serverManifest);

    writeFileSync(join(consumerDir, "schema.ts"), `
import { dbz, defineSchema, defineTable } from "@dbzz/server";

export default defineSchema({
  orders: defineTable({
    id: dbz.primaryKey(),
    description: dbz.string(),
  }),
});
`);
    writeFileSync(join(consumerDir, "functions", "orders.ts"), `
import { dbz } from "@dbzz/server";
import { createMcp, type McpToolCtx } from "../_generated/server.ts";

export const agentMcp = createMcp({
  name: "agent",
  scopes: ["orders.all", "orders.get"] as const,
});

type AgentScope = NonNullable<typeof agentMcp.scopes._type>;
const scope: AgentScope = "orders.get";
void scope;
// @ts-expect-error generated MCP scopes remain the exact declared union
const invalidScope: AgentScope = "orders.delete";
void invalidScope;

export const getOrder = agentMcp.tool({
  name: "orders_get",
  description: "Get an order by ID.",
  args: { id: dbz.bigint() },
  output: dbz.object({ id: dbz.bigint() }),
  access: { anyOf: ["orders.all", "orders.get"] },
  handler: (ctx, args) => {
    const typedContext: McpToolCtx = ctx;
    void typedContext;
    return { id: args.id };
  },
});
`);
    writeFileSync(join(consumerDir, "verify-runtime.ts"), `
import { createMcp as createMcpFromRoot } from "@dbzz/server";
import { createMcp as createMcpFromSubpath } from "@dbzz/server/mcp";

if (createMcpFromRoot !== createMcpFromSubpath) {
  throw new Error("@dbzz/server/mcp resolves a different createMcp implementation");
}
const endpoint = createMcpFromSubpath({ name: "package_probe" });
if (endpoint.path !== "/mcp") throw new Error("packed MCP runtime returned the wrong path");
`);
    writeFileSync(join(consumerDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        allowImportingTsExtensions: true,
        types: ["bun"],
      },
      include: ["schema.ts", "functions/**/*.ts", "_generated/**/*.ts"],
    }, null, 2));

    await runCommand([
      process.execPath,
      join(consumerDir, "node_modules/@dbzz/cli/src/main.ts"),
      "codegen",
      consumerDir,
    ], consumerDir, {
      ...process.env,
      DBZZ_DURABILITY: "balanced",
      DBZZ_TELEMETRY: "disabled",
    });
    await runCommand([process.execPath, "verify-runtime.ts"], consumerDir);
    await runCommand([
      process.execPath,
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      join(consumerDir, "tsconfig.json"),
    ], consumerDir);

    console.log(
      `Packed MCP gate passed: five @dbzz packages at ${version}, generated types, Bun runtime, SDK 1.29.0, and no server AI production dependency.`,
    );
  } finally {
    packed.cleanup();
  }
}

await main();
