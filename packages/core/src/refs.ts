/**
 * Function references: the typed, opaque addresses clients use to name server
 * functions. At runtime a reference is just a dot-joined address string
 * ("api.messages.list"); the generic parameters carry kind/args/data/error
 * types so every call is end-to-end typed through codegen.
 *
 * **An address begins with its group.** `<apiPath>.<...module segments>.<export
 * name>` is the whole rule, and it holds everywhere an address appears — the
 * socket, the registry's keys, the URL. A group is therefore a namespace and
 * not a label: `api.messages.list` and `internal.messages.list` are two
 * functions, and one group's names can never be squatted from another.
 */

import type { ErrResult, OkResult } from "./result.ts";

export type FunctionKind = "query" | "mutation" | "procedure" | "sse" | "event";

/**
 * The API path every function without an explicit one is published in, and so
 * the first segment of its address. It is an ordinary group, not a privileged
 * category: the framework names this one so a declaration need not. It lives
 * here because the generated trees below and the server's declaration builders
 * must agree on it exactly.
 */
export const DEFAULT_API_PATH = "api";
export type DefaultApiPath = typeof DEFAULT_API_PATH;

/**
 * The group the framework publishes its own administration functions in, and
 * so the first segment of every Admin API address. It is an ordinary group
 * carrying no reserved marker — the marker belongs to roots and scopes, and a
 * group's name becomes a generated binding, which the marker is reserved
 * against. What keeps the surface unsquattable is the address rule itself: an
 * application's `orders.list` is `api.orders.list`, never `admin.orders.list`, so
 * the two can never name one function. An application may still publish its
 * own functions here, which is why the group is shared rather than sealed.
 *
 * Like {@link DEFAULT_API_PATH} it lives here because the generated trees, the
 * server's registry, and the declaration builders must agree on it exactly.
 */
export const ADMIN_API_PATH = "admin";
export type AdminApiPath = typeof ADMIN_API_PATH;

/**
 * The namespace the generated api module gives event-table references. It is
 * reserved in three places that must agree — a function module may not be
 * called it, an API path may not be named it, and code generation writes the
 * export that causes both — so the name lives here, with the tree it belongs
 * to.
 */
export const EVENTS_NAMESPACE = "events";

/**
 * The address prefix every event-table reference carries. Event tables are not
 * modules, but they are leaves of the default group's tree, so they are
 * addressed like everything else in it. The subscription path that parses a
 * table out of an address and the generated module that writes one must agree
 * on this exactly, so it is spelled once.
 */
export const EVENTS_ADDRESS_PREFIX = `${DEFAULT_API_PATH}.${EVENTS_NAMESPACE}.`;

/**
 * The character marking a name as the framework's own, across every namespace
 * an application shares with it: API paths, HTTP roots, and scopes. An
 * application may never declare a name carrying it, so the two vocabularies
 * cannot collide.
 *
 * It lives here for the same reason the two names above do — the rule is
 * enforced in the server's routing, its authorization vocabulary, and the
 * declaration builders that refuse it, and those must agree on one character.
 * The one exception is framework tables, which carry the older `_ackerdb_`
 * prefix released in 0.16.0 data; see CONTEXT.md.
 */
export const RESERVED_MARKER = "_";

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

/**
 * The wire contract for an exposed function's URL: the address, segment for
 * segment. The group needs no separate argument because it is already the
 * first segment, so the listener claiming the path and the client building it
 * read one rule over one value and cannot drift.
 */
export function httpPathForAddress(address: string): string {
  return `/${address.replaceAll(".", "/")}`;
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

function makeRefProxy(address: string): unknown {
  return new Proxy(
    { $ref: address },
    {
      get(target, prop) {
        if (prop === "$ref") return address;
        if (typeof prop !== "string") return Reflect.get(target, prop);
        return makeRefProxy(`${address}.${prop}`);
      },
    },
  );
}

/**
 * Untyped reference builder for one group: `apiGroup("internal").messages.list`
 * yields the reference for address "internal.messages.list", resolving under
 * `/internal/messages/list`. The group is the address's first segment, so the
 * builder is seeded with it and every property access appends the next.
 * Generated `api.ts` casts each group's builder to that group's typed tree.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiGroup(apiPath: string): any {
  return makeRefProxy(apiPath);
}

/** The same builder for the default group: `anyApi.messages.list`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const anyApi: any = apiGroup(DEFAULT_API_PATH);

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
 * The API path a registered function was published in — the first segment of
 * its address — carried on its type so a generated tree can select one group.
 * Every registered function has one.
 */
export interface RegisteredApiPath<Path extends string> {
  readonly apiPath: Path;
}

type ResultData<Value> = Value extends OkResult<infer Data, infer _Error> ? Data : never;
type ResultError<Value> = Value extends ErrResult<infer Error, infer _Data> ? Error : never;

type FunctionRefOf<F> = F extends RegisteredFunction<infer Kd, infer A, infer R>
  ? Kd extends "query" | "mutation" | "procedure"
    ? FunctionReference<Kd, A, ResultData<R>, ResultError<R>>
    : FunctionReference<Kd, A, R>
  : never;

/** The one owner of group membership: whether an export appears in this tree. */
type InApiPath<Export, Path extends string> = Export extends RegisteredServerOnly
  ? // A server-only export has no reference in any group.
    false
  : Export extends RegisteredFunction
    ? // A function carries the group it was declared in.
      Export extends RegisteredApiPath<Path>
      ? true
      : false
    : Export extends RegisteredChannelContract | RegisteredRealtimeContract
      ? // Socket-addressed contracts refuse `apiPath`, so their addresses
        // begin with the default group and they live in that tree alone.
        [Path] extends [DefaultApiPath]
        ? true
        : false
      : // A namespace, kept in every group and filtered by its own recursion.
        // Testing it for emptiness here — so `internal.` listed only modules
        // that reach it — makes this type and `ApiFromModules` mutually
        // recursive, which TypeScript reports as an excessively deep
        // instantiation on real module trees. A group's binding therefore
        // shows every module namespace; only its leaves are selected.
        true;

/**
 * Maps a record of module namespaces (arbitrarily nested) to the typed shape of
 * one API path — `api` by default, and one tree per group the application
 * declares. Function files should export only ackerdb functions (same
 * convention as Convex); other exports produce unusable branches, not errors.
 */
export type ApiFromModules<T, Path extends string = DefaultApiPath> = {
  [K in keyof T as InApiPath<T[K], Path> extends true ? K : never]:
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
    : T[K] extends RegisteredFunction
    ? FunctionRefOf<T[K]>
    : ApiFromModules<T[K], Path>;
};
