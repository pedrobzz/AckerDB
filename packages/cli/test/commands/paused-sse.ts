import { createConnection, type Socket } from "node:net";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseSseMessage,
  type SseMessage,
} from "@ackerdb/core";

export interface PausedSse {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  readonly headers: string;
  readonly initialWireBytes: number;
  resumeAndRead(): Promise<Buffer>;
}

export interface DecodedChunkedBody {
  readonly payload: Buffer;
  readonly complete: boolean;
  readonly transferChunks: number;
}

export function decodeChunkedBody(wireBody: Buffer): DecodedChunkedBody {
  const chunks: Buffer[] = [];
  let offset = 0;
  let transferChunks = 0;
  for (;;) {
    const lineEnd = wireBody.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      return { payload: Buffer.concat(chunks), complete: false, transferChunks };
    }
    const sizeText = wireBody.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0]!;
    if (!/^[0-9a-f]+$/i.test(sizeText)) {
      throw new Error(`invalid HTTP chunk size ${JSON.stringify(sizeText)}`);
    }
    const size = Number.parseInt(sizeText, 16);
    const payloadStart = lineEnd + 2;
    if (size === 0) {
      if (wireBody.byteLength < payloadStart + 2) {
        return { payload: Buffer.concat(chunks), complete: false, transferChunks };
      }
      if (wireBody.subarray(payloadStart, payloadStart + 2).toString("ascii") !== "\r\n") {
        throw new Error("HTTP zero chunk is missing its terminating CRLF");
      }
      if (wireBody.byteLength !== payloadStart + 2) {
        throw new Error("unexpected bytes follow the HTTP zero chunk");
      }
      return { payload: Buffer.concat(chunks), complete: true, transferChunks };
    }
    transferChunks++;
    const available = Math.min(size, Math.max(0, wireBody.byteLength - payloadStart));
    if (available > 0) chunks.push(wireBody.subarray(payloadStart, payloadStart + available));
    if (available < size) {
      return { payload: Buffer.concat(chunks), complete: false, transferChunks };
    }
    const chunkEnd = payloadStart + size;
    if (wireBody.byteLength < chunkEnd + 2) {
      return { payload: Buffer.concat(chunks), complete: false, transferChunks };
    }
    if (wireBody.subarray(chunkEnd, chunkEnd + 2).toString("ascii") !== "\r\n") {
      throw new Error("HTTP chunk is missing its trailing CRLF");
    }
    offset = chunkEnd + 2;
  }
}

export function parseSseBody(payload: Buffer): {
  readonly frames: readonly SseMessage[];
  readonly remainder: string;
} {
  const text = payload.toString("utf8").replaceAll("\r\n", "\n");
  const frames: SseMessage[] = [];
  let offset = 0;
  for (;;) {
    const boundary = text.indexOf("\n\n", offset);
    if (boundary === -1) return { frames, remainder: text.slice(offset) };
    const block = text.slice(offset, boundary);
    offset = boundary + 2;
    const data = block.split("\n").map((line) => {
      if (!line.startsWith("data: ")) throw new Error(`unexpected SSE line ${JSON.stringify(line)}`);
      return line.slice(6);
    });
    frames.push(parseSseMessage(decode(data.join("\n"))));
  }
}

function timeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(handle));
}

export async function pausedSse(options: {
  readonly port: number;
  readonly id: number;
  readonly maxWireBytes: number;
  readonly timeoutMs: number;
}): Promise<PausedSse> {
  const body = Buffer.from(encode({
    v: PROTOCOL_VERSION,
    t: "call",
    id: options.id,
    ref: "pressure.endless",
    args: {},
  }));
  let response: Buffer = Buffer.alloc(0);
  let wireBody: Buffer = Buffer.alloc(0);
  let cumulativeWireBytes = 0;
  let headerRead = false;
  let resumed = false;
  let failure: Error | undefined;
  let rejectOpen!: (error: Error) => void;
  let resolveClosed!: () => void;
  let resolveRead!: (body: Buffer) => void;
  let rejectRead!: (error: Error) => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const read = new Promise<Buffer>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  void read.catch(() => {});
  const socket = createConnection({ host: "127.0.0.1", port: options.port });

  const fail = (error: Error) => {
    if (failure !== undefined) return;
    failure = error;
    if (headerRead) rejectRead(error);
    else rejectOpen(error);
    socket.destroy();
  };
  const append = (current: Buffer, chunk: Buffer): Buffer => {
    if (cumulativeWireBytes + chunk.byteLength > options.maxWireBytes) {
      throw new Error(`SSE response exceeds the ${options.maxWireBytes}-byte wire cap`);
    }
    cumulativeWireBytes += chunk.byteLength;
    return Buffer.concat([current, chunk]);
  };

  socket.on("close", () => {
    resolveClosed();
    if (failure !== undefined) return;
    if (!headerRead) rejectOpen(new Error("SSE socket closed before response headers"));
    else resolveRead(wireBody);
  });
  socket.on("error", (error) => fail(error));
  const opened = new Promise<PausedSse>((resolve, reject) => {
    rejectOpen = reject;
    socket.once("connect", () => {
      socket.write(Buffer.concat([
        Buffer.from([
          "POST /api/sse HTTP/1.1",
          "Host: 127.0.0.1",
          "Accept: text/event-stream",
          "Content-Type: application/json",
          `Content-Length: ${body.byteLength}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n")),
        body,
      ]));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        if (headerRead) {
          wireBody = append(wireBody, chunk);
          return;
        }
        response = append(response, chunk);
        const boundary = response.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const headers = response.subarray(0, boundary + 4).toString("ascii");
        wireBody = response.subarray(boundary + 4);
        headerRead = true;
        socket.pause();
        resolve({
          socket,
          closed,
          headers,
          initialWireBytes: wireBody.byteLength,
          resumeAndRead: async () => {
            if (resumed) throw new Error("paused SSE response can only be resumed once");
            resumed = true;
            if (failure !== undefined) throw failure;
            socket.resume();
            try {
              return await timeout(read, "paused SSE close", options.timeoutMs);
            } catch (error) {
              socket.destroy();
              await closed;
              throw error;
            }
          },
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  try {
    return await timeout(opened, "paused SSE response headers", options.timeoutMs);
  } catch (error) {
    socket.destroy();
    await closed;
    throw error;
  }
}
