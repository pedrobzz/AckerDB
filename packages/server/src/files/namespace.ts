import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getRef,
  stableEncode,
  type FileGrantId,
  type FileId,
  type FileMetadata,
  type FileUploadSession,
  type Identity,
} from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import type { QueryMaterializers } from "../database/query/types.ts";
import { ValidationError } from "../validation/error.ts";
import type {
  CreateFileUploadSessionOptions,
  CreateFileUrlOptions,
  FileDuration,
  FileGrant,
  FileGrantDisposition,
  FileGrantMetadata,
  FileGrantMetadataQuery,
  FileMetadataQuery,
  FileMutationCapability,
  OrderedFileMetadataQuery,
  FileQueryCapability,
} from "./api.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
  FILE_TABLES,
} from "./tables.ts";
import type { FileStore } from "./store/contract.ts";
import { FileObservability } from "./observability.ts";

export const DEFAULT_FILE_MAX_BYTES = 1024 ** 3;
export const HARD_FILE_MAX_BYTES = 5 * 1024 ** 3;
export const DEFAULT_UPLOAD_SESSION_MS = 60 * 60 * 1000;
export const PENDING_FILE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const GRANT_REVOCATION_BATCH = 256;

interface RuntimeTable {
  get(id: bigint): Promise<Record<string, unknown> | null>;
  insert(row: Record<string, unknown>): PromiseLike<bigint>;
  patch(id: bigint, row: Record<string, unknown>): PromiseLike<void>;
  delete(id: bigint): PromiseLike<void>;
  deleteMany(ids: readonly bigint[]): Promise<number>;
  query(): RuntimeQuery;
}

interface RuntimeQuery {
  where(predicate: (row: never) => unknown): RuntimeQuery;
  orderBy(order: (row: never) => unknown): RuntimeQuery;
  thenBy(order: (row: never) => unknown): RuntimeQuery;
  collect(): Promise<Record<string, unknown>[]>;
  take(count: number): Promise<Record<string, unknown>[]>;
  first(): Promise<Record<string, unknown> | null>;
  unique(): Promise<Record<string, unknown> | null>;
  count(): Promise<number>;
  sum(column: (row: never) => unknown): Promise<number | bigint>;
  avg(column: (row: never) => unknown): Promise<number | null>;
  min(column: (row: never) => unknown): Promise<unknown | null>;
  max(column: (row: never) => unknown): Promise<unknown | null>;
  iter(): AsyncIterable<Record<string, unknown>>;
  paginate(options: { cursor?: string | null; pageSize: number }): Promise<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
  }>;
}

type RuntimeDb = Readonly<Record<string, RuntimeTable>>;

export interface RuntimeFilesOptions {
  readonly publicUrl?: string;
  readonly maxBytes?: number;
  /** Physical byte store. The CLI configures a local or generic S3-compatible adapter. */
  readonly store?: FileStore;
}

function durationMs(value: FileDuration, path: string): number {
  if (typeof value !== "string") {
    throw new ValidationError(`${path} must be a positive duration such as "15m"`);
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (match === null) {
    throw new ValidationError(`${path} must be a positive duration such as "15m"`);
  }
  const amount = Number(match[1]);
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!;
  const duration = amount * factor;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new ValidationError(`${path} exceeds the supported duration`);
  }
  return duration;
}

function secret(): { readonly plain: string; readonly hash: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: createHash("sha256").update(plain).digest("base64url") };
}

function filePublicUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "http://127.0.0.1");
  } catch {
    throw new TypeError("files.publicUrl must be an absolute HTTP URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("files.publicUrl must be an HTTP or HTTPS URL without credentials or a fragment");
  }
  return url.href;
}

function urlFilename(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ValidationError("files.createUrl.filename must contain 1 through 1024 safe characters");
  }
  return value;
}

function principalIdentity(principal: Principal): Identity | null {
  return principal.kind === "user" || principal.kind === "mcp" ? principal.identity : null;
}

function fileMetadata(row: Record<string, unknown> | null): FileMetadata | null {
  if (row === null) return null;
  return Object.freeze({
    id: row.id as FileId,
    state: row.state as FileMetadata["state"],
    owner: row.owner as Identity | null,
    size: row.size as number,
    sha256: row.sha256 as string,
    contentType: row.contentType as string | null,
    name: row.name as string | null,
    createdAt: row.createdAt as number,
  });
}

type FileMetadataMaterializers = Omit<FileMetadataQuery, "where" | "orderBy">;

function mappedFileMaterializers(query: RuntimeQuery): FileMetadataMaterializers {
  const map = (row: Record<string, unknown>): FileMetadata => fileMetadata(row)!;
  return {
    collect: async () => (await query.collect()).map(map).filter(Boolean),
    take: async (count) => (await query.take(count)).map(map).filter(Boolean),
    first: async () => fileMetadata(await query.first()),
    unique: async () => fileMetadata(await query.unique()),
    count: () => query.count(),
    sum: ((column: never) => query.sum(column)) as FileMetadataMaterializers["sum"],
    avg: ((column: never) => query.avg(column)) as FileMetadataMaterializers["avg"],
    min: ((column: never) => query.min(column)) as FileMetadataMaterializers["min"],
    max: ((column: never) => query.max(column)) as FileMetadataMaterializers["max"],
    iter: async function* () {
      for await (const row of query.iter()) {
        const metadata = fileMetadata(row);
        if (metadata !== null) yield metadata;
      }
    },
    paginate: async (options) => {
      const page = await query.paginate(options);
      return { items: page.items.map(map).filter(Boolean), nextCursor: page.nextCursor };
    },
  };
}

function mappedQuery(query: RuntimeQuery): FileMetadataQuery {
  const mapped = {
    ...mappedFileMaterializers(query),
    where: (predicate: unknown) => mappedQuery(query.where(predicate as never)),
    orderBy: (order: unknown) => mappedOrderedQuery(query.orderBy(order as never)),
  };
  return Object.freeze(mapped) as unknown as FileMetadataQuery;
}

function mappedOrderedQuery(query: RuntimeQuery): OrderedFileMetadataQuery {
  const mapped = {
    ...mappedFileMaterializers(query),
    where: (predicate: unknown) => mappedOrderedQuery(query.where(predicate as never)),
    thenBy: (order: unknown) => mappedOrderedQuery(query.thenBy(order as never)),
  };
  return Object.freeze(mapped) as unknown as OrderedFileMetadataQuery;
}

function grantMetadata(row: Record<string, unknown>): FileGrantMetadata {
  return Object.freeze({
    id: row.id as FileGrantId,
    fileId: row.fileId as FileId,
    access: row.accessType as FileGrantMetadata["access"],
    expiresAt: row.expiresAt as number | null,
    disposition: Object.freeze({
      type: row.dispositionType as "attachment" | "inline",
      ...(row.filename === null ? {} : { filename: row.filename as string }),
    }),
    createdAt: row.createdAt as number,
  });
}

function mappedGrantQuery(query: RuntimeQuery): FileGrantMetadataQuery {
  const mapped: FileGrantMetadataQuery = {
    collect: async () => (await query.collect()).map(grantMetadata),
    take: async (count) => (await query.take(count)).map(grantMetadata),
    first: async () => {
      const row = await query.first();
      return row === null ? null : grantMetadata(row);
    },
    unique: async () => {
      const row = await query.unique();
      return row === null ? null : grantMetadata(row);
    },
    count: () => query.count(),
    iter: async function* () {
      for await (const row of query.iter()) yield grantMetadata(row);
    },
    paginate: async (options) => {
      const page = await query.paginate(options);
      return { items: page.items.map(grantMetadata), nextCursor: page.nextCursor };
    },
  };
  return Object.freeze(mapped);
}

export function applicationDatabase(db: unknown): unknown {
  const source = db as Readonly<Record<string, unknown>>;
  const application: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(source)) {
    if (!FILE_TABLES.includes(name as (typeof FILE_TABLES)[number])) application[name] = table;
  }
  return application;
}

function queryCapability(db: RuntimeDb): FileQueryCapability {
  const files = db[FILES_TABLE]!;
  const grants = db[FILE_GRANTS_TABLE]!;
  return {
    get: async (fileId) => fileMetadata(await files.get(fileId)),
    query: () => mappedQuery(files.query()),
    grants: (fileId) => mappedGrantQuery(grants.query().where((row) =>
      (row as unknown as { fileId: { eq(value: bigint): unknown } }).fileId.eq(fileId)
    )),
  };
}

function assertSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ValidationError(`${path} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return value;
}

function contentTypes(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new ValidationError("files.createUploadSession.contentTypes must contain 1 through 64 values");
  }
  const checked = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 255) {
      throw new ValidationError(`files.createUploadSession.contentTypes[${index}] must be a media type`);
    }
    return entry;
  });
  return JSON.stringify(checked);
}

function safeInlineContentType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "application/pdf" || mediaType.startsWith("audio/") || mediaType.startsWith("video/")) {
    return true;
  }
  return mediaType.startsWith("image/") && mediaType !== "image/svg+xml";
}

export class RuntimeFiles {
  readonly publicUrl: string;
  readonly maxBytes: number;
  readonly store: FileStore | undefined;
  private scheduleCleanup: (at: number) => void = () => {};

  constructor(
    options: RuntimeFilesOptions = {},
    readonly observability: FileObservability,
  ) {
    this.publicUrl = filePublicUrl(options.publicUrl);
    const maxBytes = options.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_FILE_MAX_BYTES) {
      throw new RangeError(`files.maxBytes must be an integer from 1 through ${HARD_FILE_MAX_BYTES}`);
    }
    this.maxBytes = maxBytes;
    this.store = options.store;
  }

  query(db: unknown): FileQueryCapability {
    return Object.freeze(queryCapability(db as RuntimeDb));
  }

  bindCleanupScheduler(schedule: (at: number) => void): void {
    this.scheduleCleanup = schedule;
  }

  scheduleCleanupAt(at: number): void {
    this.scheduleCleanup(at);
  }

  mutation(
    dbValue: unknown,
    principal: Principal,
    timestamp: number,
    scheduleCleanup: (at: number) => void,
    markOneTimeResult: () => void,
  ): FileMutationCapability {
    const db = dbValue as RuntimeDb;
    const files = db[FILES_TABLE]!;
    const uploads = db[FILE_UPLOADS_TABLE]!;
    const grants = db[FILE_GRANTS_TABLE]!;
    const cleanup = db[FILE_CLEANUP_TABLE]!;
    return Object.freeze({
      ...queryCapability(db),
      createUploadSession: async (
        options: CreateFileUploadSessionOptions = {},
      ): Promise<FileUploadSession> => {
        const maxBytes = options.maxBytes ?? this.maxBytes;
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.maxBytes) {
          throw new ValidationError(
            `files.createUploadSession.maxBytes must be from 1 through ${this.maxBytes}`,
          );
        }
        const expiresIn = options.expiresIn === undefined
          ? DEFAULT_UPLOAD_SESSION_MS
          : durationMs(options.expiresIn, "files.createUploadSession.expiresIn");
        if (expiresIn > DEFAULT_UPLOAD_SESSION_MS) {
          throw new ValidationError("files.createUploadSession.expiresIn cannot exceed one hour");
        }
        const token = secret();
        const owner = Object.hasOwn(options, "owner")
          ? options.owner ?? null
          : principalIdentity(principal);
        const id = await uploads.insert({
          secretHash: token.hash,
          state: "open",
          objectKey: `files/${randomUUID()}`,
          owner,
          maxBytes,
          contentTypesJson: contentTypes(options.contentTypes),
          expectedSha256: options.expectedSha256 === undefined
            ? null
            : assertSha256(options.expectedSha256, "files.createUploadSession.expectedSha256"),
          expiresAt: timestamp + expiresIn,
          fileId: null,
          attemptToken: null,
          createdAt: timestamp,
        });
        markOneTimeResult();
        scheduleCleanup(timestamp + expiresIn);
        return Object.freeze({
          url: new URL(`/api/_files/uploads/${id}.${token.plain}`, this.publicUrl).href,
          expiresAt: timestamp + expiresIn,
          maxBytes,
        });
      },
      createUrl: async <Args extends { readonly fileId: FileId }>(
        fileId: FileId,
        options: CreateFileUrlOptions<Args>,
      ): Promise<FileGrant> => {
        const file = await files.get(fileId);
        if (file === null || file.state === "deleting") {
          throw new ValidationError("files.createUrl requires an existing File");
        }
        const expiring = Object.hasOwn(options, "expiresIn");
        const permanent = Object.hasOwn(options, "permanent");
        if (permanent && options.permanent !== true) {
          throw new ValidationError("files.createUrl.permanent must be exactly true");
        }
        if (expiring === permanent) {
          throw new ValidationError("files.createUrl requires exactly expiresIn or permanent: true");
        }
        const expiresAt = expiring
          ? timestamp + durationMs(options.expiresIn!, "files.createUrl.expiresIn")
          : null;
        const access = options.access ?? { type: "bearer" as const };
        if (access.type !== "bearer" && access.type !== "authenticated" && access.type !== "validated") {
          throw new ValidationError("files.createUrl.access has an unknown type");
        }
        if (options.inline !== undefined && typeof options.inline !== "boolean") {
          throw new ValidationError("files.createUrl.inline must be a boolean");
        }
        const dispositionType = options.inline === true ? "inline" : "attachment";
        if (dispositionType === "inline" && !safeInlineContentType(file.contentType)) {
          throw new ValidationError(
            "files.createUrl inline delivery requires a trusted image, video, audio, or PDF File",
          );
        }
        const filename = urlFilename(options.filename);
        const normalizedDisposition: FileGrantDisposition = Object.freeze(
          filename === null
            ? { type: dispositionType }
            : { type: dispositionType, filename },
        );
        const authorizeAddress = access.type === "validated" ? getRef(access.authorize) : null;
        const authorizeArgsJson = access.type === "validated" ? stableEncode(access.args) : null;
        const token = secret();
        if (file.state === "pending") {
          await files.patch(fileId, { state: "active", pendingExpiresAt: null });
        }
        const id = await grants.insert({
          fileId,
          secretHash: token.hash,
          accessType: access.type,
          authorizeAddress,
          authorizeArgsJson,
          expiresAt,
          dispositionType: normalizedDisposition.type,
          filename,
          createdAt: timestamp,
        }) as FileGrantId;
        markOneTimeResult();
        if (expiresAt !== null) scheduleCleanup(expiresAt);
        return Object.freeze({
          id,
          fileId,
          url: new URL(`/api/_files/grants/${id}.${token.plain}`, this.publicUrl).href,
          access: access.type,
          expiresAt,
          disposition: normalizedDisposition,
          createdAt: timestamp,
        });
      },
      revokeGrant: async (grantId: FileGrantId): Promise<void> => {
        await grants.delete(grantId);
      },
      claim: async (fileId: FileId): Promise<void> => {
        const file = await files.get(fileId);
        if (file === null || file.state === "deleting") {
          throw new ValidationError("files.claim requires an existing File");
        }
        if (file.state === "pending") {
          await files.patch(fileId, { state: "active", pendingExpiresAt: null });
        }
      },
      delete: async (fileId: FileId): Promise<void> => {
        const file = await files.get(fileId);
        if (file === null || file.state === "deleting") return;
        await files.patch(fileId, { state: "deleting", pendingExpiresAt: null });
        for (;;) {
          const fileGrants = await grants.query().where((row) =>
            (row as unknown as { fileId: { eq(value: bigint): unknown } }).fileId.eq(fileId)
          ).take(GRANT_REVOCATION_BATCH);
          if (fileGrants.length === 0) break;
          const deleted = await grants.deleteMany(fileGrants.map((grant) => grant.id as bigint));
          if (deleted !== fileGrants.length) {
            throw new Error("File Grant revocation lost transaction ownership");
          }
        }
        await cleanup.insert({
          objectKey: file.objectKey,
          fileId,
          state: "pending",
          attempt: 0,
          runAt: timestamp,
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
          createdAt: timestamp,
        });
        scheduleCleanup(timestamp);
      },
    });
  }
}
