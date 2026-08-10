import { describe, expect, test } from "bun:test";
import { AdmissionRejected } from "../../src/runtime/admission.ts";
import { BoundedExecutor } from "../../src/runtime/executor.ts";
import { outcomeFromError } from "../../src/runtime/outcome.ts";

const limits = { maxItems: 2, maxBytes: 8, maxAgeMs: 1_000 };

function rejectionOf(ticket: Promise<unknown>): Promise<unknown> {
  return ticket.then(
    () => {
      throw new Error("expected executor submission to be rejected");
    },
    (error: unknown) => error,
  );
}

describe("BoundedExecutor", () => {
  test("runs only bounded concurrency and reports exact completion gauges", async () => {
    const executor = new BoundedExecutor({
      concurrency: 1,
      discipline: "fifo",
      limits,
      resource: "writer",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = executor.submit(async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return 1;
    }, { bytes: 1 });
    const second = executor.submit(() => {
      order.push("second");
      return 2;
    }, { bytes: 1 });

    await Promise.resolve();
    expect(executor.snapshot()).toMatchObject({ active: 1, admitted: 1, completed: 0 });
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    await executor.drain();
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(executor.snapshot()).toMatchObject({ active: 0, admitted: 2, completed: 2, failed: 0 });
  });

  test("enforces queued item and byte capacity before a handler starts", async () => {
    const executor = new BoundedExecutor({
      concurrency: 1,
      discipline: "fifo",
      limits: { maxItems: 1, maxBytes: 2, maxAgeMs: 1_000 },
      resource: "reader",
      retryAfterMs: 7,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = executor.submit(() => gate, { bytes: 1 });
    const queued = executor.submit(() => 2, { bytes: 2 });
    const rejected = executor.submit(() => 3, { bytes: 1 });
    await expect(rejected).rejects.toMatchObject({
      code: "overloaded",
      resource: "reader",
      retryAfterMs: 7,
    });
    release();
    await active;
    expect(await queued).toBe(2);
  });

  test("preserves overload, deadline, and draining outcomes across executor rejection", async () => {
    let now = 0;
    const executor = new BoundedExecutor({
      concurrency: 1,
      discipline: "fifo",
      limits: { maxItems: 1, maxBytes: 8, maxAgeMs: 1_000 },
      resource: "writer",
      retryAfterMs: 13,
      now: () => now,
    });
    let release!: () => void;
    const active = executor.submit(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
      { bytes: 1 },
    );
    const expires = executor.submit(() => 2, {
      bytes: 1,
      deadlineMs: 5,
    });

    const overloaded = await rejectionOf(
      executor.submit(() => 3, { bytes: 1 }),
    );
    expect(overloaded).toBeInstanceOf(AdmissionRejected);
    expect(outcomeFromError(overloaded)).toEqual({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 13,
      resource: "writer",
      message: "Admission rejected: items",
    });

    now = 5;
    executor.snapshot();
    const deadline = await rejectionOf(expires);
    expect(deadline).toBeInstanceOf(AdmissionRejected);
    expect(outcomeFromError(deadline)).toEqual({
      code: "deadline_exceeded",
      retryable: false,
      resource: "writer",
      message: "Admission rejected: deadline",
    });

    const closes = executor.submit(() => 4, { bytes: 1 });
    executor.close();
    const draining = await rejectionOf(closes);
    expect(draining).toBeInstanceOf(AdmissionRejected);
    expect(outcomeFromError(draining)).toEqual({
      code: "draining",
      retryable: false,
      resource: "writer",
      message: "Admission rejected: closed",
    });

    release();
    await active;
    await executor.drain();
  });

  test("close rejects queued work but drains an admitted handler", async () => {
    const executor = new BoundedExecutor({
      concurrency: 1,
      discipline: "round-robin",
      limits,
      resource: "reader",
    });
    let release!: () => void;
    const active = executor.submit(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
      { bytes: 1, fairnessKey: "a" },
    );
    const queued = executor.submit(() => 2, {
      bytes: 1,
      fairnessKey: "b",
    });
    executor.close();
    await expect(queued).rejects.toBeInstanceOf(AdmissionRejected);
    let drained = false;
    const drain = executor.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await active;
    await drain;
    expect(drained).toBe(true);
    await expect(
      executor.submit(() => 3, { bytes: 1, fairnessKey: "c" }),
    ).rejects.toMatchObject({ code: "draining" });
  });
});
