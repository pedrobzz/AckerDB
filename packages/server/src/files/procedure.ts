import { randomUUID } from "node:crypto";
import type { FileId, FileMetadata } from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import { ValidationError } from "../validation/error.ts";
import type {
  FileProcedureCapability,
  FileRange,
  OpenedFile,
  StoreFileOptions,
} from "./api.ts";
import {
  fileDatabase,
  storedFileError,
  type FileRow,
} from "./database.ts";
import { PENDING_FILE_LIFETIME_MS, type RuntimeFiles } from "./namespace.ts";
import { FILE_CLEANUP_TABLE, FILES_TABLE } from "./tables.ts";
import { FileStoreError, type FileStoreRange } from "./store/contract.ts";
import { checkedFileText } from "./text.ts";

export interface FileProcedureRuntimeOptions {
  readonly files: RuntimeFiles;
  readonly now: () => number;
  readonly lifecycleSignal: () => AbortSignal;
  read<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
  write<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
}

function owner(principal: Principal): FileMetadata["owner"] {
  return principal.kind === "user" || principal.kind === "mcp" ? principal.identity : null;
}

function boundedBody(source: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
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
        await reader.cancel("File exceeds the deployment maxBytes").catch(() => {});
        controller.error(new ValidationError(`File exceeds files.maxBytes (${maxBytes})`));
        return;
      }
      controller.enqueue(result.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function publicMetadata(row: FileRow): FileMetadata {
  return Object.freeze({
    id: row.id,
    state: row.state,
    owner: row.owner,
    size: row.size,
    sha256: row.sha256,
    contentType: row.contentType,
    name: row.name,
    createdAt: row.createdAt,
  });
}

function storeRange(range: FileRange | undefined, size: number): FileStoreRange | undefined {
  if (range === undefined) return undefined;
  const end = range.end ?? size - 1;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(end) ||
    range.start < 0 ||
    end < range.start ||
    end >= size
  ) {
    throw new ValidationError("files.open.range must be one inclusive range within the File");
  }
  return { start: range.start, endExclusive: end + 1 };
}

/** Trusted procedure/system byte operations over the same immutable File identity. */
export class FileProcedureRuntime {
  constructor(private readonly options: FileProcedureRuntimeOptions) {}

  capability(principal: Principal, signal: AbortSignal): FileProcedureCapability {
    const capability: FileProcedureCapability = {
      get: (fileId) => this.options.read(signal, (db) => this.options.files.query(db).get(fileId)),
      store: (body, storeOptions) => this.store(principal, signal, body, storeOptions),
      open: (fileId, openOptions) => this.open(signal, fileId, openOptions?.range),
      bytes: (fileId, bytesOptions) => this.bytes(signal, fileId, bytesOptions.maxBytes),
    };
    return Object.freeze(capability);
  }

  private async store(
    principal: Principal,
    signal: AbortSignal,
    body: ReadableStream<Uint8Array>,
    options: StoreFileOptions,
  ): Promise<FileId> {
    const store = this.options.files.store;
    if (store === undefined) throw new ValidationError("file storage is not configured");
    if (options === undefined || (
      !Number.isSafeInteger(options.size) || options.size < 0 || options.size > this.options.files.maxBytes
    )) {
      throw new ValidationError(`files.store.size must be from 0 through ${this.options.files.maxBytes}`);
    }
    if (options.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.expectedSha256)) {
      throw new ValidationError("files.store.expectedSha256 must be a lowercase hexadecimal SHA-256 digest");
    }
    const name = checkedFileText(options.name, "files.store.name", 1_024);
    const contentType = checkedFileText(options.contentType, "files.store.contentType", 255);
    const objectKey = `files/${randomUUID()}`;
    const stagedAt = this.options.now();
    const stagingId = await this.options.write(signal, async (value) =>
      await (fileDatabase(value))[FILE_CLEANUP_TABLE]!.insert({
        objectKey,
        fileId: null,
        state: "staging",
        attempt: 0,
        runAt: stagedAt,
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: stagedAt,
      }));
    let stored: { readonly size: number; readonly sha256: string };
    try {
      stored = await store.put(objectKey, boundedBody(body, this.options.files.maxBytes), {
        signal,
        contentLength: options.size,
      });
      if (stored.size !== options.size) {
        throw new ValidationError(`files.store received ${stored.size} bytes, expected ${options.size}`);
      }
      if (options.expectedSha256 !== undefined && stored.sha256 !== options.expectedSha256) {
        throw new ValidationError("files.store bytes do not match expectedSha256");
      }
    } catch (error) {
      if (
        !(error instanceof ValidationError) &&
        (!(error instanceof FileStoreError) || error.code !== "cancelled")
      ) {
        this.options.files.observability.recordProviderError(
          error instanceof FileStoreError ? error.operation : "put",
        );
      }
      await this.abandonStaging(stagingId, error);
      throw error;
    }
    try {
      const completedAt = this.options.now();
      const fileId = await this.options.write(this.options.lifecycleSignal(), async (value) => {
        const db = fileDatabase(value);
        const staging = await db[FILE_CLEANUP_TABLE]!.get(stagingId);
        if (staging?.state !== "staging" || staging.objectKey !== objectKey) {
          throw new Error("File staging ownership was lost before metadata commit");
        }
        const inserted = await db[FILES_TABLE]!.insert({
          state: "pending",
          objectKey,
          owner: Object.hasOwn(options, "owner") ? options.owner ?? null : owner(principal),
          size: stored.size,
          sha256: stored.sha256,
          contentType,
          name,
          createdAt: completedAt,
          pendingExpiresAt: completedAt + PENDING_FILE_LIFETIME_MS,
        });
        await db[FILE_CLEANUP_TABLE]!.delete(stagingId);
        return inserted;
      });
      this.options.files.scheduleCleanupAt(completedAt + PENDING_FILE_LIFETIME_MS);
      return fileId;
    } catch (error) {
      await this.abandonStaging(stagingId, error);
      throw error;
    }
  }

  private async row(signal: AbortSignal, fileId: FileId): Promise<FileRow> {
    const row = await this.options.read(signal, (value) =>
      (fileDatabase(value))[FILES_TABLE]!.get(fileId));
    if (row === null || row.state === "deleting") {
      throw new ValidationError("File does not exist");
    }
    return row;
  }

  private async open(
    signal: AbortSignal,
    fileId: FileId,
    range: FileRange | undefined,
  ): Promise<OpenedFile> {
    const store = this.options.files.store;
    if (store === undefined) throw new ValidationError("file storage is not configured");
    const row = await this.row(signal, fileId);
    const requestedRange = storeRange(range, row.size);
    try {
      const opened = await store.open(row.objectKey, {
        ...(requestedRange === undefined ? {} : { range: requestedRange }),
        signal,
      });
      if (opened.attributes.size !== row.size) {
        await opened.body.cancel("File Store attributes disagree with File metadata").catch(() => {});
        throw new Error("File Store returned attributes that do not match immutable File metadata");
      }
      const matchingRange = requestedRange === undefined
        ? opened.range === undefined
        : opened.range?.start === requestedRange.start &&
          opened.range.endExclusive === requestedRange.endExclusive;
      if (!matchingRange) {
        await opened.body.cancel("File Store range disagrees with files.open.range").catch(() => {});
        throw new Error("File Store returned a range that does not match files.open.range");
      }
      return Object.freeze({
        metadata: publicMetadata(row),
        body: this.observeProviderBody(opened.body),
      });
    } catch (error) {
      this.observeProviderError(error, "open");
      throw error;
    }
  }

  private async bytes(signal: AbortSignal, fileId: FileId, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new ValidationError("files.bytes.maxBytes must be a non-negative safe integer");
    }
    const row = await this.row(signal, fileId);
    if (row.size > maxBytes) {
      throw new ValidationError(`File has ${row.size} bytes, exceeding maxBytes ${maxBytes}`);
    }
    const store = this.options.files.store;
    if (store === undefined) throw new ValidationError("file storage is not configured");
    let opened: Awaited<ReturnType<typeof store.open>>;
    try {
      opened = await store.open(row.objectKey, { signal });
    } catch (error) {
      this.observeProviderError(error, "open");
      throw error;
    }
    if (opened.attributes.size !== row.size) {
      await opened.body.cancel("File Store attributes disagree with File metadata").catch(() => {});
      const error = new Error("File Store returned attributes that do not match immutable File metadata");
      this.observeProviderError(error, "open");
      throw error;
    }
    const buffer = new Uint8Array(row.size);
    let offset = 0;
    const reader = opened.body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (offset + chunk.byteLength > buffer.byteLength) {
          await reader.cancel("File Store returned more bytes than File metadata").catch(() => {});
          throw new Error("File Store returned more bytes than File metadata");
        }
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch (error) {
      this.observeProviderError(error, "open");
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (offset !== buffer.byteLength) {
      const error = new Error("File Store returned fewer bytes than File metadata");
      this.observeProviderError(error, "open");
      throw error;
    }
    return buffer;
  }

  private async abandonStaging(stagingId: bigint, error: unknown): Promise<void> {
    try {
      const now = this.options.now();
      const abandoned = await this.options.write(this.options.lifecycleSignal(), async (value) => {
        const cleanup = (fileDatabase(value))[FILE_CLEANUP_TABLE]!;
        const staging = await cleanup.get(stagingId);
        if (staging?.state !== "staging") return false;
        await cleanup.patch(stagingId, {
          state: "pending",
          runAt: now,
          lastError: storedFileError(error),
        });
        return true;
      });
      if (abandoned) this.options.files.scheduleCleanupAt(now);
    } catch {
      // The staging row remains durable for exclusive startup recovery.
    }
  }

  private observeProviderError(error: unknown, operation: "put" | "open"): void {
    if (error instanceof FileStoreError && error.code === "cancelled") return;
    this.options.files.observability.recordProviderError(
      error instanceof FileStoreError ? error.operation : operation,
    );
  }

  private observeProviderBody(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const observe = (error: unknown): void => this.observeProviderError(error, "open");
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          observe(error);
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }
}
