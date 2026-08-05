import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Engine,
  LocalFileStore,
  recordVerifiedFileStoreTransition,
  reconcile,
  resolveFileStoreBinding,
  type TelemetryRecord,
} from "@ackerdb/server";
import { loadConfig } from "../../src/app/config.ts";
import { importApp } from "../../src/app/manifest.ts";
import { fileStoreIdentity } from "../../src/files/identity.ts";
import { FIXTURE_APP, makeFixture } from "../support/fixture.ts";
import { runCli } from "../support/process.ts";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(): string {
  const directory = makeFixture({ "app.ts": FIXTURE_APP });
  directories.push(directory);
  return directory;
}

async function seedFile(
  directory: string,
  objectKey: string,
  contents: string,
  options: { writeBytes?: boolean } = {},
): Promise<string> {
  const config = loadConfig(directory);
  if (config.files.backend !== "filesystem") throw new Error("fixture must use filesystem Files");
  const bytes = new TextEncoder().encode(contents);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (options.writeBytes !== false) {
    await new LocalFileStore({ root: config.files.root }).put(
      objectKey,
      new Blob([bytes]).stream(),
      { contentLength: bytes.byteLength },
    );
  }
  const app = await importApp(config);
  const engine = new Engine(app.schema, join(config.dbDir, "data.db"));
  try {
    reconcile(engine);
    resolveFileStoreBinding(engine, fileStoreIdentity(config.files));
    engine.writer.query(`INSERT INTO _ackerdb_files (
      state, objectKey, owner, size, sha256, contentType, name, createdAt, pendingExpiresAt
    ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, NULL)`).run(
      "active",
      objectKey,
      bytes.byteLength,
      sha256,
      1_700_000_000_000,
    );
  } finally {
    engine.close("clean");
  }
  return sha256;
}

function outputJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

function telemetryRecords(stdout: string, finalReport: boolean): TelemetryRecord[] {
  const lines = stdout.trim().split("\n").filter((line) => line.length > 0);
  return (finalReport ? lines.slice(0, -1) : lines)
    .map((line) => JSON.parse(line) as TelemetryRecord);
}

describe("acker files migrate", () => {
  test("copies and verifies live bytes before atomically switching the active FileStore", async () => {
    const directory = fixture();
    writeFileSync(join(directory, ".ackerdb.config.json"), JSON.stringify({
      files: {
        backend: "filesystem",
        path: "./source-files",
        publicUrl: "https://files.example.test/base",
        maxBytes: 73_728,
      },
    }));
    const original = loadConfig(directory);
    if (original.files.backend !== "filesystem") throw new Error("fixture must use filesystem Files");
    const objectKey = "immutable/object";
    const contents = "migration preserves these bytes";
    await seedFile(directory, objectKey, contents);
    const targetDescriptor = join(directory, "target-files.json");
    writeFileSync(targetDescriptor, JSON.stringify({
      backend: "filesystem",
      path: "./migrated-files",
    }));

    const migrated = await runCli(["files", "migrate", targetDescriptor, directory]);

    expect(migrated.code).toBe(0);
    expect(migrated.stderr.trim()).toBe(
      `[ackerdb] FileStore migration complete: 1/1 objects, ` +
        `${new TextEncoder().encode(contents).byteLength}/` +
        `${new TextEncoder().encode(contents).byteLength} bytes durably checkpointed`,
    );
    expect(migrated.stderr).not.toContain(objectKey);
    expect(migrated.stderr).not.toContain(directory);
    expect(outputJson(migrated.stdout)).toMatchObject({
      operation: "file-store-migration",
      state: "complete",
      objects: { total: 1, completed: 1, copied: 1 },
    });
    expect(telemetryRecords(migrated.stdout, true)).toEqual([
      expect.objectContaining({
        kind: "span",
        operation: "file_migration",
        stage: "storage",
        outcome: "ok",
        sizeBytes: new TextEncoder().encode(contents).byteLength,
      }),
    ]);
    const active = loadConfig(directory);
    expect(active.files).toMatchObject({
      backend: "filesystem",
      root: join(directory, "migrated-files"),
      publicUrl: "https://files.example.test/base",
      maxBytes: 73_728,
    });
    if (active.files.backend !== "filesystem") throw new Error("target must use filesystem Files");
    expect(await new Response(
      (await new LocalFileStore({ root: active.files.root }).open(objectKey)).body,
    ).text()).toBe(contents);
    expect(await new Response(
      (await new LocalFileStore({ root: original.files.root }).open(objectKey)).body,
    ).text()).toBe(contents);
    expect(JSON.parse(readFileSync(join(directory, ".ackerdb.config.json"), "utf8"))).toMatchObject({
      files: {
        backend: "filesystem",
        path: "./migrated-files",
        publicUrl: "https://files.example.test/base",
        maxBytes: 73_728,
      },
    });
  });

  test("acquires database ownership before probing and sweeping local staging", async () => {
    const directory = fixture();
    await seedFile(directory, "held/object", "held bytes");
    const config = loadConfig(directory);
    if (config.files.backend !== "filesystem") throw new Error("fixture must use filesystem Files");
    const staging = join(config.files.root, "staging");
    const sentinel = join(staging, "live-owner-upload");
    mkdirSync(staging, { recursive: true });
    writeFileSync(sentinel, "in progress");

    const app = await importApp(config);
    const owner = new Engine(app.schema, join(config.dbDir, "data.db"));
    try {
      resolveFileStoreBinding(owner, fileStoreIdentity(config.files));
      const contender = await runCli(["start", directory]);
      expect(contender.code).toBe(1);
      expect(contender.stderr).toContain("database is already open");
      expect(readFileSync(sentinel, "utf8")).toBe("in progress");
    } finally {
      owner.close("clean");
    }
  });

  test("recovers a verified migration transition from whichever config survived a crash", async () => {
    for (const survivor of ["source", "target"] as const) {
      const directory = fixture();
      const configPath = join(directory, ".ackerdb.config.json");
      const sourceDocument = { backend: "filesystem", path: "./source-files" } as const;
      const targetDocument = { backend: "filesystem", path: "./target-files" } as const;
      writeFileSync(configPath, JSON.stringify({ files: sourceDocument }));
      const sourceConfig = loadConfig(directory);
      writeFileSync(configPath, JSON.stringify({ files: targetDocument }));
      const resolvedTarget = loadConfig(directory);
      writeFileSync(configPath, JSON.stringify({ files: sourceDocument }));
      mkdirSync(sourceConfig.dbDir, { recursive: true });
      const app = await importApp(sourceConfig);
      const engine = new Engine(app.schema, join(sourceConfig.dbDir, "data.db"));
      try {
        reconcile(engine);
        resolveFileStoreBinding(engine, fileStoreIdentity(sourceConfig.files));
        recordVerifiedFileStoreTransition(
          engine,
          fileStoreIdentity(sourceConfig.files),
          fileStoreIdentity(resolvedTarget.files),
        );
      } finally {
        engine.close("clean");
      }

      writeFileSync(configPath, JSON.stringify({
        files: survivor === "source" ? sourceDocument : targetDocument,
      }));
      const active = survivor === "source" ? sourceConfig : resolvedTarget;
      const inactive = survivor === "source" ? resolvedTarget : sourceConfig;
      const backup = await runCli([
        "backup",
        join(directory, `${survivor}-survivor.db`),
        directory,
        "--metadata-only",
      ]);
      expect(backup.code).toBe(0);

      const recovered = new Engine(app.schema, join(active.dbDir, "data.db"));
      try {
        resolveFileStoreBinding(recovered, fileStoreIdentity(active.files));
        expect(() => resolveFileStoreBinding(
          recovered,
          fileStoreIdentity(inactive.files),
        )).toThrow();
      } finally {
        recovered.close("clean");
      }
    }
  }, 30_000);

  test("maintenance refuses an unverified direct FileStore config switch", async () => {
    const directory = fixture();
    const configPath = join(directory, ".ackerdb.config.json");
    writeFileSync(configPath, JSON.stringify({
      files: { backend: "filesystem", path: "./source-files" },
    }));
    const source = loadConfig(directory);
    mkdirSync(source.dbDir, { recursive: true });
    const app = await importApp(source);
    const engine = new Engine(app.schema, join(source.dbDir, "data.db"));
    try {
      reconcile(engine);
      resolveFileStoreBinding(engine, fileStoreIdentity(source.files));
    } finally {
      engine.close("clean");
    }

    writeFileSync(configPath, JSON.stringify({
      files: { backend: "filesystem", path: "./direct-edit" },
    }));
    const refused = await runCli([
      "backup",
      join(directory, "refused.db"),
      directory,
      "--metadata-only",
    ]);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("configured FileStore does not match the database");
    expect(existsSync(join(directory, "refused.db"))).toBe(false);
  });

  test("retains the active FileStore configuration when migration cannot verify every File", async () => {
    const directory = fixture();
    await seedFile(directory, "missing/source", "metadata without bytes", { writeBytes: false });
    const targetDescriptor = join(directory, "target-files.json");
    const target = { backend: "filesystem", path: "./migrated-files" };
    writeFileSync(targetDescriptor, JSON.stringify(target));

    const migrated = await runCli(["files", "migrate", targetDescriptor, directory]);

    expect(migrated.code).toBe(1);
    expect(migrated.stderr).toContain("FileStore migration failed during source-read");
    expect(telemetryRecords(migrated.stdout, false)).toEqual([
      expect.objectContaining({
        kind: "span",
        operation: "file_migration",
        stage: "storage",
        outcome: "internal",
      }),
      expect.objectContaining({
        kind: "event",
        name: "failure",
        operation: "file_migration",
        stage: "storage",
        outcome: "internal",
      }),
    ]);
    expect(existsSync(join(directory, ".ackerdb.config.json"))).toBe(false);
    expect(loadConfig(directory).files).toMatchObject({
      backend: "filesystem",
      root: join(directory, ".ackerdb", "files"),
    });
  });

  test("rejects nested filesystem roots", async () => {
    const directory = fixture();
    const targetDescriptor = join(directory, "target-files.json");
    writeFileSync(targetDescriptor, JSON.stringify({
      backend: "filesystem",
      path: "./.ackerdb/files/nested",
    }));

    const migrated = await runCli(["files", "migrate", targetDescriptor, directory]);

    expect(migrated.code).toBe(1);
    expect(migrated.stderr).toContain(
      "filesystem migration source and target roots must not overlap",
    );
  });

  test("refuses the same physical S3 store even when write options differ", async () => {
    const directory = fixture();
    writeFileSync(join(directory, ".ackerdb.config.json"), JSON.stringify({
      files: {
        backend: "s3",
        endpoint: "https://objects.example.test",
        region: "auto",
        bucket: "documents",
        encryption: { type: "AES256" },
      },
    }));
    const targetDescriptor = join(directory, "target-files.json");
    writeFileSync(targetDescriptor, JSON.stringify({
      backend: "s3",
      endpoint: "https://objects.example.test/",
      region: "auto",
      bucket: "documents",
      forcePathStyle: true,
      encryption: { type: "disabled" },
    }));

    const migrated = await runCli(["files", "migrate", targetDescriptor, directory]);

    expect(migrated.code).toBe(1);
    expect(migrated.stderr).toContain("target is the active physical FileStore");
  });
});
