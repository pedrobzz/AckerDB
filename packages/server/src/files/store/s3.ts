import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  assertRange,
  classifiedReadableStream,
  classifyFileStoreError,
  fileStoreContentLength,
  FileStoreError,
  throwIfFileStoreAborted,
  type FileStore,
  type FileStoreAttributes,
  type FileStoreOpenOptions,
  type FileStoreOpenResult,
  type FileStoreOptions,
  type FileStorePutOptions,
  type FileStorePutResult,
  type FileStoreOperation,
} from "./contract.ts";
import {
  s3Checksum,
  s3EncryptionInput,
  validateS3FileStoreConfig,
  type S3FileStoreConfig,
} from "./s3-configuration.ts";

export type {
  S3Credentials,
  S3FileStoreChecksum,
  S3FileStoreConfig,
  S3FileStoreEncryption,
} from "./s3-configuration.ts";

interface S3ServiceError {
  name?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

const PROBE_BYTES = new Uint8Array([0x61, 0x62]);

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as S3ServiceError).$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function webBody(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToWebStream" in body &&
    typeof body.transformToWebStream === "function"
  ) {
    return body.transformToWebStream() as ReadableStream<Uint8Array>;
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
  }
  throw new TypeError("S3 returned an unsupported response stream");
}

async function cancelWebBody(body: unknown): Promise<void> {
  if (body === undefined) return;
  try {
    await webBody(body).cancel("S3 probe response attributes were invalid");
  } catch {
    // The capability failure is more useful than a secondary response cleanup error.
  }
}

async function verifyProbeBody(
  body: unknown,
  expected: Uint8Array,
  description: string,
): Promise<void> {
  if (body === undefined) {
    throw new FileStoreError(
      "invalid_configuration",
      "probe",
      `S3 probe ${description} returned no response body`,
    );
  }
  const reader = webBody(body).getReader();
  let complete = false;
  let offset = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        break;
      }
      if (offset + result.value.byteLength > expected.byteLength) {
        throw new FileStoreError(
          "invalid_configuration",
          "probe",
          `S3 probe ${description} returned too many bytes`,
        );
      }
      for (const byte of result.value) {
        if (byte !== expected[offset]) {
          throw new FileStoreError(
            "invalid_configuration",
            "probe",
            `S3 probe ${description} returned unexpected bytes`,
          );
        }
        offset++;
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== expected.byteLength) {
    throw new FileStoreError(
      "invalid_configuration",
      "probe",
      `S3 probe ${description} returned too few bytes`,
    );
  }
}

async function* readWebBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
  const reader = body.getReader();
  let complete = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class S3FileStore implements FileStore {
  readonly #config: S3FileStoreConfig;
  #client: S3Client | undefined;

  constructor(config: S3FileStoreConfig) {
    this.#config = config;
  }

  /** Normalized endpoint, region and bucket: the location, never the access or write policy around it. */
  async identity(): Promise<string> {
    validateS3FileStoreConfig(this.#config, "identity");
    return `s3:${JSON.stringify({
      endpoint: this.#config.endpoint === undefined ? null : new URL(this.#config.endpoint).href,
      region: this.#config.region,
      bucket: this.#config.bucket,
    })}`;
  }

  async probe(options: FileStoreOptions = {}): Promise<void> {
    const operation = "probe";
    let probeKey: string | undefined;
    let failure: unknown;
    try {
      validateS3FileStoreConfig(this.#config, operation);
      throwIfFileStoreAborted(options.signal, operation);
      const client = this.#getClient();
      probeKey = `.ackerdb-file-store-probe/${randomUUID()}`;
      await client.send(
        new PutObjectCommand(this.#putInput(probeKey, PROBE_BYTES, PROBE_BYTES.byteLength)),
        { abortSignal: options.signal },
      );
      const found = await client.send(
        new HeadObjectCommand({ Bucket: this.#config.bucket, Key: probeKey }),
        { abortSignal: options.signal },
      );
      if (found.ContentLength !== PROBE_BYTES.byteLength || found.LastModified === undefined) {
        throw new FileStoreError(
          "invalid_configuration",
          operation,
          "S3 probe HEAD returned invalid object attributes",
        );
      }

      const whole = await client.send(
        new GetObjectCommand({ Bucket: this.#config.bucket, Key: probeKey }),
        { abortSignal: options.signal },
      );
      if (whole.ContentLength !== PROBE_BYTES.byteLength || whole.LastModified === undefined) {
        await cancelWebBody(whole.Body);
        throw new FileStoreError(
          "invalid_configuration",
          operation,
          "S3 probe whole-object GET returned invalid object attributes",
        );
      }
      await verifyProbeBody(whole.Body, PROBE_BYTES, "whole-object GET");

      const ranged = await client.send(
        new GetObjectCommand({
          Bucket: this.#config.bucket,
          Key: probeKey,
          Range: "bytes=1-1",
        }),
        { abortSignal: options.signal },
      );
      if (
        ranged.ContentLength !== 1 ||
        ranged.ContentRange !== `bytes 1-1/${PROBE_BYTES.byteLength}` ||
        ranged.LastModified === undefined
      ) {
        await cancelWebBody(ranged.Body);
        throw new FileStoreError(
          "invalid_configuration",
          operation,
          "S3 probe ranged GET returned invalid range attributes",
        );
      }
      await verifyProbeBody(ranged.Body, PROBE_BYTES.subarray(1), "one-byte ranged GET");
    } catch (error) {
      failure = this.#classify(error, operation);
    } finally {
      // Once the PUT begins, its outcome may be ambiguous. DELETE is idempotent,
      // so always reclaim the random probe key even when a later capability fails.
      if (probeKey !== undefined) {
        try {
          await this.#getClient().send(new DeleteObjectCommand({
            Bucket: this.#config.bucket,
            Key: probeKey,
          }));
        } catch (cleanupError) {
          failure = failure === undefined
            ? this.#classify(cleanupError, operation)
            : new FileStoreError("unavailable", operation, "S3 probe cleanup failed", {
                cause: new AggregateError([failure, cleanupError]),
              });
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: FileStorePutOptions,
  ): Promise<FileStorePutResult> {
    const operation = "put";
    let source: Readable | undefined;
    const requestAbort = new AbortController();
    const abortRequest = (): void => requestAbort.abort(options.signal?.reason);
    try {
      validateS3FileStoreConfig(this.#config, operation);
      const contentLength = fileStoreContentLength(options);
      throwIfFileStoreAborted(options.signal, operation);
      options.signal?.addEventListener("abort", abortRequest, { once: true });
      const digest = createHash("sha256");
      let size = 0;
      let mismatch: FileStoreError | undefined;
      source = Readable.from((async function* () {
        for await (const chunk of readWebBody(body)) {
          if (size + chunk.byteLength > contentLength) {
            mismatch = new FileStoreError(
              "invalid_size",
              operation,
              `file storage body exceeds contentLength (${contentLength})`,
            );
            requestAbort.abort(mismatch);
            return;
          }
          size += chunk.byteLength;
          digest.update(chunk);
          yield chunk;
        }
        if (size !== contentLength) {
          mismatch = new FileStoreError(
            "invalid_size",
            operation,
            `file storage body contains ${size} bytes, expected contentLength ${contentLength}`,
          );
          requestAbort.abort(mismatch);
        }
      })());
      await this.#getClient().send(
        new PutObjectCommand(this.#putInput(key, source, contentLength)),
        { abortSignal: requestAbort.signal },
      );
      throwIfFileStoreAborted(options.signal, operation);
      if (mismatch !== undefined) throw mismatch;
      return { size, sha256: digest.digest("hex") };
    } catch (error) {
      if (requestAbort.signal.reason instanceof FileStoreError) {
        throw requestAbort.signal.reason;
      }
      throw this.#classify(error, operation);
    } finally {
      options?.signal?.removeEventListener("abort", abortRequest);
      source?.destroy();
    }
  }

  async open(key: string, options: FileStoreOpenOptions = {}): Promise<FileStoreOpenResult> {
    const operation = "open";
    try {
      validateS3FileStoreConfig(this.#config, operation);
      throwIfFileStoreAborted(options.signal, operation);
      const range = options.range;
      if (range !== undefined) {
        if (
          !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.endExclusive) ||
          range.start < 0 ||
          range.endExclusive <= range.start
        ) {
          throw new FileStoreError(
            "invalid_range",
            operation,
            "the requested byte range is outside the object",
          );
        }
      }
      const response = await this.#getClient().send(
        new GetObjectCommand({
          Bucket: this.#config.bucket,
          Key: key,
          ...(range === undefined
            ? {}
            : { Range: `bytes=${range.start}-${range.endExclusive - 1}` }),
        }),
        { abortSignal: options.signal },
      );
      const totalSize = range === undefined
        ? response.ContentLength
        : this.#totalSize(response.ContentRange);
      if (totalSize === undefined || response.LastModified === undefined || response.Body === undefined) {
        throw new FileStoreError("unavailable", operation, "S3 returned incomplete object attributes");
      }
      if (range !== undefined) assertRange(range, totalSize);
      const attributes: FileStoreAttributes = {
        size: totalSize,
        lastModified: response.LastModified,
        ...(response.ETag === undefined ? {} : { etag: response.ETag }),
      };
      return {
        attributes,
        ...(range === undefined ? {} : { range }),
        body: classifiedReadableStream(webBody(response.Body), operation),
      };
    } catch (error) {
      throw this.#classify(error, operation);
    }
  }

  async attributes(key: string, options: FileStoreOptions = {}): Promise<FileStoreAttributes> {
    const operation = "attributes";
    try {
      validateS3FileStoreConfig(this.#config, operation);
      throwIfFileStoreAborted(options.signal, operation);
      const response = await this.#getClient().send(
        new HeadObjectCommand({ Bucket: this.#config.bucket, Key: key }),
        { abortSignal: options.signal },
      );
      if (response.ContentLength === undefined || response.LastModified === undefined) {
        throw new FileStoreError("unavailable", operation, "S3 returned incomplete object attributes");
      }
      return {
        size: response.ContentLength,
        lastModified: response.LastModified,
        ...(response.ETag === undefined ? {} : { etag: response.ETag }),
      };
    } catch (error) {
      throw this.#classify(error, operation);
    }
  }

  async delete(key: string, options: FileStoreOptions = {}): Promise<void> {
    const operation = "delete";
    try {
      validateS3FileStoreConfig(this.#config, operation);
      throwIfFileStoreAborted(options.signal, operation);
      await this.#getClient().send(
        new DeleteObjectCommand({ Bucket: this.#config.bucket, Key: key }),
        { abortSignal: options.signal },
      );
    } catch (error) {
      const classified = this.#classify(error, operation);
      if (classified.code === "not_found") return;
      throw classified;
    }
  }

  #getClient(): S3Client {
    this.#client ??= new S3Client({
      region: this.#config.region,
      ...(this.#config.endpoint === undefined ? {} : { endpoint: this.#config.endpoint }),
      ...(this.#config.credentials === undefined ? {} : { credentials: this.#config.credentials }),
      forcePathStyle: this.#config.forcePathStyle ?? false,
      // PutObject opts into SHA-256 only when the decoded stream length is
      // known. The SDK's automatic flexible checksum cannot encode an
      // unknown-length stream without inventing an invalid length header.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_SUPPORTED",
    });
    return this.#client;
  }

  #putInput(
    key: string,
    body: PutObjectCommandInput["Body"],
    contentLength: number,
  ): PutObjectCommandInput {
    return {
      Bucket: this.#config.bucket,
      Key: key,
      Body: body,
      ContentLength: contentLength,
      ...(s3Checksum(this.#config) === "sha256" ? { ChecksumAlgorithm: "SHA256" } : {}),
      ...s3EncryptionInput(this.#config),
    };
  }

  #totalSize(contentRange: string | undefined): number | undefined {
    const match = contentRange?.match(/^bytes \d+-\d+\/(\d+)$/);
    if (!match?.[1]) return undefined;
    const size = Number(match[1]);
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
  }

  #classify(error: unknown, operation: FileStoreOperation): FileStoreError {
    if (error instanceof FileStoreError) return error;
    const status = errorStatus(error);
    const name = errorName(error);
    if (name === "NoSuchBucket") {
      return new FileStoreError(
        operation === "probe" ? "invalid_configuration" : "unavailable",
        operation,
        "S3 bucket was not found",
        { cause: error },
      );
    }
    if (status === 404 || name === "NoSuchKey" || name === "NotFound") {
      if (operation === "probe") {
        return new FileStoreError(
          "invalid_configuration",
          operation,
          "S3 bucket was not found",
          { cause: error },
        );
      }
      return new FileStoreError("not_found", operation, "file storage object was not found", {
        cause: error,
      });
    }
    if (status === 416 || name === "InvalidRange") {
      return new FileStoreError(
        "invalid_range",
        operation,
        "the requested byte range is outside the object",
        { cause: error },
      );
    }
    if (operation === "put" && name === "IncompleteBody") {
      return new FileStoreError(
        "unavailable",
        operation,
        "S3 did not receive the complete file storage body",
        { cause: error },
      );
    }
    if (operation === "probe" && status !== undefined && (status < 500 || status === 501)) {
      return new FileStoreError(
        "invalid_configuration",
        operation,
        "S3 rejected the configured bucket capabilities",
        { cause: error },
      );
    }
    return classifyFileStoreError(error, operation);
  }
}
