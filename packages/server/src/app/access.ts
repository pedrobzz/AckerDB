import type { Principal } from "../auth/credentials.ts";

export interface InvocationContext {
  readonly auth: Principal;
}

export type BuiltinAccessPolicy = "public" | "authenticated" | "system";

/**
 * Every invocable operation has exactly one policy. A callback must explicitly
 * return `true`; false, exceptions, and every other result fail closed.
 */
export type AccessPolicy<Ctx, Args> =
  | BuiltinAccessPolicy
  | ((ctx: Ctx, args: Args) => boolean | Promise<boolean>);

export function isAccessPolicy(
  value: unknown,
): value is AccessPolicy<InvocationContext, unknown> {
  return (
    value === "public" ||
    value === "authenticated" ||
    value === "system" ||
    typeof value === "function"
  );
}
