/**
 * The canonical HTTP surface: the paths AckerDB's listener owns, the methods
 * each exposed kind answers, and the headers a call carries beside its body.
 *
 * Everything AckerDB owns under `/api/` lives behind the `_` prefix, so an
 * application owns every other path there and a future built-in route can
 * never collide with an existing application module.
 *
 * The listener and the OpenAPI document both read this module, so a documented
 * method or header cannot drift from the one the surface actually serves.
 */
import type { SseAckRequest, SseMessage } from "@ackerdb/core";

export const ACKERDB_HTTP_ROUTES = Object.freeze({
  live: "/live",
  ready: "/ready",
  status: "/status",
  websocket: "/ws",
  sseAck: "/api/_sse/ack",
  realtime: "/api/_realtime",
  realtimePrepare: "/api/_realtime/prepare",
  /** Served only when the serve options ask for it; a 404 otherwise. */
  openapi: "/api/_openapi.json",
} as const);

/** The reserved prefix for every AckerDB-owned route under `/api/`. */
export const ACKERDB_RESERVED_API_PREFIX = "/api/_";

/** One live peer session: `/api/_realtime/<sessionId>`. */
export const REALTIME_SESSION_PREFIX = `${ACKERDB_HTTP_ROUTES.realtime}/`;

const builtinPaths = new Set<string>(Object.values(ACKERDB_HTTP_ROUTES));

export function isAckerDBHttpRoute(path: string): boolean {
  return builtinPaths.has(path) || path.startsWith(ACKERDB_RESERVED_API_PREFIX);
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
