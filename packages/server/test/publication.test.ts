import { describe, expect, test } from "bun:test";
import { DbzzError } from "../src/errors.ts";
import { OrderedPublication } from "../src/publication.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ordered publication", () => {
  test("reserves item and byte capacity before commit", async () => {
    let now = 10;
    const release = deferred();
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 1, maxBytes: 8 },
      now: () => now,
      process: () => release.promise,
    });

    expect(() => coordinator.reserve(9)).toThrow(DbzzError);
    const slot = coordinator.reserve(8);
    now = 17;
    expect(coordinator.snapshot()).toMatchObject({ items: 1, bytes: 8, oldestAgeMs: 7, highWater: 0n });
    expect(() => coordinator.reserve(0)).toThrow(DbzzError);

    slot.commit("committed");
    expect(coordinator.snapshot().highWater).toBe(1n);
    release.resolve();
    await slot.completion;
    expect(coordinator.snapshot()).toMatchObject({ items: 0, bytes: 0, processed: 1 });
  });

  test("resizes a provisional slot before commit without overbooking bytes", async () => {
    const release = deferred();
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 2, maxBytes: 8 },
      process: () => release.promise,
    });

    const first = coordinator.reserve(0);
    first.resize(5);
    first.commit("first");
    const second = coordinator.reserve(0);
    expect(() => second.resize(4)).toThrow(DbzzError);
    expect(coordinator.snapshot()).toMatchObject({ items: 2, bytes: 5 });
    second.resize(3);
    second.commit("second");
    expect(coordinator.snapshot()).toMatchObject({ items: 2, bytes: 8 });

    release.resolve();
    await Promise.all([first.completion, second.completion]);
  });

  test("rollback cancel releases capacity and preserves the next version", async () => {
    const seen: bigint[] = [];
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 1, maxBytes: 4 },
      process: ({ version }) => {
        seen.push(version);
      },
    });

    const rolledBack = coordinator.reserve(4);
    expect(rolledBack.version).toBe(1n);
    rolledBack.cancel();
    await rolledBack.completion;
    expect(coordinator.snapshot()).toMatchObject({ items: 0, bytes: 0, highWater: 0n });

    const committed = coordinator.reserve(4);
    expect(committed.version).toBe(1n);
    committed.commit("kept");
    await committed.completion;
    expect(seen).toEqual([1n]);
  });

  test("post-commit fill cannot lose an admitted slot", async () => {
    const seen: string[] = [];
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 2, maxBytes: 8 },
      process: ({ value }) => {
        seen.push(value);
      },
    });
    const slot = coordinator.reserve(8);

    expect(() => slot.commit("writes-for-commit-1")).not.toThrow();
    expect(coordinator.snapshot()).toMatchObject({ highWater: 1n, items: 1, bytes: 8 });
    await slot.completion;
    expect(seen).toEqual(["writes-for-commit-1"]);
    expect(coordinator.snapshot()).toMatchObject({ processedHighWater: 1n, processed: 1, failures: 0 });
  });

  test("processes commits strictly in version order despite async work", async () => {
    const first = deferred();
    const second = deferred();
    const started: bigint[] = [];
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 3, maxBytes: 3 },
      process: async ({ version }) => {
        started.push(version);
        if (version === 1n) await first.promise;
        if (version === 2n) await second.promise;
      },
    });

    const one = coordinator.reserve(1);
    one.commit("one");
    const two = coordinator.reserve(1);
    two.commit("two");
    const three = coordinator.reserve(1);
    three.commit("three");
    await Promise.resolve();
    expect(started).toEqual([1n]);

    first.resolve();
    await one.completion;
    await Promise.resolve();
    expect(started).toEqual([1n, 2n]);
    second.resolve();
    await Promise.all([two.completion, three.completion]);
    expect(started).toEqual([1n, 2n, 3n]);
  });

  test("surfaces processor failure and continues without reordering", async () => {
    const failure = new Error("processor failed");
    const seen: bigint[] = [];
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 2, maxBytes: 2 },
      process: ({ version }) => {
        seen.push(version);
        if (version === 1n) throw failure;
      },
    });
    const one = coordinator.reserve(1);
    one.commit("one");
    const two = coordinator.reserve(1);
    two.commit("two");

    await expect(one.completion).rejects.toBe(failure);
    await two.completion;
    expect(seen).toEqual([1n, 2n]);
    expect(coordinator.snapshot()).toMatchObject({
      highWater: 2n,
      processedHighWater: 2n,
      processed: 2,
      failures: 1,
      lastFailureVersion: 1n,
    });
  });

  test("compare-and-install rejects an evaluation raced by a commit", async () => {
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 1, maxBytes: 1 },
      process: () => {},
    });
    let installs = 0;
    expect(coordinator.compareAndInstall(0n, () => installs++)).toBe(true);

    const evaluatedAt = coordinator.snapshot().highWater;
    const slot = coordinator.reserve(1);
    slot.commit("commit");
    expect(coordinator.compareAndInstall(evaluatedAt, () => installs++)).toBe(false);
    expect(coordinator.compareAndInstall(1n, () => installs++)).toBe(true);
    expect(() => coordinator.compareAndInstall(1n, async () => {})).toThrow(
      "compareAndInstall callback must be synchronous",
    );
    await slot.completion;
    expect(installs).toBe(2);
  });

  test("close rejects reservations and drains already reserved commits", async () => {
    const release = deferred();
    const coordinator = new OrderedPublication<string>({
      limits: { maxItems: 1, maxBytes: 1 },
      process: () => release.promise,
    });
    const slot = coordinator.reserve(1);
    const closing = coordinator.close();
    expect(() => coordinator.reserve(0)).toThrow(DbzzError);
    slot.commit("admitted-before-close");

    let drained = false;
    void closing.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await closing;
    await slot.completion;
    expect(coordinator.snapshot()).toMatchObject({ closed: true, items: 0, bytes: 0, processed: 1 });
  });
});
