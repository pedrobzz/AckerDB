import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
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
  restoreVerifiedDatabase,
  type BackupManifest,
  type EngineStatus,
} from "@ackerdb/server";
import {
  rebindRestoredFileStore,
  resolveFileStoreBinding,
} from "@ackerdb/server/files/binding";
import { importApp } from "../app/manifest.ts";
import { createFileStore } from "../files/store.ts";
import { databasePath, type AppConfig } from "../app/config.ts";
import {
  assertRestoreKeysVacant,
  backupFilesPath,
  createFilesBackup,
  createMetadataOnlyFilesBackup,
  fileRestorePublication,
  verifyFilesBackup,
  type BackupFilesManifest,
} from "./backup-files.ts";
import { fsyncPathSync } from "../shared/fsync.ts";
import { exactFields } from "../shared/json.ts";

export { backupFilesPath } from "./backup-files.ts";
export type { BackupFilesManifest } from "./backup-files.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_BIGINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_MANIFEST_BYTES = 16 * 1024;

export interface VerifiedBackupManifest extends Omit<BackupManifest, "format"> {
  format: 2;
  files: BackupFilesManifest;
}

export interface BackupManifestJson extends Omit<VerifiedBackupManifest, "commitVersion"> {
  sha256: string;
  commitVersion: string;
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
  manifest: VerifiedBackupManifest,
) => Promise<void>;

export function backupManifestPath(artifact: string): string {
  return `${artifact}.manifest.json`;
}

function requireDatabase(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`AckerDB database not found at ${path}`);
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

export function serializeBackupManifest(manifest: VerifiedBackupManifest): BackupManifestJson {
  return { ...manifest, commitVersion: manifest.commitVersion.toString() };
}

export function parseBackupManifest(value: unknown): VerifiedBackupManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup manifest must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  exactFields(record, [
    "format",
    "sha256",
    "bytes",
    "schemaFingerprint",
    "commitVersion",
    "durability",
    "files",
    "verifiedAt",
  ], "backup manifest");
  if (record.format !== 2) throw new Error("backup manifest format must be 2");
  if (typeof record.commitVersion !== "string" || !DECIMAL_BIGINT.test(record.commitVersion)) {
    throw new Error("backup manifest commitVersion must be a canonical non-negative decimal string");
  }
  if (record.durability !== "production" && record.durability !== "balanced") {
    throw new Error("backup manifest durability must be production or balanced");
  }
  if (record.files === null || typeof record.files !== "object" || Array.isArray(record.files)) {
    throw new Error("backup manifest files must be a JSON object");
  }
  const files = record.files as Record<string, unknown>;
  const fileFields = Object.keys(files).sort();
  if (fileFields.length !== 3 || fileFields[0] !== "bytes" || fileFields[1] !== "count" || fileFields[2] !== "mode") {
    throw new Error("backup manifest files has an unsupported shape");
  }
  if (files.mode !== "included" && files.mode !== "metadata-only") {
    throw new Error("backup manifest files mode must be included or metadata-only");
  }
  return {
    format: 2,
    sha256: digest(record.sha256, "sha256"),
    bytes: safeInteger(record.bytes, "bytes"),
    schemaFingerprint: digest(record.schemaFingerprint, "schemaFingerprint"),
    commitVersion: BigInt(record.commitVersion),
    durability: record.durability,
    files: {
      mode: files.mode,
      count: safeInteger(files.count, "files.count"),
      bytes: safeInteger(files.bytes, "files.bytes"),
    },
    verifiedAt: safeInteger(record.verifiedAt, "verifiedAt"),
  };
}

export function readBackupManifest(artifact: string): VerifiedBackupManifest {
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

function publishManifest(path: string, manifest: VerifiedBackupManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  let published = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(serializeBackupManifest(manifest))}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fsyncPathSync(temporary);
    // Linking a complete file gives us exclusive, atomic publication: an
    // existing manifest is never replaced, even if another process races us.
    linkSync(temporary, path);
    published = true;
    unlinkSync(temporary);
    fsyncPathSync(dirname(path));
  } catch (error) {
    const cleanup: unknown[] = [];
    let removed = false;
    try {
      rmSync(temporary, { force: true });
      removed = true;
    } catch (cleanupError) {
      cleanup.push(cleanupError);
    }
    if (published) {
      try {
        rmSync(path, { force: true });
        removed = true;
      } catch (cleanupError) {
        cleanup.push(cleanupError);
      }
    }
    if (removed) {
      try {
        fsyncPathSync(dirname(path));
      } catch (cleanupError) {
        cleanup.push(cleanupError);
      }
    }
    if (cleanup.length > 0) {
      throw new AggregateError(
        [error, ...cleanup],
        `backup manifest publication and cleanup both failed: ${path}`,
      );
    }
    throw error;
  }
}

function databaseManifest(manifest: VerifiedBackupManifest): BackupManifest {
  return {
    format: 1,
    sha256: manifest.sha256,
    bytes: manifest.bytes,
    schemaFingerprint: manifest.schemaFingerprint,
    commitVersion: manifest.commitVersion,
    durability: manifest.durability,
    verifiedAt: manifest.verifiedAt,
  };
}

function removeBackupCandidates(artifact: string, filesPublished: boolean): readonly unknown[] {
  const failures: unknown[] = [];
  let removed = false;
  for (const candidate of filesPublished
    ? [artifact, backupFilesPath(artifact)]
    : [artifact]) {
    if (!existsSync(candidate)) continue;
    try {
      rmSync(candidate, { recursive: candidate !== artifact, force: true });
      removed = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (removed) {
    try {
      fsyncPathSync(dirname(artifact));
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}


/** Open and inspect an existing AckerDB database without starting the app server. */
export async function inspectDatabase(config: AppConfig): Promise<StatusReport> {
  const path = databasePath(config);
  requireDatabase(path);
  const schema = (await importApp(config)).schema;
  const engine = new Engine(schema, path, {
    durability: config.durability,
    integrityCheck: "full",
  });
  let failed = false;
  let failure: unknown;
  let report: StatusReport | undefined;
  try {
    report = {
      format: 1,
      operation: "status",
      database: path,
      schemaFingerprint: engine.schemaFingerprint(),
      status: statusJson(engine.status()),
    };
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    engine.close("clean");
  } catch (closeError) {
    if (failed) throw new AggregateError([failure, closeError], `status inspection and database close both failed: ${path}`);
    throw closeError;
  }
  if (failed) throw failure;
  return report!;
}

/**
 * Create and publish a backup only after a separate process has restored and
 * verified it. Engine.backup owns the consistent VACUUM INTO snapshot.
 */
export async function createVerifiedBackup(
  config: AppConfig,
  destination: string,
  verify: FreshProcessVerifier,
  options: { metadataOnly?: boolean } = {},
): Promise<BackupReport> {
  const source = databasePath(config);
  requireDatabase(source);
  const artifact = resolve(destination);
  const manifestPath = backupManifestPath(artifact);
  const filesPath = backupFilesPath(artifact);
  if (existsSync(artifact)) throw new Error(`backup destination already exists: ${artifact}`);
  if (existsSync(manifestPath)) throw new Error(`backup manifest already exists: ${manifestPath}`);
  if (existsSync(filesPath)) throw new Error(`backup File destination already exists: ${filesPath}`);

  const app = await importApp(config);
  let manifest: VerifiedBackupManifest | null = null;
  let filesPublished = false;
  const engine = new Engine(app.schema, source, {
    durability: config.durability,
    integrityCheck: "full",
  });
  let backupFailed = false;
  let backupFailure: unknown;
    try {
      resolveFileStoreBinding(engine, await (await createFileStore(config.files)).identity());
      const engineManifest = engine.backup(artifact);
      const fileManifest = options.metadataOnly === true
        ? await createMetadataOnlyFilesBackup(artifact)
        : await createFilesBackup(config, artifact, artifact);
      filesPublished = fileManifest.mode === "included";
      manifest = {
        ...engineManifest,
        format: 2,
        files: fileManifest,
        verifiedAt: 0,
      };
    } catch (error) {
      backupFailed = true;
      backupFailure = error;
    }
    try {
      engine.close("clean");
    } catch (closeError) {
      if (backupFailed) {
        backupFailure = new AggregateError(
          [backupFailure, closeError],
          `backup and database close both failed: ${source}`,
        );
      } else {
        backupFailure = closeError;
      }
      backupFailed = true;
    }
    if (backupFailed) {
      const cleanup = removeBackupCandidates(artifact, filesPublished);
      if (cleanup.length > 0) {
        throw new AggregateError(
          [backupFailure, ...cleanup],
          `backup failed and candidate artifact cleanup also failed: ${artifact}`,
        );
      }
      throw backupFailure;
    }
    if (manifest === null) throw new Error("backup completed without a manifest");

    try {
      await verify(config, artifact, manifest);
      manifest = { ...manifest, verifiedAt: Date.now() };
      publishManifest(manifestPath, manifest);
    } catch (error) {
      const cleanup = removeBackupCandidates(artifact, filesPublished);
      if (cleanup.length > 0) {
        throw new AggregateError(
          [error, ...cleanup],
          `backup verification and artifact cleanup both failed: ${artifact}`,
        );
      }
      throw error;
    }

    if (manifest === null) throw new Error("backup completed without a File manifest");

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
  manifest: VerifiedBackupManifest,
): Promise<void> {
  const temporaryDir = mkdtempSync(join(tmpdir(), "ackerdb-verify-"));
  const restored = join(temporaryDir, "data.db");
  let failed = false;
  let failure: unknown;
  try {
    await restoreVerifiedDatabase(artifact, restored, databaseManifest(manifest), () => importApp(config));
    await verifyFilesBackup(artifact, manifest.files, restored);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    rmSync(temporaryDir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError(
        [failure, cleanupError],
        `backup verification and temporary cleanup both failed: ${artifact}`,
      );
    }
    throw cleanupError;
  }
  if (failed) throw failure;
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
    await verify(config, artifact, manifest);

    const fileStore = await createFileStore(config.files);
    const configuredFileStoreIdentity = await fileStore.identity();
    if (manifest.files.mode === "included") await assertRestoreKeysVacant(fileStore, artifact);
    const filePublication = fileRestorePublication(
      config,
      artifact,
      fileStore,
      artifact,
      manifest.files.mode,
    );

    const target = databasePath(config);
    const status = await restoreVerifiedDatabase(
      artifact,
      target,
      databaseManifest(manifest),
      () => importApp(config),
      {
        ...filePublication,
        prepareStagedDatabase: (engine) => {
          rebindRestoredFileStore(engine, configuredFileStoreIdentity);
        },
      },
    );
    return {
      format: 1,
      operation: "restore",
      artifact,
      database: target,
      manifest: serializeBackupManifest(manifest),
      status: statusJson(status),
    };
}
