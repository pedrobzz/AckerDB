/**
 * Scopes: the one authorization vocabulary.
 *
 * An application declares its vocabulary once, in `defineApp({ scopes })`.
 * Every Identity carries a grant drawn from it, any function may declare a
 * requirement against it, and the single dispatch choke point (`compileAccess`
 * in `app/invocation.ts`) enforces that requirement.
 *
 * **Two vocabularies, one namespace, separated by the reserved marker.**
 * Application scopes carry no `_`; framework scopes are pre-declared under it
 * and an application may never declare one. That is why `*` and `_*` can mean
 * "every application scope" and "every framework scope" without either side
 * having to know what the other declared.
 *
 * **Grants carry wildcards; requirements stay concrete.** A wildcard is a
 * simple glob — `ad*` matches every known scope starting with `ad` — with one
 * carve-out: a bare `*` does not match scopes beginning with the reserved
 * marker. Every other pattern already excludes them, because a prefix that
 * does not start with `_` can never match a name that does.
 *
 * **Checking is expansion, then membership.** A pattern set is expanded
 * against the known vocabulary, then tested. It is the same operation at
 * issuance (a child's expansion must sit inside its parent's) and at use (the
 * requirement's scopes must sit inside the caller's expansion), which is what
 * keeps the subset ∩ intersection invariant of child credentials intact once
 * patterns enter the picture. Expanding against the *current* vocabulary is
 * also what lets a wildcard cover a domain that did not exist when the
 * credential was minted.
 *
 * There is no administrative flag. An administrative identity is one holding
 * `["*", "_*"]`, and creating another is creating another identity with those
 * two patterns.
 */
import { RESERVED_MARKER } from "@ackerdb/core";
import type { Principal } from "./credentials.ts";
import { AckerDBError } from "../shared/errors.ts";

export const MAX_APP_SCOPES = 128;
export const MAX_SCOPE_BYTES = 256;
/** A grant may name more patterns than the vocabulary has scopes; it stays bounded. */
export const MAX_SCOPE_PATTERNS = 128;

/** The trailing character that turns a concrete scope into a prefix match. */
export const SCOPE_WILDCARD = "*";

/**
 * The framework's own vocabulary, pre-declared under the reserved marker. It
 * is empty until the Admin API declares `_admin:<domain>:<verb>`; the concept
 * is load-bearing before then, because `_*` is what an administrative grant
 * names and it must keep meaning "every framework scope" as this list grows.
 */
export const FRAMEWORK_SCOPES: readonly string[] = Object.freeze([]);

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

export function isReservedScope(value: string): boolean {
  return value.startsWith(RESERVED_MARKER);
}

/**
 * Validate the application vocabulary declared in `defineApp({ scopes })`. The
 * reserved marker is refused here, once, at the only declaration site, and so
 * is the wildcard: a vocabulary entry that reads as a pattern would make
 * "concrete scope" and "grant pattern" the same string.
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
    if (isReservedScope(scope)) {
      throw new TypeError(
        `application scope ${JSON.stringify(scope)} begins with "${RESERVED_MARKER}",` +
          " which marks the framework's own vocabulary",
      );
    }
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError("application scopes must not contain duplicate values");
  }
  return Object.freeze([...value]) as unknown as ScopeValues;
}

/**
 * The vocabulary every grant expands against: the application's own plus the
 * framework's. One list, because a grant is checked against one namespace —
 * the marker is what keeps the halves apart inside it.
 */
export function knownScopeVocabulary(
  applicationScopes: readonly string[] | undefined,
): readonly string[] {
  if (applicationScopes === undefined || applicationScopes.length === 0) {
    return FRAMEWORK_SCOPES;
  }
  return Object.freeze([...applicationScopes, ...FRAMEWORK_SCOPES]);
}

function matchesPattern(pattern: string, scope: string): boolean {
  if (!pattern.endsWith(SCOPE_WILDCARD)) return pattern === scope;
  const prefix = pattern.slice(0, -1);
  // The one carve-out: a bare `*` is every application scope, never the
  // framework's. Any other prefix excludes them on its own — a prefix that
  // does not begin with the marker cannot match a name that does.
  if (prefix === "") return !isReservedScope(scope);
  return scope.startsWith(prefix);
}

/**
 * Expand a grant's patterns against the known vocabulary into the concrete
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
