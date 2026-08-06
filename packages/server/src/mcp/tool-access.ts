/**
 * MCP tool-entry access: the general access shape, evaluated against the
 * caller's Identity scope grant. An entry's requirement draws from the one
 * application vocabulary — the same `ScopeRequirement` any function may
 * declare — and is cross-checked against it at load time.
 */
import type { Principal } from "../auth/credentials.ts";
import {
  isScopeAuthorized,
  normalizeScopeRequirement,
  principalScopes,
  type NormalizedScopeRequirement,
  type ScopeRequirement,
} from "../auth/access-policy.ts";

export type McpToolAccessPolicy<Scope extends string = never> =
  | "public"
  | "authenticated"
  | ([Scope] extends [never] ? never : ScopeRequirement<Scope>);

export type NormalizedMcpToolAccessPolicy =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "authenticated" }>
  | NormalizedScopeRequirement;

const PUBLIC: NormalizedMcpToolAccessPolicy = Object.freeze({ kind: "public" });
const AUTHENTICATED: NormalizedMcpToolAccessPolicy = Object.freeze({ kind: "authenticated" });

export function normalizeMcpToolAccess(
  value: unknown,
  tool: string,
): NormalizedMcpToolAccessPolicy {
  if (value === undefined || value === "public") return PUBLIC;
  if (value === "authenticated") return AUTHENTICATED;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `MCP tool "${tool}" access must be public, authenticated, { anyOf }, or { allOf }`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`MCP tool "${tool}" access must be a plain object`);
  }
  return normalizeScopeRequirement(value, `MCP tool "${tool}" access`);
}

/** Shared evaluator for invocation, filtered discovery, and local delegation. */
export function isMcpToolAuthorized(
  policy: NormalizedMcpToolAccessPolicy,
  principal: Principal,
  explicitGrant?: readonly string[],
): boolean {
  if (policy.kind === "public") return true;
  if (principal.kind === "anonymous") return false;
  if (policy.kind === "authenticated") return true;
  // A tool entry is a curation surface: even system authority passes a
  // scoped entry only through an explicit grant, unlike function-level
  // scope requirements, which system bypasses at the choke point.
  return isScopeAuthorized(policy, explicitGrant ?? principalScopes(principal));
}
