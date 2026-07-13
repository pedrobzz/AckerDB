import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  Engine,
  type BackupManifest,
  type DurabilityPolicy,
  type EngineStatus,
} from "@dbzz/server";
import { importSchema } from "./app.ts";
import type { AppConfig } from "./config.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_BIGINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_MANIFEST_BYTES = 16 * 1024;

export interface BackupManifestJson {
  format: 1;
  sha256: string;
  bytes: number;
  schemaFingerprint: string;
  commitVersion: string;
  durability: DurabilityPolicy;
  verifiedAt: number;
}

export interface EngineStatusJson extends Omit<EngineStatus, "commitVersion"> {
  commitVersion: string;
}

export interface StatusReport {
  format: 1;
  operation: "status";
  database: string;
  schemaFingerprint: string;
  status: EngineStatusJson;
}

export interface BackupReport {
  format: 1;
  operation: "backup";
  artifact: string;
  manifestPath: string;
  manifest: BackupManifestJson;
}

export interface RestoreReport {
  format: 1;
  operation: "restore";
  artifact: string;
  database: string;
  manifest: BackupManifestJson;
  status: EngineStatusJson;
}

export type FreshProcessVerifier = (
  config: AppConfig,
  artifact: string,
  manifest: BackupManifest,
) => Promise<void>;

function databasePath(config: AppConfig): string {
  return join(config.dbDir, "data.db");
}

export function backupManifestPath(artifact: string): string {
  return `${artifact}.manifest.json`;
}

function requireDatabase(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`DBZZ database not found at ${path}`);
  }
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`backup manifest ${field} must be a non-negative safe integer`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`backup manifest ${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function serializeBackupManifest(manifest: BackupManifest): BackupManifestJson {
  return { ...manifest, commitVersion: manifest.commitVersion.toString() };
}

export function parseBackupManifest(value: unknown): BackupManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup manifest must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const fields = [
    "format",
    "sha256",
    "bytes",
    "schemaFingerprint",
    "commitVersion",
    "durability",
    "verifiedAt",
  ];
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error("backup manifest has an unsupported shape");
  }
  if (record.format !== 1) throw new Error("backup manifest format must be 1");
  if (typeof record.commitVersion !== "string" || !DECIMAL_BIGINT.test(record.commitVersion)) {
    throw new Error("backup manifest commitVersion must be a canonical non-negative decimal string");
  }
  if (record.durability !== "production" && record.durability !== "balanced") {
    throw new Error("backup manifest durability must be production or balanced");
  }
  return {
    format: 1,
    sha256: digest(record.sha256, "sha256"),
    bytes: safeInteger(record.bytes, "bytes"),
    schemaFingerprint: digest(record.schemaFingerprint, "schemaFingerprint"),
    commitVersion: BigInt(record.commitVersion),
    durability: record.durability,
    verifiedAt: safeInteger(record.verifiedAt, "verifiedAt"),
  };
}

export function readBackupManifest(artifact: string): BackupManifest {
  const path = backupManifestPath(artifact);
  if (!existsSync(path)) throw new Error(`backup manifest not found at ${path}`);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new Error(`backup manifest must be a file no larger than ${MAX_MANIFEST_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`backup manifest is not valid JSON: ${String(error)}`);
  }
  return parseBackupManifest(value);
}

function statusJson(status: EngineStatus): EngineStatusJson {
  return { ...status, commitVersion: status.commitVersion.toString() };
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishManifest(path: string, manifest: BackupManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  let published = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(serializeBackupManifest(manifest))}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fsyncPath(temporary);
    // Linking a complete file gives us exclusive, atomic publication: an
    // existing manifest is never replaced, even if another process races us.
    linkSync(temporary, path);
    published = true;
    unlinkSync(temporary);
    fsyncPath(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    if (published) rmSync(path, { force: true });
    throw error;
  }
}

function assertManifestMatchesEngine(engine: Engine, manifest: BackupManifest): EngineStatus {
  if (engine.schemaFingerprint() !== manifest.schemaFingerprint) {
    throw new Error("backup schema fingerprint does not match the target application schema");
  }
  const status = engine.status();
  if (status.commitVersion !== manifest.commitVersion) {
    throw new Error("restored commit version does not match the backup manifest");
  }
  return status;
}

function proveNextCommit(engine: Engine): void {
  const terminal = engine.commitVersion();
  let transactionOpen = false;
  try {
    // Exercise DBZZ's version allocator, but roll it back so restoring an
    // artifact preserves its exact terminal version.
    engine.writer.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const next = engine.allocateCommitVersion();
    if (next !== terminal + 1n) {
      throw new Error(`next commit version was ${next}; expected ${terminal + 1n}`);
    }
    engine.writer.exec("ROLLBACK");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        engine.writer.exec("ROLLBACK");
      } catch {
        // Preserve the failure that made the transaction unusable.
      }
    }
    throw error;
  }

  try {
    // A committed no-op write proves the restored file can complete a real
    // durable writer transaction without inventing a user-visible version.
    engine.writer.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    engine.writer
      .query("UPDATE _dbz_state SET commit_version = commit_version WHERE singleton = 1")
      .run();
    engine.writer.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        engine.writer.exec("ROLLBACK");
      } catch {
        // Preserve the commit failure.
      }
    }
    throw error;
  }
  if (engine.commitVersion() !== terminal) {
    throw new Error("restore commit probe changed the terminal commit version");
  }
}

/** Open and inspect an existing DBZZ database without starting the app server. */
export async function inspectDatabase(config: AppConfig): Promise<StatusReport> {
  const path = databasePath(config);
  requireDatabase(path);
  const schema = await importSchema(config);
  const engine = new Engine(schema, path, { integrityCheck: "full" });
  try {
    return {
      format: 1,
      operation: "status",
      database: path,
      schemaFingerprint: engine.schemaFingerprint(),
      status: statusJson(engine.status()),
    };
  } finally {
    engine.close();
  }
}

/**
 * Create and publish a backup only after a separate process has restored and
 * verified it. Engine.backup owns the consistent VACUUM INTO snapshot.
 */
export async function createVerifiedBackup(
  config: AppConfig,
  destination: string,
  verify: FreshProcessVerifier,
): Promise<BackupReport> {
  const source = databasePath(config);
  requireDatabase(source);
  const artifact = resolve(destination);
  const manifestPath = backupManifestPath(artifact);
  if (existsSync(artifact)) throw new Error(`backup destination already exists: ${artifact}`);
  if (existsSync(manifestPath)) throw new Error(`backup manifest already exists: ${manifestPath}`);

  const schema = await importSchema(config);
  let manifest: BackupManifest;
  const engine = new Engine(schema, source, { integrityCheck: "full" });
  try {
    manifest = engine.backup(artifact);
  } finally {
    engine.close();
  }

  try {
    await verify(config, artifact, manifest);
    manifest = { ...manifest, verifiedAt: Date.now() };
    publishManifest(manifestPath, manifest);
  } catch (error) {
    rmSync(artifact, { force: true });
    throw error;
  }

  return {
    format: 1,
    operation: "backup",
    artifact,
    manifestPath,
    manifest: serializeBackupManifest(manifest),
  };
}

/** Restore an artifact into a throwaway database and exercise its next commit. */
export async function verifyBackupArtifact(
  config: AppConfig,
  artifact: string,
  manifest: BackupManifest,
): Promise<void> {
  const schema = await importSchema(config);
  const temporaryDir = mkdtempSync(join(tmpdir(), "dbzz-verify-"));
  const restored = join(temporaryDir, "data.db");
  try {
    Engine.restore(artifact, restored, manifest);
    const engine = new Engine(schema, restored, {
      durability: manifest.durability,
      integrityCheck: "full",
    });
    try {
      assertManifestMatchesEngine(engine, manifest);
      proveNextCommit(engine);
    } finally {
      engine.close();
    }
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/** Verify in a fresh process, then atomically restore into a never-used target. */
export async function restoreVerifiedBackup(
  config: AppConfig,
  source: string,
  verify: FreshProcessVerifier,
): Promise<RestoreReport> {
  const artifact = resolve(source);
  if (!existsSync(artifact) || !statSync(artifact).isFile()) {
    throw new Error(`backup artifact not found at ${artifact}`);
  }
  const manifest = readBackupManifest(artifact);
  if (existsSync(config.dbDir)) {
    throw new Error(`restore requires a fresh target; database directory already exists: ${config.dbDir}`);
  }

  await verify(config, artifact, manifest);

  const target = databasePath(config);
  mkdirSync(dirname(config.dbDir), { recursive: true });
  try {
    // Claim the target after verification so a concurrent starter/restorer
    // cannot appear in the gap between the freshness check and promotion.
    mkdirSync(config.dbDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`restore requires a fresh target; database directory already exists: ${config.dbDir}`);
    }
    throw error;
  }
  try {
    Engine.restore(artifact, target, manifest);
    const schema = await importSchema(config);
    const engine = new Engine(schema, target, {
      durability: manifest.durability,
      integrityCheck: "full",
    });
    let status: EngineStatus;
    try {
      status = assertManifestMatchesEngine(engine, manifest);
      proveNextCommit(engine);
    } finally {
      engine.close();
    }
    return {
      format: 1,
      operation: "restore",
      artifact,
      database: target,
      manifest: serializeBackupManifest(manifest),
      status: statusJson(status),
    };
  } catch (error) {
    // The target was proven absent above, so every file in this directory was
    // created by this restore attempt and is safe to remove on failure.
    rmSync(config.dbDir, { recursive: true, force: true });
    throw error;
  }
}
