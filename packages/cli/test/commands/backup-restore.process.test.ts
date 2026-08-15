import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { encode } from "@ackerdb/core";
import {
  Engine,
  LocalFileStore,
  reconcile,
} from "@ackerdb/server";
import { resolveFileStoreBinding } from "@ackerdb/server/files/binding";
import { importApp } from "../../src/app/manifest.ts";
import { loadConfig } from "../../src/app/config.ts";
import { createFileStore } from "../../src/files/store.ts";
import { mutationReplayOwner } from "../../../server/src/database/mutation-replay.ts";
import {
  backupFilesPath,
  backupManifestPath,
  parseBackupManifest,
  restoreVerifiedBackup,
  type BackupManifestJson,
  type BackupReport,
  type RestoreReport,
  type StatusReport,
} from "../../src/commands/operations.ts";
import { FIXTURE_APP, makeFixture } from "../support/fixture.ts";

import { runCli } from "../support/process.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;
const dirs: string[] = [];
const replayResult = encode({ messageId: 1n, body: "preserved" });
const replayRecord = Object.freeze({
  sessionId: "backup-restore-session",
  requestId: "backup-restore-request",
  issuedAt: 1_700_000_000_000,
  principalFingerprint: "backup-restore-principal",
  functionRef: "api.messages.create",
  argsFingerprint: "backup-restore-args",
  result: replayResult,
  resultBytes: new TextEncoder().encode(replayResult).byteLength,
  completedAt: 1_700_000_000_001,
});

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(app = FIXTURE_APP): string {
  const dir = makeFixture({ "app.ts": app });
  dirs.push(dir);
  return dir;
}

async function seed(dir: string, durability: "production" | "balanced" = "production"): Promise<void> {
  const config = loadConfig(dir, { ACKERDB_DURABILITY: durability });
  const app = await importApp(config);
  mkdirSync(config.dbDir, { recursive: true });
  const engine = new Engine(app.schema, join(config.dbDir, "data.db"), { durability });
  try {
    reconcile(engine);
    const messages = engine.plan("messages");
    const role = messages.columns.get("role")!.variantTag!("member")!;
    const payload = messages.columns.get("payload")!.variantTag!("nothing")!;
    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      engine.writer
        .query(
          "INSERT INTO messages (channelId, body, role, payload, payload__p) VALUES (?, ?, ?, ?, ?)",
        )
        .run(7n, "preserved", role, payload, encode(null));
      const staged = engine[mutationReplayOwner].stage({
        sessionId: replayRecord.sessionId,
        requestId: replayRecord.requestId,
        issuedAt: replayRecord.issuedAt,
        principalFingerprint: replayRecord.principalFingerprint,
        functionRef: replayRecord.functionRef,
        argsFingerprint: replayRecord.argsFingerprint,
        resultDisposition: "replayable",
        result: replayRecord.result,
        resultBytes: replayRecord.resultBytes,
        durability,
      }, replayRecord.completedAt);
      expect(staged.commitVersion).toBe(1n);
      engine.writer.exec("COMMIT");
      engine[mutationReplayOwner].committed(staged);
    } catch (error) {
      engine.writer.exec("ROLLBACK");
      throw error;
    }
  } finally {
    engine.close("clean");
  }
}

async function seedFile(dir: string): Promise<{ objectKey: string; contents: string }> {
  const config = loadConfig(dir);
  const objectKey = "private-backup-object-key";
  const contents = "bytes survive the backup boundary";
  const bytes = new TextEncoder().encode(contents);
  if (config.files.backend !== "filesystem") throw new Error("test fixture must use local File storage");
  const store = new LocalFileStore({ root: config.files.root });
  const stored = await store.put(objectKey, new Blob([bytes]).stream(), {
    contentLength: bytes.byteLength,
  });
  const app = await importApp(config);
  const engine = new Engine(app.schema, join(config.dbDir, "data.db"));
  try {
    resolveFileStoreBinding(engine, await (await createFileStore(config.files)).identity());
    engine.writer.query(`INSERT INTO _ackerdb_files (
      id, state, objectKey, owner, size, sha256, contentType, name, createdAt, pendingExpiresAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      41n,
      "active",
      objectKey,
      null,
      BigInt(stored.size),
      stored.sha256,
      "text/plain",
      "backup.txt",
      1_700_000_000_000,
      null,
    );
  } finally {
    engine.close("clean");
  }
  return { objectKey, contents };
}

function outputJson<T>(stdout: string): T {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines.at(-1)!) as T;
}

describe("acker backup, restore, and status", () => {
  test("backup includes framework File bytes and restore writes them to the active File store", async () => {
    const source = fixture();
    await seed(source);
    const file = await seedFile(source);
    const artifact = join(source, "backup.db");

    const backup = await runCli(["backup", artifact, source]);
    expect(backup.code).toBe(0);
    const backupReport = outputJson<BackupReport>(backup.stdout);
    expect(backupReport.manifest.files).toEqual({
      mode: "included",
      count: 1,
      bytes: new TextEncoder().encode(file.contents).byteLength,
    });
    expect(existsSync(backupFilesPath(artifact))).toBe(true);

    const target = fixture();
    const restored = await runCli(["restore", artifact, target]);
    expect(restored.code).toBe(0);
    const targetConfig = loadConfig(target);
    if (targetConfig.files.backend !== "filesystem") {
      throw new Error("test fixture must use local File storage");
    }
    const opened = await new LocalFileStore({ root: targetConfig.files.root }).open(file.objectKey);
    expect(await new Response(opened.body).text()).toBe(file.contents);
    const restoredEngine = new Engine(
      (await importApp(targetConfig)).schema,
      join(targetConfig.dbDir, "data.db"),
    );
    try {
      resolveFileStoreBinding(restoredEngine, await (await createFileStore(targetConfig.files)).identity());
      const sourceIdentity = await (await createFileStore(loadConfig(source).files)).identity();
      expect(() => resolveFileStoreBinding(
        restoredEngine,
        sourceIdentity,
      )).toThrow();
    } finally {
      restoredEngine.close("clean");
    }
  }, 30_000);

  test("--metadata-only omits bytes but verifies an independently restored File store", async () => {
    const source = fixture();
    await seed(source);
    const file = await seedFile(source);
    const artifact = join(source, "metadata-only.db");

    const backup = await runCli(["backup", artifact, source, "--metadata-only"]);
    expect(backup.code).toBe(0);
    expect(outputJson<BackupReport>(backup.stdout).manifest.files).toEqual({
      mode: "metadata-only",
      count: 1,
      bytes: 0,
    });
    expect(existsSync(backupFilesPath(artifact))).toBe(false);

    const target = fixture();
    const targetConfig = loadConfig(target);
    if (targetConfig.files.backend !== "filesystem") {
      throw new Error("test fixture must use local File storage");
    }
    const targetStore = new LocalFileStore({ root: targetConfig.files.root });
    const restoredBytes = new Blob([file.contents]);
    await targetStore.put(file.objectKey, restoredBytes.stream(), {
      contentLength: restoredBytes.size,
    });
    const restored = await runCli(["restore", artifact, target]);
    expect(restored.code).toBe(0);
    expect(await new Response((await targetStore.open(file.objectKey)).body).text()).toBe(
      file.contents,
    );
  }, 30_000);

  test("metadata-only restore refuses missing or corrupt independently restored bytes", async () => {
    const source = fixture();
    await seed(source);
    const file = await seedFile(source);
    const artifact = join(source, "metadata-only.db");
    expect((await runCli(["backup", artifact, source, "--metadata-only"])).code).toBe(0);

    const target = fixture();
    const targetConfig = loadConfig(target);
    if (targetConfig.files.backend !== "filesystem") {
      throw new Error("test fixture must use local File storage");
    }
    const targetStore = new LocalFileStore({ root: targetConfig.files.root });
    const corruptBytes = new Blob(["corrupt independently restored bytes"]);
    await targetStore.put(file.objectKey, corruptBytes.stream(), {
      contentLength: corruptBytes.size,
    });
    const restored = await runCli(["restore", artifact, target]);
    expect(restored.code).toBe(1);
    expect(restored.stderr).toContain("independently restored bytes for File 41 do not match");
    expect(existsSync(join(targetConfig.dbDir, "data.db"))).toBe(false);
    expect(await new Response((await targetStore.open(file.objectKey)).body).text()).toBe(
      "corrupt independently restored bytes",
    );
  }, 30_000);

  test("restore rejects changed File bytes before creating the target database", async () => {
    const source = fixture();
    await seed(source);
    await seedFile(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).code).toBe(0);
    writeFileSync(join(backupFilesPath(artifact), "41"), "changed backup File bytes");

    const target = fixture();
    const restored = await runCli(["restore", artifact, target]);
    expect(restored.code).toBe(1);
    expect(restored.stderr).toContain("backup bytes for File 41 do not match its metadata");
    expect(existsSync(join(target, ".ackerdb"))).toBe(false);
    expect(existsSync(artifact)).toBe(true);
    expect(existsSync(backupFilesPath(artifact))).toBe(true);
  }, 30_000);

  test("backup fails without publishing a partial artifact when File bytes are missing", async () => {
    const source = fixture();
    await seed(source);
    const file = await seedFile(source);
    const config = loadConfig(source);
    if (config.files.backend !== "filesystem") throw new Error("test fixture must use local File storage");
    await new LocalFileStore({ root: config.files.root }).delete(file.objectKey);
    const artifact = join(source, "backup.db");

    const backup = await runCli(["backup", artifact, source]);
    expect(backup.code).toBe(1);
    expect(backup.stderr).toContain("file storage object was not found");
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(backupFilesPath(artifact))).toBe(false);
    expect(existsSync(backupManifestPath(artifact))).toBe(false);
    expect(existsSync(join(config.dbDir, "data.db"))).toBe(true);
  }, 30_000);

  test("backup excludes deleting Files whose physical cleanup may already be complete", async () => {
    const source = fixture();
    await seed(source);
    const file = await seedFile(source);
    const config = loadConfig(source);
    if (config.files.backend !== "filesystem") throw new Error("test fixture must use local File storage");
    const app = await importApp(config);
    const engine = new Engine(app.schema, join(config.dbDir, "data.db"));
    try {
      engine.writer.query("UPDATE _ackerdb_files SET state = 'deleting' WHERE id = 41").run();
    } finally {
      engine.close("clean");
    }
    await new LocalFileStore({ root: config.files.root }).delete(file.objectKey);
    const artifact = join(source, "backup.db");

    const backup = await runCli(["backup", artifact, source]);
    expect(backup.code).toBe(0);
    expect(outputJson<BackupReport>(backup.stdout).manifest.files).toEqual({
      mode: "included",
      count: 0,
      bytes: 0,
    });
  }, 30_000);

  test("restore never replaces an existing target File object", async () => {
    const source = fixture();
    await seed(source);
    const file = await seedFile(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).code).toBe(0);

    const target = fixture();
    const targetConfig = loadConfig(target);
    if (targetConfig.files.backend !== "filesystem") {
      throw new Error("test fixture must use local File storage");
    }
    const targetStore = new LocalFileStore({ root: targetConfig.files.root });
    const existingBytes = new Blob(["existing target bytes"]);
    await targetStore.put(file.objectKey, existingBytes.stream(), {
      contentLength: existingBytes.size,
    });

    const restored = await runCli(["restore", artifact, target]);
    expect(restored.code).toBe(1);
    expect(restored.stderr).toContain("already contains the object for File 41");
    expect(await new Response((await targetStore.open(file.objectKey)).body).text()).toBe(
      "existing target bytes",
    );
    expect(existsSync(join(targetConfig.dbDir, "data.db"))).toBe(false);
  }, 30_000);

  test("status and backup never create a missing source database", async () => {
    const source = fixture();
    const databaseDir = join(source, ".ackerdb");
    const status = await runCli(["status", source]);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("AckerDB database not found");
    expect(existsSync(databaseDir)).toBe(false);

    const artifact = join(source, "backup.db");
    const backup = await runCli(["backup", artifact, source]);
    expect(backup.code).toBe(1);
    expect(backup.stderr).toContain("AckerDB database not found");
    expect(existsSync(databaseDir)).toBe(false);
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(backupManifestPath(artifact))).toBe(false);
  });

  test("reports status and restores a fresh-process-verified backup with its terminal commit", async () => {
    const source = fixture();
    await seed(source);

    const statusResult = await runCli(["status", source]);
    expect(statusResult.code).toBe(0);
    expect(statusResult.stderr).toBe("");
    const status = outputJson<StatusReport>(statusResult.stdout);
    expect(status).toMatchObject({ format: 1, operation: "status" });
    expect(status.status.commitVersion).toBe("1");
    expect(status.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const artifact = join(source, "backup.db");
    const backupResult = await runCli(["backup", artifact, source]);
    expect(backupResult.code).toBe(0);
    expect(backupResult.stderr).toBe("");
    const backup = outputJson<BackupReport>(backupResult.stdout);
    expect(backup).toMatchObject({
      format: 1,
      operation: "backup",
      artifact,
      manifestPath: backupManifestPath(artifact),
      manifest: {
        format: 2,
        commitVersion: "1",
        durability: "production",
        files: { mode: "included", count: 0, bytes: 0 },
      },
    });
    expect(existsSync(artifact)).toBe(true);
    expect(existsSync(backupManifestPath(artifact))).toBe(true);
    expect(backup.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(backup.manifest.verifiedAt).toBeGreaterThan(0);
    const target = fixture();
    const restoreResult = await runCli(["restore", artifact, target]);
    expect(restoreResult.code).toBe(0);
    expect(restoreResult.stderr).toBe("");
    const restore = outputJson<RestoreReport>(restoreResult.stdout);
    expect(restore).toMatchObject({
      format: 1,
      operation: "restore",
      artifact,
      status: { commitVersion: "1" },
    });
    const targetConfig = loadConfig(target);
    const restored = new Engine((await importApp(targetConfig)).schema, join(targetConfig.dbDir, "data.db"), {
      integrityCheck: "full",
    });
    try {
      expect(
        restored.writer.query("SELECT channelId, body FROM messages").get(),
      ).toEqual({ channelId: 7n, body: "preserved" });
      const expectedReplay = {
        ...replayRecord,
        resultDisposition: "replayable" as const,
        sequence: 1n,
        commitVersion: 1n,
        durability: "production" as const,
      };
      expect(
        restored[mutationReplayOwner].lookup(replayRecord.sessionId, replayRecord.requestId),
      ).toEqual(expectedReplay);
      expect(restored.status()).toMatchObject({
        commitVersion: 1n,
        mutationRecords: 1,
        mutationResultBytes: replayRecord.resultBytes,
      });
      restored.writer.exec("BEGIN IMMEDIATE");
      expect(restored.allocateCommitVersion()).toBe(2n);
      restored.writer.exec("COMMIT");
      expect(restored.commitVersion()).toBe(2n);
      expect(
        restored[mutationReplayOwner].lookup(replayRecord.sessionId, replayRecord.requestId),
      ).toEqual(expectedReplay);
    } finally {
      restored.close("clean");
    }
  }, 30_000);

  test("restores into a vacant database directory and refuses unrelated entries without deleting them", async () => {
    const source = fixture();
    await seed(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).code).toBe(0);

    const vacant = fixture();
    mkdirSync(join(vacant, ".ackerdb"));
    expect((await runCli(["restore", artifact, vacant])).code).toBe(0);
    expect(existsSync(join(vacant, ".ackerdb", "data.db"))).toBe(true);

    const occupied = fixture();
    mkdirSync(join(occupied, ".ackerdb"));
    const sentinel = join(occupied, ".ackerdb", "operator-note");
    writeFileSync(sentinel, "preserve me");
    const refused = await runCli(["restore", artifact, occupied]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("unrelated entry");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
    expect(existsSync(join(occupied, ".ackerdb", "data.db"))).toBe(false);
  }, 30_000);

  test("status and backup preserve the explicitly selected balanced durability", async () => {
    const source = fixture();
    await seed(source, "balanced");
    const env = { ACKERDB_DURABILITY: "balanced" };

    const statusResult = await runCli(["status", source], env);
    expect(statusResult.code).toBe(0);
    expect(outputJson<StatusReport>(statusResult.stdout).status.durability).toBe("balanced");

    const artifact = join(source, "balanced-backup.db");
    const backupResult = await runCli(["backup", artifact, source], env);
    expect(backupResult.code).toBe(0);
    expect(outputJson<BackupReport>(backupResult.stdout).manifest.durability).toBe("balanced");
  }, 30_000);

  test("rejects changed artifacts and malformed manifests before creating a target", async () => {
    const source = fixture();
    await seed(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).code).toBe(0);

    const corruptArtifact = join(source, "corrupt.db");
    copyFileSync(artifact, corruptArtifact);
    copyFileSync(backupManifestPath(artifact), backupManifestPath(corruptArtifact));
    appendFileSync(corruptArtifact, "corrupt");
    const corruptTarget = fixture();
    const corrupt = await runCli(["restore", corruptArtifact, corruptTarget]);
    expect(corrupt.code).toBe(1);
    expect(corrupt.stderr).toContain("artifact does not match its manifest");
    expect(existsSync(join(corruptTarget, ".ackerdb"))).toBe(false);

    const malformedArtifact = join(source, "malformed.db");
    copyFileSync(artifact, malformedArtifact);
    const malformed = JSON.parse(
      readFileSync(backupManifestPath(artifact), "utf8"),
    ) as BackupManifestJson & { extra?: boolean };
    malformed.extra = true;
    writeFileSync(backupManifestPath(malformedArtifact), JSON.stringify(malformed));
    const malformedTarget = fixture();
    const malformedResult = await runCli(["restore", malformedArtifact, malformedTarget]);
    expect(malformedResult.code).toBe(1);
    expect(malformedResult.stderr).toContain("unsupported shape");
    expect(existsSync(join(malformedTarget, ".ackerdb"))).toBe(false);

    const mismatchedTarget = fixture(
      FIXTURE_APP.replace(
        "messages: defineTable({",
        "extra: defineTable({ id: v.primaryKey() }),\n  messages: defineTable({",
      ),
    );
    const mismatchedResult = await runCli(["restore", artifact, mismatchedTarget]);
    expect(mismatchedResult.code).toBe(1);
    expect(mismatchedResult.stderr).toContain("schema fingerprint");
    expect(existsSync(join(mismatchedTarget, ".ackerdb"))).toBe(false);
  }, 30_000);

  test("rechecks App layout after child verification and before canonical publication", async () => {
    const source = fixture();
    await seed(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).code).toBe(0);

    const target = fixture();
    const config = loadConfig(target);
    await expect(restoreVerifiedBackup(config, artifact, async () => {
      writeFileSync(
        config.appPath,
        FIXTURE_APP.replace(
          "messages: defineTable({",
          "extra: defineTable({ id: v.primaryKey() }),\n  messages: defineTable({",
        ),
      );
    })).rejects.toThrow("storage layout");
    expect(existsSync(join(config.dbDir, "data.db"))).toBe(false);
  });

  test("never replaces an existing or locked database target", async () => {
    const source = fixture();
    await seed(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).code).toBe(0);

    const target = fixture();
    await seed(target);
    const config = loadConfig(target);
    const live = new Engine((await importApp(config)).schema, join(config.dbDir, "data.db"));
    const sentinel = join(config.dbDir, "operator-note");
    writeFileSync(sentinel, "start winner");
    try {
      const result = await runCli(["restore", artifact, target]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("database is already open");
      expect(live.commitVersion()).toBe(1n);
      expect(live.writer.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1n });
      expect(readFileSync(sentinel, "utf8")).toBe("start winner");
    } finally {
      live.close("clean");
    }
  }, 30_000);

  test("manifest parser rejects non-canonical and lossy values", () => {
    const valid: BackupManifestJson = {
      format: 2,
      sha256: "a".repeat(64),
      bytes: 4096,
      schemaFingerprint: "b".repeat(64),
      commitVersion: "9007199254740993",
      durability: "production",
      files: { mode: "included", count: 2, bytes: 12_345 },
      verifiedAt: 1,
    };
    expect(parseBackupManifest(valid).commitVersion).toBe(9007199254740993n);
    expect(() => parseBackupManifest({ ...valid, commitVersion: "01" })).toThrow("canonical");
    expect(() => parseBackupManifest({ ...valid, bytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "safe integer",
    );
    expect(() => parseBackupManifest({ ...valid, sha256: "A".repeat(64) })).toThrow("lowercase");
  });
});
