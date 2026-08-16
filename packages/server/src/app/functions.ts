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
  DEFAULT_API_PATH,
  EVENTS_NAMESPACE,
  Status,
  type ApplicationError,
  type DefaultApiPath,
  type RegisteredApiPath,
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
import type {
  InferInputShape,
  InferShape,
  ObjectShape,
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

/**
 * The shape a declaration cannot satisfy, so the error names the rule. It is
 * an object, not a string: intersected with a union of literals a string
 * marker reduces to `never`, and TypeScript then reports every property of the
 * declaration instead of the one at fault. This is the shape
 * {@link ErrorDeclarationConstraint} already uses for the same reason.
 */
interface ImpreciseApiPath {
  readonly apiPath: {
    readonly "AckerDB: apiPath must be exactly one string literal": never;
  };
}

/** True when `T` stands for more than one type — a union rather than one literal. */
type IsUnion<T, Members = T> = T extends unknown
  ? [Members] extends [T]
    ? false
    : true
  : never;

/**
 * A declared group must be exactly one string literal. A generated tree
 * selects functions whose group matches one exact name, so anything less
 * precise — a widened `string`, a union of literals, a literal that may be
 * `undefined` — names no group any tree can select, and the function would
 * answer on a live route while appearing in no binding at all. This is the
 * same silent widening the literal-only rule on the retired `internal` field
 * existed to prevent.
 */
type ApiPathConstraint<Definition> = Definition extends {
  readonly apiPath: infer Path;
}
  ? [Path] extends [string]
    ? string extends Path
      ? ImpreciseApiPath
      : IsUnion<Path> extends true
        ? ImpreciseApiPath
        : unknown
    : ImpreciseApiPath
  : unknown;

type DefinitionConstraint<Definition extends { readonly handler: Function }> =
  ApiPathConstraint<Definition> &
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

/**
 * An API path is one address segment, one URL segment, and one generated
 * binding name, so it obeys the rule module segments already obey. The leading
 * `_` is the framework's reserved marker, which the identifier rule excludes
 * at the first character.
 */
const API_PATH = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Names the identifier rule admits but `export const <name>` does not: the
 * reserved words, plus `eval` and `arguments`, which strict mode forbids as
 * bindings. Code generation writes a group's name straight into a binding, so
 * a name that cannot be one fails here rather than inside a generated file.
 */
const UNBINDABLE_NAMES: ReadonlySet<string> = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package",
  "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield",
]);

/**
 * The one interpreter of `apiPath`: the group a function is published in, and
 * so the first segment of its address — which decides its generated binding
 * and its HTTP root together. Absent means {@link DEFAULT_API_PATH}. It is
 * namespacing and routing only — who may call is `access` alone — so no value
 * here widens or narrows admission.
 */
export function apiPath(value: unknown, where = "apiPath"): string {
  if (value === undefined) return DEFAULT_API_PATH;
  if (typeof value !== "string" || !API_PATH.test(value)) {
    throw new TypeError(
      `${where} must be a name starting with a letter, followed by letters, digits, or "_" — "_" is reserved to AckerDB`,
    );
  }
  if (UNBINDABLE_NAMES.has(value)) {
    throw new TypeError(`${where} must not be "${value}" — a group's name becomes a binding, and that one cannot be`);
  }
  if (value === EVENTS_NAMESPACE) {
    throw new TypeError(
      `${where} must not be "${EVENTS_NAMESPACE}" — the generated api module already binds that name to event-table references`,
    );
  }
  return value;
}

/**
 * Startup refusal for kinds addressed over the socket, which have no HTTP root
 * to group. Their addresses therefore always begin with the default group.
 */
export function refuseApiPathDeclaration(def: object, what: string): void {
  if ((def as { readonly apiPath?: unknown }).apiPath !== undefined) {
    throw new TypeError(
      `${what} cannot declare apiPath — it is addressed over the socket and has no HTTP root to group`,
    );
  }
}

/** Surface metadata every kind shares: HTTP exposure and its documentation. */
interface ExposureDef {
  readonly http?: HttpExposure;
  readonly description?: string;
  readonly title?: string;
  /**
   * The group this function is published in, and the first segment of its
   * address: `"api"` by default, giving `api.messages.list` and the route
   * `/api/messages/list`; `"internal"` gives `internal.messages.list` and
   * `/internal/messages/list`. Namespacing and routing only — `access` alone
   * decides who may call it. Names beginning with `_` are reserved.
   */
  readonly apiPath?: string;
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

/**
 * Carries a declaration's group onto the registered type using core's own
 * selector, so the tree that reads it and the builder that writes it cannot
 * disagree about the field.
 */
type ApiPathOf<Definition> = Definition extends {
  readonly apiPath: infer Path extends string;
}
  ? RegisteredApiPath<Path>
  : RegisteredApiPath<DefaultApiPath>;

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
export interface Registered<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H = R,
> extends Invocable<K, A, Ctx, R, H>, ExposureDef {
  readonly isAckerDB: true;
  /** Always present: the declaration's group, or `"api"` when it named none. */
  readonly apiPath: string;
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
function exposureFields(
  def: ExposureDef,
  kind: string,
): ExposureDef & { readonly apiPath: string } {
  httpExposure(def.http, `${kind} http`);
  for (const field of ["description", "title"] as const) {
    const value = def[field];
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(`${kind} ${field} must be a string`);
    }
  }
  return {
    // Resolved, never conditional: every registered function has a group, so
    // the registry reads one field instead of restating the default.
    apiPath: apiPath(def.apiPath, `${kind} apiPath`),
    ...(def.http === undefined ? {} : { http: def.http }),
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
 * The declaration's own fields, listed once for the refusal below. `satisfies`
 * makes the type the source of truth in both directions: adding a field to the
 * definition without listing it here, or listing one the definition dropped,
 * fails this build rather than a caller's declaration.
 */
const FUNCTION_FIELDS = {
  apiPath: true,
  http: true,
  description: true,
  title: true,
  args: true,
  returns: true,
  errors: true,
  access: true,
  scopes: true,
  handler: true,
} satisfies Record<keyof FunctionDef<ObjectShape, InvocationContext>, true>;

const SSE_FIELDS = {
  apiPath: true,
  http: true,
  description: true,
  title: true,
  args: true,
  yields: true,
  access: true,
  scopes: true,
  handler: true,
} satisfies Record<
  keyof SseDef<ObjectShape, Validator<unknown, string>, InvocationContext>,
  true
>;

const FUNCTION_KEYS = Object.freeze(Object.keys(FUNCTION_FIELDS));
const SSE_KEYS = Object.freeze(Object.keys(SSE_FIELDS));

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
  > & ApiPathOf<Definition> => {
    if (!isAccessPolicy(def.access)) {
      throw new TypeError(`${kind} access must be public, authenticated, system, or a policy callback`);
    }
    validateArgsShape(def.args);
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
      isAckerDB: true as const,
      kind,
      args: def.args,
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
    > & ApiPathOf<Definition>;
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
    ApiPathOf<Definition> &
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
  const Definition extends SseDef<A, Y, Ctx>,
>(
  def: SseDef<A, Y, Ctx> & Definition & ApiPathConstraint<NoInfer<Definition>>,
): RegisteredSse<A, Expand<InferValidator<Y>>, Schema> & ApiPathOf<Definition> {
  if (!isAccessPolicy(def.access)) {
    throw new TypeError("sse access must be public, authenticated, system, or a policy callback");
  }
  validateArgsShape(def.args);
  validateYields(def.yields);
  const exposure = exposureFields(def, "sse");
  const scoped = scopeFields(def, "sse");

  const callable = () => {
    throw new Error("sses cannot be called in-process — they exist at the transport boundary");
  };
  const registered = Object.assign(callable, {
    isAckerDB: true as const,
    kind: "sse" as const,
    args: def.args,
    yields: def.yields,
    ...exposure,
    ...scoped,
    access: def.access,
    handler: def.handler,
  }) as unknown as RegisteredSse<A, Expand<InferValidator<Y>>, Schema> &
    ApiPathOf<Definition>;
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
    DefinitionConstraint<NoInfer<Definition>>,
) => RegisteredQuery<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ApiPathOf<Definition> &
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
    DefinitionConstraint<NoInfer<Definition>>,
) => RegisteredMutation<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ApiPathOf<Definition> &
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
    DefinitionConstraint<NoInfer<Definition>>,
) => RegisteredProcedure<
  A,
  ResultOfDefinition<Definition>,
  S,
  DefinitionReturn<Definition>
> &
  ApiPathOf<Definition> &
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
  const Definition extends SseDef<
    A,
    Y,
    SseCtx<S, Jobs, TxJobs>,
    Scope
  >,
>(
  def: SseDef<
    A,
    Y,
    SseCtx<S, Jobs, TxJobs>,
    Scope
  > & Definition & ApiPathConstraint<NoInfer<Definition>>,
) => RegisteredSse<A, Expand<InferValidator<Y>>, S> & ApiPathOf<Definition>;

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
