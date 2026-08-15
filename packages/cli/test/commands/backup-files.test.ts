import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  FileStore,
  FileStoreOpenOptions,
  FileStoreOptions,
} from "@ackerdb/server";
import type { AppConfig } from "../../src/app/config.ts";
import {
  backupFilesPath,
  createMetadataOnlyFilesBackup,
  fileRestorePublication,
  verifyFilesBackup,
  type StoredFile,
} from "../../src/commands/backup-files.ts";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ackerdb-backup-files-"));
  directories.push(path);
  return path;
}

function storedFile(id: bigint, contents = `bytes-${id}`): StoredFile {
  const bytes = new TextEncoder().encode(contents);
  return {
    id,
    objectKey: `opaque-key-${id}`,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function metadataDatabase(root: string, files: readonly StoredFile[]): string {
  const path = join(root, `metadata-${crypto.randomUUID()}.db`);
  const database = new Database(path, { create: true });
  try {
    database.exec(
      "CREATE TABLE _ackerdb_files (" +
        "id INTEGER PRIMARY KEY, state TEXT NOT NULL, objectKey TEXT NOT NULL, " +
        "size INTEGER NOT NULL, sha256 TEXT NOT NULL)",
    );
    const insert = database.query(
      "INSERT INTO _ackerdb_files (id, state, objectKey, size, sha256) VALUES (?, 'active', ?, ?, ?)",
    );
    for (const file of files) {
      insert.run(file.id, file.objectKey, BigInt(file.size), file.sha256);
    }
  } finally {
    database.close(false);
  }
  return path;
}

function writeFilesArtifact(artifact: string, files: readonly StoredFile[]): void {
  mkdirSync(backupFilesPath(artifact));
  for (const file of files) {
    writeFileSync(join(backupFilesPath(artifact), file.id.toString()), `bytes-${file.id}`);
  }
}

function config(root: string): AppConfig {
  return {
    files: {
      backend: "filesystem",
      root: join(root, "store"),
      publicUrl: "https://files.example.test/",
      maxBytes: 1024,
    },
  } as AppConfig;
}

class CorruptingStore implements FileStore {
  bytes = new Uint8Array();
  puts = 0;
  opens = 0;
  deletes = 0;

  async probe(): Promise<void> {}

  async identity(): Promise<string> {
    return "test:corrupting";
  }

  async put(_key: string, body: ReadableStream<Uint8Array>) {
    this.puts++;
    const source = new Uint8Array(await new Response(body).arrayBuffer());
    this.bytes = source.slice();
    this.bytes[0] = this.bytes[0]! ^ 0xff;
    return {
      size: source.byteLength,
      sha256: createHash("sha256").update(source).digest("hex"),
    };
  }

  async open(_key: string, _options?: FileStoreOpenOptions) {
    this.opens++;
    return {
      attributes: { size: this.bytes.byteLength, lastModified: new Date(0) },
      body: new Blob([this.bytes]).stream(),
    };
  }

  async attributes(_key: string, _options?: FileStoreOptions) {
    return { size: this.bytes.byteLength, lastModified: new Date(0) };
  }

  async delete(): Promise<void> {
    this.deletes++;
    this.bytes = new Uint8Array();
  }
}

class MemoryStore implements FileStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  corruptOpenFor: string | undefined;

  async probe(): Promise<void> {}

  async identity(): Promise<string> {
    return "test:memory";
  }

  async put(key: string, body: ReadableStream<Uint8Array>) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, bytes);
    return {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async open(key: string, _options?: FileStoreOpenOptions) {
    const stored = this.objects.get(key);
    if (stored === undefined) throw new Error(`missing test object ${key}`);
    const bytes = stored.slice();
    if (key === this.corruptOpenFor) bytes[0] = bytes[0]! ^ 0xff;
    return {
      attributes: { size: bytes.byteLength, lastModified: new Date(0) },
      body: new Blob([bytes]).stream(),
    };
  }

  async attributes(key: string, _options?: FileStoreOptions) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`missing test object ${key}`);
    return { size: bytes.byteLength, lastModified: new Date(0) };
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

test("restore reopens provider-persisted bytes before database publication", async () => {
  const root = directory();
  const artifact = join(root, "backup.db");
  mkdirSync(backupFilesPath(artifact));
  const bytes = new TextEncoder().encode("verified source bytes");
  writeFileSync(join(backupFilesPath(artifact), "1"), bytes);
  const file: StoredFile = {
    id: 1n,
    objectKey: "opaque-key",
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const databasePath = metadataDatabase(root, [file]);
  const store = new CorruptingStore();
  const publication = fileRestorePublication(config(root), artifact, store, databasePath, "included");

  await expect(publication.prepare({} as never)).rejects.toThrow(
    "provider-persisted restored bytes for File 1 do not match",
  );
  expect({ puts: store.puts, opens: store.opens }).toEqual({ puts: 1, opens: 1 });
  await publication.rollback();
  expect(store.deletes).toBe(1);
});

test("restore rollback rescans more than one metadata page in reverse", async () => {
  const root = directory();
  const artifact = join(root, "backup.db");
  const files = Array.from({ length: 130 }, (_, index) => storedFile(BigInt(index + 1)));
  const databasePath = metadataDatabase(root, files);
  writeFilesArtifact(artifact, files);
  const store = new MemoryStore();
  store.corruptOpenFor = files.at(-1)!.objectKey;
  const publication = fileRestorePublication(
    config(root),
    artifact,
    store,
    databasePath,
    "included",
  );

  await expect(publication.prepare({} as never)).rejects.toThrow(
    "provider-persisted restored bytes for File 130 do not match",
  );
  await publication.rollback();

  expect(store.deleted).toEqual([...files].reverse().map((file) => file.objectKey));
  expect(store.objects.size).toBe(0);
});

test("restore rejects source corruption from the hash produced by store.put", async () => {
  const root = directory();
  const artifact = join(root, "backup.db");
  const file = storedFile(1n);
  const databasePath = metadataDatabase(root, [file]);
  mkdirSync(backupFilesPath(artifact));
  writeFileSync(join(backupFilesPath(artifact), "1"), "bytes-X");
  const store = new MemoryStore();
  const publication = fileRestorePublication(
    config(root),
    artifact,
    store,
    databasePath,
    "included",
  );

  await expect(publication.prepare({} as never)).rejects.toThrow(
    "restored bytes for File 1 do not match its metadata",
  );
  await publication.rollback();

  expect(store.deleted).toEqual([file.objectKey]);
  expect(store.objects.size).toBe(0);
});

test("metadata-only rollback never deletes independently restored bytes", async () => {
  const root = directory();
  const artifact = join(root, "backup.db");
  const file = storedFile(1n);
  const databasePath = metadataDatabase(root, [file]);
  const store = new MemoryStore();
  store.objects.set(file.objectKey, new TextEncoder().encode("bytes-1"));
  const publication = fileRestorePublication(
    config(root),
    artifact,
    store,
    databasePath,
    "metadata-only",
  );

  await publication.prepare({} as never);
  await publication.rollback();

  expect(store.deleted).toEqual([]);
  expect(new TextDecoder().decode(store.objects.get(file.objectKey))).toBe("bytes-1");
});

test("bounded metadata scans reject duplicate object keys across pages", async () => {
  const root = directory();
  const files = Array.from({ length: 129 }, (_, index) => {
    const file = storedFile(BigInt(index + 1));
    return index === 128 ? { ...file, objectKey: "opaque-key-1" } : file;
  });
  const databasePath = metadataDatabase(root, files);

  await expect(createMetadataOnlyFilesBackup(databasePath)).rejects.toThrow(
    "duplicate File object keys",
  );
});

test("directory verification rejects an unexpected entry without collecting or sorting names", async () => {
  const root = directory();
  const artifact = join(root, "backup.db");
  const files = [storedFile(1n), storedFile(2n)];
  const databasePath = metadataDatabase(root, files);
  writeFilesArtifact(artifact, files);
  writeFileSync(join(backupFilesPath(artifact), "unexpected"), "unrelated");

  await expect(verifyFilesBackup(
    artifact,
    { mode: "included", count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) },
    databasePath,
  )).rejects.toThrow("File backup manifest does not match the backup database");
});

test("metadata scans reject a File byte total outside the safe manifest range", async () => {
  const root = directory();
  const digest = createHash("sha256").update("").digest("hex");
  const databasePath = metadataDatabase(root, [
    { id: 1n, objectKey: "one", size: Number.MAX_SAFE_INTEGER, sha256: digest },
    { id: 2n, objectKey: "two", size: 1, sha256: digest },
  ]);

  await expect(createMetadataOnlyFilesBackup(databasePath)).rejects.toThrow(
    "File byte total exceeds the safe manifest range",
  );
});
