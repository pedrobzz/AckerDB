import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { S3FileStore } from "../../../src/files/store/s3.ts";
import type { S3FileStoreConfig } from "../../../src/files/store/s3-configuration.ts";
import { FileStoreError } from "../../../src/files/store/contract.ts";
import { fileStoreContract } from "./contract.ts";

interface StoredObject {
  body: Uint8Array;
  lastModified: Date;
}

const objects = new Map<string, StoredObject>();
const putHeaders = new Map<string, Headers>();
let rejectEncryption = false;
let rejectCompletePut = false;
let rejectProbeHead = false;
let corruptProbeWholeRead = false;
let corruptProbeRangeRead = false;
let probeWholeReads = 0;
let probeRangeReads = 0;

function isProbeKey(key: string): boolean {
  return key.startsWith(".ackerdb-file-store-probe/");
}

function objectKey(request: Request): string | undefined {
  const path = new URL(request.url).pathname;
  if (path === "/files" || path === "/files/") return undefined;
  return decodeURIComponent(path.slice("/files/".length));
}

function xmlError(code: string, status: number): Response {
  return new Response(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, {
    status,
    headers: {
      "content-type": "application/xml",
      "x-amz-request-id": "test-request",
    },
  });
}

function headersFor(object: StoredObject): HeadersInit {
  return {
    etag: `"${createHash("md5").update(object.body).digest("hex")}"`,
    "last-modified": object.lastModified.toUTCString(),
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const key = objectKey(request);
    if (request.method === "HEAD" && key === undefined) return new Response(null, { status: 200 });
    if (key === undefined) return xmlError("NoSuchBucket", 404);

    if (request.method === "PUT") {
      putHeaders.set(key, new Headers(request.headers));
      if (rejectEncryption && request.headers.has("x-amz-server-side-encryption")) {
        return xmlError("NotImplemented", 501);
      }
      let uploaded: ArrayBuffer;
      try {
        uploaded = await request.arrayBuffer();
      } catch {
        return xmlError("IncompleteBody", 400);
      }
      if (rejectCompletePut) return xmlError("IncompleteBody", 400);
      objects.set(key, {
        body: new Uint8Array(uploaded),
        lastModified: new Date(),
      });
      return new Response(null, { status: 200, headers: { etag: '"uploaded"' } });
    }

    const object = objects.get(key);
    if (request.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!object) return xmlError("NoSuchKey", 404);

    if (request.method === "HEAD") {
      if (isProbeKey(key) && rejectProbeHead) return xmlError("AccessDenied", 403);
      return new Response(null, {
        status: 200,
        headers: { ...headersFor(object), "content-length": String(object.body.byteLength) },
      });
    }
    if (request.method !== "GET") return xmlError("MethodNotAllowed", 405);

    const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (!range) {
      if (isProbeKey(key)) probeWholeReads++;
      const body = isProbeKey(key) && corruptProbeWholeRead
        ? new Uint8Array(object.body.byteLength).fill(0x7a)
        : object.body;
      return new Response(Uint8Array.from(body).buffer, {
        headers: { ...headersFor(object), "content-length": String(object.body.byteLength) },
      });
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start < 0 || end < start || end >= object.body.byteLength) {
      return xmlError("InvalidRange", 416);
    }
    if (isProbeKey(key)) probeRangeReads++;
    const body = isProbeKey(key) && corruptProbeRangeRead
      ? new Uint8Array(end - start + 1).fill(0x7a)
      : object.body.slice(start, end + 1);
    return new Response(Uint8Array.from(body).buffer, {
      status: 206,
      headers: {
        ...headersFor(object),
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${object.body.byteLength}`,
      },
    });
  },
});

afterAll(() => server.stop(true));

const config = {
  endpoint: server.url.href,
  region: "us-east-1",
  bucket: "files",
  credentials: {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  },
  forcePathStyle: true,
  checksum: "disabled",
  encryption: { type: "disabled" },
} satisfies S3FileStoreConfig;

describe("S3FileStore contract", () => {
  fileStoreContract("s3", { create: () => new S3FileStore(config) });

  test("the startup probe verifies whole and one-byte ranged reads", async () => {
    const store = new S3FileStore(config);
    const initialWholeReads = probeWholeReads;
    const initialRangeReads = probeRangeReads;

    await store.probe();

    expect(probeWholeReads).toBe(initialWholeReads + 1);
    expect(probeRangeReads).toBe(initialRangeReads + 1);
    expect([...objects.keys()].filter(isProbeKey)).toEqual([]);

    corruptProbeWholeRead = true;
    try {
      await expect(store.probe()).rejects.toBeInstanceOf(FileStoreError);
    } finally {
      corruptProbeWholeRead = false;
    }
    corruptProbeRangeRead = true;
    try {
      await expect(store.probe()).rejects.toBeInstanceOf(FileStoreError);
    } finally {
      corruptProbeRangeRead = false;
    }
    expect([...objects.keys()].filter(isProbeKey)).toEqual([]);
  });

  test("the startup probe removes a possibly-created object after a post-PUT 4xx", async () => {
    rejectProbeHead = true;
    try {
      await expect(new S3FileStore(config).probe()).rejects.toBeInstanceOf(FileStoreError);
    } finally {
      rejectProbeHead = false;
    }
    expect([...objects.keys()].filter(isProbeKey)).toEqual([]);
  });

  test("rejects unsupported compatibility settings during the startup probe", async () => {
    const store = new S3FileStore({
      ...config,
      checksum: "md5",
    } as unknown as S3FileStoreConfig);
    try {
      await store.probe();
    } catch (error) {
      expect(error).toBeInstanceOf(FileStoreError);
      expect((error as FileStoreError).code).toBe("invalid_configuration");
      return;
    }
    throw new Error("expected invalid S3 configuration");
  });

  test("fails the probe when the service rejects configured encryption", async () => {
    rejectEncryption = true;
    const store = new S3FileStore({
      ...config,
      encryption: { type: "AES256" },
    });
    try {
      await store.probe();
    } catch (error) {
      expect(error).toBeInstanceOf(FileStoreError);
      expect((error as FileStoreError).code).toBe("invalid_configuration");
      return;
    } finally {
      rejectEncryption = false;
    }
    throw new Error("expected unsupported S3 encryption");
  });

  test("classifies a provider-reported IncompleteBody as unavailable", async () => {
    rejectCompletePut = true;
    try {
      await new S3FileStore(config).put(
        `provider-incomplete-${crypto.randomUUID()}`,
        new Blob(["complete"]).stream(),
        { contentLength: 8 },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(FileStoreError);
      expect((error as FileStoreError).code).toBe("unavailable");
      return;
    } finally {
      rejectCompletePut = false;
    }
    throw new Error("expected provider IncompleteBody rejection");
  });

  test("sends an exact decoded length and SHA-256 trailer for known-length streams", async () => {
    const store = new S3FileStore({ ...config, checksum: "sha256" });
    const key = `known-sha256-${crypto.randomUUID()}`;
    const body = new Blob(["checksum bytes"]);

    const stored = await store.put(key, body.stream(), { contentLength: body.size });

    expect(stored).toEqual({
      size: body.size,
      sha256: createHash("sha256").update("checksum bytes").digest("hex"),
    });
    const headers = putHeaders.get(key);
    expect(headers).toBeDefined();
    expect(headers!.get("x-amz-decoded-content-length")).toBe(String(body.size));
    expect(headers!.get("x-amz-sdk-checksum-algorithm")).toBe("SHA256");
    expect(headers!.get("x-amz-trailer")).toBe("x-amz-checksum-sha256");
    expect(headers!.get("content-encoding")).toContain("aws-chunked");
    await store.delete(key);
  });

  test("sends Content-Length without flexible checksum headers when checksums are disabled", async () => {
    const store = new S3FileStore(config);
    const key = `known-no-checksum-${crypto.randomUUID()}`;
    const body = new Blob(["plain bytes"]);

    await store.put(key, body.stream(), { contentLength: body.size });

    const headers = putHeaders.get(key)!;
    expect(headers.get("content-length")).toBe(String(body.size));
    expect(headers.has("x-amz-decoded-content-length")).toBe(false);
    expect(headers.has("x-amz-sdk-checksum-algorithm")).toBe(false);
    expect(headers.has("x-amz-trailer")).toBe(false);
    await store.delete(key);
  });
});
