import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseServerMessage,
  parseSseMessage,
  type SseMessage,
} from "@dbzz/core";
import {
  BoundedSseProducer,
  OutboundBudget,
  WebSocketSessionSink,
  type DeliveryClock,
  type DeliveryObservation,
  type WebSocketDeliverySocket,
} from "../src/delivery.ts";
import { DbzzError } from "../src/errors.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../src/limits.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function testLimits(overrides: {
  maxFrameBytes?: number;
  webSocket?: Partial<ServiceLimits["webSocket"]>;
  sse?: Partial<ServiceLimits["sse"]>;
} = {}): ServiceLimits {
  return {
    ...PRODUCTION_LIMITS,
    maxFrameBytes: overrides.maxFrameBytes ?? 256,
    webSocket: {
      maxBytesPerConnection: 1_024,
      maxBytes: 4_096,
      maxStallMs: 20,
      ...overrides.webSocket,
    },
    sse: {
      maxBytesPerStream: 512,
      maxBytes: 4_096,
      maxStallMs: 20,
      ...overrides.sse,
    },
  };
}

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

class FakeClock implements DeliveryClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (due === undefined) break;
      this.timers.delete(due.id);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

interface SendPlan {
  readonly result: number;
  readonly buffered?: number;
}

class FakeSocket implements WebSocketDeliverySocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  readonly plans: SendPlan[] = [];
  bufferedAmount = 0;

  send(data: string): number {
    this.sent.push(data);
    const plan = this.plans.shift();
    if (plan === undefined) {
      this.bufferedAmount = 0;
      return encoder.encode(data).byteLength;
    }
    this.bufferedAmount =
      plan.buffered ??
      (plan.result === -1 ? this.bufferedAmount + encoder.encode(data).byteLength : 0);
    return plan.result;
  }

  getBufferedAmount(): number {
    return this.bufferedAmount;
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

function application(id: number, value: unknown = `value-${id}`) {
  return { v: PROTOCOL_VERSION, t: "ok" as const, id, kind: "query" as const, value };
}

async function state(promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  let result: "pending" | "resolved" | "rejected" = "pending";
  void promise.then(
    () => {
      result = "resolved";
    },
    () => {
      result = "rejected";
    },
  );
  await Promise.resolve();
  return result;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return chunks;
      chunks.push(decoder.decode(part.value));
    }
  } finally {
    reader.releaseLock();
  }
}

function sseMessage(chunk: Uint8Array | string): SseMessage {
  const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
  expect(text).toStartWith("data: ");
  expect(text).toEndWith("\n\n");
  return parseSseMessage(decode(text.slice(6, -2)));
}

async function flushObservations(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function expectSafeObservations(observations: readonly DeliveryObservation[]): void {
  const safeFields = new Set([
    "transport",
    "stage",
    "lane",
    "source",
    "bytes",
    "durationMs",
    "outcome",
    "terminalOutcome",
    "droppedObservations",
  ]);
  for (const observation of observations) {
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.keys(observation).every((field) => safeFields.has(field))).toBe(true);
    expect(Number.isSafeInteger(observation.bytes)).toBe(true);
    expect(observation.bytes).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(observation.durationMs)).toBe(true);
    expect(observation.durationMs).toBeGreaterThanOrEqual(0);
    if (observation.droppedObservations !== undefined) {
      expect(Number.isSafeInteger(observation.droppedObservations)).toBe(true);
      expect(observation.droppedObservations).toBeGreaterThan(0);
    }
  }
}

describe("OutboundBudget", () => {
  test("accounts exact bytes and keeps application traffic outside the control reserve", () => {
    const budget = new OutboundBudget(100, 20);
    const first = budget.reserve(70, "application");
    expect(first).not.toBeNull();
    expect(budget.reserve(11, "application")).toBeNull();
    const control = budget.reserve(20, "control");
    expect(control).not.toBeNull();
    expect(budget.snapshot()).toMatchObject({
      bytes: 90,
      applicationBytes: 70,
      controlBytes: 20,
    });

    first!.release(30);
    expect(first!.remainingBytes).toBe(40);
    expect(budget.snapshot().bytes).toBe(60);
    first!.release();
    control!.release();
    expect(budget.snapshot().bytes).toBe(0);
  });
});

describe("WebSocketSessionSink", () => {
  test("observes exact queue wait and full buffered delivery for both lanes", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const observations: DeliveryObservation[] = [];
    const message = application(1, "💥");
    const messageText = encode(message);
    const messageBytes = encoder.encode(messageText).byteLength;
    const control = { v: PROTOCOL_VERSION, t: "pong" as const };
    const controlBytes = encoder.encode(encode(control)).byteLength;
    socket.plans.push(
      { result: -1, buffered: messageBytes },
      { result: -1, buffered: messageBytes - 1 + controlBytes },
    );
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });

    await sink.sendApplication(1, message);
    const controlAccepted = sink.sendControl(control);
    await flushObservations();
    expect(observations.filter(({ stage }) => stage === "delivery")).toEqual([]);

    clock.advance(3);
    socket.bufferedAmount = messageBytes - 1;
    sink.onDrain();
    await controlAccepted;
    await flushObservations();
    expect(observations.filter(({ stage }) => stage === "delivery")).toEqual([]);

    clock.advance(4);
    socket.bufferedAmount = 0;
    sink.onDrain();
    await flushObservations();

    expect(observations).toEqual([
      {
        transport: "websocket",
        stage: "encoding",
        lane: "application",
        source: "send",
        bytes: messageBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "websocket",
        stage: "queue",
        lane: "application",
        source: "send",
        bytes: messageBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "websocket",
        stage: "encoding",
        lane: "control",
        source: "send",
        bytes: controlBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "websocket",
        stage: "queue",
        lane: "control",
        source: "send",
        bytes: controlBytes,
        durationMs: 3,
        outcome: "ok",
      },
      {
        transport: "websocket",
        stage: "delivery",
        lane: "application",
        source: "send",
        bytes: messageBytes,
        durationMs: 7,
        outcome: "ok",
      },
      {
        transport: "websocket",
        stage: "delivery",
        lane: "control",
        source: "send",
        bytes: controlBytes,
        durationMs: 4,
        outcome: "ok",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("reports stale drops and terminal release outcomes at their owning stage", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const observations: DeliveryObservation[] = [];
    const first = application(1);
    const firstBytes = encoder.encode(encode(first)).byteLength;
    socket.plans.push({ result: -1, buffered: firstBytes });
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });

    await sink.sendApplication(1, first);
    const stale = sink.sendApplication(1, application(2));
    const current = sink.sendApplication(2, application(3));
    clock.advance(2);
    await sink.dropApplicationFramesBefore(2);
    await stale;
    clock.advance(3);
    await sink.close({
      code: "draining",
      retryable: true,
      message: "service draining",
      resource: "connection",
    });
    await expect(current).rejects.toMatchObject({ code: "unavailable" });
    await flushObservations();

    const queueOutcomes = observations
      .filter(({ stage }) => stage === "queue")
      .map(({ outcome, durationMs }) => ({ outcome, durationMs }));
    expect(queueOutcomes).toEqual([
      { outcome: "ok", durationMs: 0 },
      { outcome: "dropped", durationMs: 2 },
      { outcome: "draining", durationMs: 5 },
    ]);
    expect(observations.filter(({ stage }) => stage === "delivery")).toEqual([
      {
        transport: "websocket",
        stage: "delivery",
        lane: "application",
        source: "send",
        bytes: firstBytes,
        durationMs: 5,
        outcome: "draining",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("keeps socket send failures in the queue stage and observes the terminal control frame", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const observations: DeliveryObservation[] = [];
    const message = application(1);
    const messageBytes = encoder.encode(encode(message)).byteLength;
    socket.plans.push({ result: 0 }, { result: 0 });
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });

    await expect(sink.sendApplication(1, message)).rejects.toMatchObject({ code: "unavailable" });
    await flushObservations();

    expect(observations.filter(({ lane }) => lane === "application")).toEqual([
      {
        transport: "websocket",
        stage: "encoding",
        lane: "application",
        source: "send",
        bytes: messageBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "websocket",
        stage: "queue",
        lane: "application",
        source: "send",
        bytes: messageBytes,
        durationMs: 0,
        outcome: "unavailable",
      },
    ]);
    const terminalBytes = encoder.encode(socket.sent.at(-1)!).byteLength;
    expect(observations.filter(({ source }) => source === "terminal")).toEqual([
      {
        transport: "websocket",
        stage: "encoding",
        lane: "control",
        source: "terminal",
        bytes: terminalBytes,
        durationMs: 0,
        outcome: "ok",
        terminalOutcome: "unavailable",
      },
      {
        transport: "websocket",
        stage: "queue",
        lane: "control",
        source: "terminal",
        bytes: terminalBytes,
        durationMs: 0,
        outcome: "ok",
        terminalOutcome: "unavailable",
      },
      {
        transport: "websocket",
        stage: "delivery",
        lane: "control",
        source: "terminal",
        bytes: terminalBytes,
        durationMs: 0,
        outcome: "unavailable",
        terminalOutcome: "unavailable",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("sends FIFO and accounts UTF-8 encoded bytes until Bun drain", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const first = application(1, "💥");
    const firstText = encode(first);
    const firstBytes = encoder.encode(firstText).byteLength;
    socket.plans.push({ result: -1, buffered: firstBytes });
    const sink = new WebSocketSessionSink({ socket, budget, limits });

    const accepted = sink.sendApplication(1, first);
    const later = sink.sendControl({ v: PROTOCOL_VERSION, t: "pong" });
    await expect(accepted).resolves.toBeUndefined();
    expect(await state(later)).toBe("pending");
    expect(socket.sent).toEqual([firstText]);
    expect(sink.snapshot()).toMatchObject({ blocked: true, bufferedBytes: firstBytes });
    expect(budget.snapshot().bytes).toBeGreaterThan(firstBytes);

    socket.bufferedAmount = 0;
    sink.onDrain();
    await expect(later).resolves.toBeUndefined();
    expect(socket.sent).toEqual([firstText, encode({ v: PROTOCOL_VERSION, t: "pong" })]);
    expect(sink.snapshot()).toMatchObject({ queuedBytes: 0, bufferedBytes: 0, blocked: false });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("drops only unaccepted stale application epochs without disturbing FIFO", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const firstText = encode(application(1));
    socket.plans.push({ result: -1, buffered: encoder.encode(firstText).byteLength });
    const sink = new WebSocketSessionSink({ socket, budget, limits });

    const accepted = sink.sendApplication(1, application(1));
    const stale = sink.sendApplication(1, application(2));
    const current = sink.sendApplication(2, application(3));
    await accepted;
    expect(await state(stale)).toBe("pending");
    await sink.dropApplicationFramesBefore(2);
    await expect(stale).resolves.toBeUndefined();
    expect(await state(current)).toBe("pending");

    socket.bufferedAmount = 0;
    sink.onDrain();
    await expect(current).resolves.toBeUndefined();
    expect(socket.sent).toEqual([firstText, encode(application(3))]);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("reserves control capacity and closes a per-connection overflow as slow_consumer", async () => {
    const limits = testLimits({
      maxFrameBytes: 128,
      webSocket: { maxBytesPerConnection: 512, maxBytes: 4_096 },
    });
    const budget = new OutboundBudget(limits.webSocket.maxBytes, 512);
    const socket = new FakeSocket();
    const observations: DeliveryObservation[] = [];
    const message = application(1, "x".repeat(45));
    const frameBytes = encoder.encode(encode(message)).byteLength;
    const capacity = limits.webSocket.maxBytesPerConnection - limits.maxFrameBytes;
    socket.plans.push({ result: -1, buffered: frameBytes });
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      observer: (observation) => observations.push(observation),
    });

    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < Math.floor(capacity / frameBytes); index++) {
      writes.push(sink.sendApplication(1, { ...message, id: index + 1 }).catch((error) => error));
    }
    const overflow = sink.sendApplication(1, { ...message, id: 99 });
    await expect(overflow).rejects.toMatchObject({ code: "slow_consumer", resource: "outbound" });
    await Promise.all(writes);
    await flushObservations();

    expect(socket.closes).toEqual([{ code: 1013, reason: "slow_consumer" }]);
    const terminal = decode(socket.sent.at(-1)!) as { t: string; outcome: { code: string } };
    expect(terminal).toMatchObject({ t: "err", outcome: { code: "slow_consumer" } });
    expect(observations).toContainEqual(expect.objectContaining({
      stage: "queue",
      lane: "application",
      outcome: "slow_consumer",
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      stage: "delivery",
      lane: "application",
      outcome: "slow_consumer",
    }));
    expect(observations.filter(({ source }) => source === "terminal").map(({ stage, terminalOutcome }) => ({
      stage,
      terminalOutcome,
    }))).toEqual([
      { stage: "encoding", terminalOutcome: "slow_consumer" },
      { stage: "queue", terminalOutcome: "slow_consumer" },
      { stage: "delivery", terminalOutcome: "slow_consumer" },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("fits a tight all-emoji WebSocket terminal to a nonempty public fallback", () => {
    const fallback = {
      v: PROTOCOL_VERSION,
      t: "err" as const,
      id: null,
      outcome: {
        code: "unsupported_protocol" as const,
        retryable: true,
        message: "err",
        retryAfterMs: 30_000,
        resource: "subscription" as const,
      },
    };
    const maxFrameBytes = encoder.encode(encode(fallback)).byteLength;
    const limits = testLimits({ maxFrameBytes });
    const budget = new OutboundBudget(limits.webSocket.maxBytes, maxFrameBytes);
    const socket = new FakeSocket();
    const sink = new WebSocketSessionSink({ socket, budget, limits });
    const error = new DbzzError("unsupported_protocol", "💥".repeat(512), {
      retryable: true,
      retryAfterMs: 30_000,
      resource: "subscription",
    });

    Reflect.get(sink, "fail").call(sink, error);

    expect(socket.sent).toHaveLength(1);
    expect(encoder.encode(socket.sent[0]!).byteLength).toBe(maxFrameBytes);
    expect(parseServerMessage(decode(socket.sent[0]!))).toEqual(fallback);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("counts queued control frames when enforcing the per-connection application limit", async () => {
    const limits = testLimits({
      maxFrameBytes: 128,
      webSocket: { maxBytesPerConnection: 512, maxBytes: 4_096 },
    });
    const budget = new OutboundBudget(limits.webSocket.maxBytes, 512);
    const socket = new FakeSocket();
    const control = { v: PROTOCOL_VERSION, t: "pong" as const };
    const controlBytes = encoder.encode(encode(control)).byteLength;
    socket.plans.push({ result: -1, buffered: controlBytes });
    const sink = new WebSocketSessionSink({ socket, budget, limits });
    const writes: Promise<unknown>[] = [];

    for (let index = 0; index < Math.floor(limits.webSocket.maxBytesPerConnection / controlBytes); index++) {
      writes.push(sink.sendControl(control).catch((error) => error));
    }
    expect(sink.snapshot().controlBytes).toBe(
      Math.floor(limits.webSocket.maxBytesPerConnection / controlBytes) * controlBytes,
    );
    expect(sink.snapshot().controlBytes).toBeLessThanOrEqual(limits.webSocket.maxBytesPerConnection);

    await expect(sink.sendApplication(1, application(1))).rejects.toMatchObject({
      code: "slow_consumer",
      resource: "outbound",
    });
    await Promise.all(writes);
    expect(socket.closes).toEqual([{ code: 1013, reason: "slow_consumer" }]);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("reports shared-budget exhaustion as overloaded without affecting another sink", async () => {
    const limits = testLimits({
      maxFrameBytes: 256,
      webSocket: { maxBytesPerConnection: 2_048, maxBytes: 600 },
    });
    const budget = new OutboundBudget(600, 256);
    const busySocket = new FakeSocket();
    const healthySocket = new FakeSocket();
    const message = application(1, "x".repeat(90));
    const frameBytes = encoder.encode(encode(message)).byteLength;
    busySocket.plans.push({ result: -1, buffered: frameBytes });
    const busy = new WebSocketSessionSink({ socket: busySocket, budget, limits });
    const healthy = new WebSocketSessionSink({ socket: healthySocket, budget, limits });

    const held = [
      busy.sendApplication(1, message).catch((error) => error),
      busy.sendApplication(1, { ...message, id: 2 }).catch((error) => error),
    ];
    await Promise.resolve();
    await expect(busy.sendApplication(1, { ...message, id: 3 })).rejects.toMatchObject({
      code: "overloaded",
      resource: "outbound",
    });
    await Promise.all(held);
    expect(busySocket.closes[0]).toEqual({ code: 1013, reason: "overloaded" });

    await expect(healthy.sendControl({ v: PROTOCOL_VERSION, t: "pong" })).resolves.toBeUndefined();
    expect(healthySocket.sent).toEqual([encode({ v: PROTOCOL_VERSION, t: "pong" })]);
    expect(healthySocket.closes).toEqual([]);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("resets the finite stall deadline only when buffered bytes make progress", async () => {
    const clock = new FakeClock();
    const limits = testLimits({ webSocket: { maxStallMs: 10 } });
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const text = encode(application(1));
    const bytes = encoder.encode(text).byteLength;
    socket.plans.push({ result: -1, buffered: bytes });
    const sink = new WebSocketSessionSink({ socket, budget, limits, clock });

    await sink.sendApplication(1, application(1));
    clock.advance(9);
    expect(socket.closes).toEqual([]);
    socket.bufferedAmount = Math.floor(bytes / 2);
    sink.onDrain();
    clock.advance(9);
    expect(socket.closes).toEqual([]);
    clock.advance(1);
    expect(socket.closes).toEqual([{ code: 1013, reason: "slow_consumer" }]);
    expect(budget.snapshot().bytes).toBe(0);
  });
});

describe("BoundedSseProducer", () => {
  test("retains exact bytes across pulls and releases frames only through a cumulative proof", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    producer.write({ text: "first" });
    producer.write({ text: "💥" });
    const reader = producer.stream.getReader();
    const firstBytes = (await reader.read()).value!;
    const secondBytes = (await reader.read()).value!;
    const first = sseMessage(firstBytes);
    const second = sseMessage(secondBytes);
    expect(first).toMatchObject({ t: "sse_chunk", seq: 1, value: { text: "first" } });
    expect(second).toMatchObject({ t: "sse_chunk", seq: 2, value: { text: "💥" } });
    expect(first.proof).not.toBe(second.proof);
    const applicationBytes = firstBytes.byteLength + secondBytes.byteLength;
    expect(producer.snapshot()).toMatchObject({
      unackedBytes: applicationBytes,
      unackedFrames: 2,
      state: "open",
    });
    expect(budget.snapshot().applicationBytes).toBe(applicationBytes);

    const completion = producer.complete();
    await Promise.resolve();
    expect(await state(completion)).toBe("pending");
    expect(producer.snapshot()).toMatchObject({ unackedFrames: 2, state: "open" });

    clock.advance(5);
    expect(producer.ack(second.seq, second.proof)).toBe(true);
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0 });
    expect(budget.snapshot().applicationBytes).toBe(0);

    await Promise.resolve();
    expect(await state(completion)).toBe("pending");
    const doneBytes = (await reader.read()).value!;
    const done = sseMessage(doneBytes);
    expect(done).toMatchObject({ t: "sse_done", seq: 3 });
    expect(producer.snapshot()).toMatchObject({
      unackedBytes: doneBytes.byteLength,
      unackedFrames: 1,
      state: "ending",
    });
    clock.advance(2);
    producer.ack(done.seq, done.proof);
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    await flushObservations();

    expect(observations.filter(({ stage }) => stage === "delivery")).toEqual([
      expect.objectContaining({ source: "write", bytes: firstBytes.byteLength, durationMs: 5 }),
      expect.objectContaining({ source: "write", bytes: secondBytes.byteLength, durationMs: 5 }),
      expect.objectContaining({ source: "terminal", bytes: doneBytes.byteLength, durationMs: 2 }),
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("rejects one remaining direct-write byte before traversing the next value", async () => {
    const probeLimits = testLimits();
    const probeBudget = new OutboundBudget(probeLimits.sse.maxBytes, 512);
    const probe = new BoundedSseProducer({ budget: probeBudget, limits: probeLimits });
    const value = { text: "exact window" };
    probe.write(value);
    const frameBytes = probe.snapshot().unackedBytes;
    const controlBytes = probe.controlReserveBytes;
    await probe.stream.cancel("probe complete");

    const limits = testLimits({
      sse: { maxBytesPerStream: controlBytes + frameBytes + 1 },
    });
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    producer.write(value);
    expect(producer.snapshot().unackedBytes).toBe(
      limits.sse.maxBytesPerStream - producer.controlReserveBytes - 1,
    );

    let traversals = 0;
    const unread = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        traversals++;
        return Number.NaN;
      },
    });
    expect(() => producer.write(unread)).toThrow(DbzzError);
    expect(traversals).toBe(0);

    const reader = producer.stream.getReader();
    const application = sseMessage((await reader.read()).value!);
    const terminal = sseMessage((await reader.read()).value!);
    expect([application.seq, terminal.seq]).toEqual([1, 2]);
    expect(terminal).toMatchObject({ t: "sse_error", outcome: { code: "slow_consumer" } });
    expect(producer.ack(terminal.seq, terminal.proof)).toBe(true);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("preflights exhausted sequences and too-small frame limits before value traversal", async () => {
    const regularLimits = testLimits();
    const budget = new OutboundBudget(regularLimits.sse.maxBytes, 512);
    const exhausted = new BoundedSseProducer({ budget, limits: regularLimits });
    Reflect.set(exhausted, "nextSequence", Number.MAX_SAFE_INTEGER);
    Reflect.set(exhausted, "acknowledgedSequence", Number.MAX_SAFE_INTEGER - 1);
    let sequenceTraversals = 0;
    const sequenceValue = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        sequenceTraversals++;
        return "unreachable";
      },
    });
    expect(() => exhausted.write(sequenceValue)).toThrow("sequence space exhausted");
    expect(sequenceTraversals).toBe(0);
    const exhaustedReader = exhausted.stream.getReader();
    const exhaustedTerminal = sseMessage((await exhaustedReader.read()).value!);
    expect(exhaustedTerminal.seq).toBe(Number.MAX_SAFE_INTEGER);
    exhausted.ack(exhaustedTerminal.seq, exhaustedTerminal.proof);
    expect((await exhaustedReader.read()).done).toBe(true);
    exhaustedReader.releaseLock();

    const narrowLimits = testLimits({ maxFrameBytes: 1 });
    const narrow = new BoundedSseProducer({ budget, limits: narrowLimits });
    let frameTraversals = 0;
    const frameValue = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        frameTraversals++;
        return "unreachable";
      },
    });
    expect(() => narrow.write(frameValue)).toThrow("event envelope exceeds maxFrameBytes");
    expect(frameTraversals).toBe(0);
    const narrowReader = narrow.stream.getReader();
    const narrowTerminal = sseMessage((await narrowReader.read()).value!);
    expect(narrowTerminal).toMatchObject({ t: "sse_error", outcome: { code: "overloaded" } });
    narrow.ack(narrowTerminal.seq, narrowTerminal.proof);
    expect((await narrowReader.read()).done).toBe(true);
    narrowReader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("rejects zero-HWM merge overload before source pull or traversal", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    const held = budget.reserve(budget.availableBytes("application"), "application");
    if (held === null) throw new Error("failed to reserve the global application window");
    let pulls = 0;
    let traversals = 0;
    const unread = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        traversals++;
        return "unreachable";
      },
    });
    const merged = producer.merge(new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(unread);
      },
    }, { highWaterMark: 0 }));

    await expect(merged).rejects.toMatchObject({ code: "overloaded", resource: "sse" });
    expect({ pulls, traversals }).toEqual({ pulls: 0, traversals: 0 });
    const reader = producer.stream.getReader();
    const terminal = sseMessage((await reader.read()).value!);
    producer.ack(terminal.seq, terminal.proof);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    held.release();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("does not traverse a direct value or a resolved merge value after termination", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const direct = new BoundedSseProducer({ budget, limits });
    direct.fail(new DbzzError("unavailable", "closed", { resource: "sse" }));
    let directTraversals = 0;
    const directValue = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        directTraversals++;
        return Number.NaN;
      },
    });
    expect(() => direct.write(directValue)).toThrow("closed");
    expect(directTraversals).toBe(0);
    const directReader = direct.stream.getReader();
    const directTerminal = sseMessage((await directReader.read()).value!);
    direct.ack(directTerminal.seq, directTerminal.proof);
    expect((await directReader.read()).done).toBe(true);
    directReader.releaseLock();

    let sourceController!: ReadableStreamDefaultController<unknown>;
    const merged = new BoundedSseProducer({ budget, limits });
    const mergeCompletion = merged.merge(new ReadableStream({
      start(controller) {
        sourceController = controller;
      },
    }));
    await Promise.resolve();
    let mergeTraversals = 0;
    const mergeValue = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        mergeTraversals++;
        return Number.NaN;
      },
    });
    sourceController.enqueue(mergeValue);
    merged.fail(new DbzzError("unavailable", "stopped", { resource: "sse" }));
    await expect(mergeCompletion).rejects.toThrow("stopped");
    expect(mergeTraversals).toBe(0);
    const mergeReader = merged.stream.getReader();
    const mergeTerminal = sseMessage((await mergeReader.read()).value!);
    merged.ack(mergeTerminal.seq, mergeTerminal.proof);
    expect((await mergeReader.read()).done).toBe(true);
    mergeReader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("fails a merge read race before encoding when a direct write consumes its credit", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    let sourceController!: ReadableStreamDefaultController<unknown>;
    const merged = producer.merge(new ReadableStream({
      start(controller) {
        sourceController = controller;
      },
    }));
    await Promise.resolve();

    producer.write({ value: "direct race winner" });
    let traversals = 0;
    const unread = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get() {
        traversals++;
        return Number.NaN;
      },
    });
    sourceController.enqueue(unread);
    await expect(merged).rejects.toMatchObject({ code: "slow_consumer" });
    expect(traversals).toBe(0);

    const reader = producer.stream.getReader();
    const application = sseMessage((await reader.read()).value!);
    const terminal = sseMessage((await reader.read()).value!);
    expect([application.seq, terminal.seq]).toEqual([1, 2]);
    expect(producer.ack(terminal.seq, terminal.proof)).toBe(true);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("does not pull or encode a merge frame until the previous frame is acknowledged", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    const first = { text: "a".repeat(80) };
    const mergedChunk = { text: "b".repeat(80) };
    producer.write(first);
    const reader = producer.stream.getReader();
    const firstFrame = sseMessage((await reader.read()).value!);
    const merged = producer.merge(new ReadableStream({
      start(controller) {
        controller.enqueue(mergedChunk);
        controller.close();
      },
    }));
    await Promise.resolve();
    expect(await state(merged)).toBe("pending");

    clock.advance(6);
    producer.ack(firstFrame.seq, firstFrame.proof);
    const mergedBytes = (await reader.read()).value!;
    const mergedFrame = sseMessage(mergedBytes);
    clock.advance(4);
    producer.ack(mergedFrame.seq, mergedFrame.proof);
    await merged;
    reader.releaseLock();
    await producer.stream.cancel("test complete");
    await flushObservations();

    expect(observations.filter(({ source }) => source === "merge")).toEqual([
      {
        transport: "sse",
        stage: "encoding",
        lane: "application",
        source: "merge",
        bytes: mergedBytes.byteLength,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "queue",
        lane: "application",
        source: "merge",
        bytes: mergedBytes.byteLength,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "delivery",
        lane: "application",
        source: "merge",
        bytes: mergedBytes.byteLength,
        durationMs: 4,
        outcome: "ok",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("cancels a merge credit wait before it pulls, traverses, or retains source data", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    producer.write({ text: "a".repeat(80) });
    const mergedChunk = { text: "b".repeat(80) };
    const merged = producer.merge(new ReadableStream({
      start(controller) {
        controller.enqueue(mergedChunk);
      },
    }));
    await Promise.resolve();

    clock.advance(2);
    await producer.stream.cancel("consumer stopped");
    await expect(merged).rejects.toMatchObject({ code: "unavailable" });
    await flushObservations();

    expect(observations.filter(({ source }) => source === "merge")).toEqual([]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("a merge waiting for credit cannot consume the next terminal sequence", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    producer.write({ text: "a".repeat(80) });
    const reader = producer.stream.getReader();
    const first = sseMessage((await reader.read()).value!);
    const merged = producer.merge(new ReadableStream({
      start(controller) {
        controller.enqueue({ text: "b".repeat(80) });
      },
    }));
    await Promise.resolve();
    expect(await state(merged)).toBe("pending");

    expect(() => producer.write({ text: "c".repeat(80) })).toThrow(DbzzError);
    const terminal = sseMessage((await reader.read()).value!);
    expect([first.seq, terminal.seq]).toEqual([1, 2]);
    expect(terminal).toMatchObject({ t: "sse_error", outcome: { code: "slow_consumer" } });
    expect(producer.ack(terminal.seq, terminal.proof)).toBe(true);
    await expect(merged).rejects.toMatchObject({ code: "slow_consumer" });
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("reports cancellation as failed delivery and releases capacity once", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    const chunk = { value: "held" };

    producer.write(chunk);
    const bytes = producer.snapshot().unackedBytes;
    clock.advance(3);
    await producer.stream.cancel("consumer stopped");
    await flushObservations();

    expect(observations.filter(({ stage }) => stage === "delivery")).toEqual([
      {
        transport: "sse",
        stage: "delivery",
        lane: "application",
        source: "write",
        bytes,
        durationMs: 3,
        outcome: "unavailable",
      },
    ]);
    expectSafeObservations(observations);
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("range-checks acknowledgments and cumulatively releases without mutating rejected proofs", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    producer.write({ text: "first held after Bun pull" });
    producer.write({ text: "second held after Bun pull" });
    const reader = producer.stream.getReader();
    const first = sseMessage((await reader.read()).value!);
    const second = sseMessage((await reader.read()).value!);
    const held = producer.snapshot();
    const heldBudget = budget.snapshot();
    expect(held.unackedBytes).toBeGreaterThan(0);
    expect(producer.ack(Number.MAX_SAFE_INTEGER, second.proof)).toBe(false);
    expect(producer.ack(second.seq + 0.5, second.proof)).toBe(false);
    expect(producer.ack(second.seq + 1, second.proof)).toBe(false);
    expect(producer.ack(second.seq, "A".repeat(second.proof.length))).toBe(false);
    expect(producer.snapshot()).toEqual(held);
    expect(budget.snapshot()).toEqual(heldBudget);

    expect(producer.ack(second.seq, second.proof)).toBe(true);
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0 });
    expect(producer.ack(first.seq, first.proof)).toBe(false);
    expect(producer.ack(second.seq, second.proof)).toBe(false);
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0 });
    reader.releaseLock();
    await producer.stream.cancel("test complete");
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("queues failure behind owned application bytes and terminal ACK releases both", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    producer.write({ value: "before failure" });
    producer.fail(new DbzzError("internal", "handler failed"));
    const completion = producer.complete();
    expect(await state(completion)).toBe("pending");

    const reader = producer.stream.getReader();
    const chunk = sseMessage((await reader.read()).value!);
    const terminal = sseMessage((await reader.read()).value!);
    expect(chunk.t).toBe("sse_chunk");
    expect(terminal).toMatchObject({ t: "sse_error", outcome: { code: "internal" } });
    expect(producer.snapshot()).toMatchObject({ state: "ending", unackedFrames: 2 });

    producer.ack(terminal.seq, terminal.proof);
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(producer.snapshot()).toMatchObject({ state: "closed", unackedBytes: 0, unackedFrames: 0 });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("keeps a completion raced by failure pending through terminal ACK or force-close", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const acknowledged = new BoundedSseProducer({ budget, limits });
    acknowledged.write({ value: "before failure" });
    const acknowledgedCompletion = acknowledged.complete();
    acknowledged.fail(new DbzzError("internal", "handler failed"));
    expect(await state(acknowledgedCompletion)).toBe("pending");
    const acknowledgedReader = acknowledged.stream.getReader();
    const application = sseMessage((await acknowledgedReader.read()).value!);
    const terminal = sseMessage((await acknowledgedReader.read()).value!);
    expect([application.seq, terminal.seq]).toEqual([1, 2]);
    expect(await state(acknowledgedCompletion)).toBe("pending");
    acknowledged.ack(terminal.seq, terminal.proof);
    await acknowledgedCompletion;
    expect((await acknowledgedReader.read()).done).toBe(true);
    acknowledgedReader.releaseLock();

    const clock = new FakeClock();
    const stalledLimits = testLimits({ sse: { maxStallMs: 10 } });
    const forced = new BoundedSseProducer({ budget, limits: stalledLimits, clock });
    forced.write({ value: "never acknowledged" });
    const forcedCompletion = forced.complete();
    const forcedReader = forced.stream.getReader();
    expect(sseMessage((await forcedReader.read()).value!).t).toBe("sse_chunk");
    clock.advance(10);
    expect(sseMessage((await forcedReader.read()).value!)).toMatchObject({
      t: "sse_error",
      outcome: { code: "slow_consumer" },
    });
    expect(await state(forcedCompletion)).toBe("pending");
    clock.advance(9);
    expect(await state(forcedCompletion)).toBe("pending");
    clock.advance(1);
    await expect(forcedCompletion).rejects.toMatchObject({ code: "slow_consumer" });
    await expect(forcedReader.read()).rejects.toMatchObject({ code: "slow_consumer" });
    forcedReader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("queues a reserved error after one ACK stall and force-cleans it after one terminal grace", async () => {
    const clock = new FakeClock();
    const limits = testLimits({ sse: { maxStallMs: 10 } });
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    producer.write({ text: "unread" });
    const reader = producer.stream.getReader();
    const chunk = sseMessage((await reader.read()).value!);
    expect(chunk.t).toBe("sse_chunk");

    clock.advance(9);
    expect(producer.snapshot().state).toBe("open");
    clock.advance(1);
    expect(producer.signal.aborted).toBe(true);
    expect(producer.signal.reason).toMatchObject({ code: "slow_consumer", resource: "sse" });
    expect(producer.snapshot()).toMatchObject({ state: "ending", unackedFrames: 2 });
    const terminal = sseMessage((await reader.read()).value!);
    expect(terminal).toMatchObject({
      t: "sse_error",
      outcome: { code: "slow_consumer", resource: "sse" },
    });
    clock.advance(9);
    expect(producer.snapshot().state).toBe("ending");
    expect(budget.snapshot().bytes).toBeGreaterThan(0);
    clock.advance(1);
    expect(producer.snapshot()).toMatchObject({ state: "closed", unackedBytes: 0, unackedFrames: 0 });
    await expect(reader.read()).rejects.toMatchObject({ code: "slow_consumer" });
    reader.releaseLock();
    await flushObservations();
    expect(observations.filter(({ source }) => source === "terminal").map((observation) => ({
      stage: observation.stage,
      lane: observation.lane,
      outcome: observation.outcome,
      terminalOutcome: observation.terminalOutcome,
    }))).toEqual([
      {
        stage: "encoding",
        lane: "control",
        outcome: "ok",
        terminalOutcome: "slow_consumer",
      },
      {
        stage: "queue",
        lane: "control",
        outcome: "ok",
        terminalOutcome: "slow_consumer",
      },
      {
        stage: "delivery",
        lane: "control",
        outcome: "slow_consumer",
        terminalOutcome: "slow_consumer",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("fails a synchronous producer at the local byte limit without exceeding it", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    const chunk = { text: "x".repeat(55) };
    let writes = 0;
    for (;;) {
      try {
        producer.write(chunk);
        writes++;
      } catch (error) {
        expect(error).toBeInstanceOf(DbzzError);
        break;
      }
    }
    expect(writes).toBeGreaterThan(0);
    expect(producer.signal.reason).toMatchObject({ code: "slow_consumer" });
    expect(producer.snapshot().unackedBytes).toBeLessThanOrEqual(limits.sse.maxBytesPerStream);

    const reader = producer.stream.getReader();
    const frames: SseMessage[] = [];
    for (let index = 0; index < writes + 1; index++) {
      frames.push(sseMessage((await reader.read()).value!));
    }
    expect(frames.at(-1)).toMatchObject({
      t: "sse_error",
      outcome: { code: "slow_consumer", resource: "sse" },
    });
    expect(frames.map(({ seq }) => seq)).toEqual(
      Array.from({ length: writes + 1 }, (_, index) => index + 1),
    );
    clock.advance(limits.sse.maxStallMs);
    await expect(reader.read()).rejects.toMatchObject({ code: "slow_consumer" });
    reader.releaseLock();
    await flushObservations();
    expect(observations.filter(({ lane, source }) =>
      lane === "application" && source === "write"
    )).toHaveLength(writes * 3);
    expect(observations.some(({ lane, source, outcome }) =>
      lane === "application" && source === "write" && outcome !== "ok"
    )).toBe(true);
    expect(observations.filter(({ source }) => source === "terminal")).toHaveLength(3);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("distinguishes global overload and leaves a separate producer bounded", async () => {
    const limits = testLimits({ sse: { maxBytes: 600 } });
    const budget = new OutboundBudget(600, 200);
    const first = new BoundedSseProducer({ budget, limits });
    const second = new BoundedSseProducer({ budget, limits });
    const chunk = { text: "x".repeat(55) };
    first.write(chunk);

    expect(() => second.write(chunk)).toThrow(DbzzError);
    expect(second.signal.reason).toMatchObject({ code: "overloaded", resource: "sse" });
    expect(budget.snapshot().bytes).toBeLessThanOrEqual(600);
    const secondReader = second.stream.getReader();
    const terminal = sseMessage((await secondReader.read()).value!);
    expect(terminal).toMatchObject({ t: "sse_error", outcome: { code: "overloaded" } });
    second.ack(terminal.seq, terminal.proof);
    expect((await secondReader.read()).done).toBe(true);
    secondReader.releaseLock();

    await first.stream.cancel("test cleanup");
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("admits only globally terminal-safe streams and delivers simultaneous worst-case errors", async () => {
    const probeLimits = testLimits();
    const probeBudget = new OutboundBudget(probeLimits.sse.maxBytes, 512);
    const probe = new BoundedSseProducer({ budget: probeBudget, limits: probeLimits });
    const terminalBytes = probe.controlReserveBytes;
    await probe.stream.cancel("probe complete");
    expect(probeBudget.snapshot().bytes).toBe(0);

    const maximumActive = 4;
    const maxBytes = terminalBytes * maximumActive;
    const limits = testLimits({ sse: { maxBytes } });
    const budget = new OutboundBudget(maxBytes, terminalBytes);
    const producers = Array.from(
      { length: maximumActive },
      () => new BoundedSseProducer({ budget, limits }),
    );
    expect(budget.snapshot()).toMatchObject({
      bytes: maxBytes,
      applicationBytes: 0,
      controlBytes: maxBytes,
    });

    let admissionError: unknown;
    try {
      new BoundedSseProducer({ budget, limits });
    } catch (error) {
      admissionError = error;
    }
    expect(admissionError).toBeInstanceOf(DbzzError);
    expect(admissionError).toMatchObject({
      code: "overloaded",
      retryable: true,
      resource: "sse",
      message: "global SSE control byte limit exceeded",
    });

    const worstCase = new DbzzError("convergence_unavailable", "x".repeat(512), {
      committed: true,
      resource: "subscription",
    });
    for (const producer of producers) producer.fail(worstCase);
    expect(budget.snapshot()).toMatchObject({
      bytes: maxBytes,
      applicationBytes: 0,
      controlBytes: maxBytes,
    });

    for (const producer of producers) {
      const reader = producer.stream.getReader();
      const part = (await reader.read()).value!;
      expect(part.byteLength).toBe(terminalBytes);
      const terminal = sseMessage(part);
      expect(terminal).toMatchObject({
        t: "sse_error",
        outcome: {
          code: "convergence_unavailable",
          committed: true,
          resource: "subscription",
        },
      });
      producer.ack(terminal.seq, terminal.proof);
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    }
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("round-trips nonempty fallback messages for empty and tight all-emoji terminals", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);

    const empty = new BoundedSseProducer({ budget, limits });
    empty.fail(new DbzzError("unavailable", "", { resource: "sse" }));
    const emptyReader = empty.stream.getReader();
    const emptyTerminal = sseMessage((await emptyReader.read()).value!);
    expect(emptyTerminal).toMatchObject({
      t: "sse_error",
      outcome: { code: "unavailable", message: "err" },
    });
    empty.ack(emptyTerminal.seq, emptyTerminal.proof);
    expect((await emptyReader.read()).done).toBe(true);
    emptyReader.releaseLock();

    const tight = new BoundedSseProducer({ budget, limits });
    Reflect.set(tight, "nextSequence", Number.MAX_SAFE_INTEGER);
    Reflect.set(tight, "acknowledgedSequence", Number.MAX_SAFE_INTEGER - 1);
    tight.fail(new DbzzError("unsupported_protocol", "💥".repeat(512), {
      retryable: true,
      retryAfterMs: 30_000,
      resource: "subscription",
    }));
    const tightReader = tight.stream.getReader();
    const tightBytes = (await tightReader.read()).value!;
    const tightTerminal = sseMessage(tightBytes);
    expect(tightBytes.byteLength).toBe(tight.controlReserveBytes);
    expect(tightTerminal).toMatchObject({
      t: "sse_error",
      outcome: {
        code: "unsupported_protocol",
        retryable: true,
        retryAfterMs: 30_000,
        resource: "subscription",
        message: "err",
      },
    });
    tight.ack(tightTerminal.seq, tightTerminal.proof);
    expect((await tightReader.read()).done).toBe(true);
    tightReader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("allows one pressure-aware merge, completes in order, and rejects concurrent merges", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = new ReadableStream<unknown>({
      async start(controller) {
        controller.enqueue({ n: 1 });
        await gate;
        controller.enqueue({ n: 2 });
        controller.close();
      },
    });
    const merged = producer.merge(source);
    expect(() => producer.merge(new ReadableStream())).toThrow("only one SSE merge");
    const reader = producer.stream.getReader();
    const first = sseMessage((await reader.read()).value!);
    expect(first).toMatchObject({ t: "sse_chunk", value: { n: 1 } });
    producer.ack(first.seq, first.proof);
    release();
    const second = sseMessage((await reader.read()).value!);
    expect(second).toMatchObject({ t: "sse_chunk", value: { n: 2 } });
    producer.ack(second.seq, second.proof);
    await merged;
    const completion = producer.complete();
    const done = sseMessage((await reader.read()).value!);
    expect(done.t).toBe("sse_done");
    producer.ack(done.seq, done.proof);
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("pull cancellation and external abort free every reservation exactly once", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const external = new AbortController();
    const producer = new BoundedSseProducer({ budget, limits, signal: external.signal });
    producer.write({ value: "held" });
    expect(budget.snapshot().bytes).toBeGreaterThan(0);
    external.abort("request disconnected");
    expect(producer.signal.aborted).toBe(true);
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);

    const canceled = new BoundedSseProducer({ budget, limits });
    canceled.write({ value: "held" });
    await canceled.stream.cancel("consumer stopped");
    expect(canceled.signal.aborted).toBe(true);
    expect(canceled.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("closes a pending SSE pull cleanly when the HTTP request is canceled", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const external = new AbortController();
    const producer = new BoundedSseProducer({ budget, limits, signal: external.signal });
    const reader = producer.stream.getReader();
    const pending = reader.read();

    external.abort(new DbzzError("unavailable", "operation was canceled", {
      resource: "operation",
    }));

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });
});

describe("delivery observers", () => {
  test("keeps coalesced observations with the observer captured once per frame", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const firstObservations: DeliveryObservation[] = [];
    const secondObservations: DeliveryObservation[] = [];
    const firstObserver = (observation: DeliveryObservation) => firstObservations.push(observation);
    const secondObserver = (observation: DeliveryObservation) => secondObservations.push(observation);
    let currentObserver = firstObserver;
    let captures = 0;
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      clock,
      captureObserver: () => {
        captures++;
        return currentObserver;
      },
    });
    const first = application(1, "first");
    const second = application(2, "second response");
    const firstBytes = encoder.encode(encode(first)).byteLength;
    const secondBytes = encoder.encode(encode(second)).byteLength;

    const firstSend = sink.sendApplication(1, first);
    currentObserver = secondObserver;
    const secondSend = sink.sendApplication(1, second);

    expect(firstObservations).toEqual([]);
    expect(secondObservations).toEqual([]);
    await Promise.all([firstSend, secondSend]);
    await flushObservations();

    expect(captures).toBe(2);
    expect(firstObservations.map(({ stage, bytes }) => ({ stage, bytes }))).toEqual([
      { stage: "encoding", bytes: firstBytes },
      { stage: "queue", bytes: firstBytes },
      { stage: "delivery", bytes: firstBytes },
    ]);
    expect(secondObservations.map(({ stage, bytes }) => ({ stage, bytes }))).toEqual([
      { stage: "encoding", bytes: secondBytes },
      { stage: "queue", bytes: secondBytes },
      { stage: "delivery", bytes: secondBytes },
    ]);
    expectSafeObservations([...firstObservations, ...secondObservations]);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("retains the frame observer through delayed WebSocket drain", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const ownerObservations: DeliveryObservation[] = [];
    const unrelatedObservations: DeliveryObservation[] = [];
    const owner = (observation: DeliveryObservation) => ownerObservations.push(observation);
    const unrelated = (observation: DeliveryObservation) => unrelatedObservations.push(observation);
    let currentObserver = owner;
    let captures = 0;
    const message = application(1, "buffered");
    const bytes = encoder.encode(encode(message)).byteLength;
    socket.plans.push({ result: -1, buffered: bytes });
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      clock,
      captureObserver: () => {
        captures++;
        return currentObserver;
      },
    });

    const accepted = sink.sendApplication(1, message);
    currentObserver = unrelated;
    await accepted;
    await flushObservations();
    expect(ownerObservations.map(({ stage }) => stage)).toEqual(["encoding", "queue"]);
    expect(unrelatedObservations).toEqual([]);

    clock.advance(7);
    socket.bufferedAmount = 0;
    sink.onDrain();
    await flushObservations();

    expect(captures).toBe(1);
    expect(ownerObservations.map(({ stage, durationMs }) => ({ stage, durationMs }))).toEqual([
      { stage: "encoding", durationMs: 0 },
      { stage: "queue", durationMs: 0 },
      { stage: "delivery", durationMs: 7 },
    ]);
    expect(unrelatedObservations).toEqual([]);
    expectSafeObservations(ownerObservations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("bounds pending observations and reports the exact overflow count", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const budget = new OutboundBudget(limits.webSocket.maxBytes, limits.maxFrameBytes);
    const socket = new FakeSocket();
    const observations: DeliveryObservation[] = [];
    const sink = new WebSocketSessionSink({
      socket,
      budget,
      limits,
      clock,
      observer: (observation) => observations.push(observation),
    });
    const control = { v: PROTOCOL_VERSION, t: "pong" as const };
    const sends: Promise<void>[] = [];

    for (let index = 0; index < 1_000; index++) sends.push(sink.sendControl(control));
    expect(observations).toEqual([]);
    expect(budget.snapshot().bytes).toBe(0);
    await Promise.all(sends);
    await flushObservations();

    expect(observations).toHaveLength(256);
    expect(observations[0]?.droppedObservations).toBe(3_000 - observations.length);
    expectSafeObservations(observations);

    await sink.sendControl(control);
    await flushObservations();
    expect(observations).toHaveLength(259);
    expect(observations.slice(-3).every(({ droppedObservations }) => (
      droppedObservations === undefined
    ))).toBe(true);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("preserves the no-observer path while receiver ACK owns release", async () => {
    const limits = testLimits();
    const clock = new FakeClock();
    const webSocketBudget = new OutboundBudget(
      limits.webSocket.maxBytes,
      limits.maxFrameBytes,
    );
    const socket = new FakeSocket();
    const sink = new WebSocketSessionSink({
      socket,
      budget: webSocketBudget,
      limits,
      clock,
    });
    await sink.sendControl({ v: PROTOCOL_VERSION, t: "pong" });
    expect(socket.sent).toEqual([encode({ v: PROTOCOL_VERSION, t: "pong" })]);
    expect(webSocketBudget.snapshot().bytes).toBe(0);

    const sseBudget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget: sseBudget, limits, clock });
    const reader = producer.stream.getReader();
    const chunk = { value: "direct" };
    producer.write(chunk);
    const application = sseMessage((await reader.read()).value!);
    expect(application).toMatchObject({ t: "sse_chunk", value: chunk });
    producer.ack(application.seq, application.proof);
    const completion = producer.complete();
    const terminal = sseMessage((await reader.read()).value!);
    expect(terminal.t).toBe("sse_done");
    producer.ack(terminal.seq, terminal.proof);
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(sseBudget.snapshot().bytes).toBe(0);
  });

  test("reports encoding failures without retaining unsafe input", async () => {
    const clock = new FakeClock();
    const limits = testLimits();
    const webSocketBudget = new OutboundBudget(
      limits.webSocket.maxBytes,
      limits.maxFrameBytes,
    );
    const webSocketObservations: DeliveryObservation[] = [];
    const sink = new WebSocketSessionSink({
      socket: new FakeSocket(),
      budget: webSocketBudget,
      limits,
      clock,
      observer: (observation) => webSocketObservations.push(observation),
    });

    await expect(sink.sendApplication(1, application(1, Number.NaN))).rejects.toThrow(
      "cannot encode non-finite number",
    );
    await flushObservations();
    expect(webSocketObservations).toEqual([
      {
        transport: "websocket",
        stage: "encoding",
        lane: "application",
        source: "send",
        bytes: 0,
        durationMs: 0,
        outcome: "internal",
      },
    ]);
    expectSafeObservations(webSocketObservations);
    expect(webSocketBudget.snapshot().bytes).toBe(0);

    const sseBudget = new OutboundBudget(limits.sse.maxBytes, 512);
    const sseObservations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget: sseBudget,
      limits,
      clock,
      observer: (observation) => sseObservations.push(observation),
    });
    expect(() => producer.write({ unsafe: Number.NaN })).toThrow(
      "cannot encode non-finite number",
    );
    await flushObservations();
    expect(sseObservations).toEqual([
      {
        transport: "sse",
        stage: "encoding",
        lane: "application",
        source: "write",
        bytes: 0,
        durationMs: 0,
        outcome: "internal",
      },
    ]);
    expectSafeObservations(sseObservations);
    await producer.stream.cancel("test complete");
    expect(sseBudget.snapshot().bytes).toBe(0);
  });

  test("isolates synchronous throws and asynchronous observer rejections", async () => {
    const limits = testLimits();
    let calls = 0;
    const observer = (): unknown => {
      calls += 1;
      if (calls % 2 === 1) throw new Error("observer failed synchronously");
      return Promise.reject(new Error("observer failed asynchronously"));
    };

    const webSocketBudget = new OutboundBudget(
      limits.webSocket.maxBytes,
      limits.maxFrameBytes,
    );
    const socket = new FakeSocket();
    const sink = new WebSocketSessionSink({ socket, budget: webSocketBudget, limits, observer });
    await sink.sendControl({ v: PROTOCOL_VERSION, t: "pong" });
    await flushObservations();
    await Promise.resolve();
    expect(socket.sent).toEqual([encode({ v: PROTOCOL_VERSION, t: "pong" })]);
    expect(socket.closes).toEqual([]);
    expect(webSocketBudget.snapshot().bytes).toBe(0);

    const sseBudget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget: sseBudget, limits, observer });
    const reader = producer.stream.getReader();
    producer.write({ value: "delivered" });
    const chunk = sseMessage((await reader.read()).value!);
    producer.ack(chunk.seq, chunk.proof);
    const completion = producer.complete();
    const terminal = sseMessage((await reader.read()).value!);
    producer.ack(terminal.seq, terminal.proof);
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    await flushObservations();
    await Promise.resolve();
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(producer.snapshot()).toMatchObject({ unackedBytes: 0, unackedFrames: 0, state: "closed" });
    expect(sseBudget.snapshot().bytes).toBe(0);
  });
});
