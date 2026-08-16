import type { MutationReceipt } from "@ackerdb/core";
import type { Principal } from "../../auth/credentials.ts";
import type { HttpParams } from "../../transport/routing/path.ts";
import type { AnyHttpHandler } from "../../transport/routing/route.ts";

export interface RuntimeExternalRequest {
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly principal: Principal;
  readonly signal?: AbortSignal;
  readonly fairnessKey?: string;
}

/**
 * The commit receipt an HTTP mutation answers with. It carries no
 * `mutationRequestId`: over HTTP the caller's own `Idempotency-Key` is that id,
 * and a mutation without one has no replay identity at all.
 */
export type HttpMutationReceipt = Omit<MutationReceipt, "mutationRequestId">;

export interface RuntimeHttpResponse {
  readonly body: string;
  readonly bytes: number;
  readonly status: number;
  /** Present for mutations; the transport spells it as response headers. */
  readonly receipt?: HttpMutationReceipt;
}

/** Constructs the HTTP response; return is the measured application handoff, not network delivery. */
export type RuntimeHttpResponder = (response: RuntimeHttpResponse) => Response;

/** One path-addressed HTTP call; every kind answers through the same responder. */
export interface RuntimeHttpRequest extends RuntimeExternalRequest {
  readonly respond: RuntimeHttpResponder;
}

/** A mutation call; the optional `Idempotency-Key` is its replay identity. */
export interface RuntimeHttpMutationRequest extends RuntimeHttpRequest {
  readonly idempotencyKey?: string;
}

/**
 * One application-owned raw route call. `request` is the buffered Request the
 * handler receives whole — no codec, no principal, no responder: the handler
 * authors its own Response. The method already chose the handler in the route
 * table, so what arrives here is the handler itself; `path` only names it in a
 * failure log and never reaches the wire.
 */
export interface RuntimeHttpRouteRequest {
  readonly handler: AnyHttpHandler;
  readonly path: string;
  readonly request: Request;
  /** The captures the listener decoded; a static route has none. */
  readonly params?: HttpParams;
  /** The listener's own sequence. */
  readonly id?: number;
  /** The buffered body size the listener admitted; 1 when bodiless. */
  readonly requestBytes?: number;
  readonly signal?: AbortSignal;
  readonly fairnessKey?: string;
}

export interface RuntimeSseRequest extends RuntimeExternalRequest {}

export interface RuntimeSseResponse {
  readonly stream: ReadableStream<Uint8Array>;
  readonly streamId: string;
}
