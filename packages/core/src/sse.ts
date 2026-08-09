import { encode } from "./wire.ts";
import { ACKERDB_VERSION } from "./version.ts";
import {
  parseSseMessage,
  type SseChunkMessage,
  type SseDoneMessage,
  type SseErrorMessage,
  type SseMessage,
} from "./protocol.ts";

const utf8 = new TextEncoder();
// The chunk envelope is assembled by concatenation rather than encoded, so the
// version's JSON form is quoted once here instead of on every chunk.
const VERSION_JSON = JSON.stringify(ACKERDB_VERSION);

/** Encode one exposed-JSON application value in its Protocol-2 SSE envelope. */
export function encodeSseChunk(
  seq: number,
  proof: string,
  value: unknown,
): Uint8Array {
  const json = JSON.stringify(value) ?? "null";
  return utf8.encode(
    `data: {"v":${VERSION_JSON},"t":"sse_chunk","seq":${seq},"proof":${JSON.stringify(proof)},"value":${json}}\n\n`,
  );
}

/** Encode a terminal Protocol-2 SSE envelope. */
export function encodeSseControl(
  message: SseDoneMessage | SseErrorMessage,
): Uint8Array {
  return utf8.encode(`data: ${encode(message)}\n\n`);
}

/** Decode one syntactically complete EventSource event into a Protocol-2 SSE message. */
export function decodeSseEvent(
  data: string,
  event: string | undefined,
): SseMessage {
  if (event !== undefined && event !== "message") {
    throw new TypeError(`unknown SSE event type "${event}"`);
  }
  return parseSseMessage(JSON.parse(data));
}

export type { SseChunkMessage };
