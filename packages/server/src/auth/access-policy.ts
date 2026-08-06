/**
 * Scopes as a first-class Identity capability.
 *
 * One vocabulary, declared once in `defineApp({ scopes })`. Every principal
 * carries a grant (`readonly scopes: readonly string[]`, empty for anonymous).
 * Any function may declare a requirement (`{ anyOf }` / `{ allOf }`), and the
 * single dispatch choke point (`compileAccess` in app/invocation.ts) enforces
 * it. This module is the generalization of the MCP-local scope concept in
 * mcp/scopes.ts: the MCP module now imports its grant validation from here,
 * and its `McpToolAccessPolicy` is `"public" | "authenticated" |
 * ScopeRequirement<Scope>` — the same shape functions use.
 *
 * Reserved namespaces: `studio:*` (AckerDB Studio's own authority) and
 * `internal:*` (framework-internal authority) can never be declared by an
 * application vocabulary, so no user scope can ever collide with or
 * impersonate framework authority.
 *
 * Typed vocabulary (codegen sketch): `defineApp({ scopes: ["notes:read",
 * "notes:write"] as const })` gives `AppScope<typeof app> = "notes:read" |
 * "notes:write"`. Generated server modules instantiate the function builders
 * as `QueryBuilder<S, Caps, Jobs, AppScope<App>>`, so `scopes: { anyOf:
 * ["notes:raed"] }` is a compile error exactly like an undeclared MCP scope
 * is today.
 */
import type { Principal } from "./credentials.ts";
import { AckerDBError } from "../shared/errors.ts";

export const MAX_APP_SCOPES = 128;
export const MAX_SCOPE_BYTES = 256;

/** Namespaces the framework owns; an application vocabulary can never claim them. */
export const RESERVED_SCOPE_PREFIXES = Object.freeze(["studio:", "internal:"] as const);

export type ScopeValues = readonly [string, ...string[]];

/**
 * The one requirement shape any invocable may declare. `anyOf` passes when the
 * caller holds at least one of the scopes; `allOf` when it holds every one.
 */
export type ScopeRequirement<Scope extends string = string> =
  | { readonly anyOf: readonly [Scope, ...Scope[]] }
  | { readonly allOf: readonly [Scope, ...Scope[]] };

export type NormalizedScopeRequirement =
  | Readonly<{ kind: "anyOf"; scopes: readonly string[] }>
  | Readonly<{ kind: "allOf"; scopes: readonly string[] }>;

const utf8 = new TextEncoder();
const EMPTY_SCOPES: readonly string[] = Object.freeze([]);

export function isScopeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    utf8.encode(value).byteLength <= MAX_SCOPE_BYTES
  );
}

/** True for a structurally valid grant: bounded, unique, non-empty strings. */
export function isScopeGrant(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_APP_SCOPES &&
    value.every(isScopeValue) &&
    new Set(value).size === value.length
  );
}

export function isReservedScope(value: string): boolean {
  return RESERVED_SCOPE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Validate the application vocabulary declared in `defineApp({ scopes })`.
 * Reserved prefixes are rejected here, once, at the only declaration site.
 */
export function validateScopeVocabulary(value: unknown): ScopeValues {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("application scopes must be a non-empty array");
  }
  if (value.length > MAX_APP_SCOPES) {
    throw new TypeError(`application scopes must contain at most ${MAX_APP_SCOPES} values`);
  }
  for (const scope of value) {
    if (!isScopeValue(scope)) {
      throw new TypeError(
        `each application scope must be a non-empty string of at most ${MAX_SCOPE_BYTES} UTF-8 bytes`,
      );
    }
    if (isReservedScope(scope)) {
      throw new TypeError(
        `application scope ${JSON.stringify(scope)} uses a reserved namespace` +
          ` (${RESERVED_SCOPE_PREFIXES.join(", ")} are framework-owned)`,
      );
    }
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError("application scopes must not contain duplicate values");
  }
  return Object.freeze([...value]) as unknown as ScopeValues;
}

/** Structural validation of a declared `scopes` requirement on a function. */
export function normalizeScopeRequirement(
  value: unknown,
  where: string,
): NormalizedScopeRequirement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where} must be { anyOf: [...] } or { allOf: [...] }`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "anyOf" && keys[0] !== "allOf")) {
    throw new TypeError(`${where} must contain exactly one of anyOf or allOf`);
  }
  const kind = keys[0];
  const scopes = (value as Record<string, unknown>)[kind];
  if (!isScopeGrant(scopes) || scopes.length === 0) {
    throw new TypeError(`${where}.${kind} must be a non-empty array of unique scope strings`);
  }
  return Object.freeze({ kind, scopes: Object.freeze([...scopes]) }) as NormalizedScopeRequirement;
}

/**
 * Load-time cross-check: every scope a function requires must exist in the
 * application vocabulary. Runs where the App manifest and the Registry meet
 * (the CLI manifest loader), because registered functions are module-level
 * constants that exist before `defineApp` is evaluated.
 */
export function checkRequirementAgainstVocabulary(
  requirement: NormalizedScopeRequirement,
  vocabulary: readonly string[],
  where: string,
): void {
  for (const scope of requirement.scopes) {
    if (!vocabulary.includes(scope)) {
      throw new TypeError(`${where} requires undeclared scope ${JSON.stringify(scope)}`);
    }
  }
}

/** The grant a principal carries. Anonymous and system principals hold none. */
export function principalScopes(principal: Principal): readonly string[] {
  return principal.kind === "user" || principal.kind === "mcp"
    ? principal.scopes
    : EMPTY_SCOPES;
}

export function isScopeAuthorized(
  requirement: NormalizedScopeRequirement,
  grant: readonly string[],
): boolean {
  return requirement.kind === "anyOf"
    ? requirement.scopes.some((scope) => grant.includes(scope))
    : requirement.scopes.every((scope) => grant.includes(scope));
}

/**
 * The one runtime scope check, called from the dispatch choke point after the
 * base access policy passes. System bypasses scopes: `system` is already the
 * framework's own unrestricted authority. Anonymous fails as unauthenticated
 * — a scope requirement implies an authenticated caller.
 */
export function enforceScopeRequirement(
  requirement: NormalizedScopeRequirement,
  principal: Principal,
): void {
  if (principal.kind === "system") return;
  if (principal.kind === "anonymous") {
    throw new AckerDBError("unauthenticated", "authentication required");
  }
  if (!isScopeAuthorized(requirement, principalScopes(principal))) {
    throw new AckerDBError(
      "unauthorized",
      `access denied: caller lacks required scope (${requirement.kind}: ${requirement.scopes.join(", ")})`,
    );
  }
}
