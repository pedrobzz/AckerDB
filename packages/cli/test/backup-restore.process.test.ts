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
import { encode } from "@dbzz/core";
import { Engine, reconcile, type TelemetryRecord } from "@dbzz/server";
import { importSchema } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { mutationReplayOwner } from "../../server/src/mutation-replay.ts";
import {
  backupManifestPath,
  parseBackupManifest,
  type BackupManifestJson,
  type BackupReport,
  type RestoreReport,
  type StatusReport,
} from "../src/operations.ts";
import { FIXTURE_SCHEMA, makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;
const dirs: string[] = [];
const replayResult = encode({ messageId: 1n, body: "preserved" });
const replayRecord = Object.freeze({
  sessionId: "backup-restore-session",
  requestId: "backup-restore-request",
  issuedAt: 1_700_000_000_000,
  principalFingerprint: "backup-restore-principal",
  functionRef: "messages.create",
  argsFingerprint: "backup-restore-args",
  result: replayResult,
  resultBytes: new TextEncoder().encode(replayResult).byteLength,
  completedAt: 1_700_000_000_001,
});

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(schema = FIXTURE_SCHEMA): string {
  const dir = makeFixture({ "schema.ts": schema });
  dirs.push(dir);
  return dir;
}

async function seed(dir: string, durability: "production" | "balanced" = "production"): Promise<void> {
  const config = loadConfig(dir, { DBZZ_DURABILITY: durability });
  const schema = await importSchema(config);
  mkdirSync(config.dbDir, { recursive: true });
  const engine = new Engine(schema, join(config.dbDir, "data.db"), { durability });
  try {
    reconcile(engine);
    const role = engine.tags.get("Role")!.toTag.get("member")!;
    const payload = engine.tags.get("Payload")!.toTag.get("nothing")!;
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

async function runCli(
  args: string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function outputJson<T>(stdout: string): T {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines.at(-1)!) as T;
}

function telemetryRecords(stdout: string): TelemetryRecord[] {
  return stdout
    .trim()
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as TelemetryRecord)
    .filter((record) => record.schemaVersion === 1);
}

describe("dbz backup, restore, and status", () => {
  test("status and backup never create a missing source database", async () => {
    const source = fixture();
    const databaseDir = join(source, ".zdb");
    const status = await runCli(["status", source]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("DBZZ database not found");
    expect(existsSync(databaseDir)).toBe(false);

    const artifact = join(source, "backup.db");
    const backup = await runCli(["backup", artifact, source]);
    expect(backup.exitCode).toBe(1);
    expect(backup.stderr).toContain("DBZZ database not found");
    expect(existsSync(databaseDir)).toBe(false);
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(backupManifestPath(artifact))).toBe(false);
  });

  test("reports status and restores a fresh-process-verified backup with its terminal commit", async () => {
    const source = fixture();
    await seed(source);

    const statusResult = await runCli(["status", source]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stderr).toBe("");
    const status = outputJson<StatusReport>(statusResult.stdout);
    expect(status).toMatchObject({ format: 1, operation: "status" });
    expect(status.status.commitVersion).toBe("1");
    expect(status.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const artifact = join(source, "backup.db");
    const backupResult = await runCli(["backup", artifact, source]);
    expect(backupResult.exitCode).toBe(0);
    expect(backupResult.stderr).toBe("");
    const backup = outputJson<BackupReport>(backupResult.stdout);
    expect(backup).toMatchObject({
      format: 1,
      operation: "backup",
      artifact,
      manifestPath: backupManifestPath(artifact),
      manifest: { format: 1, commitVersion: "1", durability: "production" },
    });
    expect(existsSync(artifact)).toBe(true);
    expect(existsSync(backupManifestPath(artifact))).toBe(true);
    expect(backup.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(backup.manifest.verifiedAt).toBeGreaterThan(0);
    expect(telemetryRecords(backupResult.stdout)).toEqual([
      expect.objectContaining({
        kind: "span",
        operation: "backup",
        stage: "storage",
        outcome: "ok",
        resource: "operation",
        sizeBytes: backup.manifest.bytes,
        commitId: "1",
      }),
    ]);

    const target = fixture();
    const restoreResult = await runCli(["restore", artifact, target]);
    expect(restoreResult.exitCode).toBe(0);
    expect(restoreResult.stderr).toBe("");
    const restore = outputJson<RestoreReport>(restoreResult.stdout);
    expect(restore).toMatchObject({
      format: 1,
      operation: "restore",
      artifact,
      status: { commitVersion: "1" },
    });
    expect(telemetryRecords(restoreResult.stdout)).toEqual([
      expect.objectContaining({
        kind: "span",
        operation: "restore",
        stage: "storage",
        outcome: "ok",
        resource: "operation",
        sizeBytes: backup.manifest.bytes,
        commitId: "1",
      }),
    ]);

    const targetConfig = loadConfig(target);
    const restored = new Engine(await importSchema(targetConfig), join(targetConfig.dbDir, "data.db"), {
      integrityCheck: "full",
    });
    try {
      expect(
        restored.writer.query("SELECT channelId, body FROM messages").get(),
      ).toEqual({ channelId: 7n, body: "preserved" });
      const expectedReplay = {
        ...replayRecord,
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

  test("status and backup preserve the explicitly selected balanced durability", async () => {
    const source = fixture();
    await seed(source, "balanced");
    const env = { DBZZ_DURABILITY: "balanced" };

    const statusResult = await runCli(["status", source], env);
    expect(statusResult.exitCode).toBe(0);
    expect(outputJson<StatusReport>(statusResult.stdout).status.durability).toBe("balanced");

    const artifact = join(source, "balanced-backup.db");
    const backupResult = await runCli(["backup", artifact, source], env);
    expect(backupResult.exitCode).toBe(0);
    expect(outputJson<BackupReport>(backupResult.stdout).manifest.durability).toBe("balanced");
  }, 30_000);

  test("backup telemetry is fail-safe, payload-free, and can be disabled exactly", async () => {
    const source = fixture();
    await seed(source);
    const secret = "backup-telemetry-secret-canary";
    const occupied = join(source, secret);
    writeFileSync(occupied, secret);

    const failed = await runCli(["backup", occupied, source]);
    expect(failed.exitCode).toBe(1);
    const failedRecords = failed.stdout.trim().split("\n").map(
      (line) => JSON.parse(line) as TelemetryRecord,
    );
    expect(failedRecords).toEqual([
      expect.objectContaining({
        kind: "span",
        operation: "backup",
        stage: "storage",
        outcome: "internal",
        resource: "operation",
      }),
      expect.objectContaining({
        kind: "event",
        name: "failure",
        operation: "backup",
        stage: "storage",
        outcome: "internal",
        errorClass: "Error",
      }),
    ]);
    expect(failed.stdout).not.toContain(secret);

    const artifact = join(source, "disabled-backup.db");
    const disabled = await runCli(["backup", artifact, source], { DBZZ_TELEMETRY: "disabled" });
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stderr).toBe("");
    expect(disabled.stdout.trim().split("\n")).toHaveLength(1);
    expect(outputJson<BackupReport>(disabled.stdout)).toMatchObject({
      operation: "backup",
      manifest: { commitVersion: "1" },
    });
  }, 30_000);

  test("rejects changed artifacts and malformed manifests before creating a target", async () => {
    const source = fixture();
    await seed(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).exitCode).toBe(0);

    const corruptArtifact = join(source, "corrupt.db");
    copyFileSync(artifact, corruptArtifact);
    copyFileSync(backupManifestPath(artifact), backupManifestPath(corruptArtifact));
    appendFileSync(corruptArtifact, "corrupt");
    const corruptTarget = fixture();
    const corrupt = await runCli(["restore", corruptArtifact, corruptTarget]);
    expect(corrupt.exitCode).toBe(1);
    expect(corrupt.stderr).toContain("artifact does not match its manifest");
    expect(existsSync(join(corruptTarget, ".zdb"))).toBe(false);

    const malformedArtifact = join(source, "malformed.db");
    copyFileSync(artifact, malformedArtifact);
    const malformed = JSON.parse(
      readFileSync(backupManifestPath(artifact), "utf8"),
    ) as BackupManifestJson & { extra?: boolean };
    malformed.extra = true;
    writeFileSync(backupManifestPath(malformedArtifact), JSON.stringify(malformed));
    const malformedTarget = fixture();
    const malformedResult = await runCli(["restore", malformedArtifact, malformedTarget]);
    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stderr).toContain("unsupported shape");
    expect(existsSync(join(malformedTarget, ".zdb"))).toBe(false);

    const mismatchedTarget = fixture(
      FIXTURE_SCHEMA.replace(
        "messages: defineTable({",
        "extra: defineTable({ id: dbz.primaryKey() }),\n  messages: defineTable({",
      ),
    );
    const mismatchedResult = await runCli(["restore", artifact, mismatchedTarget]);
    expect(mismatchedResult.exitCode).toBe(1);
    expect(mismatchedResult.stderr).toContain("schema fingerprint");
    expect(existsSync(join(mismatchedTarget, ".zdb"))).toBe(false);
  }, 30_000);

  test("never replaces an existing or locked database target", async () => {
    const source = fixture();
    await seed(source);
    const artifact = join(source, "backup.db");
    expect((await runCli(["backup", artifact, source])).exitCode).toBe(0);

    const target = fixture();
    await seed(target);
    const config = loadConfig(target);
    const live = new Engine(await importSchema(config), join(config.dbDir, "data.db"));
    try {
      const result = await runCli(["restore", artifact, target]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("restore requires a fresh target");
      expect(live.commitVersion()).toBe(1n);
      expect(live.writer.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1n });
    } finally {
      live.close("clean");
    }
  }, 30_000);

  test("manifest parser rejects non-canonical and lossy values", () => {
    const valid: BackupManifestJson = {
      format: 1,
      sha256: "a".repeat(64),
      bytes: 4096,
      schemaFingerprint: "b".repeat(64),
      commitVersion: "9007199254740993",
      durability: "production",
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
