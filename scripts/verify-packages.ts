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
        throw new Error(`packed @ackerdb/server has production AI dependency ${field}.${dependency}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const packed = await createPackedConsumer("ackerdb-packed-consumer");
  const { consumerDir, root, version } = packed;
  mkdirSync(join(consumerDir, "functions"), { recursive: true });

  try {
    for (const pkg of PACKAGES) {
      const manifest = readManifest(
        join(consumerDir, "node_modules", "@ackerdb", pkg, "package.json"),
      );
      if (manifest.name !== `@ackerdb/${pkg}` || manifest.version !== version) {
        throw new Error(
          `packed @ackerdb/${pkg} resolved as ${String(manifest.name)}@${String(manifest.version)}, expected ${version}`,
        );
      }
      for (const field of ["dependencies", "peerDependencies"] as const) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (name.startsWith("@ackerdb/") && specifier !== version) {
            throw new Error(
              `packed @ackerdb/${pkg} ${field}.${name} is ${specifier}, expected exact ${version}`,
            );
          }
        }
      }
    }

    const serverManifest = readManifest(
      join(consumerDir, "node_modules/@ackerdb/server/package.json"),
    );
    if (serverManifest.exports?.["./mcp"] !== "./src/mcp/index.ts") {
      throw new Error("packed @ackerdb/server does not expose ./mcp from ./src/mcp/index.ts");
    }
    if (serverManifest.dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0") {
      throw new Error("packed @ackerdb/server must pin @modelcontextprotocol/sdk exactly to 1.29.0");
    }
    if (serverManifest.dependencies?.numkong !== "7.7.1") {
      throw new Error("packed @ackerdb/server must pin NumKong exactly to 7.7.1");
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

    const cacheManifest = readManifest(
      join(consumerDir, "node_modules/@ackerdb/cache/package.json"),
    );
    for (const [subpath, target] of Object.entries({
      ".": "./src/index.ts",
      "./redis": "./src/adapters/redis.ts",
      "./upstash": "./src/adapters/upstash.ts",
    })) {
      if (cacheManifest.exports?.[subpath] !== target) {
        throw new Error(`packed @ackerdb/cache does not expose ${subpath} from ${target}`);
      }
    }

    writeFileSync(join(consumerDir, "app.ts"), `
import { v, defineApp, defineSchema, defineTable } from "@ackerdb/server";

const schema = defineSchema({
  orders: defineTable({
    id: v.primaryKey(),
    description: v.string(),
    embedding: v.vector(3).nullable(),
  }),
});

export default defineApp({ schema });
`);
    writeFileSync(join(consumerDir, "functions", "orders.ts"), `
import { v } from "@ackerdb/server";
import { createMcp, mcpTool, type McpToolCtx } from "../_generated/server.ts";

export const getOrder = mcpTool({
  description: "Get an order by ID.",
  args: { id: v.bigint() },
  output: v.object({ id: v.bigint() }),
  access: { anyOf: ["orders.all", "orders.get"] },
  handler: (ctx, args) => {
    const typedContext: McpToolCtx = ctx;
    void typedContext;
    return { id: args.id };
  },
});

export const agentMcp = createMcp({
  name: "agent",
  scopes: ["orders.all", "orders.get"] as const,
  tools: { orders_get: getOrder },
});

type AgentScope = NonNullable<typeof agentMcp.scopes._type>;
const scope: AgentScope = "orders.get";
void scope;
// @ts-expect-error generated MCP scopes remain the exact declared union
const invalidScope: AgentScope = "orders.delete";
void invalidScope;
`);
    writeFileSync(join(consumerDir, "verify-runtime.ts"), `
import {
  createMcp as createMcpFromRoot,
  defineSchema,
  defineTable,
  type DbWriter,
  Engine,
  makeDbWriter,
  mcpTool as mcpToolFromRoot,
  newWriteCollector,
  v,
} from "@ackerdb/server";
import {
  createMcp as createMcpFromSubpath,
  mcpTool as mcpToolFromSubpath,
} from "@ackerdb/server/mcp";
import { cachePlugin, defineCacheStore } from "@ackerdb/cache";
import { redisCacheStore } from "@ackerdb/cache/redis";
import { upstashCacheStore } from "@ackerdb/cache/upstash";

if (createMcpFromRoot !== createMcpFromSubpath) {
  throw new Error("@ackerdb/server/mcp resolves a different createMcp implementation");
}
if (mcpToolFromRoot !== mcpToolFromSubpath) {
  throw new Error("@ackerdb/server/mcp resolves a different mcpTool implementation");
}
const endpoint = createMcpFromSubpath({
  name: "package_probe",
  tools: {
    package_probe: mcpToolFromSubpath({
      description: "Verify packed MCP blueprint assembly.",
      args: {},
      handler: () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
  },
});
if (endpoint.path !== "/mcp") throw new Error("packed MCP runtime returned the wrong path");

let customStoreOpens = 0;
const customStore = defineCacheStore({
  keyPrefix: "packed-custom",
  open() {
    customStoreOpens++;
    throw new Error("packed import verification must not open Cache stores");
  },
});
let upstashRequests = 0;
const redisStore = redisCacheStore({
  url: "redis://127.0.0.1:1",
  keyPrefix: "packed-redis",
});
const upstashStore = upstashCacheStore({
  url: "https://packed.example.com",
  token: "packed-token",
  keyPrefix: "packed-upstash",
  fetch: async () => {
    upstashRequests++;
    throw new Error("packed import verification must not issue Cache requests");
  },
});
const cacheInstances = [
  cachePlugin(),
  cachePlugin({ store: customStore }),
  cachePlugin({ store: redisStore }),
  cachePlugin({ store: upstashStore }),
];
const cacheDefinitionIds = cacheInstances.map((plugin) => plugin.definitionId);
if (JSON.stringify(cacheDefinitionIds) !== JSON.stringify([
  "@ackerdb/cache",
  "@ackerdb/cache-external",
  "@ackerdb/cache-external",
  "@ackerdb/cache-external",
])) {
  throw new Error("packed @ackerdb/cache root export returned the wrong Plugin definition");
}
if (customStoreOpens !== 0 || upstashRequests !== 0) {
  throw new Error("packed Cache imports or construction performed external work");
}

const vectorSchema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    accountId: v.bigint(),
    embedding: v.vector(2),
  }).index(["accountId"]),
});
const engine = new Engine(vectorSchema, ":memory:");
try {
  engine.createAll();
  const db = makeDbWriter(
    engine,
    newWriteCollector(),
    () => 1n,
  ) as DbWriter<typeof vectorSchema>;
  await db.documents.insert({ accountId: 1n, embedding: [1, 0] });
  const match = await db.documents
    .nearest("embedding", [1, 0], { metric: "cosine" })
    .where((row) => row.accountId.eq(1n))
    .first();
  if (match?.row.accountId !== 1n || match.distance !== 0) {
    throw new Error("packed NumKong exact-nearest runtime returned the wrong result");
  }
} finally {
  engine.close("clean");
}
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
      include: ["app.ts", "functions/**/*.ts", "_generated/**/*.ts", "verify-runtime.ts"],
    }, null, 2));

    await runCommand([
      process.execPath,
      join(consumerDir, "node_modules/@ackerdb/cli/src/commands/main.ts"),
      "codegen",
      consumerDir,
    ], consumerDir, {
      ...process.env,
      ACKERDB_DURABILITY: "balanced",
      ACKERDB_TELEMETRY: "disabled",
    });
    await runCommand([process.execPath, "verify-runtime.ts"], consumerDir);
    await runCommand([
      process.execPath,
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      join(consumerDir, "tsconfig.json"),
    ], consumerDir);

    console.log(
      `Packed package gate passed: ${PACKAGES.length} @ackerdb packages at ${version}, Cache root/adapter exports, generated MCP types, Bun runtime, SDK 1.29.0, native NumKong exact search, and no server AI production dependency.`,
    );
  } finally {
    packed.cleanup();
  }
}

await main();
