/**
 * Function constructors: `query`, `mutation`, `procedure`, `sseProcedure`.
 *
 * The runtime versions here are schema-agnostic; generated server modules cast
 * them to schema-bound builders. Queries and mutations remain directly
 * callable for server-side composition, but every call enters `invokeFunction`
 * so nested calls cannot skip argument validation or the callee's policy.
 */
import type { Principal } from "./auth.ts";
import { type Expand, type InferShape, type ObjectShape } from "./dbz.ts";
import type { DbReader, DbWriter } from "./dbtypes.ts";
import { invokeFunction, type InvocationContext } from "./invocation.ts";
import type { InsertShape, Schema } from "./schema.ts";

export type AuthCtx = Principal;

export interface QueryCtx<S extends Schema = Schema> extends InvocationContext {
  readonly db: DbReader<S>;
  readonly auth: AuthCtx;
}

export interface MutationCtx<S extends Schema = Schema> extends InvocationContext {
  readonly db: DbWriter<S>;
  readonly auth: AuthCtx;
}

/** The context inside `ctx.tx(...)`: a mutation's powers, structurally. */
export interface TxCtx<S extends Schema = Schema> extends InvocationContext {
  readonly db: DbWriter<S>;
  readonly auth: AuthCtx;
}

export interface ProcedureCtx<S extends Schema = Schema> extends InvocationContext {
  readonly auth: AuthCtx;
  /** Fires when the request, credential lease, or Runtime shuts down. */
  readonly abortSignal: AbortSignal;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<T>(fn: (tx: TxCtx<S>) => T | Promise<T>): Promise<T>;
}

export interface StreamWriter {
  /** Write one chunk (one SSE `data:` line) by hand. */
  write(chunk: unknown): void;
  /** Pipe a ReadableStream of chunks (e.g. an AI SDK UI message stream). */
  merge(stream: ReadableStream<unknown>): void;
}

export interface SseCtx<S extends Schema = Schema> extends ProcedureCtx<S> {
  readonly stream: StreamWriter;
}

/** Args as the caller provides them: nullable validators become optional. */
export type ArgsInput<A extends ObjectShape> = InsertShape<A>;

export type BuiltinAccessPolicy = "public" | "authenticated" | "system";

/**
 * Every registered function has exactly one policy. A callback must explicitly
 * return `true`; false, exceptions, and every other result fail closed.
 */
export type AccessPolicy<Ctx, Args> =
  | BuiltinAccessPolicy
  | ((ctx: Ctx, args: Args) => boolean | Promise<boolean>);

interface FunctionDef<A extends ObjectShape, Ctx extends InvocationContext, R> {
  readonly args: A;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly handler: (ctx: Ctx, args: Expand<InferShape<A>>) => R;
}

export interface Registered<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
> {
  readonly isDbzz: true;
  readonly kind: K;
  readonly args: A;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly handler: (ctx: Ctx, args: Expand<InferShape<A>>) => R | Promise<R>;
  /** Phantoms consumed by ApiFromModules via type-only imports. */
  readonly _argsType?: ArgsInput<A>;
  readonly _retType?: R;
}

export type RegisteredQuery<A extends ObjectShape, R, S extends Schema = Schema> = Registered<
  "query",
  A,
  QueryCtx<S>,
  R
>;
export type RegisteredMutation<A extends ObjectShape, R, S extends Schema = Schema> = Registered<
  "mutation",
  A,
  MutationCtx<S>,
  R
>;
export type RegisteredProcedure<A extends ObjectShape, R, S extends Schema = Schema> = Registered<
  "procedure",
  A,
  ProcedureCtx<S>,
  R
>;
export type RegisteredSse<A extends ObjectShape, R, S extends Schema = Schema> = Registered<
  "sse",
  A,
  SseCtx<S>,
  R
>;

export function isAccessPolicy(value: unknown): value is AccessPolicy<InvocationContext, unknown> {
  return (
    value === "public" ||
    value === "authenticated" ||
    value === "system" ||
    typeof value === "function"
  );
}

export function validateArgsShape(args: ObjectShape, prefix = "args"): void {
  for (const [name, validator] of Object.entries(args)) {
    if (validator.kind === "pk" || validator.kind === "scheduleAt" || validator.kind === "tag") {
      throw new Error(`${prefix}.${name}: dbz.${validator.kind}() is not a valid argument validator`);
    }
  }
}

function register<K extends string>(kind: K) {
  return <A extends ObjectShape, Ctx extends InvocationContext, R>(
    def: FunctionDef<A, Ctx, R>,
  ): Registered<K, A, Ctx, Awaited<R>> => {
    if (!isAccessPolicy(def.access)) {
      throw new TypeError(`${kind} access must be public, authenticated, system, or a policy callback`);
    }
    validateArgsShape(def.args);

    const callable =
      kind === "query" || kind === "mutation"
        ? (ctx: Ctx, args: unknown) => invokeFunction(registered, ctx, args)
        : () => {
            throw new Error(`${kind}s cannot be called in-process — they exist at the transport boundary`);
          };
    const registered = Object.assign(callable, {
      isDbzz: true as const,
      kind,
      args: def.args,
      access: def.access,
      handler: def.handler,
    }) as unknown as Registered<K, A, Ctx, Awaited<R>>;
    return registered;
  };
}

/** Schema-agnostic constructors; queries and mutations are directly callable. */
function registerCallable<K extends string>(kind: K) {
  return register(kind) as <A extends ObjectShape, Ctx extends InvocationContext, R>(
    def: FunctionDef<A, Ctx, R>,
  ) => Registered<K, A, Ctx, Awaited<R>> &
    ((ctx: Ctx, args: Expand<ArgsInput<A>>) => Promise<Awaited<R>>);
}

export const query = registerCallable("query");
export const mutation = registerCallable("mutation");
export const procedure = register("procedure");
export const sseProcedure = register("sse");

export type QueryBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  readonly args: A;
  readonly access: AccessPolicy<QueryCtx<S>, Expand<InferShape<A>>>;
  readonly handler: (ctx: QueryCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredQuery<A, Awaited<R>, S> &
  ((ctx: QueryCtx<S>, args: Expand<ArgsInput<A>>) => Promise<Awaited<R>>);

export type MutationBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  readonly args: A;
  readonly access: AccessPolicy<MutationCtx<S>, Expand<InferShape<A>>>;
  readonly handler: (ctx: MutationCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredMutation<A, Awaited<R>, S> &
  ((ctx: MutationCtx<S>, args: Expand<ArgsInput<A>>) => Promise<Awaited<R>>);

export type ProcedureBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  readonly args: A;
  readonly access: AccessPolicy<ProcedureCtx<S>, Expand<InferShape<A>>>;
  readonly handler: (ctx: ProcedureCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredProcedure<A, Awaited<R>, S>;

export type SseBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  readonly args: A;
  readonly access: AccessPolicy<SseCtx<S>, Expand<InferShape<A>>>;
  readonly handler: (ctx: SseCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredSse<A, Awaited<R>, S>;

// Runtime registries deliberately erase each function's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegistered = Registered<string, ObjectShape, any, any>;

export function isRegisteredFunction(value: unknown): value is AnyRegistered {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as { isDbzz?: unknown }).isDbzz === true &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    isAccessPolicy((value as { access?: unknown }).access)
  );
}
