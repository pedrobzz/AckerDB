import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTPayload,
} from "jose";
import { DbzzError } from "./errors.ts";

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

export interface UserPrincipal extends ExternalPrincipal {
  readonly kind: "user";
}

export interface WorkloadPrincipal extends ExternalPrincipal {
  readonly kind: "workload";
}

export type VerifiedPrincipal = UserPrincipal | WorkloadPrincipal;
export type Principal = AnonymousPrincipal | UserPrincipal | WorkloadPrincipal | SystemPrincipal;

export const ANONYMOUS_PRINCIPAL: AnonymousPrincipal = Object.freeze({ kind: "anonymous" });
export const SYSTEM_PRINCIPAL: SystemPrincipal = Object.freeze({ kind: "system" });

export function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const principal = value as Partial<Principal>;
  if (principal.kind === "anonymous" || principal.kind === "system") return true;
  return (
    (principal.kind === "user" || principal.kind === "workload") &&
    typeof principal.issuer === "string" &&
    principal.issuer.length > 0 &&
    typeof principal.subject === "string" &&
    principal.subject.length > 0 &&
    typeof principal.expiresAt === "number" &&
    Number.isFinite(principal.expiresAt) &&
    typeof principal.claims === "object" &&
    principal.claims !== null &&
    (principal.tokenId === null || typeof principal.tokenId === "string")
  );
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
  verify(credential: string): Promise<VerifiedPrincipal>;
  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void;
}

export type JwtAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";

export interface OidcProviderConfig {
  readonly issuer: string;
  readonly jwksUri: string | URL;
  readonly audiences: readonly string[];
  readonly algorithms: readonly JwtAlgorithm[];
  readonly tokenType: string;
  readonly principalKind: "user" | "workload";
  readonly requiredClaims?: readonly string[];
  readonly claimNames?: readonly string[];
  readonly maxTokenAgeSeconds?: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface OidcVerifierOptions {
  readonly providers: readonly OidcProviderConfig[];
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

function httpsUrl(value: string | URL, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new TypeError(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  return url;
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
  if ((required && values.length === 0) || values.length > max) {
    throw new TypeError(`${name} must contain ${required ? "1" : "0"} through ${max} values`);
  }
  const unique = new Set<T>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new TypeError(`${name} values must be non-empty strings of at most 256 characters`);
    }
    unique.add(value);
  }
  if (unique.size !== values.length) throw new TypeError(`${name} must not contain duplicates`);
  return Object.freeze([...values]);
}

function authUnavailable(cause: unknown): DbzzError {
  return new DbzzError("auth_unavailable", "credential verification is temporarily unavailable", {
    retryable: true,
    cause,
  });
}

function unauthenticated(cause?: unknown): DbzzError {
  return new DbzzError("unauthenticated", "invalid credential", { cause });
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const seen = new Set<object>();
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function selectClaims(payload: JWTPayload, names: readonly string[]): Readonly<Record<string, unknown>> {
  const selected = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const value = payload[name];
    if (value !== undefined) selected[name] = value;
  }
  return deepFreeze(selected);
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

  for (const raw of options.providers) {
    const issuerUrl = httpsUrl(raw.issuer, "provider issuer");
    if (issuerUrl.search !== "") throw new TypeError("provider issuer must not contain a query");
    const issuer = raw.issuer;
    if (issuerUrl.href !== issuer) {
      throw new TypeError("provider issuer must already be in its exact canonical URL form");
    }
    if (providers.has(issuer)) throw new TypeError(`duplicate provider issuer "${issuer}"`);
    const jwksUri = httpsUrl(raw.jwksUri, "provider jwksUri");
    const audiences = boundedStrings(raw.audiences, "provider audiences", MAX_AUDIENCES, true);
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
    const claimNames = boundedStrings(raw.claimNames, "provider claimNames", MAX_CLAIM_NAMES, false);
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
        audience: [...audiences],
        algorithms: [...algorithms],
        typ: raw.tokenType,
        requiredClaims: ["exp", "sub", ...requiredClaims],
        clockTolerance: clockToleranceSeconds,
        ...(maxTokenAgeSeconds === undefined ? {} : { maxTokenAge: maxTokenAgeSeconds }),
      },
    });
  }

  return Object.freeze({
    revocationBound: Object.freeze({ kind: "token-expiration" as const }),
    subscribeInvalidation: (_listener: (invalidation: PrincipalInvalidation) => void) => () => {},
    verify: async (credential: string): Promise<VerifiedPrincipal> => {
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
        if (error instanceof DbzzError) throw error;
        if (invalidJoseCredential(error)) throw unauthenticated(error);
        throw authUnavailable(error);
      }
    },
  });
}
