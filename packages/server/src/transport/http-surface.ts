/**
 * The canonical HTTP surface: the paths AckerDB's listener owns, the methods
 * each exposed kind answers, and the headers a call carries beside its body.
 *
 * The framework's own routes live at the root behind the `_` marker. The
 * application's address-derived routes live beneath the fixed `/api/` root;
 * at the root, `_` belongs to AckerDB.
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
import {
  APPLICATION_ADDRESS_ROOT,
  httpPathForAddress,
  RESERVED_MARKER,
  type SseAckRequest,
  type SseMessage,
} from "@ackerdb/core";
import {
  httpExposure,
  type AnyRegistered,
} from "../app/functions.ts";
import type { HttpMethod } from "./routing/path.ts";
import { validateRoutePath } from "./routing/path.ts";

/** The root of the File byte routes; the segments below it name one handle. */
const FILES_ROOT = "/_files";

export const ACKERDB_HTTP_ROUTES = Object.freeze({
  live: "/live",
  ready: "/ready",
  status: "/status",
  websocket: "/_ws",
  sseAck: "/_sse/ack",
  files: FILES_ROOT,
  /** One Upload Session's bytes; the captured handle is `<id>.<secret>`. */
  fileUpload: `${FILES_ROOT}/uploads/:handle`,
  /** One File grant's bytes; the captured handle is `<id>.<secret>`. */
  fileDownload: `${FILES_ROOT}/grants/:handle`,
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
 * endpoints live, and directly under the fixed `/api/` root, so a future
 * built-in route can never collide with an exposed function's derived path.
 *
 * The second segment is reserved only beneath `/api/`. An explicit raw route
 * owns its URL because an external provider dictated it, and `/webhooks/_raw`
 * is that provider's name for a path AckerDB will never serve; reserving every
 * second segment everywhere would forbid it for nothing.
 *
 * One predicate for every claiming site, so the reservation cannot hold on one
 * surface and lapse on another.
 */
export function claimsReservedName(path: string): boolean {
  const [first, second] = path.split("/").slice(1);
  if (first?.startsWith(RESERVED_MARKER) === true) return true;
  return first === APPLICATION_ADDRESS_ROOT && second?.startsWith(RESERVED_MARKER) === true;
}

/** Refuse every path reserved to AckerDB before it reaches the live HTTP registry. */
export function validateApplicationHttpPath(path: string, where: string): string {
  const validated = validateRoutePath(path, where);
  if (isAckerDBHttpRoute(validated) || claimsReservedName(validated)) {
    throw new Error(
      `${where} claims AckerDB-owned path "${validated}": AckerDB owns its built-in ` +
        `paths and every name marked "${RESERVED_MARKER}"`,
    );
  }
  return validated;
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

/** The HTTP surface derived from one addressable function, before a listener compiles its codec. */
export interface ExposedFunction {
  readonly address: string;
  readonly path: string;
  readonly openapi: boolean;
  readonly kind: ExposedHttpKind;
  readonly fn: AnyRegistered;
}

/** Derive one function's optional plain-HTTP surface without retaining a second registry. */
export function exposedFunction(
  address: string,
  fn: AnyRegistered,
): ExposedFunction | null {
  const exposure = httpExposure(fn.http, `function "${address}" http`);
  if (exposure === null) return null;
  const kind = exposedHttpKind(fn.kind);
  if (kind === undefined) {
    throw new Error(
      `HTTP-exposed function "${address}" is a ${fn.kind}, which the HTTP surface does not serve`,
    );
  }
  const where = `HTTP-exposed function "${address}"`;
  return Object.freeze({
    address,
    path: validateApplicationHttpPath(httpPathForAddress(address), where),
    openapi: exposure.openapi,
    kind,
    fn,
  });
}

/**
 * Methods each served kind answers, and the `Allow` header a wrong method
 * receives. GET exists for queries alone: it is the cacheable, curl-able read;
 * an SSE `EventSource` variant cannot carry `Authorization`, so it has none.
 */
export const EXPOSED_HTTP_METHODS: Readonly<Record<ExposedHttpKind, readonly HttpMethod[]>> =
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
