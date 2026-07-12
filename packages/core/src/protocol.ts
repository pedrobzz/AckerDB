/**
 * The client <-> server protocol. Every frame is one wire-encoded message
 * (see wire.ts). WebSocket carries subscriptions, one-shot queries and
 * mutations; HTTP carries procedures (`POST /api/call`) and SSE procedures
 * (`POST /api/sse`).
 */

export const PROTOCOL_VERSION = 1;

export type ClientMessage =
  /** Open a subscription (reactive query or event table). */
  | { t: "sub"; id: number; ref: string; args: unknown }
  | { t: "unsub"; id: number }
  /** One-shot query. */
  | { t: "q"; id: number; ref: string; args: unknown }
  /** Mutation; `mid` is the client-generated idempotency key. */
  | { t: "m"; id: number; ref: string; args: unknown; mid: string }
  | { t: "ping" };

export type ServerMessage =
  /** New result for a query subscription. */
  | { t: "update"; id: number; value: unknown }
  /** One row broadcast from an event-table subscription. */
  | { t: "event"; id: number; row: unknown }
  /** Successful one-shot query / mutation response. */
  | { t: "ok"; id: number; value: unknown }
  /** Failed request (the id is the request's / subscription's id). */
  | { t: "err"; id: number; message: string }
  | { t: "pong" };

/** Body of `POST /api/call`. */
export interface CallRequest {
  ref: string;
  args: unknown;
  /** Idempotency key; required when the ref is a mutation. */
  mid?: string;
}
