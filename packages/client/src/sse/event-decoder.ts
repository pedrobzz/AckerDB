import {
  decodeSseEvent,
  type SseMessage,
} from "@ackerdb/core";
import { createParser, type ParseError } from "eventsource-parser";

/**
 * Exact byte ownership for the parser's unfinished event. The dependency
 * deliberately measures characters; AckerDB's resource contract measures the
 * UTF-8 bytes retained from the transport, so this small line-boundary state
 * stays policy-owned.
 */
class SseByteBudget {
  private pendingBytes = 0;
  private lineHasContent = false;
  private previousWasCr = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.pendingBytes++;
      if (this.pendingBytes > this.maxBytes) {
        throw new RangeError("SSE input exceeds the client buffer limit");
      }
      if (byte === 13) {
        this.finishLine();
        this.previousWasCr = true;
      } else if (byte === 10) {
        if (this.previousWasCr) {
          // CRLF is one line terminator; the CR already consumed the line.
          this.pendingBytes--;
          this.previousWasCr = false;
        } else {
          this.finishLine();
        }
      } else {
        this.previousWasCr = false;
        this.lineHasContent = true;
      }
    }
  }

  get hasPendingEvent(): boolean {
    return this.pendingBytes !== 0;
  }

  private finishLine(): void {
    if (!this.lineHasContent) this.pendingBytes = 0;
    this.lineHasContent = false;
  }
}

/** Streaming UTF-8/EventSource syntax decoder with AckerDB's byte bound. */
export class SseEventDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly budget: SseByteBudget;
  private readonly frames: SseMessage[] = [];
  private failure: ParseError | undefined;
  private readonly parser;

  constructor(maxBufferBytes: number) {
    this.budget = new SseByteBudget(maxBufferBytes);
    this.parser = createParser({
      maxBufferSize: maxBufferBytes,
      onEvent: ({ data, event }) => {
        this.frames.push(decodeSseEvent(data, event));
      },
      onError: (error) => {
        if (error.type === "max-buffer-size-exceeded") this.failure = error;
      },
    });
  }

  push(chunk: Uint8Array): SseMessage[] {
    this.budget.push(chunk);
    this.parser.feed(this.decoder.decode(chunk, { stream: true }));
    if (this.failure !== undefined) throw this.failure;
    return this.drain();
  }

  finish(): SseMessage[] {
    this.parser.feed(this.decoder.decode());
    if (this.failure !== undefined) throw this.failure;
    return this.drain();
  }

  get hasPendingEvent(): boolean {
    return this.budget.hasPendingEvent;
  }

  private drain(): SseMessage[] {
    return this.frames.splice(0);
  }
}
