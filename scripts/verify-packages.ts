import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PACKAGES } from "./lib.ts";
import { FSL_LICENSE } from "./release/package-license.ts";
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

function assertPackagedLicenses(consumerDirectory: string): void {
  for (const pkg of PACKAGES) {
    const packageDirectory = join(
      consumerDirectory,
      "node_modules",
      "@ackerdb",
      pkg,
    );
    const manifest = readManifest(join(packageDirectory, "package.json"));
    if (manifest.license !== FSL_LICENSE) {
      throw new Error(
        `packed @ackerdb/${pkg} license is ${String(manifest.license)}, expected ${FSL_LICENSE}`,
      );
    }
    const license = readFileSync(join(packageDirectory, "LICENSE.md"), "utf8");
    if (!license.includes("Functional Source License, Version 1.1, Apache 2.0 Future License")) {
      throw new Error(`packed @ackerdb/${pkg} does not contain its declared license`);
    }
  }
}

async function main(): Promise<void> {
  const packed = await createPackedConsumer("ackerdb-packed-consumer");
  const { consumerDir, root, version } = packed;
  mkdirSync(join(consumerDir, "functions"), { recursive: true });

  try {
    assertPackagedLicenses(consumerDir);
    for (const pkg of PACKAGES) {
      const manifest = readManifest(
        join(consumerDir, "node_modules", "@ackerdb", pkg, "package.json"),
      );
      if (manifest.name !== `@ackerdb/${pkg}` || manifest.version !== version) {
        throw new Error(
          `packed @ackerdb/${pkg} resolved as ${String(manifest.name)}@${String(manifest.version)}, expected ${version}`,
        );
      }
      if (pkg === "client" || pkg === "client-react") {
        const packedPackageDirectory = join(consumerDir, "node_modules", "@ackerdb", pkg);
        const binaries = nodeFiles(packedPackageDirectory);
        if (binaries.length > 0) {
          throw new Error(`packed @ackerdb/${pkg} includes native payload: ${binaries.join(", ")}`);
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
    if (serverManifest.exports?.["./files/s3"] !== "./src/files/store/s3.ts") {
      throw new Error(
        "packed @ackerdb/server does not expose ./files/s3 from ./src/files/store/s3.ts",
      );
    }
    if (
      serverManifest.exports?.["./files/binding"] !== "./src/files/binding.ts"
    ) {
      throw new Error(
        "packed @ackerdb/server does not expose ./files/binding from ./src/files/binding.ts",
      );
    }
    if (
      serverManifest.exports?.["./database/framework-schema"] !==
        "./src/database/framework-schema.ts"
    ) {
      throw new Error(
        "packed @ackerdb/server does not expose ./database/framework-schema from its owner",
      );
    }
    const exactServerDependencies = {
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

    writeFileSync(join(consumerDir, "app.ts"), `
import { v, defineApp, defineSchema, defineTable } from "@ackerdb/server";

const schema = defineSchema({
  orders: defineTable({
    id: v.primaryKey(),
    description: v.string(),
    embedding: v.vector(3).nullable(),
  }),
});

export default defineApp({ schema, scopes: ["orders.all", "orders.get"] as const });
`);
    writeFileSync(join(consumerDir, "functions", "orders.ts"), `
import { v } from "@ackerdb/server";
import { query, type QueryCtx, type Scope } from "../_generated/server.ts";

export const getOrder = query({
  description: "Get an order by ID.",
  access: "authenticated",
  args: { id: v.bigint() },
  returns: v.object({ id: v.bigint() }),
  handler: (ctx, args) => {
    const typedContext: QueryCtx = ctx;
    void typedContext;
    return { id: args.id };
  },
});

const scope: Scope = "orders.get";
void scope;
// @ts-expect-error generated scopes remain the exact declared vocabulary union
const invalidScope: Scope = "orders.delete";
void invalidScope;
`);
    writeFileSync(join(consumerDir, "verify-runtime.ts"), `
import {
  type CreateFileUploadSessionOptions,
  type CreateFileUrlOptions,
  defineSchema,
  defineTable,
  type DbWriter,
  Engine,
  type FileGrantId,
  makeDbWriter,
  newWriteCollector,
  v,
} from "@ackerdb/server";
import * as serverRoot from "@ackerdb/server";
import { withFrameworkTables } from "@ackerdb/server/database/framework-schema";
import {
  rebindRestoredFileStore,
  recordVerifiedFileStoreTransition,
  resolveFileStoreBinding,
} from "@ackerdb/server/files/binding";
import {
  S3FileStore,
  type S3FileStoreConfig,
} from "@ackerdb/server/files/s3";

if ("S3FileStore" in serverRoot) {
  throw new Error("the root @ackerdb/server entrypoint eagerly exposes the optional S3 adapter");
}
for (const internal of [
  "withFrameworkTables",
  "rebindRestoredFileStore",
  "recordVerifiedFileStoreTransition",
  "resolveFileStoreBinding",
] as const) {
  if (internal in serverRoot) {
    throw new Error(
      "the root @ackerdb/server entrypoint exposes owner-subpath API " + internal,
    );
  }
}
if (
  typeof withFrameworkTables !== "function" ||
  typeof rebindRestoredFileStore !== "function" ||
  typeof recordVerifiedFileStoreTransition !== "function" ||
  typeof resolveFileStoreBinding !== "function"
) {
  throw new Error("@ackerdb/server owner subpaths did not resolve their functions");
}
const uploadOptions = { maxBytes: 1 } satisfies CreateFileUploadSessionOptions;
const urlOptions = { permanent: true } satisfies CreateFileUrlOptions;
const grantId = 1n as FileGrantId;
void [uploadOptions, urlOptions, grantId];
const s3Config = {
  region: "us-east-1",
  bucket: "packed-export-probe",
} satisfies S3FileStoreConfig;
if (!(new S3FileStore(s3Config) instanceof S3FileStore)) {
  throw new Error("@ackerdb/server/files/s3 did not construct its public S3 adapter");
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
      include: [
        "app.ts",
        "functions/**/*.ts",
        "_generated/**/*.ts",
        "verify-runtime.ts",
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
    });
    await runCommand([process.execPath, "verify-runtime.ts"], consumerDir);
    await runCommand([
      process.execPath,
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      join(consumerDir, "tsconfig.json"),
    ], consumerDir);

    console.log(
      `Packed package gate passed: ${PACKAGES.length} public @ackerdb packages at ${version}, lazy S3 adapter exports, generated types, Bun runtime, audited transitive security floors, and native NumKong exact search, with no server AI production dependency.`,
    );
  } finally {
    packed.cleanup();
  }
}

await main();
