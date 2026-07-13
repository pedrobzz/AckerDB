import { AsyncLocalStorage } from "node:async_hooks";
import { isPrincipal, type Principal } from "./auth.ts";
import { checkShape, type Expand, type InferShape, type ObjectShape } from "./dbz.ts";
import { DbzzError } from "./errors.ts";
import type { AccessPolicy, Registered } from "./functions.ts";
import { deepFreeze } from "./immutable.ts";

export interface InvocationContext {
  readonly auth: Principal;
}

interface InvocationState {
  readonly principal: Principal;
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

/** Validate and freeze caller input, bind an immutable principal, then enforce access. */
export async function authorizeInvocation<A extends ObjectShape, Ctx extends InvocationContext>(
  definition: AuthorizationDefinition<A, Ctx>,
  ctx: Ctx,
  rawArgs: unknown,
): Promise<AuthorizedInvocation<Ctx, Expand<InferShape<A>>>> {
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
  const safeCtx = immutableContext(ctx, principal);
  await enforceAccess(definition.access, safeCtx, args);
  return Object.freeze({ ctx: safeCtx, args });
}

/** The only args → policy → handler path, shared by top-level and direct nested calls. */
export async function invokeFunction<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
>(
  fn: Registered<K, A, Ctx, R>,
  ctx: Ctx,
  rawArgs: unknown,
  options: InvocationOptions<Ctx, Expand<InferShape<A>>> = {},
): Promise<Awaited<R>> {
  const { ctx: safeCtx, args } = await authorizeInvocation(fn, ctx, rawArgs);
  options.onAuthorized?.(safeCtx, args);
  return invocationState.run(
    { principal: safeCtx.auth },
    async () => fn.handler(safeCtx, args),
  ) as Promise<Awaited<R>>;
}
