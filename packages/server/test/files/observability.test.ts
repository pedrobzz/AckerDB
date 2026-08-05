import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err, Status, type FileId } from "@ackerdb/core";
import { Registry } from "../../src/app/registry.ts";
import { Engine } from "../../src/database/engine.ts";
import type {
  FileStore,
  FileStoreOpenOptions,
  FileStoreOptions,
  FileStorePutOptions,
} from "../../src/files/store/contract.ts";
import { LocalFileStore } from "../../src/files/store/local.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { serve } from "../../src/transport/server.ts";
import type {
  TelemetryMetricRecord,
  TelemetryRecord,
} from "../../src/telemetry/telemetry.ts";

class FailingDeleteStore implements FileStore {
  private failures = 1;

  constructor(private readonly delegate: FileStore) {}

  probe(options?: FileStoreOptions) { return this.delegate.probe(options); }
  put(key: string, body: ReadableStream<Uint8Array>, options: FileStorePutOptions) {
    return this.delegate.put(key, body, options);
  }
  open(key: string, options?: FileStoreOpenOptions) { return this.delegate.open(key, options); }
  attributes(key: string, options?: FileStoreOptions) {
    return this.delegate.attributes(key, options);
  }
  delete(key: string, options?: FileStoreOptions): Promise<void> {
    if (this.failures-- > 0) return Promise.reject(new Error("injected provider failure"));
    return this.delegate.delete(key, options);
  }
}

async function eventually(work: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!work()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

describe("File observability", () => {
  const directories: string[] = [];
  const runtimes: Runtime[] = [];
  const engines: Engine[] = [];
  const servers: ReturnType<typeof serve>[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0).reverse()) await server.drain().catch(() => {});
    for (const runtime of runtimes.splice(0).reverse()) await runtime.drain().catch(() => {});
    for (const engine of engines.splice(0).reverse()) engine.close("clean");
    for (const directory of directories.splice(0).reverse()) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("status keeps exact File usage through committed lifecycle changes and restart hydration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-file-observability-"));
    directories.push(directory);
    const engine = new Engine(defineSchema({}), join(directory, "data.db"));
    engines.push(engine);
    reconcile(engine);
    const store = new LocalFileStore({ root: join(directory, "files") });
    const runtime = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: false,
      files: { store },
    });
    runtimes.push(runtime);

    await runtime.system.run("test.files.active", async (ctx) => {
      const fileId = await ctx.files.store(new Blob(["four"]).stream(), { size: 4 });
      await ctx.tx((tx) => tx.files.claim(fileId));
      return fileId;
    });
    const pending = await runtime.system.run("test.files.pending", (ctx) =>
      ctx.files.store(new Blob(["sixsix"]).stream(), { size: 6 }));
    const rejectedClaim = await runtime.system.run("test.files.rejected-claim", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.claim(pending);
        return Err("rejected", {}, Status.Conflict);
      }));
    expect(rejectedClaim.ok).toBe(false);

    expect(runtime.status().files).toMatchObject({
      pending: { count: 1, bytes: 6 },
      active: { count: 1, bytes: 4 },
      deleting: { count: 0, bytes: 0 },
    });

    await runtime.drain();
    runtimes.pop();
    const restarted = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: false,
      files: { store },
    });
    runtimes.push(restarted);
    expect(restarted.status().files).toMatchObject({
      pending: { count: 1, bytes: 6 },
      active: { count: 1, bytes: 4 },
      deleting: { count: 0, bytes: 0 },
    });
  });

  test("status exposes cleanup backlog, oldest age, failures, and provider errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-file-cleanup-observability-"));
    directories.push(directory);
    const engine = new Engine(defineSchema({}), join(directory, "data.db"));
    engines.push(engine);
    reconcile(engine);
    const store = new FailingDeleteStore(
      new LocalFileStore({ root: join(directory, "files") }),
    );
    const runtime = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: false,
      files: { store },
    });
    runtimes.push(runtime);

    await runtime.system.run("test.files.delete", async (ctx) => {
      const fileId = await ctx.files.store(new Blob(["delete-me"]).stream(), { size: 9 });
      await ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        await tx.files.delete(fileId);
      });
      return fileId;
    });

    await eventually(() => runtime.status().files.cleanup.failures === 1);
    expect(runtime.status().files).toMatchObject({
      pending: { count: 0, bytes: 0 },
      active: { count: 0, bytes: 0 },
      deleting: { count: 1, bytes: 9 },
      cleanup: { backlog: 1, failures: 1 },
      providerErrors: { total: 1, delete: 1 },
    });
    expect(runtime.status().files.cleanup.oldestAgeMs).toBeGreaterThanOrEqual(0);
  });

  test("status counts upload and streamed download bytes, latency, and outcomes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-file-transfer-observability-"));
    directories.push(directory);
    const engine = new Engine(defineSchema({}), join(directory, "data.db"));
    engines.push(engine);
    reconcile(engine);
    const telemetryRecords: TelemetryRecord[] = [];
    const runtime = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: {
        exporter: {
          export(batch) {
            telemetryRecords.push(...batch);
          },
        },
        localSink: false,
        limits: { batchIntervalMs: 5, sampleIntervalMs: 10 },
      },
      files: {
        publicUrl: "http://127.0.0.1/",
        store: new LocalFileStore({ root: join(directory, "files") }),
      },
    });
    runtimes.push(runtime);
    const server = serve({ runtime, port: 0 });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const session = await runtime.system.run("test.files.session", (ctx) =>
      ctx.tx((tx) => tx.files.createUpload({ contentTypes: ["text/plain"] })));
    if (!session.ok) throw session.error;
    const upload = await fetch(`${base}${new URL(session.data.url).pathname}`, {
      method: "PUT",
      body: "hello-files",
      headers: { "content-type": "text/plain" },
    });
    const fileId = BigInt((await upload.json() as { fileId: string }).fileId) as FileId;
    const grant = await runtime.system.run("test.files.grant", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        return tx.files.createGrant(fileId, {
          access: { type: "bearer" },
          permanent: true,
        });
      }));
    if (!grant.ok) throw grant.error;
    const download = await fetch(`${base}${new URL(grant.data.url).pathname}`);
    expect(await download.text()).toBe("hello-files");
    expect((await fetch(`${base}/api/_files/grants/999.${"x".repeat(43)}`)).status).toBe(404);

    const rejectedSession = await runtime.system.run("test.files.rejected-session", (ctx) =>
      ctx.tx((tx) => tx.files.createUpload({ contentTypes: ["text/plain"] })));
    if (!rejectedSession.ok) throw rejectedSession.error;
    expect((await fetch(`${base}${new URL(rejectedSession.data.url).pathname}`, {
      method: "PUT",
      body: "bad",
      headers: { "content-type": "application/json" },
    })).status).toBe(415);

    expect(runtime.status().files).toMatchObject({
      upload: {
        operations: 2,
        bytes: 11,
        outcomes: { ok: 1, validation: 1 },
      },
      download: {
        operations: 2,
        bytes: 11,
        outcomes: { ok: 1, not_found: 1 },
      },
    });
    expect(runtime.status().files.upload.latencyMs.max).toBeGreaterThanOrEqual(0);
    expect(runtime.status().files.download.latencyMs.max).toBeGreaterThanOrEqual(0);

    await eventually(() => telemetryRecords.some((record) =>
      record.kind === "metric" &&
      record.name === "runtime.file_download_bytes" &&
      record.value === 11));
    const metrics = telemetryRecords.filter(
      (record): record is TelemetryMetricRecord => record.kind === "metric",
    );
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "runtime.file_active_bytes",
      value: 11,
      unit: "bytes",
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "runtime.file_upload_outcomes",
      value: 1,
      labels: expect.objectContaining({ outcome: "validation" }),
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "runtime.file_download_outcomes",
      value: 1,
      labels: expect.objectContaining({ outcome: "not_found" }),
    }));
  });
});
