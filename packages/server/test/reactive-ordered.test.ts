import { describe, expect, test } from "bun:test";
import type {
  LiveEvent,
  Outcome,
  SubscriptionCursor,
  SubscriptionTransition,
} from "@dbzz/core";
import { stableEncode } from "@dbzz/core";
import { DbzzError } from "../src/errors.ts";
import { defineServiceLimits, PRODUCTION_LIMITS, type ServiceLimits } from "../src/limits.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type ReactiveCommitResult,
  type ReactiveObservation,
  type Subscriber,
} from "../src/reactive.ts";

class RecordingSubscriber implements Subscriber {
  readonly transitions: Array<{ id: number; transition: SubscriptionTransition }> = [];
  readonly events: Array<{ id: number; event: LiveEvent }> = [];
  readonly errors: Array<{ id: number; outcome: Outcome }> = [];
  readonly failNextTransition = new Set<number>();
  readonly failNextEvent = new Set<number>();
  private nextTransitionGate?: {
    readonly id: number;
    readonly entered: () => void;
    readonly release: Promise<void>;
  };

  async sendTransition(id: number, transition: SubscriptionTransition): Promise<void> {
    const gate = this.nextTransitionGate;
    if (gate?.id === id) {
      this.nextTransitionGate = undefined;
      gate.entered();
      await gate.release;
    }
    if (this.failNextTransition.delete(id)) throw new Error(`transition ${id} failed`);
    this.transitions.push({ id, transition });
  }

  async sendEvent(id: number, event: LiveEvent): Promise<void> {
    if (this.failNextEvent.delete(id)) throw new Error(`event ${id} failed`);
    this.events.push({ id, event });
  }

  async sendError(id: number, outcome: Outcome): Promise<void> {
    this.errors.push({ id, outcome });
  }

  cursor(id: number): SubscriptionCursor {
    const transition = this.transitions.findLast((item) => item.id === id)?.transition;
    if (!transition) throw new Error(`missing transition ${id}`);
    return transition.to;
  }

  gateNextTransition(id: number): { readonly entered: Promise<void>; release(): void } {
    const entered = deferred();
    const release = deferred();
    this.nextTransitionGate = { id, entered: entered.resolve, release: release.promise };
    return { entered: entered.promise, release: release.resolve };
  }
}

interface LimitOverrides {
  maxSharedSubscriptions?: number;
  maxSharedResultBytes?: number;
  maxFrameBytes?: number;
  maxTransitionsPerStream?: number;
  maxHistoryBytes?: number;
  maxHistoryBytesPerStream?: number;
  maxHistoryAgeMs?: number;
  revalidationConcurrency?: number;
  revalidationMaxItems?: number;
  revalidationMaxBytes?: number;
  revalidationMaxAgeMs?: number;
}

function testLimits(overrides: LimitOverrides = {}): ServiceLimits {
  const maxHistoryBytes = overrides.maxHistoryBytes ?? PRODUCTION_LIMITS.resume.maxBytes;
  return defineServiceLimits({
    ...PRODUCTION_LIMITS,
    maxSharedSubscriptions: overrides.maxSharedSubscriptions ?? PRODUCTION_LIMITS.maxSharedSubscriptions,
    maxSharedResultBytes: overrides.maxSharedResultBytes ?? PRODUCTION_LIMITS.maxSharedResultBytes,
    maxFrameBytes: overrides.maxFrameBytes ?? PRODUCTION_LIMITS.maxFrameBytes,
    revalidationConcurrency:
      overrides.revalidationConcurrency ?? PRODUCTION_LIMITS.revalidationConcurrency,
    revalidationQueue: {
      maxItems: overrides.revalidationMaxItems ?? PRODUCTION_LIMITS.revalidationQueue.maxItems,
      maxBytes: overrides.revalidationMaxBytes ?? PRODUCTION_LIMITS.revalidationQueue.maxBytes,
      maxAgeMs: overrides.revalidationMaxAgeMs ?? PRODUCTION_LIMITS.revalidationQueue.maxAgeMs,
    },
    publication: { maxItems: 32, maxBytes: 32 * 1024 },
    resume: {
      ...PRODUCTION_LIMITS.resume,
      maxTransitionsPerStream:
        overrides.maxTransitionsPerStream ?? PRODUCTION_LIMITS.resume.maxTransitionsPerStream,
      maxBytesPerStream: overrides.maxHistoryBytesPerStream ?? Math.min(
        PRODUCTION_LIMITS.resume.maxBytesPerStream,
        maxHistoryBytes,
      ),
      maxAgeMs: overrides.maxHistoryAgeMs ?? PRODUCTION_LIMITS.resume.maxAgeMs,
      maxBytes: maxHistoryBytes,
    },
  });
}

function generationSequence(): () => string {
  let generation = 0;
  return () => `generation-${++generation}`;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function publish<C>(
  reactive: OrderedReactive<C>,
  writeKeys: ReadonlySet<string>,
  prepare: (version: bigint) => void,
  options: { events?: readonly { table: string; row: unknown }[]; caller?: Subscriber } = {},
): Promise<ReactiveCommitResult> {
  const slot = reactive.publication.reserve(64);
  prepare(slot.version);
  const commit = new ReactiveCommit(writeKeys, options.events, options.caller);
  slot.commit(commit);
  await slot.completion;
  if (!commit.result) throw new Error("publication did not produce a result");
  return commit.result;
}

function evaluation(value: unknown, version: bigint, ...readSet: string[]): QueryEvaluation {
  return { value, encoded: JSON.stringify(value), readSet: new Set(readSet), commitVersion: version };
}

function queuedBytes(address: string, args: unknown, scope: string): number {
  const key = stableEncode([address, stableEncode(args), scope]);
  return new TextEncoder().encode(key).byteLength;
}

describe("ordered reactive ownership", () => {
  test("shares only address, args, and explicit policy-scope peers", async () => {
    let evaluations = 0;
    const reactive = new OrderedReactive<{ request: string }>({
      generation: generationSequence(),
      evaluate: async ({ address, args, policyScopeFingerprint }) => {
        evaluations++;
        return evaluation({ address, args, policyScopeFingerprint }, 0n, `query:${address}`);
      },
    });
    const first = new RecordingSubscriber();
    const peer = new RecordingSubscriber();
    const isolated = new RecordingSubscriber();
    const common = {
      address: "messages.list",
      args: { room: 7 },
      policyScopeFingerprint: "room:7",
      fairnessKey: "caller",
    };

    await reactive.subscribeQuery({ ...common, context: { request: "first" }, subscriber: first, id: 1, authEpoch: 4 });
    await reactive.subscribeQuery({
      ...common,
      context: { request: "peer" },
      subscriber: peer,
      id: 2,
      authEpoch: 4,
      cursor: first.cursor(1),
    });
    await reactive.subscribeQuery({
      ...common,
      policyScopeFingerprint: "admin",
      context: { request: "isolated" },
      subscriber: isolated,
      id: 3,
      authEpoch: 4,
    });

    expect(evaluations).toBe(2);
    expect(first.transitions[0]?.transition.kind).toBe("reset");
    expect(peer.transitions[0]?.transition.kind).toBe("resume");
    expect(peer.cursor(2).identity).toBe(first.cursor(1).identity);
    expect(isolated.cursor(3).identity).not.toBe(first.cursor(1).identity);
    expect(reactive.snapshot()).toMatchObject({ sharedEntries: 2, queryListeners: 3 });
  });

  test("keeps shared revalidation with the oldest active caller until ownership leaves", async () => {
    let version = 0n;
    const revalidationOwners: string[] = [];
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async ({ fairnessKey }) => {
        if (version > 0n) revalidationOwners.push(fairnessKey);
        return evaluation(`value-${version}`, version, "messages");
      },
    });
    const first = new RecordingSubscriber();
    const peer = new RecordingSubscriber();
    const common = {
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "same-claim-sensitive-scope",
      context: undefined,
      authEpoch: 0,
    };

    await reactive.subscribeQuery({
      ...common,
      fairnessKey: "caller-first",
      subscriber: first,
      id: 1,
    });
    await reactive.subscribeQuery({
      ...common,
      fairnessKey: "caller-peer",
      subscriber: peer,
      id: 2,
    });
    expect(reactive.snapshot()).toMatchObject({ sharedEntries: 1, queryListeners: 2 });

    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
    });
    expect(revalidationOwners).toEqual(["caller-first"]);

    reactive.disconnect(first);
    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
    });
    expect(revalidationOwners).toEqual(["caller-first", "caller-peer"]);
  });

  test("retries an optimistic setup evaluation raced by commit publication", async () => {
    let version = 0n;
    let calls = 0;
    const releaseFirst = deferred();
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async () => {
        const observed = version;
        if (++calls === 1) await releaseFirst.promise;
        return evaluation(`value-${observed}`, observed, "messages");
      },
    });
    const subscriber = new RecordingSubscriber();

    const subscribing = reactive.subscribeQuery({
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 1,
      authEpoch: 0,
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
    });
    releaseFirst.resolve();
    await subscribing;

    expect(calls).toBe(2);
    expect(subscriber.transitions).toHaveLength(1);
    expect(subscriber.transitions[0]?.transition).toMatchObject({ kind: "reset", value: "value-1" });
    expect(subscriber.cursor(1).commitVersion).toBe(1n);
  });

  test("publishes full updates, checkpoints, and coalesces newer revalidations", async () => {
    let version = 0n;
    let value = "initial";
    let calls = 0;
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async () => {
        calls++;
        return evaluation(value, version, "messages");
      },
    });
    const subscriber = new RecordingSubscriber();
    await reactive.subscribeQuery({
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 1,
      authEpoch: 0,
    });

    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
      value = "changed";
    });
    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
    });

    const third = reactive.publication.reserve(64);
    version = third.version;
    value = "superseded";
    third.commit(new ReactiveCommit(new Set(["messages"])));
    const fourth = reactive.publication.reserve(64);
    version = fourth.version;
    value = "newest";
    fourth.commit(new ReactiveCommit(new Set(["messages"])));
    await Promise.all([third.completion, fourth.completion]);

    expect(calls).toBe(4);
    expect(subscriber.transitions.map(({ transition }) => transition.kind)).toEqual([
      "reset",
      "update",
      "checkpoint",
      "update",
    ]);
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({ kind: "update", value: "newest" });
    expect(subscriber.cursor(1).commitVersion).toBe(4n);
  });

  test("bounds queued revalidations by items and expires them with the exact age outcome", async () => {
    let now = 0;
    let version = 0n;
    let stalled = false;
    const entered = deferred();
    const release = deferred();
    const reactive = new OrderedReactive({
      limits: testLimits({
        revalidationConcurrency: 1,
        revalidationMaxItems: 1,
        revalidationMaxBytes: 16 * 1024,
        revalidationMaxAgeMs: 10,
      }),
      now: () => now,
      generation: generationSequence(),
      evaluate: async ({ address }) => {
        const observed = version;
        if (stalled && address === "active") {
          entered.resolve();
          await release.promise;
        }
        return evaluation(`${address}@${observed}`, observed, address);
      },
    });
    const active = new RecordingSubscriber();
    const queued = new RecordingSubscriber();
    const overflow = new RecordingSubscriber();
    for (const [subscriber, id, address] of [
      [active, 1, "active"],
      [queued, 2, "queued-µ"],
      [overflow, 3, "overflow"],
    ] as const) {
      await reactive.subscribeQuery({
        address,
        args: { tag: "é" },
        policyScopeFingerprint: "tenant-é",
        fairnessKey: "tenant-é",
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    stalled = true;
    const first = reactive.publication.reserve(64);
    version = first.version;
    first.commit(new ReactiveCommit(new Set(["active"]), [], active));
    await entered.promise;

    const second = reactive.publication.reserve(64);
    version = second.version;
    second.commit(new ReactiveCommit(new Set(["queued-µ", "overflow"])));
    await Promise.resolve();
    await Promise.resolve();

    expect(reactive.snapshot().revalidation).toMatchObject({
      concurrency: 1,
      active: 1,
      queue: {
        queuedItems: 1,
        queuedBytes: queuedBytes("queued-µ", { tag: "é" }, "tenant-é"),
        oldestAgeMs: 0,
        nextExpiryAtMs: 10,
        rejected: { items: 1, bytes: 0, age: 0 },
      },
    });

    now = 10;
    expect(reactive.snapshot().revalidation.queue).toMatchObject({
      queuedItems: 0,
      queuedBytes: 0,
      oldestAgeMs: 0,
      rejected: { items: 1, bytes: 0, age: 1 },
    });
    await second.completion;
    expect(overflow.errors).toMatchObject([{
      id: 3,
      outcome: {
        code: "overloaded",
        message: "Admission rejected: items",
        resource: "revalidation",
        retryable: true,
        retryAfterMs: 0,
      },
    }]);
    expect(queued.errors).toMatchObject([{
      id: 2,
      outcome: {
        code: "deadline_exceeded",
        message: "Admission rejected: age",
        resource: "revalidation",
        retryable: false,
      },
    }]);

    release.resolve();
    await first.completion;
    expect(active.cursor(1).commitVersion).toBe(2n);
  });

  test("accounts exact encoded revalidation bytes at the admission boundary", async () => {
    let version = 0n;
    let stalled = false;
    const entered = deferred();
    const release = deferred();
    const args = { tag: "é" };
    const scope = "tenant-é";
    const exactBytes = queuedBytes("queued-µ", args, scope);
    const reactive = new OrderedReactive({
      limits: testLimits({
        revalidationConcurrency: 1,
        revalidationMaxItems: 2,
        revalidationMaxBytes: exactBytes,
      }),
      generation: generationSequence(),
      evaluate: async ({ address }) => {
        const observed = version;
        if (stalled && address === "active") {
          entered.resolve();
          await release.promise;
        }
        return evaluation(`${address}@${observed}`, observed, address);
      },
    });
    const active = new RecordingSubscriber();
    const queued = new RecordingSubscriber();
    const overflow = new RecordingSubscriber();
    for (const [subscriber, id, address] of [
      [active, 1, "active"],
      [queued, 2, "queued-µ"],
      [overflow, 3, "overflow"],
    ] as const) {
      await reactive.subscribeQuery({
        address,
        args,
        policyScopeFingerprint: scope,
        fairnessKey: scope,
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    stalled = true;
    const first = reactive.publication.reserve(64);
    version = first.version;
    first.commit(new ReactiveCommit(new Set(["active"])));
    await entered.promise;
    const second = reactive.publication.reserve(64);
    version = second.version;
    second.commit(new ReactiveCommit(new Set(["queued-µ", "overflow"])));
    await Promise.resolve();
    await Promise.resolve();

    expect(reactive.snapshot().revalidation.queue).toMatchObject({
      queuedItems: 1,
      queuedBytes: exactBytes,
      rejected: { items: 0, bytes: 1 },
    });
    release.resolve();
    await Promise.all([first.completion, second.completion]);
    expect(overflow.errors).toMatchObject([{
      outcome: {
        code: "overloaded",
        message: "Admission rejected: bytes",
        resource: "revalidation",
      },
    }]);
  });

  test("makes round-robin progress across callers independently of policy fingerprints", async () => {
    let version = 0n;
    let revalidating = false;
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const reactive = new OrderedReactive({
      limits: testLimits({ revalidationConcurrency: 1 }),
      generation: generationSequence(),
      evaluate: async ({ address }) => {
        if (revalidating) {
          order.push(address);
          if (address === "block") {
            entered.resolve();
            await release.promise;
          }
        }
        return evaluation(`${address}@${version}`, version, address);
      },
    });
    const subscriber = new RecordingSubscriber();
    for (const [id, address, scope, fairnessKey] of [
      [1, "block", "claims-a-1", "caller-a"],
      [2, "a2", "claims-a-2", "caller-a"],
      [3, "a3", "claims-a-3", "caller-a"],
      [4, "b", "claims-b", "caller-b"],
    ] as const) {
      await reactive.subscribeQuery({
        address,
        args: null,
        policyScopeFingerprint: scope,
        fairnessKey,
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    revalidating = true;
    const slot = reactive.publication.reserve(64);
    version = slot.version;
    slot.commit(new ReactiveCommit(new Set(["block", "a2", "a3", "b"])));
    await entered.promise;
    expect(reactive.snapshot().revalidation).toMatchObject({
      active: 1,
      queue: { queuedItems: 3, activeFairnessKeys: 2 },
    });
    release.resolve();
    await slot.completion;

    expect(order).toEqual(["block", "a2", "b", "a3"]);
    expect(reactive.snapshot().revalidation).toMatchObject({
      active: 0,
      queue: { queuedItems: 0, queuedBytes: 0 },
    });
  });

  test("yields a revalidation turn when a hot entry becomes dirty again", async () => {
    let version = 0n;
    let revalidating = false;
    let blockFirstHot = true;
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const reactive = new OrderedReactive({
      limits: testLimits({ revalidationConcurrency: 1 }),
      generation: generationSequence(),
      evaluate: async ({ address }) => {
        const observed = version;
        if (revalidating) {
          order.push(address);
          if (address === "hot" && blockFirstHot) {
            blockFirstHot = false;
            entered.resolve();
            await release.promise;
          }
        }
        return evaluation(`${address}@${observed}`, observed, address);
      },
    });
    const subscriber = new RecordingSubscriber();
    for (const [id, address, scope] of [
      [1, "hot", "group-hot"],
      [2, "cold", "group-cold"],
    ] as const) {
      await reactive.subscribeQuery({
        address,
        args: null,
        policyScopeFingerprint: scope,
        fairnessKey: scope,
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    revalidating = true;
    const first = reactive.publication.reserve(64);
    version = first.version;
    first.commit(new ReactiveCommit(new Set(["hot", "cold"])));
    await entered.promise;

    const second = reactive.publication.reserve(64);
    version = second.version;
    second.commit(new ReactiveCommit(new Set(["hot"])));
    release.resolve();
    await Promise.all([first.completion, second.completion]);

    expect(order).toEqual(["hot", "cold", "hot"]);
    expect(reactive.snapshot().revalidation).toMatchObject({
      active: 0,
      queue: { queuedItems: 0, queuedBytes: 0 },
    });
  });

  test("a stalled group does not block an unrelated later publication or ordered events", async () => {
    let version = 0n;
    let stallA = false;
    const entered = deferred();
    const release = deferred();
    const reactive = new OrderedReactive({
      limits: testLimits({ revalidationConcurrency: 2 }),
      generation: generationSequence(),
      evaluate: async ({ address }) => {
        const observed = version;
        if (stallA && address === "a") {
          stallA = false;
          entered.resolve();
          await release.promise;
        }
        return evaluation(`${address}@${observed}`, observed, address);
      },
    });
    const firstCaller = new RecordingSubscriber();
    const secondCaller = new RecordingSubscriber();
    const eventSubscriber = new RecordingSubscriber();
    await reactive.subscribeQuery({
      address: "a",
      args: null,
      policyScopeFingerprint: "group-a",
      fairnessKey: "group-a",
      context: undefined,
      subscriber: firstCaller,
      id: 1,
      authEpoch: 0,
    });
    await reactive.subscribeQuery({
      address: "b",
      args: null,
      policyScopeFingerprint: "group-b",
      fairnessKey: "group-b",
      context: undefined,
      subscriber: secondCaller,
      id: 2,
      authEpoch: 0,
    });
    await reactive.subscribeEvent({
      subscriber: eventSubscriber,
      id: 3,
      table: "events",
      authEpoch: 0,
      args: null,
      matches: () => true,
    });

    stallA = true;
    const first = reactive.publication.reserve(64);
    version = first.version;
    const firstCommit = new ReactiveCommit(
      new Set(["a"]),
      [{ table: "events", row: "one" }],
      firstCaller,
    );
    first.commit(firstCommit);
    await entered.promise;
    let firstSettled = false;
    void first.completion.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );

    const second = reactive.publication.reserve(64);
    version = second.version;
    const secondCommit = new ReactiveCommit(
      new Set(["b"]),
      [{ table: "events", row: "two" }],
      secondCaller,
    );
    second.commit(secondCommit);
    await second.completion;

    expect(firstSettled).toBe(false);
    expect(firstCommit.result).toBeUndefined();
    expect(secondCommit.result).toMatchObject({ affectedCallerIds: [2], deliveryFailures: [] });
    expect(secondCaller.cursor(2).commitVersion).toBe(2n);
    expect(eventSubscriber.events.filter(({ event }) => event.kind === "row")).toMatchObject([
      { id: 3, event: { cursor: { commitVersion: 1n, sequence: 1n }, row: "one" } },
      { id: 3, event: { cursor: { commitVersion: 2n, sequence: 2n }, row: "two" } },
    ]);
    expect(reactive.publication.snapshot().processedHighWater).toBe(0n);

    release.resolve();
    await first.completion;
    expect(firstCommit.result).toMatchObject({ affectedCallerIds: [1], deliveryFailures: [] });
    expect(firstCaller.cursor(1).commitVersion).toBe(2n);
    expect(reactive.publication.snapshot().processedHighWater).toBe(2n);
  });

  test("resumes exact cursors, replays proven chains, and resets after history overflow", async () => {
    let version = 0n;
    let value = "zero";
    const reactive = new OrderedReactive({
      limits: testLimits({ maxTransitionsPerStream: 2 }),
      generation: generationSequence(),
      evaluate: async () => evaluation(value, version, "messages"),
    });
    const subscriber = new RecordingSubscriber();
    const options = {
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      authEpoch: 0,
    };
    await reactive.subscribeQuery({ ...options, id: 1 });
    const original = subscriber.cursor(1);
    reactive.disconnect(subscriber);

    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
      value = "one";
    });
    await reactive.subscribeQuery({ ...options, id: 2, cursor: original });
    expect(subscriber.transitions.at(-1)?.transition.kind).toBe("update");
    reactive.disconnect(subscriber);

    for (const next of ["two", "three"]) {
      await publish(reactive, new Set(["messages"]), (commitVersion) => {
        version = commitVersion;
        value = next;
      });
    }
    await reactive.subscribeQuery({ ...options, id: 3, cursor: original });
    expect(subscriber.transitions.at(-1)?.transition.kind).toBe("reset");
    const current = subscriber.cursor(3);
    reactive.disconnect(subscriber);
    await reactive.subscribeQuery({ ...options, id: 4, cursor: current });
    expect(subscriber.transitions.at(-1)?.transition.kind).toBe("resume");
    expect(reactive.snapshot().historyTransitions).toBe(2);
  });

  test("answers an explicit cursor mismatch with an in-place authoritative reset", async () => {
    let version = 0n;
    let value = "initial";
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async () => evaluation(value, version, "messages"),
    });
    const subscriber = new RecordingSubscriber();
    await reactive.subscribeQuery({
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 1,
      authEpoch: 2,
    });
    const unexpected = { ...subscriber.cursor(1), generation: "client-mismatch", commitVersion: 99n };

    await reactive.reset(subscriber, 1, unexpected);
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({ kind: "reset", from: unexpected });
    expect(reactive.snapshot().queryListeners).toBe(1);

    await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
      value = "still-attached";
    });
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({ kind: "update", value: "still-attached" });
  });

  test("evicts the oldest chain when the global history budget fills", async () => {
    let version = 0n;
    const values = new Map([["a", "a0"], ["b", "b0"]]);
    const reactive = new OrderedReactive({
      limits: testLimits({ maxHistoryBytes: 4, maxHistoryBytesPerStream: 4 }),
      generation: generationSequence(),
      evaluate: async ({ address }) => evaluation(values.get(address), version, address),
    });
    const subscriber = new RecordingSubscriber();
    const subscribe = (id: number, address: string, cursor?: SubscriptionCursor) => reactive.subscribeQuery({
      address,
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id,
      authEpoch: 0,
      cursor,
    });
    await subscribe(1, "a");
    await subscribe(2, "b");
    const a0 = subscriber.cursor(1);
    const b0 = subscriber.cursor(2);
    reactive.disconnect(subscriber);

    await publish(reactive, new Set(["a", "b"]), (commitVersion) => {
      version = commitVersion;
      values.set("a", "a1");
      values.set("b", "b1");
    });
    expect(reactive.snapshot()).toMatchObject({ historyTransitions: 1, historyBytes: 4 });

    await subscribe(3, "a", a0);
    await subscribe(4, "b", b0);
    expect(subscriber.transitions.findLast(({ id }) => id === 3)?.transition.kind).toBe("reset");
    expect(subscriber.transitions.findLast(({ id }) => id === 4)?.transition.kind).toBe("update");
  });

  test("accounts each history transition exactly once across global eviction and age pruning", async () => {
    let now = 0;
    let version = 0n;
    const values = new Map([["a", "a0"], ["b", "b0"]]);
    const reactive = new OrderedReactive({
      limits: testLimits({
        maxHistoryBytes: 4,
        maxHistoryBytesPerStream: 4,
        maxHistoryAgeMs: 10,
      }),
      now: () => now,
      generation: generationSequence(),
      evaluate: async ({ address }) => evaluation(values.get(address), version, address),
    });
    const subscriber = new RecordingSubscriber();
    for (const [id, address] of [[1, "a"], [2, "b"]] as const) {
      await reactive.subscribeQuery({
        address,
        args: null,
        policyScopeFingerprint: "public",
        fairnessKey: "public",
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    await publish(reactive, new Set(["a"]), (commitVersion) => {
      version = commitVersion;
      values.set("a", "a1");
    });
    expect(reactive.snapshot()).toMatchObject({ historyTransitions: 1, historyBytes: 4 });

    await publish(reactive, new Set(["b"]), (commitVersion) => {
      version = commitVersion;
      values.set("b", "b1");
    });
    // Retaining b1 evicts a1 globally: one leaves and one enters.
    expect(reactive.snapshot()).toMatchObject({ historyTransitions: 1, historyBytes: 4 });

    now = 9;
    reactive.prune();
    expect(reactive.snapshot()).toMatchObject({ historyTransitions: 1, historyBytes: 4 });
    now = 10;
    reactive.prune();
    expect(reactive.snapshot()).toMatchObject({ historyTransitions: 0, historyBytes: 0 });
  });

  test("indexes precise reads and exposes replay convergence obligations", async () => {
    let version = 0n;
    const calls = new Map<string, number>();
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async ({ address }) => {
        calls.set(address, (calls.get(address) ?? 0) + 1);
        return evaluation(`${address}@${version}`, version, address);
      },
    });
    const subscriber = new RecordingSubscriber();
    for (const [id, address] of [[2, "rooms"], [1, "messages"]] as const) {
      await reactive.subscribeQuery({
        address,
        args: null,
        policyScopeFingerprint: "public",
        fairnessKey: "public",
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    subscriber.failNextTransition.add(1);
    const precise = await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
    }, { caller: subscriber });
    expect(precise.affectedCallerIds).toEqual([1]);
    expect(precise.deliveryFailures).toMatchObject([{ subscriptionId: 1, phase: "delivery" }]);
    expect(calls).toEqual(new Map([["rooms", 1], ["messages", 2]]));

    const recovered = await reactive.converge(subscriber, version);
    expect(recovered).toMatchObject({ affectedCallerIds: [1, 2], deliveryFailures: [] });
    expect(subscriber.cursor(1).commitVersion).toBe(version);
    expect(subscriber.cursor(2).commitVersion).toBe(version);

    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    });
    expect(reactive.queryIds(subscriber)).toEqual([1, 2]);
    const converged = await reactive.converge(subscriber, version);
    expect(converged).toMatchObject({ affectedCallerIds: [1, 2], deliveryFailures: [] });
    expect(subscriber.cursor(1).commitVersion).toBe(version);
    expect(subscriber.cursor(2).commitVersion).toBe(version);
    expect(calls).toEqual(new Map([["rooms", 3], ["messages", 3]]));
  });

  test("reports convergence failure and revokes auth failures even when notification succeeds", async () => {
    let version = 0n;
    let authFailure = false;
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async () => {
        if (authFailure) throw new DbzzError("unauthorized", "Room access was revoked");
        return evaluation("visible", version, "messages");
      },
    });
    const subscriber = new RecordingSubscriber();
    await reactive.subscribeQuery({
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "room:7",
      fairnessKey: "room:7",
      context: undefined,
      subscriber,
      id: 7,
      authEpoch: 1,
    });

    const result = await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
      authFailure = true;
    }, { caller: subscriber });

    expect(result.affectedCallerIds).toEqual([7]);
    expect(result.deliveryFailures).toHaveLength(1);
    expect(result.deliveryFailures[0]).toMatchObject({
      subscriptionId: 7,
      kind: "query",
      phase: "convergence",
      error: { code: "unauthorized" },
    });
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({
      kind: "revoked",
      outcome: { code: "unauthorized" },
    });
    expect(reactive.queryIds(subscriber)).toEqual([]);
  });

  test("tracks live-only event sequence and emits a gap after failed delivery", async () => {
    let version = 0n;
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async () => evaluation(null, version, "unused"),
    });
    const subscriber = new RecordingSubscriber();
    await reactive.subscribeEvent({
      subscriber,
      id: 9,
      table: "messages",
      authEpoch: 2,
      args: {},
      matches: () => true,
    });

    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "messages", row: "one" }] });
    subscriber.failNextEvent.add(9);
    const failed = await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "messages", row: "missed" }] });
    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "messages", row: "after-gap" }] });
    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "messages", row: "resumed" }] });

    expect(failed.deliveryFailures).toMatchObject([{ subscriptionId: 9, kind: "event", phase: "delivery" }]);
    expect(subscriber.events.map(({ event }) => event.kind)).toEqual(["reset", "row", "gap", "row"]);
    expect(subscriber.events[2]?.event.cursor).toMatchObject({ commitVersion: 3n, sequence: 2n });

    reactive.disconnect(subscriber);
    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "messages", row: "not-replayed" }] });
    await reactive.subscribeEvent({
      subscriber,
      id: 10,
      table: "messages",
      authEpoch: 2,
      args: {},
      matches: () => true,
    });
    expect(subscriber.events.at(-1)?.event).toMatchObject({
      kind: "reset",
      cursor: { commitVersion: 5n, sequence: 0n },
    });
  });

  test("partitions event rows per listener without exposing mutable matcher input", async () => {
    let version = 0n;
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      evaluate: async () => evaluation(null, version, "unused"),
    });
    const subscriber = new RecordingSubscriber();
    const seenRooms: string[] = [];
    await reactive.subscribeEvent({
      subscriber,
      id: 11,
      table: "typing",
      authEpoch: 1,
      args: Object.freeze({ room: "a" }),
      matches: (value, args) => {
        const row = value as { room: string };
        seenRooms.push(row.room);
        expect(Object.isFrozen(row)).toBe(true);
        expect(Reflect.set(row, "room", "mutated")).toBe(false);
        return row.room === (args as { room: string }).room;
      },
    });
    await reactive.subscribeEvent({
      subscriber,
      id: 12,
      table: "typing",
      authEpoch: 1,
      args: Object.freeze({ room: "b" }),
      matches: (value, args) => {
        const row = value as { room: string };
        seenRooms.push(row.room);
        return row.room === (args as { room: string }).room;
      },
    });

    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "typing", row: { room: "a" } }] });
    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "typing", row: { room: "b" } }] });

    expect(seenRooms).toEqual(["a", "a", "b", "b"]);
    expect(subscriber.events.filter(({ event }) => event.kind === "row")).toMatchObject([
      { id: 11, event: { cursor: { sequence: 1n }, row: { room: "a" } } },
      { id: 12, event: { cursor: { sequence: 1n }, row: { room: "b" } } },
    ]);
  });

  test("detaches on auth rotation and requires an explicit subscription refresh", async () => {
    let version = 0n;
    const reactive = new OrderedReactive<string>({
      generation: generationSequence(),
      evaluate: async ({ context }) => evaluation(context, version, "messages"),
    });
    const subscriber = new RecordingSubscriber();
    const base = {
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "user:1",
      fairnessKey: "user:1",
      subscriber,
    };
    await reactive.subscribeQuery({ ...base, context: "old-context", id: 1, authEpoch: 1 });
    await reactive.subscribeEvent({
      subscriber,
      id: 2,
      table: "messages",
      authEpoch: 1,
      args: {},
      matches: () => true,
    });

    const rotated = await reactive.rotateAuth(subscriber, 2);
    expect(rotated).toMatchObject({ queryIds: [1], eventIds: [2], deliveryFailures: [] });
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({
      kind: "revoked",
      outcome: { code: "auth_stale" },
      to: { authEpoch: 2 },
    });
    expect(subscriber.errors).toHaveLength(0);
    expect(reactive.snapshot()).toMatchObject({ queryListeners: 0, eventListeners: 0 });

    await reactive.subscribeQuery({
      ...base,
      policyScopeFingerprint: "user:1:refreshed",
      fairnessKey: "user:1:refreshed",
      context: "fresh-context",
      id: 3,
      authEpoch: 2,
    });
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({ kind: "reset", value: "fresh-context" });
    await reactive.revoke(subscriber, 3);
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({
      kind: "revoked",
      outcome: { code: "unauthorized" },
      to: { authEpoch: 3 },
    });
  });

  test("bounds result bytes, shared entries, and dormant lifetime", async () => {
    const oversized = new OrderedReactive({
      limits: testLimits({ maxSharedResultBytes: 3 }),
      generation: generationSequence(),
      evaluate: async () => ({ value: "four", encoded: "four", readSet: new Set(), commitVersion: 0n }),
    });
    await expect(oversized.subscribeQuery({
      address: "too-large",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber: new RecordingSubscriber(),
      id: 1,
      authEpoch: 0,
    })).rejects.toMatchObject({ code: "overloaded" });
    expect(oversized.snapshot()).toMatchObject({ sharedEntries: 0, resultBytes: 0 });

    let now = 0;
    const bounded = new OrderedReactive({
      limits: testLimits({ maxSharedSubscriptions: 1, maxHistoryAgeMs: 10 }),
      now: () => now,
      generation: generationSequence(),
      evaluate: async ({ address }) => evaluation(address, 0n, address),
    });
    const subscriber = new RecordingSubscriber();
    await bounded.subscribeQuery({
      address: "first",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 1,
      authEpoch: 0,
    });
    bounded.disconnect(subscriber);
    await bounded.subscribeQuery({
      address: "second",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 2,
      authEpoch: 0,
    });
    expect(bounded.snapshot()).toMatchObject({ sharedEntries: 1, queryListeners: 1 });
    bounded.disconnect(subscriber);
    now = 10;
    expect(bounded.prune()).toBe(1);
    expect(bounded.snapshot().sharedEntries).toBe(0);
  });

  test("rejects a result larger than one frame before retaining or delivering it", async () => {
    const subscriber = new RecordingSubscriber();
    const reactive = new OrderedReactive({
      limits: testLimits({ maxFrameBytes: 64, maxSharedResultBytes: 1_024 }),
      generation: generationSequence(),
      evaluate: async () => evaluation("x".repeat(64), 0n),
    });

    await expect(reactive.subscribeQuery({
      address: "too-large-for-frame",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 1,
      authEpoch: 0,
    })).rejects.toMatchObject({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "subscription",
      message: "Query result exceeds maxFrameBytes",
    });
    expect(subscriber.transitions).toEqual([]);
    expect(subscriber.errors).toEqual([]);
    expect(reactive.queryIds(subscriber)).toEqual([]);
    expect(reactive.snapshot()).toMatchObject({
      sharedEntries: 0,
      queryListeners: 0,
      resultBytes: 0,
      historyTransitions: 0,
      historyBytes: 0,
      evaluatingEntries: 0,
    });
  });

  test("terminates an active subscription when a recompute grows beyond one frame", async () => {
    let version = 0n;
    let value = "ok";
    const subscriber = new RecordingSubscriber();
    const reactive = new OrderedReactive({
      limits: testLimits({ maxFrameBytes: 512, maxSharedResultBytes: 1_024 }),
      generation: generationSequence(),
      evaluate: async () => evaluation(value, version, "messages"),
    });
    await reactive.subscribeQuery({
      address: "messages.list",
      args: null,
      policyScopeFingerprint: "public",
      fairnessKey: "public",
      context: undefined,
      subscriber,
      id: 1,
      authEpoch: 0,
    });
    expect(subscriber.transitions).toHaveLength(1);
    expect(reactive.snapshot()).toMatchObject({ sharedEntries: 1, queryListeners: 1, resultBytes: 4 });

    const result = await publish(reactive, new Set(["messages"]), (commitVersion) => {
      version = commitVersion;
      value = "x".repeat(512);
    });

    expect(result.deliveryFailures).toMatchObject([{
      subscriptionId: 1,
      kind: "query",
      phase: "convergence",
      error: { code: "overloaded", resource: "subscription" },
    }]);
    expect(subscriber.transitions).toHaveLength(1);
    expect(subscriber.errors).toEqual([{
      id: 1,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
        message: "Query result exceeds maxFrameBytes",
      },
    }]);
    expect(reactive.queryIds(subscriber)).toEqual([]);
    expect(reactive.snapshot()).toMatchObject({
      sharedEntries: 0,
      queryListeners: 0,
      resultBytes: 0,
      historyTransitions: 0,
      historyBytes: 0,
      evaluatingEntries: 0,
    });
  });

  test("observes query stages with safe metadata and exact queue timing", async () => {
    const secret = "never-emit-this-query-payload";
    let now = 0;
    let version = 0n;
    let stalled = false;
    const entered = deferred();
    const release = deferred();
    const observations: ReactiveObservation[] = [];
    const values = new Map<string, unknown>([
      ["a", { state: "initial", secret }],
      ["b", { state: "stable" }],
      ["c", { state: "unaffected" }],
    ]);
    const reactive = new OrderedReactive({
      limits: testLimits({ revalidationConcurrency: 1 }),
      now: () => now,
      generation: generationSequence(),
      observer: (observation) => observations.push(observation),
      evaluate: async ({ address }) => {
        const observedVersion = version;
        if (stalled && address === "a") {
          entered.resolve();
          await release.promise;
        }
        return evaluation(values.get(address), observedVersion, address);
      },
    });
    const subscriber = new RecordingSubscriber();
    for (const [id, address] of [[1, "a"], [2, "b"], [3, "c"]] as const) {
      await reactive.subscribeQuery({
        address,
        args: { secret },
        policyScopeFingerprint: `scope:${secret}`,
        fairnessKey: `scope:${secret}`,
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }

    expect(observations.filter(({ phase }) => phase === "initial_evaluation").map(({ address }) => address))
      .toEqual(["a", "b", "c"]);
    expect(observations.filter(({ phase }) => phase === "delivery").map(({ subscriptionId }) => subscriptionId))
      .toEqual([1, 2, 3]);
    expect(observations.every(Object.isFrozen)).toBe(true);
    observations.length = 0;

    stalled = true;
    now = 10;
    values.set("a", { state: "changed", secret });
    const slot = reactive.publication.reserve(64);
    version = slot.version;
    slot.commit(new ReactiveCommit(new Set(["a", "b"])));
    await entered.promise;
    now = 25;
    release.resolve();
    await slot.completion;

    const invalidations = observations.filter(({ phase }) => phase === "invalidation_match");
    expect(invalidations).toEqual([{
      kind: "query",
      phase: "invalidation_match",
      outcome: "matched",
      durationMs: 0,
      commitVersion: 1n,
      dependencyCount: 2,
      resultCount: 2,
    }]);
    expect(observations.filter(({ phase }) => phase === "evaluation").map(({ address }) => address))
      .toEqual(["a", "b"]);
    expect(observations.filter(({ phase }) => phase === "changed").map(({ address }) => address))
      .toEqual(["a"]);
    expect(observations.filter(({ phase }) => phase === "unchanged").map(({ address }) => address))
      .toEqual(["b"]);
    expect(observations.find(({ phase, address }) => phase === "revalidation_queue" && address === "b"))
      .toMatchObject({ outcome: "ok", durationMs: 15, commitVersion: 1n });
    expect(observations.filter(({ phase }) => phase === "fanout").map(({ address, resultCount }) => [address, resultCount]))
      .toEqual([["a", 1], ["b", 1]]);
    expect(observations.filter(({ phase }) => phase === "delivery").map(({ subscriptionId }) => subscriptionId))
      .toEqual([1, 2]);
    expect(observations.some(({ phase, address }) => phase === "evaluation" && address === "c"))
      .toBe(false);

    observations.length = 0;
    const unmatched = reactive.publication.reserve(64);
    version = unmatched.version;
    unmatched.commit(new ReactiveCommit(new Set(["unobserved-key"])));
    await unmatched.completion;
    expect(observations.filter(({ phase }) => phase === "invalidation_match")).toEqual([
      {
        kind: "query",
        phase: "invalidation_match",
        outcome: "unmatched",
        durationMs: 0,
        commitVersion: 2n,
        dependencyCount: 1,
        resultCount: 0,
      },
    ]);
    expect(observations.filter(({ phase }) => phase === "evaluation")).toHaveLength(0);

    observations.length = 0;
    await publish(reactive, new Set(), (nextVersion) => {
      version = nextVersion;
    });
    expect(observations.filter(({ phase }) => phase === "invalidation_match")).toHaveLength(0);

    const emptyObservations: ReactiveObservation[] = [];
    const empty = new OrderedReactive({
      observer: (observation) => emptyObservations.push(observation),
      evaluate: async () => evaluation(null, 0n, "unused"),
    });
    const emptyPublication = empty.publication.reserve(64);
    emptyPublication.commit(new ReactiveCommit(new Set(["unobserved-key"])));
    await emptyPublication.completion;
    expect(emptyObservations).toHaveLength(0);

    now = 30;
    const gate = subscriber.gateNextTransition(1);
    const firstReset = reactive.reset(subscriber, 1, subscriber.cursor(1));
    await gate.entered;
    const queuedFrom = observations.length;
    const secondReset = reactive.reset(subscriber, 1, subscriber.cursor(1));
    now = 45;
    gate.release();
    await Promise.all([firstReset, secondReset]);
    expect(observations.slice(queuedFrom).find(({ phase }) => phase === "listener_queue"))
      .toMatchObject({
        kind: "query",
        subscriptionId: 1,
        commitVersion: 1n,
        outcome: "ok",
        durationMs: 15,
      });

    const allowedKeys = new Set([
      "kind",
      "phase",
      "outcome",
      "durationMs",
      "address",
      "subscriptionId",
      "commitVersion",
      "dependencyCount",
      "resultCount",
      "byteCount",
    ]);
    expect(observations.every((observation) =>
      Object.keys(observation).every((key) => allowedKeys.has(key))
    )).toBe(true);
    expect(observations.every(Object.isFrozen)).toBe(true);
    const serialized = JSON.stringify(observations, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(serialized).not.toContain(secret);
    for (const forbidden of ["args", "row", "identity", "value", "policyScopeFingerprint"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
  });

  test("observes invalidation work in proportion to affected query state", async () => {
    const observations: ReactiveObservation[] = [];
    let version = 0n;
    const reactive = new OrderedReactive({
      observer: (observation) => observations.push(observation),
      evaluate: async ({ address }) => evaluation(address, version, `read:${address}`),
    });
    const subscriber = new RecordingSubscriber();
    for (let id = 1; id <= 256; id++) {
      await reactive.subscribeQuery({
        address: `query-${id}`,
        args: {},
        policyScopeFingerprint: "scope",
        fairnessKey: "caller",
        context: undefined,
        subscriber,
        id,
        authEpoch: 0,
      });
    }
    observations.length = 0;

    await publish(reactive, new Set(["read:query-256"]), (nextVersion) => {
      version = nextVersion;
    });

    expect(observations.filter(({ phase }) => phase === "invalidation_match")).toEqual([{
      kind: "query",
      phase: "invalidation_match",
      outcome: "matched",
      durationMs: 0,
      commitVersion: 1n,
      dependencyCount: 1,
      resultCount: 1,
    }]);
  });

  test("observer failures are fail-open across event matching and failed delivery", async () => {
    const secret = "never-emit-this-event-row";
    const observations: ReactiveObservation[] = [];
    let observerCalls = 0;
    const reactive = new OrderedReactive({
      generation: generationSequence(),
      observer: (observation) => {
        observations.push(observation);
        observerCalls++;
        if (observerCalls % 2 === 1) throw new Error("observer failed synchronously");
        return Promise.reject(new Error("observer failed asynchronously"));
      },
      evaluate: async () => evaluation(null, 0n, "unused"),
    });
    const subscriber = new RecordingSubscriber();
    await reactive.subscribeEvent({
      subscriber,
      id: 10,
      table: "typing",
      authEpoch: 0,
      args: { room: "a", secret },
      matches: (row, args) =>
        (row as { room: string }).room === (args as { room: string }).room,
    });
    await reactive.subscribeEvent({
      subscriber,
      id: 11,
      table: "typing",
      authEpoch: 0,
      args: { room: "b", secret },
      matches: (row, args) =>
        (row as { room: string }).room === (args as { room: string }).room,
    });
    observations.length = 0;
    subscriber.failNextEvent.add(10);

    const failed = await publish(reactive, new Set(), () => {}, {
      events: [{ table: "typing", row: { room: "a", secret } }],
    });
    expect(failed.deliveryFailures).toMatchObject([{
      subscriptionId: 10,
      kind: "event",
      phase: "delivery",
    }]);
    expect(observations.filter(({ phase }) => phase === "event_match")).toMatchObject([
      { subscriptionId: 10, outcome: "matched", resultCount: 1 },
      { subscriptionId: 11, outcome: "unmatched", resultCount: 0 },
    ]);
    expect(observations).toContainEqual(expect.objectContaining({
      kind: "event",
      phase: "delivery",
      outcome: "internal",
      subscriptionId: 10,
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      kind: "event",
      phase: "failure",
      outcome: "internal",
      subscriptionId: 10,
    }));
    expect(observations.some(({ phase, subscriptionId }) =>
      phase === "delivery" && subscriptionId === 11
    )).toBe(false);

    const recovered = await publish(reactive, new Set(), () => {}, {
      events: [{ table: "typing", row: { room: "a", secret } }],
    });
    expect(recovered.deliveryFailures).toEqual([]);
    expect(subscriber.events.filter(({ id }) => id === 10).at(-1)?.event.kind).toBe("gap");
    await Promise.resolve();
    expect(observerCalls).toBeGreaterThan(0);
    expect(observations.every(Object.isFrozen)).toBe(true);
    const serialized = JSON.stringify(observations, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(serialized).not.toContain(secret);
    for (const forbidden of ["args", "row", "identity", "value", "policyScopeFingerprint"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
  });
});
