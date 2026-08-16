import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Database } from "bun:sqlite";
import {
  CorruptDatabaseError,
  FileStoreError,
  type FileStore,
  type RestorePublicationHook,
} from "@ackerdb/server";
import type { AppConfig } from "../app/config.ts";
import { createFileStore } from "../files/store.ts";
import { fsyncPathSync, runWithCleanupAsync } from "../shared/fsync.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const FILE_SCAN_BATCH = 128;
const LIVE_FILE_PREDICATE = "state IN ('active', 'pending')";

export interface BackupFilesManifest {
  mode: "included" | "metadata-only";
  count: number;
  bytes: number;
}

export interface StoredFile {
  readonly id: bigint;
  readonly objectKey: string;
  readonly size: number;
  readonly sha256: string;
}

interface StoredFileTotals {
  readonly count: number;
  readonly bytes: number;
}

export function backupFilesPath(artifact: string): string {
  return `${artifact}.files`;
}

function addSafeTotal(left: number, right: number, description: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`File backup ${description} exceeds the safe manifest range`);
  }
  return total;
}

function storedFile(row: Record<string, unknown>): StoredFile {
  if (typeof row.id !== "bigint" || row.id < 0n) {
    throw new CorruptDatabaseError("backup database contains an invalid File id");
  }
  if (typeof row.objectKey !== "string" || row.objectKey.length === 0) {
    throw new CorruptDatabaseError("backup database contains an invalid File object key");
  }
  if (typeof row.size !== "bigint" || row.size < 0n || row.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptDatabaseError("backup database contains an invalid File byte size");
  }
  if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) {
    throw new CorruptDatabaseError("backup database contains an invalid File SHA-256");
  }
  return {
    id: row.id,
    objectKey: row.objectKey,
    size: Number(row.size),
    sha256: row.sha256,
  };
}

function assertUniqueObjectKeys(database: Database): void {
  const duplicate = database.query(
    `SELECT objectKey FROM _ackerdb_files WHERE ${LIVE_FILE_PREDICATE} ` +
      "GROUP BY objectKey HAVING COUNT(*) > 1 LIMIT 1",
  ).get();
  if (duplicate !== null) {
    throw new CorruptDatabaseError("backup database contains duplicate File object keys");
  }
}

async function withStoredFileDatabase<T>(
  databasePath: string,
  work: (database: Database) => T | Promise<T>,
): Promise<T> {
  const database = new Database(databasePath, { readonly: true, safeIntegers: true, strict: true });
  return runWithCleanupAsync(
    () => work(database),
    () => database.close(false),
    `File backup inspection and SQLite close both failed: ${databasePath}`,
  );
}

async function scanStoredFiles(
  databasePath: string,
  visit?: (file: StoredFile) => void | Promise<void>,
): Promise<StoredFileTotals> {
  return withStoredFileDatabase(databasePath, async (database) => {
    assertUniqueObjectKeys(database);
    const statement = database.query(
      `SELECT id, objectKey, size, sha256 FROM _ackerdb_files ` +
        `WHERE ${LIVE_FILE_PREDICATE} AND id > ? ORDER BY id ASC LIMIT ${FILE_SCAN_BATCH}`,
    );
    let cursor = -1n;
    let count = 0;
    let bytes = 0;
    for (;;) {
      const page = statement.all(cursor) as Array<Record<string, unknown>>;
      if (page.length === 0) return { count, bytes };
      for (const row of page) {
        const file = storedFile(row);
        if (file.id <= cursor) {
          throw new CorruptDatabaseError("backup File metadata scan did not advance monotonically");
        }
        cursor = file.id;
        count = addSafeTotal(count, 1, "File count");
        bytes = addSafeTotal(bytes, file.size, "File byte total");
        await visit?.(file);
      }
    }
  });
}

async function scanStoredFilesReverseThrough(
  databasePath: string,
  throughId: bigint,
  visit: (file: StoredFile) => void | Promise<void>,
): Promise<void> {
  await withStoredFileDatabase(databasePath, async (database) => {
    const firstStatement = database.query(
      `SELECT id, objectKey, size, sha256 FROM _ackerdb_files ` +
        `WHERE ${LIVE_FILE_PREDICATE} AND id <= ? ORDER BY id DESC LIMIT ${FILE_SCAN_BATCH}`,
    );
    const nextStatement = database.query(
      `SELECT id, objectKey, size, sha256 FROM _ackerdb_files ` +
        `WHERE ${LIVE_FILE_PREDICATE} AND id < ? ORDER BY id DESC LIMIT ${FILE_SCAN_BATCH}`,
    );
    let cursor = throughId;
    let first = true;
    for (;;) {
      const page = (first ? firstStatement : nextStatement).all(cursor) as Array<Record<string, unknown>>;
      first = false;
      if (page.length === 0) return;
      for (const row of page) {
        const file = storedFile(row);
        if (file.id > cursor) {
          throw new CorruptDatabaseError("backup File metadata rollback scan did not advance monotonically");
        }
        cursor = file.id;
        await visit(file);
      }
    }
  });
}

export async function createMetadataOnlyFilesBackup(
  databasePath: string,
): Promise<BackupFilesManifest> {
  const totals = await scanStoredFiles(databasePath);
  return { mode: "metadata-only", count: totals.count, bytes: 0 };
}

async function streamToBackupFile(
  store: FileStore,
  file: StoredFile,
  destination: string,
): Promise<void> {
  const opened = await store.open(file.objectKey);
  if (opened.attributes.size !== file.size) {
    throw new CorruptDatabaseError(`File ${file.id} storage size does not match its metadata`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(opened.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      hashing,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    fsyncPathSync(destination);
    if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
      throw new CorruptDatabaseError(`File ${file.id} storage bytes do not match its metadata`);
    }
  } catch (error) {
    try {
      rmSync(destination, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `File ${file.id} backup and candidate cleanup both failed`,
      );
    }
    throw error;
  }
}

export async function createFilesBackup(
  config: AppConfig,
  artifact: string,
  databasePath: string,
): Promise<BackupFilesManifest> {
  const destination = backupFilesPath(artifact);
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  const store = await createFileStore(config.files);
  let published = false;
  try {
    mkdirSync(temporary, { recursive: false, mode: 0o700 });
    const totals = await scanStoredFiles(databasePath, async (file) => {
      await streamToBackupFile(store, file, join(temporary, file.id.toString()));
    });
    fsyncPathSync(temporary);
    renameSync(temporary, destination);
    published = true;
    fsyncPathSync(dirname(destination));
    return { mode: "included", count: totals.count, bytes: totals.bytes };
  } catch (error) {
    const cleanup: unknown[] = [];
    for (const path of published ? [temporary, destination] : [temporary]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanup.push(cleanupError);
      }
    }
    try {
      fsyncPathSync(dirname(destination));
    } catch (cleanupError) {
      cleanup.push(cleanupError);
    }
    if (cleanup.length > 0) {
      throw new AggregateError(
        [error, ...cleanup],
        `File backup creation and artifact cleanup both failed: ${destination}`,
      );
    }
    throw error;
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function backupEntryCount(path: string): number {
  const directory = opendirSync(path);
  let failed = false;
  let failure: unknown;
  let count = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      count = addSafeTotal(count, 1, "directory entry count");
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new CorruptDatabaseError(
          "File backup artifact entries do not match the backup database",
        );
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    directory.closeSync();
  } catch (closeError) {
    if (failed) {
      throw new AggregateError(
        [failure, closeError],
        `File backup directory iteration and close both failed: ${path}`,
      );
    }
    throw closeError;
  }
  if (failed) throw failure;
  return count;
}

async function verifyStoredFile(
  store: FileStore,
  file: StoredFile,
  source: string,
): Promise<void> {
  const opened = await store.open(file.objectKey);
  if (opened.attributes.size !== file.size) {
    await opened.body.cancel(`${source} size does not match File metadata`).catch(() => {});
    throw new CorruptDatabaseError(`${source} for File ${file.id} do not match its metadata`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = opened.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      hash.update(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
    throw new CorruptDatabaseError(`${source} for File ${file.id} do not match its metadata`);
  }
}

export async function verifyFilesBackup(
  artifact: string,
  manifest: BackupFilesManifest,
  databasePath: string,
): Promise<void> {
  const path = backupFilesPath(artifact);
  if (manifest.mode === "metadata-only") {
    if (existsSync(path)) {
      throw new CorruptDatabaseError("metadata-only backup unexpectedly contains a File byte artifact");
    }
    const totals = await scanStoredFiles(databasePath);
    if (manifest.count !== totals.count || manifest.bytes !== 0) {
      throw new CorruptDatabaseError("metadata-only File manifest does not match the backup database");
    }
    return;
  }
  const pathMetadata = existsSync(path) ? lstatSync(path) : null;
  if (pathMetadata === null || !pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()) {
    throw new CorruptDatabaseError(`File backup artifact is not a directory: ${path}`);
  }
  const entries = backupEntryCount(path);
  const totals = await scanStoredFiles(databasePath, async (file) => {
    const backupFile = join(path, file.id.toString());
    const metadata = existsSync(backupFile) ? lstatSync(backupFile) : null;
    if (
      metadata === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== file.size ||
      await fileDigest(backupFile) !== file.sha256
    ) {
      throw new CorruptDatabaseError(`backup bytes for File ${file.id} do not match its metadata`);
    }
  });
  if (
    entries !== totals.count ||
    manifest.count !== totals.count ||
    manifest.bytes !== totals.bytes
  ) {
    throw new CorruptDatabaseError("File backup manifest does not match the backup database");
  }
}

export async function assertRestoreKeysVacant(
  store: FileStore,
  databasePath: string,
): Promise<void> {
  await scanStoredFiles(databasePath, async (file) => {
    try {
      await store.attributes(file.objectKey);
    } catch (error) {
      if (error instanceof FileStoreError && error.code === "not_found") return;
      throw error;
    }
    throw new Error(`restore target File store already contains the object for File ${file.id}`);
  });
}

export function fileRestorePublication(
  config: AppConfig,
  artifact: string,
  store: FileStore,
  databasePath: string,
  mode: BackupFilesManifest["mode"],
): RestorePublicationHook {
  let attemptedThrough: bigint | null = null;
  return {
    ...(config.files.backend === "filesystem"
      ? { allowedTargetSubtrees: [config.files.root] }
      : {}),
    prepare: async () => {
      if (mode === "metadata-only") {
        await scanStoredFiles(databasePath, async (file) => {
          await verifyStoredFile(store, file, "independently restored bytes");
        });
        return;
      }
      await scanStoredFiles(databasePath, async (file) => {
        attemptedThrough = file.id;
        const source = createReadStream(join(backupFilesPath(artifact), file.id.toString()));
        const result = await store.put(
          file.objectKey,
          Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>,
          { contentLength: file.size },
        );
        if (result.size !== file.size || result.sha256 !== file.sha256) {
          throw new CorruptDatabaseError(`restored bytes for File ${file.id} do not match its metadata`);
        }
        await verifyStoredFile(store, file, "provider-persisted restored bytes");
      });
    },
    rollback: async () => {
      if (mode === "metadata-only" || attemptedThrough === null) return;
      let cleanupFailure: unknown;
      let cleanupFailures = 0;
      const recordCleanupFailure = (error: unknown): void => {
        cleanupFailure ??= error;
        cleanupFailures = addSafeTotal(cleanupFailures, 1, "rollback failure count");
      };
      try {
        await scanStoredFilesReverseThrough(databasePath, attemptedThrough, async (file) => {
          try {
            await store.delete(file.objectKey);
          } catch (cleanupError) {
            recordCleanupFailure(cleanupError);
          }
        });
      } catch (scanError) {
        recordCleanupFailure(scanError);
      }
      if (cleanupFailure !== undefined) {
        throw new AggregateError(
          [cleanupFailure],
          `File restore target cleanup did not complete (${cleanupFailures} failures)`,
        );
      }
    },
  };
}
