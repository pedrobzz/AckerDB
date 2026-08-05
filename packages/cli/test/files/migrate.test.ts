import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineSchema,
  Engine,
  LocalFileStore,
  reconcile,
  type FileStore,
  type FileStoreOpenOptions,
  type FileStoreOptions,
  type FileStorePutOptions,
} from "@ackerdb/server";
import {
  FileStoreMigrationError,
  migrateFileStore,
  type FileStoreMigrationProgressEvent,
} from "../../src/files/migrate.ts";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ackerdb-file-store-migration-"));
  directories.push(path);
  return path;
}

function seedFile(
  engine: Engine,
  row: {
    readonly state: "pending" | "active" | "deleting";
    readonly objectKey: string;
    readonly size: number;
    readonly sha256: string;
  },
): void {
  engine.writer.query(`
    INSERT INTO _ackerdb_files (
      state, objectKey, owner, size, sha256, contentType, name, createdAt, pendingExpiresAt
    ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?)
  `).run(
    row.state,
    row.objectKey,
    row.size,
    row.sha256,
    1_700_000_000_000,
    row.state === "pending" ? 1_700_086_400_000 : null,
  );
}

async function text(store: FileStore, objectKey: string): Promise<string> {
  const opened = await store.open(objectKey);
  return await new Response(opened.body).text();
}

async function putText(store: FileStore, objectKey: string, value: string): Promise<void> {
  const body = new Blob([value]);
  await store.put(objectKey, body.stream(), { contentLength: body.size });
}

class DelegatingStore implements FileStore {
  constructor(protected readonly delegate: FileStore) {}

  probe(options?: FileStoreOptions) {
    return this.delegate.probe(options);
  }

  put(key: string, body: ReadableStream<Uint8Array>, options: FileStorePutOptions) {
    return this.delegate.put(key, body, options);
  }

  open(key: string, options?: FileStoreOpenOptions) {
    return this.delegate.open(key, options);
  }

  attributes(key: string, options?: FileStoreOptions) {
    return this.delegate.attributes(key, options);
  }

  delete(key: string, options?: FileStoreOptions) {
    return this.delegate.delete(key, options);
  }
}

class FailOnceOnPutStore extends DelegatingStore {
  #failed = false;

  constructor(delegate: FileStore, private readonly failedKey: string) {
    super(delegate);
  }

  override put(key: string, body: ReadableStream<Uint8Array>, options: FileStorePutOptions) {
    if (key === this.failedKey && !this.#failed) {
      this.#failed = true;
      return Promise.reject(new Error("planned target interruption"));
    }
    return super.put(key, body, options);
  }
}

class RejectOpenKeyStore extends DelegatingStore {
  constructor(delegate: FileStore, private readonly rejectedKey: string) {
    super(delegate);
  }

  override open(key: string, options?: FileStoreOpenOptions) {
    if (key === this.rejectedKey) {
      return Promise.reject(new Error(`checkpointed object was revisited: ${key}`));
    }
    return super.open(key, options);
  }
}

class CorruptingPutStore extends DelegatingStore {
  override async put(key: string, body: ReadableStream<Uint8Array>, options: FileStorePutOptions) {
    const input = new Uint8Array(await new Response(body).arrayBuffer());
    await this.delegate.put(key, new Blob(["corrupt bytes"]).stream(), options);
    return {
      size: input.byteLength,
      sha256: createHash("sha256").update(input).digest("hex"),
    };
  }
}

class MisreportedSizeStore extends DelegatingStore {
  override async open(key: string, options?: FileStoreOpenOptions) {
    const opened = await super.open(key, options);
    return {
      ...opened,
      attributes: { ...opened.attributes, size: opened.attributes.size + 1 },
    };
  }
}

describe("FileStore maintenance migration", () => {
  test("reports only bounded aggregate progress after durable checkpoints", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    const events: FileStoreMigrationProgressEvent[] = [];
    reconcile(engine);

    try {
      for (let index = 0; index < 65; index += 1) {
        const objectKey = `files/progress-${index.toString().padStart(2, "0")}`;
        await putText(source, objectKey, "x");
        seedFile(engine, {
          state: "active",
          objectKey,
          size: 1,
          sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
        });
      }

      await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath: join(root, "file-store-migration.jsonl"),
        onProgress: (event) => {
          events.push(event);
        },
      });

      expect(events).toEqual([
        expect.objectContaining({
          state: "running",
          objects: expect.objectContaining({ total: 65, completed: 64 }),
          bytes: expect.objectContaining({ total: 65, completed: 64 }),
        }),
        expect.objectContaining({
          state: "complete",
          objects: expect.objectContaining({ total: 65, completed: 65 }),
          bytes: expect.objectContaining({ total: 65, completed: 65 }),
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("files/progress-");
    } finally {
      engine.close("clean");
    }
  });

  test("copies and verifies every live File without touching deleting bytes or the source", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    const journalPath = join(root, "file-store-migration.jsonl");
    reconcile(engine);

    try {
      await putText(source, "files/active", "hello world");
      await putText(source, "files/pending", "second object");
      await putText(source, "files/deleting", "do not copy");
      seedFile(engine, {
        state: "active",
        objectKey: "files/active",
        size: 11,
        sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      });
      seedFile(engine, {
        state: "pending",
        objectKey: "files/pending",
        size: 13,
        sha256: "30c5ed406cd20934a53644a852b4e8c81e5de8d0447d3b0a2bbd08c2c1143d10",
      });
      seedFile(engine, {
        state: "deleting",
        objectKey: "files/deleting",
        size: 11,
        sha256: "1c0f02019cdbf3a1e52332cb8c7c7b2779267256316af9d8efcb66a60bf94d9e",
      });

      const report = await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      });

      expect(report).toMatchObject({
        format: 1,
        operation: "file-store-migration",
        state: "complete",
        objects: { total: 2, completed: 2, copied: 2, alreadyPresent: 0, resumed: 0 },
        bytes: { total: 24, completed: 24, copied: 24, alreadyPresent: 0, resumed: 0 },
      });
      expect(await text(target, "files/active")).toBe("hello world");
      expect(await text(target, "files/pending")).toBe("second object");
      await expect(target.open("files/deleting")).rejects.toMatchObject({ code: "not_found" });
      expect(await text(source, "files/active")).toBe("hello world");
      expect(readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ type: "header", format: 1 }),
        expect.objectContaining({ type: "object", objectKey: "files/active", outcome: "copied" }),
        expect.objectContaining({ type: "object", objectKey: "files/pending", outcome: "copied" }),
        expect.objectContaining({ type: "complete", objects: 2, bytes: 24 }),
      ]);
    } finally {
      engine.close("clean");
    }
  });

  test("resumes after the last durably verified object following an interrupted copy", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    const journalPath = join(root, "file-store-migration.jsonl");
    reconcile(engine);

    try {
      await putText(source, "files/first", "hello world");
      await putText(source, "files/second", "second object");
      seedFile(engine, {
        state: "active",
        objectKey: "files/first",
        size: 11,
        sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      });
      seedFile(engine, {
        state: "active",
        objectKey: "files/second",
        size: 13,
        sha256: "30c5ed406cd20934a53644a852b4e8c81e5de8d0447d3b0a2bbd08c2c1143d10",
      });

      try {
        await migrateFileStore({
          engine,
          source,
          target: new FailOnceOnPutStore(target, "files/second"),
          sourceIdentity: "filesystem:source",
          targetIdentity: "filesystem:target",
          journalPath,
        });
        throw new Error("expected migration interruption");
      } catch (error) {
        expect(error).toBeInstanceOf(FileStoreMigrationError);
        expect((error as FileStoreMigrationError).report).toMatchObject({
          state: "failed",
          failure: { stage: "target-copy", file: { objectKey: "files/second" } },
          objects: { total: 2, completed: 1, copied: 1, resumed: 0 },
          bytes: { total: 24, completed: 11, copied: 11, resumed: 0 },
        });
      }

      await expect(migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:different-target",
        journalPath,
      })).rejects.toMatchObject({
        report: { state: "failed", failure: { stage: "journal" } },
      });
      await expect(target.open("files/second")).rejects.toMatchObject({ code: "not_found" });

      appendFileSync(journalPath, '{"type":"object","id":');

      const resumed = await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      });

      expect(resumed).toMatchObject({
        state: "complete",
        objects: { total: 2, completed: 2, copied: 2, alreadyPresent: 0, resumed: 1 },
        bytes: { total: 24, completed: 24, copied: 24, alreadyPresent: 0, resumed: 11 },
      });
      expect(await text(target, "files/first")).toBe("hello world");
      expect(await text(target, "files/second")).toBe("second object");
      expect(readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ type: "header" }),
        expect.objectContaining({ type: "object", objectKey: "files/first" }),
        expect.objectContaining({ type: "object", objectKey: "files/second" }),
        expect.objectContaining({ type: "complete", objects: 2, bytes: 24 }),
      ]);
    } finally {
      engine.close("clean");
    }
  });

  test("advances progress only after reopening and hashing the persisted target object", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    const journalPath = join(root, "file-store-migration.jsonl");
    reconcile(engine);

    try {
      await putText(source, "files/verified", "correct bytes");
      seedFile(engine, {
        state: "active",
        objectKey: "files/verified",
        size: 13,
        sha256: "5eaea7c98539b6faac2e243276605f2b5ee19747e66cd13a54706abd48b66582",
      });

      try {
        await migrateFileStore({
          engine,
          source,
          target: new CorruptingPutStore(target),
          sourceIdentity: "filesystem:source",
          targetIdentity: "filesystem:target",
          journalPath,
        });
        throw new Error("expected persisted-target verification failure");
      } catch (error) {
        expect(error).toBeInstanceOf(FileStoreMigrationError);
        expect((error as FileStoreMigrationError).report).toMatchObject({
          state: "failed",
          failure: { stage: "target-verification", file: { objectKey: "files/verified" } },
          objects: { total: 1, completed: 0, copied: 0 },
          bytes: { total: 13, completed: 0, copied: 0 },
        });
      }
      expect(await text(target, "files/verified")).toBe("corrupt bytes");
      expect(readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ type: "header" }),
      ]);

      const recovered = await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      });
      expect(recovered).toMatchObject({
        state: "complete",
        objects: { total: 1, completed: 1, copied: 1, alreadyPresent: 0, resumed: 0 },
        bytes: { total: 13, completed: 13, copied: 13, alreadyPresent: 0, resumed: 0 },
      });
      expect(await text(target, "files/verified")).toBe("correct bytes");
      expect(await text(source, "files/verified")).toBe("correct bytes");
    } finally {
      engine.close("clean");
    }
  });

  test("verifies the target before attempting to read the source object", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    reconcile(engine);

    try {
      await putText(target, "files/present", "hello world");
      seedFile(engine, {
        state: "active",
        objectKey: "files/present",
        size: 11,
        sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      });

      const report = await migrateFileStore({
        engine,
        source: new RejectOpenKeyStore(source, "files/present"),
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath: join(root, "file-store-migration.jsonl"),
      });

      expect(report).toMatchObject({
        state: "complete",
        objects: { total: 1, completed: 1, copied: 0, alreadyPresent: 1, resumed: 0 },
        bytes: { total: 11, completed: 11, copied: 0, alreadyPresent: 11, resumed: 0 },
      });
      expect(await text(target, "files/present")).toBe("hello world");
    } finally {
      engine.close("clean");
    }
  });

  test("rejects provider attributes that disagree with the target byte stream", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    reconcile(engine);

    try {
      await putText(source, "files/attributes", "correct bytes");
      await putText(target, "files/attributes", "correct bytes");
      seedFile(engine, {
        state: "active",
        objectKey: "files/attributes",
        size: 13,
        sha256: "5eaea7c98539b6faac2e243276605f2b5ee19747e66cd13a54706abd48b66582",
      });

      await expect(migrateFileStore({
        engine,
        source,
        target: new MisreportedSizeStore(target),
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath: join(root, "file-store-migration.jsonl"),
      })).rejects.toMatchObject({
        report: {
          state: "failed",
          failure: { stage: "target-verification", file: { objectKey: "files/attributes" } },
        },
      });
    } finally {
      engine.close("clean");
    }
  });

  test("re-verifies every target object before accepting an already-complete journal", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    const journalPath = join(root, "file-store-migration.jsonl");
    reconcile(engine);

    try {
      await putText(source, "files/complete", "correct bytes");
      seedFile(engine, {
        state: "active",
        objectKey: "files/complete",
        size: 13,
        sha256: "5eaea7c98539b6faac2e243276605f2b5ee19747e66cd13a54706abd48b66582",
      });
      await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      });
      await putText(target, "files/complete", "corrupt bytes");

      await expect(migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      })).rejects.toMatchObject({
        report: {
          state: "failed",
          failure: {
            stage: "final-verification",
            file: { objectKey: "files/complete" },
          },
        },
      });
    } finally {
      engine.close("clean");
    }
  });

  test("binds the journal to every live File's object key, size, and digest", async () => {
    const root = directory();
    const engine = new Engine(defineSchema({}), join(root, "data.db"));
    const source = new LocalFileStore({ root: join(root, "source") });
    const target = new LocalFileStore({ root: join(root, "target") });
    const journalPath = join(root, "file-store-migration.jsonl");
    reconcile(engine);

    try {
      await putText(source, "files/first", "hello world");
      await putText(source, "files/second", "second object");
      seedFile(engine, {
        state: "active",
        objectKey: "files/first",
        size: 11,
        sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      });
      seedFile(engine, {
        state: "active",
        objectKey: "files/second",
        size: 13,
        sha256: "30c5ed406cd20934a53644a852b4e8c81e5de8d0447d3b0a2bbd08c2c1143d10",
      });
      await migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      });
      const header = JSON.parse(readFileSync(journalPath, "utf8").split("\n")[0]!);
      expect(header.manifestFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const commitVersion = engine.commitVersion();
      engine.writer.query(
        "UPDATE _ackerdb_files SET objectKey = ? WHERE objectKey = ?",
      ).run("files/replaced", "files/first");
      expect(engine.commitVersion()).toBe(commitVersion);

      await expect(migrateFileStore({
        engine,
        source,
        target,
        sourceIdentity: "filesystem:source",
        targetIdentity: "filesystem:target",
        journalPath,
      })).rejects.toMatchObject({
        report: {
          state: "failed",
          failure: { stage: "journal" },
        },
      });
    } finally {
      engine.close("clean");
    }
  });
});
