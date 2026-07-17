import { DbzzError } from "./errors.ts";

export const MCP_TOKEN_PREFIX = "dbzz_mcp.";
const PUBLIC_ID_LENGTH = 22;
const SECRET_LENGTH = 43;
const MCP_TOKEN = new RegExp(
  `^dbzz_mcp\\.([A-Za-z0-9_-]{${PUBLIC_ID_LENGTH}})\\.([A-Za-z0-9_-]{${SECRET_LENGTH}})$`,
);

export interface ParsedMcpToken {
  readonly id: string;
  readonly secret: string;
}

export function hasMcpTokenPrefix(value: string): boolean {
  return value.startsWith(MCP_TOKEN_PREFIX);
}

export function parseMcpToken(value: string): ParsedMcpToken | null {
  const match = MCP_TOKEN.exec(value);
  return match === null ? null : Object.freeze({ id: match[1]!, secret: match[2]! });
}

/** MCP HTTP accepts either no credential or one exact DBZZ MCP bearer. */
export function mcpCredentialFromAuthorization(value: string | null): string | null {
  if (value === null) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(value);
  if (match === null || parseMcpToken(match[1]!) === null) {
    throw new DbzzError("unauthenticated", "invalid MCP credential");
  }
  return match[1]!;
}
