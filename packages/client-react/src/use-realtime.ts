import {
  AckerDBClientError,
  getRef,
  stableEncode,
  type AckerDBRealtime,
  type AckerDBRealtimeOn,
  type AckerDBRealtimeOptions,
  type AckerDBRealtimeState,
  type AckerDBClient,
  type AnyRealtimeRef,
  type RealtimeArgs,
  type RealtimeClientEvents,
  type RealtimeClientStreams,
  type RealtimeError,
  type RealtimeServerEvents,
  type RealtimeServerStreams,
  type NativeRTCPeerConnection,
} from "@ackerdb/client";
import {
  useCallback,
  useInsertionEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useProviderClient } from "./provider.tsx";
import {
  noObservation,
  SharedObservation,
  skip,
} from "./query-observation.ts";

export type RealtimeOn<Ref extends AnyRealtimeRef> = AckerDBRealtimeOn<
  RealtimeServerEvents<Ref>,
  RealtimeServerStreams<Ref>,
  RealtimeError<Ref>
>;

export interface UseRealtimeOptions<Ref extends AnyRealtimeRef> {
  /**
   * Makes repeated calls inside one custom hook retain one native peer and
   * one complete handler bundle.
   */
  readonly handlerKey?: string;
  readonly on?: RealtimeOn<Ref>;
}

export type UseRealtimeState<Ref extends AnyRealtimeRef> =
  | { readonly phase: "disabled" }
  | AckerDBRealtimeState<RealtimeError<Ref>>;

export interface UseRealtimeResult<Ref extends AnyRealtimeRef> {
  readonly state: UseRealtimeState<Ref>;
  readonly peerConnection: NativeRTCPeerConnection | null;
  send<Name extends Extract<keyof RealtimeClientEvents<Ref>, string>>(
    event: Name,
    payload: NoInfer<RealtimeClientEvents<Ref>[Name]>,
  ): boolean;
  openStream<Name extends Extract<keyof RealtimeClientStreams<Ref>, string>>(
    stream: Name,
    metadata: NoInfer<RealtimeClientStreams<Ref>[Name]>,
    options?: { readonly size?: number },
  ): {
    readonly id: string;
    readonly writable: WritableStream<Uint8Array>;
  };
  disconnect(): void;
  reconnect(): void;
}

interface CommittedObserver<Ref extends AnyRealtimeRef> {
  readonly source: RealtimeObservation<Ref> | null;
  readonly on: RealtimeOn<Ref> | undefined;
  live: boolean;
}

const CONNECTING: AckerDBRealtimeState<never> = Object.freeze({
  phase: "connecting",
});
const DISABLED: UseRealtimeState<AnyRealtimeRef> = Object.freeze({
  phase: "disabled",
});

class RealtimeObservation<Ref extends AnyRealtimeRef>
  extends SharedObservation<AckerDBRealtimeState<RealtimeError<Ref>>>
{
  private handle: AckerDBRealtime<
    RealtimeClientEvents<Ref>,
    RealtimeClientStreams<Ref>,
    RealtimeError<Ref>
  > | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly client: AckerDBClient,
    private readonly ref: Ref,
    private readonly args: RealtimeArgs<Ref>,
    private readonly options: UseRealtimeOptions<Ref>,
    private readonly on: RealtimeOn<Ref>,
  ) {
    super(CONNECTING);
  }

  get peerConnection(): NativeRTCPeerConnection | null {
    return this.handle?.peerConnection ?? null;
  }

  readonly send = <
    Name extends Extract<keyof RealtimeClientEvents<Ref>, string>,
  >(
    event: Name,
    payload: NoInfer<RealtimeClientEvents<Ref>[Name]>,
  ): boolean => this.handle?.send(event, payload) ?? false;

  readonly openStream = <
    Name extends Extract<keyof RealtimeClientStreams<Ref>, string>,
  >(
    stream: Name,
    metadata: NoInfer<RealtimeClientStreams<Ref>[Name]>,
    options?: { readonly size?: number },
  ) => {
    if (this.handle === null) {
      throw new Error("realtime session is not connected");
    }
    return this.handle.openStream(stream, metadata, options);
  };

  readonly disconnect = (): void => this.handle?.disconnect();
  readonly reconnect = (): void => this.handle?.reconnect();

  protected startObservation(): void {
    if (this.snapshot().phase === "failed") return;
    try {
      const session = this.client.realtime(
        this.ref,
        this.args,
        {
          ...this.options,
          on: this.on,
        } as AckerDBRealtimeOptions<
          RealtimeServerEvents<Ref>,
          RealtimeServerStreams<Ref>,
          RealtimeError<Ref>
        >,
      );
      this.handle = session;
      this.replace(session.currentState);
      this.unsubscribe = session.subscribe(() => {
        this.replace(session.currentState);
      });
    } catch (error) {
      if (!(error instanceof AckerDBClientError)) throw error;
      this.replace({ phase: "failed", error });
    }
  }

  protected stopObservation(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle?.release();
    this.handle = null;
  }
}

/**
 * Retains one typed WebRTC session after commit. Equal client, reference, and
 * canonical arguments are shareable only through the same non-empty
 * `handlerKey`; those calls retain one peer and one complete `on` bundle.
 */
export function useRealtime<Ref extends AnyRealtimeRef>(
  ref: Ref,
  args: NoInfer<RealtimeArgs<Ref>> | typeof skip,
  options: UseRealtimeOptions<Ref> = {},
): UseRealtimeResult<Ref> {
  const client = useProviderClient("useRealtime");
  const address = getRef(ref);
  const identity = args === skip
    ? null
    : stableEncode([args, options.handlerKey ?? null]);
  const latest = useRef<CommittedObserver<Ref> | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo<RealtimeObservation<Ref> | null>(() => {
    if (client === null || args === skip) return null;
    let observation!: RealtimeObservation<Ref>;
    const committed = (): RealtimeOn<Ref> | undefined => {
      const value = latest.current;
      return value !== null &&
          value.live &&
          value.source === observation
        ? value.on
        : undefined;
    };
    const on: RealtimeOn<Ref> = {
      peerConnection(peer) {
        return committed()?.peerConnection?.(peer);
      },
      connected(peer) {
        return committed()?.connected?.(peer);
      },
      track(event) {
        return committed()?.track?.(event);
      },
      stateChange(state, previous) {
        return committed()?.stateChange?.(state, previous);
      },
      event(event) {
        const handler = committed()?.event;
        if (handler === undefined) return;
        return typeof handler === "function"
          ? handler(event)
          : handler[event.type]?.(event.payload);
      },
      stream(input) {
        const handler = committed()?.stream;
        if (handler === undefined) return;
        return typeof handler === "function"
          ? handler(input)
          : handler[input.type]?.(input);
      },
    };
    observation = new RealtimeObservation(
      client,
      ref,
      args,
      options,
      on,
    );
    return observation;
  }, [client, address, identity]);

  useInsertionEffect(() => {
    const committed: CommittedObserver<Ref> = {
      source,
      on: options.on,
      live: true,
    };
    latest.current = committed;
    return () => {
      committed.live = false;
    };
  });

  const subscribe = useCallback(
    (listener: () => void) =>
      source === null ? noObservation() : source.listen(listener),
    [source],
  );
  const getSnapshot = useCallback(
    (): UseRealtimeState<Ref> =>
      source?.snapshot() ?? (
        args === skip
          ? DISABLED as UseRealtimeState<Ref>
          : CONNECTING
      ),
    [source, args],
  );
  const state = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => args === skip
      ? DISABLED as UseRealtimeState<Ref>
      : CONNECTING,
  );
  const send = useCallback(
    (<Name extends Extract<keyof RealtimeClientEvents<Ref>, string>>(
      event: Name,
      payload: NoInfer<RealtimeClientEvents<Ref>[Name]>,
    ) => source?.send(event, payload) ?? false),
    [source],
  );
  const openStream = useCallback(
    (<Name extends Extract<keyof RealtimeClientStreams<Ref>, string>>(
      stream: Name,
      metadata: NoInfer<RealtimeClientStreams<Ref>[Name]>,
      streamOptions?: { readonly size?: number },
    ) => {
      if (source === null) {
        throw new Error("realtime session is not connected");
      }
      return source.openStream(stream, metadata, streamOptions);
    }),
    [source],
  );
  const disconnect = useCallback(() => source?.disconnect(), [source]);
  const reconnect = useCallback(() => source?.reconnect(), [source]);
  const peerConnection = source?.peerConnection ?? null;
  return useMemo(() => Object.freeze({
    state,
    peerConnection,
    send,
    openStream,
    disconnect,
    reconnect,
  }), [
    state,
    peerConnection,
    send,
    openStream,
    disconnect,
    reconnect,
  ]);
}
