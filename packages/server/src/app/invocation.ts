import { AsyncLocalStorage } from "node:async_hooks";
import {
  Err,
  Ok,
  isApplicationError,
  isResult,
  type OkResult,
  type Outcome,
} from "@ackerdb/core";
import { isPrincipal, type Principal } from "../auth/credentials.ts";
import type { Expand, Validator } from "../validation/validator.ts";
import {
  compileShape,
  type InferShape,
  type ObjectShape,
} from "../validation/composites.ts";
import { AckerDBError } from "../shared/errors.ts";
import type {
  AnyInvocable,
  FunctionResult,
  Invocable,
} from "./functions.ts";
import type { AccessPolicy, InvocationContext } from "./access.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { outcomeFromError } from "../runtime/outcome.ts";
import {
  currentInvocationState,
  withInvocationState,
  type InvocationState,
  type MutationAccess,
} from "../runtime/invocation-state.ts";

type AccessEnforcer<Ctx, Args> = (ctx: Ctx, args: Args) => void | Promise<void>;

interface CompiledInvocation<Ctx, Args> {
  readonly validateArgs: (rawArgs: unknown) => Args;
  readonly enforceAccess: AccessEnforcer<Ctx, Args>;
}

type InvocationArgsDecoder<Args> = (rawArgs: unknown, path: string) => Args;

export type InvocationPhase = "auth" | "policy" | "handler";
export type InvocationOutcome = "ok" | Outcome["code"];

export interface InvocationObservation {
  readonly fn: AnyInvocable;
  readonly invocationId: number;
  readonly parentInvocationId?: number;
  readonly depth: number;
  readonly phase: InvocationPhase;
  readonly durationMs: number;
  readonly outcome: InvocationOutcome;
}

export type InvocationObserver = (observation: InvocationObservation) => unknown;

export interface InvocationPhaseScope {
  readonly fn: AnyInvocable;
  readonly invocationId: number;
  readonly parentInvocationId?: number;
  readonly depth: number;
  readonly phase: InvocationPhase;
}

export interface InvocationPhaseRunner {
  <T>(scope: Readonly<InvocationPhaseScope>, work: () => T): T;
}

interface InvocationInstrumentationScope {
  readonly observer?: InvocationObserver;
  readonly telemetryObserver?: InvocationTelemetryObserver;
  readonly runPhase?: InvocationPhaseRunner;
  nextInvocationId: number;
}

interface InvocationInstrumentationState {
  readonly scope: InvocationInstrumentationScope;
  readonly invocationId: number | null;
  readonly parentInvocationId?: number;
  readonly depth: number;
  readonly parent?: InvocationInstrumentationState;
  readonly fn?: AnyInvocable;
}

export interface InvocationTelemetryContext {
  readonly invocationId: number;
  readonly parent?: InvocationTelemetryContext;
  readonly fn: AnyInvocable;
}

export interface InvocationFunctionContext {
  readonly invocationId: number;
  readonly parent?: InvocationFunctionContext;
  readonly fn: AnyInvocable;
}

export type InvocationTelemetryObserver = (
  context: InvocationTelemetryContext,
  phase: InvocationPhase,
  durationMs: number,
  outcome: InvocationOutcome,
) => unknown;

export interface InvocationOptions<Ctx, Args> {
  /** Runs after args and access pass, immediately before the handler starts. */
  readonly onAuthorized?: (ctx: Ctx, args: Args) => void;
  /** Package-internal writer scope for a top-level mutation or transaction. */
  readonly mutationAccess?: MutationAccess;
}

export interface AuthorizationDefinition<A extends ObjectShape, Ctx extends InvocationContext> {
  readonly args: A;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
}

export interface AuthorizedInvocation<Ctx, Args> {
  readonly ctx: Ctx;
  readonly args: Args;
}

const invocationInstrumentation = new AsyncLocalStorage<InvocationInstrumentationState>();
const compiledInvocations = new WeakMap<object, CompiledInvocation<InvocationContext, unknown>>();

/** Install one isolated observer scope around a top-level invocation boundary. */
export function withInvocationObserver<T>(
  observer: InvocationObserver,
  work: () => T,
  runPhase?: InvocationPhaseRunner,
): T {
  return invocationInstrumentation.run({
    scope: { observer, runPhase, nextInvocationId: 0 },
    invocationId: null,
    depth: -1,
  }, work);
}

/** Package-internal low-allocation observer path for Runtime telemetry. */
export function withInvocationTelemetry<T>(
  observer: InvocationTelemetryObserver,
  work: () => T,
): T {
  return invocationInstrumentation.run({
    scope: { telemetryObserver: observer, nextInvocationId: 0 },
    invocationId: null,
    depth: -1,
  }, work);
}

/** Install only ambient function ownership, without timing or observations. */
export function withInvocationContext<T>(work: () => T): T {
  return invocationInstrumentation.run({
    scope: { nextInvocationId: 0 },
    invocationId: null,
    depth: -1,
  }, work);
}

export function currentInvocationFunctionContext(): InvocationFunctionContext | undefined {
  const state = invocationInstrumentation.getStore();
  return state?.invocationId !== null && state?.fn !== undefined
    ? state as InvocationFunctionContext
    : undefined;
}

/** Returns the existing ambient invocation frame without allocating a public observation. */
export function currentInvocationTelemetryContext(): InvocationTelemetryContext | undefined {
  const state = invocationInstrumentation.getStore();
  return state?.invocationId !== null && state?.fn !== undefined
    ? state as InvocationTelemetryContext
    : undefined;
}

function denied(principal: Principal, cause?: unknown): AckerDBError {
  return principal.kind === "anonymous"
    ? new AckerDBError("unauthenticated", "authentication required", { cause })
    : new AckerDBError("unauthorized", "access denied", { cause });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function compileAccess<Ctx extends InvocationContext, Args>(
  access: AccessPolicy<Ctx, Args>,
): AccessEnforcer<Ctx, Args> {
  if (access === "public") return () => {};
  if (access === "authenticated") {
    return (ctx) => {
      if (ctx.auth.kind === "anonymous") throw denied(ctx.auth);
    };
  }
  if (access === "system") {
    return (ctx) => {
      if (ctx.auth.kind !== "system") throw denied(ctx.auth);
    };
  }
  return async (ctx, args) => {
    let allowed: boolean;
    try {
      allowed = (await access(ctx, args)) === true;
    } catch (error) {
      throw new AckerDBError("unauthorized", "access denied", { cause: error });
    }
    if (!allowed) throw denied(ctx.auth);
  };
}

const SCALAR_OUTPUT_KINDS = new Set([
  "string",
  "int",
  "float",
  "bigint",
  "identity",
  "boolean",
  "enum",
  "literal",
]);

function scalarOutput(validator: Validator<unknown, string>): boolean {
  return SCALAR_OUTPUT_KINDS.has(validator.kind) || (
    (validator.kind === "nullable" || validator.kind === "optional" || validator.kind === "nullish") &&
    scalarOutput((validator as Validator & { readonly inner: Validator }).inner)
  );
}

function buildInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
  decoder?: InvocationArgsDecoder<Expand<InferShape<A>>>,
): CompiledInvocation<Ctx, Expand<InferShape<A>>> {
  const shape = definition.args;
  const enforceAccess = compileAccess(definition.access);
  const decode = decoder ?? (
    compileShape(shape) as InvocationArgsDecoder<Expand<InferShape<A>>>
  );
  const check = (rawArgs: unknown) =>
    decode(rawArgs === undefined ? {} : rawArgs, "args");
  const validateArgs = Object.values(shape).every(scalarOutput)
    ? (rawArgs: unknown) => Object.freeze(check(rawArgs)) as Expand<InferShape<A>>
    : (rawArgs: unknown) => deepFreeze(check(rawArgs));
  return Object.freeze({ validateArgs, enforceAccess });
}

/** Compile static validation and policy work once when a function is registered. */
export function compileInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
  decoder?: InvocationArgsDecoder<Expand<InferShape<A>>>,
): void {
  compiledInvocations.set(
    definition,
    buildInvocation(definition, decoder) as CompiledInvocation<InvocationContext, unknown>,
  );
}

function compiledInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
): CompiledInvocation<Ctx, Expand<InferShape<A>>> {
  let compiled = compiledInvocations.get(definition) as
    | CompiledInvocation<Ctx, Expand<InferShape<A>>>
    | undefined;
  if (compiled === undefined) {
    compiled = buildInvocation(definition);
    compiledInvocations.set(
      definition,
      compiled as CompiledInvocation<InvocationContext, unknown>,
    );
  }
  return compiled;
}

function immutableContext<Ctx extends InvocationContext>(ctx: Ctx, principal: Principal): Ctx {
  if (Object.isFrozen(ctx)) {
    const auth = Object.getOwnPropertyDescriptor(ctx, "auth");
    if (auth !== undefined && "value" in auth && auth.value === principal) return ctx;
  }
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ctx);
  descriptors.auth = {
    value: principal,
    enumerable: true,
    configurable: false,
    writable: false,
  };
  return Object.freeze(Object.create(Object.getPrototypeOf(ctx), descriptors) as Ctx);
}

function validateContext<Ctx extends InvocationContext>(
  ctx: Ctx,
  parent: InvocationState | undefined,
): Ctx {
  if (parent !== undefined && ctx.auth !== parent.principal) {
    // Deliberately distinct from a policy denial's "access denied": tripping
    // this guard means runtime-owned work ran inside a foreign invocation's
    // async context (a framework or composition bug), not that a policy said
    // no — the message must point debugging at the right layer.
    throw new AckerDBError("unauthorized", "invocation context principal mismatch");
  }
  if (!isPrincipal(ctx.auth)) throw new AckerDBError("internal", "invalid invocation context");
  const principal = parent?.principal ?? ctx.auth;
  return immutableContext(ctx, principal);
}

/** Validate and freeze caller input, bind an immutable principal, then enforce access. */
export function authorizeInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
  ctx: Ctx,
  rawArgs: unknown,
): Promise<AuthorizedInvocation<Ctx, Expand<InferShape<A>>>> {
  try {
    const compiled = compiledInvocation(definition);
    const safeCtx = validateContext(ctx, currentInvocationState());
    const args = compiled.validateArgs(rawArgs);
    const access = compiled.enforceAccess(safeCtx, args);
    if (isPromiseLike(access)) {
      return Promise.resolve(access).then(() => Object.freeze({ ctx: safeCtx, args }));
    }
    return Promise.resolve(Object.freeze({ ctx: safeCtx, args }));
  } catch (error) {
    return Promise.reject(error);
  }
}

function safeOutcome(error: unknown): InvocationOutcome {
  try {
    return outcomeFromError(error).code;
  } catch {
    return "internal";
  }
}

function emitObservation(
  state: InvocationInstrumentationState,
  fn: AnyInvocable,
  phase: InvocationPhase,
  startedAt: number,
  outcome: InvocationOutcome,
): void {
  const durationMs = Math.max(0, performance.now() - startedAt);
  try {
    const result = invocationInstrumentation.exit(() => {
      if (state.scope.telemetryObserver !== undefined) {
        return state.scope.telemetryObserver(
          state as InvocationTelemetryContext,
          phase,
          durationMs,
          outcome,
        );
      }
      const observation: InvocationObservation = Object.freeze({
        fn,
        invocationId: state.invocationId!,
        ...(state.parentInvocationId === undefined
          ? {}
          : { parentInvocationId: state.parentInvocationId }),
        depth: state.depth,
        phase,
        durationMs,
        outcome,
      });
      return state.scope.observer!(observation);
    });
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
  } catch {
    // Instrumentation is diagnostic and must never affect application work.
  }
}

function observePhase<T>(
  state: InvocationInstrumentationState,
  fn: AnyInvocable,
  phase: InvocationPhase,
  work: () => T | Promise<T>,
): T | Promise<T> {
  if (
    state.scope.observer === undefined &&
    state.scope.telemetryObserver === undefined &&
    state.scope.runPhase === undefined
  ) return work();
  const run = (): T | Promise<T> => {
    const startedAt = performance.now();
    try {
      const value = work();
      if (isPromiseLike(value)) {
        return Promise.resolve(value).then(
          (settled) => {
            emitObservation(state, fn, phase, startedAt, "ok");
            return settled;
          },
          (error: unknown) => {
            emitObservation(state, fn, phase, startedAt, safeOutcome(error));
            throw error;
          },
        );
      }
      emitObservation(state, fn, phase, startedAt, "ok");
      return value;
    } catch (error) {
      emitObservation(state, fn, phase, startedAt, safeOutcome(error));
      throw error;
    }
  };
  const observed = (): T | Promise<T> => {
    const runPhase = state.scope.runPhase;
    if (runPhase === undefined) return run();
    return runPhase(Object.freeze({
      fn,
      invocationId: state.invocationId!,
      ...(state.parentInvocationId === undefined
        ? {}
        : { parentInvocationId: state.parentInvocationId }),
      depth: state.depth,
      phase,
    }), run);
  };
  return observed();
}

function runHandler<Ctx extends InvocationContext, Args, R>(
  fn: { readonly handler: (ctx: Ctx, args: Args) => R | Promise<R> },
  ctx: Ctx,
  args: Args,
  options: InvocationOptions<Ctx, Args> | undefined,
): R | Promise<R> {
  options?.onAuthorized?.(ctx, args);
  return fn.handler(ctx, args);
}

function normalizeFunctionResult<K extends string, T>(kind: K, value: T): T | OkResult<T> {
  if (kind !== "query" && kind !== "mutation" && kind !== "procedure") return value;
  return isResult(value) ? value : Ok(value);
}

function invocationStateFor(
  ctx: InvocationContext,
  parent: InvocationState | undefined,
  mutationAccess: MutationAccess | undefined,
): InvocationState {
  return parent ?? {
    principal: ctx.auth,
    root: {},
    ...(mutationAccess === undefined ? {} : { mutationAccess }),
  };
}

function markPoisoned(
  state: InvocationState | undefined,
  error: unknown,
  poisonTree: boolean,
): unknown {
  if (
    poisonTree &&
    state !== undefined &&
    !Object.hasOwn(state.root, "poison")
  ) {
    state.root.poison = error;
  }
  return error;
}

/** Mark the ambient registered invocation unrecoverable, then rethrow. */
export function poisonCurrentInvocation(error: unknown): never {
  throw markPoisoned(currentInvocationState(), error, true);
}

function finishInvocation<K extends string, A extends ObjectShape, Ctx extends InvocationContext, R, H, T>(
  fn: Invocable<K, A, Ctx, R, H>,
  value: T,
  state: InvocationState,
): T | OkResult<T> {
  if (Object.hasOwn(state.root, "poison")) throw state.root.poison;
  const normalized = normalizeFunctionResult(fn.kind, value);
  if (!isResult(normalized)) return normalized;
  if (normalized.ok) {
    return fn.returns === undefined
      ? normalized
      : Ok(fn.returns.check(normalized.data, "returns")) as T | OkResult<T>;
  }
  if (!isApplicationError(normalized.error)) {
    throw new AckerDBError("validation", "registered Err must contain an application error");
  }
  if (fn.errors === undefined) return normalized as T | OkResult<T>;
  if (!Object.hasOwn(fn.errors, normalized.error.code)) {
    throw new AckerDBError(
      "validation",
      `errors does not declare returned code "${normalized.error.code}"`,
    );
  }
  const declaration = fn.errors[normalized.error.code];
  if (declaration === undefined) {
    throw new AckerDBError(
      "validation",
      `errors does not declare returned code "${normalized.error.code}"`,
    );
  }
  if (declaration.status !== normalized.error.status) {
    throw new AckerDBError(
      "validation",
      `errors.${normalized.error.code}.status does not match the returned status`,
    );
  }
  return Err(
    normalized.error.code,
    declaration.body.check(normalized.error.body, `errors.${normalized.error.code}.body`),
    normalized.error.status,
  ) as T | OkResult<T>;
}

function runInvocation<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H,
  T,
>(
  fn: Invocable<K, A, Ctx, R, H>,
  work: (state: InvocationState) => T | Promise<T>,
  state: InvocationState,
  root: boolean,
): Promise<T | OkResult<T>> {
  const poisonTree =
    fn.kind === "query" || fn.kind === "mutation" || fn.kind === "procedure";
  const execute = (
    activeState: InvocationState,
  ): Promise<T | OkResult<T>> => {
    try {
      const result = withInvocationState(activeState, () => work(activeState));
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value) => finishInvocation(fn, value, activeState),
          (error) => {
            throw markPoisoned(activeState, error, poisonTree);
          },
        );
      }
      return Promise.resolve(finishInvocation(fn, result, activeState));
    } catch (error) {
      return Promise.reject(markPoisoned(activeState, error, poisonTree));
    }
  };
  const access = state.mutationAccess;
  if (fn.kind !== "mutation" || access === undefined || root) {
    return execute(state);
  }
  return access.scope.run(
    access,
    (nestedAccess) => execute({ ...state, mutationAccess: nestedAccess }),
    (error) => {
      throw markPoisoned(state, error, poisonTree);
    },
  );
}

function invokeUnobserved<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H,
>(
  fn: Invocable<K, A, Ctx, R, H>,
  ctx: Ctx,
  rawArgs: unknown,
  options: InvocationOptions<Ctx, Expand<InferShape<A>>> | undefined,
): Promise<InvokedFunctionResult<K, H>> {
  try {
    const compiled = compiledInvocation(fn);
    const parent = currentInvocationState();
    const safeCtx = validateContext(ctx, parent);
    const state = invocationStateFor(
      safeCtx,
      parent,
      options?.mutationAccess,
    );
    const args = compiled.validateArgs(rawArgs);
    const execute = (activeState: InvocationState) => {
      const access = compiled.enforceAccess(safeCtx, args);
      if (isPromiseLike(access)) {
        return Promise.resolve(access).then(() =>
          runHandler(fn, safeCtx, args, options));
      }
      return runHandler(fn, safeCtx, args, options);
    };
    return runInvocation(
      fn,
      execute,
      state,
      parent === undefined,
    ) as Promise<InvokedFunctionResult<K, H>>;
  } catch (error) {
    return Promise.reject(markPoisoned(
      currentInvocationState(),
      error,
      fn.kind === "query" || fn.kind === "mutation" || fn.kind === "procedure",
    ));
  }
}

type InvokedFunctionResult<K extends string, HandlerReturn> =
  K extends "query" | "mutation" | "procedure"
    ? FunctionResult<HandlerReturn>
    : Awaited<HandlerReturn>;

/** The only args → policy → handler path, shared by top-level and direct nested calls. */
export function invokeFunction<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H,
>(
  fn: Invocable<K, A, Ctx, R, H>,
  ctx: Ctx,
  rawArgs: unknown,
  options?: InvocationOptions<Ctx, Expand<InferShape<A>>>,
): Promise<InvokedFunctionResult<K, H>> {
  const instrumentation = invocationInstrumentation.getStore();
  if (instrumentation === undefined) {
    return invokeUnobserved(fn, ctx, rawArgs, options);
  }

  const state: InvocationInstrumentationState = {
    scope: instrumentation.scope,
    invocationId: ++instrumentation.scope.nextInvocationId,
    ...(instrumentation.invocationId === null
      ? {}
      : { parentInvocationId: instrumentation.invocationId }),
    depth: instrumentation.depth + 1,
    ...(instrumentation.invocationId === null ? {} : { parent: instrumentation }),
    fn: fn as unknown as AnyInvocable,
  };
  const observedFn = fn as unknown as AnyInvocable;
  return invocationInstrumentation.run(state, () => {
    try {
      const compiled = compiledInvocation(fn);
      const parent = currentInvocationState();
      let invocation!: InvocationState;
      let safeCtx!: Ctx;
      let args!: Expand<InferShape<A>>;
      const authenticate = observePhase(state, observedFn, "auth", () => {
        safeCtx = validateContext(ctx, parent);
        invocation = invocationStateFor(
          safeCtx,
          parent,
          options?.mutationAccess,
        );
        args = compiled.validateArgs(rawArgs);
      });
      const handle = (activeState: InvocationState): H | Promise<H> =>
        observePhase(state, observedFn, "handler", () =>
          runHandler(fn, safeCtx, args, options));
      const authorize = (activeState: InvocationState): H | Promise<H> => {
        const access = observePhase(state, observedFn, "policy", () =>
          compiled.enforceAccess(safeCtx, args));
        return isPromiseLike(access)
          ? Promise.resolve(access).then(() => handle(activeState))
          : handle(activeState);
      };
      const execute = (activeState: InvocationState) =>
        isPromiseLike(authenticate)
          ? Promise.resolve(authenticate).then(() => authorize(activeState))
          : authorize(activeState);
      return runInvocation(
        fn,
        execute,
        invocation,
        parent === undefined,
      ) as Promise<InvokedFunctionResult<K, H>>;
    } catch (error) {
      return Promise.reject(markPoisoned(
        currentInvocationState(),
        error,
        fn.kind === "query" || fn.kind === "mutation" || fn.kind === "procedure",
      ));
    }
  });
}

/**
 * Run one callback owned by an already-authorized persistent registration.
 *
 * Channels authorize once when membership starts. Their later lifecycle and
 * event callbacks still need a registered invocation frame so `ctx.tx`,
 * transaction poisoning, principal isolation, and telemetry keep the same
 * guarantees as procedures without re-running membership policy per message.
 */
export function invokeRegisteredHandler<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H,
  T,
>(
  fn: Invocable<K, A, Ctx, R, H>,
  ctx: Ctx,
  work: (ctx: Ctx) => T | Promise<T>,
): Promise<T | OkResult<T>> {
  const instrumentation = invocationInstrumentation.getStore();
  if (instrumentation === undefined) {
    try {
      const parent = currentInvocationState();
      const safeCtx = validateContext(ctx, parent);
      const state = invocationStateFor(safeCtx, parent, undefined);
      return runInvocation(
        fn,
        (activeState) =>
          withInvocationState(activeState, () => work(safeCtx)),
        state,
        parent === undefined,
      );
    } catch (error) {
      return Promise.reject(markPoisoned(currentInvocationState(), error, true));
    }
  }

  const state: InvocationInstrumentationState = {
    scope: instrumentation.scope,
    invocationId: ++instrumentation.scope.nextInvocationId,
    ...(instrumentation.invocationId === null
      ? {}
      : { parentInvocationId: instrumentation.invocationId }),
    depth: instrumentation.depth + 1,
    ...(instrumentation.invocationId === null ? {} : { parent: instrumentation }),
    fn: fn as unknown as AnyInvocable,
  };
  const observedFn = fn as unknown as AnyInvocable;
  return invocationInstrumentation.run(state, () => {
    try {
      const parent = currentInvocationState();
      const safeCtx = validateContext(ctx, parent);
      const invocation = invocationStateFor(safeCtx, parent, undefined);
      return runInvocation(
        fn,
        (activeState) =>
          observePhase(state, observedFn, "handler", () =>
            withInvocationState(activeState, () => work(safeCtx))
          ),
        invocation,
        parent === undefined,
      );
    } catch (error) {
      return Promise.reject(markPoisoned(currentInvocationState(), error, true));
    }
  });
}
