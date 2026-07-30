import {
  PROTOCOL_VERSION,
  getRef,
  stableEncode,
  type ApplicationError,
  type AnyChannelRef,
  type ChannelArgs,
  type ChannelClientEvents,
  type ChannelError,
  type ChannelRoom,
  type ChannelServerEvents,
  type ClientMessage,
  type EventMap,
  type EventUnion,
} from "@ackerdb/core";
import type { AckerDBClientError } from "../client.ts";

export type AckerDBChannelOn<Events extends EventMap> =
  | {
      readonly [Name in keyof Events]?: (
        payload: Events[Name],
      ) => void;
    }
  | ((event: EventUnion<Events>) => void);

export type AckerDBChannelState<Error = never> =
  | { readonly phase: "connecting" }
  | { readonly phase: "connected" }
  | { readonly phase: "reconnecting" }
  | { readonly phase: "rejected"; readonly error: Error }
  | { readonly phase: "failed"; readonly error: AckerDBClientError };

type RoomOption<Room> = [Room] extends [never]
  ? { readonly room?: never }
  : { readonly room: Room };

export type AckerDBChannelOptions<
  Room,
  ServerEvents extends EventMap,
> = RoomOption<Room> & {
  /**
   * Coalesces this complete local `on` bundle with another observer carrying
   * the same key. Omit it when both observers should run independently.
   */
  readonly handlerKey?: string;
  readonly on?: AckerDBChannelOn<ServerEvents>;
};

export interface AckerDBChannel<
  ClientEvents extends EventMap,
  Error = never,
> {
  readonly currentState: AckerDBChannelState<Error>;
  send<Name extends Extract<keyof ClientEvents, string>>(
    event: Name,
    payload: NoInfer<ClientEvents[Name]>,
  ): boolean;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export interface ChannelManagerPort {
  allocateId(): number;
  encode(frame: ClientMessage): string;
  retain(frame: string): number;
  release(bytes: number): void;
  ensureConnected(): void;
  canSend(): boolean;
  send(frame: string): boolean;
  generation(): number;
  authEpoch(): number | undefined;
}

interface Observer {
  readonly handlerKey?: string;
  readonly on?: AckerDBChannelOn<EventMap>;
  readonly listeners: Set<() => void>;
  active: boolean;
}

interface Group {
  readonly key: string;
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly hasRoom: boolean;
  readonly room?: unknown;
  readonly frame: string;
  readonly bytes: number;
  readonly observers: Set<Observer>;
  state: AckerDBChannelState<unknown>;
  attemptedGeneration?: number;
  attemptedAuthEpoch?: number;
}

const CONNECTING: AckerDBChannelState<never> = Object.freeze({
  phase: "connecting",
});
const CONNECTED: AckerDBChannelState<never> = Object.freeze({
  phase: "connected",
});
const RECONNECTING: AckerDBChannelState<never> = Object.freeze({
  phase: "reconnecting",
});

export class ChannelManager {
  private readonly byKey = new Map<string, Group>();
  private readonly byId = new Map<number, Group>();

  constructor(private readonly port: ChannelManagerPort) {}

  get hasDemand(): boolean {
    return this.byId.size > 0;
  }

  observe<Ref extends AnyChannelRef>(
    ref: Ref,
    args: NoInfer<ChannelArgs<Ref>>,
    options: AckerDBChannelOptions<
      ChannelRoom<Ref>,
      ChannelServerEvents<Ref>
    >,
  ): AckerDBChannel<ChannelClientEvents<Ref>, ChannelError<Ref>> {
    if (
      options.handlerKey !== undefined &&
      (typeof options.handlerKey !== "string" || options.handlerKey.length === 0)
    ) {
      throw new TypeError("handlerKey must be a non-empty string");
    }
    const address = getRef(ref);
    const hasRoom = Object.hasOwn(options, "room");
    const room = hasRoom ? options.room : undefined;
    const key = stableEncode([
      address,
      args,
      hasRoom
        ? { hasRoom: true, value: room }
        : { hasRoom: false },
    ]);
    let group = this.byKey.get(key);
    if (group === undefined) {
      const id = this.port.allocateId();
      const message = {
        v: PROTOCOL_VERSION,
        t: "channel_join",
        id,
        ref: address,
        args,
        ...(hasRoom ? { room } : {}),
      } satisfies ClientMessage;
      const frame = this.port.encode(message);
      const bytes = this.port.retain(frame);
      group = {
        key,
        id,
        address,
        args,
        hasRoom,
        ...(hasRoom ? { room } : {}),
        frame,
        bytes,
        observers: new Set(),
        state: CONNECTING,
      };
      this.byKey.set(key, group);
      this.byId.set(id, group);
    }

    const observer: Observer = {
      ...(options.handlerKey === undefined
        ? {}
        : { handlerKey: options.handlerKey }),
      ...(options.on === undefined
        ? {}
        : { on: options.on as AckerDBChannelOn<EventMap> }),
      listeners: new Set(),
      active: true,
    };
    group.observers.add(observer);
    this.port.ensureConnected();
    this.flushGroup(group);
    return this.handle(group, observer) as AckerDBChannel<
      ChannelClientEvents<Ref>,
      ChannelError<Ref>
    >;
  }

  flush(): void {
    for (const group of this.byId.values()) this.flushGroup(group);
  }

  connectionLost(): void {
    for (const group of this.byId.values()) {
      group.attemptedGeneration = undefined;
      group.attemptedAuthEpoch = undefined;
      this.replace(group, RECONNECTING);
    }
  }

  ready(id: number, authEpoch: number): void {
    const group = this.byId.get(id);
    if (group === undefined) return;
    group.attemptedGeneration = this.port.generation();
    group.attemptedAuthEpoch = authEpoch;
    this.replace(group, CONNECTED);
  }

  rejected(id: number, authEpoch: number, error: ApplicationError): void {
    const group = this.byId.get(id);
    if (group === undefined) return;
    group.attemptedGeneration = this.port.generation();
    group.attemptedAuthEpoch = authEpoch;
    this.replace(group, Object.freeze({
      phase: "rejected",
      error,
    }));
  }

  failed(id: number, error: AckerDBClientError): boolean {
    const group = this.byId.get(id);
    if (group === undefined) return false;
    this.replace(group, Object.freeze({ phase: "failed", error }));
    return true;
  }

  failAll(error: AckerDBClientError): void {
    for (const group of this.byId.values()) {
      this.replace(group, Object.freeze({ phase: "failed", error }));
    }
  }

  event(id: number, event: string, payload: unknown): boolean {
    const group = this.byId.get(id);
    if (group === undefined) return false;
    if (group.state.phase !== "connected") this.replace(group, CONNECTED);

    const keyed = new Set<string>();
    let firstError: unknown;
    for (const observer of [...group.observers]) {
      if (!observer.active || observer.on === undefined) continue;
      if (observer.handlerKey !== undefined) {
        if (keyed.has(observer.handlerKey)) continue;
        keyed.add(observer.handlerKey);
      }
      try {
        if (typeof observer.on === "function") {
          observer.on(Object.freeze({ type: event, payload }));
        } else {
          observer.on[event]?.(payload);
        }
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      queueMicrotask(() => {
        throw firstError;
      });
    }
    return true;
  }

  close(): void {
    for (const group of [...this.byId.values()]) this.releaseGroup(group, false);
  }

  private handle(group: Group, observer: Observer): AckerDBChannel<EventMap, unknown> {
    let closed = false;
    const manager = this;
    return Object.freeze({
      get currentState(): AckerDBChannelState<unknown> {
        return group.state;
      },
      send(event: string, payload: unknown): boolean {
        if (closed || group.state.phase !== "connected" || !manager.port.canSend()) {
          return false;
        }
        const frame = manager.port.encode({
          v: PROTOCOL_VERSION,
          t: "channel_send",
          id: group.id,
          event,
          payload,
        });
        return manager.port.send(frame);
      },
      subscribe(listener: () => void): () => void {
        if (closed) return () => {};
        observer.listeners.add(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          observer.listeners.delete(listener);
        };
      },
      close(): void {
        if (closed) return;
        closed = true;
        observer.active = false;
        observer.listeners.clear();
        group.observers.delete(observer);
        if (group.observers.size === 0) manager.releaseGroup(group, true);
      },
    });
  }

  private replace(group: Group, state: AckerDBChannelState<unknown>): void {
    if (group.state === state) return;
    group.state = state;
    for (const observer of [...group.observers]) {
      for (const listener of [...observer.listeners]) listener();
    }
  }

  private flushGroup(group: Group): void {
    if (!this.port.canSend()) return;
    const generation = this.port.generation();
    const authEpoch = this.port.authEpoch();
    if (
      authEpoch === undefined ||
      (
        group.attemptedGeneration === generation &&
        group.attemptedAuthEpoch === authEpoch
      )
    ) {
      return;
    }
    if (!this.port.send(group.frame)) return;
    group.attemptedGeneration = generation;
    group.attemptedAuthEpoch = authEpoch;
    if (group.state.phase !== "connected") {
      this.replace(group, generation === 1 ? CONNECTING : RECONNECTING);
    }
  }

  private releaseGroup(group: Group, sendLeave: boolean): void {
    if (this.byId.get(group.id) !== group) return;
    this.byId.delete(group.id);
    this.byKey.delete(group.key);
    this.port.release(group.bytes);
    if (sendLeave && this.port.canSend()) {
      try {
        this.port.send(this.port.encode({
          v: PROTOCOL_VERSION,
          t: "channel_leave",
          id: group.id,
        }));
      } catch {
        // The local observer is already gone; leave is best effort.
      }
    }
  }
}
