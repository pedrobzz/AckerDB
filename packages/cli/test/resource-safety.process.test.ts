import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Subprocess } from "bun";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallResponse,
  parseServerMessage,
  type CallResponse,
  type ServerMessage,
} from "@dbzz/core";
import type { DbzzServerStatus, RuntimeStatus } from "@dbzz/server";
import {
  ProcessTreeMonitor,
  PROCESS_TREE_RSS_KIND,
  snapshotProcessTree,
} from "../../../bench/process-tree.ts";
import { makeFixture } from "./fixture.ts";
import { decodeChunkedBody, parseSseBody, pausedSse } from "./paused-sse.ts";

const TEST_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;
const STATUS_TOKEN = "resource-status";
const KiB = 1024;
const LIMITS = Object.freeze({
  connections: 4,
  operations: 4,
  queueItems: 4,
  queueBytes: 128 * KiB,
  subscriptions: 3,
  sharedSubscriptions: 3,
  sharedResultBytes: 128 * KiB,
  revalidationConcurrency: 1,
  webSocketBytesPerConnection: 64 * KiB,
  webSocketBytes: 256 * KiB,
  sseBytesPerStream: 64 * KiB,
  sseBytes: 96 * KiB,
  resumeTransitionsPerStream: 2,
  resumeBytes: 128 * KiB,
  publicationItems: 4,
  publicationBytes: 128 * KiB,
});
// Every explicitly byte-bounded in-memory pool configured by the fixture.
const DECLARED_RETAINED_BYTES =
  LIMITS.webSocketBytes * 2 + // transport outbound + runtime auth capture
  LIMITS.sseBytes +
  LIMITS.sharedResultBytes +
  LIMITS.resumeBytes +
  LIMITS.queueBytes * 3 + // read, write, and revalidation queues
  LIMITS.publicationBytes;
const DECLARED_RETAINED_MB = DECLARED_RETAINED_BYTES / (KiB * KiB);
const PROCESS_SAMPLE_MS = 20;
const DESCRIPTOR_SAMPLE_MS = 50;
const WARMUP_EPOCHS = 5;
const MEASURED_EPOCHS = 5;
const SSE_MIN_WARMUP_EPOCHS = 15;
const SSE_STABILITY_EPOCHS = 8;
const SSE_MAX_TOTAL_EPOCHS = 64;
const SSE_MAX_STABILIZATION_MS = 90_000;
// One epoch has five sequentially bounded phases: response headers, open
// credit, terminal grace, close/release, and exact descriptor recovery.
const SSE_EPOCH_TIMEOUT_MS = 5 * STEP_TIMEOUT_MS;
// Fixture readiness/baseline and final release/descriptors/shutdown are outside
// the stabilization deadline. The test timeout is derived from both real caps.
const SSE_HARNESS_TIMEOUT_STEPS = 8;
const SSE_TEST_TIMEOUT_MS =
  SSE_MAX_STABILIZATION_MS + SSE_HARNESS_TIMEOUT_STEPS * STEP_TIMEOUT_MS;
const SSE_PAYLOAD_BYTES = 30 * KiB;
const SSE_STALL_MS = 300;
const SSE_APPLICATION_FRAME_LIMIT = 1;
const SSE_HTTP_FRAME_LIMIT = SSE_APPLICATION_FRAME_LIMIT + 1;
const SSE_HTTP_FRAMING_BYTES =
  SSE_HTTP_FRAME_LIMIT * (LIMITS.sseBytesPerStream.toString(16).length + 4) + 5;
const SSE_HTTP_HEADER_BYTES = 4 * KiB;
const SSE_RESPONSE_WIRE_BYTES =
  SSE_HTTP_HEADER_BYTES + LIMITS.sseBytesPerStream + SSE_HTTP_FRAMING_BYTES;
const SSE_DESCRIPTOR_PEAK_DELTA = 2;
const DESCRIPTOR_MONITOR_AVAILABLE =
  process.platform === "darwin" && Bun.which("lsof") !== null;

const RESOURCE_SERVER = new URL("./resource-safety.fixture.mjs", import.meta.url).pathname;

type FixtureProcess = Subprocess<"ignore", "pipe", "pipe">;

interface ProcessHarness {
  readonly child: FixtureProcess;
  output(): string;
  waitForCount(marker: string, count: number): Promise<void>;
  readonly drained: Promise<void>;
}

type ResourceStatus = Omit<DbzzServerStatus, "runtime"> & { readonly runtime: RuntimeStatus };

interface WsClient {
  readonly socket: WebSocket;
  send(frame: unknown): void;
  next(): Promise<ServerMessage>;
  closed(): Promise<CloseEvent>;
}

interface PausedWebSocket {
  readonly socket: Socket;
  resumeAndRead(): Promise<{
    readonly handshake: string;
    readonly bytes: number;
    readonly frames: readonly ServerMessage[];
    readonly close: { readonly code: number; readonly reason: string } | null;
  }>;
}

interface DescriptorSnapshot {
  readonly open: number;
  readonly listeners: number;
}

let fixtureDir: string | undefined;
const harnesses = new Set<ProcessHarness>();
const sockets = new Set<WebSocket>();
const tcpSockets = new Set<Socket>();
const socketClosures = new Map<WebSocket, Promise<void>>();
const tcpClosures = new Map<Socket, Promise<void>>();
const monitors = new Set<{ stop(): void }>();

afterEach(async () => {
  for (const monitor of monitors) monitor.stop();
  const closures = [...socketClosures.values(), ...tcpClosures.values()];
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // Killing the fixture below closes sockets that are still connecting.
    }
  }
  for (const socket of tcpSockets) socket.destroy();
  for (const harness of harnesses) {
    try {
      harness.child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  await Promise.all([
    ...closures.map((closed) => closed.catch(() => {})),
    ...[...harnesses].flatMap((harness) => [
      harness.child.exited.catch(() => {}),
      harness.drained.catch(() => {}),
    ]),
  ]);
  monitors.clear();
  sockets.clear();
  tcpSockets.clear();
  socketClosures.clear();
  tcpClosures.clear();
  harnesses.clear();
  if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

async function eventually<T>(
  read: () => T | Promise<T>,
  accepted: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let value = await read();
  while (!accepted(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last value: ${encode(value)}`);
    }
    await Bun.sleep(20);
    value = await read();
  }
  return value;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

function spawnFixture(dir: string, port: number): ProcessHarness {
  const child = Bun.spawn([process.execPath, RESOURCE_SERVER, String(port), dir], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DBZZ_TELEMETRY: "disabled" },
  }) as FixtureProcess;
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, append: (value: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        append(decoder.decode(next.value, { stream: true }));
      }
      append(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  };
  const drained = Promise.all([
    drain(child.stdout, (value) => {
      stdout += value;
    }),
    drain(child.stderr, (value) => {
      stderr += value;
    }),
  ]).then(() => undefined);
  const output = () => `${stdout}${stderr === "" ? "" : `\n[stderr]\n${stderr}`}`;
  const harness: ProcessHarness = {
    child,
    output,
    waitForCount: async (marker, count) => {
      await eventually(
        () => output().split(marker).length - 1,
        (found) => found >= count,
        `${count} ${marker} fixture markers`,
      );
    },
    drained,
  };
  harnesses.add(harness);
  return harness;
}

async function status(base: string): Promise<ResourceStatus> {
  const response = await fetch(`${base}/status`, {
    headers: {
      authorization: `Bearer ${STATUS_TOKEN}`,
      connection: "close",
    },
  });
  if (response.status !== 200) {
    throw new Error(`status failed with ${response.status}: ${await response.text()}`);
  }
  return decode(await response.text()) as ResourceStatus;
}

async function call(
  base: string,
  id: number,
  ref: string,
  args: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<{ readonly status: number; readonly frame: CallResponse }> {
  const response = await fetch(`${base}/api/call`, {
    method: "POST",
    headers: {
      connection: "close",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: encode({ v: PROTOCOL_VERSION, t: "call", id, ref, args }),
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    status: response.status,
    frame: parseCallResponse(decode(await response.text())),
  };
}

function rawWebSocket(url: string): Promise<WsClient> {
  const socket = new WebSocket(url);
  sockets.add(socket);
  let resolveClosed!: () => void;
  const transportClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socketClosures.set(socket, transportClosed);
  const frames: ServerMessage[] = [];
  const waiters: Array<(frame: ServerMessage) => void> = [];
  let closeEvent: CloseEvent | null = null;
  const closeWaiters: Array<(event: CloseEvent) => void> = [];
  socket.onmessage = (event) => {
    const frame = parseServerMessage(decode(String(event.data)));
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  };
  socket.onclose = (event) => {
    closeEvent = event;
    sockets.delete(socket);
    resolveClosed();
    for (const waiter of closeWaiters.splice(0)) waiter(event);
  };
  return withTimeout(new Promise<WsClient>((resolve, reject) => {
    socket.onopen = () => resolve({
      socket,
      send: (frame) => socket.send(encode(frame)),
      next: () => {
        const frame = frames.shift();
        return frame === undefined
          ? new Promise<ServerMessage>((accept) => waiters.push(accept))
          : Promise.resolve(frame);
      },
      closed: () => closeEvent === null
        ? new Promise<CloseEvent>((accept) => closeWaiters.push(accept))
        : Promise.resolve(closeEvent),
    });
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  }), "WebSocket open");
}

let sessionSequence = 0;

async function connectWebSocket(url: string): Promise<WsClient> {
  const client = await rawWebSocket(url);
  client.send({
    v: PROTOCOL_VERSION,
    t: "hello",
    clientSessionId: `resource-safety-${++sessionSequence}`,
    credential: { kind: "anonymous" },
  });
  expect(await withTimeout(client.next(), "WebSocket welcome")).toMatchObject({
    t: "welcome",
    principal: "anonymous",
  });
  return client;
}

function maskedWebSocketFrame(frame: unknown, opcode = 1): Buffer {
  const payload = Buffer.isBuffer(frame)
    ? frame
    : Buffer.from(typeof frame === "string" ? frame : encode(frame));
  const extended = payload.byteLength >= 126 ? 2 : 0;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  if (extended === 0) header[1] = 0x80 | payload.byteLength;
  else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  }
  const maskOffset = 2 + extended;
  const mask = Buffer.from([0x13, 0x37, 0x42, 0x99]);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index++) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, masked]);
}

function pausedWebSocket(port: number): Promise<PausedWebSocket> {
  let handshakeBytes = Buffer.alloc(0);
  let handshake = "";
  let frameBytes = Buffer.alloc(0);
  let bytes = 0;
  const frames: ServerMessage[] = [];
  let close: { code: number; reason: string } | null = null;
  let opened = false;
  let subscriptionSent = false;
  let unreadStarted = false;
  let closeAcknowledged = false;
  let rejectOpen: ((error: Error) => void) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const socket = createConnection({ host: "127.0.0.1", port });
  tcpSockets.add(socket);
  tcpClosures.set(socket, closed);
  socket.on("close", () => {
    tcpSockets.delete(socket);
    resolveClosed();
    if (!unreadStarted) {
      rejectOpen?.(new Error(`WebSocket closed before subscription reset: ${JSON.stringify({ frames, close })}`));
    }
  });
  const connected = new Promise<PausedWebSocket>((resolve, reject) => {
    rejectOpen = reject;
    socket.once("connect", () => {
      socket.write([
        "GET /ws HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: cmVzb3VyY2Utc2FmZXR5IQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    socket.once("error", (error) => {
      if (!opened) reject(error);
    });

    const consumeFrames = () => {
      for (;;) {
        if (frameBytes.byteLength < 2) return;
        const first = frameBytes[0]!;
        const second = frameBytes[1]!;
        if ((second & 0x80) !== 0) throw new Error("server WebSocket frame must not be masked");
        let offset = 2;
        let length = second & 0x7f;
        if (length === 126) {
          if (frameBytes.byteLength < 4) return;
          length = frameBytes.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (frameBytes.byteLength < 10) return;
          const large = frameBytes.readBigUInt64BE(2);
          if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized WebSocket frame");
          length = Number(large);
          offset = 10;
        }
        if (frameBytes.byteLength < offset + length) return;
        const payload = frameBytes.subarray(offset, offset + length);
        frameBytes = frameBytes.subarray(offset + length);
        const opcode = first & 0x0f;
        if (opcode === 1) {
          const frame = parseServerMessage(decode(payload.toString("utf8")));
          frames.push(frame);
          if (frame.t === "welcome" && !subscriptionSent) {
            subscriptionSent = true;
            socket.write(maskedWebSocketFrame({
              v: PROTOCOL_VERSION,
              t: "sub",
              id: 1,
              ref: "items.large",
              args: {},
            }));
          } else if (
            frame.t === "transition" &&
            frame.id === 1 &&
            frame.transition.kind === "reset" &&
            !unreadStarted
          ) {
            unreadStarted = true;
            socket.pause();
            resolve({
              socket,
              resumeAndRead: async () => {
                socket.resume();
                await withTimeout(closed, "paused WebSocket close");
                return { handshake, bytes, frames, close };
              },
            });
          }
        }
        if (opcode === 8) {
          close = {
            code: payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1005,
            reason: payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : "",
          };
          if (!closeAcknowledged) {
            closeAcknowledged = true;
            socket.write(maskedWebSocketFrame(payload, 8));
          }
        }
      }
    };

    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (!opened) {
        handshakeBytes = Buffer.concat([handshakeBytes, chunk]);
        const boundary = handshakeBytes.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        handshake = handshakeBytes.subarray(0, boundary + 4).toString("utf8");
        if (!handshake.startsWith("HTTP/1.1 101")) {
          reject(new Error(`WebSocket handshake failed: ${handshake.trim()}`));
          return;
        }
        frameBytes = handshakeBytes.subarray(boundary + 4);
        handshakeBytes = Buffer.alloc(0);
        opened = true;
        socket.write(maskedWebSocketFrame({
          v: PROTOCOL_VERSION,
          t: "hello",
          clientSessionId: "resource-safety-unread",
          credential: { kind: "anonymous" },
        }));
        consumeFrames();
        return;
      }
      frameBytes = Buffer.concat([frameBytes, chunk]);
      consumeFrames();
    });
  });
  return withTimeout(connected, "paused WebSocket TCP connection");
}

function descriptorSnapshot(pid: number): DescriptorSnapshot {
  const run = (args: string[]): string => {
    const result = Bun.spawnSync(["lsof", "-a", "-p", String(pid), ...args, "-Ff"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`lsof failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString();
  };
  const numericDescriptors = (output: string) =>
    output.split("\n").filter((line) => /^f\d+$/.test(line)).length;
  return {
    open: numericDescriptors(run([])),
    listeners: numericDescriptors(run(["-nP", "-iTCP", "-sTCP:LISTEN"])),
  };
}

interface DescriptorSample extends DescriptorSnapshot {
  readonly timestampMs: number;
}

class DescriptorMonitor {
  readonly #pid: number;
  readonly #intervalMs: number;
  readonly #samples: DescriptorSample[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #failure: Error | undefined;

  constructor(pid: number, intervalMs: number) {
    this.#pid = pid;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    this.sampleNow();
    this.#timer = setInterval(() => {
      try {
        this.sampleNow();
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        this.stop();
      }
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  sampleNow(): DescriptorSample {
    if (this.#failure !== undefined) throw this.#failure;
    const startedAt = Date.now();
    const snapshot = descriptorSnapshot(this.#pid);
    const sample = { ...snapshot, timestampMs: (startedAt + Date.now()) / 2 };
    this.#samples.push(sample);
    return sample;
  }

  samples(): readonly DescriptorSample[] {
    if (this.#failure !== undefined) throw this.#failure;
    return this.#samples;
  }
}

async function settledDescriptorSnapshot(pid: number): Promise<DescriptorSnapshot> {
  const samples: DescriptorSnapshot[] = [];
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = descriptorSnapshot(pid);
    samples.push(current);
    if (
      samples.length >= 3 &&
      samples.slice(-3).every((sample) =>
        sample.open === current.open && sample.listeners === current.listeners
      )
    ) {
      return current;
    }
    await Bun.sleep(DESCRIPTOR_SAMPLE_MS);
  }
  throw new Error(`file descriptors did not settle: ${JSON.stringify(samples)}`);
}

function assertQueueWithinLimits(queue: RuntimeStatus["reader"]["queue"]): void {
  expect(queue.queuedItems).toBeLessThanOrEqual(LIMITS.queueItems);
  expect(queue.queuedBytes).toBeLessThanOrEqual(LIMITS.queueBytes);
  expect(queue.activeFairnessKeys).toBeLessThanOrEqual(queue.queuedItems);
}

function assertResourceCeilings(value: ResourceStatus): void {
  expect(value.connections).toBeLessThanOrEqual(LIMITS.connections);
  expect(value.preHelloConnections).toBeLessThanOrEqual(value.connections);
  expect(value.httpIngress).toBeLessThanOrEqual(LIMITS.operations);
  expect(value.httpFairnessKeys).toBeLessThanOrEqual(value.httpIngress);
  expect(value.outboundBytes).toBeLessThanOrEqual(LIMITS.webSocketBytes);
  expect(value.runtime.connections).toBeLessThanOrEqual(LIMITS.connections);
  expect(value.runtime.activeOperations).toBeLessThanOrEqual(LIMITS.operations);
  expect(value.runtime.activeOperationCallers).toBeLessThanOrEqual(
    value.runtime.activeOperations,
  );
  for (const executor of [
    value.runtime.reader,
    value.runtime.writer,
    value.runtime.reactive.revalidation,
  ]) {
    expect(executor.active).toBeLessThanOrEqual(executor.concurrency);
    assertQueueWithinLimits(executor.queue);
  }
  expect(value.runtime.reactive.revalidation.concurrency).toBe(
    LIMITS.revalidationConcurrency,
  );
  expect(value.runtime.reactive.sharedEntries).toBeLessThanOrEqual(
    LIMITS.sharedSubscriptions,
  );
  expect(value.runtime.reactive.queryListeners).toBeLessThanOrEqual(LIMITS.subscriptions);
  expect(value.runtime.reactive.resultBytes).toBeLessThanOrEqual(LIMITS.sharedResultBytes);
  expect(value.runtime.reactive.historyTransitions).toBeLessThanOrEqual(
    LIMITS.sharedSubscriptions * LIMITS.resumeTransitionsPerStream,
  );
  expect(value.runtime.reactive.historyBytes).toBeLessThanOrEqual(LIMITS.resumeBytes);
  expect(value.runtime.reactive.evaluatingEntries).toBeLessThanOrEqual(
    value.runtime.reactive.sharedEntries,
  );
  expect(value.runtime.publication.items).toBeLessThanOrEqual(LIMITS.publicationItems);
  expect(value.runtime.publication.bytes).toBeLessThanOrEqual(LIMITS.publicationBytes);
  expect(value.runtime.authCaptureBudget.bytes).toBeLessThanOrEqual(LIMITS.webSocketBytes);
  expect(value.runtime.sseBudget.bytes).toBeLessThanOrEqual(LIMITS.sseBytes);
}

function slope(values: readonly number[]): number {
  const mean = (values.length - 1) / 2;
  const denominator = values.reduce((sum, _value, index) => sum + (index - mean) ** 2, 0);
  return values.reduce((sum, value, index) => sum + (index - mean) * value, 0) / denominator;
}

function maximum(values: readonly number[]): number {
  return Math.max(...values);
}

function minimum(values: readonly number[]): number {
  return Math.min(...values);
}

function queueReleased(queue: RuntimeStatus["reader"]["queue"]): boolean {
  return queue.queuedItems === 0 &&
    queue.queuedBytes === 0 &&
    queue.oldestAgeMs === 0 &&
    queue.nextExpiryAtMs === undefined &&
    queue.activeFairnessKeys === 0;
}

function everyNumberIsZero(value: object): boolean {
  return Object.values(value).every((entry) =>
    typeof entry === "number"
      ? entry === 0
      : typeof entry === "object" && entry !== null
        ? everyNumberIsZero(entry)
        : true
  );
}

function telemetryReleased(telemetry: RuntimeStatus["telemetry"]): boolean {
  return telemetry.enabled === false &&
    telemetry.queuedRecords === 0 &&
    telemetry.queuedBytes === 0 &&
    telemetry.oldestAgeMs === 0 &&
    telemetry.metricSeries === 0 &&
    telemetry.traceRetention.activeTraces === 0 &&
    telemetry.traceRetention.completedDecisions === 0 &&
    telemetry.traceRetention.stagedRecords === 0 &&
    telemetry.traceRetention.stagedBytes === 0 &&
    telemetry.localSink.configured === false &&
    telemetry.localSink.inFlight === false &&
    telemetry.localSink.pendingRecords === 0 &&
    telemetry.localSink.pendingBytes === 0 &&
    telemetry.localSink.oldestAgeMs === 0 &&
    telemetry.exporter.configured === false &&
    telemetry.exporter.inFlight === false &&
    everyNumberIsZero(telemetry);
}

function resourcesReleased(value: ResourceStatus): boolean {
  return (
    value.connections === 0 &&
    value.preHelloConnections === 0 &&
    value.httpIngress === 1 &&
    value.httpFairnessKeys === 1 &&
    value.sseAckIngress === 0 &&
    value.sseAckNoops === 0 &&
    value.outboundBytes === 0 &&
    value.runtime.connections === 0 &&
    value.runtime.activeOperations === 0 &&
    value.runtime.activeOperationCallers === 0 &&
    value.runtime.activeSse === 0 &&
    value.runtime.scheduledHandlers === 0 &&
    value.runtime.schedulerArmed === false &&
    value.runtime.reader.active === 0 &&
    queueReleased(value.runtime.reader.queue) &&
    value.runtime.writer.active === 0 &&
    queueReleased(value.runtime.writer.queue) &&
    value.runtime.reactive.sharedEntries === 0 &&
    value.runtime.reactive.queryListeners === 0 &&
    value.runtime.reactive.eventListeners === 0 &&
    value.runtime.reactive.dormantEntries === 0 &&
    value.runtime.reactive.evaluatingEntries === 0 &&
    value.runtime.reactive.revalidation.active === 0 &&
    queueReleased(value.runtime.reactive.revalidation.queue) &&
    value.runtime.reactive.resultBytes === 0 &&
    value.runtime.reactive.historyTransitions === 0 &&
    value.runtime.reactive.historyBytes === 0 &&
    value.runtime.publication.items === 0 &&
    value.runtime.publication.bytes === 0 &&
    value.runtime.publication.oldestAgeMs === 0 &&
    value.runtime.authCaptureBudget.bytes === 0 &&
    value.runtime.authCaptureBudget.applicationBytes === 0 &&
    value.runtime.authCaptureBudget.controlBytes === 0 &&
    value.runtime.sseBudget.bytes === 0 &&
    value.runtime.sseBudget.applicationBytes === 0 &&
    value.runtime.sseBudget.controlBytes === 0 &&
    telemetryReleased(value.runtime.telemetry)
  );
}

function assertResourcesReleased(value: ResourceStatus): void {
  expect(resourcesReleased(value)).toBe(true);
  expect(value).toMatchObject({
    connections: 0,
    preHelloConnections: 0,
    httpIngress: 1,
    httpFairnessKeys: 1,
    sseAckIngress: 0,
    sseAckNoops: 0,
    outboundBytes: 0,
    runtime: {
      connections: 0,
      activeOperations: 0,
      activeOperationCallers: 0,
      activeSse: 0,
      scheduledHandlers: 0,
      schedulerArmed: false,
      reader: { active: 0 },
      writer: { active: 0 },
      reactive: {
        sharedEntries: 0,
        queryListeners: 0,
        eventListeners: 0,
        dormantEntries: 0,
        resultBytes: 0,
        historyTransitions: 0,
        historyBytes: 0,
        evaluatingEntries: 0,
        revalidation: { active: 0 },
      },
      publication: { items: 0, bytes: 0, oldestAgeMs: 0 },
      authCaptureBudget: { bytes: 0, applicationBytes: 0, controlBytes: 0 },
      sseBudget: { bytes: 0, applicationBytes: 0, controlBytes: 0 },
      telemetry: {
        enabled: false,
        queuedRecords: 0,
        queuedBytes: 0,
        oldestAgeMs: 0,
        metricSeries: 0,
        traceRetention: {
          activeTraces: 0,
          completedDecisions: 0,
          stagedRecords: 0,
          stagedBytes: 0,
        },
        localSink: {
          configured: false,
          inFlight: false,
          pendingRecords: 0,
          pendingBytes: 0,
          oldestAgeMs: 0,
        },
        exporter: { configured: false, inFlight: false },
      },
    },
  });
  for (const queue of [
    value.runtime.reader.queue,
    value.runtime.writer.queue,
    value.runtime.reactive.revalidation.queue,
  ]) {
    expect(queue).toMatchObject({
      queuedItems: 0,
      queuedBytes: 0,
      oldestAgeMs: 0,
      activeFairnessKeys: 0,
    });
    expect(queue.nextExpiryAtMs).toBeUndefined();
  }
}

function uuidV7(sequence: number): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

test(
  "bounds an unacknowledged paused SSE receiver and releases every public resource",
  async () => {
    expect(SSE_APPLICATION_FRAME_LIMIT).toBe(1);
    expect(SSE_HTTP_FRAME_LIMIT).toBe(2);
    expect(SSE_HTTP_FRAMING_BYTES).toBe(23);
    const port = await freePort();
    const dir = makeFixture({});
    fixtureDir = dir;
    const processHarness = spawnFixture(dir, port);
    await processHarness.waitForCount("@@ready", 1);
    const base = `http://127.0.0.1:${port}`;
    const initial = await status(base);
    assertResourcesReleased(initial);
    expect(initial).toMatchObject({ sseAckIngress: 0, sseAckNoops: 0 });

    const baselineDescriptors = DESCRIPTOR_MONITOR_AVAILABLE
      ? await settledDescriptorSnapshot(processHarness.child.pid)
      : undefined;
    if (baselineDescriptors !== undefined) expect(baselineDescriptors.listeners).toBe(1);

    const processMonitor = new ProcessTreeMonitor(processHarness.child.pid, PROCESS_SAMPLE_MS);
    monitors.add(processMonitor);
    processMonitor.start();
    const descriptorMonitor = baselineDescriptors === undefined
      ? undefined
      : new DescriptorMonitor(processHarness.child.pid, DESCRIPTOR_SAMPLE_MS);
    if (descriptorMonitor !== undefined) {
      monitors.add(descriptorMonitor);
      descriptorMonitor.start();
    }

    const churn = async (id: number) => {
      const sampleStart = processMonitor.samples().length;
      const descriptorStart = descriptorMonitor?.samples().length;
      processMonitor.sampleNow();
      descriptorMonitor?.sampleNow();
      const paused = await pausedSse({
        port,
        id,
        maxWireBytes: SSE_RESPONSE_WIRE_BYTES,
        timeoutMs: STEP_TIMEOUT_MS,
      });
      tcpSockets.add(paused.socket);
      tcpClosures.set(paused.socket, paused.closed);
      void paused.closed.then(() => {
        tcpSockets.delete(paused.socket);
        tcpClosures.delete(paused.socket);
      });
      expect(paused.headers).toStartWith("HTTP/1.1 200");
      expect(paused.headers.toLowerCase()).toContain("transfer-encoding: chunked");
      expect(paused.headers).toMatch(/\r\nx-dbzz-sse-stream: [^\r\n]+\r\n/i);
      expect(paused.headers.toLowerCase()).toContain(
        `x-dbzz-sse-max-stall-ms: ${SSE_STALL_MS}`,
      );
      const headerBytes = Buffer.byteLength(paused.headers);
      expect(headerBytes).toBeLessThanOrEqual(SSE_HTTP_HEADER_BYTES);

      const open = await eventually(
        () => status(base),
        (value) => value.runtime.activeSse === 1 &&
          value.runtime.sseBudget.applicationBytes > SSE_PAYLOAD_BYTES,
        `paused SSE ${id} to consume its single receiver credit`,
      );
      assertResourceCeilings(open);
      expect(open).toMatchObject({
        httpIngress: 1,
        httpFairnessKeys: 1,
        sseAckIngress: 0,
        sseAckNoops: 0,
        runtime: {
          activeOperations: 1,
          activeOperationCallers: 1,
          activeSse: 1,
        },
      });
      expect(open.runtime.sseBudget.bytes).toBeGreaterThan(0);
      expect(open.runtime.sseBudget.bytes).toBeLessThanOrEqual(LIMITS.sseBytesPerStream);
      expect(open.runtime.sseBudget.bytes).toBeLessThanOrEqual(LIMITS.sseBytes);
      expect(open.runtime.sseBudget.maxBytes).toBe(LIMITS.sseBytes);

      const terminalGrace = await eventually(
        () => status(base),
        (value) => value.runtime.activeSse === 1 &&
          value.runtime.sseBudget.controlBytes > 0 &&
          value.runtime.sseBudget.controlBytes < open.runtime.sseBudget.controlBytes,
        `paused SSE ${id} terminal grace`,
      );
      assertResourceCeilings(terminalGrace);
      expect(terminalGrace).toMatchObject({
        httpIngress: 1,
        httpFairnessKeys: 1,
        sseAckIngress: 0,
        sseAckNoops: 0,
        runtime: {
          activeOperations: 1,
          activeOperationCallers: 1,
          activeSse: 1,
        },
      });
      expect(terminalGrace.runtime.sseBudget.applicationBytes).toBe(
        open.runtime.sseBudget.applicationBytes,
      );
      expect(terminalGrace.runtime.sseBudget.bytes).toBeLessThanOrEqual(
        LIMITS.sseBytesPerStream,
      );

      // Resume while the bounded terminal frame is still in its finite grace
      // window. No ACK endpoint is called before or after this read.
      const wireBodyPromise = paused.resumeAndRead();
      const [wireBody, released] = await Promise.all([
        wireBodyPromise,
        eventually(
          () => status(base),
          resourcesReleased,
          `paused SSE ${id} resources after terminal grace`,
        ),
      ]);
      assertResourceCeilings(released);
      assertResourcesReleased(released);
      expect(released).toMatchObject({ sseAckIngress: 0, sseAckNoops: 0 });

      const decodedBody = decodeChunkedBody(wireBody);
      const framingBytes = wireBody.byteLength - decodedBody.payload.byteLength;
      expect(wireBody.byteLength).toBeGreaterThan(SSE_PAYLOAD_BYTES);
      expect(decodedBody.payload.byteLength).toBeLessThanOrEqual(LIMITS.sseBytesPerStream);
      expect(decodedBody.complete).toBe(true);
      // Bun currently maps each controller.enqueue(Uint8Array) to at most one
      // HTTP transfer chunk: one application enqueue plus one terminal enqueue.
      expect(decodedBody.transferChunks).toBeLessThanOrEqual(SSE_HTTP_FRAME_LIMIT);
      expect(framingBytes).toBeLessThanOrEqual(SSE_HTTP_FRAMING_BYTES);
      expect(wireBody.byteLength).toBeLessThanOrEqual(
        LIMITS.sseBytesPerStream + SSE_HTTP_FRAMING_BYTES,
      );
      expect(headerBytes + wireBody.byteLength).toBeLessThanOrEqual(
        SSE_RESPONSE_WIRE_BYTES,
      );

      const parsed = parseSseBody(decodedBody.payload);
      expect(parsed.remainder).toBe("");
      expect(parsed.frames).toHaveLength(2);
      expect(parsed.frames.filter((frame) => frame.t === "sse_chunk").map((frame) => frame.seq))
        .toEqual([1]);
      expect(parsed.frames[0]).toMatchObject({
        t: "sse_chunk",
        seq: 1,
      });
      const applicationValue = (parsed.frames[0] as { value: { payload: unknown } }).value;
      expect(typeof applicationValue.payload).toBe("string");
      expect(applicationValue.payload as string).toHaveLength(SSE_PAYLOAD_BYTES);
      expect(parsed.frames[1]).toMatchObject({
        t: "sse_error",
        seq: 2,
        outcome: {
          code: "slow_consumer",
          retryable: true,
          resource: "sse",
        },
      });

      expect(await call(base, 10_000 + id, "pressure.collect", {})).toMatchObject({
        status: 200,
        frame: { t: "ok", value: null },
      });
      const descriptorRecovered = baselineDescriptors === undefined
        ? undefined
        : await eventually(
            () => descriptorSnapshot(processHarness.child.pid),
            (snapshot) => snapshot.open === baselineDescriptors.open &&
              snapshot.listeners === baselineDescriptors.listeners,
            `paused SSE ${id} descriptors to recover exactly`,
          );
      if (baselineDescriptors !== undefined) {
        expect(descriptorRecovered).toEqual(baselineDescriptors);
      }
      const recovered = processMonitor.sampleNow();
      descriptorMonitor?.sampleNow();
      const samples = processMonitor.samples().slice(sampleStart);
      const descriptorSamples = descriptorStart === undefined
        ? undefined
        : descriptorMonitor!.samples().slice(descriptorStart);
      expect(samples.length).toBeGreaterThan(2);
      if (baselineDescriptors !== undefined && descriptorSamples !== undefined) {
        expect(maximum(descriptorSamples.map((sample) => sample.open))).toBeLessThanOrEqual(
          baselineDescriptors.open + SSE_DESCRIPTOR_PEAK_DELTA,
        );
        expect(minimum(descriptorSamples.map((sample) => sample.listeners))).toBe(
          baselineDescriptors.listeners,
        );
        expect(maximum(descriptorSamples.map((sample) => sample.listeners))).toBe(
          baselineDescriptors.listeners,
        );
      }
      return {
        rssPeak: maximum(samples.map((sample) => sample.rssMb)),
        rssRecovered: recovered.rssMb,
        sseBytes: maximum([
          open.runtime.sseBudget.bytes,
          terminalGrace.runtime.sseBudget.bytes,
        ]),
        wireBytes: wireBody.byteLength,
        framingBytes,
        transferChunks: decodedBody.transferChunks,
        initialWireBytes: paused.initialWireBytes,
        descriptorPeak: descriptorSamples === undefined
          ? undefined
          : maximum(descriptorSamples.map((sample) => sample.open)),
        descriptorRecovered,
      };
    };

    const rssTrendBudgetMb = LIMITS.sseBytes / (KiB * KiB);
    const linearTrend = (values: readonly number[]) => slope(values) * (values.length - 1);
    const positiveTrend = (values: readonly number[]) => Math.max(0, linearTrend(values));
    const plateauShift = (values: readonly number[]) => {
      const half = values.length / 2;
      const average = (part: readonly number[]) =>
        part.reduce((sum, value) => sum + value, 0) / part.length;
      return Math.abs(average(values.slice(half)) - average(values.slice(0, half)));
    };
    type Epoch = Awaited<ReturnType<typeof churn>>;
    let epochId = 0;
    let rebases = 0;
    let stabilizationRetries = 0;
    const allEpochs: Epoch[] = [];
    const stabilizationStartedAt = Date.now();
    const stabilizationDeadlineAt = stabilizationStartedAt + SSE_MAX_STABILIZATION_MS;
    const stabilizationBudgetError = (reason: string) => new Error(
      `paused SSE exhausted its global stabilization budget: ${JSON.stringify({
        reason,
        epochs: epochId,
        maxEpochs: SSE_MAX_TOTAL_EPOCHS,
        elapsedMs: Date.now() - stabilizationStartedAt,
        maxElapsedMs: SSE_MAX_STABILIZATION_MS,
        rebases,
        stabilizationRetries,
        recovered: allEpochs.map((sample) => sample.rssRecovered),
        peaks: allEpochs.map((sample) => sample.rssPeak),
      })}`,
    );
    const nextEpoch = async () => {
      const remainingMs = stabilizationDeadlineAt - Date.now();
      if (epochId >= SSE_MAX_TOTAL_EPOCHS) throw stabilizationBudgetError("epoch cap");
      if (remainingMs <= 0) throw stabilizationBudgetError("wall-time cap");
      const id = ++epochId;
      try {
        const sample = await withTimeout(
          churn(id),
          `paused SSE epoch ${id}`,
          Math.min(SSE_EPOCH_TIMEOUT_MS, remainingMs),
        );
        allEpochs.push(sample);
        return sample;
      } catch (error) {
        if (Date.now() >= stabilizationDeadlineAt) {
          throw stabilizationBudgetError("wall-time cap");
        }
        throw error;
      }
    };
    const settle = async (seed: readonly Epoch[]) => {
      let warmup = [...seed];
      let candidate: {
        readonly recoveredMinimum: number;
        readonly recoveredTolerance: number;
        readonly peakMinimum: number;
        readonly peakTolerance: number;
      } | undefined;
      for (;;) {
        const sample = await nextEpoch();
        if (
          candidate !== undefined &&
          (sample.rssRecovered < candidate.recoveredMinimum - candidate.recoveredTolerance ||
            sample.rssPeak < candidate.peakMinimum - candidate.peakTolerance)
        ) {
          rebases++;
          warmup = [sample];
          candidate = undefined;
          continue;
        }
        warmup.push(sample);
        if (warmup.length < SSE_STABILITY_EPOCHS) continue;
        const plateau = warmup.slice(-SSE_STABILITY_EPOCHS);
        const recovered = plateau.map((sample) => sample.rssRecovered);
        const peaks = plateau.map((sample) => sample.rssPeak);
        // Comparing half-window means rejects allocator descent while allowing
        // normal page-level sample ordering inside one settled plateau.
        if (
          plateauShift(recovered) <= rssTrendBudgetMb &&
          plateauShift(peaks) <= rssTrendBudgetMb
        ) {
          candidate = {
            recoveredMinimum: minimum(recovered),
            recoveredTolerance: maximum(recovered) - minimum(recovered) + rssTrendBudgetMb,
            peakMinimum: minimum(peaks),
            peakTolerance: maximum(peaks) - minimum(peaks) + rssTrendBudgetMb,
          };
          if (
            warmup.length >= SSE_MIN_WARMUP_EPOCHS &&
            positiveTrend(recovered) <= rssTrendBudgetMb &&
            positiveTrend(peaks) <= rssTrendBudgetMb
          ) {
            return { warmup, plateau };
          }
        }
      }
    };

    const metricProof = (measuredValues: readonly number[], settledValues: readonly number[]) => {
      const settledVariability = maximum(settledValues) - minimum(settledValues);
      const tolerance = settledVariability + rssTrendBudgetMb;
      const spread = maximum(measuredValues) - minimum(measuredValues);
      const firstLast = Math.abs(measuredValues.at(-1)! - measuredValues[0]!);
      const growthTrend = positiveTrend(measuredValues);
      const maximumAllowed = maximum(settledValues) + tolerance;
      return {
        settledVariability,
        tolerance,
        spread,
        firstLast,
        growthTrend,
        maximum: maximum(measuredValues),
        maximumAllowed,
      };
    };
    const proofAccepted = (proof: ReturnType<typeof metricProof>) =>
      proof.spread <= proof.tolerance &&
      proof.firstLast <= proof.tolerance &&
      proof.maximum <= proof.maximumAllowed &&
      proof.growthTrend <= rssTrendBudgetMb;
    const assertMetricProof = (proof: ReturnType<typeof metricProof>) => {
      expect(proof.spread).toBeLessThanOrEqual(proof.tolerance);
      expect(proof.firstLast).toBeLessThanOrEqual(proof.tolerance);
      expect(proof.maximum).toBeLessThanOrEqual(proof.maximumAllowed);
      expect(proof.growthTrend).toBeLessThanOrEqual(rssTrendBudgetMb);
    };

    let seed: readonly Epoch[] = [];
    let settled!: Awaited<ReturnType<typeof settle>>;
    let measured!: Epoch[];
    let recoveredProof!: ReturnType<typeof metricProof>;
    let peakProof!: ReturnType<typeof metricProof>;
    for (;;) {
      settled = await settle(seed);
      const warmRecovered = settled.plateau.map((sample) => sample.rssRecovered);
      const warmPeaks = settled.plateau.map((sample) => sample.rssPeak);
      const recoveredTolerance = maximum(warmRecovered) - minimum(warmRecovered) +
        rssTrendBudgetMb;
      const peakTolerance = maximum(warmPeaks) - minimum(warmPeaks) + rssTrendBudgetMb;
      measured = [];
      let lowerPlateau: Epoch | undefined;
      for (let epoch = 0; epoch < MEASURED_EPOCHS; epoch++) {
        const sample = await nextEpoch();
        if (
          sample.rssRecovered < minimum(warmRecovered) - recoveredTolerance ||
          sample.rssPeak < minimum(warmPeaks) - peakTolerance
        ) {
          lowerPlateau = sample;
          break;
        }
        measured.push(sample);
      }
      if (lowerPlateau !== undefined) {
        rebases++;
        seed = [lowerPlateau];
        continue;
      }
      recoveredProof = metricProof(
        measured.map((epoch) => epoch.rssRecovered),
        warmRecovered,
      );
      peakProof = metricProof(measured.map((epoch) => epoch.rssPeak), warmPeaks);
      if (proofAccepted(recoveredProof) && proofAccepted(peakProof)) break;

      // A measured window that still moves becomes additional warmup. A true
      // leak can never pass the unchanged proof and exhausts the one global cap.
      stabilizationRetries++;
      seed = [...settled.plateau, ...measured];
    }
    processMonitor.stop();
    descriptorMonitor?.stop();

    const warmupPlateauRecovered = settled.plateau.map((epoch) => epoch.rssRecovered);
    const warmupPlateauPeaks = settled.plateau.map((epoch) => epoch.rssPeak);
    const measuredRecoveredRss = measured.map((epoch) => epoch.rssRecovered);
    const measuredPeakRss = measured.map((epoch) => epoch.rssPeak);
    assertMetricProof(recoveredProof);
    assertMetricProof(peakProof);
    expect(processMonitor.samples()[0]!.rssKind).toBe(PROCESS_TREE_RSS_KIND);
    const maxMeasuredSseBytes = maximum(measured.map((epoch) => epoch.sseBytes));
    const maxMeasuredWireBytes = maximum(measured.map((epoch) => epoch.wireBytes));
    console.log("@@sse-resource-proof", encode({
      totalEpochs: epochId,
      stabilizationElapsedMs: Date.now() - stabilizationStartedAt,
      rebases,
      stabilizationRetries,
      warmupPlateauRecovered,
      warmupPlateauPeaks,
      measuredPostGcRss: measuredRecoveredRss,
      measuredPeakRss,
      recoveredProof,
      peakProof,
      rssTrendBudgetMb,
      maxMeasuredSseBytes,
      maxMeasuredWireBytes,
      maxMeasuredFramingBytes: maximum(measured.map((epoch) => epoch.framingBytes)),
      maxTransferChunks: maximum(measured.map((epoch) => epoch.transferChunks)),
      descriptors: baselineDescriptors === undefined
        ? undefined
        : {
            baseline: baselineDescriptors,
            measuredPeaks: measured.map((epoch) => epoch.descriptorPeak),
            measuredRecovered: measured.map((epoch) => epoch.descriptorRecovered),
          },
    }));
    expect(maxMeasuredSseBytes).toBeLessThanOrEqual(LIMITS.sseBytesPerStream);
    expect(maxMeasuredWireBytes).toBeLessThanOrEqual(
      LIMITS.sseBytesPerStream + SSE_HTTP_FRAMING_BYTES,
    );
    expect(maximum(allEpochs.map((epoch) => epoch.initialWireBytes))).toBeLessThanOrEqual(
      LIMITS.sseBytesPerStream + SSE_HTTP_FRAMING_BYTES,
    );
    expect(tcpSockets.size).toBe(0);
    expect(tcpClosures.size).toBe(0);
    const final = await eventually(
      () => status(base),
      resourcesReleased,
      "all paused SSE resources to remain released",
    );
    assertResourcesReleased(final);
    expect(final).toMatchObject({ sseAckIngress: 0, sseAckNoops: 0 });
    if (baselineDescriptors !== undefined) {
      const finalDescriptors = await eventually(
        () => descriptorSnapshot(processHarness.child.pid),
        (snapshot) => snapshot.open === baselineDescriptors.open &&
          snapshot.listeners === baselineDescriptors.listeners,
        "paused SSE descriptors to return exactly to their settled baseline",
      );
      expect(finalDescriptors).toEqual(baselineDescriptors);
    }

    processHarness.child.kill("SIGTERM");
    expect(await withTimeout(processHarness.child.exited, "paused SSE fixture shutdown")).toBe(0);
    await withTimeout(processHarness.drained, "paused SSE fixture output drain");
  },
  SSE_TEST_TIMEOUT_MS,
);

const processResourceTest = process.platform === "darwin" && Bun.which("lsof") !== null
  ? test
  : test.skip;

processResourceTest(
  "bounds combined pressure and reaches a process-resource plateau (macOS ps+lsof)",
  async () => {
  const port = await freePort();
  const dir = makeFixture({});
  fixtureDir = dir;
  const processHarness = spawnFixture(dir, port);
  await processHarness.waitForCount("@@ready", 1);
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // Warm every measured path so the baseline excludes one-time module/JIT work.
  const warm = await connectWebSocket(wsUrl);
  warm.send({ v: PROTOCOL_VERSION, t: "sub", id: 1, ref: "items.list", args: {} });
  expect(await withTimeout(warm.next(), "warm subscription reset")).toMatchObject({
    t: "transition",
    id: 1,
    transition: { kind: "reset", value: [] },
  });
  expect(await call(base, 1, "pressure.echo", { value: 1 })).toMatchObject({
    status: 200,
    frame: { t: "ok", value: 1 },
  });
  warm.socket.close();
  await withTimeout(warm.closed(), "warm WebSocket close");
  const warmReleased = await eventually(
    () => status(base),
    resourcesReleased,
    "warm resources to be released",
  );
  assertResourcesReleased(warmReleased);

  const baselineRss = snapshotProcessTree(processHarness.child.pid);
  const baselineDescriptors = descriptorSnapshot(processHarness.child.pid);
  expect(baselineRss.rssKind).toBe(PROCESS_TREE_RSS_KIND);
  expect(baselineDescriptors.listeners).toBe(1);

  const first = await connectWebSocket(wsUrl);
  const second = await connectWebSocket(wsUrl);
  const third = await connectWebSocket(wsUrl);
  first.send({ v: PROTOCOL_VERSION, t: "sub", id: 1, ref: "items.list", args: {} });
  second.send({ v: PROTOCOL_VERSION, t: "sub", id: 1, ref: "items.list", args: {} });
  for (const client of [first, second]) {
    expect(await withTimeout(client.next(), "subscription reset")).toMatchObject({
      t: "transition",
      id: 1,
      transition: { kind: "reset", value: [] },
    });
  }

  first.send({ v: PROTOCOL_VERSION, t: "sub", id: 2, ref: "items.list", args: {} });
  expect(await withTimeout(first.next(), "subscription overload")).toMatchObject({
    t: "err",
    id: 2,
    outcome: {
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "subscription",
    },
  });

  third.send({
    v: PROTOCOL_VERSION,
    t: "m",
    id: 1,
    ref: "items.add",
    args: { sequence: 1 },
    mutationRequestId: uuidV7(1),
    issuedAt: Date.now(),
  });
  for (const client of [first, second]) {
    expect(await withTimeout(client.next(), "subscription revalidation")).toMatchObject({
      t: "transition",
      id: 1,
      transition: {
        kind: "update",
        value: [{ id: 1n, sequence: 1, payload: "row-1" }],
      },
    });
  }
  expect(await withTimeout(third.next(), "mutation acknowledgement")).toMatchObject({
    t: "ok",
    id: 1,
    kind: "mutation",
  });

  const blockControllers = Array.from({ length: 4 }, () => new AbortController());
  const blockers: Promise<unknown>[] = blockControllers.slice(0, 2).map((controller, index) =>
    call(base, 10 + index, "pressure.block", {}, `block-${index}`, controller.signal).catch(
      (error: unknown) => error,
    ));
  await processHarness.waitForCount("@@block-start", 2);

  const unread = await pausedWebSocket(port);
  await processHarness.waitForCount("@@large-eval", 1);

  const connectionExcess = await fetch(`${base}/ws`, {
    headers: { connection: "close" },
  });
  expect(connectionExcess.status).toBe(503);
  expect(parseCallResponse(decode(await connectionExcess.text()))).toMatchObject({
    t: "err",
    id: null,
    outcome: {
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
    },
  });
  const combinedStatus = await status(base);
  assertResourceCeilings(combinedStatus);
  expect(combinedStatus).toMatchObject({
    connections: 4,
    runtime: {
      activeOperations: 2,
      reactive: { queryListeners: 3, sharedEntries: 2 },
    },
  });

  first.send({ v: PROTOCOL_VERSION, t: "unsub", id: 1 });
  second.send({ v: PROTOCOL_VERSION, t: "unsub", id: 1 });
  const unreadOnlyStatus = await eventually(
    () => status(base),
    (value) => value.runtime.reactive.queryListeners === 1 &&
      value.runtime.reactive.sharedEntries === 1,
    "unread WebSocket to own the remaining subscription",
  );
  assertResourceCeilings(unreadOnlyStatus);
  expect(unreadOnlyStatus.runtime.reactive.sharedEntries).toBe(1);

  // The other sockets have no subscriptions and every mutation acknowledgement
  // is consumed before sampling, so top-level outboundBytes belongs to this one
  // unread sink and is simultaneously its per-connection ownership.
  const unreadOutboundSamples: number[] = [unreadOnlyStatus.outboundBytes];
  let pressureSequence = 1;
  while (maximum(unreadOutboundSamples) === 0 && pressureSequence < 512) {
    pressureSequence++;
    third.send({
      v: PROTOCOL_VERSION,
      t: "m",
      id: pressureSequence,
      ref: "items.add",
      args: { sequence: pressureSequence },
      mutationRequestId: uuidV7(pressureSequence),
      issuedAt: Date.now(),
    });
    expect(await withTimeout(third.next(), `pressure mutation ${pressureSequence}`)).toMatchObject({
      t: "ok",
      id: pressureSequence,
      kind: "mutation",
    });
    await processHarness.waitForCount("@@large-eval", pressureSequence);
    const pressureStatus = await status(base);
    assertResourceCeilings(pressureStatus);
    expect(pressureStatus.runtime.reactive.queryListeners).toBe(1);
    expect(pressureStatus.runtime.reactive.sharedEntries).toBe(1);
    expect(pressureStatus.outboundBytes).toBeLessThanOrEqual(
      LIMITS.webSocketBytesPerConnection,
    );
    unreadOutboundSamples.push(pressureStatus.outboundBytes);
  }
  expect(processHarness.output().split("@@large-eval").length - 1).toBe(pressureSequence);
  expect(maximum(unreadOutboundSamples)).toBeGreaterThan(0);
  expect(unreadOutboundSamples.every(
    (bytes) => bytes <= LIMITS.webSocketBytesPerConnection && bytes <= LIMITS.webSocketBytes,
  )).toBe(true);

  for (let index = 2; index < 4; index++) {
    blockers.push(call(
      base,
      10 + index,
      "pressure.block",
      {},
      `block-${index}`,
      blockControllers[index]!.signal,
    ).catch((error: unknown) => error));
  }
  await processHarness.waitForCount("@@block-start", 4);

  third.send({ v: PROTOCOL_VERSION, t: "q", id: 2, ref: "items.list", args: {} });
  expect(await withTimeout(third.next(), "operation overload")).toMatchObject({
    t: "err",
    id: 2,
    outcome: {
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "operation",
    },
  });

  expect(await call(base, 20, "pressure.echo", { value: 20 })).toEqual({
    status: 503,
    frame: expect.objectContaining({
      t: "err",
      id: null,
      outcome: expect.objectContaining({
        code: "overloaded",
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      }),
    }),
  });

  blockControllers[3]!.abort("leave one public status slot");
  await processHarness.waitForCount("@@block-abort", 1);
  await blockers[3];
  const saturatedStatus = await status(base);
  assertResourceCeilings(saturatedStatus);
  expect(saturatedStatus.runtime).toMatchObject({
    activeOperations: 3,
    activeOperationCallers: 3,
  });

  const processMonitor = new ProcessTreeMonitor(processHarness.child.pid, PROCESS_SAMPLE_MS);
  const descriptorMonitor = new DescriptorMonitor(
    processHarness.child.pid,
    DESCRIPTOR_SAMPLE_MS,
  );
  monitors.add(processMonitor);
  monitors.add(descriptorMonitor);
  processMonitor.start();
  descriptorMonitor.start();

  const overloadEpoch = async (from: number) => {
    const processStart = processMonitor.samples().length;
    const descriptorStart = descriptorMonitor.samples().length;
    processMonitor.sampleNow();
    descriptorMonitor.sampleNow();
    const openingStatus = await status(base);
    assertResourceCeilings(openingStatus);
    expect(openingStatus.runtime).toMatchObject({
      activeOperations: 3,
      activeOperationCallers: 3,
    });

    for (let batch = 0; batch < 4; batch++) {
      const ids = Array.from({ length: 8 }, (_, offset) => from + batch * 8 + offset);
      const requests = ids.map((id, offset) =>
        call(base, id, "pressure.echo", { value: offset }, "pressure"));

      // The fixture's pressure verifier holds the one admitted source lease for
      // 50ms. This sample is inside that deterministic in-flight window while
      // the seven same-source peers are being rejected.
      await Bun.sleep(10);
      processMonitor.sampleNow();
      descriptorMonitor.sampleNow();
      const results = await Promise.all(requests);
      const callerRejected = results.filter((result) => result.status === 429);
      const sourceRejected = results.filter((result) => result.status === 503);
      expect(callerRejected).toHaveLength(1);
      expect(sourceRejected).toHaveLength(7);
      expect(ids).toContain(callerRejected[0]!.frame.id!);
      expect(callerRejected[0]).toMatchObject({
        status: 429,
        frame: {
          t: "err",
          outcome: {
            code: "overloaded",
            retryable: true,
            retryAfterMs: 0,
            resource: "operation",
          },
        },
      });
      for (const result of sourceRejected) {
        expect(result).toMatchObject({
          status: 503,
          frame: {
            t: "err",
            id: null,
            outcome: {
              code: "overloaded",
              retryable: true,
              retryAfterMs: 0,
              resource: "connection",
            },
          },
        });
      }

      const batchStatus = await status(base);
      assertResourceCeilings(batchStatus);
      expect(batchStatus.runtime).toMatchObject({
        activeOperations: 3,
        activeOperationCallers: 3,
      });
    }

    processMonitor.sampleNow();
    descriptorMonitor.sampleNow();
    const processSamples = processMonitor.samples().slice(processStart);
    const descriptorSamples = descriptorMonitor.samples().slice(descriptorStart);
    return {
      rssMinimum: minimum(processSamples.map((sample) => sample.rssMb)),
      rssPeak: maximum(processSamples.map((sample) => sample.rssMb)),
      descriptorsPeak: maximum(descriptorSamples.map((sample) => sample.open)),
      listenersMinimum: minimum(descriptorSamples.map((sample) => sample.listeners)),
      listenersPeak: maximum(descriptorSamples.map((sample) => sample.listeners)),
    };
  };

  const warmupEpochs = [];
  for (let epoch = 0; epoch < WARMUP_EPOCHS; epoch++) {
    warmupEpochs.push(await overloadEpoch(100 + epoch * 100));
  }
  const measuredEpochs = [];
  for (let epoch = 0; epoch < MEASURED_EPOCHS; epoch++) {
    measuredEpochs.push(await overloadEpoch(1_000 + epoch * 100));
  }
  processMonitor.stop();
  descriptorMonitor.stop();

  const warmupRssPeaks = warmupEpochs.map((epoch) => epoch.rssPeak);
  const warmupRssMinimums = warmupEpochs.map((epoch) => epoch.rssMinimum);
  const rssPeaks = measuredEpochs.map((epoch) => epoch.rssPeak);
  const warmupRssVariability = maximum(warmupRssPeaks) - minimum(warmupRssMinimums);
  const rssPeakToleranceMb = warmupRssVariability + DECLARED_RETAINED_MB;
  const rssRecoveryToleranceMb = Math.max(
    0,
    maximum(warmupRssPeaks) - baselineRss.rssMb,
  ) + rssPeakToleranceMb;
  const rssStepGrowth = maximum([
    0,
    ...rssPeaks.slice(1).map((value, index) => value - rssPeaks[index]!),
  ]);
  const measuredRssGrowth = rssPeaks.at(-1)! - rssPeaks[0]!;
  const measuredRssTrend = slope(rssPeaks) * (MEASURED_EPOCHS - 1);

  // A positive fitted trend may consume at most one declared retained-byte
  // budget across the whole window; it cannot grow once per epoch indefinitely.
  expect(measuredRssTrend).toBeLessThanOrEqual(DECLARED_RETAINED_MB);
  expect(rssStepGrowth).toBeLessThanOrEqual(rssPeakToleranceMb);
  expect(measuredRssGrowth).toBeLessThanOrEqual(rssPeakToleranceMb);
  expect(rssPeaks.at(-1)).toBeLessThanOrEqual(
    maximum(warmupRssPeaks) + rssPeakToleranceMb,
  );

  const warmupDescriptorPeaks = warmupEpochs.map((epoch) => epoch.descriptorsPeak);
  const descriptorPeaks = measuredEpochs.map((epoch) => epoch.descriptorsPeak);
  const warmupDescriptorVariability = maximum(warmupDescriptorPeaks) -
    minimum(warmupDescriptorPeaks);
  expect(maximum(descriptorPeaks)).toBeLessThanOrEqual(
    maximum(warmupDescriptorPeaks) + warmupDescriptorVariability,
  );
  expect(descriptorPeaks.at(-1)!).toBeLessThanOrEqual(descriptorPeaks[0]!);
  expect(slope(descriptorPeaks)).toBeLessThanOrEqual(0);
  for (const epoch of [...warmupEpochs, ...measuredEpochs]) {
    expect(epoch.listenersMinimum).toBe(baselineDescriptors.listeners);
    expect(epoch.listenersPeak).toBe(baselineDescriptors.listeners);
  }

  const unreadResult = await unread.resumeAndRead();
  expect(unreadResult.handshake).toStartWith("HTTP/1.1 101");
  expect(unreadResult.frames).toContainEqual(expect.objectContaining({
    t: "welcome",
    clientSessionId: "resource-safety-unread",
  }));
  expect(unreadResult.frames).toContainEqual(expect.objectContaining({
    t: "transition",
    id: 1,
    transition: expect.objectContaining({ kind: "reset" }),
  }));
  expect(unreadResult.frames).toContainEqual(expect.objectContaining({
    t: "err",
    id: null,
    outcome: expect.objectContaining({
      code: "slow_consumer",
      retryable: true,
      resource: "outbound",
    }),
  }));
  expect(unreadResult.close).toEqual({
    code: 1013,
    reason: "slow_consumer",
  });
  expect(unreadResult.bytes).toBeGreaterThan(64 * 1024);

  await eventually(
    async () => {
      const response = await fetch(`${base}/ws`, { headers: { connection: "close" } });
      await response.arrayBuffer();
      return response.status;
    },
    (value) => value === 400,
    "unread WebSocket connection slot to be released",
  );

  for (const controller of blockControllers) controller.abort("test release");
  await processHarness.waitForCount("@@block-abort", 4);
  await Promise.all(blockers);
  for (const client of [first, second, third]) client.socket.close();
  await Promise.all([first.closed(), second.closed(), third.closed()].map(
    (closed) => withTimeout(closed, "WebSocket close"),
  ));

  const finalStatus = await eventually(
    () => status(base),
    resourcesReleased,
    "all bounded resources to be released",
  );
  assertResourcesReleased(finalStatus);
  const finalDescriptors = await eventually(
    () => descriptorSnapshot(processHarness.child.pid),
    (value) => value.open === baselineDescriptors.open &&
      value.listeners === baselineDescriptors.listeners,
    "file descriptors to return exactly to baseline",
  );
  const finalRss = snapshotProcessTree(processHarness.child.pid);

  expect(finalDescriptors.open).toBe(baselineDescriptors.open);
  expect(finalDescriptors.listeners).toBe(baselineDescriptors.listeners);
  expect(finalRss.rssMb).toBeLessThanOrEqual(
    baselineRss.rssMb + rssRecoveryToleranceMb,
  );

  processHarness.child.kill("SIGTERM");
  expect(await withTimeout(processHarness.child.exited, "fixture shutdown")).toBe(0);
  await withTimeout(processHarness.drained, "fixture output drain");
},
  TEST_TIMEOUT_MS,
);
