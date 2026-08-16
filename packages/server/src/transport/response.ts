/**
 * Every Response this listener writes is built here, in exactly two body shapes.
 *
 * Connection-level routes — the WebSocket door, the SSE receiver credit, the
 * status document — answer a Protocol-2 `err` frame through the wire codec, so a
 * `bigint` survives. The exposed application surface (and the File routes that
 * ride on it) answers the bare `Outcome` in the standard JSON its documents
 * publish. A caller that decodes one surface never meets the other's shape.
 */
import {
  ACKERDB_VERSION,
  encode,
  type ErrorMessage,
  type Outcome,
} from "@ackerdb/core";
import { outcomeFromError, outcomeHttpStatus } from "../runtime/outcome.ts";
import type { HttpMutationReceipt, RuntimeHttpResponder } from "../runtime/contracts/requests.ts";
import { standardJsonText } from "../validation/standard-json.ts";
import { RECEIPT_HEADERS, SSE_STREAM_HEADERS } from "./http-surface.ts";

export const CORS = Object.freeze({
  "access-control-allow-origin": "*",
  // PATCH, PUT and DELETE are raw HTTP handler methods; the exposed function
  // surface serves only GET and POST.
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, content-disposition, authorization, idempotency-key, range, if-match, if-none-match, if-modified-since, if-unmodified-since, if-range",
  "access-control-expose-headers": [
    ...Object.values(SSE_STREAM_HEADERS),
    ...Object.values(RECEIPT_HEADERS),
    "accept-ranges",
    "content-disposition",
    "content-range",
    "digest",
    "etag",
    "last-modified",
  ].join(", "),
});

/**
 * One URL answers different bearer credentials with different rows, and the GET
 * query form is the cacheable one an operator is invited to put a CDN rule in
 * front of. Without this, such a rule serves one caller's rows to another.
 */
export const VARY_AUTHORIZATION = "authorization";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** A connection-level document, through the wire codec so `bigint` survives. */
export function json(value: unknown, status = 200): Response {
  return new Response(encode(value), {
    status,
    headers: { ...CORS, ...JSON_HEADERS },
  });
}

function frame(outcome: Outcome, status: number, headers: Record<string, string> = {}): Response {
  const message: ErrorMessage = { v: ACKERDB_VERSION, t: "err", id: null, outcome };
  return new Response(encode(message), {
    status,
    headers: { ...CORS, ...JSON_HEADERS, ...headers },
  });
}

/**
 * Protocol-2 routes answer with a frame. Every one of them is connection
 * level — health, status, the WebSocket upgrade, SSE receiver credit — so the
 * frame never names an operation.
 */
export function protocolError(error: unknown): Response {
  const outcome = outcomeFromError(error);
  return frame(outcome, outcomeHttpStatus(outcome));
}

export function outcomeResponse(
  outcome: Outcome,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(standardJsonText(outcome), {
    status,
    headers: { ...CORS, ...JSON_HEADERS, ...headers },
  });
}

/**
 * The exposed surface answers failures with the plain outcome, never a frame —
 * and in the standard JSON its document publishes, never the wire encoder the
 * connection-level routes above use.
 */
export function outcomeError(error: unknown): Response {
  const outcome = outcomeFromError(error);
  return outcomeResponse(outcome, outcomeHttpStatus(outcome));
}

/**
 * No outcome code names a wrong method — the status carries that — so this one
 * is built rather than mapped, and both body shapes carry the same words.
 */
function methodNotAllowedOutcome(allow: string): Outcome {
  return { code: "malformed", retryable: false, message: `method not allowed; allow: ${allow}` };
}

export function methodNotAllowed(allow: string, headers: Record<string, string> = {}): Response {
  return outcomeResponse(methodNotAllowedOutcome(allow), 405, { allow, ...headers });
}

/** The connection-level twin, for the routes that speak frames. */
export function frameMethodNotAllowed(allow: string): Response {
  return frame(methodNotAllowedOutcome(allow), 405, { allow });
}

/**
 * The mutation receipt rides response headers so the body stays the plain
 * return value. It is state at response time: a pending obligation's later
 * durability transition belongs to the WebSocket protocol, not to this caller.
 * The empty obligation list omits its header outright: RFC 9110 permits an
 * empty field value, so serializers may carry one, and a caller reading `""`
 * cannot tell it from a malformed list.
 */
function receiptHeaders(receipt: HttpMutationReceipt): Record<string, string> {
  return {
    [RECEIPT_HEADERS.commitVersion]: String(receipt.commitVersion),
    [RECEIPT_HEADERS.durability]: receipt.durability,
    [RECEIPT_HEADERS.replay]: String(receipt.replay === "replayed"),
    ...(receipt.obligations.length === 0
      ? {}
      : { [RECEIPT_HEADERS.obligations]: receipt.obligations.join(",") }),
  };
}

/**
 * Every path-addressed call hands its encoded value to the same response shape.
 * No `Cache-Control` is emitted: caching policy belongs to the operator.
 */
export const valueResponder: RuntimeHttpResponder = ({ body, status, receipt }) => new Response(body, {
  status,
  headers: {
    ...CORS,
    ...JSON_HEADERS,
    vary: VARY_AUTHORIZATION,
    ...(receipt === undefined ? {} : receiptHeaders(receipt)),
  },
});
