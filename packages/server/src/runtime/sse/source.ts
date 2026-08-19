import type { AnyRegisteredSse, SseSource } from "../../app/functions.ts";
import { AckerDBError } from "../../shared/errors.ts";
import { transportError } from "../execution/operation-runner.ts";

interface SseChunkIterator {
  next(): Promise<IteratorResult<unknown, unknown>>;
  /** Returns/cancels the handler's source so its cleanup runs exactly once. */
  release(reason?: unknown): Promise<unknown>;
}

function sseChunkIterator(source: SseSource<unknown>): SseChunkIterator {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    return {
      next: async () => {
        const part = await reader.read();
        return part.done
          ? { done: true, value: undefined }
          : { done: false, value: part.value };
      },
      release: (reason) => reader.cancel(reason),
    };
  }
  if (
    (typeof source === "object" || typeof source === "function") &&
    source !== null &&
    Symbol.asyncIterator in source
  ) {
    const iterator = source[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      release: (reason) =>
        iterator.return === undefined
          ? Promise.resolve()
          : iterator.return(reason),
    };
  }
  throw new AckerDBError(
    "internal",
    "sse handler must return a ReadableStream or async iterable",
  );
}

/**
 * Adapts the handler's returned source into the producer's merge input.
 * Zero high-water: the source advances only when the receiver-credited merge
 * loop asks for the next chunk, so downstream acknowledgement drives the
 * handler. Every chunk crosses the exposed function's standard-JSON codec,
 * which validates it against the declared `yields` validator and converts it
 * to the JSON the document publishes; a failing chunk releases the source and
 * fails the stream with the exact validation error. `handlerContext` restores
 * the invocation-time async context, so generator bodies keep the handler's
 * invocation ownership.
 */
export function validatedSseSource(
  fn: AnyRegisteredSse,
  source: SseSource<unknown>,
  handlerContext: <T>(work: () => T) => T,
): ReadableStream<unknown> {
  const iterator = handlerContext(() => sseChunkIterator(source));
  return new ReadableStream<unknown>(
    {
      pull: async (controller) => {
        const part = await handlerContext(() => iterator.next());
        if (part.done === true) {
          controller.close();
          return;
        }
        let chunk: unknown;
        try {
          chunk = fn.yields.encode(part.value, "chunk");
        } catch (error) {
          // The source's own cleanup failures cannot mask the validation error.
          void Promise.resolve()
            .then(() => handlerContext(() => iterator.release(error)))
            .catch(() => {});
          throw transportError(error);
        }
        controller.enqueue(chunk);
      },
      cancel: async (reason) => {
        await handlerContext(() => iterator.release(reason));
      },
    },
    { highWaterMark: 0 },
  );
}
