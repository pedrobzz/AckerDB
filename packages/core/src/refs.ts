/**
 * Function references: the typed, opaque addresses clients use to name server
 * functions. At runtime a reference is just a dot-joined address string
 * ("api.messages.list"); the generic parameters carry kind/args/data/error
 * types so every call is end-to-end typed through codegen.
 *
 * **An application address begins with `api`.**
 * `api.<...module segments>.<export name>` is the whole rule wherever an
 * address appears — the socket, the registry's keys, jobs, channels, and the
 * framework-owned SSE protocol. Public HTTP paths are declared independently
 * by each function factory.
 */

import type { ErrResult, OkResult } from "./result.ts";

export type FunctionKind = "query" | "mutation" | "procedure" | "sse" | "event";

/**
 * The fixed root of every application address. It lives here because generated
 * references, registry addresses, event references, and channels must agree
 * on it exactly.
 */
export const APPLICATION_ADDRESS_ROOT = "api";

/**
 * The namespace the generated api module gives event-table references. It is
 * reserved in three places that must agree — a function module may not be
 * called it, and code generation writes the export that causes both — so the
 * name lives here, with the tree it belongs to.
 */
export const EVENTS_NAMESPACE = "events";

/**
 * The address prefix every event-table reference carries. Event tables are not
 * modules, but they are leaves of the application tree, so they are addressed
 * like everything else in it. The subscription path that parses a
 * table out of an address and the generated module that writes one must agree
 * on this exactly, so it is spelled once.
 */
export const EVENTS_ADDRESS_PREFIX = `${APPLICATION_ADDRESS_ROOT}.${EVENTS_NAMESPACE}.`;

/**
 * The character marking a name as the framework's own, across the two
 * application-address and HTTP namespaces. An application may never claim a
 * marked name at either reserved boundary, so the framework's own protocol
 * surface can never be squatted. Scopes are not one of those namespaces: the
 * whole vocabulary belongs to the application, so `_` is an ordinary
 * character inside a scope name.
 *
 * It lives here for the same reason the name above does — the rule is enforced
 * in the server's routing and in the declaration builders that refuse it, and
 * those must agree on one character. The one exception is framework tables,
 * which carry the older `_ackerdb_` prefix released in 0.16.0 data; see
 * CONTEXT.md.
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

/** One named event in a typed channel's event map. */
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

/** Accepts a reference object or a raw address string; returns the address. */
export function getRef(
  ref:
    | FunctionReference<FunctionKind, unknown, unknown, unknown>
    | AnyChannelRef
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
 * Untyped application reference builder. Generated `api.ts` casts it to the
 * application's typed tree.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const anyApi: any = makeRefProxy(APPLICATION_ADDRESS_ROOT);

/**
 * The type-only contract every registered server function satisfies. It lives
 * in core so generated `api.ts` can derive reference types from type-only
 * imports of the user's function modules without touching server code.
 */
export interface RegisteredFunction<K extends FunctionKind = FunctionKind, A = unknown, R = unknown> {
  readonly kind: K;
  readonly _argsType?: A;
  readonly _retType?: R;
}

/**
 * Type-only contract implemented by the server package's `channel()` return.
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
  readonly kind: "channel";
  readonly _argsType?: A;
  readonly _roomType?: Room;
  readonly _clientEventsType?: ClientEvents;
  readonly _serverEventsType?: ServerEvents;
  readonly _errorType?: Error;
}

type ResultData<Value> = Value extends OkResult<infer Data, infer _Error> ? Data : never;
type ResultError<Value> = Value extends ErrResult<infer Error, infer _Data> ? Error : never;

type FunctionRefOf<F> = F extends RegisteredFunction<infer Kd, infer A, infer R>
  ? Kd extends "query" | "mutation" | "procedure"
    ? FunctionReference<Kd, A, ResultData<R>, ResultError<R>>
    : FunctionReference<Kd, A, R>
  : never;

/**
 * Maps a record of module namespaces (arbitrarily nested) to the application's
 * typed API shape. Server-only definitions and ordinary helper exports are erased.
 */
type ApiValue<T> = T extends RegisteredChannelContract<
    infer A,
    infer Room,
    infer ClientEvents,
    infer ServerEvents,
    infer Error
  >
    ? ChannelRef<A, Room, ClientEvents, ServerEvents, Error>
    : T extends RegisteredFunction
    ? FunctionRefOf<T>
    : T extends { readonly kind: "http" | "job" }
      ? never
      : T extends object
        ? keyof ApiModule<T> extends never ? never : ApiModule<T>
        : never;

type ApiModule<T> = {
  [K in keyof T as ApiValue<T[K]> extends never ? never : K]: ApiValue<T[K]>;
};

export type ApiFromModules<T> = ApiModule<T>;
