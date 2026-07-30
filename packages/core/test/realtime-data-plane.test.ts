import { describe, expect, test } from "bun:test";
import {
  REALTIME_STREAM_CHUNK_MAX_BYTES,
  RealtimeDataPlane,
  RealtimeStreamInterruptedError,
  RealtimeStreamOverrunError,
  type RealtimeDataPlaneIncomingStream,
} from "@ackerdb/core";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "open";
  peer?: FakeDataChannel;
  readonly packets: Uint8Array[] = [];

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") throw new Error("channel is closed");
    if (typeof data === "string" || data instanceof Blob) {
      throw new Error("AckerDB sent a non-binary packet");
    }
    const view = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const packet = view.slice();
    this.packets.push(packet);
    queueMicrotask(() => {
      this.peer?.dispatchEvent(new MessageEvent("message", {
        data: packet.buffer,
      }));
    });
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function pair(): readonly [FakeDataChannel, FakeDataChannel] {
  const client = new FakeDataChannel();
  const server = new FakeDataChannel();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

function rtc(channel: FakeDataChannel): RTCDataChannel {
  return channel as unknown as RTCDataChannel;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("RealtimeDataPlane", () => {
  test("sends one binary event packet and preserves nested bytes", async () => {
    const [clientChannel, serverChannel] = pair();
    const received: unknown[] = [];
    const failures: unknown[] = [];
    const client = new RealtimeDataPlane({
      channel: rtc(clientChannel),
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 32 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const server = new RealtimeDataPlane({
      channel: rtc(serverChannel),
      localPrefix: "s",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 32 * 1024,
      streamIdleMs: 30_000,
      onEvent: (event, payload) => received.push({ event, payload }),
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });

    expect(client.send("audio.delta", {
      audio: new Uint8Array([1, 2, 3]),
    })).toBe(true);
    await turn();
    expect(received).toEqual([{
      event: "audio.delta",
      payload: { audio: new Uint8Array([1, 2, 3]) },
    }]);
    expect(clientChannel.packets).toHaveLength(1);
    expect(failures).toEqual([]);
    client.close();
    server.close();
  });

  test("pipes a large write as bounded packets into a standard readable", async () => {
    const [clientChannel, serverChannel] = pair();
    const failures: unknown[] = [];
    let incoming!: RealtimeDataPlaneIncomingStream;
    let resolveIncoming!: () => void;
    const incomingReady = new Promise<void>((resolve) => {
      resolveIncoming = resolve;
    });
    const client = new RealtimeDataPlane({
      channel: rtc(clientChannel),
      localPrefix: "c",
      maxBufferedAmount: 128 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const server = new RealtimeDataPlane({
      channel: rtc(serverChannel),
      localPrefix: "s",
      maxBufferedAmount: 128 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: (stream, metadata) => ({
        maxBytes: 64 * 1024,
        accept(value) {
          expect(stream).toBe("camera.snapshot");
          expect(metadata).toEqual({ contentType: "image/jpeg" });
          incoming = value;
          resolveIncoming();
        },
      }),
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });

    const source = new Uint8Array(REALTIME_STREAM_CHUNK_MAX_BYTES * 2 + 17);
    source.forEach((_value, index) => {
      source[index] = index % 251;
    });
    const outgoing = client.openStream(
      "camera.snapshot",
      { contentType: "image/jpeg" },
      source.byteLength,
      source.byteLength,
    );
    const writer = outgoing.writable.getWriter();
    await writer.write(source);
    await writer.close();
    await incomingReady;
    const received = new Uint8Array(await new Response(incoming.readable).arrayBuffer());
    expect(received).toEqual(source);
    // open + 3 chunks + end; the large application write was never one packet.
    expect(clientChannel.packets).toHaveLength(5);
    expect(failures).toEqual([]);
    client.close();
    server.close();
  });

  test("fails only an incoming transfer when its JS consumer buffer overruns", async () => {
    const [clientChannel, serverChannel] = pair();
    const failures: unknown[] = [];
    let incoming!: RealtimeDataPlaneIncomingStream;
    let resolveIncoming!: () => void;
    const incomingReady = new Promise<void>((resolve) => {
      resolveIncoming = resolve;
    });
    const client = new RealtimeDataPlane({
      channel: rtc(clientChannel),
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const server = new RealtimeDataPlane({
      channel: rtc(serverChannel),
      localPrefix: "s",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 4,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => ({
        maxBytes: 100,
        accept(value) {
          incoming = value;
          resolveIncoming();
        },
      }),
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });

    const outgoing = client.openStream("photo", {}, 100);
    const writer = outgoing.writable.getWriter();
    await writer.write(new Uint8Array([1, 2, 3, 4, 5]));
    await incomingReady;
    await turn();
    await expect(incoming.readable.getReader().read()).rejects.toBeInstanceOf(
      RealtimeStreamOverrunError,
    );
    expect(failures).toEqual([]);
    await expect(writer.closed).rejects.toThrow("receive buffer");
    client.close();
    server.close();
  });

  test("event sends fail immediately while the data channel is backpressured", () => {
    const [clientChannel] = pair();
    clientChannel.bufferedAmount = 1024;
    const pressure: string[] = [];
    const client = new RealtimeDataPlane({
      channel: rtc(clientChannel),
      localPrefix: "c",
      maxBufferedAmount: 512,
      maxConcurrentStreams: 1,
      maxIncomingBufferedBytes: 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: () => {},
      onPressure: (value) => pressure.push(value),
    });
    expect(client.send("message", { text: "not queued" })).toBe(false);
    expect(clientChannel.packets).toEqual([]);
    expect(pressure).toEqual(["data-channel-buffer"]);
    client.close();
  });

  test("reports a critical channel close and interrupts open writers", async () => {
    const [clientChannel] = pair();
    const failures: unknown[] = [];
    const client = new RealtimeDataPlane({
      channel: rtc(clientChannel),
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 1,
      maxIncomingBufferedBytes: 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const transfer = client.openStream("photo", {}, 1024);
    const writer = transfer.writable.getWriter();

    clientChannel.close();

    let interruption: unknown;
    try {
      await writer.closed;
    } catch (error) {
      interruption = error;
    }
    expect(interruption).toBeInstanceOf(RealtimeStreamInterruptedError);
    expect(interruption).toMatchObject({
      transferId: transfer.id,
      message: "realtime data channel closed",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });
});
