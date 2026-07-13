import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, decode, encode } from "@dbzz/core";
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
  ]);
  for (const observation of observations) {
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.keys(observation).every((field) => safeFields.has(field))).toBe(true);
    expect(Number.isSafeInteger(observation.bytes)).toBe(true);
    expect(observation.bytes).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(observation.durationMs)).toBe(true);
    expect(observation.durationMs).toBeGreaterThanOrEqual(0);
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
  test("observes exact write and terminal delivery through stream consumption", async () => {
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
    const chunk = { text: "💥" };
    const text = `data: ${encode(chunk)}\n\n`;
    const bytes = encoder.encode(text).byteLength;
    const doneText = "data: [DONE]\n\n";
    const doneBytes = encoder.encode(doneText).byteLength;

    producer.write(chunk);
    clock.advance(5);
    const reader = producer.stream.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(text);
    const completion = producer.complete();
    await Promise.resolve();
    clock.advance(2);
    expect(decoder.decode((await reader.read()).value)).toBe(doneText);
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    await flushObservations();

    expect(observations).toEqual([
      {
        transport: "sse",
        stage: "encoding",
        lane: "application",
        source: "write",
        bytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "queue",
        lane: "application",
        source: "write",
        bytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "delivery",
        lane: "application",
        source: "write",
        bytes,
        durationMs: 5,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "encoding",
        lane: "control",
        source: "terminal",
        bytes: doneBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "queue",
        lane: "control",
        source: "terminal",
        bytes: doneBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "delivery",
        lane: "control",
        source: "terminal",
        bytes: doneBytes,
        durationMs: 2,
        outcome: "ok",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("includes merge capacity wait and retains delivery timing until the exact release", async () => {
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
    const first = { text: "a".repeat(180) };
    const mergedChunk = { text: "b".repeat(180) };
    const mergedBytes = encoder.encode(`data: ${encode(mergedChunk)}\n\n`).byteLength;
    producer.write(first);
    const merged = producer.merge(new ReadableStream({
      start(controller) {
        controller.enqueue(mergedChunk);
        controller.close();
      },
    }));
    await Promise.resolve();

    clock.advance(6);
    const reader = producer.stream.getReader();
    await reader.read();
    await merged;
    clock.advance(4);
    await reader.read();
    reader.releaseLock();
    await producer.stream.cancel("test complete");
    await flushObservations();

    expect(observations.filter(({ source }) => source === "merge")).toEqual([
      {
        transport: "sse",
        stage: "encoding",
        lane: "application",
        source: "merge",
        bytes: mergedBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "queue",
        lane: "application",
        source: "merge",
        bytes: mergedBytes,
        durationMs: 6,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "delivery",
        lane: "application",
        source: "merge",
        bytes: mergedBytes,
        durationMs: 4,
        outcome: "ok",
      },
    ]);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("ends a canceled merge capacity wait as a queue failure without a delivery", async () => {
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
    producer.write({ text: "a".repeat(180) });
    const mergedChunk = { text: "b".repeat(180) };
    const mergedBytes = encoder.encode(`data: ${encode(mergedChunk)}\n\n`).byteLength;
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

    expect(observations.filter(({ source }) => source === "merge")).toEqual([
      {
        transport: "sse",
        stage: "encoding",
        lane: "application",
        source: "merge",
        bytes: mergedBytes,
        durationMs: 0,
        outcome: "ok",
      },
      {
        transport: "sse",
        stage: "queue",
        lane: "application",
        source: "merge",
        bytes: mergedBytes,
        durationMs: 2,
        outcome: "unavailable",
      },
    ]);
    expectSafeObservations(observations);
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
    const bytes = encoder.encode(`data: ${encode(chunk)}\n\n`).byteLength;

    producer.write(chunk);
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
    expect(producer.snapshot()).toMatchObject({ queuedBytes: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("uses a byte-length queue and releases exact UTF-8 bytes on pull", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    const chunk = { text: "💥" };
    const text = `data: ${encode(chunk)}\n\n`;
    const bytes = encoder.encode(text).byteLength;

    expect(budget.snapshot()).toMatchObject({
      bytes: producer.controlReserveBytes,
      applicationBytes: 0,
      controlBytes: producer.controlReserveBytes,
    });
    producer.write(chunk);
    expect(producer.snapshot().queuedBytes).toBe(bytes);
    expect(budget.snapshot()).toMatchObject({
      bytes: producer.controlReserveBytes + bytes,
      applicationBytes: bytes,
      controlBytes: producer.controlReserveBytes,
    });

    const reader = producer.stream.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(text);
    expect(producer.snapshot().queuedBytes).toBe(0);
    expect(budget.snapshot()).toMatchObject({
      bytes: producer.controlReserveBytes,
      applicationBytes: 0,
      controlBytes: producer.controlReserveBytes,
    });
    const completion = producer.complete();
    await Promise.resolve();
    const doneBytes = encoder.encode("data: [DONE]\n\n").byteLength;
    expect(budget.snapshot()).toMatchObject({
      bytes: doneBytes,
      applicationBytes: 0,
      controlBytes: doneBytes,
    });
    expect(decoder.decode((await reader.read()).value)).toBe("data: [DONE]\n\n");
    await completion;
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("emits an explicit dbzz-error event after a deterministic stall", async () => {
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

    clock.advance(9);
    expect(producer.snapshot().state).toBe("open");
    clock.advance(1);
    expect(producer.signal.aborted).toBe(true);
    expect(producer.signal.reason).toMatchObject({ code: "slow_consumer", resource: "sse" });

    const chunks = await collect(producer.stream);
    await flushObservations();
    expect(chunks[0]).toBe(`data: ${encode({ text: "unread" })}\n\n`);
    expect(chunks[1]).toStartWith("event: dbzz-error\ndata: ");
    const outcome = decode(chunks[1]!.split("data: ")[1]!.trim()) as { code: string; resource: string };
    expect(outcome).toMatchObject({ code: "slow_consumer", resource: "sse" });
    expect(observations).toContainEqual(expect.objectContaining({
      stage: "delivery",
      lane: "application",
      source: "write",
      durationMs: 10,
      outcome: "ok",
    }));
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
        outcome: "ok",
        terminalOutcome: "slow_consumer",
      },
    ]);
    expectSafeObservations(observations);
    expect(producer.snapshot()).toMatchObject({ queuedBytes: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("fails a synchronous producer at the local byte limit without exceeding it", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const observations: DeliveryObservation[] = [];
    const producer = new BoundedSseProducer({
      budget,
      limits,
      observer: (observation) => observations.push(observation),
    });
    const chunk = { text: "x".repeat(55) };
    const bytes = encoder.encode(`data: ${encode(chunk)}\n\n`).byteLength;
    const applicationLimit = limits.sse.maxBytesPerStream - producer.controlReserveBytes;

    for (let used = 0; used + bytes <= applicationLimit; used += bytes) producer.write(chunk);
    expect(() => producer.write(chunk)).toThrow(DbzzError);
    expect(producer.signal.reason).toMatchObject({ code: "slow_consumer" });
    expect(producer.snapshot().queuedBytes).toBeLessThanOrEqual(limits.sse.maxBytesPerStream);

    const chunks = await collect(producer.stream);
    await flushObservations();
    expect(chunks.at(-1)).toStartWith("event: dbzz-error\ndata: ");
    expect(observations).toContainEqual(expect.objectContaining({
      stage: "queue",
      lane: "application",
      source: "write",
      outcome: "slow_consumer",
    }));
    expect(observations.filter(({ source }) => source === "terminal")).toHaveLength(3);
    expectSafeObservations(observations);
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("distinguishes global overload and leaves a separate producer bounded", async () => {
    const limits = testLimits({ sse: { maxBytes: 600 } });
    const budget = new OutboundBudget(600, 200);
    const first = new BoundedSseProducer({ budget, limits });
    const second = new BoundedSseProducer({ budget, limits });
    const chunk = { text: "x".repeat(200) };
    first.write(chunk);

    expect(() => second.write(chunk)).toThrow(DbzzError);
    expect(second.signal.reason).toMatchObject({ code: "overloaded", resource: "sse" });
    expect(budget.snapshot().bytes).toBeLessThanOrEqual(600);
    const secondChunks = await collect(second.stream);
    expect(secondChunks.at(-1)).toStartWith("event: dbzz-error\ndata: ");

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

    const streams = await Promise.all(producers.map((producer) => collect(producer.stream)));
    for (const chunks of streams) {
      expect(chunks).toHaveLength(1);
      expect(encoder.encode(chunks[0]!).byteLength).toBe(terminalBytes);
      expect(decode(chunks[0]!.split("data: ")[1]!.trim())).toMatchObject({
        code: "convergence_unavailable",
        committed: true,
        resource: "subscription",
      });
    }
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
    const collected = collect(producer.stream);
    release();
    await merged;
    await producer.complete();

    expect(await collected).toEqual([
      `data: ${encode({ n: 1 })}\n\n`,
      `data: ${encode({ n: 2 })}\n\n`,
      "data: [DONE]\n\n",
    ]);
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
    expect(producer.snapshot()).toMatchObject({ queuedBytes: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);

    const canceled = new BoundedSseProducer({ budget, limits });
    canceled.write({ value: "held" });
    await canceled.stream.cancel("consumer stopped");
    expect(canceled.signal.aborted).toBe(true);
    expect(canceled.snapshot()).toMatchObject({ queuedBytes: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });
});

describe("delivery observers", () => {
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
    const collected = collect(producer.stream);
    producer.write({ value: "delivered" });
    await producer.complete();
    expect(await collected).toEqual([
      `data: ${encode({ value: "delivered" })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    await flushObservations();
    await Promise.resolve();
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(producer.snapshot()).toMatchObject({ queuedBytes: 0, state: "closed" });
    expect(sseBudget.snapshot().bytes).toBe(0);
  });
});
