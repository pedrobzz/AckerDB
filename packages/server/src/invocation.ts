import { AsyncLocalStorage } from "node:async_hooks";
import { isPrincipal, type Principal } from "./auth.ts";
import { checkShape, type Expand, type InferShape, type ObjectShape } from "./dbz.ts";
import { DbzzError } from "./errors.ts";
import type { AccessPolicy, Registered } from "./functions.ts";

export interface InvocationContext {
  readonly auth: Principal;
}

interface InvocationState {
  readonly principal: Principal;
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

/** The only args → policy → handler path, shared by top-level and direct nested calls. */
export async function invokeFunction<
  K extends string,
  A extends ObjectShape,
  Ctx extends InvocationContext,
  R,
>(fn: Registered<K, A, Ctx, R>, ctx: Ctx, rawArgs: unknown): Promise<Awaited<R>> {
  const parent = invocationState.getStore();
  if (parent !== undefined && ctx.auth !== parent.principal) {
    throw new DbzzError("unauthorized", "access denied");
  }
  if (!isPrincipal(ctx.auth)) throw new DbzzError("internal", "invalid invocation context");
  const principal = parent?.principal ?? ctx.auth;
  const args = checkShape(
    fn.args,
    rawArgs === undefined ? {} : rawArgs,
    "args",
  ) as Expand<InferShape<A>>;
  const safeCtx = immutableContext(ctx, principal);
  await enforceAccess(fn.access, safeCtx, args);
  return invocationState.run({ principal }, async () => fn.handler(safeCtx, args)) as Promise<Awaited<R>>;
}
