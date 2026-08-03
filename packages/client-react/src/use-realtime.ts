import {
  AckerDBClientError,
  getRef,
  stableEncode,
  type AckerDBRealtime,
  type AckerDBRealtimeOn,
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
import { useCallback, useMemo } from "react";
import {
  SharedObservation,
  useCommittedObservation,
} from "./observation.ts";
import { useProviderClient } from "./provider.tsx";
import { skip } from "./query-observation.ts";

export type RealtimeOn<Ref extends AnyRealtimeRef> = AckerDBRealtimeOn<
  RealtimeServerEvents<Ref>,
  RealtimeServerStreams<Ref>,
  RealtimeError<Ref>
>;

export interface UseRealtimeOptions<Ref extends AnyRealtimeRef> {
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
    RealtimeServerEvents<Ref>,
    RealtimeServerStreams<Ref>,
    RealtimeError<Ref>
  > | null = null;
  private unsubscribe: (() => void) | null = null;
  private unobserve: (() => void) | null = null;

  constructor(
    private readonly client: AckerDBClient,
    private readonly ref: Ref,
    private readonly args: RealtimeArgs<Ref>,
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
      const session = this.client.realtime(this.ref, this.args);
      this.handle = session;
      this.unobserve = session.observe(this.on);
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
    this.unobserve?.();
    this.unobserve = null;
    this.handle?.release();
    this.handle = null;
  }
}

/**
 * Retains one typed WebRTC session after commit. Equal client, reference, and
 * canonical arguments share one native peer; each hook observes it with its
 * own current handler bundle.
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
    : stableEncode(args);
  const fallback = args === skip
    ? DISABLED as UseRealtimeState<Ref>
    : CONNECTING;
  const [source, state] = useCommittedObservation<
    UseRealtimeState<Ref>,
    RealtimeOn<Ref> | undefined,
    RealtimeObservation<Ref>
  >(
    (committed) => {
      if (client === null || args === skip) return null;
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
      return new RealtimeObservation(client, ref, args, on);
    },
    [client, address, identity],
    options.on,
    fallback,
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
