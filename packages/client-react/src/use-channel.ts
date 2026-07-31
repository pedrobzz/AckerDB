import {
  AckerDBClientError,
  getRef,
  stableEncode,
  type AckerDBChannel,
  type AckerDBChannelOn,
  type AckerDBChannelOptions,
  type AckerDBChannelState,
  type AckerDBClient,
  type AnyChannelRef,
  type ChannelArgs,
  type ChannelClientEvents,
  type ChannelError,
  type ChannelRoom,
  type ChannelServerEvents,
  type EventUnion,
} from "@ackerdb/client";
import { useCallback, useMemo } from "react";
import {
  SharedObservation,
  useCommittedObservation,
} from "./observation.ts";
import { useProviderClient } from "./provider.tsx";

export type ChannelOn<Ref extends AnyChannelRef> = AckerDBChannelOn<
  ChannelServerEvents<Ref>
>;

type RoomOption<Ref extends AnyChannelRef> = [ChannelRoom<Ref>] extends [never]
  ? { readonly room?: never }
  : { readonly room: ChannelRoom<Ref> };

export type UseChannelOptions<Ref extends AnyChannelRef> =
  RoomOption<Ref> & {
    /**
     * Coalesces this complete local `on` bundle with every observer carrying
     * the same key. It does not change the shared network subscription.
     */
    readonly handlerKey?: string;
    readonly on?: ChannelOn<Ref>;
  };

export interface UseChannelResult<Ref extends AnyChannelRef> {
  readonly state: AckerDBChannelState<ChannelError<Ref>>;
  send<Name extends Extract<keyof ChannelClientEvents<Ref>, string>>(
    event: Name,
    payload: NoInfer<ChannelClientEvents<Ref>[Name]>,
  ): boolean;
}

const CONNECTING: AckerDBChannelState<never> = Object.freeze({
  phase: "connecting",
});

class ChannelObservation<Ref extends AnyChannelRef>
  extends SharedObservation<AckerDBChannelState<ChannelError<Ref>>>
{
  private handle: AckerDBChannel<
    ChannelClientEvents<Ref>,
    ChannelError<Ref>
  > | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly client: AckerDBClient,
    private readonly ref: Ref,
    private readonly args: ChannelArgs<Ref>,
    private readonly options: UseChannelOptions<Ref>,
    private readonly deliver: (event: EventUnion<ChannelServerEvents<Ref>>) => void,
  ) {
    super(CONNECTING);
  }

  readonly send = <
    Name extends Extract<keyof ChannelClientEvents<Ref>, string>,
  >(
    event: Name,
    payload: NoInfer<ChannelClientEvents<Ref>[Name]>,
  ): boolean => this.handle?.send(event, payload) ?? false;

  protected startObservation(): void {
    if (this.snapshot().phase === "failed") return;
    try {
      const open = this.client.channel.bind(this.client) as unknown as (
        ref: Ref,
        args: ChannelArgs<Ref>,
        options: AckerDBChannelOptions<
          ChannelRoom<Ref>,
          ChannelServerEvents<Ref>
        >,
      ) => AckerDBChannel<ChannelClientEvents<Ref>, ChannelError<Ref>>;
      const channel = open(
        this.ref,
        this.args,
        {
          ...this.options,
          on: this.deliver,
        } as AckerDBChannelOptions<
          ChannelRoom<Ref>,
          ChannelServerEvents<Ref>
        >,
      );
      this.handle = channel;
      this.replace(channel.currentState);
      this.unsubscribe = channel.subscribe(() => {
        this.replace(channel.currentState);
      });
    } catch (error) {
      if (!(error instanceof AckerDBClientError)) throw error;
      this.replace({ phase: "failed", error });
    }
  }

  protected stopObservation(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle?.close();
    this.handle = null;
  }
}

/**
 * Retains one typed application-channel observer for the provider client.
 *
 * Equal client, reference, canonical arguments, and room values share the
 * underlying server membership. Each call's handlers remain independent
 * unless equal `handlerKey` values deliberately coalesce their complete `on`
 * bundles. Recreating callbacks during render never rejoins the channel.
 */
export function useChannel<Ref extends AnyChannelRef>(
  ref: Ref,
  args: NoInfer<ChannelArgs<Ref>>,
  ...options: [ChannelRoom<Ref>] extends [never]
    ? [options?: UseChannelOptions<Ref>]
    : [options: UseChannelOptions<Ref>]
): UseChannelResult<Ref> {
  const client = useProviderClient("useChannel");
  const address = getRef(ref);
  const value = options[0] ?? {} as UseChannelOptions<Ref>;
  const hasRoom = Object.hasOwn(value, "room");
  const identity = stableEncode([
    args,
    hasRoom
      ? { hasRoom: true, value: value.room }
      : { hasRoom: false },
    value.handlerKey ?? null,
  ]);

  // The source owns no transport work until useSyncExternalStore subscribes
  // during commit. Its delivery closure reads the latest committed callback,
  // so ordinary rerenders do not replace the observer or its membership.
  const [source, state] = useCommittedObservation<
    AckerDBChannelState<ChannelError<Ref>>,
    ChannelOn<Ref> | undefined,
    ChannelObservation<Ref>
  >(
    (committedOn) =>
      client === null
        ? null
        : new ChannelObservation(
          client,
          ref,
          args,
          value,
          (event) => {
            const on = committedOn();
            if (on === undefined) return;
            if (typeof on === "function") {
              on(event);
            } else {
              on[event.type]?.(event.payload);
            }
          },
        ),
    [client, address, identity],
    value.on,
    CONNECTING,
  );
  const send = useCallback(
    (<Name extends Extract<keyof ChannelClientEvents<Ref>, string>>(
      event: Name,
      payload: NoInfer<ChannelClientEvents<Ref>[Name]>,
    ) => source?.send(event, payload) ?? false),
    [source],
  );
  return useMemo(() => Object.freeze({ state, send }), [state, send]);
}
