import {
  AckerDBClientError,
  type AckerDBAuthentication,
  type AckerDBAuthenticationState,
  type AckerDBClient,
  type AckerDBConnectionState,
} from "@ackerdb/client";
import type { ApplicationError } from "@ackerdb/core";
import {
  SharedObservation,
  type ObservationSource,
} from "./observation.ts";
import {
  PENDING_STATE,
  queryApplicationError,
  queryClientError,
  queryConnectionUnavailable,
  querySuccess,
  type AckerDBQueryState,
} from "./query-observation.ts";

export type { AckerDBQueryState } from "./query-observation.ts";

/**
 * Whether two server-accepted authentications describe the same principal.
 * Epochs are compared separately by the caller: they reset per connection, so
 * shape equality parks demand across reconnects, while a same-connection
 * epoch advance is a genuinely new presentation whose claims may have changed
 * even for an identical subject — access policies see the full principal,
 * claims included, so it must re-present.
 */
function samePrincipal(
  rejected: AckerDBAuthentication | undefined,
  accepted: AckerDBAuthentication,
): boolean {
  if (rejected === undefined) return false;
  if (rejected.principal === "anonymous" || accepted.principal === "anonymous") {
    return rejected.principal === accepted.principal;
  }
  if (rejected.principal !== accepted.principal) return false;
  if (
    rejected.provenance.issuer !== accepted.provenance.issuer ||
    rejected.provenance.subject !== accepted.provenance.subject
  ) {
    return false;
  }
  return rejected.principal !== "user" ||
    accepted.principal !== "user" ||
    rejected.identity === accepted.identity;
}

/** What useQuery observes: an immutable snapshot plus a counted listener slot. */
export type QuerySource<Rows, Error extends ApplicationError = never> =
  ObservationSource<AckerDBQueryState<Rows, Error>>;

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
> extends SharedObservation<AckerDBQueryState<Rows, Error>> {
  private stopQuery: (() => void) | null = null;
  private stopConnectionState: (() => void) | null = null;
  private stopAuthenticationState: (() => void) | null = null;
  private lastApplicationError: Error | null = null;
  /**
   * Awaiting principal change: the server rejected this demand with an
   * authentication or authorization outcome while the demand itself persists.
   * It is re-presented exactly when the accepted principal changes — never on
   * a timer, because a rejection without a principal change would only repeat.
   */
  private awaitingPrincipalChange = false;
  /** The accepted authentication under which the rejection happened, if any. */
  private rejectedUnder: AckerDBAuthentication | undefined;

  constructor(
    private readonly client: AckerDBClient,
    private readonly address: string,
    private readonly args: unknown,
    onRelease?: () => void,
  ) {
    super(PENDING_STATE, onRelease);
  }

  protected startObservation(): void {
    this.stopConnectionState = this.client.subscribeConnectionState((connection) =>
      this.onConnectionState(connection),
    );
    this.stopAuthenticationState = this.client.subscribeAuthenticationState((state) =>
      this.onAuthenticationState(state),
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

  protected stopObservation(): void {
    this.stopQuery?.();
    this.stopQuery = null;
    this.stopConnectionState?.();
    this.stopConnectionState = null;
    this.stopAuthenticationState?.();
    this.stopAuthenticationState = null;
    this.lastApplicationError = null;
    this.awaitingPrincipalChange = false;
    this.rejectedUnder = undefined;
  }

  private onApplicationError(error: Error): void {
    this.lastApplicationError = error;
    // This callback is only present when the reference carries an Error.
    // TypeScript cannot reduce a conditional type over a still-generic Error,
    // even though receiving the value proves Error is inhabited.
    this.replace(queryApplicationError<Rows, Error>(error));
  }

  private onSuccess(data: Rows): void {
    // Applied reset/update deliveries are authoritative on the live
    // connection: delivered data is always fresh.
    this.lastApplicationError = null;
    this.replace(querySuccess<Rows, Error>(data));
  }

  private onCursorConfirmed(): void {
    const state = this.snapshot();
    if (state.status !== "unavailable") return;
    if (state.data !== undefined) {
      this.replace({
        status: "success",
        data: state.data,
        error: undefined,
        loading: false,
        stale: false,
      });
      return;
    }
    if (this.lastApplicationError !== null) {
      this.replace(queryApplicationError<Rows, Error>(this.lastApplicationError));
    }
  }

  private onError(error: AckerDBClientError): void {
    if (error.kind === "framework") this.lastApplicationError = null;
    if (error.code === "unauthenticated" || error.code === "unauthorized") {
      // Armed one microtask later, when the client's own state cascade has
      // settled: a session-wide credential failure publishes refresh-required
      // by then — there the client keeps this demand and resubscribes it
      // itself. Only a per-demand policy rejection under a still-accepted
      // principal leaves dropped demand for this entry to re-present, and
      // socket events are macrotasks, so nothing can race the sample.
      queueMicrotask(() => {
        if (this.stopConnectionState === null) return;
        const phase = this.client.currentAuthenticationState.phase;
        if (phase !== "authenticated" && phase !== "unauthenticated") return;
        this.awaitingPrincipalChange = true;
        this.rejectedUnder = this.client.currentAuthentication;
      });
    }
    this.replace(queryClientError(this.snapshot(), error));
  }

  private onAuthenticationState(state: AckerDBAuthenticationState): void {
    if (!this.awaitingPrincipalChange) return;
    // Only a server-accepted principal can decide differently than the one
    // that rejected; presentations in flight and blocked states prove nothing.
    if (state.phase !== "authenticated" && state.phase !== "unauthenticated") return;
    if (
      samePrincipal(this.rejectedUnder, state.authentication) &&
      this.rejectedUnder!.authEpoch === state.authentication.authEpoch
    ) {
      return;
    }
    this.awaitingPrincipalChange = false;
    this.rejectedUnder = undefined;
    // The client already dropped a non-retryably rejected subscription;
    // releasing first makes the restart safe on every rejection path.
    this.stopQuery?.();
    this.stopQuery = null;
    this.startQuery();
  }

  private onConnectionState(connection: AckerDBConnectionState): void {
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
    this.replace(queryConnectionUnavailable(this.snapshot(), error));
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
