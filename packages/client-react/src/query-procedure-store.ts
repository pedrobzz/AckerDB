import {
  AckerDBClientError,
  type AckerDBClient,
  type AckerDBConnectionState,
} from "@ackerdb/client";
import {
  isApplicationError,
  type ApplicationError,
} from "@ackerdb/core";
import {
  DISABLED_STATE,
  PENDING_STATE,
  SharedObservation,
  queryApplicationError,
  queryClientError,
  queryConnectionUnavailable,
  querySuccess,
  type AckerDBQueryState,
  type ObservationSource,
} from "./query-observation.ts";

export interface AckerDBQueryProcedureOptions {
  readonly refreshIntervalMs?: number;
}

type Refreshable<State> = State extends unknown
  ? State & { readonly refresh: () => void }
  : never;

export type AckerDBQueryProcedureState<
  Data,
  Error extends ApplicationError = never,
> = Refreshable<AckerDBQueryState<Data, Error>>;

export type QueryProcedureSource<
  Data,
  Error extends ApplicationError = never,
> = ObservationSource<AckerDBQueryProcedureState<Data, Error>>;

const noRefresh = (): void => {};

function withRefresh<Data, Error extends ApplicationError = never>(
  state: AckerDBQueryState<Data, Error>,
  refresh: () => void,
): AckerDBQueryProcedureState<Data, Error> {
  return Object.freeze({ ...state, refresh }) as AckerDBQueryProcedureState<Data, Error>;
}

export const DISABLED_QUERY_PROCEDURE_STATE = withRefresh<never, never>(
  DISABLED_STATE,
  noRefresh,
);
export const PENDING_QUERY_PROCEDURE_STATE = withRefresh<never, never>(
  PENDING_STATE,
  noRefresh,
);

export class QueryProcedureEntry<
  Data,
  Error extends ApplicationError = never,
> extends SharedObservation<AckerDBQueryProcedureState<Data, Error>> {
  private readonly refresh: () => void;
  private stopConnectionState: (() => void) | null = null;
  private activeController: AbortController | null = null;
  private refreshHandle: ReturnType<typeof setTimeout> | null = null;
  private refreshAfterExecution = false;
  private connectionPhase: AckerDBConnectionState["phase"];

  constructor(
    private readonly client: AckerDBClient,
    private readonly address: string,
    private readonly args: unknown,
    private readonly refreshIntervalMs: number | undefined,
    onRelease?: () => void,
  ) {
    let requestRefresh: (() => void) | undefined;
    const refresh = (): void => requestRefresh?.();
    super(withRefresh<Data, Error>(PENDING_STATE, refresh), onRelease);
    this.refresh = refresh;
    requestRefresh = () => this.requestRefresh();
    this.connectionPhase = client.currentConnectionState.phase;
  }

  protected startObservation(): void {
    this.stopConnectionState = this.client.subscribeConnectionState((connection) =>
      this.onConnectionState(connection),
    );
    this.execute();
  }

  protected stopObservation(): void {
    this.clearRefresh();
    this.refreshAfterExecution = false;
    this.stopConnectionState?.();
    this.stopConnectionState = null;
    const controller = this.activeController;
    this.activeController = null;
    controller?.abort();
  }

  private requestRefresh(): void {
    if (!this.hasDemand) return;
    this.clearRefresh();
    if (this.activeController !== null) {
      this.refreshAfterExecution = true;
      return;
    }
    this.execute();
  }

  private execute(): void {
    if (!this.hasDemand || this.activeController !== null) return;
    this.clearRefresh();
    const controller = new AbortController();
    this.activeController = controller;
    void this.client
      .procedure<unknown, Data, Error>(
        this.address,
        this.args,
        { signal: controller.signal },
      )
      .then((result) => {
        if (this.activeController !== controller) return;
        this.activeController = null;
        if (!this.hasDemand) return;

        let retryAfterMs = 0;
        if (result.ok) {
          this.publish(querySuccess<Data, Error>(result.data));
        } else if (isApplicationError(result.error)) {
          this.publish(queryApplicationError<Data, Error>(result.error as Error));
        } else {
          retryAfterMs = result.error.retryAfterMs ?? 0;
          this.publish(queryClientError(this.snapshot(), result.error));
        }

        if (this.refreshAfterExecution) {
          this.refreshAfterExecution = false;
          this.execute();
          return;
        }
        this.scheduleRefresh(retryAfterMs);
      });
  }

  private scheduleRefresh(retryAfterMs: number): void {
    if (
      this.refreshIntervalMs === undefined ||
      this.client.currentConnectionState.phase !== "ready"
    ) {
      return;
    }
    const delayMs = Math.max(this.refreshIntervalMs, retryAfterMs);
    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = null;
      this.execute();
    }, delayMs);
  }

  private clearRefresh(): void {
    if (this.refreshHandle === null) return;
    clearTimeout(this.refreshHandle);
    this.refreshHandle = null;
  }

  private onConnectionState(connection: AckerDBConnectionState): void {
    const previousPhase = this.connectionPhase;
    this.connectionPhase = connection.phase;
    if (connection.phase === "ready") {
      if (previousPhase !== "ready" && this.activeController === null) {
        this.clearRefresh();
        this.execute();
      }
      return;
    }
    const error = new AckerDBClientError({
      code: "unavailable",
      retryable: true,
      message: "query procedure freshness is unavailable while reconnecting",
      resource: "operation",
    });
    this.publish(queryConnectionUnavailable(this.snapshot(), error));
  }

  private publish(state: AckerDBQueryState<Data, Error>): void {
    this.replace(withRefresh(state, this.refresh));
  }
}

export class QueryProcedureRegistry {
  private readonly entries = new Map<
    string,
    QueryProcedureEntry<unknown, ApplicationError>
  >();

  constructor(private readonly client: AckerDBClient) {}

  source<Data, Error extends ApplicationError = never>(
    address: string,
    argsKey: string,
    args: unknown,
    refreshIntervalMs: number | undefined,
  ): QueryProcedureSource<Data, Error> {
    const key = `${address}\u0000${argsKey}\u0000${refreshIntervalMs ?? ""}`;
    return {
      snapshot: () =>
        (this.entries.get(key)?.snapshot() ??
          PENDING_QUERY_PROCEDURE_STATE) as AckerDBQueryProcedureState<Data, Error>,
      listen: (listener) => {
        const entry =
          this.entries.get(key) ??
          this.register(key, address, args, refreshIntervalMs);
        return entry.listen(listener);
      },
    };
  }

  private register(
    key: string,
    address: string,
    args: unknown,
    refreshIntervalMs: number | undefined,
  ): QueryProcedureEntry<unknown, ApplicationError> {
    const entry = new QueryProcedureEntry<unknown, ApplicationError>(
      this.client,
      address,
      args,
      refreshIntervalMs,
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.entries.set(key, entry);
    return entry;
  }
}

const registries = new WeakMap<AckerDBClient, QueryProcedureRegistry>();

export function queryProcedureRegistryFor(
  client: AckerDBClient,
): QueryProcedureRegistry {
  let registry = registries.get(client);
  if (registry === undefined) {
    registry = new QueryProcedureRegistry(client);
    registries.set(client, registry);
  }
  return registry;
}
