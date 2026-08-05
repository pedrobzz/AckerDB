import { expect, test } from "bun:test";
import type {
  FileStore,
  FileStoreErrorCode,
} from "../../../src/files/store/contract.ts";
import { FileStoreError } from "../../../src/files/store/contract.ts";

export interface FileStoreContractOptions {
  create(): Promise<FileStore> | FileStore;
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function bytes(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

async function expectStoreError(
  work: Promise<unknown>,
  code: FileStoreErrorCode,
): Promise<FileStoreError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(FileStoreError);
    expect((error as FileStoreError).code).toBe(code);
    return error as FileStoreError;
  }
  throw new Error(`expected FileStoreError(${code})`);
}

export function fileStoreContract(
  adapter: string,
  options: FileStoreContractOptions,
): void {
  test(`${adapter}: probes, stores, describes, and streams whole objects`, async () => {
    const store = await options.create();
    await store.probe();

    const stored = await store.put("whole-object", stream("hello ", "world"), {
      contentLength: 11,
    });
    expect(stored).toEqual({
      size: 11,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });

    const attributes = await store.attributes("whole-object");
    expect(attributes.size).toBe(11);
    expect(attributes.lastModified).toBeInstanceOf(Date);

    const opened = await store.open("whole-object");
    expect(opened.body).toBeInstanceOf(ReadableStream);
    expect(opened.attributes.size).toBe(11);
    expect(opened.range).toBeUndefined();
    expect(await bytes(opened.body)).toBe("hello world");
  });

  test(`${adapter}: opens one exact byte range without changing whole-object attributes`, async () => {
    const store = await options.create();
    await store.put("range-object", stream("hello world"), { contentLength: 11 });

    const opened = await store.open("range-object", {
      range: { start: 6, endExclusive: 11 },
    });

    expect(opened.attributes.size).toBe(11);
    expect(opened.range).toEqual({ start: 6, endExclusive: 11 });
    expect(await bytes(opened.body)).toBe("world");
  });

  test(`${adapter}: treats caller keys as opaque and deletes idempotently`, async () => {
    const store = await options.create();
    const key = "../opaque/%2F/\u{1F680}?key=#value";
    await store.put(key, stream("opaque"), { contentLength: 6 });
    expect(await bytes((await store.open(key)).body)).toBe("opaque");

    await store.delete(key);
    await store.delete(key);
    await expectStoreError(store.attributes(key), "not_found");
  });

  test(`${adapter}: classifies missing objects and invalid ranges`, async () => {
    const store = await options.create();
    await expectStoreError(store.open("missing"), "not_found");

    await store.put("short", stream("abc"), { contentLength: 3 });
    const error = await expectStoreError(
      store.open("short", { range: { start: 2, endExclusive: 4 } }),
      "invalid_range",
    );
    expect(error.retryable).toBe(false);
  });

  test(`${adapter}: cancels an upload without publishing an object`, async () => {
    const store = await options.create();
    const abort = new AbortController();
    const encoder = new TextEncoder();
    let continuePull: (() => void) | undefined;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!continuePull) {
          controller.enqueue(encoder.encode("partial"));
          await new Promise<void>((resolve) => {
            continuePull = resolve;
          });
        }
      },
      cancel() {
        continuePull?.();
      },
    });

    const putting = store.put("cancelled", source, {
      signal: abort.signal,
      contentLength: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort("test cancellation");

    const error = await expectStoreError(putting, "cancelled");
    expect(error.retryable).toBe(false);
    await expectStoreError(store.attributes("cancelled"), "not_found");
  });

  test(`${adapter}: a canceled replacement preserves the previously published bytes`, async () => {
    const store = await options.create();
    await store.put("replace", stream("known-good"), { contentLength: 10 });
    const abort = new AbortController();
    const encoder = new TextEncoder();
    let continuePull: (() => void) | undefined;
    const replacement = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!continuePull) {
          controller.enqueue(encoder.encode("replacement"));
          await new Promise<void>((resolve) => {
            continuePull = resolve;
          });
        }
      },
      cancel() {
        continuePull?.();
      },
    });

    const putting = store.put("replace", replacement, {
      signal: abort.signal,
      contentLength: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort("test cancellation");
    await expectStoreError(putting, "cancelled");
    expect(await bytes((await store.open("replace")).body)).toBe("known-good");
  });

  test(`${adapter}: rejects missing, invalid, and mismatched content lengths`, async () => {
    const store = await options.create();
    await expectStoreError(
      store.put("missing-length", stream("abc"), undefined as never),
      "invalid_size",
    );
    await expectStoreError(
      store.put("invalid-length", stream("abc"), { contentLength: -1 }),
      "invalid_size",
    );
    await expectStoreError(
      store.put("short-length", stream("abc"), { contentLength: 4 }),
      "invalid_size",
    );
    await expectStoreError(
      store.put("long-length", stream("abc"), { contentLength: 2 }),
      "invalid_size",
    );
    await store.delete("short-length");
    await store.delete("long-length");
  });
}
