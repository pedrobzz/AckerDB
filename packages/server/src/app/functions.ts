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
import type {
  Expand,
  InferValidator,
  Validator,
} from "../validation/validator.ts";
import {
  object,
  type InferInputShape,
  type InferShape,
  type ObjectValidator,
  type ObjectShape,
} from "../validation/composites.ts";
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
import {
  normalizeScopeRequirement,
  type NormalizedScopeRequirement,
  type ScopeRequirement,
} from "../auth/scopes.ts";
import type { Schema } from "../schema/definition.ts";
import { validateArgsShape } from "../validation/declarations.ts";
import type { AnyJobsNamespace } from "../jobs/api.ts";
import type {
  CredentialMutationCapability,
  CredentialQueryCapability,
} from "../credentials/api.ts";
import type {
  FileMutationCapability,
  FileProcedureCapability,
  FileQueryCapability,
} from "../files/api.ts";
import { assertApplicationHttpPath } from "../transport/http-surface.ts";
import { captureNames, validateRoutePath } from "../transport/routing/path.ts";

export type AuthCtx = Principal;

export type QueryCtx<
  S extends Schema = Schema,
  Jobs extends object = AnyJobsNamespace,
> = InvocationContext & {
  readonly db: DbReader<S>;
  readonly auth: AuthCtx;
  readonly timestamp: number;
  /** Declared jobs, read-only: the reactive builder scoped per definition. */
  readonly jobs: Jobs;
  /** Reactive metadata reads over framework-owned immutable Files. */
  readonly files: FileQueryCapability;
  /** Reactive reads over the credentials this Identity issued, and over all of them. */
  readonly credentials: CredentialQueryCapability;
};

export type MutationCtx<
  S extends Schema = Schema,
  Jobs extends object = AnyJobsNamespace,
> = InvocationContext & {
  readonly db: DbWriter<S>;
  readonly auth: AuthCtx;
  readonly timestamp: number;
  /** Declared jobs: transactional enqueue — the job exists iff this commits. */
  readonly jobs: Jobs;
  /** Transactional File lifecycle, Upload Session, and File Grant operations. */
  readonly files: FileMutationCapability;
  /**
   * Credential issuance and administration. The owner surface is bounded by the
   * calling Identity's own grant; `credentials.manage` is global and carries no
   * framework access check, so the containing function's access policy and
   * declared scopes are the whole admission decision.
   */
  readonly credentials: CredentialMutationCapability;
};

/** The context inside `ctx.tx(...)`: a mutation's powers, structurally. */
export type TxCtx<
  S extends Schema = Schema,
  Jobs extends object = AnyJobsNamespace,
> = MutationCtx<S, Jobs>;

export type ProcedureCtx<
  S extends Schema = Schema,
  Jobs extends object = AnyJobsNamespace,
  TxJobs extends object = AnyJobsNamespace,
> = InvocationContext & {
  readonly auth: AuthCtx;
  readonly timestamp: number;
  /** Fires when the request, credential lease, or Runtime shuts down. */
  readonly abortSignal: AbortSignal;
  /** Declared jobs: enqueue, await, and sanctioned transitions. */
  readonly jobs: Jobs;
  /** Immutable File byte I/O; database-coupled lifecycle changes stay inside tx. */
  readonly files: FileProcedureCapability;
  /** Prove and attach another user account using its raw bearer token, not an Authorization header. */
  linkAccount(rawBearerToken: string): Promise<void>;
  /** Remove one exact owned account while retaining the durable application Identity. */
  unlinkAccount(account: ExternalAccount): Promise<void>;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<R>(
    fn: (tx: TxCtx<S, TxJobs>) => R,
  ): Promise<FunctionResult<R>>;
};

/**
 * One channel invocation's context together with the auth-invalidation
 * publisher opened for it. A channel handler runs outside any single request,
 * so the publisher it may revoke through is finished by the owner rather than
 * by a response handoff.
 */
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
  Jobs extends object = AnyJobsNamespace,
  TxJobs extends object = AnyJobsNamespace,
> = ProcedureCtx<S, Jobs, TxJobs>;

/** Args as the caller provides them: only optional/nullish keys may be omitted. */
export type ArgsInput<A extends ObjectShape> = InferInputShape<A>;

/** One explicit public HTTP route produced by a function factory. */
export interface HttpExposure {
  readonly path: string;
  readonly openapi: boolean;
}

export interface ErrorDeclaration {
  readonly body: Validator<unknown, string>;
  readonly status: ErrorHttpStatus;
}

type ErrorDeclarations = Readonly<Record<string, ErrorDeclaration>>;

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
  Scope extends string = string,
> = ExposureDef & {
  readonly args: A;
  readonly returns?: Validator<unknown, string>;
  readonly errors?: ErrorDeclarations;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  /**
   * The scope requirement drawn from the application vocabulary, enforced at
   * the one authorization funnel after `access`. It combines with
   * `"authenticated"` or a policy callback; `"public"` contradicts it and
   * `"system"` bypasses it, so both are registration errors. Generated server
   * modules bind `Scope` to the declared vocabulary, which makes an undeclared
   * scope a compile error.
   */
  readonly scopes?: ScopeRequirement<Scope>;
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
  readonly args: ObjectValidator<A>;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly scopes?: NormalizedScopeRequirement;
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
export type Registered<
  K extends RegisteredFunctionKind,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H = R,
> = Invocable<K, A, Ctx, R, H> & ExposureDef;

export type RegisteredFunctionKind = "query" | "mutation" | "procedure" | "sse";

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
    typeof (value as Validator).parse === "function" &&
    typeof (value as Validator).decode === "function" &&
    typeof (value as Validator).encode === "function" &&
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
function exposureFields(
  def: ExposureDef,
  kind: string,
): ExposureDef {
  let http: HttpExposure | undefined;
  if (def.http !== undefined) {
    const value = def.http;
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 2 ||
      typeof value.path !== "string" ||
      typeof value.openapi !== "boolean"
    ) {
      throw new TypeError(`${kind} http must be { path: string, openapi: boolean }`);
    }
    const path = validateRoutePath(value.path, `${kind} http`);
    if (captureNames(path).length !== 0) {
      throw new TypeError(`${kind} http path must not contain parameters`);
    }
    assertApplicationHttpPath(path, `${kind} http`);
    http = Object.freeze({ path, openapi: value.openapi });
  }
  for (const field of ["description", "title"] as const) {
    const value = def[field];
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(`${kind} ${field} must be a string`);
    }
  }
  return {
    ...(http === undefined ? {} : { http }),
    ...(def.description === undefined ? {} : { description: def.description }),
    ...(def.title === undefined ? {} : { title: def.title }),
  };
}

/**
 * Validate a declared scope requirement once, at registration. Requiring
 * scopes on a `"public"` function contradicts the declaration — an anonymous
 * caller can never hold one — and on a `"system"` function it is dead
 * configuration, because system authority bypasses scopes at the funnel. Both
 * are registration errors rather than a rule that silently never fires.
 */
/**
 * Normalize the declared requirement once, here, and keep the canonical value.
 *
 * What is registered must be what is enforced and what is validated. Keeping
 * the caller's own object instead would leave three parties reading a mutable
 * declaration at three different moments: registration validating one shape,
 * dispatch compiling a private snapshot of another, and the load-time
 * vocabulary check approving a third. `normalizeScopeRequirement` already
 * clones and freezes, so storing its result is what makes the authorization
 * rule single-valued rather than merely written down three times.
 */
function scopeFields(
  def: { readonly access: unknown; readonly scopes?: ScopeRequirement<string> },
  kind: string,
): { readonly scopes?: NormalizedScopeRequirement } {
  if (def.scopes === undefined) return {};
  const scopes = normalizeScopeRequirement(def.scopes, `${kind} scopes`);
  if (def.access === "public" || def.access === "system") {
    throw new TypeError(
      `${kind} scopes cannot combine with access "${String(def.access)}"` +
        ` — use "authenticated" or a policy callback`,
    );
  }
  return { scopes };
}

export function validateYields(yields: unknown): asserts yields is Validator<unknown, string> {
  if (!isValidator(yields)) {
    throw new TypeError("sse yields must be a v validator for the chunks the stream emits");
  }
  if (yields.kind === "pk" || yields.kind === "scheduleAt" || yields.kind === "tag") {
    throw new Error(`yields: v.${yields.kind}() is not a valid chunk validator`);
  }
}

/**
 * A declaration parameter is an intersection with an inferred generic, which
 * turns off TypeScript's excess-property check. Restating the allowed keys as
 * a type restores it: every key outside the definition maps to `never`, so a
 * misspelled field fails the caller's build instead of being dropped in
 * silence. The definition type is the only list.
 */
type ExactKeys<Definition, Allowed> = {
  readonly [K in Exclude<keyof Definition, keyof Allowed>]: never;
};

function register<K extends RegisteredFunctionKind>(kind: K) {
  return <
    A extends ObjectShape,
    Ctx extends InvocationContext,
    const Definition extends FunctionDef<A, Ctx>,
  >(
    def: { readonly args: A } &
      Definition &
      DefinitionConstraint<NoInfer<Definition>> &
      ExactKeys<NoInfer<Definition>, FunctionDef<A, Ctx>>,
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
    const args = object(def.args);
    validateOutputDeclarations(def as never);
    const exposure = exposureFields(def, kind);
    const scoped = scopeFields(def, kind);

    const callable =
      kind === "query" || kind === "mutation" || kind === "procedure"
        ? (ctx: Ctx, args: unknown) => invokeFunction(registered, ctx, args)
        : () => {
            throw new Error(`${kind}s cannot be called in-process — they exist at the transport boundary`);
          };
    const registered = Object.assign(callable, {
      kind,
      args,
      ...(def.returns === undefined ? {} : { returns: def.returns }),
      ...(def.errors === undefined ? {} : { errors: def.errors }),
      ...exposure,
      ...scoped,
      access: def.access,
      handler: def.handler,
    }) as unknown as Registered<
      K,
      A,
      Ctx,
      ResultOfDefinition<Definition>,
      DefinitionReturn<Definition>
    >;
    // Frozen before it is compiled, so what is registered is what is enforced.
    // Dispatch compiles `args`, `access` and `scopes` into a private snapshot
    // here, once; a writable declaration would let a later assignment show the
    // registry — and every load-time rule reading it — a policy the funnel is
    // not enforcing.
    Object.freeze(registered);
    compileInvocation(registered);
    return registered;
  };
}

/** Schema-agnostic constructors; queries and mutations are directly callable. */
function registerCallable<K extends Exclude<RegisteredFunctionKind, "sse">>(kind: K) {
  return register(kind) as <
    A extends ObjectShape,
    Ctx extends InvocationContext,
    const Definition extends FunctionDef<A, Ctx>,
  >(
    def: { readonly args: A } &
      Definition &
      DefinitionConstraint<NoInfer<Definition>> &
      ExactKeys<NoInfer<Definition>, FunctionDef<A, Ctx>>,
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
  Scope extends string = string,
> extends ExposureDef {
  readonly args: A;
  readonly yields: Y;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
  readonly scopes?: ScopeRequirement<Scope>;
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
>(
  def: SseDef<A, Y, Ctx>,
): RegisteredSse<A, Expand<InferValidator<Y>>, Schema> {
  if (!isAccessPolicy(def.access)) {
    throw new TypeError("sse access must be public, authenticated, system, or a policy callback");
  }
  validateArgsShape(def.args);
  const args = object(def.args);
  validateYields(def.yields);
  const exposure = exposureFields(def, "sse");
  const scoped = scopeFields(def, "sse");

  const callable = () => {
    throw new Error("sses cannot be called in-process — they exist at the transport boundary");
  };
  const registered = Object.assign(callable, {
    kind: "sse" as const,
    args,
    yields: def.yields,
    ...exposure,
    ...scoped,
    access: def.access,
    handler: def.handler,
  }) as unknown as RegisteredSse<A, Expand<InferValidator<Y>>, Schema>;
  Object.freeze(registered);
  compileInvocation(registered);
  return registered;
}

/**
 * Code generation binds `Scope` to the application's declared vocabulary, so
 * `scopes: { anyOf: ["notes:read"] }` type-checks against `defineApp` and an
 * undeclared scope is a compile error. The schema-agnostic constructors keep
 * the `string` default.
 */
export type QueryBuilder<
  S extends Schema,
  Jobs extends object = AnyJobsNamespace,
  Scope extends string = string,
> = <
  A extends ObjectShape,
  const Definition extends FunctionDef<A, QueryCtx<S, Jobs>, Scope>,
>(
  def: { readonly args: A } &
    Definition &
    DefinitionConstraint<NoInfer<Definition>> &
      ExactKeys<NoInfer<Definition>, FunctionDef<A, QueryCtx<S, Jobs>, Scope>>,
) => RegisteredQuery<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ((
    ctx: QueryCtx<S, Jobs>,
    args: Expand<ArgsInput<A>>,
  ) => Promise<ResultOfDefinition<Definition>>);

export type MutationBuilder<
  S extends Schema,
  Jobs extends object = AnyJobsNamespace,
  Scope extends string = string,
> = <
  A extends ObjectShape,
  const Definition extends FunctionDef<A, MutationCtx<S, Jobs>, Scope>,
>(
  def: { readonly args: A } &
    Definition &
    DefinitionConstraint<NoInfer<Definition>> &
      ExactKeys<NoInfer<Definition>, FunctionDef<A, MutationCtx<S, Jobs>, Scope>>,
) => RegisteredMutation<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ((
    ctx: MutationCtx<S, Jobs>,
    args: Expand<ArgsInput<A>>,
  ) => Promise<ResultOfDefinition<Definition>>);

export type ProcedureBuilder<
  S extends Schema,
  Jobs extends object = AnyJobsNamespace,
  TxJobs extends object = AnyJobsNamespace,
  Scope extends string = string,
> = <
  A extends ObjectShape,
  const Definition extends FunctionDef<
    A,
    ProcedureCtx<S, Jobs, TxJobs>,
    Scope
  >,
>(
  def: { readonly args: A } &
    Definition &
    DefinitionConstraint<NoInfer<Definition>> &
      ExactKeys<NoInfer<Definition>, FunctionDef<
    A,
    ProcedureCtx<S, Jobs, TxJobs>,
    Scope
  >>,
) => RegisteredProcedure<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ((
    ctx: ProcedureCtx<S, Jobs, TxJobs>,
    args: Expand<ArgsInput<A>>,
  ) => Promise<ResultOfDefinition<Definition>>);

export type SseBuilder<
  S extends Schema,
  Jobs extends object = AnyJobsNamespace,
  TxJobs extends object = AnyJobsNamespace,
  Scope extends string = string,
> = <
  A extends ObjectShape,
  Y extends Validator<unknown, string>,
>(
  def: SseDef<
    A,
    Y,
    SseCtx<S, Jobs, TxJobs>,
    Scope
  >,
) => RegisteredSse<A, Expand<InferValidator<Y>>, S>;

// Runtime registries deliberately erase each function's concrete context while
// preserving separate literal-kind members for exhaustive narrowing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RuntimeRegistered<K extends RegisteredFunctionKind> = Registered<K, ObjectShape, any, any, any>;

type RuntimeRegisteredSse = RuntimeRegistered<"sse"> & {
  readonly yields: Validator<unknown, string>;
};

export type AnyRegistered =
  | RuntimeRegistered<"query">
  | RuntimeRegistered<"mutation">
  | RuntimeRegistered<"procedure">
  | RuntimeRegisteredSse;

// Invocation registries deliberately erase each declaration's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInvocable = Invocable<string, ObjectShape, any, any, any>;

export type AnyRegisteredSse = RuntimeRegisteredSse;
