/**
 * Names and byte budgets shared by the MCP auth provider and the endpoint.
 *
 * Both declarations validate the same identifier shapes, and both publish
 * strings to clients, so the patterns and limits live in one place rather than
 * being restated on each side.
 */

export const MCP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MCP_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
export const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const MAX_MCP_PATH_BYTES = 256;
export const MAX_MCP_INSTRUCTIONS_BYTES = 16 * 1_024;
export const MAX_MCP_METADATA_BYTES = 4 * 1_024;
export const MAX_MCP_TOOL_NAME_BYTES = 63;
export const MAX_MCP_TOOL_TITLE_BYTES = 256;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 4 * 1_024;

const utf8 = new TextEncoder();

export function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

export function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${where} must be a non-empty string`);
  }
  return value;
}

/** The shared identifier rule for an MCP auth provider and an MCP endpoint. */
export function mcpName(value: unknown, where: string): string {
  if (typeof value !== "string" || !MCP_NAME.test(value)) {
    throw new TypeError(
      `${where} must start with a letter and contain at most 64 letters, digits, _ or -`,
    );
  }
  return value;
}
