/**
 * Function constructors: `query`, `mutation`, `procedure`, `sseProcedure`.
 *
 * The runtime versions here are schema-agnostic; generated server modules cast
 * them to schema-bound builders. Queries and mutations remain directly
 * callable for server-side composition, but every call enters `invokeFunction`
 * so nested calls cannot skip argument validation or the callee's policy.
 */
import type { ExternalAccount, Principal } from "../auth/credentials.ts";
import {
  Status,
  type ApplicationError,
  type ErrorHttpStatus,
  type ErrResult,
  type OkResult,
  type Result,
} from "@ackerdb/core";
import {
  type Expand,
  type InferInputShape,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type Validator,
} from "../validation/v.ts";
import type { DbReader, DbWriter } from "../database/query/types.ts";
import {
  compileInvocation,
  invokeFunction,
} from "./invocation.ts";
import {
  isAccessPolicy,
  type AccessPolicy,
  type InvocationContext,
} from "./access.ts";
import type { Schema } from "../schema/definition.ts";
import { validateArgsShape } from "../validation/declarations.ts";
import type {
  AnalyticsTracker,
  ApplicationLogger,
} from "../telemetry/application-signals/types.ts";

export type AuthCtx = Principal;

type EmptyContextCapabilities = Readonly<Record<never, never>>;

export type QueryCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
> = InvocationContext & Capabilities & {
  readonly db: DbReader<S>;
  readonly auth: AuthCtx;
  readonly log: ApplicationLogger;
  readonly timestamp: number;
};

export type MutationCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
> = InvocationContext & Capabilities & {
  readonly db: DbWriter<S>;
  readonly auth: AuthCtx;
  readonly analytics: AnalyticsTracker;
  readonly log: ApplicationLogger;
  readonly timestamp: number;
};

/** The context inside `ctx.tx(...)`: a mutation's powers, structurally. */
export type TxCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
> = MutationCtx<S, Capabilities>;

export type ProcedureCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = InvocationContext & Capabilities & {
  readonly auth: AuthCtx;
  readonly log: ApplicationLogger;
  readonly timestamp: number;
  /** Fires when the request, credential lease, or Runtime shuts down. */
  readonly abortSignal: AbortSignal;
  /** Prove and attach another user account using its raw bearer token, not an Authorization header. */
  linkAccount(rawBearerToken: string): Promise<void>;
  /** Remove one exact owned account while retaining the durable application Identity. */
  unlinkAccount(account: ExternalAccount): Promise<void>;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<R>(
    fn: (tx: TxCtx<S, TransactionCapabilities>) => R,
  ): Promise<FunctionResult<R>>;
};

export interface OwnedProcedureContext {
  readonly value: ProcedureCtx;
  release(): void;
}

/**
 * What an SSE handler returns: the chunks the client receives, either as a
 * ReadableStream (e.g. an AI SDK UI message stream) or any async iterable
 * (`async function*` handlers). Every chunk is validated against the
 * declaration's `yields` validator before it is encoded onto the wire, and
 * the source is advanced one chunk at a time as the receiver acknowledges.
 */
export type SseSource<Chunk> = ReadableStream<Chunk> | AsyncIterable<Chunk>;

export type SseCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = ProcedureCtx<S, Capabilities, TransactionCapabilities>;

/** Args as the caller provides them: only optional/nullish keys may be omitted. */
export type ArgsInput<A extends ObjectShape> = InferInputShape<A>;

/**
 * Per-function opt-in to the plain-HTTP surface. Absent or `false` means the
 * function is not reachable over HTTP and absent from OpenAPI; `true` is
 * shorthand for `{ openapi: true }`. `openapi` exists only inside an exposed
 * function's config, so "documented but not callable" is unrepresentable.
 */
export type HttpExposure = boolean | { readonly openapi: boolean };

/**
 * The one interpreter of `http`: `null` when the function is not exposed,
 * otherwise its OpenAPI visibility. Untyped callers reach the same validation,
 * so a malformed field is always a registration error.
 */
export function httpExposure(
  value: unknown,
  where = "http",
): { readonly openapi: boolean } | null {
  if (value === undefined || value === false) return null;
  if (value === true) return { openapi: true };
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 1 ||
    typeof (value as { openapi?: unknown }).openapi !== "boolean"
  ) {
    throw new TypeError(`${where} must be true, false, or { openapi: boolean }`);
  }
  return { openapi: (value as { openapi: boolean }).openapi };
}

export interface ErrorDeclaration {
  readonly body: Validator<unknown, string>;
  readonly status: ErrorHttpStatus;
}

export type ErrorDeclarations = Readonly<Record<string, ErrorDeclaration>>;

type DeclaredErrors<Declarations extends ErrorDeclarations> = {
  readonly [Code in Extract<keyof Declarations, string>]: ApplicationError<
    Code,
    Expand<InferValidator<Declarations[Code]["body"]>>,
    Declarations[Code]["status"]
  >;
}[Extract<keyof Declarations, string>];

type ReturnedErrorCodes<HandlerReturn> =
  ErrorOfReturn<HandlerReturn> extends infer Error
    ? Error extends { readonly code: infer Code extends string }
      ? Code
      : never
    : never;

type ReturnedErrorBody<HandlerReturn, Code extends string> =
  Extract<
    ErrorOfReturn<HandlerReturn>,
    { readonly code: Code }
  > extends { readonly body: infer Body }
    ? Expand<Body>
    : never;

type ReturnedErrorStatus<HandlerReturn, Code extends string> =
  Extract<
    ErrorOfReturn<HandlerReturn>,
    { readonly code: Code }
  > extends { readonly status: infer HttpStatus extends ErrorHttpStatus }
    ? HttpStatus
    : never;

type ReturnedErrorDeclarations<HandlerReturn> = {
  readonly [Code in ReturnedErrorCodes<HandlerReturn>]: {
    readonly body: Validator<ReturnedErrorBody<HandlerReturn, Code>, string>;
    readonly status: ReturnedErrorStatus<HandlerReturn, Code>;
  };
};

type ExactReturnedErrorDeclarations<
  HandlerReturn,
  Declarations extends ErrorDeclarations,
> = ReturnedErrorDeclarations<HandlerReturn> & {
  readonly [Code in Exclude<
    Extract<keyof Declarations, string>,
    ReturnedErrorCodes<HandlerReturn>
  >]: never;
};

type ReturnDeclarationConstraint<
  HandlerReturn,
  Returns extends Validator<unknown, string> | undefined,
> = Returns extends Validator<unknown, string>
    ? [SuccessOf<Awaited<HandlerReturn>>] extends [
      Expand<InferValidator<Returns>>,
    ]
    ? unknown
    : {
        readonly returns: Validator<
          SuccessOf<Awaited<HandlerReturn>>,
          string
        >;
      }
  : unknown;

type ErrorDeclarationConstraint<
  HandlerReturn,
  Declarations extends ErrorDeclarations | undefined,
> = unknown extends ErrorOfReturn<HandlerReturn>
  ? unknown
  : [ErrorOfReturn<HandlerReturn>] extends [ApplicationError]
    ? Declarations extends ErrorDeclarations
      ? {
          readonly errors: ExactReturnedErrorDeclarations<
            HandlerReturn,
            Declarations
          >;
        }
      : unknown
    : {
        readonly handler: {
          readonly "AckerDB: registered handlers may only return application Err(...) results": Exclude<
            ErrorOfReturn<HandlerReturn>,
            ApplicationError
          >;
        };
      };

type DefinitionConstraint<Definition extends { readonly handler: Function }> =
  ReturnDeclarationConstraint<
    DefinitionReturn<Definition>,
    DefinitionReturns<Definition>
  > &
    ErrorDeclarationConstraint<
      DefinitionReturn<Definition>,
      DefinitionErrors<Definition>
    >;

type FunctionHandler<
  A extends ObjectShape,
  Ctx extends InvocationContext,
> = (
  ctx: Ctx,
  args: Expand<InferShape<A>>,
) => unknown;

/** Surface metadata every kind shares: HTTP exposure and its documentation. */
interface ExposureDef {
  readonly http?: HttpExposure;
  readonly description?: string;
  readonly title?: string;
}

type FunctionDef<
  A extends ObjectShape,
  Ctx extends InvocationContext,
> = ExposureDef & {
  readonly args: A;
  readonly returns?: Validator<unknown, string>;
  readonly errors?: ErrorDeclarations;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly handler: FunctionHandler<A, Ctx>;
};

type DefinitionReturn<Definition extends { readonly handler: Function }> =
  Definition["handler"] extends (...args: never[]) => infer HandlerReturn
    ? HandlerReturn
    : never;

type DefinitionReturns<Definition> = Definition extends {
  readonly returns: infer Returns extends Validator<unknown, string>;
}
  ? Returns
  : undefined;

type DefinitionErrors<Definition> = Definition extends {
  readonly errors: infer Declarations extends ErrorDeclarations;
}
  ? Declarations
  : undefined;

type ResultOfDefinition<Definition extends { readonly handler: Function }> =
  DeclaredFunctionResult<
    DefinitionReturn<Definition>,
    DefinitionReturns<Definition>,
    DefinitionErrors<Definition>
  >;

type SuccessOf<Value> = Value extends ErrResult<unknown, infer _Data>
  ? never
  : Value extends OkResult<infer Data, infer _Error>
    ? Data
    : Value;

type ErrorOf<Value> = Value extends ErrResult<infer Error, infer _Data> ? Error : never;

type ErrorOfReturn<Value> = Value extends PromiseLike<infer AwaitedValue>
  ? ErrorOfReturn<AwaitedValue>
  : ErrorOf<Value>;

/** The registered-call Result produced from a handler's raw/Ok/Err union. */
export type FunctionResult<HandlerReturn> = Result<
  SuccessOf<Awaited<HandlerReturn>>,
  ErrorOf<Awaited<HandlerReturn>>
>;

type DeclaredFunctionResult<
  HandlerReturn,
  Returns extends Validator<unknown, string> | undefined,
  Declarations extends ErrorDeclarations | undefined,
> = Result<
  Returns extends Validator<unknown, string>
    ? Expand<InferValidator<Returns>>
    : SuccessOf<Awaited<HandlerReturn>>,
  Declarations extends ErrorDeclarations
    ? DeclaredErrors<Declarations>
    : ErrorOf<Awaited<HandlerReturn>>
>;

/** Marker-neutral execution contract shared by functions and server-only tools. */
export interface Invocable<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H = R,
> {
  readonly kind: K;
  readonly args: A;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly handler: (ctx: Ctx, args: Expand<InferShape<A>>) => H | Promise<H>;
  readonly returns?: Validator<unknown, string>;
  readonly errors?: ErrorDeclarations;
  readonly _argsType?: ArgsInput<A>;
  readonly _retType?: R;
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
> extends Invocable<K, A, Ctx, R, H>, ExposureDef {
  readonly isAckerDB: true;
}

export type RegisteredQuery<
  A extends ObjectShape,
  R,
  S extends Schema = Schema,
  H = R,
> = Registered<
  "query",
  A,
  QueryCtx<S>,
  R,
  H
>;
export type RegisteredMutation<
  A extends ObjectShape,
  R,
  S extends Schema = Schema,
  H = R,
> = Registered<
  "mutation",
  A,
  MutationCtx<S>,
  R,
  H
>;
export type RegisteredProcedure<
  A extends ObjectShape,
  R,
  S extends Schema = Schema,
  H = R,
> = Registered<
  "procedure",
  A,
  ProcedureCtx<S>,
  R,
  H
>;
export interface RegisteredSse<A extends ObjectShape, Chunk, S extends Schema = Schema>
  extends Registered<"sse", A, SseCtx<S>, Chunk, SseSource<Chunk>> {
  /** Validates every yielded chunk at the server boundary. */
  readonly yields: Validator<Chunk, string>;
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

function validateOutputDeclarations(def: Pick<
  FunctionDef<ObjectShape, InvocationContext>,
  "returns" | "errors"
>): void {
  if (def.returns !== undefined && !isValidator(def.returns)) {
    throw new TypeError("returns must be a v validator");
  }
  if (def.errors === undefined) return;
  for (const [code, declaration] of Object.entries(def.errors)) {
    if (code.length === 0) throw new TypeError("error codes must be non-empty strings");
    if (
      declaration === null ||
      typeof declaration !== "object" ||
      !isValidator(declaration.body) ||
      !Object.values(Status).includes(declaration.status)
    ) {
      throw new TypeError(`errors.${code} must declare a body validator and named Status`);
    }
  }
}

/** Validated surface metadata, spread onto the registered function as declared. */
function exposureFields(def: ExposureDef): ExposureDef {
  httpExposure(def.http);
  for (const field of ["description", "title"] as const) {
    const value = def[field];
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(`${field} must be a string`);
    }
  }
  return {
    ...(def.http === undefined ? {} : { http: def.http }),
    ...(def.description === undefined ? {} : { description: def.description }),
    ...(def.title === undefined ? {} : { title: def.title }),
  };
}

export function validateYields(yields: unknown): asserts yields is Validator<unknown, string> {
  if (!isValidator(yields)) {
    throw new TypeError("sse yields must be a v validator for the chunks the stream emits");
  }
  if (yields.kind === "pk" || yields.kind === "scheduleAt" || yields.kind === "tag") {
    throw new Error(`yields: v.${yields.kind}() is not a valid chunk validator`);
  }
}

function register<K extends string>(kind: K) {
  return <
    A extends ObjectShape,
    Ctx extends InvocationContext,
    const Definition extends FunctionDef<A, Ctx>,
  >(
    def: { readonly args: A } &
      Definition &
      DefinitionConstraint<NoInfer<Definition>>,
  ): Registered<
    K,
    A,
    Ctx,
    ResultOfDefinition<Definition>,
    DefinitionReturn<Definition>
  > => {
    if (!isAccessPolicy(def.access)) {
      throw new TypeError(`${kind} access must be public, authenticated, system, or a policy callback`);
    }
    validateArgsShape(def.args);
    validateOutputDeclarations(def as never);
    const exposure = exposureFields(def);

    const callable =
      kind === "query" || kind === "mutation" || kind === "procedure"
        ? (ctx: Ctx, args: unknown) => invokeFunction(registered, ctx, args)
        : () => {
            throw new Error(`${kind}s cannot be called in-process — they exist at the transport boundary`);
          };
    const registered = Object.assign(callable, {
      isAckerDB: true as const,
      kind,
      args: def.args,
      ...(def.returns === undefined ? {} : { returns: def.returns }),
      ...(def.errors === undefined ? {} : { errors: def.errors }),
      ...exposure,
      access: def.access,
      handler: def.handler,
    }) as unknown as Registered<
      K,
      A,
      Ctx,
      ResultOfDefinition<Definition>,
      DefinitionReturn<Definition>
    >;
    compileInvocation(registered);
    return registered;
  };
}

/** Schema-agnostic constructors; queries and mutations are directly callable. */
function registerCallable<K extends string>(kind: K) {
  return register(kind) as <
    A extends ObjectShape,
    Ctx extends InvocationContext,
    const Definition extends FunctionDef<A, Ctx>,
  >(
    def: { readonly args: A } &
      Definition &
      DefinitionConstraint<NoInfer<Definition>>,
  ) => Registered<
    K,
    A,
    Ctx,
    ResultOfDefinition<Definition>,
    DefinitionReturn<Definition>
  > &
    ((
      ctx: Ctx,
      args: Expand<ArgsInput<A>>,
    ) => Promise<ResultOfDefinition<Definition>>);
}

export const query = registerCallable("query");
export const mutation = registerCallable("mutation");
export const procedure = registerCallable("procedure");

interface SseDef<
  A extends ObjectShape,
  Y extends Validator<unknown, string>,
  Ctx extends InvocationContext,
> extends ExposureDef {
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
  const exposure = exposureFields(def);

  const callable = () => {
    throw new Error("sses cannot be called in-process — they exist at the transport boundary");
  };
  const registered = Object.assign(callable, {
    isAckerDB: true as const,
    kind: "sse" as const,
    args: def.args,
    yields: def.yields,
    ...exposure,
    access: def.access,
    handler: def.handler,
  }) as unknown as RegisteredSse<A, Expand<InferValidator<Y>>, Schema>;
  compileInvocation(registered);
  return registered;
}

export type QueryBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
> = <
  A extends ObjectShape,
  const Definition extends FunctionDef<A, QueryCtx<S, Capabilities>>,
>(
  def: { readonly args: A } &
    Definition &
    DefinitionConstraint<NoInfer<Definition>>,
) => RegisteredQuery<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ((
    ctx: QueryCtx<S, Capabilities>,
    args: Expand<ArgsInput<A>>,
  ) => Promise<ResultOfDefinition<Definition>>);

export type MutationBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
> = <
  A extends ObjectShape,
  const Definition extends FunctionDef<A, MutationCtx<S, Capabilities>>,
>(
  def: { readonly args: A } &
    Definition &
    DefinitionConstraint<NoInfer<Definition>>,
) => RegisteredMutation<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ((
    ctx: MutationCtx<S, Capabilities>,
    args: Expand<ArgsInput<A>>,
  ) => Promise<ResultOfDefinition<Definition>>);

export type ProcedureBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = <
  A extends ObjectShape,
  const Definition extends FunctionDef<
    A,
    ProcedureCtx<S, Capabilities, TransactionCapabilities>
  >,
>(
  def: { readonly args: A } &
    Definition &
    DefinitionConstraint<NoInfer<Definition>>,
) => RegisteredProcedure<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ((
    ctx: ProcedureCtx<S, Capabilities, TransactionCapabilities>,
    args: Expand<ArgsInput<A>>,
  ) => Promise<ResultOfDefinition<Definition>>);

export type SseBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = <A extends ObjectShape, Y extends Validator<unknown, string>>(def: ExposureDef & {
  readonly args: A;
  readonly yields: Y;
  readonly access: AccessPolicy<
    SseCtx<S, Capabilities, TransactionCapabilities>,
    Expand<InferShape<A>>
  >;
  readonly handler: (
    ctx: SseCtx<S, Capabilities, TransactionCapabilities>,
    args: Expand<InferShape<A>>,
  ) => SseSource<InferValidator<Y>> | Promise<SseSource<InferValidator<Y>>>;
}) => RegisteredSse<A, Expand<InferValidator<Y>>, S>;

// Runtime registries deliberately erase each function's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegistered = Registered<string, ObjectShape, any, any, any>;

// Invocation registries deliberately erase each declaration's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInvocable = Invocable<string, ObjectShape, any, any, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegisteredSse = RegisteredSse<ObjectShape, any, any>;

export function isRegisteredFunction(value: unknown): value is AnyRegistered {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as { isAckerDB?: unknown }).isAckerDB === true &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    isAccessPolicy((value as { access?: unknown }).access)
  );
}
