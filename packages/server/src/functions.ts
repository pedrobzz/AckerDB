/**
 * Function constructors: `query`, `mutation`, `procedure`, `sseProcedure`.
 *
 * The runtime versions here are schema-agnostic; generated server modules cast
 * them to schema-bound builders. Queries and mutations remain directly
 * callable for server-side composition, but every call enters `invokeFunction`
 * so nested calls cannot skip argument validation or the callee's policy.
 */
import type { Principal } from "./auth.ts";
import {
  type Expand,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type Validator,
} from "./dbz.ts";
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

/**
 * What an SSE handler returns: the chunks the client receives, either as a
 * ReadableStream (e.g. an AI SDK UI message stream) or any async iterable
 * (`async function*` handlers). Every chunk is validated against the
 * declaration's `yields` validator before it is encoded onto the wire, and
 * the source is advanced one chunk at a time as the receiver acknowledges.
 */
export type SseSource<Chunk> = ReadableStream<Chunk> | AsyncIterable<Chunk>;

export type SseCtx<S extends Schema = Schema> = ProcedureCtx<S>;

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

/**
 * `R` is the phantom clients consume through generated references; `H` is
 * what the handler actually produces. They coincide everywhere except SSE,
 * where the reference carries the validated chunk type while the handler
 * returns a chunk source.
 */
export interface Registered<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H = R,
> {
  readonly isDbzz: true;
  readonly kind: K;
  readonly args: A;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly handler: (ctx: Ctx, args: Expand<InferShape<A>>) => H | Promise<H>;
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
export interface RegisteredSse<A extends ObjectShape, Chunk, S extends Schema = Schema>
  extends Registered<"sse", A, SseCtx<S>, Chunk, SseSource<Chunk>> {
  /** Validates every yielded chunk at the server boundary. */
  readonly yields: Validator<Chunk, string>;
}

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

function isValidator(value: unknown): value is Validator<unknown, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Validator).kind === "string" &&
    typeof (value as Validator).check === "function" &&
    typeof (value as Validator).tsType === "function"
  );
}

export function validateYields(yields: unknown): asserts yields is Validator<unknown, string> {
  if (!isValidator(yields)) {
    throw new TypeError("sse yields must be a dbz validator for the chunks the stream emits");
  }
  if (yields.kind === "pk" || yields.kind === "scheduleAt" || yields.kind === "tag") {
    throw new Error(`yields: dbz.${yields.kind}() is not a valid chunk validator`);
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

interface SseDef<
  A extends ObjectShape,
  Y extends Validator<unknown, string>,
  Ctx extends InvocationContext,
> {
  readonly args: A;
  readonly yields: Y;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly handler: (
    ctx: Ctx,
    args: Expand<InferShape<A>>,
  ) => SseSource<InferValidator<Y>> | Promise<SseSource<InferValidator<Y>>>;
}

/**
 * SSE declarations require a `yields` chunk validator; the handler returns a
 * `SseSource` of exactly those chunks. The registered phantom return type is
 * the chunk type, so generated references read `SseRef<Args, Chunk>`.
 */
export function sseProcedure<
  A extends ObjectShape,
  Y extends Validator<unknown, string>,
  Ctx extends InvocationContext,
>(def: SseDef<A, Y, Ctx>): RegisteredSse<A, Expand<InferValidator<Y>>, Schema> {
  if (!isAccessPolicy(def.access)) {
    throw new TypeError("sse access must be public, authenticated, system, or a policy callback");
  }
  validateArgsShape(def.args);
  validateYields(def.yields);

  const callable = () => {
    throw new Error("sses cannot be called in-process — they exist at the transport boundary");
  };
  return Object.assign(callable, {
    isDbzz: true as const,
    kind: "sse" as const,
    args: def.args,
    yields: def.yields,
    access: def.access,
    handler: def.handler,
  }) as unknown as RegisteredSse<A, Expand<InferValidator<Y>>, Schema>;
}

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

export type SseBuilder<S extends Schema> = <A extends ObjectShape, Y extends Validator<unknown, string>>(def: {
  readonly args: A;
  readonly yields: Y;
  readonly access: AccessPolicy<SseCtx<S>, Expand<InferShape<A>>>;
  readonly handler: (
    ctx: SseCtx<S>,
    args: Expand<InferShape<A>>,
  ) => SseSource<InferValidator<Y>> | Promise<SseSource<InferValidator<Y>>>;
}) => RegisteredSse<A, Expand<InferValidator<Y>>, S>;

// Runtime registries deliberately erase each function's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegistered = Registered<string, ObjectShape, any, any, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegisteredSse = RegisteredSse<ObjectShape, any, any>;

export function isRegisteredFunction(value: unknown): value is AnyRegistered {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as { isDbzz?: unknown }).isDbzz === true &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    isAccessPolicy((value as { access?: unknown }).access)
  );
}
