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
    try {
      this.stopQuery = this.client.subscribe(
        this.address,
        this.args,
        (value) => this.onUpdate(value as Rows),
        (error) => this.onError(error),
        { onCursorConfirmed: () => this.onCursorConfirmed() },
      );
    } catch (error) {
      // subscribe() rejects synchronously when the client cannot accept the
      // subscription (closed, blocked, over its pending limits, unencodable
      // arguments); that rejection is this query's error state.
      this.onError(
        error instanceof DbzzClientError
          ? error
          : new DbzzClientError({
              code: "validation",
              retryable: false,
              message: "subscription cannot be encoded",
              resource: "subscription",
            }),
      );
    }
  }

  private stop(): void {
    this.stopQuery?.();
    this.stopQuery = null;
    this.stopConnectionState?.();
    this.stopConnectionState = null;
  }

  private onUpdate(data: Rows): void {
    // Applied reset/update deliveries are authoritative on the live
    // connection: delivered data is always fresh.
    this.replace({ status: "success", data, stale: false });
  }

  private onCursorConfirmed(): void {
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
  }

  private onConnectionState(connection: DbzzConnectionState): void {
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
