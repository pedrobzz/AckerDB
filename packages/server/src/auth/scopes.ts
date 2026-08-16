/**
 * Scopes: the one authorization vocabulary, and it is the application's.
 *
 * An application declares its vocabulary once, in `defineApp({ scopes })`.
 * Every Identity carries a grant drawn from it, any function may declare a
 * requirement against it, and the single dispatch choke point (`compileAccess`
 * in `app/invocation.ts`) enforces that requirement.
 *
 * **One vocabulary, no framework half.** AckerDB declares no scopes of its own
 * and reserves no names inside this namespace, so `_` carries no meaning here:
 * `_internal:purge` is an ordinary scope an application may declare, `*` covers
 * every declared scope including that one, and `_*` is an ordinary prefix
 * pattern covering the ones beginning with `_`.
 *
 * **Grants carry wildcards; requirements stay concrete.** A wildcard is a
 * simple glob — `ad*` matches every declared scope starting with `ad`, and a
 * bare `*` matches all of them.
 *
 * **Checking is expansion, then membership.** A pattern set is expanded
 * against the declared vocabulary, then tested. It is the same operation at
 * issuance (a child's expansion must sit inside its parent's) and at use (the
 * requirement's scopes must sit inside the caller's expansion), which is what
 * keeps the subset ∩ intersection invariant of child credentials intact once
 * patterns enter the picture. Expanding against the *current* vocabulary is
 * also what lets a wildcard cover a scope that did not exist when the
 * credential was minted.
 */
import type { Principal } from "./credentials.ts";
import { AckerDBError } from "../shared/errors.ts";

export const MAX_APP_SCOPES = 128;
export const MAX_SCOPE_BYTES = 256;
/** A grant may name more patterns than the vocabulary has scopes; it stays bounded. */
export const MAX_SCOPE_PATTERNS = 128;

/** The trailing character that turns a concrete scope into a prefix match. */
export const SCOPE_WILDCARD = "*";

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

function boundedName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    utf8.encode(value).byteLength <= MAX_SCOPE_BYTES
  );
}

/** A concrete scope: a bounded name carrying no wildcard. */
export function isScopeValue(value: unknown): value is string {
  return boundedName(value) && !value.includes(SCOPE_WILDCARD);
}

/**
 * A grant entry: a concrete scope, or a prefix followed by exactly one
 * trailing `*`. The wildcard is a glob, not a pattern language — anywhere but
 * the last character it would be a syntax nobody asked for.
 */
export function isScopePattern(value: unknown): value is string {
  if (!boundedName(value)) return false;
  const wildcard = value.indexOf(SCOPE_WILDCARD);
  return wildcard === -1 || wildcard === value.length - 1;
}

/** True for a structurally valid grant: bounded, unique, non-empty patterns. */
export function isScopeGrant(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SCOPE_PATTERNS &&
    value.every(isScopePattern) &&
    new Set(value).size === value.length
  );
}

/**
 * Validate the application vocabulary declared in `defineApp({ scopes })`. The
 * wildcard is refused here, once, at the only declaration site: a vocabulary
 * entry that reads as a pattern would make "concrete scope" and "grant pattern"
 * the same string. Nothing else about a name is reserved — the vocabulary is
 * the application's alone.
 */
export function validateScopeVocabulary(value: unknown): ScopeValues {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("application scopes must be a non-empty array");
  }
  if (value.length > MAX_APP_SCOPES) {
    throw new TypeError(`application scopes must contain at most ${MAX_APP_SCOPES} values`);
  }
  for (const scope of value) {
    if (!boundedName(scope)) {
      throw new TypeError(
        `each application scope must be a non-empty string of at most ${MAX_SCOPE_BYTES} UTF-8 bytes`,
      );
    }
    if (scope.includes(SCOPE_WILDCARD)) {
      throw new TypeError(
        `application scope ${JSON.stringify(scope)} must not contain "${SCOPE_WILDCARD}"` +
          " — the wildcard belongs to grants, never to the vocabulary",
      );
    }
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError("application scopes must not contain duplicate values");
  }
  return Object.freeze([...value]) as unknown as ScopeValues;
}

function matchesPattern(pattern: string, scope: string): boolean {
  if (!pattern.endsWith(SCOPE_WILDCARD)) return pattern === scope;
  return scope.startsWith(pattern.slice(0, -1));
}

/**
 * Expand a grant's patterns against the declared vocabulary into the concrete
 * scopes it authorizes, in vocabulary order so two equivalent grants compare
 * and render identically. A pattern matching nothing contributes nothing:
 * authority is what a grant expands to, never what it says.
 */
export function expandScopeGrant(
  patterns: readonly string[],
  vocabulary: readonly string[],
): readonly string[] {
  if (patterns.length === 0 || vocabulary.length === 0) return EMPTY_SCOPES;
  const granted = vocabulary.filter((scope) =>
    patterns.some((pattern) => matchesPattern(pattern, scope)));
  return granted.length === 0 ? EMPTY_SCOPES : Object.freeze(granted);
}

/**
 * Structural validation of a declared `scopes` requirement on a function. A
 * requirement names concrete scopes: a wildcard there would ask the caller to
 * hold "something starting with", which no grant can answer unambiguously and
 * no reader can audit.
 */
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
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > MAX_APP_SCOPES ||
    !scopes.every(isScopeValue) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new TypeError(
      `${where}.${kind} must be a non-empty array of unique concrete scopes` +
        ` — "${SCOPE_WILDCARD}" belongs to grants, never to a requirement`,
    );
  }
  return Object.freeze({ kind, scopes: Object.freeze([...scopes]) }) as NormalizedScopeRequirement;
}

/**
 * Load-time cross-check: every scope a function requires must exist in the
 * known vocabulary. It runs where the App manifest and the Registry meet,
 * because registered functions are module-level constants that exist before
 * `defineApp` is evaluated.
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

/** The expanded grant a principal carries. Anonymous and system hold none. */
export function principalScopes(principal: Principal): readonly string[] {
  return principal.kind === "user" ? principal.scopes : EMPTY_SCOPES;
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
 * base access policy passes. System bypasses scopes: it is already the
 * framework's own unrestricted authority. Anonymous fails as unauthenticated —
 * a scope requirement implies an authenticated caller.
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
