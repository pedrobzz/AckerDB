import { ProtocolError, decode } from "@ackerdb/core";
import { AckerDBError } from "../../shared/errors.ts";

/** One raw WebSocket message whose byte ownership remains inside Session. */
export type SessionWireFrame = string | Uint8Array;

/** An admitted frame and the exact transport bytes its operation owns. */
export interface DecodedClientFrame<Message> {
  readonly message: Message;
  readonly bytes: number;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function protocolError(error: ProtocolError): AckerDBError {
  return new AckerDBError(error.code, error.message, { cause: error });
}

/**
 * Admits one raw frame against the session's byte limits and decodes Protocol-2.
 * Admission is all-or-nothing: on success the caller owns exactly `bytes`, and
 * every rejection throws the AckerDBError the session must terminate on.
 *
 * The parser is the caller's to choose because it is the caller that knows
 * whether this connection has a verified peer yet. A session passes the
 * handshake parser until its hello is accepted and the session parser
 * afterwards, so the phase decides which vocabulary a frame is read against
 * instead of one parser deciding it from the frame's own contents.
 */
export function decodeClientFrame<Message>(
  raw: SessionWireFrame,
  maxFrameBytes: number,
  maxRequestBytes: number,
  parse: (value: unknown) => Message,
): DecodedClientFrame<Message> {
  let bytes: number;
  if (typeof raw === "string") {
    bytes = Buffer.byteLength(raw);
  } else if (raw instanceof Uint8Array) {
    bytes = raw.byteLength;
  } else {
    throw new AckerDBError("malformed", "client frame must be text or binary");
  }
  if (bytes > maxFrameBytes) {
    throw new AckerDBError("overloaded", "client frame exceeds maxFrameBytes", {
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
    });
  }
  if (bytes > maxRequestBytes) {
    throw new AckerDBError("overloaded", "client request exceeds maxRequestBytes", {
      resource: "operation",
    });
  }

  let text: string;
  try {
    text = typeof raw === "string" ? raw : STRICT_UTF8.decode(raw);
  } catch (cause) {
    throw new AckerDBError("malformed", "client frame is not valid UTF-8", { cause });
  }
  try {
    return { message: parse(decode(text)), bytes };
  } catch (cause) {
    throw cause instanceof ProtocolError
      ? protocolError(cause)
      : new AckerDBError("malformed", "malformed client frame", { cause });
  }
}
