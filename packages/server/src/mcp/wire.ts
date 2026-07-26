import { AckerDBError } from "../shared/errors.ts";
import { outcomeFromError, outcomeHttpStatus } from "../runtime/outcome.ts";

type CorsHeaders = Readonly<Record<string, string>>;

interface McpBearerChallenge {
  readonly realm: string;
  readonly credentialPresented: boolean;
}

export function parseMcpJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AckerDBError("malformed", "malformed JSON request body", { cause });
  }
}

function mcpJson(
  value: unknown,
  cors: CorsHeaders,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function bearerHeaders(cors: CorsHeaders, challenge: string): Readonly<Record<string, string>> {
  const exposed = cors["access-control-expose-headers"];
  return {
    "www-authenticate": challenge,
    "access-control-expose-headers": exposed === undefined
      ? "www-authenticate"
      : `${exposed}, www-authenticate`,
  };
}

export function mcpErrorResponse(
  error: unknown,
  cors: CorsHeaders,
  bearer?: McpBearerChallenge,
): Response {
  const outcome = outcomeFromError(error);
  const code = outcome.code === "malformed"
    ? -32700
    : outcome.code === "validation"
      ? -32602
      : -32000;
  const status = outcomeHttpStatus(outcome);
  let headers: Readonly<Record<string, string>> = {};
  if (bearer !== undefined && status === 401) {
    headers = bearerHeaders(cors, `Bearer realm="${bearer.realm}"${
      bearer.credentialPresented ? ', error="invalid_token"' : ""
    }`);
  } else if (bearer !== undefined && status === 403) {
    headers = bearerHeaders(
      cors,
      `Bearer realm="${bearer.realm}", error="insufficient_scope"`,
    );
  }
  return mcpJson({
    jsonrpc: "2.0",
    error: { code, message: outcome.message },
    id: null,
  }, cors, status, headers);
}

export function mcpMethodNotAllowed(cors: CorsHeaders): Response {
  return mcpJson({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }, cors, 405, { allow: "POST" });
}

/** Generic HTTP-boundary rejection that never reflects the rejected value. */
export function mcpBoundaryRejected(
  status: 403 | 431,
  cors: CorsHeaders,
): Response {
  return mcpJson({
    jsonrpc: "2.0",
    error: { code: -32000, message: "MCP request rejected." },
    id: null,
  }, cors, status);
}

export function withMcpCors(response: Response, cors: CorsHeaders): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
