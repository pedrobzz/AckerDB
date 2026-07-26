/**
 * Adapts AckerDBClient.sse's acknowledged async generator into a standard
 * `ReadableStream<Chunk>` without changing ackerdb's delivery semantics:
 *
 * - Zero high-water mark and no priming read: nothing is requested from the
 *   server until the consumer pulls, and each pull advances the generator by
 *   exactly one chunk — which is also what sends the previous chunk's
 *   receiver credit. Backpressure and acknowledgement order stay exact.
 * - The request itself starts lazily with the first pull; a stream that is
 *   cancelled before it is ever read never contacts the server.
 * - `cancel()` aborts the in-flight request/acknowledgement and returns the
 *   generator so the client releases its reader, reservation, and fetch.
 * - Generator failures (validation, disconnect, terminal outcomes) surface
 *   as the stream's error with the exact `AckerDBClientError` value.
 *
 * The controller is aborted at every terminal point (done, failure, cancel),
 * which also releases anything the caller registered against its signal.
 */
export function sseReadableStream<Chunk>(
  iterator: AsyncGenerator<Chunk, void, undefined>,
  abort: AbortController,
): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>(
    {
      pull: async (controller) => {
        let part: IteratorResult<Chunk, void>;
        try {
          part = await iterator.next();
        } catch (error) {
          abort.abort(error);
          throw error;
        }
        if (part.done) {
          abort.abort();
          controller.close();
        } else {
          controller.enqueue(part.value);
        }
      },
      cancel: async (reason) => {
        abort.abort(reason);
        try {
          await iterator.return(undefined);
        } catch {
          // Cancellation owns the outcome; generator cleanup cannot change it.
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/** A stream that fails on first read with a typed error and nothing else. */
export function erroredReadableStream<Chunk>(error: unknown): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start: (controller) => {
      controller.error(error);
    },
  });
}
