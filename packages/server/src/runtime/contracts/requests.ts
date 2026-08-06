import type { MutationReceipt } from "@ackerdb/core";
import type { Principal } from "../../auth/credentials.ts";
import type { RuntimeMcpToolAuthorization } from "../mcp/authorization.ts";

export interface RuntimeExternalRequest {
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly principal: Principal;
  readonly signal?: AbortSignal;
  readonly fairnessKey?: string;
}

export interface RuntimeMcpToolRequest {
  readonly id: string | number;
  readonly authorization: RuntimeMcpToolAuthorization;
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
 * One raw handler call. `request` is the buffered Request the handler
 * receives whole — no codec, no principal, no responder: the handler authors
 * its own Response. Also the direct test entry point, so everything but the
 * address and the Request defaults.
 */
export interface RuntimeHttpHandlerRequest {
  readonly address: string;
  readonly request: Request;
  /** The listener's own sequence; telemetry correlation only. */
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
