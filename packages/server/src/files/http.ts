import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  decode,
  isResult,
  type FileId,
  type Identity,
  type Outcome,
  type OutcomeCode,
} from "@ackerdb/core";
import { ACKERDB_HTTP_ROUTES } from "../transport/http-surface.ts";
import type { Principal } from "../auth/credentials.ts";
import { outcomeFromError } from "../runtime/outcome.ts";
import { AckerDBError, isAckerDBError } from "../shared/errors.ts";
import {
  fileDatabase,
  pendingCleanupRow,
  storedFileError,
  type FileRow,
} from "./database.ts";
import {
  contentDisposition,
  fileDigest,
  fileEtag,
  ifRangeMatches,
  parseFileRange,
  preconditionStatus,
} from "./http-headers.ts";
import { FileStoreError, type FileStore } from "./store/contract.ts";
import { safeFileText } from "./text.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
} from "./tables.ts";
import { PENDING_FILE_LIFETIME_MS, type RuntimeFiles } from "./namespace.ts";
import type { FileTransferOutcome } from "./observability.ts";

export interface FileRequestAuthentication {
  readonly principal: Principal;
  readonly signal: AbortSignal;
  readonly fairnessKey: string;
}

export interface RuntimeFileRequest {
  readonly request: Request;
  authenticate(): Promise<FileRequestAuthentication>;
}

export interface FileHttpRuntimeOptions {
  readonly files: RuntimeFiles;
  readonly now: () => number;
  readonly lifecycleSignal: () => AbortSignal;
  read<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
  write<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
  authorize(
    address: string,
    args: unknown,
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

type UploadStart =
  | { readonly kind: "committed"; readonly fileId: FileId }
  | { readonly kind: "busy" }
  | {
      readonly kind: "upload";
      readonly id: bigint;
      readonly token: string;
      readonly objectKey: string;
      readonly maxBytes: number;
      readonly owner: Identity | null;
      readonly contentTypes: readonly string[] | null;
      readonly expectedSha256: string | null;
    };

interface DownloadGrant {
  readonly accessType: "bearer" | "authenticated" | "validated";
  readonly authorizeAddress: string | null;
  readonly authorizeArgsJson: string | null;
  readonly dispositionType: "attachment" | "inline";
  readonly filename: string | null;
  readonly file: FileRow;
}

const utf8 = new TextEncoder();
/** Derived from the canonical surface, so the route cannot drift from it. */
const FILE_ROUTE = new RegExp(
  `^${ACKERDB_HTTP_ROUTES.files}/(uploads|grants)/([1-9]\\d*)\\.([A-Za-z0-9_-]{20,})$`,
);
const MAX_UPLOAD_RECOVERY_WAIT_MS = 30_000;

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

function concealedAuthenticationFailure(error: unknown): boolean {
  return isAckerDBError(error) && (
    error.code === "unauthenticated" ||
    error.code === "auth_stale" ||
    error.code === "unauthorized"
  );
}

function fileStoreDownloadFailure(error: unknown): never {
  if (!(error instanceof FileStoreError)) throw error;
  throw new AckerDBError(
    error.code === "invalid_range" || error.code === "invalid_size" ? "internal" : "unavailable",
    error.code === "cancelled" ? "file transfer was canceled" : "file storage is unavailable",
    {
      cause: error,
      resource: "operation",
      retryable: error.retryable,
    },
  );
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, {
    status: 405,
    headers: { allow, "cache-control": "no-store" },
  });
}

function transferOutcome(status: number): FileTransferOutcome {
  if ((status >= 200 && status < 400)) return "ok";
  if (status === 400 || status === 411) return "malformed";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 413 || status === 415 || status === 416 || status === 422) return "validation";
  if (status === 429) return "overloaded";
  if (status === 499) return "indeterminate";
  if (status === 503) return "unavailable";
  return "internal";
}

function uploadError(
  status: number,
  message: string,
  headers?: Record<string, string>,
  codeOverride?: OutcomeCode,
  retryableOverride?: boolean,
): Response {
  const code: OutcomeCode = codeOverride ?? (status === 400 || status === 411
    ? "malformed"
    : status === 404
    ? "not_found"
    : status === 413 || status === 415 || status === 422
    ? "validation"
    : status === 499
    ? "indeterminate"
    : status === 503
    ? "unavailable"
    : "internal");
  const outcome: Outcome = {
    code,
    message,
    retryable: retryableOverride ?? status === 503,
    resource: "idempotency",
  };
  return Response.json(outcome, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sameSecret(expected: unknown, plain: string): boolean {
  if (typeof expected !== "string") return false;
  const actual = hashSecret(plain);
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function parseRoute(request: Request): {
  readonly kind: "uploads" | "grants";
  readonly id: bigint;
  readonly secret: string;
} | null {
  const match = FILE_ROUTE.exec(new URL(request.url).pathname);
  if (match === null) return null;
  try {
    const id = BigInt(match[2]!);
    if (id <= 0n || id > (1n << 63n) - 1n) return null;
    return { kind: match[1] as "uploads" | "grants", id, secret: match[3]! };
  } catch {
    return null;
  }
}

function uploadName(value: string | null): string | null {
  if (value === null || value.length > 8_192) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]*)/i.exec(value)?.[1];
  if (encoded !== undefined) {
    try {
      const name = decodeURIComponent(encoded.trim());
      return safeFileText(name, 1_024) ? name : null;
    } catch {
      return null;
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value)?.[1];
  if (quoted === undefined) return null;
  const name = quoted.replace(/\\(.)/g, "$1");
  return safeFileText(name, 1_024) ? name : null;
}

function parseContentTypes(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function boundedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("file exceeds Upload Session maxBytes").catch(() => {});
        controller.error(new PayloadTooLargeError());
        return;
      }
      controller.enqueue(result.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

class PayloadTooLargeError extends Error {}

function causedByPayloadTooLarge(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof PayloadTooLargeError) return true;
    current = current.cause;
  }
  return false;
}

function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function callerPrincipal(principal: Principal): boolean {
  return principal.kind !== "anonymous" && principal.kind !== "system";
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, delayMs);
    timer.unref?.();
    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Owns the streaming File routes; table mutation remains in Runtime's one writer. */
export class FileHttpRuntime {
  constructor(private readonly options: FileHttpRuntimeOptions) {}

  async handle(input: RuntimeFileRequest): Promise<Response> {
    const route = parseRoute(input.request);
    if (route === null) return notFound();
    if (route.kind === "uploads") {
      if (input.request.method !== "PUT") return methodNotAllowed("PUT");
      return this.upload(input.request, route.id, route.secret);
    }
    if (input.request.method !== "GET" && input.request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return this.download(input, route.id, route.secret);
  }

  private async upload(request: Request, id: bigint, secret: string): Promise<Response> {
    const observedAt = performance.now();
    let bytes = 0;
    let response: Response;
    try {
      response = await this.executeUpload(request, id, secret, (stored) => {
        bytes = stored;
      });
    } catch {
      response = uploadError(503, "file upload is temporarily unavailable");
    }
    this.options.files.observability.recordTransfer(
      "upload",
      transferOutcome(response.status),
      bytes,
      performance.now() - observedAt,
    );
    return response;
  }

  private async executeUpload(
    request: Request,
    id: bigint,
    secret: string,
    accepted: (bytes: number) => void,
  ): Promise<Response> {
    const store = this.options.files.store;
    if (store === undefined) return uploadError(503, "file storage is not configured");
    const startedAt = this.options.now();
    const attemptToken = randomUUID();
    let start: UploadStart | null;
    try {
      start = await this.acquireUpload(request.signal, id, secret, attemptToken, startedAt);
      let delayMs = 10;
      const waitUntil = startedAt + MAX_UPLOAD_RECOVERY_WAIT_MS;
      while (start?.kind === "busy" && this.options.now() < waitUntil) {
        await waitForRetry(delayMs, request.signal);
        delayMs = Math.min(250, delayMs * 2);
        start = await this.acquireUpload(request.signal, id, secret, attemptToken, startedAt);
      }
    } catch {
      return uploadError(503, "file upload is temporarily unavailable");
    }
    if (start === null) return uploadError(404, "Upload Session was not found");
    if (start.kind === "committed") return this.uploaded(start.fileId, 200);
    if (start.kind === "busy") {
      return uploadError(
        409,
        "File upload is still completing; retry this Upload Session",
        { "retry-after": "1" },
        "conflict",
        true,
      );
    }

    const length = contentLength(request);
    if (Number.isNaN(length)) {
      await this.releaseUpload(start);
      return uploadError(400, "invalid Content-Length");
    }
    if (length === null) {
      await this.releaseUpload(start);
      return uploadError(411, "Content-Length is required for streaming file uploads");
    }
    if (length > start.maxBytes) {
      await this.releaseUpload(start);
      return uploadError(413, "file exceeds Upload Session maxBytes");
    }
    const contentType = request.headers.get("content-type");
    if (contentType !== null && contentType.length > 255) {
      await this.releaseUpload(start);
      return uploadError(400, "Content-Type is too long");
    }
    if (start.contentTypes !== null && (contentType === null || !start.contentTypes.includes(contentType))) {
      await this.releaseUpload(start);
      return uploadError(415, "Content-Type is not allowed by this Upload Session");
    }

    let stored: { readonly size: number; readonly sha256: string };
    try {
      const body = boundedBody(request.body ?? new Blob([]).stream(), start.maxBytes);
      stored = await store.put(start.objectKey, body, {
        signal: request.signal,
        contentLength: length,
      });
      accepted(stored.size);
      if (start.expectedSha256 !== null && stored.sha256 !== start.expectedSha256) {
        if (await this.cleanupObject(store, start.objectKey)) await this.releaseUpload(start);
        return uploadError(422, "uploaded bytes do not match expectedSha256");
      }
    } catch (error) {
      if (await this.cleanupObject(store, start.objectKey)) await this.releaseUpload(start);
      if (causedByPayloadTooLarge(error)) {
        return uploadError(413, "file exceeds Upload Session maxBytes");
      }
      if (error instanceof FileStoreError) {
        if (error.code === "invalid_size") {
          return uploadError(400, "uploaded bytes do not match Content-Length");
        }
        if (error.code === "cancelled") {
          return uploadError(499, "file upload was canceled");
        }
      }
      this.options.files.observability.recordProviderError(
        error instanceof FileStoreError ? error.operation : "put",
      );
      return uploadError(503, "file storage is temporarily unavailable");
    }

    try {
      // Once the physical put succeeds, completion no longer belongs to the
      // client connection: finish or prove the metadata commit under Runtime
      // lifecycle ownership so a disconnect cannot make us delete live bytes.
      const fileId = await this.options.write(this.options.lifecycleSignal(), async (value) => {
        const db = fileDatabase(value);
        const uploads = db[FILE_UPLOADS_TABLE]!;
        const files = db[FILES_TABLE]!;
        const row = await uploads.get(start.id);
        if (row?.state === "committed" && typeof row.fileId === "bigint") {
          return row.fileId;
        }
        if (row?.state !== "uploading" || row.attemptToken !== start.token) {
          throw new Error("Upload Session attempt no longer owns completion");
        }
        const completedAt = this.options.now();
        const fileId = await files.insert({
          state: "pending",
          objectKey: start.objectKey,
          owner: start.owner,
          size: stored.size,
          sha256: stored.sha256,
          contentType,
          name: uploadName(request.headers.get("content-disposition")),
          createdAt: completedAt,
          pendingExpiresAt: completedAt + PENDING_FILE_LIFETIME_MS,
        });
        await uploads.patch(start.id, {
          state: "committed",
          fileId,
          attemptToken: null,
        });
        return fileId;
      });
      this.options.files.scheduleCleanupAt(this.options.now() + PENDING_FILE_LIFETIME_MS);
      return this.uploaded(fileId, 201);
    } catch {
      let proof: { readonly kind: "committed"; readonly fileId: FileId } | { readonly kind: "owned" };
      try {
        proof = await this.uploadCommitProof(start, secret, this.options.lifecycleSignal());
      } catch {
        return uploadError(
          503,
          "file upload completion could not be proven",
          undefined,
          "indeterminate",
          false,
        );
      }
      if (proof.kind === "committed") return this.uploaded(proof.fileId, 200);
      if (await this.cleanupObject(store, start.objectKey)) await this.releaseUpload(start);
      return uploadError(503, "file metadata could not be committed");
    }
  }

  private uploaded(fileId: FileId, status: number): Response {
    return Response.json({ fileId: fileId.toString() }, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }

  private acquireUpload(
    signal: AbortSignal,
    id: bigint,
    secret: string,
    attemptToken: string,
    admittedAt: number,
  ): Promise<UploadStart | null> {
    return this.options.read(signal, async (value) => {
      const row = await (fileDatabase(value))[FILE_UPLOADS_TABLE]!.get(id);
      if (row === null || !sameSecret(row.secretHash, secret)) return null;
      if (row.state === "committed" && typeof row.fileId === "bigint") {
        return { kind: "committed", fileId: row.fileId } satisfies UploadStart;
      }
      if (typeof row.expiresAt !== "number" || row.expiresAt <= admittedAt) return null;
      if (row.state === "uploading") return { kind: "busy" } satisfies UploadStart;
      return row.state === "open" ? "claimable" as const : null;
    }).then((inspected) => {
      if (inspected !== "claimable") return inspected;
      return this.claimUpload(signal, id, secret, attemptToken, admittedAt);
    });
  }

  /** Only a plausibly claimable session enters the single-writer coordinator. */
  private claimUpload(
    signal: AbortSignal,
    id: bigint,
    secret: string,
    attemptToken: string,
    admittedAt: number,
  ): Promise<UploadStart | null> {
    return this.options.write(signal, async (value) => {
      const uploads = (fileDatabase(value))[FILE_UPLOADS_TABLE]!;
      const row = await uploads.get(id);
      if (row === null || !sameSecret(row.secretHash, secret)) return null;
      if (row.state === "committed" && typeof row.fileId === "bigint") {
        return { kind: "committed", fileId: row.fileId };
      }
      if (typeof row.expiresAt !== "number" || row.expiresAt <= admittedAt) return null;
      if (row.state === "uploading") return { kind: "busy" };
      if (row.state !== "open") return null;
      await uploads.patch(id, { state: "uploading", attemptToken });
      return {
        kind: "upload",
        id,
        token: attemptToken,
        objectKey: row.objectKey,
        maxBytes: row.maxBytes,
        owner: row.owner,
        contentTypes: parseContentTypes(row.contentTypesJson),
        expectedSha256: row.expectedSha256,
      } satisfies UploadStart;
    });
  }

  private async uploadCommitProof(
    start: Extract<UploadStart, { kind: "upload" }>,
    secret: string,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "committed"; readonly fileId: FileId } | { readonly kind: "owned" }> {
    return this.options.read(signal, async (value) => {
      const row = await (fileDatabase(value))[FILE_UPLOADS_TABLE]!.get(start.id);
      if (
        row !== null &&
        sameSecret(row.secretHash, secret) &&
        row.state === "committed" &&
        typeof row.fileId === "bigint"
      ) {
        return { kind: "committed", fileId: row.fileId };
      }
      if (
        row !== null &&
        sameSecret(row.secretHash, secret) &&
        row.state === "uploading" &&
        row.attemptToken === start.token &&
        row.objectKey === start.objectKey
      ) {
        return { kind: "owned" };
      }
      throw new Error("Upload Session completion ownership could not be proven");
    });
  }

  private async releaseUpload(start: Extract<UploadStart, { kind: "upload" }>): Promise<void> {
    await this.options.write(this.options.lifecycleSignal(), async (value) => {
      const uploads = (fileDatabase(value))[FILE_UPLOADS_TABLE]!;
      const row = await uploads.get(start.id);
      if (row?.state === "uploading" && row.attemptToken === start.token) {
        // Never reuse a physical key after a failed write. A queued deletion
        // may still target the old key after this bearer session is retried.
        await uploads.patch(start.id, {
          state: "open",
          objectKey: `files/${randomUUID()}`,
          attemptToken: null,
        });
      }
    }).catch(() => {});
  }

  /** True once deletion is confirmed or represented by durable cleanup state. */
  private async cleanupObject(store: FileStore, objectKey: string): Promise<boolean> {
    try {
      await store.delete(objectKey);
      return true;
    } catch (error) {
      this.options.files.observability.recordCleanupFailure();
      if (!(error instanceof FileStoreError) || error.code !== "cancelled") {
        this.options.files.observability.recordProviderError(
          error instanceof FileStoreError ? error.operation : "delete",
        );
      }
      try {
        const now = this.options.now();
        await this.options.write(this.options.lifecycleSignal(), async (value) => {
          await (fileDatabase(value))[FILE_CLEANUP_TABLE].insert(pendingCleanupRow({
            objectKey,
            fileId: null,
            now,
            lastError: storedFileError(error),
          }));
        });
        this.options.files.scheduleCleanupAt(now);
        return true;
      } catch {
        // The Upload Session remains `uploading`, preserving the old key for
        // exclusive startup recovery instead of silently losing cleanup state.
        return false;
      }
    }
  }

  private async download(input: RuntimeFileRequest, id: bigint, secret: string): Promise<Response> {
    const observedAt = performance.now();
    let streaming = false;
    let response: Response;
    try {
      response = await this.executeDownload(input, id, secret, (body) => {
        streaming = true;
        return this.observeDownloadBody(body, observedAt);
      });
    } catch (error) {
      this.options.files.observability.recordTransfer(
        "download",
        outcomeFromError(error).code,
        0,
        performance.now() - observedAt,
      );
      throw error;
    }
    if (!streaming) {
      this.options.files.observability.recordTransfer(
        "download",
        transferOutcome(response.status),
        0,
        performance.now() - observedAt,
      );
    }
    return response;
  }

  private async executeDownload(
    input: RuntimeFileRequest,
    id: bigint,
    secret: string,
    observeBody: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>,
  ): Promise<Response> {
    const store = this.options.files.store;
    if (store === undefined) return notFound();
    const startedAt = this.options.now();
    let grant: DownloadGrant | null;
    grant = await this.options.read(input.request.signal, async (value) => {
      const db = fileDatabase(value);
      const row = await db[FILE_GRANTS_TABLE].get(id);
      if (
        row === null ||
        !sameSecret(row.secretHash, secret) ||
        row.expiresAt !== null && row.expiresAt <= startedAt
      ) return null;
      const file = await db[FILES_TABLE].get(row.fileId);
      if (file === null || file.state !== "active") return null;
      return {
        accessType: row.accessType,
        authorizeAddress: row.authorizeAddress,
        authorizeArgsJson: row.authorizeArgsJson,
        dispositionType: row.dispositionType,
        filename: row.filename,
        file,
      };
    });
    if (grant === null) return notFound();

    if (grant.accessType !== "bearer") {
      let auth: FileRequestAuthentication;
      try {
        auth = await input.authenticate();
      } catch (error) {
        if (concealedAuthenticationFailure(error)) return notFound();
        throw error;
      }
      if (grant.accessType === "authenticated") {
        if (auth.principal.kind !== "user") return notFound();
      } else if (grant.accessType === "validated") {
        if (!callerPrincipal(auth.principal)) return notFound();
        if (grant.authorizeAddress === null || grant.authorizeArgsJson === null) return notFound();
        const decoded = decode(grant.authorizeArgsJson);
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return notFound();
        const result = await this.options.authorize(
          grant.authorizeAddress,
          { ...(decoded as Record<string, unknown>), fileId: grant.file.id },
          auth.principal,
          auth.fairnessKey,
          auth.signal,
        );
        if (!isResult(result) || !result.ok || result.data !== true) return notFound();
      } else {
        return notFound();
      }
    }

    const size = grant.file.size;
    const sha256 = grant.file.sha256;
    const createdAt = grant.file.createdAt;
    const expectedTag = { opaque: sha256, weak: false } as const;
    const responseEtag = fileEtag(sha256);
    const lastModified = new Date(createdAt).toUTCString();
    const condition = preconditionStatus(input.request.headers, expectedTag, createdAt);
    if (condition !== null) {
      return new Response(null, {
        status: condition,
        headers: {
          "cache-control": "no-store",
          etag: responseEtag,
          "last-modified": lastModified,
        },
      });
    }

    const rangeHeader = input.request.headers.get("range");
    const range = rangeHeader === null || !ifRangeMatches(
      input.request.headers.get("if-range"),
      expectedTag,
      createdAt,
    )
      ? null
      : parseFileRange(rangeHeader, size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}`, "cache-control": "no-store" },
      });
    }

    try {
      const filename = grant.filename ?? grant.file.name;
      const headers = new Headers({
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-disposition": contentDisposition(grant.dispositionType, filename),
        "content-length": String(range === null ? size : range.endExclusive - range.start),
        "content-type": grant.file.contentType ?? "application/octet-stream",
        digest: fileDigest(sha256),
        etag: responseEtag,
        "last-modified": lastModified,
        "x-content-type-options": "nosniff",
      });
      if (range !== null) headers.set("content-range", `bytes ${range.start}-${range.endExclusive - 1}/${size}`);
      if (input.request.method === "HEAD") {
        const attributes = await store.attributes(grant.file.objectKey, {
          signal: input.request.signal,
        });
        if (attributes.size !== size) {
          this.options.files.observability.recordProviderError("attributes");
          throw new AckerDBError("unavailable", "file storage is unavailable", {
            resource: "operation",
            retryable: true,
          });
        }
        return new Response(null, { status: range === null ? 200 : 206, headers });
      }
      const opened = await store.open(grant.file.objectKey, {
        ...(range === null ? {} : { range }),
        signal: input.request.signal,
      });
      if (opened.attributes.size !== size) {
        await opened.body.cancel("File Store object size does not match immutable File metadata").catch(() => {});
        this.options.files.observability.recordProviderError("open");
        throw new AckerDBError("unavailable", "file storage is unavailable", {
          resource: "operation",
          retryable: true,
        });
      }
      return new Response(observeBody(opened.body), { status: range === null ? 200 : 206, headers });
    } catch (error) {
      if (!(error instanceof FileStoreError) || error.code !== "cancelled") {
        this.options.files.observability.recordProviderError(
          error instanceof FileStoreError ? error.operation : input.request.method === "HEAD"
            ? "attributes"
            : "open",
        );
      }
      fileStoreDownloadFailure(error);
    }
  }

  private observeDownloadBody(
    source: ReadableStream<Uint8Array>,
    observedAt: number,
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const files = this.options.files;
    let bytes = 0;
    let settled = false;
    const settle = (outcome: FileTransferOutcome): void => {
      if (settled) return;
      settled = true;
      this.options.files.observability.recordTransfer(
        "download",
        outcome,
        bytes,
        performance.now() - observedAt,
      );
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            settle("ok");
            controller.close();
            return;
          }
          bytes += result.value.byteLength;
          controller.enqueue(result.value);
        } catch (error) {
          if (!(error instanceof FileStoreError) || error.code !== "cancelled") {
            files.observability.recordProviderError(
              error instanceof FileStoreError ? error.operation : "open",
            );
          }
          settle(error instanceof FileStoreError && error.code === "cancelled"
            ? "indeterminate"
            : "unavailable");
          controller.error(error);
        }
      },
      cancel(reason) {
        settle("indeterminate");
        return reader.cancel(reason);
      },
    });
  }
}
