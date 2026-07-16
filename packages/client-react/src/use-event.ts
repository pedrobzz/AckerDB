import {
  DbzzClientError,
  stableEncode,
  type DbzzClient,
  type DbzzLiveEvent,
  type EventRef,
} from "@dbzz/client";
import { useEffect, useInsertionEffect, useRef } from "react";
import { useProviderClient } from "./provider.tsx";

// The identity and callbacks of the most recent commit. Each subscription
// closure compares against this before delivering, so events still in flight
// from a superseded subscription — or arriving after unmount but before the
// passive cleanup — reach nobody.
interface Committed<Row> {
  readonly onEvent: (event: DbzzLiveEvent<Row>) => void;
  readonly onError: ((error: DbzzClientError) => void) | undefined;
  readonly client: DbzzClient | null;
  readonly address: string;
  readonly key: string;
  live: boolean;
}

/**
 * Subscribes to a typed dbzz event table for the enclosing provider's client
 * lifetime.
 *
 * dbzz event tables are transient, append-only streams: mutations publish rows
 * that are never persisted, so there is nothing to update or delete. The
 * exhaustive event union is therefore the protocol's own: `row`, `gap`,
 * `reset`. The wire gives each cursor exactly one event, so a gap consumes the
 * event at its cursor:
 *
 * - `row`: one newly published event row (every row is an insertion into the
 *   transient stream).
 * - `gap`: at least one matched event was lost while the subscription stayed
 *   live. The server publishes a gap when it could not match or deliver an
 *   event; the client surfaces one itself when a row arrives with a
 *   discontinuous sequence, consuming that row rather than presenting a
 *   stream with a hole it cannot describe. Missed events are never replayed.
 * - `reset`: a new subscription boundary — initial attach, reconnect, or
 *   authentication rotation. The sequence restarts and nothing published
 *   before the boundary is claimed or synthesized. Consumers needing current
 *   state should pair this hook with `useQuery`.
 *
 * The server subscription's identity is (provider lifetime, event reference,
 * canonical argument values). Callback identity changes across rerenders swap
 * the delivered-to functions without touching the subscription. Unmount,
 * argument changes, and provider shutdown release the subscription exactly
 * once; the base client re-establishes it across reconnects and delivers the
 * server's fresh reset boundary.
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
  const address = event.$ref;
  // Canonical value identity, shared with the server's own subscription
  // keying: equal argument values keep the current server subscription
  // regardless of key order; different values replace it.
  const key = stableEncode(args);

  const latest = useRef<Committed<Row> | null>(null);
  // Latest-callback pattern, installed during the mutation phase: by the time
  // any effect or delivery observes it, the commit's callbacks and identity
  // are current, and a render can never churn the subscription just by
  // recreating its callbacks. The cleanup marks the superseded commit dead so
  // an unmounted component fences deliveries that beat the passive cleanup.
  useInsertionEffect(() => {
    const committed: Committed<Row> = { onEvent, onError, client, address, key, live: true };
    latest.current = committed;
    return () => {
      committed.live = false;
    };
  });

  useEffect(() => {
    if (client === null) return;
    const deliverable = (): boolean => {
      const current = latest.current;
      return (
        current !== null &&
        current.live &&
        current.client === client &&
        current.address === address &&
        current.key === key
      );
    };
    try {
      return client.subscribeEvent<A, Row>(
        event,
        args,
        (live) => {
          if (deliverable()) latest.current!.onEvent(live);
        },
        (error) => {
          if (deliverable()) latest.current!.onError?.(error);
        },
      );
    } catch (error) {
      if (!(error instanceof DbzzClientError)) throw error;
      latest.current?.onError?.(error);
      return;
    }
    // The address and key cover the reference and argument values; the
    // objects themselves are recreated per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, key]);
}
