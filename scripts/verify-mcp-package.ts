import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGES, pkgJsonPath, syncedVersion } from "./lib.ts";

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly exports?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

async function command(
  args: string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed in ${cwd} (exit ${exitCode})\n${stdout}${stderr}`,
    );
  }
  return stdout.trim();
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

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
  const root = resolve(import.meta.dir, "..");
  const version = syncedVersion((pkg) => readFileSync(join(root, pkgJsonPath(pkg)), "utf8"));
  const bunTypesVersion = readManifest(join(root, "node_modules/@types/bun/package.json")).version;
  if (bunTypesVersion === undefined) throw new Error("root @types/bun version is unavailable");
  const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-package-"));
  const packDir = join(directory, "packs");
  const consumerDir = join(directory, "consumer");
  mkdirSync(packDir);
  mkdirSync(join(consumerDir, "functions"), { recursive: true });

  try {
    const dependencies: Record<string, string> = {};
    for (const pkg of PACKAGES) {
      const output = await command([
        process.execPath,
        "pm",
        "pack",
        "--destination",
        packDir,
        "--ignore-scripts",
        "--quiet",
      ], join(root, "packages", pkg));
      const tarball = output.split("\n").at(-1)?.trim();
      if (tarball === undefined || tarball === "") {
        throw new Error(`bun pm pack did not report a tarball for @dbzz/${pkg}`);
      }
      dependencies[`@dbzz/${pkg}`] = `file:${tarball}`;
    }

    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
      name: "dbzz-mcp-packed-consumer",
      private: true,
      type: "module",
      dependencies,
      devDependencies: { "@types/bun": bunTypesVersion },
      // The release is intentionally unpublished: force transitive @dbzz exact
      // versions to the same five tarballs while preserving their packed
      // manifests for the assertions below.
      overrides: dependencies,
    }, null, 2));
    await command([
      process.execPath,
      "install",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
    ], consumerDir);

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

    await command([
      process.execPath,
      join(consumerDir, "node_modules/@dbzz/cli/src/main.ts"),
      "codegen",
      consumerDir,
    ], consumerDir, {
      ...process.env,
      DBZZ_DURABILITY: "balanced",
      DBZZ_TELEMETRY: "disabled",
    });
    await command([process.execPath, "verify-runtime.ts"], consumerDir);
    await command([
      process.execPath,
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      join(consumerDir, "tsconfig.json"),
    ], consumerDir);

    console.log(
      `Packed MCP gate passed: five @dbzz packages at ${version}, generated types, Bun runtime, SDK 1.29.0, and no server AI production dependency.`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
