/**
 * Function references: the typed, opaque addresses clients use to name server
 * functions. At runtime a reference is just a dot-joined address string
 * ("messages.list"); the generic parameters carry kind/args/data/error types so
 * every call is end-to-end typed through codegen.
 */

import type { ErrResult, OkResult } from "./result.ts";

export type FunctionKind = "query" | "mutation" | "procedure" | "sse" | "event";

export interface FunctionReference<
  K extends FunctionKind = FunctionKind,
  A = unknown,
  Data = unknown,
  Error = never,
> {
  readonly $ref: string;
  readonly _kind?: K;
  readonly _args?: A;
  readonly _ret?: Data;
  readonly _error?: Error;
}

export type QueryRef<A = unknown, Data = unknown, Error = never> =
  FunctionReference<"query", A, Data, Error>;
export type MutationRef<A = unknown, Data = unknown, Error = never> =
  FunctionReference<"mutation", A, Data, Error>;
export type ProcedureRef<A = unknown, Data = unknown, Error = never> =
  FunctionReference<"procedure", A, Data, Error>;
/** An SSE reference's second parameter is the validated per-chunk type the
 *  stream yields to clients — never the handler's completion value. */
export type SseRef<A = unknown, Chunk = unknown> = FunctionReference<"sse", A, Chunk>;
export type EventRef<A = unknown, Row = unknown> = FunctionReference<"event", A, Row>;

export type EventMap = Readonly<Record<string, unknown>>;

/** One named event in a typed channel or realtime event map. */
export type EventUnion<Events extends EventMap> = {
  readonly [Name in Extract<keyof Events, string>]: {
    readonly type: Name;
    readonly payload: Events[Name];
  };
}[Extract<keyof Events, string>];

/**
 * A typed application-channel address. `Room = never` means the server
 * declaration is roomless and callers must not supply a room.
 */
export interface ChannelRef<
  A = unknown,
  Room = never,
  ClientEvents extends EventMap = EventMap,
  ServerEvents extends EventMap = EventMap,
  Error = never,
> {
  readonly $ref: string;
  readonly _kind?: "channel";
  readonly _args?: A;
  readonly _room?: Room;
  readonly _clientEvents?: ClientEvents;
  readonly _serverEvents?: ServerEvents;
  readonly _error?: Error;
}

export type AnyChannelRef = ChannelRef<
  unknown,
  unknown,
  EventMap,
  EventMap,
  unknown
>;

export type RealtimeStreamMap = Readonly<Record<string, unknown>>;

/**
 * A typed WebRTC media-session address. Media uses native tracks; these maps
 * describe only the reliable ordered data channel's events and finite byte
 * streams.
 */
export interface RealtimeRef<
  A = unknown,
  ClientEvents extends EventMap = EventMap,
  ServerEvents extends EventMap = EventMap,
  ClientStreams extends RealtimeStreamMap = RealtimeStreamMap,
  ServerStreams extends RealtimeStreamMap = RealtimeStreamMap,
  Error = never,
> {
  readonly $ref: string;
  readonly _kind?: "realtime";
  readonly _args?: A;
  readonly _clientEvents?: ClientEvents;
  readonly _serverEvents?: ServerEvents;
  readonly _clientStreams?: ClientStreams;
  readonly _serverStreams?: ServerStreams;
  readonly _error?: Error;
}

export type AnyRealtimeRef = RealtimeRef<
  unknown,
  EventMap,
  EventMap,
  RealtimeStreamMap,
  RealtimeStreamMap,
  unknown
>;

/** Accepts a reference object or a raw address string; returns the address. */
export function getRef(
  ref:
    | FunctionReference<FunctionKind, unknown, unknown, unknown>
    | AnyChannelRef
    | AnyRealtimeRef
    | string,
): string {
  if (typeof ref === "string") return ref;
  const address = ref.$ref;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("not a ackerdb function reference");
  }
  return address;
}

export type ChannelArgs<Ref extends AnyChannelRef> =
  Ref extends ChannelRef<infer Args, unknown, EventMap, EventMap, unknown> ? Args : never;
export type ChannelRoom<Ref extends AnyChannelRef> =
  Ref extends ChannelRef<unknown, infer Room, EventMap, EventMap, unknown> ? Room : never;
export type ChannelClientEvents<Ref extends AnyChannelRef> =
  Ref extends ChannelRef<unknown, unknown, infer Events, EventMap, unknown> ? Events : never;
export type ChannelServerEvents<Ref extends AnyChannelRef> =
  Ref extends ChannelRef<unknown, unknown, EventMap, infer Events, unknown> ? Events : never;
export type ChannelError<Ref extends AnyChannelRef> =
  Ref extends ChannelRef<unknown, unknown, EventMap, EventMap, infer Error> ? Error : never;
export type RealtimeArgs<Ref extends AnyRealtimeRef> =
  Ref extends RealtimeRef<
    infer Args,
    EventMap,
    EventMap,
    RealtimeStreamMap,
    RealtimeStreamMap,
    unknown
  > ? Args : never;
export type RealtimeClientEvents<Ref extends AnyRealtimeRef> =
  Ref extends RealtimeRef<
    unknown,
    infer Events,
    EventMap,
    RealtimeStreamMap,
    RealtimeStreamMap,
    unknown
  > ? Events : never;
export type RealtimeServerEvents<Ref extends AnyRealtimeRef> =
  Ref extends RealtimeRef<
    unknown,
    EventMap,
    infer Events,
    RealtimeStreamMap,
    RealtimeStreamMap,
    unknown
  > ? Events : never;
export type RealtimeClientStreams<Ref extends AnyRealtimeRef> =
  Ref extends RealtimeRef<
    unknown,
    EventMap,
    EventMap,
    infer Streams,
    RealtimeStreamMap,
    unknown
  > ? Streams : never;
export type RealtimeServerStreams<Ref extends AnyRealtimeRef> =
  Ref extends RealtimeRef<
    unknown,
    EventMap,
    EventMap,
    RealtimeStreamMap,
    infer Streams,
    unknown
  > ? Streams : never;
export type RealtimeError<Ref extends AnyRealtimeRef> =
  Ref extends RealtimeRef<
    unknown,
    EventMap,
    EventMap,
    RealtimeStreamMap,
    RealtimeStreamMap,
    infer Error
  > ? Error : never;

function makeRefProxy(path: string): unknown {
  return new Proxy(
    { $ref: path },
    {
      get(target, prop) {
        if (prop === "$ref") return path;
        if (typeof prop !== "string") return Reflect.get(target, prop);
        return makeRefProxy(path === "" ? prop : `${path}.${prop}`);
      },
    },
  );
}

/**
 * Untyped reference builder: `anyApi.messages.list` yields the reference for
 * address "messages.list". Generated `api.ts` casts this to the typed api.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const anyApi: any = makeRefProxy("");

/**
 * The marker interface every registered server function satisfies (the server
 * package's `query()`, `mutation()`, ... return types extend it). Lives in
 * core so generated `api.ts` can derive reference types from type-only imports
 * of the user's function modules without touching server code.
 */
export interface RegisteredFunction<K extends FunctionKind = FunctionKind, A = unknown, R = unknown> {
  readonly isAckerDB: true;
  readonly kind: K;
  readonly _argsType?: A;
  readonly _retType?: R;
}

/**
 * Type-only marker implemented by the server package's `channel()` return.
 * It lives in core so generated client APIs infer the complete event contract
 * without importing server runtime code.
 */
export interface RegisteredChannelContract<
  A = unknown,
  Room = never,
  ClientEvents extends EventMap = EventMap,
  ServerEvents extends EventMap = EventMap,
  Error = never,
> {
  readonly isAckerDBChannel: true;
  readonly kind: "channel";
  readonly _argsType?: A;
  readonly _roomType?: Room;
  readonly _clientEventsType?: ClientEvents;
  readonly _serverEventsType?: ServerEvents;
  readonly _errorType?: Error;
}

/** Type-only marker implemented by the server package's `realtime()` return. */
export interface RegisteredRealtimeContract<
  A = unknown,
  ClientEvents extends EventMap = EventMap,
  ServerEvents extends EventMap = EventMap,
  ClientStreams extends RealtimeStreamMap = RealtimeStreamMap,
  ServerStreams extends RealtimeStreamMap = RealtimeStreamMap,
  Error = never,
> {
  readonly isAckerDBRealtime: true;
  readonly kind: "realtime";
  readonly _argsType?: A;
  readonly _clientEventsType?: ClientEvents;
  readonly _serverEventsType?: ServerEvents;
  readonly _clientStreamsType?: ClientStreams;
  readonly _serverStreamsType?: ServerStreams;
  readonly _errorType?: Error;
}

/**
 * Marker for declarations that belong to the server module graph but are not
 * remotely callable AckerDB functions. Generated client APIs erase these keys.
 */
export interface RegisteredServerOnly {
  readonly isAckerDBServerOnly: true;
}

/**
 * Marker carried by a function declared `internal: true`: a registered
 * function with no client-facing address. `ApiFromModules` erases these keys;
 * `InternalFromModules` keeps exactly them.
 */
export interface RegisteredInternal {
  readonly internal: true;
}

type ResultData<Value> = Value extends OkResult<infer Data, infer _Error> ? Data : never;
type ResultError<Value> = Value extends ErrResult<infer Error, infer _Data> ? Error : never;

type FunctionRefOf<F> = F extends RegisteredFunction<infer Kd, infer A, infer R>
  ? Kd extends "query" | "mutation" | "procedure"
    ? FunctionReference<Kd, A, ResultData<R>, ResultError<R>>
    : FunctionReference<Kd, A, R>
  : never;

/**
 * Maps a record of module namespaces (arbitrarily nested) to the typed `api`
 * shape. Function files should export only ackerdb functions (same convention as
 * Convex); other exports produce unusable branches, not errors.
 */
export type ApiFromModules<T> = {
  [K in keyof T as T[K] extends RegisteredServerOnly | RegisteredInternal ? never : K]:
  T[K] extends RegisteredChannelContract<
    infer A,
    infer Room,
    infer ClientEvents,
    infer ServerEvents,
    infer Error
  >
    ? ChannelRef<A, Room, ClientEvents, ServerEvents, Error>
    : T[K] extends RegisteredRealtimeContract<
      infer A,
      infer ClientEvents,
      infer ServerEvents,
      infer ClientStreams,
      infer ServerStreams,
      infer Error
    >
    ? RealtimeRef<
      A,
      ClientEvents,
      ServerEvents,
      ClientStreams,
      ServerStreams,
      Error
    >
    : T[K] extends RegisteredFunction<infer Kd, infer A, infer R>
    ? Kd extends "query" | "mutation" | "procedure"
      ? FunctionReference<Kd, A, ResultData<R>, ResultError<R>>
      : FunctionReference<Kd, A, R>
    : ApiFromModules<T[K]>;
};

/**
 * The complement of `ApiFromModules`'s internal erasure: only functions
 * declared `internal: true`, as the same typed references. Consumed by
 * server-side callers — steps, composition — through the generated
 * `internal.*` tree; never by clients.
 */
export type InternalFromModules<T> = {
  [K in keyof T as T[K] extends RegisteredInternal
    ? K
    : T[K] extends
        | RegisteredServerOnly
        | RegisteredFunction
        | RegisteredChannelContract
        | RegisteredRealtimeContract
      ? never
      : K]: T[K] extends RegisteredInternal
    ? FunctionRefOf<T[K]>
    : InternalFromModules<T[K]>;
};
