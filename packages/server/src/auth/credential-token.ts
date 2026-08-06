/**
 * Opaque identity-credential tokens: the bearer form of an issued credential.
 *
 * A credential token authenticates a first-class Identity (standalone agent
 * or child of a user) on every transport. Its synthetic external account —
 * issuer `ackerdb:credentials`, subject = token id — is how revocations and
 * grant changes ride the one generic auth-invalidation path.
 */
import { AckerDBError } from "../shared/errors.ts";

/** The synthetic issuer every vault-issued credential authenticates under. */
export const CREDENTIAL_ISSUER = "ackerdb:credentials";

/**
 * Brand carried only by the Runtime's composed credential authority. A
 * vault-prefixed bearer must never reach an application verifier, so
 * verification fails closed unless the verifier declares this capability.
 */
export const VAULT_CREDENTIAL_AUTHORITY: unique symbol = Symbol.for(
  "@ackerdb/server/VaultCredentialAuthority/v1",
);

export const CREDENTIAL_TOKEN_PREFIX = "ackerdb_credential.";
const PUBLIC_ID_LENGTH = 22;
const SECRET_LENGTH = 43;
const CREDENTIAL_TOKEN = new RegExp(
  `^ackerdb_credential\\.([A-Za-z0-9_-]{${PUBLIC_ID_LENGTH}})\\.([A-Za-z0-9_-]{${SECRET_LENGTH}})$`,
);

export interface ParsedCredentialToken {
  readonly id: string;
  readonly secret: string;
  readonly bytes: number;
}

export function hasCredentialTokenPrefix(value: string): boolean {
  return value.startsWith(CREDENTIAL_TOKEN_PREFIX);
}

export function parseCredentialToken(value: string): ParsedCredentialToken | null {
  const match = CREDENTIAL_TOKEN.exec(value);
  return match === null
    ? null
    : Object.freeze({ id: match[1]!, secret: match[2]!, bytes: value.length });
}

/** MCP HTTP accepts either no credential or one exact parsed AckerDB credential bearer. */
export function credentialTokenFromAuthorization(
  value: string | null,
): ParsedCredentialToken | null {
  if (value === null) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(value);
  const parsed = match === null ? null : parseCredentialToken(match[1]!);
  if (parsed === null) {
    throw new AckerDBError("unauthenticated", "invalid credential");
  }
  return parsed;
}
