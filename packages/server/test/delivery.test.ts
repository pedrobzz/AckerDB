import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, decode, encode } from "@dbzz/core";
import {
  BoundedSseProducer,
  OutboundBudget,
  WebSocketSessionSink,
  type DeliveryClock,
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
    const message = application(1, "x".repeat(45));
    const frameBytes = encoder.encode(encode(message)).byteLength;
    const capacity = limits.webSocket.maxBytesPerConnection - limits.maxFrameBytes;
    socket.plans.push({ result: -1, buffered: frameBytes });
    const sink = new WebSocketSessionSink({ socket, budget, limits });

    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < Math.floor(capacity / frameBytes); index++) {
      writes.push(sink.sendApplication(1, { ...message, id: index + 1 }).catch((error) => error));
    }
    const overflow = sink.sendApplication(1, { ...message, id: 99 });
    await expect(overflow).rejects.toMatchObject({ code: "slow_consumer", resource: "outbound" });
    await Promise.all(writes);

    expect(socket.closes).toEqual([{ code: 1013, reason: "slow_consumer" }]);
    const terminal = decode(socket.sent.at(-1)!) as { t: string; outcome: { code: string } };
    expect(terminal).toMatchObject({ t: "err", outcome: { code: "slow_consumer" } });
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
  test("uses a byte-length queue and releases exact UTF-8 bytes on pull", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    const chunk = { text: "💥" };
    const text = `data: ${encode(chunk)}\n\n`;
    const bytes = encoder.encode(text).byteLength;

    producer.write(chunk);
    expect(producer.snapshot().queuedBytes).toBe(bytes);
    expect(budget.snapshot().bytes).toBe(bytes);

    const reader = producer.stream.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(text);
    expect(producer.snapshot().queuedBytes).toBe(0);
    const completion = producer.complete();
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
    const producer = new BoundedSseProducer({ budget, limits, clock });
    producer.write({ text: "unread" });

    clock.advance(9);
    expect(producer.snapshot().state).toBe("open");
    clock.advance(1);
    expect(producer.signal.aborted).toBe(true);
    expect(producer.signal.reason).toMatchObject({ code: "slow_consumer", resource: "sse" });

    const chunks = await collect(producer.stream);
    expect(chunks[0]).toBe(`data: ${encode({ text: "unread" })}\n\n`);
    expect(chunks[1]).toStartWith("event: dbzz-error\ndata: ");
    const outcome = decode(chunks[1]!.split("data: ")[1]!.trim()) as { code: string; resource: string };
    expect(outcome).toMatchObject({ code: "slow_consumer", resource: "sse" });
    expect(producer.snapshot()).toMatchObject({ queuedBytes: 0, state: "closed" });
    expect(budget.snapshot().bytes).toBe(0);
  });

  test("fails a synchronous producer at the local byte limit without exceeding it", async () => {
    const limits = testLimits();
    const budget = new OutboundBudget(limits.sse.maxBytes, 512);
    const producer = new BoundedSseProducer({ budget, limits });
    const chunk = { text: "x".repeat(55) };
    const bytes = encoder.encode(`data: ${encode(chunk)}\n\n`).byteLength;
    const applicationLimit = limits.sse.maxBytesPerStream - producer.controlReserveBytes;

    for (let used = 0; used + bytes <= applicationLimit; used += bytes) producer.write(chunk);
    expect(() => producer.write(chunk)).toThrow(DbzzError);
    expect(producer.signal.reason).toMatchObject({ code: "slow_consumer" });
    expect(producer.snapshot().queuedBytes).toBeLessThanOrEqual(limits.sse.maxBytesPerStream);

    const chunks = await collect(producer.stream);
    expect(chunks.at(-1)).toStartWith("event: dbzz-error\ndata: ");
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
