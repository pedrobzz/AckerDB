import type { SseRef } from "@dbzz/client";
import type { ChatTransport, InferUIMessageChunk, UIMessage, UIMessageChunk } from "ai";
import { useEffect, useInsertionEffect, useState } from "react";
import { useSseProcedure, type SseProcedureCall } from "../use-sse-procedure.ts";

// Same commit-ordering rule as use-procedure.ts: the cell must reflect this
// render's callable and mapper before any same-commit effect can send a
// message through the transport. Server rendering runs no effects; the
// fallback only silences React's server-side warning.
const useCommitEffect = typeof document === "undefined" ? useEffect : useInsertionEffect;

/**
 * One chat request as AI SDK v7 hands it to `ChatTransport.sendMessages`,
 * minus the abort signal — the transport wires that into the dbzz call
 * itself. A {@link DbzzChatTransportOptions.prepareArgs} mapper receives this
 * whole object: everything `useChat` forwards for one submission or
 * regeneration, including the per-request `headers`, `body`, and `metadata`
 * accepted by `sendMessage`/`regenerate`.
 */
export interface DbzzChatRequest<UI_MESSAGE extends UIMessage = UIMessage> {
  readonly trigger: "submit-message" | "regenerate-message";
  readonly chatId: string;
  /** The message being regenerated; `undefined` for new submissions. */
  readonly messageId: string | undefined;
  readonly messages: UI_MESSAGE[];
  readonly headers: Record<string, string> | Headers | undefined;
  readonly body: object | undefined;
  readonly metadata: unknown;
}

/**
 * The argument object the transport sends when no `prepareArgs` mapper is
 * given: the wire-encodable standard chat fields. `headers`, `body`, and
 * `metadata` are never defaulted — `Headers` instances are not
 * wire-encodable and the other two carry no declared shape — so a procedure
 * consuming them declares them in its args and maps them explicitly.
 */
export interface DbzzChatArgs<UI_MESSAGE extends UIMessage = UIMessage> {
  readonly trigger: "submit-message" | "regenerate-message";
  readonly chatId: string;
  /** Normalized to `null` so the declared args type is `string | null`. */
  readonly messageId: string | null;
  readonly messages: UI_MESSAGE[];
}

export interface DbzzChatTransportOptions<A, UI_MESSAGE extends UIMessage = UIMessage> {
  /**
   * Maps one AI SDK chat request onto the procedure's argument object.
   * Required whenever the procedure's args are not the standard
   * {@link DbzzChatArgs} shape. Requests use the mapper from the latest
   * committed render, so an inline closure always sees current props.
   *
   * `NoInfer` pins the argument type to the reference: a mapper returning
   * the wrong shape is an error at the mapper, never a silent widening of
   * the procedure's argument type.
   */
  readonly prepareArgs?: (request: DbzzChatRequest<UI_MESSAGE>) => NoInfer<A>;
}

/** {@link DbzzChatTransportOptions} with the mapper mandatory. */
export interface DbzzChatTransportOptionsWithArgs<A, UI_MESSAGE extends UIMessage = UIMessage>
  extends DbzzChatTransportOptions<A, UI_MESSAGE> {
  readonly prepareArgs: (request: DbzzChatRequest<UI_MESSAGE>) => NoInfer<A>;
}

/**
 * Whether sending the standard args object is exactly what the procedure
 * declared. dbzz validates args with exact keys — extra fields are rejected
 * and missing fields fail their validators — so both the field types and the
 * full key set must line up before the mapper may be omitted. `unknown` args
 * (raw addresses, untyped references) keep the mapper optional as the
 * untyped escape hatch.
 */
type AcceptsStandardArgs<A, UI_MESSAGE extends UIMessage> = unknown extends A
  ? true
  : DbzzChatArgs<UI_MESSAGE> extends A
    ? [keyof A, keyof DbzzChatArgs] extends [keyof DbzzChatArgs, keyof A]
      ? true
      : false
    : false;

function standardChatArgs<UI_MESSAGE extends UIMessage>(
  request: DbzzChatRequest<UI_MESSAGE>,
): DbzzChatArgs<UI_MESSAGE> {
  return {
    trigger: request.trigger,
    chatId: request.chatId,
    messageId: request.messageId ?? null,
    messages: request.messages,
  };
}

// Per-hook-instance mutable state shared between renders and the stable
// transport. The transport reads the latest committed callable and mapper
// through it, so its identity never changes across renders, client arrival,
// or provider reconfiguration.
interface Cell<A, UI_MESSAGE extends UIMessage> {
  call: SseProcedureCall<A, InferUIMessageChunk<UI_MESSAGE>>;
  prepareArgs: ((request: DbzzChatRequest<UI_MESSAGE>) => A) | undefined;
  // AI SDK v7's useChat never aborts its active response on unmount, so the
  // hook owns that boundary: unmounting aborts this lifetime, which cancels
  // every request still streaming through the cell (and any send a retained
  // transport issues afterwards) with the client's typed cancellation.
  lifetime: AbortController;
  readonly transport: ChatTransport<UI_MESSAGE>;
}

function createCell<A, UI_MESSAGE extends UIMessage>(
  call: SseProcedureCall<A, InferUIMessageChunk<UI_MESSAGE>>,
  prepareArgs: ((request: DbzzChatRequest<UI_MESSAGE>) => A) | undefined,
): Cell<A, UI_MESSAGE> {
  const cell: Cell<A, UI_MESSAGE> = {
    call,
    prepareArgs,
    lifetime: new AbortController(),
    transport: {
      sendMessages: ({ trigger, chatId, messageId, messages, abortSignal, headers, body, metadata }) => {
        const request: DbzzChatRequest<UI_MESSAGE> = {
          trigger,
          chatId,
          messageId,
          messages,
          headers,
          body,
          metadata,
        };
        // The conditional options tuple only admits an omitted mapper when
        // `DbzzChatArgs` is a valid `A`, which the compiler cannot re-derive
        // here; dbzz's exact args validation remains the runtime authority.
        const args =
          cell.prepareArgs === undefined
            ? (standardChatArgs(request) as unknown as A)
            : cell.prepareArgs(request);
        // One owned controller per request: the AI SDK's abort (useChat's
        // stop) and the hook's unmount lifetime both funnel through it into
        // the dbzz call, which aborts the request and releases the server
        // iterator. The SDK's signal is per-request, so its listener dies
        // with the request; on the hook-lived lifetime signal one inert
        // closure per completed request remains until unmount — bounded by
        // the conversation and released with the hook.
        const owned = new AbortController();
        const lifetime = cell.lifetime.signal;
        if (lifetime.aborted) owned.abort(lifetime.reason);
        else {
          lifetime.addEventListener("abort", () => owned.abort(lifetime.reason), {
            once: true,
            signal: owned.signal,
          });
        }
        if (abortSignal !== undefined) {
          if (abortSignal.aborted) owned.abort(abortSignal.reason);
          else {
            abortSignal.addEventListener("abort", () => owned.abort(abortSignal.reason), {
              once: true,
              signal: owned.signal,
            });
          }
        }
        // The stream is lazy — nothing reaches the server before the AI
        // SDK's first read. Chunks are the server-validated values
        // themselves; no second SSE encoding exists on this path.
        return Promise.resolve<ReadableStream<UIMessageChunk>>(
          cell.call(args, { signal: owned.signal }),
        );
      },
      // dbzz SSE procedures are non-resumable by contract: report "no active
      // stream" (the AI SDK's makeRequest then does nothing) instead of
      // starting a hidden replacement procedure.
      reconnectToStream: () => Promise.resolve(null),
    },
  };
  return cell;
}

/**
 * An AI SDK v7 {@link ChatTransport} over a generated dbzz SSE reference,
 * for `useChat({ transport })`. Standard chat request data flows into the
 * procedure's arguments — directly when the procedure declares the standard
 * {@link DbzzChatArgs} shape, through a typed `prepareArgs` mapper otherwise
 * — and the server's validated `UIMessageChunk` values flow out as the
 * stream the AI SDK consumes. Stopping generation aborts the dbzz request,
 * unmounting the hook aborts every stream it started (useChat leaves
 * responses running on unmount), and stream reconnection is explicitly
 * unsupported.
 *
 * The returned transport's identity is stable for the hook instance's
 * lifetime; each request uses the callable and mapper from the latest
 * committed render.
 */
export function useChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
  A = DbzzChatArgs<UI_MESSAGE>,
>(
  ref: SseRef<A, InferUIMessageChunk<NoInfer<UI_MESSAGE>>> | string,
  ...options: AcceptsStandardArgs<A, UI_MESSAGE> extends true
    ? [options?: DbzzChatTransportOptions<A, UI_MESSAGE>]
    : [options: DbzzChatTransportOptionsWithArgs<A, UI_MESSAGE>]
): ChatTransport<UI_MESSAGE>;
export function useChatTransport<UI_MESSAGE extends UIMessage, A>(
  ref: SseRef<A, InferUIMessageChunk<UI_MESSAGE>> | string,
  options?: DbzzChatTransportOptions<A, UI_MESSAGE>,
): ChatTransport<UI_MESSAGE> {
  const call = useSseProcedure<A, InferUIMessageChunk<UI_MESSAGE>>(ref);
  const prepareArgs = options?.prepareArgs;
  const [cell] = useState(() => createCell<A, UI_MESSAGE>(call, prepareArgs));
  useCommitEffect(() => {
    cell.call = call;
    cell.prepareArgs = prepareArgs;
  });
  // The hook's lifetime bounds every stream it started: unmount aborts them
  // (useChat itself never stops an active response on unmount), and a
  // Strict Mode remount starts a fresh lifetime for the same cell.
  useCommitEffect(() => {
    if (cell.lifetime.signal.aborted) cell.lifetime = new AbortController();
    return () => cell.lifetime.abort();
  }, [cell]);
  return cell.transport;
}
