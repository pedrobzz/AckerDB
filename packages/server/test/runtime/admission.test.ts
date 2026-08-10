import { describe, expect, test } from "bun:test";
import {
  AdmissionQueue,
  AdmissionRejected,
  type AdmissionLease,
} from "../../src/runtime/admission.ts";
import {
  defineServiceLimits,
  PRODUCTION_LIMITS,
  validateQueueLimits,
} from "../../src/runtime/limits.ts";
import { AckerDBError, isAckerDBError } from "../../src/shared/errors.ts";
import { BoundedExecutor } from "../../src/runtime/executor.ts";

function settled<T>(ticket: Promise<T>): Promise<T | AdmissionRejected> {
  return ticket.catch((error: unknown) => {
    if (!(error instanceof AdmissionRejected)) throw error;
    return error;
  });
}

describe("production limits", () => {
  test("defaults are finite, validated, and immutable", () => {
    expect(Object.isFrozen(PRODUCTION_LIMITS)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_LIMITS.readQueue)).toBe(true);
    expect(PRODUCTION_LIMITS.maxConnections).toBe(4_096);
    expect(PRODUCTION_LIMITS.maxOperationsPerCaller).toBe(128);
    expect(PRODUCTION_LIMITS.readQueue).toEqual({
      maxItems: 4_096,
      maxBytes: 32 * 1024 * 1024,
      maxAgeMs: 30_000,
    });
    expect(PRODUCTION_LIMITS.revalidationConcurrency).toBe(4);

    expect(() => validateQueueLimits({ maxItems: 1, maxBytes: Infinity, maxAgeMs: 1 })).toThrow(
      "positive safe integer",
    );
    expect(() =>
      defineServiceLimits({ ...PRODUCTION_LIMITS, maxOperationsPerCaller: 5_000 }),
    ).toThrow("cannot exceed");
    expect(() =>
      defineServiceLimits({ ...PRODUCTION_LIMITS, maxOperationsPerConnection: 5_000 }),
    ).toThrow("cannot exceed");
    expect(() =>
      defineServiceLimits({ ...PRODUCTION_LIMITS, revalidationConcurrency: 0 }),
    ).toThrow("revalidationConcurrency must be a positive safe integer");
    expect(() => defineServiceLimits({
      ...PRODUCTION_LIMITS,
      maxFrameBytes: PRODUCTION_LIMITS.webSocket.maxBytesPerConnection,
    })).toThrow("smaller than webSocket.maxBytesPerConnection");
    expect(() => defineServiceLimits({
      ...PRODUCTION_LIMITS,
      maxFrameBytes: PRODUCTION_LIMITS.sse.maxBytesPerStream + 1,
    })).toThrow("cannot exceed sse.maxBytesPerStream");
  });
});

describe("AdmissionQueue", () => {
  test("FIFO admission enforces item and encoded-byte bounds without losing order", async () => {
    const queue = new AdmissionQueue<string>({
      discipline: "fifo",
      resource: "writer",
      retryAfterMs: 17,
      limits: { maxItems: 2, maxBytes: 5, maxAgeMs: 100 },
      now: () => 10,
    });
    const first = queue.enqueue("first", { bytes: 2 });
    const second = queue.enqueue("second", { bytes: 3 });
    const rejected = await settled(
      queue.enqueue("third", { bytes: 0 }),
    );

    expect(rejected).toBeInstanceOf(AdmissionRejected);
    expect(rejected).toBeInstanceOf(AckerDBError);
    expect(isAckerDBError(rejected)).toBe(true);
    expect(rejected).toMatchObject({
      reason: "items",
      code: "overloaded",
      retryable: true,
      retryAfterMs: 17,
      resource: "writer",
    });
    expect(queue.snapshot()).toMatchObject({ queuedItems: 2, queuedBytes: 5, oldestAgeMs: 0 });

    const firstLease = queue.take()!;
    const secondLease = queue.take()!;
    expect([firstLease.value, secondLease.value]).toEqual(["first", "second"]);
    expect([firstLease.turn, secondLease.turn]).toEqual([1, 2]);
    expect(await first).toBe(firstLease);
    expect(await second).toBe(secondLease);
    expect(queue.take()).toBeUndefined();
    expect(queue.snapshot().rejected.items).toBe(1);

    const byteQueue = new AdmissionQueue<string>({
      discipline: "fifo",
      resource: "reader",
      limits: { maxItems: 3, maxBytes: 4, maxAgeMs: 100 },
    });
    const admitted = byteQueue.enqueue("fits", { bytes: 3 });
    const byteRejection = await settled(
      byteQueue.enqueue("too-large", { bytes: 2 }),
    );
    expect(byteRejection).toMatchObject({ reason: "bytes", code: "overloaded" });
    byteQueue.take();
    await admitted;
  });

  test("round-robin serves exactly one item per active fairness key and turn", async () => {
    const queue = new AdmissionQueue<string>({
      discipline: "round-robin",
      resource: "reader",
      limits: { maxItems: 20, maxBytes: 100, maxAgeMs: 1_000 },
      now: () => 0,
    });
    const tickets = [
      queue.enqueue("a1", { bytes: 1, fairnessKey: "a" }),
      queue.enqueue("a2", { bytes: 1, fairnessKey: "a" }),
      queue.enqueue("a3", { bytes: 1, fairnessKey: "a" }),
      queue.enqueue("b1", { bytes: 1, fairnessKey: "b" }),
      queue.enqueue("b2", { bytes: 1, fairnessKey: "b" }),
      queue.enqueue("c1", { bytes: 1, fairnessKey: "c" }),
    ];

    const leases: AdmissionLease<string>[] = [];
    while (queue.snapshot().queuedItems) leases.push(queue.take()!);
    expect(leases.map((lease) => lease.value)).toEqual(["a1", "b1", "c1", "a2", "b2", "a3"]);
    expect(leases.map((lease) => lease.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    await Promise.all(tickets);
  });

  test("a cold key starts after at most the active keys already ahead in the round", async () => {
    const queue = new AdmissionQueue<string>({
      discipline: "round-robin",
      resource: "revalidation",
      limits: { maxItems: 20, maxBytes: 100, maxAgeMs: 1_000 },
      now: () => 0,
    });
    const tickets = [
      queue.enqueue("hot-1", { bytes: 1, fairnessKey: "hot" }),
      queue.enqueue("hot-2", { bytes: 1, fairnessKey: "hot" }),
      queue.enqueue("warm-1", { bytes: 1, fairnessKey: "warm" }),
      queue.enqueue("warm-2", { bytes: 1, fairnessKey: "warm" }),
    ];
    expect(queue.take()!.value).toBe("hot-1");
    tickets.push(
      queue.enqueue("cold-1", { bytes: 1, fairnessKey: "cold" }),
    );

    expect(queue.snapshot().activeFairnessKeys).toBe(3);
    expect([queue.take()!.value, queue.take()!.value, queue.take()!.value]).toEqual([
      "warm-1",
      "hot-2",
      "cold-1",
    ]);
    expect(queue.take()!.value).toBe("warm-2");
    await Promise.all(tickets);
  });

  test("deadline, maximum age, and cancellation remove capacity and update exact gauges", async () => {
    let now = 0;
    const queue = new AdmissionQueue<string>({
      discipline: "fifo",
      resource: "reader",
      limits: { maxItems: 3, maxBytes: 9, maxAgeMs: 10 },
      now: () => now,
    });
    const controller = new AbortController();
    const deadline = settled(
      queue.enqueue("deadline", { bytes: 3, deadlineMs: 5 }),
    );
    const aged = settled(queue.enqueue("aged", { bytes: 3 }));
    const canceled = settled(
      queue.enqueue("canceled", { bytes: 3, signal: controller.signal }),
    );
    expect(queue.snapshot()).toMatchObject({
      queuedItems: 3,
      queuedBytes: 9,
      nextExpiryAtMs: 5,
    });

    controller.abort();
    expect(await canceled).toMatchObject({ reason: "canceled", retryable: false });
    expect(queue.snapshot()).toMatchObject({ queuedItems: 2, queuedBytes: 6 });

    now = 5;
    expect(queue.expire()).toBe(1);
    expect(await deadline).toMatchObject({ reason: "deadline", code: "deadline_exceeded" });
    now = 10;
    expect(queue.snapshot().oldestAgeMs).toBe(0);
    expect(await aged).toMatchObject({ reason: "age", code: "deadline_exceeded" });
    expect(queue.snapshot()).toMatchObject({
      queuedItems: 0,
      queuedBytes: 0,
      rejected: { age: 1, deadline: 1, canceled: 1 },
    });
  });

  test("close rejects only queued work and permanently refuses new work", async () => {
    const queue = new AdmissionQueue<string>({
      discipline: "fifo",
      resource: "writer",
      limits: { maxItems: 2, maxBytes: 2, maxAgeMs: 100 },
    });
    const queued = settled(queue.enqueue("queued", { bytes: 1 }));
    queue.close();
    expect(await queued).toMatchObject({ reason: "closed", code: "draining" });
    expect(await settled(queue.enqueue("late", { bytes: 1 }))).toMatchObject({
      reason: "closed",
    });
    expect(queue.snapshot()).toMatchObject({ queuedItems: 0, closed: true });
    expect(queue.snapshot().rejected.closed).toBe(2);
  });
});

describe("BoundedExecutor", () => {
  test("expires queued work autonomously while every execution slot is stalled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = new BoundedExecutor({
      concurrency: 1,
      discipline: "round-robin",
      resource: "revalidation",
      limits: { maxItems: 2, maxBytes: 2, maxAgeMs: 5 },
    });
    const active = executor.submit(() => gate, {
      bytes: 1,
      fairnessKey: "active",
    });
    const queued = settled(executor.submit(() => undefined, {
      bytes: 1,
      fairnessKey: "queued",
    }));

    expect(executor.snapshot()).toMatchObject({
      active: 1,
      queue: { queuedItems: 1, queuedBytes: 1 },
    });
    expect(await queued).toMatchObject({
      reason: "age",
      code: "deadline_exceeded",
      resource: "revalidation",
      retryable: false,
    });
    expect(executor.snapshot().queue).toMatchObject({
      queuedItems: 0,
      queuedBytes: 0,
      rejected: { age: 1 },
    });

    release();
    await active;
    executor.close();
    await executor.drain();
  });
});
