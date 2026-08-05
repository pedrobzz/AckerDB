import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  promises as fs,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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

export interface LocalFileStoreConfig {
  root: string;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await fs.open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureDurableDirectory(path: string): Promise<void> {
  const created = await fs.mkdir(path, { recursive: true });
  if (created === undefined) return;
  const durableParent = resolve(dirname(created));
  let current = resolve(path);
  for (;;) {
    await syncDirectory(current);
    if (current === durableParent) return;
    current = dirname(current);
  }
}

export class LocalFileStore implements FileStore {
  readonly #configuredRoot: string;
  readonly #root: string;
  readonly #objects: string;
  readonly #staging: string;

  constructor(config: LocalFileStoreConfig) {
    this.#configuredRoot = config.root;
    this.#root = resolve(config.root);
    this.#objects = join(this.#root, "objects");
    this.#staging = join(this.#root, "staging");
  }

  async probe(options: FileStoreOptions = {}): Promise<void> {
    const operation = "probe";
    let key: string | undefined;
    let failure: unknown;
    try {
      this.#validateConfiguration(operation);
      throwIfFileStoreAborted(options.signal, operation);
      await this.#ensureLayout();
      await this.#sweepStaging(options);
      key = `ackerdb-probe-${randomUUID()}`;
      await this.put(key, new Blob(["probe"]).stream(), {
        ...options,
        contentLength: 5,
      });
      const attributes = await this.attributes(key, options);
      if (attributes.size !== 5) {
        throw new FileStoreError("unavailable", operation, "file storage probe read an invalid object");
      }
    } catch (error) {
      const classified = classifyFileStoreError(error, operation);
      failure = new FileStoreError(classified.code, operation, classified.message, {
        cause: classified,
        retryable: classified.retryable,
      });
    } finally {
      if (key !== undefined) {
        try {
          await this.delete(key);
        } catch (cleanupError) {
          failure = failure === undefined
            ? classifyFileStoreError(cleanupError, operation)
            : new FileStoreError("unavailable", operation, "local file storage probe cleanup failed", {
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
    let stagingPath: string | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      this.#validateConfiguration(operation);
      const contentLength = fileStoreContentLength(options);
      throwIfFileStoreAborted(options.signal, operation);
      await this.#ensureLayout();

      stagingPath = join(this.#staging, randomUUID());
      handle = await fs.open(stagingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const digest = createHash("sha256");
      let size = 0;
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (size + chunk.byteLength > contentLength) {
            callback(new FileStoreError(
              "invalid_size",
              operation,
              `file storage body exceeds contentLength (${contentLength})`,
            ));
            return;
          }
          size += chunk.byteLength;
          digest.update(chunk);
          callback(null, chunk);
        },
        flush(callback) {
          if (size !== contentLength) {
            callback(new FileStoreError(
              "invalid_size",
              operation,
              `file storage body contains ${size} bytes, expected contentLength ${contentLength}`,
            ));
            return;
          }
          callback();
        },
      });
      const destination = createWriteStream(stagingPath, {
        fd: handle.fd,
        autoClose: false,
      });
      const source = Readable.fromWeb(
        body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      await pipeline(source, hashing, destination, { signal: options.signal });
      throwIfFileStoreAborted(options.signal, operation);
      await handle.sync();
      await handle.close();
      handle = undefined;

      const objectPath = this.#objectPath(key);
      const shard = join(this.#objects, objectPath.shard);
      const created = await fs.mkdir(shard, { recursive: true });
      if (created !== undefined) await syncDirectory(this.#objects);
      await fs.rename(stagingPath, objectPath.path);
      await syncDirectory(shard);
      await syncDirectory(this.#staging);
      stagingPath = undefined;
      return { size, sha256: digest.digest("hex") };
    } catch (error) {
      throw this.#classify(error, operation);
    } finally {
      await handle?.close().catch(() => undefined);
      if (stagingPath !== undefined) {
        await fs.unlink(stagingPath).catch(() => undefined);
      }
    }
  }

  async open(key: string, options: FileStoreOpenOptions = {}): Promise<FileStoreOpenResult> {
    const operation = "open";
    try {
      throwIfFileStoreAborted(options.signal, operation);
      const attributes = await this.#attributes(key, options, operation);
      const range = options.range;
      if (range !== undefined) assertRange(range, attributes.size);
      if (attributes.size === 0) {
        return {
          attributes,
          ...(range === undefined ? {} : { range }),
          body: new ReadableStream({ start: (controller) => controller.close() }),
        };
      }

      const objectPath = this.#objectPath(key).path;
      const source = createReadStream(objectPath, {
        ...(range === undefined
          ? {}
          : { start: range.start, end: range.endExclusive - 1 }),
        signal: options.signal,
      });
      const body = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
      return {
        attributes,
        ...(range === undefined ? {} : { range }),
        body: classifiedReadableStream(body, operation),
      };
    } catch (error) {
      throw this.#classify(error, operation);
    }
  }

  attributes(key: string, options: FileStoreOptions = {}): Promise<FileStoreAttributes> {
    return this.#attributes(key, options, "attributes");
  }

  async delete(key: string, options: FileStoreOptions = {}): Promise<void> {
    const operation = "delete";
    try {
      this.#validateConfiguration(operation);
      throwIfFileStoreAborted(options.signal, operation);
      const { path, shard } = this.#objectPath(key);
      await fs.unlink(path);
      await syncDirectory(join(this.#objects, shard));
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      throw this.#classify(error, operation);
    }
  }

  async #attributes(
    key: string,
    options: FileStoreOptions,
    operation: FileStoreOperation,
  ): Promise<FileStoreAttributes> {
    try {
      this.#validateConfiguration(operation);
      throwIfFileStoreAborted(options.signal, operation);
      const stat = await fs.stat(this.#objectPath(key).path);
      if (!stat.isFile()) {
        throw new FileStoreError("not_found", operation, "file storage object was not found");
      }
      return { size: stat.size, lastModified: stat.mtime };
    } catch (error) {
      throw this.#classify(error, operation);
    }
  }

  #objectPath(key: string): { path: string; shard: string } {
    const encoded = createHash("sha256").update(key).digest("hex");
    const shard = encoded.slice(0, 2);
    return { shard, path: join(this.#objects, shard, encoded.slice(2)) };
  }

  async #ensureLayout(): Promise<void> {
    await ensureDurableDirectory(this.#objects);
    await ensureDurableDirectory(this.#staging);
  }

  /** Startup probe owns the deployment exclusively and reclaims crashed puts. */
  async #sweepStaging(options: FileStoreOptions): Promise<void> {
    const entries = await fs.readdir(this.#staging, { withFileTypes: true });
    for (const entry of entries) {
      throwIfFileStoreAborted(options.signal, "probe");
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new FileStoreError(
          "unavailable",
          "probe",
          "local file storage staging contains an unexpected non-file entry",
        );
      }
      await fs.unlink(join(this.#staging, entry.name));
    }
    if (entries.length > 0) await syncDirectory(this.#staging);
  }

  #validateConfiguration(operation: FileStoreOperation): void {
    if (typeof this.#configuredRoot !== "string" || this.#configuredRoot.trim().length === 0) {
      throw new FileStoreError(
        "invalid_configuration",
        operation,
        "local file storage root must be a non-empty path",
      );
    }
  }

  #classify(error: unknown, operation: FileStoreOperation): FileStoreError {
    if (error instanceof FileStoreError) return error;
    if (nodeErrorCode(error) === "ENOENT") {
      return new FileStoreError("not_found", operation, "file storage object was not found", {
        cause: error,
      });
    }
    return classifyFileStoreError(error, operation);
  }
}
