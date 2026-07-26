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

/** Accepts a reference object or a raw address string; returns the address. */
export function getRef(
  ref: FunctionReference<FunctionKind, unknown, unknown, unknown> | string,
): string {
  if (typeof ref === "string") return ref;
  const address = ref.$ref;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("not a ackerdb function reference");
  }
  return address;
}

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
 * Marker for declarations that belong to the server module graph but are not
 * remotely callable AckerDB functions. Generated client APIs erase these keys.
 */
export interface RegisteredServerOnly {
  readonly isAckerDBServerOnly: true;
}

type ResultData<Value> = Value extends OkResult<infer Data, infer _Error> ? Data : never;
type ResultError<Value> = Value extends ErrResult<infer Error, infer _Data> ? Error : never;

/**
 * Maps a record of module namespaces (arbitrarily nested) to the typed `api`
 * shape. Function files should export only ackerdb functions (same convention as
 * Convex); other exports produce unusable branches, not errors.
 */
export type ApiFromModules<T> = {
  [K in keyof T as T[K] extends RegisteredServerOnly ? never : K]:
  T[K] extends RegisteredFunction<infer Kd, infer A, infer R>
    ? Kd extends "query" | "mutation" | "procedure"
      ? FunctionReference<Kd, A, ResultData<R>, ResultError<R>>
      : FunctionReference<Kd, A, R>
    : ApiFromModules<T[K]>;
};
