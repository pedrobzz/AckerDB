import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyApi, parseOutcome, type FileId } from "@ackerdb/core";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedCredential,
} from "../../src/auth/credentials.ts";
import { Engine } from "../../src/database/engine.ts";
import { Registry } from "../../src/app/registry.ts";
import { mutation, query } from "../../src/app/functions.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { LocalFileStore } from "../../src/files/store/local.ts";
import type {
  FileStore,
  FileStoreOpenOptions,
  FileStoreOptions,
  FileStorePutOptions,
  FileStoreRange,
} from "../../src/files/store/contract.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { v } from "../../src/validation/v.ts";
import { listen } from "ackerdb-test-support/listen";

class BlockingDeleteStore implements FileStore {
  blockDeletes = false;
  blockOpens = false;
  blockPuts = false;
  openCalls = 0;
  attributesCalls = 0;
  reportedSizeDelta = 0;
  reportedRange: FileStoreRange | "missing" | null = null;
  cancelledOpenBodies = 0;
  readonly putKeys: string[] = [];
  deleteEntered: Promise<void> = Promise.resolve();
  putEntered: Promise<void> = Promise.resolve();
  private failingDeletes = 0;
  private enterDelete: (() => void) | null = null;
  private releaseDelete: (() => void) | null = null;
  private enterPut: (() => void) | null = null;
  private releasePut: (() => void) | null = null;
  private deleteRelease: Promise<void> = Promise.resolve();
  private putRelease: Promise<void> = Promise.resolve();
  private releaseOpen: (() => void) | null = null;
  private openRelease: Promise<void> = Promise.resolve();

  constructor(private readonly delegate: FileStore) {}

  block(): void {
    this.blockDeletes = true;
    this.deleteEntered = new Promise((resolve) => (this.enterDelete = resolve));
    this.deleteRelease = new Promise((resolve) => (this.releaseDelete = resolve));
  }

  release(): void {
    this.blockDeletes = false;
    this.releaseDelete?.();
  }

  blockNextPut(): void {
    this.blockPuts = true;
    this.putEntered = new Promise((resolve) => (this.enterPut = resolve));
    this.putRelease = new Promise((resolve) => (this.releasePut = resolve));
  }

  releaseBlockedPut(): void {
    this.blockPuts = false;
    this.releasePut?.();
  }

  blockOpenBodies(): void {
    this.blockOpens = true;
    this.openRelease = new Promise((resolve) => (this.releaseOpen = resolve));
  }

  releaseOpenBodies(): void {
    this.blockOpens = false;
    this.releaseOpen?.();
  }

  failNextDeletes(count = 1): void {
    this.failingDeletes = count;
  }

  probe(options?: FileStoreOptions) { return this.delegate.probe(options); }
  async put(key: string, body: ReadableStream<Uint8Array>, options: FileStorePutOptions) {
    this.putKeys.push(key);
    if (this.blockPuts) {
      this.enterPut?.();
      await this.putRelease;
    }
    return this.delegate.put(key, body, options);
  }
  async open(key: string, options?: FileStoreOpenOptions) {
    this.openCalls++;
    const opened = await this.delegate.open(key, options);
    const injectedMismatch = this.reportedSizeDelta !== 0 || this.reportedRange !== null;
    const body = this.blockOpens
      ? (() => {
          const reader = opened.body.getReader();
          return new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              await this.openRelease;
              const result = await reader.read();
              if (result.done) controller.close();
              else controller.enqueue(result.value);
            },
            cancel: (reason) => reader.cancel(reason),
          });
        })()
      : opened.body;
    return {
      ...opened,
      attributes: {
        ...opened.attributes,
        size: opened.attributes.size + this.reportedSizeDelta,
      },
      ...(this.reportedRange === null
        ? {}
        : this.reportedRange === "missing"
          ? { range: undefined }
          : { range: this.reportedRange }),
      ...(injectedMismatch
        ? {
            body: new ReadableStream<Uint8Array>({
              cancel: async (reason) => {
                this.cancelledOpenBodies++;
                await opened.body.cancel(reason);
              },
            }),
          }
        : { body }),
    };
  }
  async attributes(key: string, options?: FileStoreOptions) {
    this.attributesCalls++;
    const attributes = await this.delegate.attributes(key, options);
    return { ...attributes, size: attributes.size + this.reportedSizeDelta };
  }
  async delete(key: string, options?: FileStoreOptions): Promise<void> {
    if (this.failingDeletes > 0) {
      this.failingDeletes--;
      throw new Error("injected File Store delete failure");
    }
    if (this.blockDeletes) {
      this.enterDelete?.();
      await this.deleteRelease;
    }
    await this.delegate.delete(key, options);
  }
}

async function eventually(work: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await work())) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

function uuidV7(sequence: number): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

// Runtime integration is the boundary under test, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let authorizationCalls = 0;

const functions = {
  files: {
    createUpload: mutation({
      access: "authenticated",
      http: true,
      args: {},
      handler: (ctx: Ctx) => ctx.files.createUploadSession({ maxBytes: 64 }),
    }),
    canDownload: query({
      access: "authenticated",
      args: { organizationId: v.bigint(), fileId: v.file() },
      handler: (_ctx, args) => {
        authorizationCalls++;
        return args.organizationId === 7n;
      },
    }),
  },
};

class TestVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;

  async verify(token: string): Promise<VerifiedCredential> {
    if (token !== "user-token" && token !== "workload-token") {
      throw new AckerDBError("unauthenticated", "invalid credential");
    }
    return {
      kind: token === "user-token" ? "user" : "workload",
      issuer: "https://issuer.example",
      subject: token === "user-token" ? "user" : "workload",
      claims: { role: "member" },
      expiresAt: Date.now() + 60_000,
      tokenId: "user-token-id",
    };
  }

  subscribeInvalidation(_listener: (invalidation: PrincipalInvalidation) => void): () => void {
    return () => {};
  }
}

describe("File HTTP flow", () => {
  let directory: string;
  let engine: Engine;
  let runtime: Runtime;
  let server: ReturnType<typeof listen>;
  let base: string;
  let fileStore: BlockingDeleteStore;

  beforeEach(async () => {
    authorizationCalls = 0;
    directory = mkdtempSync(join(tmpdir(), "ackerdb-file-http-"));
    engine = new Engine(defineSchema({
      documents: defineTable({ id: v.primaryKey(), file: v.file() }),
    }), join(directory, "data.db"));
    reconcile(engine);
    fileStore = new BlockingDeleteStore(new LocalFileStore({ root: join(directory, "files") }));
    runtime = new Runtime({
      engine,
      registry: new Registry(functions),
      verifier: new TestVerifier(),
      files: {
        publicUrl: "https://files.example.test/",
        store: fileStore,
      },
    });
    await runtime.start();
    server = listen(runtime);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  test("uploads immutable bytes and serves them through a revocable grant", async () => {
    const sessionResult = await runtime.system.run("test.files.create-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession({
        maxBytes: 64,
        contentTypes: ["text/plain"],
      })),
    );
    if (!sessionResult.ok) throw sessionResult.error;
    const sessionPath = new URL(sessionResult.data.url).pathname;

    const upload = await fetch(`${base}${sessionPath}`, {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename*=UTF-8''hello.txt",
      },
      body: "hello files",
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { fileId: string };
    const fileId = BigInt(uploaded.fileId) as FileId;

    const grantResult = await runtime.system.run("test.files.create-grant", (ctx) =>
      ctx.tx(async (tx) => {
        const pending = await tx.files.get(fileId);
        await tx.db.documents!.insert({ file: fileId });
        const grant = await tx.files.createUrl(fileId, { permanent: true });
        return { pending, active: await tx.files.get(fileId), grant };
      }),
    );
    if (!grantResult.ok) throw grantResult.error;
    expect(grantResult.data.pending).toMatchObject({
      id: fileId,
      state: "pending",
      size: 11,
      sha256: "6e5bc8df28cfac06658769974f895070db24676563ebc1ae17fb961f5da4d5e9",
      contentType: "text/plain",
      name: "hello.txt",
    });
    expect(grantResult.data.active?.state).toBe("active");
    const listed = await runtime.system.run("test.files.list-grants", (ctx) =>
      ctx.tx((tx) => tx.files.grants(fileId).collect()),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.data).toEqual([{
      id: grantResult.data.grant.id,
      fileId,
      access: "bearer",
      expiresAt: null,
      disposition: { type: "attachment" },
      createdAt: grantResult.data.grant.createdAt,
    }]);
    expect(Object.hasOwn(listed.data[0]!, "url")).toBe(false);

    const grantPath = new URL(grantResult.data.grant.url).pathname;
    const download = await fetch(`${base}${grantPath}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toBe(
      'attachment; filename="hello.txt"; filename*=UTF-8\'\'hello.txt',
    );
    expect(await download.text()).toBe("hello files");
    const range = await fetch(`${base}${grantPath}`, { headers: { range: "bytes=6-10" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await range.text()).toBe("files");
    expect((await fetch(`${base}${grantPath}`, {
      headers: { range: "bytes=0-1,6-10" },
    })).status).toBe(416);
    const etag = download.headers.get("etag")!;
    const lastModified = download.headers.get("last-modified")!;
    expect((await fetch(`${base}${grantPath}`, {
      headers: { "if-none-match": `W/${etag}` },
    })).status).toBe(304);
    expect((await fetch(`${base}${grantPath}`, {
      headers: { "if-none-match": "*" },
    })).status).toBe(304);
    expect((await fetch(`${base}${grantPath}`, {
      headers: { "if-match": '"different"' },
    })).status).toBe(412);
    expect((await fetch(`${base}${grantPath}`, {
      headers: { "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    })).status).toBe(412);
    expect((await fetch(`${base}${grantPath}`, {
      headers: { "if-modified-since": lastModified },
    })).status).toBe(304);
    const staleRange = await fetch(`${base}${grantPath}`, {
      headers: { range: "bytes=6-10", "if-range": '"different"' },
    });
    expect(staleRange.status).toBe(200);
    expect(await staleRange.text()).toBe("hello files");
    const weakRange = await fetch(`${base}${grantPath}`, {
      headers: { range: "bytes=6-10", "if-range": `W/${etag}` },
    });
    expect(weakRange.status).toBe(200);
    expect(await weakRange.text()).toBe("hello files");
    const currentRange = await fetch(`${base}${grantPath}`, {
      headers: { range: "bytes=6-10", "if-range": etag },
    });
    expect(currentRange.status).toBe(206);
    expect(await currentRange.text()).toBe("files");
    const opensBeforeHead = fileStore.openCalls;
    const attributesBeforeHead = fileStore.attributesCalls;
    const head = await fetch(`${base}${grantPath}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(fileStore.openCalls).toBe(opensBeforeHead);
    expect(fileStore.attributesCalls).toBe(attributesBeforeHead + 1);
    fileStore.reportedSizeDelta = 1;
    expect((await fetch(`${base}${grantPath}`, { method: "HEAD" })).status).toBe(503);
    const unavailable = await fetch(`${base}${grantPath}`);
    expect(unavailable.status).toBe(503);
    expect(parseOutcome(await unavailable.json())).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    fileStore.reportedSizeDelta = 0;

    await runtime.system.run("test.files.revoke", (ctx) =>
      ctx.tx((tx) => tx.files.revokeGrant(grantResult.data.grant.id)),
    );
    expect((await fetch(`${base}${grantPath}`)).status).toBe(404);
  });

  test("returns typed upload failures and leaves a rejected Upload Session retryable", async () => {
    const created = await runtime.system.run("test.files.create-retryable-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession({
        maxBytes: 8,
        contentTypes: ["text/plain"],
      })),
    );
    if (!created.ok) throw created.error;
    const sessionPath = new URL(created.data.url).pathname;

    const rejected = await fetch(`${base}${sessionPath}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(rejected.status).toBe(415);
    expect(parseOutcome(await rejected.json())).toEqual({
      code: "validation",
      message: "Content-Type is not allowed by this Upload Session",
      retryable: false,
      resource: "idempotency",
    });

    const retried = await fetch(`${base}${sessionPath}`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "okay",
    });
    expect(retried.status).toBe(201);
  });

  test("requires an exact Content-Length and rejects clean under-delivery", async () => {
    const created = await runtime.system.run("test.files.create-length-required-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession()),
    );
    if (!created.ok) throw created.error;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("chunked"));
        controller.close();
      },
    });

    const response = await fetch(`${base}${new URL(created.data.url).pathname}`, {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(response.status).toBe(411);
    expect(parseOutcome(await response.json())).toEqual({
      code: "malformed",
      message: "Content-Length is required for streaming file uploads",
      retryable: false,
      resource: "idempotency",
    });

    const short = await runtime.runFileRequest({
      request: new Request(`${base}${new URL(created.data.url).pathname}`, {
        method: "PUT",
        headers: { "content-length": "7" },
        body: "short",
      }),
      authenticate: () => Promise.reject(new Error("uploads do not authenticate")),
    });
    expect(short.status).toBe(400);
    expect(parseOutcome(await short.json())).toEqual({
      code: "malformed",
      message: "uploaded bytes do not match Content-Length",
      retryable: false,
      resource: "idempotency",
    });
    const retried = await runtime.runFileRequest({
      request: new Request(`${base}${new URL(created.data.url).pathname}`, {
        method: "PUT",
        headers: { "content-length": "7" },
        body: "exactly",
      }),
      authenticate: () => Promise.reject(new Error("uploads do not authenticate")),
    });
    expect(retried.status).toBe(201);
  });

  test("invalid bearer upload URLs never enter the database writer", async () => {
    const before = engine.commitVersion();
    const response = await fetch(
      `${base}/_files/uploads/9223372036854775807.${"x".repeat(43)}`,
      { method: "PUT", body: "untrusted" },
    );

    expect(response.status).toBe(404);
    expect(engine.commitVersion()).toBe(before);
  });

  test("refuses an Upload Session after its request-start expiry", async () => {
    const created = await runtime.system.run("test.files.create-expiring-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession({ expiresIn: "1ms" })),
    );
    if (!created.ok) throw created.error;
    await Bun.sleep(2);
    expect((await fetch(`${base}${new URL(created.data.url).pathname}`, {
      method: "PUT",
      body: "late",
    })).status).toBe(404);
  });

  test("never reuses a physical key that durable cleanup may still delete", async () => {
    const expectedSha256 = createHash("sha256").update("good").digest("hex");
    const created = await runtime.system.run("test.files.create-checksummed-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession({ expectedSha256 })),
    );
    if (!created.ok) throw created.error;
    const sessionPath = new URL(created.data.url).pathname;
    fileStore.failNextDeletes();

    const rejected = await fetch(`${base}${sessionPath}`, { method: "PUT", body: "bad" });
    expect(rejected.status).toBe(422);
    const retried = await fetch(`${base}${sessionPath}`, { method: "PUT", body: "good" });
    expect(retried.status).toBe(201);
    expect(fileStore.putKeys).toHaveLength(2);
    expect(fileStore.putKeys[1]).not.toBe(fileStore.putKeys[0]);
  });

  test("a concurrent recovery retry waits for and returns the first committed File", async () => {
    const created = await runtime.system.run("test.files.create-concurrent-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession()),
    );
    if (!created.ok) throw created.error;
    const sessionPath = new URL(created.data.url).pathname;
    fileStore.blockNextPut();

    const firstPromise = fetch(`${base}${sessionPath}`, { method: "PUT", body: "same bytes" });
    await fileStore.putEntered;
    const retryPromise = fetch(`${base}${sessionPath}`, { method: "PUT", body: "same bytes" });
    await Bun.sleep(20);
    fileStore.releaseBlockedPut();
    const [first, retry] = await Promise.all([firstPromise, retryPromise]);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(fileStore.putKeys).toHaveLength(1);
  });

  test("keeps stalled File transfers out of ordinary HTTP admission", async () => {
    const created = await runtime.system.run("test.files.create-stalled-upload", (ctx) =>
      ctx.tx((tx) => tx.files.createUploadSession()),
    );
    if (!created.ok) throw created.error;
    const sessionPath = new URL(created.data.url).pathname;
    fileStore.blockNextPut();

    const upload = fetch(`${base}${sessionPath}`, { method: "PUT", body: "stalled" });
    await fileStore.putEntered;
    try {
      expect(server.status()).toMatchObject({ fileTransfers: 1, httpIngress: 0 });

      const ordinary = await fetch(`${base}/api/files/createUpload`, {
        method: "POST",
        headers: {
          authorization: "Bearer user-token",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(ordinary.status).toBe(200);
      expect(server.status().fileTransfers).toBe(1);
    } finally {
      fileStore.releaseBlockedPut();
    }
    expect((await upload).status).toBe(201);
    await eventually(async () => server.status().fileTransfers === 0);
  });

  test("streams and deliberately buffers File bytes in trusted backend work", async () => {
    const result = await runtime.system.run("test.files.backend-bytes", async (ctx) => {
      const fileId = await ctx.files.store(new Blob(["backend bytes"]).stream(), {
        size: 13,
        contentType: "text/plain",
        name: "backend.txt",
      });
      const pending = await ctx.files.get(fileId);
      const claimedResult = await ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        return tx.files.get(fileId);
      });
      if (!claimedResult.ok) throw claimedResult.error;
      const buffered = await ctx.files.bytes(fileId, { maxBytes: 13 });
      const opened = await ctx.files.open(fileId, { range: { start: 8, end: 12 } });
      return {
        fileId,
        pending,
        claimed: claimedResult.data,
        metadata: opened.metadata,
        buffered: new TextDecoder().decode(buffered),
        range: await new Response(opened.body).text(),
      };
    });

    expect(result).toMatchObject({
      pending: { id: result.fileId, state: "pending" },
      claimed: { id: result.fileId, state: "active" },
      metadata: {
        id: result.fileId,
        state: "active",
        owner: null,
        size: 13,
        contentType: "text/plain",
        name: "backend.txt",
      },
      buffered: "backend bytes",
      range: "bytes",
    });
    fileStore.reportedSizeDelta = 1;
    await expect(runtime.system.run("test.files.backend-bytes-mismatch", (ctx) =>
      ctx.files.bytes(result.fileId, { maxBytes: 13 }),
    )).rejects.toThrow("attributes that do not match immutable File metadata");
    fileStore.reportedSizeDelta = 0;
  });

  test("rejects provider attributes that disagree with immutable File metadata before streaming", async () => {
    const fileId = await runtime.system.run("test.files.store-before-size-mismatch", (ctx) =>
      ctx.files.store(new Blob(["immutable"]).stream(), { size: 9 }),
    );
    fileStore.reportedSizeDelta = 1;

    await expect(runtime.system.run("test.files.open-size-mismatch", async (ctx) => {
      await ctx.files.open(fileId);
    })).rejects.toThrow("File Store returned attributes that do not match immutable File metadata");
    expect(fileStore.cancelledOpenBodies).toBe(1);
  });

  test("rejects provider range metadata that disagrees with the requested range before streaming", async () => {
    const fileId = await runtime.system.run("test.files.store-before-range-mismatch", (ctx) =>
      ctx.files.store(new Blob(["immutable"]).stream(), { size: 9 }),
    );
    fileStore.reportedRange = { start: 0, endExclusive: 1 };

    await expect(runtime.system.run("test.files.open-range-mismatch", async (ctx) => {
      await ctx.files.open(fileId, { range: { start: 2, end: 4 } });
    })).rejects.toThrow("File Store returned a range that does not match files.open.range");
    expect(fileStore.cancelledOpenBodies).toBe(1);

    await expect(runtime.system.run("test.files.open-unrequested-range", async (ctx) => {
      await ctx.files.open(fileId);
    })).rejects.toThrow("File Store returned a range that does not match files.open.range");
    expect(fileStore.cancelledOpenBodies).toBe(2);
  });

  test("captures the Upload Session creator as immutable indexed File ownership", async () => {
    const sessionResponse = await fetch(`${base}/api/files/createUpload`, {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json() as { url: string };
    const upload = await fetch(`${base}${new URL(session.url).pathname}`, {
      method: "PUT",
      body: "owned",
    });
    const fileId = BigInt((await upload.json() as { fileId: string }).fileId) as FileId;

    const owned = await runtime.system.run("test.files.owner-query", (ctx) =>
      ctx.tx(async (tx) => {
        const file = await tx.files.get(fileId);
        if (file?.owner === null || file?.owner === undefined) return { file, matches: [] };
        return {
          file,
          matches: await tx.files.query().where((row) => row.owner.eq(file.owner!)).collect(),
        };
      }),
    );
    if (!owned.ok) throw owned.error;
    expect(owned.data.file).toMatchObject({ id: fileId, state: "pending" });
    expect(owned.data.file?.owner).toBeGreaterThan(0n);
    expect(owned.data.matches.map((file) => file.id)).toContain(fileId);
  });

  test("never persists a replayable plaintext Upload Session secret", async () => {
    const idempotencyKey = uuidV7(1);
    const request = () => fetch(`${base}/api/files/createUpload`, {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: "{}",
    });
    const created = await request();
    expect(created.status).toBe(200);
    const session = await created.json() as { readonly url: string };
    const secret = new URL(session.url).pathname.split(".").at(-1)!;

    expect(
      engine.writer.query(
        "SELECT result_disposition, result, result_bytes FROM _ackerdb_mutations",
      ).get(),
    ).toEqual({ result_disposition: "one-time", result: null, result_bytes: 0n });
    expect(JSON.stringify(
      engine.writer.query("SELECT * FROM _ackerdb_mutations").all(),
      (_key, value) => typeof value === "bigint" ? value.toString() : value,
    ))
      .not.toContain(secret);
    expect((await request()).status).toBe(409);
  });

  test("makes authenticated and validated grants indistinguishable when denied", async () => {
    const fileId = await runtime.system.run("test.files.auth-store", async (ctx) => {
      const stored = await ctx.files.store(new Blob(["private"]).stream(), {
        size: 7,
        contentType: "text/plain",
      });
      const claimed = await ctx.tx((tx) => tx.files.claim(stored));
      if (!claimed.ok) throw claimed.error;
      return stored;
    });
    const created = await runtime.system.run("test.files.auth-grants", (ctx) =>
      ctx.tx(async (tx) => ({
        authenticated: await tx.files.createUrl(fileId, {
          access: { type: "authenticated" },
          permanent: true,
        }),
        allowed: await tx.files.createUrl(fileId, {
          access: {
            type: "validated",
            authorize: anyApi.files.canDownload,
            args: { organizationId: 7n },
          },
          permanent: true,
        }),
        denied: await tx.files.createUrl(fileId, {
          access: {
            type: "validated",
            authorize: anyApi.files.canDownload,
            args: { organizationId: 8n },
          },
          permanent: true,
        }),
        expiring: await tx.files.createUrl(fileId, {
          expiresIn: "1ms",
        }),
      })),
    );
    if (!created.ok) throw created.error;
    const path = (url: string) => `${base}${new URL(url).pathname}`;
    const authorization = { authorization: "Bearer user-token" };

    expect((await fetch(path(created.data.authenticated.url))).status).toBe(404);
    expect((await fetch(path(created.data.authenticated.url), { headers: authorization })).status).toBe(200);
    expect((await fetch(path(created.data.authenticated.url), {
      headers: { authorization: "Bearer workload-token" },
    })).status).toBe(404);
    const callsBeforeAllowed = authorizationCalls;
    expect((await fetch(path(created.data.allowed.url), { headers: authorization })).status).toBe(200);
    expect((await fetch(path(created.data.allowed.url), {
      method: "HEAD",
      headers: authorization,
    })).status).toBe(200);
    expect((await fetch(path(created.data.allowed.url), {
      headers: { ...authorization, range: "bytes=0-2" },
    })).status).toBe(206);
    expect(authorizationCalls - callsBeforeAllowed).toBe(3);
    expect((await fetch(path(created.data.denied.url), { headers: authorization })).status).toBe(404);
    expect((await fetch(path(created.data.denied.url), {
      headers: { authorization: "Bearer invalid" },
    })).status).toBe(404);
    await Bun.sleep(2);
    expect((await fetch(path(created.data.expiring.url))).status).toBe(404);
    expect((await fetch(`${base}/_files/grants/999.${"x".repeat(43)}`)).status).toBe(404);
  });

  test("reports authenticated transfer saturation as retryable overload", async () => {
    const fileId = await runtime.system.run("test.files.overload-store", async (ctx) => {
      const stored = await ctx.files.store(new Blob(["held"]).stream(), { size: 4 });
      const claimed = await ctx.tx((tx) => tx.files.claim(stored));
      if (!claimed.ok) throw claimed.error;
      return stored;
    });
    const created = await runtime.system.run("test.files.overload-grant", (ctx) =>
      ctx.tx((tx) => tx.files.createUrl(fileId, {
        access: { type: "authenticated" },
        permanent: true,
      })),
    );
    if (!created.ok) throw created.error;
    const url = `${base}${new URL(created.data.url).pathname}`;
    const headers = { authorization: "Bearer user-token" };
    fileStore.blockOpenBodies();

    const held = Array.from({ length: 16 }, () => fetch(url, { headers }));
    try {
      await eventually(async () => fileStore.openCalls === 16);
      const overloaded = await fetch(url, { headers });
      expect(overloaded.status).toBe(429);
      expect(parseOutcome(await overloaded.json())).toMatchObject({
        code: "overloaded",
        retryable: true,
      });
    } finally {
      fileStore.releaseOpenBodies();
    }
    for (const response of await Promise.all(held)) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("held");
    }
  });

  test("requires permanent grant intent to be exactly true", async () => {
    const fileId = await runtime.system.run("test.files.false-permanent-store", (ctx) =>
      ctx.files.store(new Blob(["private"]).stream(), { size: 7 }),
    );
    await expect(runtime.system.run("test.files.false-permanent", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        return tx.files.createUrl(fileId, {
          access: { type: "bearer" },
          permanent: false,
        } as never);
      }),
    )).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("permanent must be exactly true"),
    });
  });

  test("permits trusted media inline but refuses executable HTML and SVG", async () => {
    const stored = await runtime.system.run("test.files.inline-store", async (ctx) =>
      Promise.all([
        ctx.files.store(new Blob(["html"]).stream(), { size: 4, contentType: "text/html" }),
        ctx.files.store(new Blob(["svg"]).stream(), { size: 3, contentType: "image/svg+xml" }),
        ctx.files.store(new Blob(["png"]).stream(), { size: 3, contentType: "image/png" }),
      ]),
    );
    const [html, svg, png] = stored;
    const result = await runtime.system.run("test.files.inline-grants", (ctx) =>
      ctx.tx(async (tx) => {
        const rejected: string[] = [];
        for (const fileId of [html, svg]) {
          try {
            await tx.files.createUrl(fileId, {
              permanent: true,
              inline: true,
            });
          } catch (error) {
            rejected.push((error as Error).message);
          }
        }
        const allowed = await tx.files.createUrl(png, {
          permanent: true,
          inline: true,
        });
        return {
          rejected,
          allowed,
          states: await Promise.all([html, svg, png].map((fileId) => tx.files.get(fileId))),
        };
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.data.rejected).toEqual([
      expect.stringContaining("inline delivery requires"),
      expect.stringContaining("inline delivery requires"),
    ]);
    expect(result.data.states.map((file) => file?.state)).toEqual(["pending", "pending", "active"]);
    const response = await fetch(`${base}${new URL(result.data.allowed.url).pathname}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("keeps deleting metadata visible until durable physical cleanup finishes", async () => {
    const fileId = await runtime.system.run("test.files.store-for-delete", (ctx) =>
      ctx.files.store(new Blob(["delete me"]).stream(), { size: 9 }),
    );
    fileStore.block();

    const deleted = await runtime.system.run("test.files.logical-delete", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.delete(fileId);
        return tx.files.get(fileId);
      }),
    );
    if (!deleted.ok) throw deleted.error;
    expect(deleted.data?.state).toBe("deleting");

    await Promise.race([
      fileStore.deleteEntered,
      Bun.sleep(500).then(() => {
        throw (runtime as unknown as { fileCleanup: { lastFailure: unknown } }).fileCleanup.lastFailure;
      }),
    ]);
    expect(await runtime.system.run("test.files.still-deleting", (ctx) =>
      ctx.tx((tx) => tx.files.get(fileId)),
    )).toMatchObject({ ok: true, data: { state: "deleting" } });

    fileStore.release();
    await eventually(async () => {
      const result = await runtime.system.run("test.files.deleted", (ctx) =>
        ctx.tx((tx) => tx.files.get(fileId)),
      );
      return result.ok && result.data === null;
    });
  }, 30_000);
});
