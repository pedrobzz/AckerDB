export type FileStoreOperation = "probe" | "identity" | "put" | "open" | "attributes" | "delete";

export type FileStoreErrorCode =
  | "cancelled"
  | "invalid_configuration"
  | "invalid_size"
  | "invalid_range"
  | "not_found"
  | "unavailable";

export class FileStoreError extends Error {
  readonly code: FileStoreErrorCode;
  readonly operation: FileStoreOperation;
  readonly retryable: boolean;

  constructor(
    code: FileStoreErrorCode,
    operation: FileStoreOperation,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FileStoreError";
    this.code = code;
    this.operation = operation;
    this.retryable = options.retryable ?? code === "unavailable";
  }
}

export interface FileStoreRange {
  /** Inclusive byte offset. */
  start: number;
  /** Exclusive byte offset. */
  endExclusive: number;
}

export interface FileStoreAttributes {
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface FileStorePutResult {
  size: number;
  /** Lowercase hexadecimal SHA-256 of the stored bytes. */
  sha256: string;
}

export interface FileStoreOpenResult {
  /** Attributes describe the complete object, even for a ranged read. */
  attributes: FileStoreAttributes;
  /** Present only when the caller requested a range. */
  range?: FileStoreRange;
  body: ReadableStream<Uint8Array>;
}

export interface FileStoreOptions {
  signal?: AbortSignal;
}

export interface FileStorePutOptions extends FileStoreOptions {
  /** Exact stream length required by the S3 PutObject protocol. */
  contentLength: number;
}

export interface FileStoreOpenOptions extends FileStoreOptions {
  range?: FileStoreRange;
}

/** Physical storage port. Keys are opaque, caller-owned identifiers. */
export interface FileStore {
  probe(options?: FileStoreOptions): Promise<void>;
  /**
   * The store's durable physical identity: what the database's FileStore
   * binding is checked against, so an absent, replaced, or wrongly mounted
   * store fails closed. Placement only — presentation, path spelling and write
   * policy do not change it.
   */
  identity(options?: FileStoreOptions): Promise<string>;
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: FileStorePutOptions,
  ): Promise<FileStorePutResult>;
  open(key: string, options?: FileStoreOpenOptions): Promise<FileStoreOpenResult>;
  attributes(key: string, options?: FileStoreOptions): Promise<FileStoreAttributes>;
  /** Removing an absent object succeeds. */
  delete(key: string, options?: FileStoreOptions): Promise<void>;
}

export function fileStoreContentLength(
  options: FileStorePutOptions | undefined,
): number {
  const contentLength = options?.contentLength;
  if (
    typeof contentLength !== "number" ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0
  ) {
    throw new FileStoreError(
      "invalid_size",
      "put",
      "file storage put requires contentLength as a non-negative safe integer",
    );
  }
  return contentLength;
}

export function assertRange(
  range: FileStoreRange,
  size: number,
  operation: FileStoreOperation = "open",
): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.endExclusive) ||
    range.start < 0 ||
    range.endExclusive <= range.start ||
    range.endExclusive > size
  ) {
    throw new FileStoreError(
      "invalid_range",
      operation,
      "the requested byte range is outside the object",
    );
  }
}

export function throwIfFileStoreAborted(
  signal: AbortSignal | undefined,
  operation: FileStoreOperation,
): void {
  if (!signal?.aborted) return;
  throw new FileStoreError("cancelled", operation, "file storage operation was canceled", {
    cause: signal.reason,
  });
}

export function classifyFileStoreError(
  error: unknown,
  operation: FileStoreOperation,
): FileStoreError {
  if (error instanceof FileStoreError) return error;
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error &&
      (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR")))
  ) {
    return new FileStoreError("cancelled", operation, "file storage operation was canceled", {
      cause: error,
    });
  }
  return new FileStoreError("unavailable", operation, "file storage is unavailable", {
    cause: error,
  });
}

export function classifiedReadableStream(
  source: ReadableStream<Uint8Array>,
  operation: FileStoreOperation,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(classifyFileStoreError(error, operation));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
