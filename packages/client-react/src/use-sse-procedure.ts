import {
  AckerDBClientError,
  getRef,
  refApiPath,
  type AckerDBCallOptions,
  type SseRef,
} from "@ackerdb/client";
import { useCallback } from "react";
import { useProviderClient } from "./provider.tsx";
import { erroredReadableStream, sseReadableStream } from "./sse-stream.ts";

/**
 * The callable `useSseProcedure` returns: invoking it starts one SSE
 * procedure call whose chunks arrive as a standard `ReadableStream`.
 */
export type SseProcedureCall<A, Chunk> = (
  args: A,
  options?: AckerDBCallOptions,
) => ReadableStream<Chunk>;

/**
 * A stable callable for a generated SSE reference. Each invocation returns a
 * `ReadableStream<Chunk>` typed by the reference's server-validated yield
 * type. Consumption is strictly pull-driven (see sse-stream.ts): the request
 * starts on the first read, every downstream pull advances the server
 * iterator and credits the previous chunk, and `cancel()` aborts the request
 * promptly. Streams never restart on disconnect — the existing typed
 * non-resumable/indeterminate outcome is the stream's error.
 *
 * The callable's identity is stable for one provider client lifetime and
 * reference address; provider reconfiguration produces a new callable.
 */
export function useSseProcedure<A, Chunk>(
  ref: SseRef<A, Chunk> | string,
): SseProcedureCall<A, Chunk> {
  const client = useProviderClient("useSseProcedure");
  // The address identifies the callable; the group travels with it, because a
  // group decides which root the stream is fetched from.
  const address = getRef(ref);
  const apiPath = refApiPath(ref);
  return useCallback<SseProcedureCall<A, Chunk>>(
    (args, options = {}) => {
      if (client === null) {
        // Before the provider's commit-phase effect (or during server
        // rendering) there is no client to stream from; report the same
        // typed error channel every other stream failure uses.
        return erroredReadableStream(
          new AckerDBClientError({
            code: "unavailable",
            retryable: false,
            message: "the provider has not created its client yet",
            resource: "sse",
          }),
        );
      }
      // One owned controller per call: stream cancellation and the caller's
      // optional signal both funnel through it into the client request.
      const abort = new AbortController();
      const external = options.signal;
      if (external !== undefined) {
        if (external.aborted) abort.abort(external.reason);
        else {
          external.addEventListener("abort", () => abort.abort(external.reason), {
            once: true,
            // The stream settling aborts `abort`, which unregisters this
            // listener from long-lived caller signals.
            signal: abort.signal,
          });
        }
      }
      return sseReadableStream<Chunk>(
        client.sse<A, Chunk>({ $ref: address, $apiPath: apiPath }, args, {
          signal: abort.signal,
        }),
        abort,
      );
    },
    [client, address, apiPath],
  );
}
