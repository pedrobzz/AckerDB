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
  CorruptDatabaseError,
  Engine,
  IncompatibleDatabaseError,
  PRODUCTION_LIMITS,
  restoreVerifiedDatabase,
  Telemetry,
  isDbzzError,
  type BackupManifest,
  type DurabilityPolicy,
  type EngineStatus,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryTraceContext,
} from "@dbzz/server";
import { importApp } from "./manifest.ts";
import type { AppConfig } from "./config.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_BIGINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_MANIFEST_BYTES = 16 * 1024;

interface OperationTelemetryDetails {
  readonly sizeBytes?: number;
  readonly commitId?: string;
}

function operationOutcome(error: unknown): TelemetryOutcome {
  if (isDbzzError(error)) return error.code;
  if (error instanceof CorruptDatabaseError || error instanceof IncompatibleDatabaseError) {
    return "validation";
  }
  return "internal";
}

async function observeStorageOperation<T>(
  config: AppConfig,
  operation: Extract<TelemetryOperation, "backup" | "restore">,
  work: () => Promise<T>,
  details: (value: T) => OperationTelemetryDetails,
): Promise<T> {
  const telemetry = new Telemetry(config.telemetry === "disabled"
    ? { enabled: false }
    : { limits: { slowOperationMs: 0 } });
  const context: TelemetryTraceContext = {
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
  };
  const startedAt = performance.now();
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = await work();
    const observed = details(value);
    telemetry.recordSpan({
      operation,
      stage: "storage",
      outcome: "ok",
      resource: "operation",
      durationMs: Math.max(0, performance.now() - startedAt),
      ...(observed.sizeBytes === undefined ? {} : { sizeBytes: observed.sizeBytes }),
      context: observed.commitId === undefined ? context : { ...context, commitId: observed.commitId },
    });
  } catch (error) {
    failed = true;
    failure = error;
    const outcome = operationOutcome(error);
    try {
      telemetry.recordSpan({
        operation,
        stage: "storage",
        outcome,
        resource: "operation",
        durationMs: Math.max(0, performance.now() - startedAt),
        context,
      });
      telemetry.recordEvent({
        name: "failure",
        level: "error",
        operation,
        stage: "storage",
        outcome,
        resource: "operation",
        errorClass: error instanceof Error ? error.name : "UnknownError",
        context,
      });
    } catch (telemetryError) {
      failure = new AggregateError(
        [error, telemetryError],
        `${operation} failed and failure telemetry also failed`,
      );
    }
  }
  try {
    await telemetry.drain(Date.now() + PRODUCTION_LIMITS.gracefulShutdownMs);
  } catch (drainError) {
    if (failed) {
      throw new AggregateError(
        [failure, drainError],
        `${operation} failed and telemetry cleanup also failed`,
      );
    }
    throw drainError;
  }
  if (failed) throw failure;
  return value!;
}

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
  let failed = false;
  let failure: unknown;
  try {
    fsyncSync(fd);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (closeError) {
    if (failed) throw new AggregateError([failure, closeError], `fsync and descriptor close both failed: ${path}`);
    throw closeError;
  }
  if (failed) throw failure;
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
    const cleanup: unknown[] = [];
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      cleanup.push(cleanupError);
    }
    if (published) {
      try {
        rmSync(path, { force: true });
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

/** Open and inspect an existing DBZZ database without starting the app server. */
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
): Promise<BackupReport> {
  return observeStorageOperation(config, "backup", async () => {
    const source = databasePath(config);
    requireDatabase(source);
    const artifact = resolve(destination);
    const manifestPath = backupManifestPath(artifact);
    if (existsSync(artifact)) throw new Error(`backup destination already exists: ${artifact}`);
    if (existsSync(manifestPath)) throw new Error(`backup manifest already exists: ${manifestPath}`);

    const app = await importApp(config);
    let manifest: BackupManifest | null = null;
    const engine = new Engine(app.schema, source, {
      durability: config.durability,
      integrityCheck: "full",
    });
    let backupFailed = false;
    let backupFailure: unknown;
    try {
      manifest = engine.backup(artifact);
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
      try {
        rmSync(artifact, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [backupFailure, cleanupError],
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
      try {
        rmSync(artifact, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `backup verification and artifact cleanup both failed: ${artifact}`,
        );
      }
      throw error;
    }

    return {
      format: 1,
      operation: "backup",
      artifact,
      manifestPath,
      manifest: serializeBackupManifest(manifest),
    };
  }, (report) => ({
    sizeBytes: report.manifest.bytes,
    commitId: report.manifest.commitVersion,
  }));
}

/** Restore an artifact into a throwaway database and exercise its next commit. */
export async function verifyBackupArtifact(
  config: AppConfig,
  artifact: string,
  manifest: BackupManifest,
): Promise<void> {
  const temporaryDir = mkdtempSync(join(tmpdir(), "dbzz-verify-"));
  const restored = join(temporaryDir, "data.db");
  let failed = false;
  let failure: unknown;
  try {
    await restoreVerifiedDatabase(artifact, restored, manifest, () => importApp(config));
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
  return observeStorageOperation(config, "restore", async () => {
    const artifact = resolve(source);
    if (!existsSync(artifact) || !statSync(artifact).isFile()) {
      throw new Error(`backup artifact not found at ${artifact}`);
    }
    const manifest = readBackupManifest(artifact);
    await verify(config, artifact, manifest);

    const target = databasePath(config);
    const status = await restoreVerifiedDatabase(artifact, target, manifest, () => importApp(config));
    return {
      format: 1,
      operation: "restore",
      artifact,
      database: target,
      manifest: serializeBackupManifest(manifest),
      status: statusJson(status),
    };
  }, (report) => ({
    sizeBytes: report.manifest.bytes,
    commitId: report.manifest.commitVersion,
  }));
}
