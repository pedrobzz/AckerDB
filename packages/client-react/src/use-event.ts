import { DbzzClientError, type DbzzLiveEvent, type EventRef } from "@dbzz/client";
import { useEffect, useInsertionEffect, useRef } from "react";
import { useProviderClient } from "./provider.tsx";

// Value identity for one subscription's arguments: equal values keep the
// current server subscription, different values replace it. Arguments are wire
// values, so bigints are the one JSON-hostile shape to cover.
function argsKey(args: unknown): string {
  return (
    JSON.stringify(args, (_key, value: unknown) =>
      typeof value === "bigint" ? `\u0000bigint:${value}` : value,
    ) ?? ""
  );
}

/**
 * Subscribes to a typed dbzz event table for the enclosing provider's client
 * lifetime.
 *
 * dbzz event tables are transient, append-only streams: mutations publish rows
 * that are never persisted, so there is nothing to update or delete. The
 * exhaustive event union is therefore exactly what the wire protocol carries:
 *
 * - `row`: one newly published event row (every row is an insertion into the
 *   transient stream).
 * - `gap`: at least one matched event was dropped while the subscription
 *   stayed live (server backpressure or an observed sequence discontinuity).
 *   Missed events are never replayed.
 * - `reset`: a new subscription boundary — initial attach, reconnect, or
 *   authentication rotation. The sequence restarts and nothing published
 *   before the boundary is claimed or synthesized. Consumers needing current
 *   state should pair this hook with `useQuery`.
 *
 * The server subscription's identity is (provider lifetime, event reference,
 * argument values). Callback identity changes across rerenders swap the
 * delivered-to functions without touching the subscription. Unmount, argument
 * changes, and provider shutdown release the subscription exactly once; the
 * base client re-establishes it across reconnects and delivers the server's
 * fresh reset boundary.
 *
 * When the client cannot accept subscriptions (closed, terminal protocol
 * failure, authentication-blocked, or pending-state limits) the failure is
 * reported to `onError` as an exact `DbzzClientError` value instead of
 * throwing through the component tree. Errors follow base-client semantics: a
 * server rejection ends that subscription, while an authentication block
 * keeps it registered and the recovered connection re-attaches it behind a
 * fresh reset boundary.
 */
export function useEvent<A, Row>(
  event: EventRef<A, Row>,
  args: NoInfer<A>,
  onEvent: (event: DbzzLiveEvent<Row>) => void,
  onError?: (error: DbzzClientError) => void,
): void {
  const client = useProviderClient("useEvent");
  const latest = useRef({ onEvent, onError });
  // Latest-callback pattern: committed before any effect resubscribes, so a
  // render can never churn the subscription just by recreating its callbacks.
  useInsertionEffect(() => {
    latest.current = { onEvent, onError };
  });

  const address = event.$ref;
  const key = argsKey(args);
  useEffect(() => {
    if (client === null) return;
    try {
      return client.subscribeEvent<A, Row>(
        event,
        args,
        (live) => latest.current.onEvent(live),
        (error) => latest.current.onError?.(error),
      );
    } catch (error) {
      if (!(error instanceof DbzzClientError)) throw error;
      latest.current.onError?.(error);
      return;
    }
    // The address and key cover the reference and argument values; the
    // objects themselves are recreated per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, key]);
}
