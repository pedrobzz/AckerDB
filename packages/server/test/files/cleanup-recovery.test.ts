import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/app/registry.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
} from "../../src/files/tables.ts";
import { FileStoreError } from "../../src/files/store/contract.ts";
import { LocalFileStore } from "../../src/files/store/local.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";

interface InternalTable {
  get(id: bigint): Promise<Record<string, unknown> | null>;
  insert(row: Record<string, unknown>): PromiseLike<bigint>;
}

type InternalDatabase = Readonly<Record<string, InternalTable>>;

interface RuntimeInternals {
  readonly fileCleanup: { stop(): void; drain(): Promise<void>; arm(at: number): void };
  readonly functions: {
    filesRead<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
    filesWrite<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
  };
}

async function eventually(work: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await work())) {
    if (Date.now() >= deadline) throw new Error("File cleanup recovery did not settle");
    await Bun.sleep(5);
  }
}

describe("File cleanup restart recovery", () => {
  let directory: string;
  let engine: Engine;
  let runtime: Runtime;
  let store: LocalFileStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-file-recovery-"));
    engine = new Engine(defineSchema({}), join(directory, "data.db"));
    reconcile(engine);
    store = new LocalFileStore({ root: join(directory, "files") });
    runtime = new Runtime({
      engine,
      registry: new Registry(),
      files: { store },
    });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  test("keeps a clean Files-empty startup read-only", async () => {
    await (runtime as unknown as RuntimeInternals).fileCleanup.drain();

    expect(engine.commitVersion()).toBe(0n);
    expect(runtime.status().writer).toMatchObject({ admitted: 0, completed: 0 });
  });

  test("recovers interrupted File work before admitting a new File writer", async () => {
    const first = runtime as unknown as RuntimeInternals;
    first.fileCleanup.stop();
    const signal = new AbortController().signal;
    const interruptedKey = "files/interrupted-before-admission";
    const uploadId = await first.functions.filesWrite(signal, async (value) =>
      await (value as InternalDatabase)[FILE_UPLOADS_TABLE]!.insert({
        secretHash: "irrecoverable-plain-secret",
        state: "uploading",
        objectKey: interruptedKey,
        owner: null,
        maxBytes: 64,
        contentTypesJson: null,
        expectedSha256: null,
        expiresAt: Date.now() + 60_000,
        fileId: null,
        attemptToken: "dead-attempt",
        createdAt: Date.now() - 1_000,
      }));
    await runtime.drain();

    runtime = new Runtime({
      engine,
      registry: new Registry(),
      files: { store },
    });
    await runtime.start();
    const restarted = runtime as unknown as RuntimeInternals;
    const observed = await restarted.functions.filesWrite(signal, (value) =>
      (value as InternalDatabase)[FILE_UPLOADS_TABLE]!.get(uploadId));

    expect(observed).toMatchObject({ state: "open", attemptToken: null });
    expect(observed?.objectKey).not.toBe(interruptedKey);
  });

  test("reclaims an expired running lease after transient finalization and retry write failures", async () => {
    await runtime.drain();
    let now = Date.now();
    runtime = new Runtime({
      engine,
      registry: new Registry(),
      files: { store },
      now: () => now,
    });
    await runtime.start();
    const first = runtime as unknown as RuntimeInternals;
    await first.fileCleanup.drain();
    first.fileCleanup.stop();

    const signal = new AbortController().signal;
    const objectKey = "files/transient-finalization-failure";
    await store.put(objectKey, new Blob(["delete once"]).stream(), { contentLength: 11 });
    const cleanupId = await first.functions.filesWrite(signal, async (value) =>
      await (value as InternalDatabase)[FILE_CLEANUP_TABLE]!.insert({
        objectKey,
        fileId: null,
        state: "pending",
        attempt: 0,
        runAt: now,
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: now,
      }));
    await runtime.drain();

    engine.writer.exec(`
      CREATE TEMP TRIGGER fail_file_cleanup_finalize
      BEFORE DELETE ON "${FILE_CLEANUP_TABLE}"
      BEGIN SELECT RAISE(ABORT, 'injected cleanup finalization failure'); END;
      CREATE TEMP TRIGGER fail_file_cleanup_retry
      BEFORE UPDATE ON "${FILE_CLEANUP_TABLE}"
      WHEN OLD.state = 'running' AND NEW.state = 'pending'
      BEGIN SELECT RAISE(ABORT, 'injected cleanup retry failure'); END;
    `);
    try {
      runtime = new Runtime({
        engine,
        registry: new Registry(),
        files: { store },
        now: () => now,
      });
      await runtime.start();
      await (runtime as unknown as RuntimeInternals).fileCleanup.drain();
    } finally {
      engine.writer.exec(`
        DROP TRIGGER IF EXISTS fail_file_cleanup_finalize;
        DROP TRIGGER IF EXISTS fail_file_cleanup_retry;
      `);
    }

    const restarted = runtime as unknown as RuntimeInternals;
    expect(await restarted.functions.filesRead(signal, (value) =>
      (value as InternalDatabase)[FILE_CLEANUP_TABLE]!.get(cleanupId)))
      .toMatchObject({ state: "running" });

    const previousNow = now;
    now += 60_001;
    const completed = runtime.status().writer.completed;
    restarted.fileCleanup.arm(previousNow);
    await eventually(async () => runtime.status().writer.completed > completed);
    await restarted.fileCleanup.drain();

    expect(await restarted.functions.filesRead(signal, (value) =>
      (value as InternalDatabase)[FILE_CLEANUP_TABLE]!.get(cleanupId)))
      .toBeNull();
  });

  test("arms future pending File, upload, and grant deadlines without a startup commit", async () => {
    const first = runtime as unknown as RuntimeInternals;
    await first.fileCleanup.drain();
    first.fileCleanup.stop();
    const signal = new AbortController().signal;
    const now = Date.now();
    const expiresAt = now + 250;
    const pendingKey = "files/future-pending";
    await store.put(pendingKey, new Blob(["pending"]).stream(), { contentLength: 7 });
    const ids = await first.functions.filesWrite(signal, async (value) => {
      const db = value as InternalDatabase;
      const pendingFile = await db[FILES_TABLE]!.insert({
        state: "pending",
        objectKey: pendingKey,
        owner: null,
        size: 7,
        sha256: "0".repeat(64),
        contentType: null,
        name: null,
        createdAt: now,
        pendingExpiresAt: expiresAt,
      });
      const activeFile = await db[FILES_TABLE]!.insert({
        state: "active",
        objectKey: "files/grant-owner",
        owner: null,
        size: 0,
        sha256: "0".repeat(64),
        contentType: null,
        name: null,
        createdAt: now,
        pendingExpiresAt: null,
      });
      const upload = await db[FILE_UPLOADS_TABLE]!.insert({
        secretHash: "future-upload",
        state: "open",
        objectKey: "files/future-upload",
        owner: null,
        maxBytes: 64,
        contentTypesJson: null,
        expectedSha256: null,
        expiresAt,
        fileId: null,
        attemptToken: null,
        createdAt: now,
      });
      const grant = await db[FILE_GRANTS_TABLE]!.insert({
        fileId: activeFile,
        secretHash: "future-grant",
        accessType: "bearer",
        authorizeAddress: null,
        authorizeArgsJson: null,
        expiresAt,
        dispositionType: "attachment",
        filename: null,
        createdAt: now,
      });
      return { pendingFile, upload, grant };
    });
    const commitVersion = engine.commitVersion();
    await runtime.drain();

    runtime = new Runtime({
      engine,
      registry: new Registry(),
      files: { store },
    });
    await runtime.start();
    const restarted = runtime as unknown as RuntimeInternals;
    await restarted.fileCleanup.drain();
    expect(engine.commitVersion()).toBe(commitVersion);
    expect(runtime.status().writer).toMatchObject({ admitted: 0, completed: 0 });

    const completedReads = runtime.status().reader.completed;
    restarted.fileCleanup.arm(now - 1);
    await eventually(async () => runtime.status().reader.completed > completedReads);
    await restarted.fileCleanup.drain();
    expect(engine.commitVersion()).toBe(commitVersion);
    expect(runtime.status().writer).toMatchObject({ admitted: 0, completed: 0 });

    await eventually(async () => {
      const rows = await restarted.functions.filesRead(signal, async (value) => {
        const db = value as InternalDatabase;
        return await Promise.all([
          db[FILES_TABLE]!.get(ids.pendingFile),
          db[FILE_UPLOADS_TABLE]!.get(ids.upload),
          db[FILE_GRANTS_TABLE]!.get(ids.grant),
        ]);
      });
      return rows.every((row) => row === null);
    });
  });

  test("reclaims every exclusively owned running task and rotates an interrupted upload key", async () => {
    const first = runtime as unknown as RuntimeInternals;
    // Model an abrupt process exit: stop its worker before the first timer turn,
    // then persist the exact states the next exclusive Runtime must recover.
    first.fileCleanup.stop();
    const signal = new AbortController().signal;
    const runningKey = "files/interrupted-cleanup";
    const stagingKey = "files/interrupted-store";
    const uploadKey = "files/interrupted-upload";
    await store.put(runningKey, new Blob(["old cleanup bytes"]).stream(), { contentLength: 17 });
    await store.put(stagingKey, new Blob(["staged backend bytes"]).stream(), { contentLength: 20 });
    await store.put(uploadKey, new Blob(["ambiguous upload bytes"]).stream(), { contentLength: 22 });
    const uploadId = await first.functions.filesWrite(signal, async (value) => {
      const db = value as InternalDatabase;
      await db[FILE_CLEANUP_TABLE]!.insert({
        objectKey: runningKey,
        fileId: null,
        state: "running",
        attempt: 1,
        runAt: Date.now() - 1,
        leaseToken: "dead-process",
        leaseUntil: Date.now() + 60 * 60_000,
        lastError: null,
        createdAt: Date.now() - 1_000,
      });
      await db[FILE_CLEANUP_TABLE]!.insert({
        objectKey: stagingKey,
        fileId: null,
        state: "staging",
        attempt: 0,
        runAt: Date.now() - 1,
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: Date.now() - 1_000,
      });
      return await db[FILE_UPLOADS_TABLE]!.insert({
        secretHash: "irrecoverable-plain-secret",
        state: "uploading",
        objectKey: uploadKey,
        owner: null,
        maxBytes: 64,
        contentTypesJson: null,
        expectedSha256: null,
        expiresAt: Date.now() + 60_000,
        fileId: null,
        attemptToken: "dead-attempt",
        createdAt: Date.now() - 1_000,
      });
    });
    await runtime.drain();

    runtime = new Runtime({
      engine,
      registry: new Registry(),
      files: { store },
    });
    await runtime.start();
    const restarted = runtime as unknown as RuntimeInternals;
    await eventually(async () => {
      const session = await restarted.functions.filesRead(signal, (value) =>
        (value as InternalDatabase)[FILE_UPLOADS_TABLE]!.get(uploadId));
      if (session?.state !== "open" || session.objectKey === uploadKey) return false;
      for (const key of [runningKey, stagingKey, uploadKey]) {
        try {
          await store.attributes(key);
          return false;
        } catch (error) {
          if (!(error instanceof FileStoreError) || error.code !== "not_found") throw error;
        }
      }
      return true;
    });

    const recovered = await restarted.functions.filesRead(signal, (value) =>
      (value as InternalDatabase)[FILE_UPLOADS_TABLE]!.get(uploadId));
    expect(recovered).toMatchObject({ state: "open", attemptToken: null });
    expect(recovered?.objectKey).not.toBe(uploadKey);
  });
});
