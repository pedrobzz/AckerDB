import type { Principal } from "../auth/credentials.ts";
import { v, type EnumValidator } from "../validation/v.ts";
import { DbzzError } from "../shared/errors.ts";

export const MAX_MCP_SCOPES = 128;
export const MAX_MCP_SCOPE_BYTES = 256;

export type McpScopeValues = readonly [string, ...string[]];
export type McpScopeDescriptor<Scope extends string = string> = EnumValidator<Scope>;

export type McpToolAccessPolicy<Scope extends string = never> =
  | "public"
  | "authenticated"
  | ([Scope] extends [never]
    ? never
    : { readonly anyOf: readonly [Scope, ...Scope[]] }
      | { readonly allOf: readonly [Scope, ...Scope[]] });

export type NormalizedMcpToolAccessPolicy =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "authenticated" }>
  | Readonly<{ kind: "anyOf"; scopes: readonly string[] }>
  | Readonly<{ kind: "allOf"; scopes: readonly string[] }>;

const utf8 = new TextEncoder();
const EMPTY_SCOPES: readonly string[] = Object.freeze([]);

function validScopeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    utf8.encode(value).byteLength <= MAX_MCP_SCOPE_BYTES
  );
}

export function isMcpScopeGrant(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MCP_SCOPES &&
    value.every(validScopeValue) &&
    new Set(value).size === value.length
  );
}

/** Build the one validator descriptor used by declaration types and every runtime scope check. */
export function createMcpScopeDescriptor(
  mcp: string,
  value: unknown,
): McpScopeDescriptor | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("MCP scopes must be a non-empty array");
  }
  if (value.length > MAX_MCP_SCOPES) {
    throw new TypeError(`MCP scopes must contain at most ${MAX_MCP_SCOPES} values`);
  }
  if (value.some((scope) => !validScopeValue(scope))) {
    throw new TypeError(
      `each MCP scope must be a non-empty string of at most ${MAX_MCP_SCOPE_BYTES} UTF-8 bytes`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError("MCP scopes must not contain duplicate values");
  }
  const values = Object.freeze([...value]) as unknown as McpScopeValues;
  const typeName = `McpScope_${mcp.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return Object.freeze(v.enum(typeName, values));
}

/** Validate a token grant completely, then return it in declaration order as an immutable set. */
export function normalizeMcpScopeGrant<Scope extends string>(
  descriptor: McpScopeDescriptor<Scope>,
  value: unknown,
  where: string,
): readonly Scope[] {
  if (!Array.isArray(value)) {
    throw new DbzzError("validation", `${where} must be an array`);
  }
  if (value.length > descriptor.values.length) {
    throw new DbzzError("validation", `${where} contains too many values`);
  }
  const requested = new Set<Scope>();
  for (const scope of value) {
    if (typeof scope !== "string" || !descriptor.values.includes(scope as Scope)) {
      throw new DbzzError("validation", `${where} contains undeclared scope ${JSON.stringify(scope)}`);
    }
    if (requested.has(scope as Scope)) {
      throw new DbzzError("validation", `${where} must not contain duplicate values`);
    }
    requested.add(scope as Scope);
  }
  return Object.freeze(descriptor.values.filter((scope) => requested.has(scope)));
}

export function normalizeMcpToolAccess(
  value: unknown,
  descriptor: McpScopeDescriptor | undefined,
  tool: string,
): NormalizedMcpToolAccessPolicy {
  if (value === undefined || value === "public") return Object.freeze({ kind: "public" });
  if (value === "authenticated") return Object.freeze({ kind: "authenticated" });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `MCP tool "${tool}" access must be public, authenticated, { anyOf }, or { allOf }`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`MCP tool "${tool}" access must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "anyOf" && keys[0] !== "allOf")) {
    throw new TypeError(`MCP tool "${tool}" access must contain exactly one of anyOf or allOf`);
  }
  if (descriptor === undefined) {
    throw new TypeError(`MCP tool "${tool}" cannot use scopes because its MCP declares none`);
  }
  const kind = keys[0];
  let scopes: readonly string[];
  try {
    scopes = normalizeMcpScopeGrant(
      descriptor,
      (value as Record<string, unknown>)[kind],
      `MCP tool "${tool}" ${kind}`,
    );
  } catch (error) {
    if (error instanceof DbzzError) throw new TypeError(error.message);
    throw error;
  }
  if (scopes.length === 0) {
    throw new TypeError(`MCP tool "${tool}" ${kind} must contain at least one scope`);
  }
  return Object.freeze({ kind, scopes }) as NormalizedMcpToolAccessPolicy;
}

/** Shared evaluator for invocation now and filtered discovery/local adapters later. */
export function isMcpToolAuthorized(
  policy: NormalizedMcpToolAccessPolicy,
  principal: Principal,
  explicitGrant?: readonly string[],
): boolean {
  if (policy.kind === "public") return true;
  if (principal.kind === "anonymous") return false;
  if (policy.kind === "authenticated") return true;
  const grant = explicitGrant ?? (principal.kind === "mcp" ? principal.scopes : EMPTY_SCOPES);
  return policy.kind === "anyOf"
    ? policy.scopes.some((scope) => grant.includes(scope))
    : policy.scopes.every((scope) => grant.includes(scope));
}
