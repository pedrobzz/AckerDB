import { parseReceivedFrame, parseSentFrame } from "ackerdb-test-support/client-transport";
import {
  decode,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { within } from "ackerdb-test-support/async";

const HEADER_END = Buffer.from("\r\n\r\n");

interface WebSocketFrame {
  readonly bytes: Buffer;
  readonly final: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  readonly reserved: number;
}

function readWebSocketFrame(buffer: Buffer): WebSocketFrame | undefined {
  if (buffer.byteLength < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  let payloadLength = second & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.byteLength < 4) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.byteLength < 10) return undefined;
    const extended = buffer.readBigUInt64BE(2);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("WebSocket frame exceeds the safe byte range");
    }
    payloadLength = Number(extended);
    offset = 10;
  }
  const masked = (second & 0x80) !== 0;
  const maskOffset = offset;
  if (masked) offset += 4;
  const frameLength = offset + payloadLength;
  if (buffer.byteLength < frameLength) return undefined;

  const bytes = Buffer.from(buffer.subarray(0, frameLength));
  const encodedPayload = bytes.subarray(offset);
  if (!masked) {
    return {
      bytes,
      final: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload: Buffer.from(encodedPayload),
      reserved: first & 0x70,
    };
  }
  const mask = bytes.subarray(maskOffset, maskOffset + 4);
  const payload = Buffer.allocUnsafe(encodedPayload.byteLength);
  for (let index = 0; index < encodedPayload.byteLength; index++) {
    payload[index] = encodedPayload[index]! ^ mask[index & 3]!;
  }
  return {
    bytes,
    final: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload,
    reserved: first & 0x70,
  };
}

export interface ProxiedClientFrame {
  readonly sequence: number;
  readonly connectionId: number;
  readonly message: ClientMessage;
  readonly receivedBytes: Buffer;
  forwardedBytes?: Buffer;
}

export interface ProxiedServerFrame {
  readonly sequence: number;
  readonly connectionId: number;
  readonly message: ServerMessage;
  readonly receivedBytes: Buffer;
  forwardedBytes?: Buffer;
}

export interface HeldServerFrame {
  readonly frame: ProxiedServerFrame;
  forward(): void;
  drop(): void;
}

export interface HeldClientFrame {
  readonly frame: ProxiedClientFrame;
  forward(): void;
  drop(): void;
}

interface FrameCut<Message, Frame> {
  readonly predicate: (message: Message) => boolean;
  readonly phase: "before" | "after";
  readonly matched: PromiseWithResolvers<Frame>;
}

interface FrameHold {
  readonly predicate: (message: ServerMessage) => boolean;
  readonly matched: PromiseWithResolvers<HeldServerFrame>;
}

interface ClientFrameHold {
  readonly predicate: (message: ClientMessage) => boolean;
  readonly matched: PromiseWithResolvers<HeldClientFrame>;
}

interface Pair {
  readonly id: number;
  readonly downstream: Socket;
  readonly upstream: Socket;
  readonly closed: PromiseWithResolvers<void>;
  clientBuffer: Buffer;
  serverBuffer: Buffer;
  clientHandshake: boolean;
  serverHandshake: boolean;
  /** Frames each end has sent; the first of each is the AckerDB handshake. */
  clientSent: number;
  serverSent: number;
  clientClosed: boolean;
  serverClosed: boolean;
  faulted: boolean;
  heldServer?: { readonly frame: ProxiedServerFrame; readonly bytes: Buffer };
  heldClient?: { readonly frame: ProxiedClientFrame; readonly bytes: Buffer };
}

/**
 * A transparent TCP proxy that preserves every unmodified WebSocket frame byte.
 * It parses complete text-frame payloads only to select deterministic fault cuts.
 */
export class FrameProxy {
  readonly hostname = "127.0.0.1";
  readonly clientFrames: ProxiedClientFrame[] = [];
  readonly serverFrames: ProxiedServerFrame[] = [];

  private readonly listener: Server;
  private readonly pairs = new Map<number, Pair>();
  private readonly changes = new Set<() => void>();
  private nextConnectionId = 0;
  private nextSequence = 0;
  private closed = false;
  private clientCut?: FrameCut<ClientMessage, ProxiedClientFrame>;
  private serverCut?: FrameCut<ServerMessage, ProxiedServerFrame>;
  private serverHold?: FrameHold;
  private clientHold?: ClientFrameHold;
  private failure: unknown;
  private _port = 0;

  private constructor(
    private readonly upstreamHostname: string,
    private readonly upstreamPort: number,
  ) {
    this.listener = createServer((socket) => this.accept(socket));
  }

  static async listen(options: {
    readonly upstreamPort: number;
    readonly upstreamHostname?: string;
  }): Promise<FrameProxy> {
    const proxy = new FrameProxy(options.upstreamHostname ?? "127.0.0.1", options.upstreamPort);
    const listening = Promise.withResolvers<void>();
    const onError = (error: Error): void => listening.reject(error);
    proxy.listener.once("error", onError);
    proxy.listener.listen(0, proxy.hostname, () => listening.resolve(undefined));
    await within(listening.promise, "fault proxy listener");
    proxy.listener.off("error", onError);
    const address = proxy.listener.address();
    if (address === null || typeof address === "string") throw new Error("fault proxy has no TCP port");
    proxy._port = address.port;
    return proxy;
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://${this.hostname}:${this.port}`;
  }

  get connectionsOpened(): number {
    return this.nextConnectionId;
  }

  cutNextClientFrame(
    predicate: (message: ClientMessage) => boolean,
    phase: "before" | "after" = "before",
  ): Promise<ProxiedClientFrame> {
    if (this.clientCut !== undefined || this.clientHold !== undefined) {
      throw new Error("a client-frame fault is already armed");
    }
    const matched = Promise.withResolvers<ProxiedClientFrame>();
    this.clientCut = { predicate, phase, matched };
    return within(matched.promise, "client-frame cut");
  }

  holdNextClientFrame(
    predicate: (message: ClientMessage) => boolean,
  ): Promise<HeldClientFrame> {
    if (this.clientCut !== undefined || this.clientHold !== undefined) {
      throw new Error("a client-frame fault is already armed");
    }
    const matched = Promise.withResolvers<HeldClientFrame>();
    this.clientHold = { predicate, matched };
    return within(matched.promise, "held client frame");
  }

  cutNextServerFrame(
    predicate: (message: ServerMessage) => boolean,
    phase: "before" | "after" = "before",
  ): Promise<ProxiedServerFrame> {
    if (this.serverCut !== undefined || this.serverHold !== undefined) {
      throw new Error("a server-frame fault is already armed");
    }
    const matched = Promise.withResolvers<ProxiedServerFrame>();
    this.serverCut = { predicate, phase, matched };
    return within(matched.promise, "server-frame cut");
  }

  holdNextServerFrame(
    predicate: (message: ServerMessage) => boolean,
  ): Promise<HeldServerFrame> {
    if (this.serverCut !== undefined || this.serverHold !== undefined) {
      throw new Error("a server-frame fault is already armed");
    }
    const matched = Promise.withResolvers<HeldServerFrame>();
    this.serverHold = { predicate, matched };
    return within(matched.promise, "held server frame");
  }

  waitForConnection(id: number): Promise<number> {
    return this.waitFor(
      () => this.nextConnectionId >= id ? id : undefined,
      `proxy connection ${id}`,
    );
  }

  waitForConnectionClosed(id: number): Promise<void> {
    return this.waitFor(
      () => this.pairs.has(id) ? undefined : true,
      `proxy connection ${id} cleanup`,
    ).then(() => {});
  }

  waitForForwardedServerFrame(
    connectionId: number,
    predicate: (message: ServerMessage) => boolean,
  ): Promise<ProxiedServerFrame> {
    return this.waitFor(
      () => this.serverFrames.find((frame) =>
        frame.connectionId === connectionId &&
        frame.forwardedBytes !== undefined &&
        predicate(frame.message)
      ),
      `forwarded server frame on connection ${connectionId}`,
    );
  }

  async dropConnections(): Promise<void> {
    const active = [...this.pairs.values()];
    if (active.length === 0) throw new Error("fault proxy has no active connection");
    for (const pair of active) this.drop(pair);
    await within(Promise.all(active.map(({ closed }) => closed.promise)).then(() => {}), "proxy drop");
  }

  assertBytePreserving(): void {
    if (this.failure !== undefined) throw this.failure;
    for (const frame of [...this.clientFrames, ...this.serverFrames]) {
      if (frame.forwardedBytes !== undefined && !frame.receivedBytes.equals(frame.forwardedBytes)) {
        throw new Error(`proxy changed WebSocket frame ${frame.sequence}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      if (this.failure !== undefined) throw this.failure;
      return;
    }
    this.closed = true;
    const error = new Error("fault proxy closed before the armed frame matched");
    this.clientCut?.matched.reject(error);
    this.serverCut?.matched.reject(error);
    this.serverHold?.matched.reject(error);
    this.clientHold?.matched.reject(error);
    this.clientCut = undefined;
    this.serverCut = undefined;
    this.serverHold = undefined;
    this.clientHold = undefined;
    const active = [...this.pairs.values()];
    for (const pair of active) this.drop(pair);
    try {
      await Promise.all(active.map(({ closed }) => closed.promise));
    } catch (error) {
      this.failure ??= error;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        this.listener.close((error) => error === undefined ? resolve() : reject(error));
      });
    } catch (error) {
      this.failure ??= error;
    }
    if (this.pairs.size !== 0) {
      this.failure ??= new Error("fault proxy retained TCP pairs after close");
    }
    if (this.failure !== undefined) throw this.failure;
  }

  private accept(downstream: Socket): void {
    const id = ++this.nextConnectionId;
    const upstream = createConnection({ host: this.upstreamHostname, port: this.upstreamPort });
    const pair: Pair = {
      id,
      downstream,
      upstream,
      closed: Promise.withResolvers<void>(),
      clientBuffer: Buffer.alloc(0),
      serverBuffer: Buffer.alloc(0),
      clientHandshake: false,
      serverHandshake: false,
      clientSent: 0,
      serverSent: 0,
      clientClosed: false,
      serverClosed: false,
      faulted: false,
    };
    this.pairs.set(id, pair);
    downstream.on("data", (chunk) => this.receiveClient(
      pair,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ));
    upstream.on("data", (chunk) => this.receiveServer(
      pair,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ));
    downstream.on("end", () => {
      if (!upstream.destroyed) upstream.end();
    });
    upstream.on("end", () => {
      if (!downstream.destroyed) downstream.end();
    });
    downstream.on("error", (error) => {
      if (!pair.faulted) this.failPair(pair, error);
    });
    upstream.on("error", (error) => {
      if (!pair.faulted) this.failPair(pair, error);
    });
    downstream.on("close", () => {
      pair.clientClosed = true;
      this.finishPair(pair);
    });
    upstream.on("close", () => {
      pair.serverClosed = true;
      this.finishPair(pair);
    });
    this.changed();
  }

  private receiveClient(pair: Pair, chunk: Buffer): void {
    if (pair.faulted) return;
    pair.clientBuffer = Buffer.concat([pair.clientBuffer, chunk]);
    if (!pair.clientHandshake) {
      const end = pair.clientBuffer.indexOf(HEADER_END);
      if (end < 0) return;
      const length = end + HEADER_END.byteLength;
      pair.upstream.write(pair.clientBuffer.subarray(0, length));
      pair.clientBuffer = pair.clientBuffer.subarray(length);
      pair.clientHandshake = true;
    }
    this.drainClientFrames(pair);
  }

  private drainClientFrames(pair: Pair): void {
    try {
      while (!pair.faulted && pair.heldClient === undefined) {
        const parsed = readWebSocketFrame(pair.clientBuffer);
        if (parsed === undefined) return;
        pair.clientBuffer = pair.clientBuffer.subarray(parsed.bytes.byteLength);
        if (parsed.reserved !== 0) {
          throw new Error("fault proxy cannot inspect a WebSocket frame with reserved bits");
        }
        if (parsed.opcode === 0 || (parsed.opcode === 1 && !parsed.final)) {
          throw new Error("fault proxy requires unfragmented application text frames");
        }
        if (parsed.opcode !== 1) {
          pair.upstream.write(parsed.bytes);
          continue;
        }
        const message = parseSentFrame(parsed.payload.toString("utf8"), pair.clientSent++);
        const frame: ProxiedClientFrame = {
          sequence: ++this.nextSequence,
          connectionId: pair.id,
          message,
          receivedBytes: parsed.bytes,
        };
        this.clientFrames.push(frame);

        const hold = this.clientHold;
        if (hold !== undefined && hold.predicate(message)) {
          this.clientHold = undefined;
          pair.heldClient = { frame, bytes: parsed.bytes };
          const held: HeldClientFrame = {
            frame,
            forward: () => this.releaseHeldClient(pair, true),
            drop: () => this.releaseHeldClient(pair, false),
          };
          hold.matched.resolve(held);
          this.changed();
          return;
        }

        const cut = this.clientCut;
        if (cut !== undefined && cut.predicate(message)) {
          this.clientCut = undefined;
          if (cut.phase === "after") {
            frame.forwardedBytes = Buffer.from(parsed.bytes);
            pair.upstream.write(parsed.bytes);
          }
          cut.matched.resolve(frame);
          this.changed();
          this.drop(pair);
          return;
        }
        frame.forwardedBytes = Buffer.from(parsed.bytes);
        pair.upstream.write(parsed.bytes);
        this.changed();
      }
    } catch (error) {
      this.failPair(pair, error);
    }
  }

  private receiveServer(pair: Pair, chunk: Buffer): void {
    if (pair.faulted) return;
    pair.serverBuffer = Buffer.concat([pair.serverBuffer, chunk]);
    if (!pair.serverHandshake) {
      const end = pair.serverBuffer.indexOf(HEADER_END);
      if (end < 0) return;
      const length = end + HEADER_END.byteLength;
      const response = pair.serverBuffer.subarray(0, length);
      if (/\r\nsec-websocket-extensions\s*:/i.test(response.toString("latin1"))) {
        this.failPair(
          pair,
          new Error("fault predicates require an uncompressed WebSocket application stream"),
        );
        return;
      }
      pair.downstream.write(response);
      pair.serverBuffer = pair.serverBuffer.subarray(length);
      pair.serverHandshake = true;
    }
    this.drainServerFrames(pair);
  }

  private drainServerFrames(pair: Pair): void {
    try {
      while (!pair.faulted && pair.heldServer === undefined) {
        const parsed = readWebSocketFrame(pair.serverBuffer);
        if (parsed === undefined) return;
        pair.serverBuffer = pair.serverBuffer.subarray(parsed.bytes.byteLength);
        if (parsed.reserved !== 0) {
          throw new Error("fault proxy cannot inspect a WebSocket frame with reserved bits");
        }
        if (parsed.opcode === 0 || (parsed.opcode === 1 && !parsed.final)) {
          throw new Error("fault proxy requires unfragmented application text frames");
        }
        if (parsed.opcode !== 1) {
          pair.downstream.write(parsed.bytes);
          continue;
        }
        const message = parseReceivedFrame(parsed.payload.toString("utf8"), pair.serverSent++);
        const frame: ProxiedServerFrame = {
          sequence: ++this.nextSequence,
          connectionId: pair.id,
          message,
          receivedBytes: parsed.bytes,
        };
        this.serverFrames.push(frame);

        const hold = this.serverHold;
        if (hold !== undefined && hold.predicate(message)) {
          this.serverHold = undefined;
          pair.heldServer = { frame, bytes: parsed.bytes };
          const held: HeldServerFrame = {
            frame,
            forward: () => this.releaseHeld(pair, true),
            drop: () => this.releaseHeld(pair, false),
          };
          hold.matched.resolve(held);
          this.changed();
          return;
        }

        const cut = this.serverCut;
        if (cut !== undefined && cut.predicate(message)) {
          this.serverCut = undefined;
          if (cut.phase === "after") {
            frame.forwardedBytes = Buffer.from(parsed.bytes);
            pair.faulted = true;
            pair.downstream.end(parsed.bytes);
            pair.upstream.destroy();
          } else {
            this.drop(pair);
          }
          cut.matched.resolve(frame);
          this.changed();
          return;
        }

        frame.forwardedBytes = Buffer.from(parsed.bytes);
        pair.downstream.write(parsed.bytes);
        this.changed();
      }
    } catch (error) {
      this.failPair(pair, error);
    }
  }

  private releaseHeld(pair: Pair, forward: boolean): void {
    const held = pair.heldServer;
    if (held === undefined) throw new Error("server frame is no longer held");
    pair.heldServer = undefined;
    if (!forward) {
      this.drop(pair);
      return;
    }
    held.frame.forwardedBytes = Buffer.from(held.bytes);
    pair.downstream.write(held.bytes);
    this.changed();
    this.drainServerFrames(pair);
  }

  private releaseHeldClient(pair: Pair, forward: boolean): void {
    const held = pair.heldClient;
    if (held === undefined) throw new Error("client frame is no longer held");
    pair.heldClient = undefined;
    if (!forward) {
      this.drop(pair);
      return;
    }
    held.frame.forwardedBytes = Buffer.from(held.bytes);
    pair.upstream.write(held.bytes);
    this.changed();
    this.drainClientFrames(pair);
  }

  private drop(pair: Pair): void {
    if (pair.faulted && pair.downstream.destroyed && pair.upstream.destroyed) return;
    pair.faulted = true;
    pair.downstream.destroy();
    pair.upstream.destroy();
  }

  private failPair(pair: Pair, error: unknown): void {
    this.failure ??= error;
    this.clientCut?.matched.reject(error);
    this.serverCut?.matched.reject(error);
    this.serverHold?.matched.reject(error);
    this.clientHold?.matched.reject(error);
    this.drop(pair);
  }

  private finishPair(pair: Pair): void {
    if (!pair.clientClosed || !pair.serverClosed) return;
    if (this.pairs.delete(pair.id)) pair.closed.resolve(undefined);
    this.changed();
  }

  private waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
    const current = read();
    if (current !== undefined) return Promise.resolve(current);
    const waiting = Promise.withResolvers<T>();
    const check = (): void => {
      const value = read();
      if (value === undefined) return;
      this.changes.delete(check);
      waiting.resolve(value);
    };
    this.changes.add(check);
    return within(waiting.promise, description).finally(() => this.changes.delete(check));
  }

  private changed(): void {
    for (const listener of [...this.changes]) listener();
  }
}

/** Prove that teardown released the exact ephemeral listener, not merely its owner object. */
export async function assertTcpPortReleased(port: number): Promise<void> {
  const listener = createServer();
  const listening = Promise.withResolvers<void>();
  const onError = (error: Error): void => listening.reject(error);
  listener.once("error", onError);
  listener.listen(port, "127.0.0.1", () => listening.resolve(undefined));
  await within(listening.promise, `released TCP port ${port}`);
  listener.off("error", onError);
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => error === undefined ? resolve() : reject(error));
  });
}
