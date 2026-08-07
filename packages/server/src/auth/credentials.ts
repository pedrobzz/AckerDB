import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTPayload,
} from "jose";
import { parseCredential, type Credential, type Identity } from "@ackerdb/core";
import { AckerDBError, isAckerDBError } from "../shared/errors.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { isScopeGrant } from "./scopes.ts";
import {
  hasCredentialTokenPrefix,
  VAULT_CREDENTIAL_AUTHORITY,
} from "./credential-token.ts";

export interface AnonymousPrincipal {
  readonly kind: "anonymous";
}

export interface SystemPrincipal {
  readonly kind: "system";
}

interface ExternalPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
  readonly tokenId: string | null;
}

export interface ExternalAccount {
  readonly issuer: string;
  readonly subject: string;
}

/** Cryptographically verified user evidence before AckerDB assigns application identity. */
export interface VerifiedUserCredential extends ExternalPrincipal {
  readonly kind: "user";
}

export interface WorkloadPrincipal extends ExternalPrincipal {
  readonly kind: "workload";
}

export interface UserPrincipal extends ExternalPrincipal {
  readonly kind: "user";
  readonly identity: Identity;
  /**
   * The Identity's grant, already expanded against the known vocabulary: a
   * pattern set is resolved once, when the principal is built, so the
   * authorization funnel does a plain membership test per call.
   */
  readonly scopes: readonly string[];
}

export type VerifiedCredential = VerifiedUserCredential | WorkloadPrincipal;
export type AuthenticatedPrincipal = UserPrincipal | WorkloadPrincipal;
export type ClientPrincipal = AnonymousPrincipal | AuthenticatedPrincipal;
export type Principal =
  | AnonymousPrincipal
  | UserPrincipal
  | WorkloadPrincipal
  | SystemPrincipal;
export type IdentityResolver = (
  account: ExternalAccount,
  signal?: AbortSignal,
) => Promise<Identity>;
/**
 * Resolves the grant patterns an Identity holds. `account` is the verified
 * external account at credential verification, and null when the framework
 * re-derives an issuer's grant for the child-credential intersection. An
 * absent resolver means every external principal carries the empty grant.
 */
export type ScopeResolver = (
  identity: Identity,
  account: ExternalAccount | null,
) => readonly string[] | Promise<readonly string[]>;

export const ANONYMOUS_PRINCIPAL: AnonymousPrincipal = Object.freeze({ kind: "anonymous" });
export const SYSTEM_PRINCIPAL: SystemPrincipal = Object.freeze({ kind: "system" });

function isExternalPrincipal(value: unknown): value is ExternalPrincipal & { kind: "user" | "workload" } {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const principal = value as Partial<ExternalPrincipal> & { kind?: unknown };
  return (
    (principal.kind === "user" || principal.kind === "workload") &&
    typeof principal.issuer === "string" &&
    principal.issuer.length > 0 &&
    typeof principal.subject === "string" &&
    principal.subject.length > 0 &&
    typeof principal.expiresAt === "number" &&
    // Vault-issued credentials never expire: POSITIVE_INFINITY is the one
    // sanctioned non-finite expiry, revoked by invalidation instead of time.
    (Number.isFinite(principal.expiresAt) ||
      principal.expiresAt === Number.POSITIVE_INFINITY) &&
    typeof principal.claims === "object" &&
    principal.claims !== null &&
    (principal.tokenId === null || typeof principal.tokenId === "string")
  );
}

export function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const principal = value as Partial<Principal>;
  if (principal.kind === "anonymous" || principal.kind === "system") return !("identity" in value);
  if (!isExternalPrincipal(value)) return false;
  const identity = (value as { readonly identity?: unknown }).identity;
  return principal.kind === "workload"
    ? !("identity" in value)
    : typeof identity === "bigint" &&
      identity > 0n &&
      isScopeGrant((value as { readonly scopes?: unknown }).scopes);
}

export function isVerifiedCredential(value: unknown): value is VerifiedCredential {
  return isExternalPrincipal(value) && !("identity" in value);
}

export interface PrincipalInvalidation {
  readonly issuer: string;
  readonly subject?: string;
  readonly tokenId?: string;
}

export type RevocationBound =
  | { readonly kind: "token-expiration" }
  | { readonly kind: "invalidation"; readonly deadlineMs: number };

export interface CredentialVerifier {
  readonly revocationBound: RevocationBound;
  verify(credential: string): Promise<VerifiedCredential>;
  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void;
}

export type JwtAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";

export interface OidcProviderConfig {
  /** Exact issuer: matched byte-exactly against the token's `iss`, never normalized. */
  readonly issuer: string;
  readonly jwksUri: string | URL;
  /** Accepted `aud` values, or the explicit `"unchecked"` enforcement opt-out. */
  readonly audiences: readonly string[] | "unchecked";
  readonly algorithms: readonly JwtAlgorithm[];
  /** Required JOSE `typ` header value, or the explicit `"unchecked"` enforcement opt-out. */
  readonly tokenType: string;
  /**
   * Explicit declaration that this provider's plaintext HTTP URLs may cross a
   * private network (RFC 1918, link-local, IPv6 ULA/link-local). Loopback
   * plaintext needs no declaration; public plaintext is never accepted.
   */
  readonly allowPrivateNetworkHttp?: boolean;
  readonly principalKind: "user" | "workload";
  readonly requiredClaims?: readonly string[];
  /**
   * Claims copied to `ctx.auth.claims`, or the explicit `"none"`. Verified
   * claims outside the selection are discarded; like every other enforcement
   * dimension, discarding everything is a visible declaration, never a
   * silent default.
   */
  readonly claimNames: readonly string[] | "none";
  readonly maxTokenAgeSeconds?: number;
}

/**
 * Named provider presets: the product shape of a known identity provider,
 * resolved into exact configuration at construction. A preset never weakens
 * verification — it only fills in the fields whose values follow from the
 * provider's published token shape. `resolveOidcProvider` is exported so the
 * resolved exact configuration is always inspectable.
 */
export interface OidcProviderPreset {
  readonly preset: "clerk" | "auth0" | "workos" | "betterauth";
  /** Exact issuer — still matched byte-exactly, still whatever the provider mints. */
  readonly issuer: string;
  /** Required for `auth0` (its registered API audience); defaulted elsewhere. */
  readonly audiences?: readonly string[] | "unchecked";
  /** Required for `workos`: the AuthKit JWKS URL is per-client. */
  readonly clientId?: string;
  readonly tokenType?: string;
  readonly claimNames?: readonly string[] | "none";
  readonly principalKind?: "user" | "workload";
  readonly allowPrivateNetworkHttp?: boolean;
}

export type OidcProviderEntry = OidcProviderConfig | OidcProviderPreset;

const WORKOS_CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function withoutTrailingSlash(issuer: string): string {
  return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
}

/** Resolves a preset entry into the exact configuration it stands for; exact entries pass through. */
export function resolveOidcProvider(entry: OidcProviderEntry): OidcProviderConfig {
  if (!("preset" in entry)) return entry;
  const { preset, issuer } = entry;
  if (typeof issuer !== "string" || issuer.length === 0) {
    throw new TypeError(`the ${String(preset)} preset requires the exact issuer the provider mints`);
  }
  const shared = {
    issuer,
    audiences: entry.audiences ?? ("unchecked" as const),
    principalKind: entry.principalKind ?? ("user" as const),
    ...(entry.allowPrivateNetworkHttp === undefined
      ? {}
      : { allowPrivateNetworkHttp: entry.allowPrivateNetworkHttp }),
  };
  switch (preset) {
    case "clerk":
      return {
        ...shared,
        jwksUri: `${withoutTrailingSlash(issuer)}/.well-known/jwks.json`,
        algorithms: ["RS256"],
        tokenType: entry.tokenType ?? "JWT",
        claimNames: entry.claimNames ?? ["azp", "sid"],
      };
    case "auth0":
      if (entry.audiences === undefined) {
        throw new TypeError(
          "the auth0 preset requires audiences: Auth0 mints JWT access tokens only for a registered API audience",
        );
      }
      return {
        ...shared,
        audiences: entry.audiences,
        jwksUri: `${withoutTrailingSlash(issuer)}/.well-known/jwks.json`,
        algorithms: ["RS256"],
        tokenType: entry.tokenType ?? "JWT",
        claimNames: entry.claimNames ?? ["azp", "scope"],
      };
    case "workos":
      if (typeof entry.clientId !== "string" || !WORKOS_CLIENT_ID.test(entry.clientId)) {
        throw new TypeError("the workos preset requires clientId: the AuthKit JWKS URL is per-client");
      }
      return {
        ...shared,
        jwksUri: `https://api.workos.com/sso/jwks/${entry.clientId}`,
        algorithms: ["RS256"],
        tokenType: entry.tokenType ?? "unchecked",
        claimNames: entry.claimNames ?? ["sid", "org_id", "role"],
      };
    case "betterauth":
      return {
        ...shared,
        jwksUri: `${withoutTrailingSlash(issuer)}/api/auth/jwks`,
        algorithms: ["EdDSA"],
        tokenType: entry.tokenType ?? "unchecked",
        claimNames: entry.claimNames ?? ["email"],
      };
    default:
      throw new TypeError(`unknown oidc provider preset "${String(preset)}"`);
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface OidcVerifierOptions {
  readonly providers: readonly OidcProviderEntry[];
  readonly fetch?: Fetcher;
  readonly maxTokenBytes?: number;
  readonly jwksTimeoutMs?: number;
  readonly jwksMaxBytes?: number;
  readonly jwksCooldownMs?: number;
  readonly jwksCacheMaxAgeMs?: number;
  readonly maxJwksKeys?: number;
  readonly clockToleranceSeconds?: number;
}

interface CompiledProvider {
  readonly config: OidcProviderConfig;
  readonly keySet: ReturnType<typeof createRemoteJWKSet>;
  readonly verifyOptions: JWTVerifyOptions;
  readonly claimNames: readonly string[];
}

const MAX_PROVIDERS = 32;
const MAX_AUDIENCES = 32;
const MAX_ALGORITHMS = 8;
const MAX_CLAIM_NAMES = 64;
const DEFAULT_MAX_TOKEN_BYTES = 16 * 1024;
const DEFAULT_JWKS_TIMEOUT_MS = 5_000;
const DEFAULT_JWKS_MAX_BYTES = 1024 * 1024;
const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_MAX_JWKS_KEYS = 32;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  if (value > max) throw new TypeError(`${name} must not exceed ${max}`);
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number`);
  return value;
}

/**
 * Private plaintext boundary: plaintext HTTP is permitted on loopback hosts —
 * where it cannot cross a network at all — and, only under a provider's
 * explicit `allowPrivateNetworkHttp` declaration, on private-network IP
 * literals. Private ranges are attackable networks (Wi-Fi, corporate LAN,
 * VPN, cloud VPC): an on-path peer that rewrites a plaintext JWKS response
 * mints accepted tokens, so crossing them without TLS must be a visible,
 * reviewable configuration decision, never a default. Public hosts never
 * accept plaintext. Hostnames arrive in WHATWG-canonical form, so IPv4 is
 * dotted-quad and IPv6 is bracketed.
 */
function isLoopbackHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host === "::1";
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (host.includes(":")) {
    const firstGroup = host.split(":", 1)[0] ?? "";
    return /^f[cd]/.test(firstGroup) || /^fe[89ab]/.test(firstGroup);
  }
  return false;
}

function idpUrl(value: string | URL, name: string, allowPrivateNetworkHttp: boolean): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new TypeError(`${name} must not contain credentials or a fragment`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    if (isLoopbackHost(url.hostname)) return url;
    if (allowPrivateNetworkHttp && isPrivateNetworkHost(url.hostname)) return url;
  }
  throw new TypeError(
    `${name} must be an HTTPS URL, or plaintext HTTP on a loopback host` +
      ` (private-network hosts additionally require allowPrivateNetworkHttp)`,
  );
}

function boundedStrings<T extends string>(
  values: readonly T[] | undefined,
  name: string,
  max: number,
  required: boolean,
): readonly T[] {
  if (values === undefined) {
    if (required) throw new TypeError(`${name} must not be empty`);
    return Object.freeze([]) as readonly T[];
  }
  // Unvalidated configuration can hand any value here; a plain string would
  // iterate as characters and silently become a character-level allowlist.
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array of strings`);
  if ((required && values.length === 0) || values.length > max) {
    throw new TypeError(`${name} must contain ${required ? "1" : "0"} through ${max} values`);
  }
  const unique = new Set<T>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new TypeError(`${name} values must be non-empty strings of at most 256 characters`);
    }
    unique.add(value as T);
  }
  if (unique.size !== values.length) throw new TypeError(`${name} must not contain duplicates`);
  return Object.freeze([...values]);
}

function authUnavailable(cause: unknown): AckerDBError {
  return new AckerDBError("auth_unavailable", "credential verification is temporarily unavailable", {
    retryable: true,
    cause,
  });
}

/**
 * The rejection a `credentialVerifier` must throw for an invalid credential.
 * Anything else is treated as verifier unavailability and retried as
 * `auth_unavailable` instead of rejecting the credential.
 */
export function unauthenticated(cause?: unknown): AckerDBError {
  return new AckerDBError("unauthenticated", "invalid credential", { cause });
}

async function boundedJwksResponse(
  response: Response,
  maxBytes: number,
  maxKeys: number,
): Promise<Response> {
  if (response.status !== 200) return response;
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw authUnavailable(new Error("JWKS response exceeds its byte limit"));
  }
  if (response.body === null) throw authUnavailable(new Error("JWKS response has no body"));

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw authUnavailable(new Error("JWKS response exceeds its byte limit"));
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw authUnavailable(error);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("keys" in body) ||
    !Array.isArray(body.keys) ||
    body.keys.length > maxKeys
  ) {
    throw authUnavailable(new Error("JWKS response has an invalid or oversized key set"));
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function selectClaims(payload: JWTPayload, names: readonly string[]): Readonly<Record<string, unknown>> {
  const selected = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const value = payload[name];
    if (value !== undefined) selected[name] = value;
  }
  return deepFreeze(selected);
}

/** Parse one strict HTTP Authorization value into the shared transport credential. */
export function credentialFromAuthorization(value: string | null): Credential {
  if (value === null) return Object.freeze({ kind: "anonymous" });
  const match = /^Bearer ([^\s,]+)$/i.exec(value);
  if (!match) throw unauthenticated();
  try {
    return Object.freeze(parseCredential({ kind: "bearer", token: match[1]! }));
  } catch (error) {
    throw unauthenticated(error);
  }
}

/** Verify one raw bearer token into immutable external credential evidence. */
export async function verifyBearerCredential(
  rawBearerToken: string,
  verifier: CredentialVerifier | undefined,
  now: () => number = Date.now,
): Promise<VerifiedCredential> {
  // Vault credentials are Engine-backed authority: only the Runtime's composed
  // verifier may answer them, never a custom application verifier.
  if (
    hasCredentialTokenPrefix(rawBearerToken) &&
    (verifier as { [VAULT_CREDENTIAL_AUTHORITY]?: boolean } | undefined)
      ?.[VAULT_CREDENTIAL_AUTHORITY] !== true
  ) {
    throw unauthenticated();
  }
  let credential: Credential;
  try {
    credential = parseCredential({ kind: "bearer", token: rawBearerToken });
  } catch (error) {
    throw unauthenticated(error);
  }
  if (credential.kind !== "bearer") throw unauthenticated();
  if (verifier === undefined) throw unauthenticated();
  let candidate: VerifiedCredential;
  try {
    candidate = await verifier.verify(credential.token);
  } catch (error) {
    if (isAckerDBError(error)) throw error;
    throw authUnavailable(error);
  }
  if (!isVerifiedCredential(candidate)) {
    throw authUnavailable(new Error("credential verifier returned invalid credential evidence"));
  }
  const { kind, issuer, subject, claims, expiresAt, tokenId } = candidate;
  const verified: VerifiedCredential = Object.freeze({
    kind,
    issuer,
    subject,
    claims: deepFreeze(claims),
    expiresAt,
    tokenId,
  });
  const timestamp = now();
  if (!Number.isFinite(timestamp)) throw new RangeError("credential clock must return finite milliseconds");
  if (verified.expiresAt <= timestamp) throw unauthenticated();
  return verified;
}

/** Verify that a raw bearer token proves one configured external user account. */
export async function verifyUserBearerCredential(
  rawBearerToken: string,
  verifier: CredentialVerifier | undefined,
  now: () => number = Date.now,
): Promise<VerifiedUserCredential> {
  const verified = await verifyBearerCredential(rawBearerToken, verifier, now);
  if (verified.kind !== "user") throw unauthenticated();
  return verified;
}

const EMPTY_SCOPE_GRANT: readonly string[] = Object.freeze([]);

/**
 * One fail-closed credential path shared by WebSocket, HTTP, and SSE.
 *
 * `resolveScopes` is the Runtime's own resolver, which composes the
 * application's with the vault and expands the result against the vocabulary,
 * so what lands on the principal is always concrete scopes.
 */
export async function verifyClientCredential(
  credential: Credential,
  verifier: CredentialVerifier | undefined,
  resolveIdentity: IdentityResolver,
  now: () => number = Date.now,
  resolveScopes?: ScopeResolver,
): Promise<ClientPrincipal> {
  if (credential.kind === "anonymous") return ANONYMOUS_PRINCIPAL;
  const verified = await verifyBearerCredential(credential.token, verifier, now);
  if (verified.kind === "workload") {
    return Object.freeze({
      kind: "workload",
      issuer: verified.issuer,
      subject: verified.subject,
      claims: verified.claims,
      expiresAt: verified.expiresAt,
      tokenId: verified.tokenId,
    });
  }
  const account = Object.freeze({
    issuer: verified.issuer,
    subject: verified.subject,
  });
  let identity: Identity;
  try {
    identity = await resolveIdentity(account);
  } catch (error) {
    if (isAckerDBError(error)) throw error;
    throw authUnavailable(error);
  }
  if (typeof identity !== "bigint" || identity <= 0n) {
    throw authUnavailable(new Error("identity resolver returned an invalid Identity"));
  }
  let scopes: readonly string[] = EMPTY_SCOPE_GRANT;
  if (resolveScopes !== undefined) {
    let resolved: readonly string[];
    try {
      resolved = await resolveScopes(identity, account);
    } catch (error) {
      if (isAckerDBError(error)) throw error;
      throw authUnavailable(error);
    }
    if (!isScopeGrant(resolved)) {
      throw authUnavailable(new Error("scope resolver returned an invalid scope grant"));
    }
    scopes = Object.freeze([...resolved]);
  }
  const resolvedAt = now();
  if (!Number.isFinite(resolvedAt)) {
    throw new RangeError("credential clock must return finite milliseconds");
  }
  if (verified.expiresAt <= resolvedAt) throw unauthenticated();
  return Object.freeze({
    kind: "user",
    identity,
    scopes,
    issuer: verified.issuer,
    subject: verified.subject,
    claims: verified.claims,
    expiresAt: verified.expiresAt,
    tokenId: verified.tokenId,
  });
}

function invalidJoseCredential(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return (
    typeof code === "string" &&
    (code.startsWith("ERR_JWT_") ||
      code.startsWith("ERR_JWS_") ||
      code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
      code === "ERR_JOSE_NOT_SUPPORTED" ||
      code === "ERR_JWKS_NO_MATCHING_KEY")
  );
}

/** Compile an exact issuer registry. An unverified token can only select an existing entry. */
export function createOidcVerifier(options: OidcVerifierOptions): CredentialVerifier {
  if (options.providers.length === 0 || options.providers.length > MAX_PROVIDERS) {
    throw new TypeError(`providers must contain 1 through ${MAX_PROVIDERS} entries`);
  }

  const maxTokenBytes = positiveInteger(
    options.maxTokenBytes ?? DEFAULT_MAX_TOKEN_BYTES,
    "maxTokenBytes",
    DEFAULT_MAX_TOKEN_BYTES,
  );
  const jwksTimeoutMs = positiveInteger(
    options.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    "jwksTimeoutMs",
    DEFAULT_JWKS_TIMEOUT_MS,
  );
  const jwksMaxBytes = positiveInteger(
    options.jwksMaxBytes ?? DEFAULT_JWKS_MAX_BYTES,
    "jwksMaxBytes",
    DEFAULT_JWKS_MAX_BYTES,
  );
  const jwksCooldownMs = nonNegativeNumber(
    options.jwksCooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS,
    "jwksCooldownMs",
  );
  const jwksCacheMaxAgeMs = positiveInteger(
    options.jwksCacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
    "jwksCacheMaxAgeMs",
  );
  const maxJwksKeys = positiveInteger(
    options.maxJwksKeys ?? DEFAULT_MAX_JWKS_KEYS,
    "maxJwksKeys",
    DEFAULT_MAX_JWKS_KEYS,
  );
  const clockToleranceSeconds = nonNegativeNumber(
    options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
    "clockToleranceSeconds",
  );
  const fetcher: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const providers = new Map<string, CompiledProvider>();

  for (const entry of options.providers) {
    const raw = resolveOidcProvider(entry);
    // Exact issuer: validated as a well-formed URL, then stored and matched
    // byte-exactly as written — never normalized. The one correct value is
    // whatever the provider actually mints in `iss`.
    if (
      typeof raw.issuer !== "string" ||
      raw.issuer.length === 0 ||
      /[\u0000-\u0020\u007f]/.test(raw.issuer)
    ) {
      throw new TypeError(
        "provider issuer must be a non-empty string without whitespace or control characters",
      );
    }
    if (raw.allowPrivateNetworkHttp !== undefined && typeof raw.allowPrivateNetworkHttp !== "boolean") {
      throw new TypeError("provider allowPrivateNetworkHttp must be a boolean");
    }
    const allowPrivateNetworkHttp = raw.allowPrivateNetworkHttp === true;
    const issuerUrl = idpUrl(raw.issuer, "provider issuer", allowPrivateNetworkHttp);
    if (issuerUrl.search !== "") throw new TypeError("provider issuer must not contain a query");
    const issuer = raw.issuer;
    if (providers.has(issuer)) throw new TypeError(`duplicate provider issuer "${issuer}"`);
    const jwksUri = idpUrl(raw.jwksUri, "provider jwksUri", allowPrivateNetworkHttp);
    const audiences =
      raw.audiences === "unchecked"
        ? ("unchecked" as const)
        : boundedStrings(raw.audiences, "provider audiences", MAX_AUDIENCES, true);
    const algorithms = boundedStrings(raw.algorithms, "provider algorithms", MAX_ALGORITHMS, true);
    const allowedAlgorithms: ReadonlySet<string> = new Set<JwtAlgorithm>([
      "RS256",
      "PS256",
      "ES256",
      "EdDSA",
    ]);
    if (algorithms.some((algorithm) => !allowedAlgorithms.has(algorithm))) {
      throw new TypeError("provider algorithms contains an unsupported algorithm");
    }
    if (typeof raw.tokenType !== "string" || raw.tokenType.length === 0 || raw.tokenType.length > 128) {
      throw new TypeError("provider tokenType must be a non-empty string of at most 128 characters");
    }
    if (raw.principalKind !== "user" && raw.principalKind !== "workload") {
      throw new TypeError("provider principalKind must be user or workload");
    }
    const requiredClaims = boundedStrings(
      raw.requiredClaims,
      "provider requiredClaims",
      MAX_CLAIM_NAMES,
      false,
    );
    // Claim projection is a visible declaration like every other dimension:
    // either a non-empty selection or the explicit "none" — silently
    // discarding every verified claim by default was accidental complexity.
    if (raw.claimNames === undefined) {
      throw new TypeError('provider claimNames must be a list of selected claims or the explicit "none"');
    }
    const claimNames =
      raw.claimNames === "none"
        ? (Object.freeze([]) as readonly string[])
        : boundedStrings(raw.claimNames, "provider claimNames", MAX_CLAIM_NAMES, true);
    const maxTokenAgeSeconds =
      raw.maxTokenAgeSeconds === undefined
        ? undefined
        : positiveInteger(raw.maxTokenAgeSeconds, "provider maxTokenAgeSeconds");

    const keySet = createRemoteJWKSet(jwksUri, {
      timeoutDuration: jwksTimeoutMs,
      cooldownDuration: jwksCooldownMs,
      cacheMaxAge: jwksCacheMaxAgeMs,
      [customFetch]: async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url !== jwksUri.href) throw authUnavailable(new Error("unconfigured JWKS destination"));
        const response = await fetcher(url, { ...init, redirect: "manual" });
        return boundedJwksResponse(response, jwksMaxBytes, maxJwksKeys);
      },
    });
    const config = Object.freeze({ ...raw, issuer, audiences, algorithms, requiredClaims, claimNames });
    providers.set(issuer, {
      config,
      keySet,
      claimNames,
      verifyOptions: {
        issuer,
        algorithms: [...algorithms],
        requiredClaims: ["exp", "sub", ...requiredClaims],
        clockTolerance: clockToleranceSeconds,
        ...(audiences === "unchecked" ? {} : { audience: [...audiences] }),
        ...(raw.tokenType === "unchecked" ? {} : { typ: raw.tokenType }),
        ...(maxTokenAgeSeconds === undefined ? {} : { maxTokenAge: maxTokenAgeSeconds }),
      },
    });
  }

  return Object.freeze({
    revocationBound: Object.freeze({ kind: "token-expiration" as const }),
    subscribeInvalidation: (_listener: (invalidation: PrincipalInvalidation) => void) => () => {},
    verify: async (credential: string): Promise<VerifiedCredential> => {
      if (
        typeof credential !== "string" ||
        credential.length === 0 ||
        credential.length > maxTokenBytes ||
        new TextEncoder().encode(credential).byteLength > maxTokenBytes
      ) {
        throw unauthenticated();
      }

      let issuer: unknown;
      try {
        issuer = decodeJwt(credential).iss;
      } catch (error) {
        throw unauthenticated(error);
      }
      if (typeof issuer !== "string") throw unauthenticated();
      const provider = providers.get(issuer);
      if (provider === undefined) throw unauthenticated();

      try {
        const { payload } = await jwtVerify(credential, provider.keySet, provider.verifyOptions);
        if (typeof payload.sub !== "string" || payload.sub.length === 0 || typeof payload.exp !== "number") {
          throw unauthenticated();
        }
        if (payload.jti !== undefined && typeof payload.jti !== "string") throw unauthenticated();
        const maxAgeExpiry =
          provider.config.maxTokenAgeSeconds !== undefined && typeof payload.iat === "number"
            ? (payload.iat + provider.config.maxTokenAgeSeconds) * 1_000
            : Number.POSITIVE_INFINITY;
        return Object.freeze({
          kind: provider.config.principalKind,
          issuer: provider.config.issuer,
          subject: payload.sub,
          claims: selectClaims(payload, provider.claimNames),
          expiresAt: Math.min(payload.exp * 1_000, maxAgeExpiry),
          tokenId: typeof payload.jti === "string" ? payload.jti : null,
        });
      } catch (error) {
        if (isAckerDBError(error)) throw error;
        if (invalidJoseCredential(error)) throw unauthenticated(error);
        throw authUnavailable(error);
      }
    },
  });
}
