import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NATIVE_PACKAGES, PUBLIC_PACKAGES } from "./lib.ts";
import {
  DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
  TARGET_EVIDENCE_FILES,
  assertTargetCycloneDx,
  assertTargetBuildManifest,
  nativeBindingSourceDigest,
  targetBinaryName,
  type TargetBuildManifest,
} from "../packages/realtime/native/webrtc/evidence.ts";
import { NATIVE_ABI, WEBRTC_TARGETS } from "../packages/realtime/native/webrtc/provenance.ts";
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

function nodeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? nodeFiles(path)
      : entry.name.endsWith(".node") ? [path] : [];
  });
}

function assertArray(
  actual: readonly string[] | undefined,
  expected: readonly string[],
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

async function assertPackagedWebRtc(
  realtimeDirectory: string,
  scopeDirectory: string,
  version: string,
  required: boolean,
): Promise<boolean> {
  const rootBinaries = nodeFiles(realtimeDirectory);
  if (rootBinaries.length > 0) {
    throw new Error(
      `packed @ackerdb/realtime contains native payload: ${rootBinaries.join(", ")}`,
    );
  }
  for (const file of [
    "native/webrtc/binding/index.cjs",
    "native/webrtc/binding/index.d.cts",
    "native/webrtc/PROVENANCE.md",
  ]) {
    if (!existsSync(join(realtimeDirectory, file))) {
      throw new Error(`packed @ackerdb/realtime is missing ${file}`);
    }
  }

  const realtimeManifest = readManifest(join(realtimeDirectory, "package.json"));
  const expectedOptional = Object.fromEntries(
    NATIVE_PACKAGES.map((pkg) => [`@ackerdb/${pkg}`, version]),
  );
  const actualOptional = Object.fromEntries(
    Object.entries(realtimeManifest.optionalDependencies ?? {})
      .filter(([name]) => name.startsWith("@ackerdb/realtime-"))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (!Bun.deepEquals(actualOptional, expectedOptional)) {
    throw new Error(
      `packed @ackerdb/realtime has the wrong native optional dependency graph: ${JSON.stringify(actualOptional)}`,
    );
  }

  const current = WEBRTC_TARGETS.find((target) =>
    target.host === `${process.platform}-${process.arch}`
  );
  if (current === undefined) {
    if (required) {
      throw new Error(
        `AckerDB has no WebRTC native package for ${process.platform}-${process.arch}`,
      );
    }
    return false;
  }

  const nativeDirectory = join(
    scopeDirectory,
    current.packageName.slice("@ackerdb/".length),
  );
  if (!existsSync(nativeDirectory)) {
    if (required) {
      throw new Error(`packed @ackerdb/realtime is missing ${current.packageName}`);
    }
    return false;
  }
  const nativeManifest = readManifest(join(nativeDirectory, "package.json"));
  const packageName = current.packageName;
  const file = targetBinaryName(current);
  if (
    nativeManifest.name !== packageName ||
    nativeManifest.version !== version ||
    nativeManifest.main !== file
  ) {
    throw new Error(`packed ${packageName} has an invalid package identity`);
  }
  const os = current.host.split("-")[0]!;
  const cpu = current.host.endsWith("arm64") ? "arm64" : "x64";
  assertArray(nativeManifest.os, [os], `${packageName} os`);
  assertArray(nativeManifest.cpu, [cpu], `${packageName} cpu`);
  if (os === "linux") {
    assertArray(nativeManifest.libc, ["glibc"], `${packageName} libc`);
  } else if (nativeManifest.libc !== undefined) {
    throw new Error(`${packageName} must not declare libc on ${os}`);
  }

  for (const evidence of [file, ...TARGET_EVIDENCE_FILES]) {
    if (!existsSync(join(nativeDirectory, evidence))) {
      if (!required && evidence === file) return false;
      throw new Error(`packed ${packageName} is missing ${evidence}`);
    }
  }

  const target = JSON.parse(
    readFileSync(join(nativeDirectory, "manifest.json"), "utf8"),
  ) as TargetBuildManifest;
  const loader = {
    cjsSha256: createHash("sha256")
      .update(readFileSync(join(realtimeDirectory, "native/webrtc/binding/index.cjs")))
      .digest("hex"),
    dtsSha256: createHash("sha256")
      .update(readFileSync(join(realtimeDirectory, "native/webrtc/binding/index.d.cts")))
      .digest("hex"),
  };
  const digest = createHash("sha256")
    .update(readFileSync(join(nativeDirectory, file)))
    .digest("hex");
  const nativeBindingSourceSha256 = await nativeBindingSourceDigest();
  try {
    assertTargetBuildManifest(target, current, version, nativeBindingSourceSha256);
  } catch {
    throw new Error(`packed ${packageName} has an invalid target manifest`);
  }
  if (!Bun.deepEquals(target.loader, loader)) {
    throw new Error(`packed ${packageName} loader evidence differs from @ackerdb/realtime`);
  }
  if (target.sha256 !== digest) throw new Error(`packed ${packageName} binary digest differs from manifest`);
  if (
    createHash("sha256")
      .update(readFileSync(join(nativeDirectory, target.upstream.license.file)))
      .digest("hex") !== target.upstream.license.sha256
  ) {
    throw new Error(`packed ${packageName} has invalid archive license evidence`);
  }
  try {
    assertTargetCycloneDx(
      JSON.parse(readFileSync(join(nativeDirectory, "sbom.cdx.json"), "utf8")),
      current,
    );
  } catch {
    throw new Error(`packed ${packageName} has invalid target-bound Cargo SBOM evidence`);
  }
  if (readFileSync(join(nativeDirectory, "THIRD_PARTY_NOTICES.txt"), "utf8").trim() === "") {
    throw new Error(`packed ${packageName} has empty Cargo notices`);
  }

  const distribution = join(realtimeDirectory, "native/webrtc/distribution");
  const aggregatePath = join(distribution, "manifest.json");
  if (!existsSync(aggregatePath)) {
    if (!required) return true;
    throw new Error("packed @ackerdb/realtime is missing aggregate evidence");
  }
  const aggregate = JSON.parse(readFileSync(aggregatePath, "utf8")) as {
    readonly schemaVersion?: number;
    readonly version?: string;
    readonly nativeAbi?: number;
    readonly nativeBindingSourceSha256?: string;
    readonly loader?: TargetBuildManifest["loader"];
    readonly targets?: readonly TargetBuildManifest[];
  };
  if (
    aggregate.schemaVersion !== DISTRIBUTION_MANIFEST_SCHEMA_VERSION ||
    aggregate.version !== version ||
    aggregate.nativeAbi !== NATIVE_ABI ||
    aggregate.nativeBindingSourceSha256 !== nativeBindingSourceSha256 ||
    !Bun.deepEquals(aggregate.loader, loader) ||
    aggregate.targets?.length !== WEBRTC_TARGETS.length
  ) {
    throw new Error("packed @ackerdb/realtime has an invalid aggregate manifest");
  }
  for (const [index, expected] of WEBRTC_TARGETS.entries()) {
    const entry = aggregate.targets[index];
    try {
      assertTargetBuildManifest(entry!, expected, version, nativeBindingSourceSha256);
      if (!Bun.deepEquals(entry!.loader, loader)) {
        throw new Error("target loader differs from aggregate loader");
      }
    } catch {
      throw new Error(
        `packed @ackerdb/realtime has an invalid aggregate target ${expected.host}`,
      );
    }
  }
  const currentAggregate = aggregate.targets.find((entry) => entry.host === current.host);
  if (currentAggregate?.sha256 !== digest) {
    throw new Error(`aggregate WebRTC digest differs for ${current.host}`);
  }
  return true;
}

function assertServerExcludesRealtimeRuntime(serverDirectory: string): void {
  const forbidden = [
    "native",
    "src/realtime/diagnostics.ts",
    "src/realtime/engine.ts",
    "src/realtime/hub.ts",
    "src/realtime/native",
    "src/realtime/network.ts",
    "src/realtime/resources.ts",
    "src/realtime/session.ts",
    "src/realtime/turn-preflight.ts",
    "src/realtime/turn.ts",
  ];
  for (const path of forbidden) {
    if (existsSync(join(serverDirectory, path))) {
      throw new Error(
        `packed @ackerdb/server includes optional realtime runtime payload: ${path}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const packed = await createPackedConsumer("ackerdb-packed-consumer");
  const { consumerDir, root, version } = packed;
  mkdirSync(join(consumerDir, "functions"), { recursive: true });

  try {
    for (const pkg of PUBLIC_PACKAGES) {
      const manifest = readManifest(
        join(consumerDir, "node_modules", "@ackerdb", pkg, "package.json"),
      );
      if (manifest.name !== `@ackerdb/${pkg}` || manifest.version !== version) {
        throw new Error(
          `packed @ackerdb/${pkg} resolved as ${String(manifest.name)}@${String(manifest.version)}, expected ${version}`,
        );
      }
      if (pkg !== "realtime") {
        for (const field of [
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
        ] as const) {
          if (manifest[field]?.["@ackerdb/realtime"] !== undefined) {
            throw new Error(
              `packed @ackerdb/${pkg} must not install optional @ackerdb/realtime through ${field}`,
            );
          }
        }
      }
      if (pkg === "client" || pkg === "client-react") {
        const packedPackageDirectory = join(consumerDir, "node_modules", "@ackerdb", pkg);
        const binaries = nodeFiles(packedPackageDirectory);
        if (binaries.length > 0) {
          throw new Error(`packed @ackerdb/${pkg} includes native payload: ${binaries.join(", ")}`);
        }
        for (const field of [
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
        ] as const) {
          for (const dependency of ["react-native-webrtc", "@livekit/react-native-webrtc"]) {
            if (manifest[field]?.[dependency] !== undefined) {
              throw new Error(`packed @ackerdb/${pkg} has native WebRTC dependency ${field}.${dependency}`);
            }
          }
        }
      }
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ] as const) {
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
    const serverDirectory = join(consumerDir, "node_modules/@ackerdb/server");
    const realtimeDirectory = join(consumerDir, "node_modules/@ackerdb/realtime");
    assertServerExcludesRealtimeRuntime(serverDirectory);
    const verifyNativeRuntime = await assertPackagedWebRtc(
      realtimeDirectory,
      join(consumerDir, "node_modules/@ackerdb"),
      version,
      process.argv.includes("--require-webrtc"),
    );
    if (serverManifest.exports?.["./mcp"] !== "./src/mcp/index.ts") {
      throw new Error("packed @ackerdb/server does not expose ./mcp from ./src/mcp/index.ts");
    }
    const exactServerDependencies = {
      "@modelcontextprotocol/sdk": "1.30.0",
      "numkong": "7.7.1",
    } as const;
    for (const [dependency, expected] of Object.entries(exactServerDependencies)) {
      if (serverManifest.dependencies?.[dependency] !== expected) {
        throw new Error(`packed @ackerdb/server must pin ${dependency} exactly to ${expected}`);
      }
      const installed = readManifest(
        join(consumerDir, "node_modules", dependency, "package.json"),
      );
      if (installed.version !== expected) {
        throw new Error(`clean consumer resolved ${dependency} ${String(installed.version)}, expected ${expected}`);
      }
    }
    const consumerLock = Bun.JSONC.parse(
      readFileSync(join(consumerDir, "bun.lock"), "utf8"),
    ) as { readonly packages: Readonly<Record<string, readonly unknown[]>> };
    for (const [dependency, expected] of Object.entries({
      "@hono/node-server": "2.0.12",
      "fast-uri": "3.1.5",
    })) {
      const prefix = `${dependency}@`;
      const resolved = new Set(Object.values(consumerLock.packages).flatMap(
        (entry) => typeof entry[0] === "string" && entry[0].startsWith(prefix)
          ? [entry[0].slice(prefix.length)]
          : [],
      ));
      if (resolved.size !== 1 || !resolved.has(expected)) {
        throw new Error(`${dependency} resolves as ${[...resolved].join(", ")}, expected only ${expected}`);
      }
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
    if (verifyNativeRuntime) {
      writeFileSync(
        join(consumerDir, "public-session-fixture.ts"),
        readFileSync(
          join(
            root,
            "packages/realtime/native/webrtc/test/public-session-fixture.ts",
          ),
          "utf8",
        ),
      );
    }
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
${verifyNativeRuntime ? `
const { createBundledRealtimeEngine } = await import(
  "./node_modules/@ackerdb/realtime/src/native/engine.ts"
);
const { verifyPublicRealtimeSession } = await import(
  "./public-session-fixture.ts"
);
await verifyPublicRealtimeSession(createBundledRealtimeEngine);
` : ""}
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
      include: [
        "app.ts",
        "functions/**/*.ts",
        "_generated/**/*.ts",
        "verify-runtime.ts",
        ...(verifyNativeRuntime ? ["public-session-fixture.ts"] : []),
      ],
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
      `Packed package gate passed: ${PUBLIC_PACKAGES.length} public @ackerdb packages plus ${NATIVE_PACKAGES.length} platform tarballs at ${version}, optional realtime payload excluded from server, Cache root/adapter exports, generated MCP types, Bun runtime, SDK 1.30.0 with audited transitive security floors, native NumKong exact search${verifyNativeRuntime ? ", and host-resolved WebRTC loading with typed events, audio, procedure, transaction, and cleanup" : ""}, with no server AI production dependency.`,
    );
  } finally {
    packed.cleanup();
  }
}

await main();
