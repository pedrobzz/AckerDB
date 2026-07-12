/**
 * Function constructors: `query`, `mutation`, `procedure`, `sseProcedure`.
 *
 * The runtime versions here are schema-agnostic; the generated `server.ts`
 * casts them to schema-bound builder types (QueryBuilder<Schema> etc.) so
 * handlers get fully-typed `ctx` and validated `args` without annotations.
 *
 * Server-side composition is direct function calls — `getByEmail(ctx, args)`
 * — never references: queries and mutations are callable with a compatible
 * context. The context lattice enforces the calling rules structurally:
 *
 *   - MutationCtx ⊇ QueryCtx (read/write ⊇ read-only), so a mutation can
 *     call a query with its own ctx and the callee joins its transaction.
 *   - A query cannot call a mutation: its ctx has no write methods, so it
 *     doesn't satisfy MutationCtx (and its runtime db has no writes either).
 *   - Procedures open transactions and pass the tx ctx into callees; several
 *     calls inside one `ctx.tx` commit atomically together.
 *   - Procedures are not callable in-process — their context (external
 *     calls, streams) only exists at the transport boundary.
 *
 * Direct calls run the same args validation as the wire, so a function
 * behaves identically no matter how it is invoked.
 */
import { checkShape, type Expand, type Identity, type InferShape, type ObjectShape } from "./dbz.ts";
import type { DbReader, DbWriter } from "./dbtypes.ts";
import type { InsertShape, Schema } from "./schema.ts";

/** v1 auth is stubbed anonymous; the shape matches the full design. */
export interface AuthCtx {
  userId: Identity | null;
  sessionId: bigint | null;
  identity: { issuer: string; subject: string; claims: Record<string, unknown> } | null;
}

export interface QueryCtx<S extends Schema = Schema> {
  db: DbReader<S>;
  auth: AuthCtx;
}

export interface MutationCtx<S extends Schema = Schema> {
  db: DbWriter<S>;
  auth: AuthCtx;
}

/** The context inside `ctx.tx(...)`: a mutation's powers, structurally. */
export interface TxCtx<S extends Schema = Schema> {
  db: DbWriter<S>;
  auth: AuthCtx;
}

export interface ProcedureCtx<S extends Schema = Schema> {
  auth: AuthCtx;
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
  stream: StreamWriter;
  /** Fires when the client stops or disconnects; pass it to upstream calls. */
  abortSignal: AbortSignal;
}

/** Args as the *caller* provides them: nullable validators become optional. */
export type ArgsInput<A extends ObjectShape> = InsertShape<A>;

interface FunctionDef<A extends ObjectShape, Ctx, R> {
  args: A;
  handler: (ctx: Ctx, args: InferShape<A>) => R;
}

export interface Registered<K extends string, A extends ObjectShape, R> {
  readonly isDbzz: true;
  readonly kind: K;
  readonly args: A;
  readonly handler: (ctx: never, args: never) => unknown;
  /** Phantoms consumed by ApiFromModules via type-only imports. */
  readonly _argsType?: ArgsInput<A>;
  readonly _retType?: R;
}

export type RegisteredQuery<A extends ObjectShape, R> = Registered<"query", A, R>;
export type RegisteredMutation<A extends ObjectShape, R> = Registered<"mutation", A, R>;
export type RegisteredProcedure<A extends ObjectShape, R> = Registered<"procedure", A, R>;
export type RegisteredSse<A extends ObjectShape, R> = Registered<"sse", A, R>;

function register<K extends string>(kind: K) {
  return <A extends ObjectShape, Ctx, R>(def: FunctionDef<A, Ctx, R>): Registered<K, A, Awaited<R>> => {
    for (const [name, validator] of Object.entries(def.args)) {
      if (validator.kind === "pk" || validator.kind === "scheduleAt" || validator.kind === "tag") {
        throw new Error(`args.${name}: dbz.${validator.kind}() is not a valid argument validator`);
      }
    }
    const callable =
      kind === "query" || kind === "mutation"
        ? async (ctx: Ctx, args: unknown) =>
            def.handler(ctx, checkShape(def.args, args ?? {}, "args") as InferShape<A>)
        : () => {
            throw new Error(`${kind}s cannot be called in-process — they exist at the transport boundary`);
          };
    return Object.assign(callable, {
      isDbzz: true as const,
      kind,
      args: def.args,
      handler: def.handler as (ctx: never, args: never) => unknown,
    }) as unknown as Registered<K, A, Awaited<R>>;
  };
}

/** Schema-agnostic constructors; queries and mutations are callable. */
function registerCallable<K extends string>(kind: K) {
  return register(kind) as <A extends ObjectShape, Ctx, R>(
    def: FunctionDef<A, Ctx, R>,
  ) => Registered<K, A, Awaited<R>> & ((ctx: Ctx, args: Expand<ArgsInput<A>>) => Promise<Awaited<R>>);
}

export const query = registerCallable("query");
export const mutation = registerCallable("mutation");
export const procedure = register("procedure");
export const sseProcedure = register("sse");

// Schema-bound builder types for the generated server.ts. Queries and
// mutations are directly callable with a compatible context; the ctx
// parameter type is what encodes the calling rules (see module docs).
export type QueryBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  args: A;
  handler: (ctx: QueryCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredQuery<A, Awaited<R>> &
  ((ctx: QueryCtx<S>, args: Expand<ArgsInput<A>>) => Promise<Awaited<R>>);

export type MutationBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  args: A;
  handler: (ctx: MutationCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredMutation<A, Awaited<R>> &
  ((ctx: MutationCtx<S>, args: Expand<ArgsInput<A>>) => Promise<Awaited<R>>);

export type ProcedureBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  args: A;
  handler: (ctx: ProcedureCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredProcedure<A, Awaited<R>>;

export type SseBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  args: A;
  handler: (ctx: SseCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredSse<A, Awaited<R>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegistered = Registered<string, ObjectShape, any>;

export function isRegisteredFunction(value: unknown): value is AnyRegistered {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as { isDbzz?: unknown }).isDbzz === true &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}
