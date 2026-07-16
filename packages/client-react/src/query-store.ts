import {
  DbzzClientError,
  type DbzzClient,
  type DbzzConnectionState,
} from "@dbzz/client";

/**
 * Exhaustive live-query state. Success data is `stale` from the moment the
 * connection leaves ready and returns to fresh only when dbzz's own protocol
 * authoritatively re-confirms or redelivers the subscription state (resume,
 * checkpoint, or reset/update delivery). An error keeps the last authoritative
 * rows as `staleData` where any were ever delivered.
 */
export type DbzzQueryState<Rows> =
  | { readonly status: "disabled" }
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly data: Rows; readonly stale: boolean }
  | {
      readonly status: "error";
      readonly error: DbzzClientError;
      readonly staleData: Rows | undefined;
    };

// Shared frozen snapshots for the two data-free states, so equal-state renders
// always observe the same reference.
export const DISABLED_STATE: { readonly status: "disabled" } = Object.freeze({
  status: "disabled",
});
export const PENDING_STATE: { readonly status: "pending" } = Object.freeze({
  status: "pending",
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

/**
 * One live-query external-store entry: a client subscription plus a
 * connection-state observer folded into a single immutable snapshot. The
 * client subscription starts with the first listener and is released with the
 * last one, so entries are inert until React commits — skipped queries and
 * discarded renders never start work, and Strict Mode subscribe/cleanup
 * cycles map one-to-one onto client subscriptions. The listener-count
 * lifecycle is deliberately the sharing contract ISSUE-03's registry keys
 * entries by; this module stays single-consumer.
 */
export class QueryStoreEntry<Rows> {
  private readonly listeners = new Set<() => void>();
  private state: DbzzQueryState<Rows> = PENDING_STATE;
  private stopQuery: (() => void) | null = null;
  private stopConnectionState: (() => void) | null = null;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private retryDeferred = false;

  constructor(
    private readonly client: DbzzClient,
    private readonly address: string,
    private readonly args: unknown,
  ) {}

  /** Immutable snapshot; the same object is returned until the next transition. */
  snapshot(): DbzzQueryState<Rows> {
    return this.state;
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    // A restarted entry (Strict Mode re-subscribe) keeps retained rows as
    // stale until the new subscription's authoritative delivery, and retries
    // after an error that belonged to the released subscription.
    if (this.state.status === "error") {
      this.replace(
        this.state.staleData === undefined
          ? PENDING_STATE
          : { status: "success", data: this.state.staleData, stale: true },
      );
    } else if (this.state.status === "success" && !this.state.stale) {
      this.replace({ status: "success", data: this.state.data, stale: true });
    }
    this.stopConnectionState = this.client.subscribeConnectionState((connection) =>
      this.onConnectionState(connection),
    );
    this.startQuery();
  }

  private startQuery(): void {
    try {
      this.stopQuery = this.client.subscribe(
        this.address,
        this.args,
        (value) => this.onUpdate(value as Rows),
        (error) => this.onError(error),
        { onCursorConfirmed: () => this.onCursorConfirmed() },
      );
    } catch (error) {
      // subscribe() rejects synchronously with the exact DbzzClientError when
      // the client cannot accept the subscription (closed, blocked, over its
      // pending limits, unencodable arguments); that rejection is this
      // query's error state.
      if (!(error instanceof DbzzClientError)) throw error;
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
  }

  private onUpdate(data: Rows): void {
    // Applied reset/update deliveries are authoritative on the live
    // connection: delivered data is always fresh.
    this.settleRetries();
    this.replace({ status: "success", data: deepFreeze(data), stale: false });
  }

  private onCursorConfirmed(): void {
    this.settleRetries();
    if (this.state.status === "success" && this.state.stale) {
      this.replace({ status: "success", data: this.state.data, stale: false });
    }
  }

  private onError(error: DbzzClientError): void {
    this.replace({
      status: "error",
      error,
      staleData:
        this.state.status === "success"
          ? this.state.data
          : this.state.status === "error"
            ? this.state.staleData
            : undefined,
    });
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

  private onConnectionState(connection: DbzzConnectionState): void {
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
    if (this.state.status === "success" && !this.state.stale) {
      this.replace({ status: "success", data: this.state.data, stale: true });
    }
  }

  private replace(state: DbzzQueryState<Rows>): void {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) listener();
  }
}
