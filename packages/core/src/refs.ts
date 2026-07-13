/**
 * Function references: the typed, opaque addresses clients use to name server
 * functions. At runtime a reference is just a dot-joined address string
 * ("messages.list"); the generic parameters carry kind/args/return types so
 * every call is end-to-end typed through codegen.
 */

export type FunctionKind = "query" | "mutation" | "procedure" | "sse" | "event";

export interface FunctionReference<
  K extends FunctionKind = FunctionKind,
  A = unknown,
  R = unknown,
> {
  readonly $ref: string;
  readonly _kind?: K;
  readonly _args?: A;
  readonly _ret?: R;
}

export type QueryRef<A = unknown, R = unknown> = FunctionReference<"query", A, R>;
export type MutationRef<A = unknown, R = unknown> = FunctionReference<"mutation", A, R>;
export type ProcedureRef<A = unknown, R = unknown> = FunctionReference<"procedure", A, R>;
export type SseRef<A = unknown, R = unknown> = FunctionReference<"sse", A, R>;
export type EventRef<A = unknown, Row = unknown> = FunctionReference<"event", A, Row>;

/** Accepts a reference object or a raw address string; returns the address. */
export function getRef(ref: FunctionReference | string): string {
  if (typeof ref === "string") return ref;
  const address = ref.$ref;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("not a dbzz function reference");
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
  readonly isDbzz: true;
  readonly kind: K;
  readonly _argsType?: A;
  readonly _retType?: R;
}

/**
 * Maps a record of module namespaces (arbitrarily nested) to the typed `api`
 * shape. Function files should export only dbzz functions (same convention as
 * Convex); other exports produce unusable branches, not errors.
 */
export type ApiFromModules<T> = {
  [K in keyof T]: T[K] extends RegisteredFunction<infer Kd, infer A, infer R>
    ? FunctionReference<Kd, A, R>
    : ApiFromModules<T[K]>;
};
