import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Engine,
  type FileStore,
} from "@ackerdb/server";
import {
  recordVerifiedFileStoreTransition,
  resolveFileStoreBinding,
} from "@ackerdb/server/files/binding";
import {
  databasePath,
  resolveFilesConfig,
  type AppConfig,
} from "../app/config.ts";
import { importEntrypoint } from "../app/manifest.ts";
import { createFileStore } from "./store.ts";
import {
  migrateFileStore,
  type FileStoreMigrationCompleteReport,
  type FileStoreMigrationProgressEvent,
} from "./migrate.ts";
import { fsyncPathSync, runWithCleanup, runWithCleanupAsync } from "../shared/fsync.ts";

const CONFIG_NAME = ".ackerdb.config.json";
const MAX_TARGET_DESCRIPTOR_BYTES = 64 * 1024;

interface ConfigSnapshot {
  readonly path: string;
  readonly contents: string | null;
  readonly document: Record<string, unknown>;
  readonly mode: number;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readTargetDescriptor(path: string): Record<string, unknown> {
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`FileStore target descriptor must be a regular file: ${path}`);
  if (metadata.size > MAX_TARGET_DESCRIPTOR_BYTES) {
    throw new Error(`FileStore target descriptor exceeds ${MAX_TARGET_DESCRIPTOR_BYTES} bytes`);
  }
  return jsonObject(JSON.parse(readFileSync(path, "utf8")), "FileStore target descriptor");
}

function configSnapshot(appDir: string): ConfigSnapshot {
  const path = join(appDir, CONFIG_NAME);
  if (!existsSync(path)) return { path, contents: null, document: {}, mode: 0o600 };
  const metadata = lstatSync(path);
  if (!metadata.isFile()) throw new Error(`application configuration must be a regular file: ${path}`);
  const contents = readFileSync(path, "utf8");
  return {
    path,
    contents,
    document: jsonObject(JSON.parse(contents), "application configuration"),
    mode: metadata.mode & 0o777,
  };
}

function unchanged(snapshot: ConfigSnapshot): boolean {
  return snapshot.contents === null
    ? !existsSync(snapshot.path)
    : existsSync(snapshot.path) && readFileSync(snapshot.path, "utf8") === snapshot.contents;
}

function publishActiveFilesConfig(
  snapshot: ConfigSnapshot,
  target: Readonly<Record<string, unknown>>,
): void {
  if (!unchanged(snapshot)) {
    throw new Error(
      `FileStore migration completed, but ${snapshot.path} changed during maintenance; ` +
        "the active FileStore was not switched",
    );
  }
  const temporary = join(
    dirname(snapshot.path),
    `.${basename(snapshot.path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let published = false;
  try {
    const descriptor = openSync(temporary, "wx", snapshot.mode);
    runWithCleanup(
      () => {
        writeFileSync(descriptor, `${JSON.stringify({ ...snapshot.document, files: target }, null, 2)}\n`);
        fsyncSync(descriptor);
      },
      () => closeSync(descriptor),
      `configuration write and descriptor close both failed: ${temporary}`,
    );
    if (!unchanged(snapshot)) {
      throw new Error(
        `FileStore migration completed, but ${snapshot.path} changed during maintenance; ` +
          "the active FileStore was not switched",
      );
    }
    renameSync(temporary, snapshot.path);
    published = true;
    try {
      fsyncPathSync(dirname(snapshot.path));
    } catch (error) {
      throw new Error(
        `FileStore configuration was replaced at ${snapshot.path}, but its directory sync failed; ` +
          "publication crash durability is indeterminate",
        { cause: error },
      );
    }
  } finally {
    if (!published) rmSync(temporary, { force: true });
  }
}

function journalPath(
  config: AppConfig,
  engine: Engine,
  sourceIdentity: string,
  targetIdentity: string,
): string {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    database: engine.path,
    commitVersion: engine.commitVersion().toString(),
    schemaFingerprint: engine.schemaFingerprint(),
    sourceIdentity,
    targetIdentity,
  })).digest("hex");
  return join(config.dbDir, "file-store-migrations", `${fingerprint}.jsonl`);
}

function containsPath(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested === "" || (
    nested !== ".." &&
    !nested.startsWith(`..${sep}`) &&
    !isAbsolute(nested)
  );
}

function closeAfter<T>(engine: Engine, work: () => Promise<T>): Promise<T> {
  return runWithCleanupAsync(
    work,
    () => engine.close("clean"),
    "FileStore migration and database close both failed",
  );
}

/** Run one offline migration and publish its target as the app's active FileStore. */
export async function migrateActiveFileStore(
  config: AppConfig,
  targetDescriptorPath: string,
  onProgress?: (event: FileStoreMigrationProgressEvent) => void | Promise<void>,
): Promise<FileStoreMigrationCompleteReport> {
  const snapshot = configSnapshot(config.appDir);
    const targetRaw = readTargetDescriptor(resolve(targetDescriptorPath));
    const targetDocument = {
      publicUrl: config.files.publicUrl,
      maxBytes: config.files.maxBytes,
      ...targetRaw,
    };
    const targetFiles = resolveFilesConfig(targetDocument, config);
    const source: FileStore = await createFileStore(config.files);
    const target: FileStore = await createFileStore(targetFiles);
    const sourceIdentity = await source.identity();
    const targetIdentity = await target.identity();
    if (sourceIdentity === targetIdentity) {
      throw new Error("FileStore migration target is the active physical FileStore");
    }
    if (
      config.files.backend === "filesystem" &&
      targetFiles.backend === "filesystem" &&
      (
        containsPath(config.files.root, targetFiles.root) ||
        containsPath(targetFiles.root, config.files.root)
      )
    ) {
      throw new Error("filesystem migration source and target roots must not overlap");
    }

    const database = databasePath(config);
    if (!existsSync(database) || !statSync(database).isFile() || statSync(database).size === 0) {
      throw new Error(`AckerDB database not found at ${database}`);
    }
    const app = await importEntrypoint(config);
    const engine = new Engine(app.schema, database, {
      durability: config.durability,
      integrityCheck: "full",
    });
    return closeAfter(engine, async () => {
      resolveFileStoreBinding(engine, sourceIdentity);
      const report = await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity,
        targetIdentity,
        journalPath: journalPath(config, engine, sourceIdentity, targetIdentity),
        onProgress,
      });
      recordVerifiedFileStoreTransition(engine, sourceIdentity, targetIdentity);
      publishActiveFilesConfig(snapshot, targetDocument);
      resolveFileStoreBinding(engine, targetIdentity);
      return report;
    });
}
