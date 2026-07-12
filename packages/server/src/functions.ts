/**
 * Function constructors: `query`, `mutation`, `procedure`, `sseProcedure`.
 *
 * The runtime versions here are schema-agnostic; the generated `server.ts`
 * casts them to schema-bound builder types (QueryBuilder<Schema> etc.) so
 * handlers get fully-typed `ctx` and validated `args` without annotations.
 */
import type { FunctionReference, MutationRef, QueryRef } from "@dbzz/core";
import type { Expand, Identity, InferShape, ObjectShape } from "./dbz.ts";
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

export interface TxCtx<S extends Schema = Schema> {
  db: DbWriter<S>;
}

export interface ProcedureCtx<S extends Schema = Schema> {
  auth: AuthCtx;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<T>(fn: (tx: TxCtx<S>) => T | Promise<T>): Promise<T>;
  runQuery<A, R>(ref: QueryRef<A, R>, args: A): Promise<R>;
  runMutation<A, R>(ref: MutationRef<A, R>, args: A): Promise<R>;
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
    return {
      isDbzz: true,
      kind,
      args: def.args,
      handler: def.handler as (ctx: never, args: never) => unknown,
    };
  };
}

export const query = register("query");
export const mutation = register("mutation");
export const procedure = register("procedure");
export const sseProcedure = register("sse");

// Schema-bound builder types for the generated server.ts.
export type QueryBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  args: A;
  handler: (ctx: QueryCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredQuery<A, Awaited<R>>;

export type MutationBuilder<S extends Schema> = <A extends ObjectShape, R>(def: {
  args: A;
  handler: (ctx: MutationCtx<S>, args: Expand<InferShape<A>>) => R;
}) => RegisteredMutation<A, Awaited<R>>;

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
    typeof value === "object" &&
    value !== null &&
    (value as { isDbzz?: unknown }).isDbzz === true &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** Event references get their own kind so clients can't call them. */
export type AnyFunctionReference = FunctionReference;
