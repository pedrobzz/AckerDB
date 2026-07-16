import { AsyncLocalStorage } from "node:async_hooks";
import type { Outcome } from "@dbzz/core";
import { isPrincipal, type Principal } from "./auth.ts";
import { checkShape, type Expand, type InferShape, type ObjectShape } from "./dbz.ts";
import { DbzzError } from "./errors.ts";
import type { AccessPolicy, AnyRegistered, Registered } from "./functions.ts";
import { deepFreeze } from "./immutable.ts";
import { outcomeFromError } from "./outcome.ts";

export interface InvocationContext {
  readonly auth: Principal;
}

interface InvocationState {
  readonly principal: Principal;
}

export type InvocationPhase = "auth" | "policy" | "handler";
export type InvocationOutcome = "ok" | Outcome["code"];

export interface InvocationObservation {
  readonly fn: AnyRegistered;
  readonly invocationId: number;
  readonly parentInvocationId?: number;
  readonly depth: number;
  readonly phase: InvocationPhase;
  readonly durationMs: number;
  readonly outcome: InvocationOutcome;
}

export type InvocationObserver = (observation: InvocationObservation) => unknown;

export interface InvocationPhaseScope {
  readonly fn: AnyRegistered;
  readonly invocationId: number;
  readonly parentInvocationId?: number;
  readonly depth: number;
  readonly phase: InvocationPhase;
}

export interface InvocationPhaseRunner {
  <T>(scope: Readonly<InvocationPhaseScope>, work: () => T): T;
}

interface InvocationInstrumentationScope {
  readonly observer: InvocationObserver;
  readonly runPhase?: InvocationPhaseRunner;
  nextInvocationId: number;
}

interface InvocationInstrumentationState {
  readonly scope: InvocationInstrumentationScope;
  readonly invocationId: number | null;
  readonly parentInvocationId?: number;
  readonly depth: number;
}

export interface InvocationOptions<Ctx, Args> {
  /** Runs after args and access pass, immediately before the handler starts. */
  readonly onAuthorized?: (ctx: Ctx, args: Args) => void;
}

export interface AuthorizationDefinition<A extends ObjectShape, Ctx extends InvocationContext> {
  readonly args: A;
  readonly access: AccessPolicy<Ctx, Expand<InferShape<A>>>;
}

export interface AuthorizedInvocation<Ctx, Args> {
  readonly ctx: Ctx;
  readonly args: Args;
}

const invocationState = new AsyncLocalStorage<InvocationState>();
const invocationInstrumentation = new AsyncLocalStorage<InvocationInstrumentationState>();

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

function denied(principal: Principal, cause?: unknown): DbzzError {
  return principal.kind === "anonymous"
    ? new DbzzError("unauthenticated", "authentication required", { cause })
    : new DbzzError("unauthorized", "access denied", { cause });
}

async function enforceAccess<Ctx extends InvocationContext, Args>(
  access: AccessPolicy<Ctx, Args>,
  ctx: Ctx,
  args: Args,
): Promise<void> {
  if (access === "public") return;
  if (access === "authenticated") {
    if (ctx.auth.kind === "anonymous") throw denied(ctx.auth);
    return;
  }
  if (access === "system") {
    if (ctx.auth.kind !== "system") throw denied(ctx.auth);
    return;
  }
  let allowed: boolean;
  try {
    allowed = (await access(ctx, args)) === true;
  } catch (error) {
    throw new DbzzError("unauthorized", "access denied", { cause: error });
  }
  if (!allowed) throw denied(ctx.auth);
}

function immutableContext<Ctx extends InvocationContext>(ctx: Ctx, principal: Principal): Ctx {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ctx);
  descriptors.auth = {
    value: principal,
    enumerable: true,
    configurable: false,
    writable: false,
  };
  return Object.freeze(Object.create(Object.getPrototypeOf(ctx), descriptors) as Ctx);
}

function validateInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
  ctx: Ctx,
  rawArgs: unknown,
): AuthorizedInvocation<Ctx, Expand<InferShape<A>>> {
  const parent = invocationState.getStore();
  if (parent !== undefined && ctx.auth !== parent.principal) {
    throw new DbzzError("unauthorized", "access denied");
  }
  if (!isPrincipal(ctx.auth)) throw new DbzzError("internal", "invalid invocation context");
  const principal = parent?.principal ?? ctx.auth;
  const args = deepFreeze(checkShape(
    definition.args,
    rawArgs === undefined ? {} : rawArgs,
    "args",
  )) as Expand<InferShape<A>>;
  return Object.freeze({ ctx: immutableContext(ctx, principal), args });
}

/** Validate and freeze caller input, bind an immutable principal, then enforce access. */
export async function authorizeInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
  ctx: Ctx,
  rawArgs: unknown,
): Promise<AuthorizedInvocation<Ctx, Expand<InferShape<A>>>> {
  const invocation = validateInvocation(definition, ctx, rawArgs);
  await enforceAccess(definition.access, invocation.ctx, invocation.args);
  return invocation;
}

function safeOutcome(error: unknown): InvocationOutcome {
  try {
    return outcomeFromError(error).code;
  } catch {
    return "internal";
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function emitObservation(
  state: InvocationInstrumentationState,
  fn: AnyRegistered,
  phase: InvocationPhase,
  startedAt: number,
  outcome: InvocationOutcome,
): void {
  const observation: InvocationObservation = Object.freeze({
    fn,
    invocationId: state.invocationId!,
    ...(state.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: state.parentInvocationId }),
    depth: state.depth,
    phase,
    durationMs: Math.max(0, performance.now() - startedAt),
    outcome,
  });
  try {
    const result = invocationInstrumentation.exit(() => state.scope.observer(observation));
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
  } catch {
    // Instrumentation is diagnostic and must never affect application work.
  }
}

async function observePhase<T>(
  state: InvocationInstrumentationState,
  fn: AnyRegistered,
  phase: InvocationPhase,
  work: () => T | Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const startedAt = performance.now();
    try {
      const value = await work();
      emitObservation(state, fn, phase, startedAt, "ok");
      return value;
    } catch (error) {
      emitObservation(state, fn, phase, startedAt, safeOutcome(error));
      throw error;
    }
  };
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
}

function runHandler<Ctx extends InvocationContext, Args, R>(
  fn: { readonly handler: (ctx: Ctx, args: Args) => R | Promise<R> },
  ctx: Ctx,
  args: Args,
  options: InvocationOptions<Ctx, Args>,
): Promise<Awaited<R>> {
  options.onAuthorized?.(ctx, args);
  return invocationState.run(
    { principal: ctx.auth },
    async () => fn.handler(ctx, args),
  ) as Promise<Awaited<R>>;
}

/** The only args → policy → handler path, shared by top-level and direct nested calls. */
export async function invokeFunction<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
  H,
>(
  fn: Registered<K, A, Ctx, R, H>,
  ctx: Ctx,
  rawArgs: unknown,
  options: InvocationOptions<Ctx, Expand<InferShape<A>>> = {},
): Promise<Awaited<H>> {
  const instrumentation = invocationInstrumentation.getStore();
  if (instrumentation === undefined) {
    const { ctx: safeCtx, args } = await authorizeInvocation(fn, ctx, rawArgs);
    return runHandler(fn, safeCtx, args, options) as Promise<Awaited<H>>;
  }

  const state: InvocationInstrumentationState = {
    scope: instrumentation.scope,
    invocationId: ++instrumentation.scope.nextInvocationId,
    ...(instrumentation.invocationId === null
      ? {}
      : { parentInvocationId: instrumentation.invocationId }),
    depth: instrumentation.depth + 1,
  };
  const observedFn = fn as unknown as AnyRegistered;
  return invocationInstrumentation.run(state, async () => {
    const invocation = await observePhase(state, observedFn, "auth", () =>
      validateInvocation(fn, ctx, rawArgs));
    await observePhase(state, observedFn, "policy", () =>
      enforceAccess(fn.access, invocation.ctx, invocation.args));
    return observePhase(state, observedFn, "handler", () =>
      runHandler(fn, invocation.ctx, invocation.args, options));
  }) as Promise<Awaited<H>>;
}
