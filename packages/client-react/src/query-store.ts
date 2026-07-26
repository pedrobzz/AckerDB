import {
  AckerDBClientError,
  type AckerDBClient,
  type AckerDBConnectionState,
} from "@ackerdb/client";
import type { ApplicationError } from "@ackerdb/core";

type ApplicationErrorState<Error extends ApplicationError> =
  [Error] extends [never]
    ? never
    : {
      readonly status: "application-error";
      readonly data: undefined;
      readonly error: Error;
      readonly loading: false;
    };

/**
 * Exhaustive live-query state. Success data is `stale` from the moment the
 * connection leaves ready and returns to fresh only when ackerdb's own protocol
 * authoritatively re-confirms or redelivers the subscription state (resume,
 * checkpoint, or reset/update delivery). Only transport/unhandled
 * unavailability may retain the last authoritative data. Application and
 * framework errors clear it.
 */
export type AckerDBQueryState<Rows, Error extends ApplicationError = never> =
  | {
      readonly status: "disabled";
      readonly data: undefined;
      readonly error: undefined;
      readonly loading: false;
    }
  | {
      readonly status: "pending";
      readonly data: undefined;
      readonly error: undefined;
      readonly loading: true;
    }
  | {
      readonly status: "success";
      readonly data: Rows;
      readonly error: undefined;
      readonly loading: false;
      readonly stale: false;
    }
  | ApplicationErrorState<Error>
  | {
      readonly status: "rejected";
      readonly data: undefined;
      readonly error: AckerDBClientError;
      readonly loading: false;
    }
  | {
      readonly status: "unavailable";
      readonly data: Rows;
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly stale: true;
    }
  | {
      readonly status: "unavailable";
      readonly data: undefined;
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly stale: false;
    };

// Shared frozen snapshots for the two data-free states, so equal-state renders
// always observe the same reference.
export const DISABLED_STATE = Object.freeze({
  status: "disabled",
  data: undefined,
  error: undefined,
  loading: false,
});
export const PENDING_STATE = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  loading: true,
});

// Re-establishing a rejected-but-retryable subscription mirrors the client's
// own reconnect shape, floored by the server's explicit retry hint.
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 3_000;

// Snapshots promise immutability, so delivered container structure is frozen:
// a consumer sort() or push() would silently corrupt the retained data every
// later state is built from. Binary leaves stay genuine mutable Uint8Arrays.
// The platform has no immutable typed array, and every read-only wrapper
// stops being a real ArrayBuffer view — TextDecoder and Web Crypto reject it
// and Blob/Response mis-serialize it — which breaks correct consumers to
// guard against incorrect ones. Each delivery decodes a fresh byte array, so
// the only possible writer is the consumer itself.
function deepFreeze<T>(value: T): T {
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    if (ArrayBuffer.isView(current) || Object.isFrozen(current)) return;
    Object.freeze(current);
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return value;
}

/** What useQuery observes: an immutable snapshot plus a counted listener slot. */
export interface QuerySource<Rows, Error extends ApplicationError = never> {
  snapshot(): AckerDBQueryState<Rows, Error>;
  listen(listener: () => void): () => void;
}

/**
 * One live-query external-store entry: a client subscription plus a
 * connection-state observer folded into a single immutable snapshot. The
 * client subscription starts with the first listener and is released after
 * the last one leaves, so entries are inert until React commits — skipped
 * queries and discarded renders never start work. The release is deferred by
 * one microtask: React replaces listeners as cleanup-then-setup inside one
 * synchronous effects pass (Strict Mode replays, same-commit consumer
 * handoffs), so the zero-listener instant those create is not lost demand. A
 * listener returning within the window continues the live subscription and
 * its authoritative snapshot, and because socket events arrive as macrotasks,
 * nothing can be delivered while the release is pending.
 */
export class QueryStoreEntry<
  Rows,
  Error extends ApplicationError = never,
> implements QuerySource<Rows, Error> {
  private readonly listeners = new Set<() => void>();
  private state: AckerDBQueryState<Rows, Error> = PENDING_STATE;
  private started = false;
  private releaseScheduled = false;
  private stopQuery: (() => void) | null = null;
  private stopConnectionState: (() => void) | null = null;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private retryDeferred = false;
  private lastApplicationError: Error | null = null;

  constructor(
    private readonly client: AckerDBClient,
    private readonly address: string,
    private readonly args: unknown,
    private readonly onRelease?: () => void,
  ) {}

  /** Immutable snapshot; the same object is returned until the next transition. */
  snapshot(): AckerDBQueryState<Rows, Error> {
    return this.state;
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      this.start();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.scheduleRelease();
    };
  }

  private scheduleRelease(): void {
    if (this.releaseScheduled) return;
    this.releaseScheduled = true;
    queueMicrotask(() => {
      this.releaseScheduled = false;
      if (this.listeners.size > 0 || !this.started) return;
      this.started = false;
      this.stop();
      this.onRelease?.();
    });
  }

  private start(): void {
    this.stopConnectionState = this.client.subscribeConnectionState((connection) =>
      this.onConnectionState(connection),
    );
    this.startQuery();
  }

  private startQuery(): void {
    try {
      this.stopQuery = this.client.subscribe<unknown, Rows, Error>(
        this.address,
        this.args,
        (value) => this.onSuccess(value as Rows),
        (error) => this.onError(error),
        {
          onCursorConfirmed: () => this.onCursorConfirmed(),
          onApplicationError: (error) => this.onApplicationError(error),
        },
      );
    } catch (error) {
      // subscribe() rejects synchronously with the exact AckerDBClientError when
      // the client cannot accept the subscription (closed, blocked, over its
      // pending limits, unencodable arguments); that rejection is this
      // query's error state.
      if (!(error instanceof AckerDBClientError)) throw error;
      this.onError(error);
    }
  }

  private stop(): void {
    this.clearRetry();
    this.retryDeferred = false;
    this.stopQuery?.();
    this.stopQuery = null;
    this.stopConnectionState?.();
    this.stopConnectionState = null;
    this.lastApplicationError = null;
  }

  private onApplicationError(error: Error): void {
    this.settleRetries();
    this.lastApplicationError = error;
    // This callback is only present when the reference carries an Error.
    // TypeScript cannot reduce a conditional type over a still-generic Error,
    // even though receiving the value proves Error is inhabited.
    this.replace({
      status: "application-error",
      data: undefined,
      error,
      loading: false,
    } as ApplicationErrorState<Error>);
  }

  private onSuccess(data: Rows): void {
    // Applied reset/update deliveries are authoritative on the live
    // connection: delivered data is always fresh.
    this.settleRetries();
    this.lastApplicationError = null;
    this.replace({
      status: "success",
      data: deepFreeze(data),
      error: undefined,
      loading: false,
      stale: false,
    });
  }

  private onCursorConfirmed(): void {
    this.settleRetries();
    if (this.state.status !== "unavailable") return;
    if (this.state.data !== undefined) {
      this.replace({
        status: "success",
        data: this.state.data,
        error: undefined,
        loading: false,
        stale: false,
      });
      return;
    }
    if (this.lastApplicationError !== null) {
      this.replace({
        status: "application-error",
        data: undefined,
        error: this.lastApplicationError,
        loading: false,
      } as ApplicationErrorState<Error>);
    }
  }

  private onError(error: AckerDBClientError): void {
    if (error.kind === "framework") {
      this.lastApplicationError = null;
      this.replace({
        status: "rejected",
        data: undefined,
        error,
        loading: false,
      });
    } else {
      const data = this.state.status === "success"
        ? this.state.data
        : this.state.status === "unavailable"
          ? this.state.data
          : undefined;
      this.replace(data === undefined
        ? {
            status: "unavailable",
            data: undefined,
            error,
            loading: false,
            stale: false,
          }
        : {
            status: "unavailable",
            data,
            error,
            loading: false,
            stale: true,
          });
    }
    // A retryable rejection removed the subscription, but the consumer's
    // demand still stands: re-establish it after the server's hint or the
    // client's own backoff shape, whichever is later.
    if (error.retryable && this.listeners.size > 0 && this.retryHandle === null) {
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retryAttempt);
      this.retryAttempt++;
      this.retryHandle = setTimeout(
        () => {
          this.retryHandle = null;
          this.resubscribe();
        },
        Math.max(error.retryAfterMs ?? 0, backoff),
      );
    }
  }

  private resubscribe(): void {
    if (this.listeners.size === 0) return;
    const phase = this.client.currentConnectionState.phase;
    // Failed and closed clients never accept work again for this lifetime.
    if (phase === "terminal-error" || phase === "closed") return;
    // A blocked client rejects new subscriptions until refreshCredential()
    // recovers it; hold the demand and resubscribe on that recovery instead
    // of consuming the retry here.
    if (phase === "authentication-blocked") {
      this.retryDeferred = true;
      return;
    }
    this.stopQuery?.();
    this.stopQuery = null;
    this.startQuery();
  }

  private settleRetries(): void {
    // An authoritative delivery proves the subscription healthy: cancel any
    // scheduled resubscribe and restart the backoff shape.
    this.retryAttempt = 0;
    this.retryDeferred = false;
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private onConnectionState(connection: AckerDBConnectionState): void {
    // A deferred retry fires once the client leaves its blocked state, e.g.
    // when refreshCredential() installs new credentials.
    if (
      this.retryDeferred &&
      connection.phase !== "authentication-blocked" &&
      connection.phase !== "terminal-error" &&
      connection.phase !== "closed"
    ) {
      this.retryDeferred = false;
      this.resubscribe();
    }
    // Leaving ready means held rows can no longer be assumed current. Ready
    // itself proves nothing for this query — freshness returns only through
    // the subscription's own resume/reset confirmation.
    if (connection.phase === "ready") return;
    const error = new AckerDBClientError({
      code: "unavailable",
      retryable: true,
      message: "query freshness is unavailable while reconnecting",
      resource: "subscription",
    });
    if (this.state.status === "success") {
      this.replace({
        status: "unavailable",
        data: this.state.data,
        error,
        loading: false,
        stale: true,
      });
    } else if (this.state.status === "application-error") {
      this.replace({
        status: "unavailable",
        data: undefined,
        error,
        loading: false,
        stale: false,
      });
    }
  }

  private replace(state: AckerDBQueryState<Rows, Error>): void {
    Object.freeze(state);
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Shared live-query registry for one client lifetime. Consumers addressing
 * the same query with canonically equal arguments observe one entry — one
 * client subscription and one snapshot object — while different addresses or
 * argument values never share. Entries are created only when a listener
 * commits and evicted when their deferred release actually runs, so discarded
 * React renders never register anything, same-pass listener handoffs adopt
 * the live entry, and a key whose subscription was truly released starts one
 * clean new query lifetime.
 */
export class QueryRegistry {
  private readonly entries = new Map<string, QueryStoreEntry<unknown, ApplicationError>>();

  constructor(private readonly client: AckerDBClient) {}

  /**
   * The observation surface for one (address, canonical arguments) pair.
   * Reading the snapshot never creates an entry; without one the state is the
   * shared pending constant a fresh entry would report anyway.
   */
  source<Rows, Error extends ApplicationError = never>(
    address: string,
    argsKey: string,
    args: unknown,
  ): QuerySource<Rows, Error> {
    // argsKey is stableEncode output — JSON, whose strings escape control
    // characters — so neither half can contain a literal NUL and structurally
    // similar (address, args) pairs cannot forge each other's key.
    const key = `${address}\u0000${argsKey}`;
    return {
      snapshot: () =>
        (this.entries.get(key)?.snapshot() ?? PENDING_STATE) as AckerDBQueryState<Rows, Error>,
      listen: (listener) => {
        const entry = this.entries.get(key) ?? this.register(key, address, args);
        return entry.listen(listener);
      },
    };
  }

  private register(
    key: string,
    address: string,
    args: unknown,
  ): QueryStoreEntry<unknown, ApplicationError> {
    const entry = new QueryStoreEntry<unknown, ApplicationError>(this.client, address, args, () => {
      // The entry's release ran with no surviving listeners: its client
      // subscription is gone, so the key must read as a clean lifetime again.
      // The identity check keeps a stale release from evicting a successor.
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.entries.set(key, entry);
    return entry;
  }
}

// One registry per client, resolved by client identity: the provider replaces
// the client on reconfiguration, so a new lifetime can never observe the
// previous lifetime's entries, and each registry is released with its client.
const registries = new WeakMap<AckerDBClient, QueryRegistry>();

export function queryRegistryFor(client: AckerDBClient): QueryRegistry {
  let registry = registries.get(client);
  if (registry === undefined) {
    registry = new QueryRegistry(client);
    registries.set(client, registry);
  }
  return registry;
}
