/**
 * The canonical HTTP surface: the paths AckerDB's listener owns, the methods
 * each exposed kind answers, and the headers a call carries beside its body.
 *
 * The framework's own routes live at the root behind the `_` marker, which no
 * `apiPath` may begin with. `/api/` is one function group among however many an
 * application names, so a protocol endpoint nested under it would be squatting
 * in that group's namespace; at the root, `_` belongs to AckerDB and every
 * other path belongs to the application.
 *
 * The operational endpoints are the deliberate exception. `/live`, `/ready`,
 * and `/status` carry no marker because they are the contract with the outside
 * world — Kubernetes probes, load-balancer health checks — and their names live
 * in configuration that is not ours to rename. The reserved-name list below is
 * what stops an application route from hijacking them.
 *
 * The listener and the OpenAPI document both read this module, so a documented
 * method or header cannot drift from the one the surface actually serves.
 */
import { RESERVED_MARKER, type SseAckRequest, type SseMessage } from "@ackerdb/core";

export const ACKERDB_HTTP_ROUTES = Object.freeze({
  live: "/live",
  ready: "/ready",
  status: "/status",
  websocket: "/_ws",
  sseAck: "/_sse/ack",
  /** The root of the File byte routes; the segments after it name one grant. */
  files: "/_files",
  /** Served only when the serve options ask for it; a 404 otherwise. */
  openapi: "/_openapi.json",
} as const);

/** The reserved root: every AckerDB-owned route lives behind it. */
const ACKERDB_RESERVED_ROOT = `/${RESERVED_MARKER}`;

const builtinPaths = new Set<string>(Object.values(ACKERDB_HTTP_ROUTES));

export function isAckerDBHttpRoute(path: string): boolean {
  return builtinPaths.has(path) || path.startsWith(ACKERDB_RESERVED_ROOT);
}

/**
 * Whether a path an application wants to claim reaches into a name marked as
 * the framework's own. `_` is AckerDB's at the root, where the protocol
 * endpoints live, and directly under a group, so a future built-in route can
 * never collide with an application's. Segments deeper than that are the
 * application's own business.
 *
 * One predicate for every claiming site, so the reservation cannot hold on one
 * surface and lapse on another.
 */
export function claimsReservedName(path: string): boolean {
  return path
    .split("/")
    .slice(1, 3)
    .some((segment) => segment.startsWith(RESERVED_MARKER));
}

/** Every registered kind the exposed surface serves, narrowed from an erased kind. */
export type ExposedHttpKind = "query" | "mutation" | "procedure" | "sse";

export function exposedHttpKind(kind: string): ExposedHttpKind | undefined {
  switch (kind) {
    case "query":
    case "mutation":
    case "procedure":
    case "sse":
      return kind;
    default:
      return undefined;
  }
}

/**
 * Methods each served kind answers, and the `Allow` header a wrong method
 * receives. GET exists for queries alone: it is the cacheable, curl-able read;
 * an SSE `EventSource` variant cannot carry `Authorization`, so it has none.
 */
export const EXPOSED_HTTP_METHODS: Readonly<Record<ExposedHttpKind, readonly string[]>> =
  Object.freeze({
    query: ["GET", "POST"],
    mutation: ["POST"],
    procedure: ["POST"],
    sse: ["POST"],
  });

/** A mutation's optional replay key. HTTP header names match case-insensitively. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** The mutation receipt, spelled as response headers so the body stays the value. */
export const RECEIPT_HEADERS = Object.freeze({
  commitVersion: "x-ackerdb-commit-version",
  durability: "x-ackerdb-durability",
  replay: "x-ackerdb-replay",
  obligations: "x-ackerdb-obligations",
} as const);

/** What an SSE response tells its receiver about the stream it opened. */
export const SSE_STREAM_HEADERS = Object.freeze({
  stream: "x-ackerdb-sse-stream",
  maxStallMs: "x-ackerdb-sse-max-stall-ms",
} as const);

/**
 * The frame vocabulary an SSE response speaks. An event's `data` is one of
 * these envelopes — never a bare chunk — and the receiver buys the next frame
 * by posting an `ack` to {@link ACKERDB_HTTP_ROUTES.sseAck}. Each tag is typed
 * against the frames `@ackerdb/core` parses, so a renamed frame fails this
 * build instead of a generated client.
 */
export const SSE_FRAME_TYPES = Object.freeze({
  chunk: "sse_chunk",
  done: "sse_done",
  error: "sse_error",
  ack: "sse_ack",
} as const) satisfies Readonly<Record<string, SseMessage["t"] | SseAckRequest["t"]>>;
