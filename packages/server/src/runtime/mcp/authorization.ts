import type { AnyRegisteredMcpTool } from "../../mcp/index.ts";

const authorizedTool = Symbol("ackerdb.runtime.authorizedMcpTool");

/** Typed transport outcome for one exact MCP tool authorization decision. */
export type RuntimeMcpToolAuthorization =
  | {
      readonly ok: true;
      readonly [authorizedTool]: AnyRegisteredMcpTool;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
    };

export function mcpToolAuthorization(
  tool: AnyRegisteredMcpTool,
): RuntimeMcpToolAuthorization {
  return Object.freeze({ ok: true, [authorizedTool]: tool });
}

export function mcpToolAuthorizationFailure(error: unknown): RuntimeMcpToolAuthorization {
  return Object.freeze({ ok: false, error });
}

export function authorizedMcpTool(
  authorization: RuntimeMcpToolAuthorization,
): AnyRegisteredMcpTool {
  if (!authorization.ok) throw authorization.error;
  return authorization[authorizedTool];
}
