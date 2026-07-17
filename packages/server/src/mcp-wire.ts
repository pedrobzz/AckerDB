import { DbzzError } from "./errors.ts";
import { outcomeFromError, outcomeHttpStatus } from "./outcome.ts";

type CorsHeaders = Readonly<Record<string, string>>;

export function parseMcpJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new DbzzError("malformed", "malformed JSON request body", { cause });
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

export function mcpErrorResponse(error: unknown, cors: CorsHeaders): Response {
  const outcome = outcomeFromError(error);
  const code = outcome.code === "malformed"
    ? -32700
    : outcome.code === "validation"
      ? -32602
      : -32000;
  return mcpJson({
    jsonrpc: "2.0",
    error: { code, message: outcome.message },
    id: null,
  }, cors, outcomeHttpStatus(outcome));
}

export function mcpMethodNotAllowed(cors: CorsHeaders): Response {
  return mcpJson({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }, cors, 405, { allow: "POST" });
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
