import { describe, expect, test } from "bun:test";
import type {
  LiveEvent,
  Outcome,
  SubscriptionCursor,
  SubscriptionTransition,
} from "@dbzz/core";
import { DbzzError } from "../src/errors.ts";
import { defineServiceLimits, PRODUCTION_LIMITS, type ServiceLimits } from "../src/limits.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type ReactiveCommitResult,
  type Subscriber,
} from "../src/reactive.ts";

class RecordingSubscriber implements Subscriber {
  readonly transitions: Array<{ id: number; transition: SubscriptionTransition }> = [];
  readonly events: Array<{ id: number; event: LiveEvent }> = [];
  readonly errors: Array<{ id: number; outcome: Outcome }> = [];
  readonly failNextTransition = new Set<number>();
  readonly failNextEvent = new Set<number>();

  async sendTransition(id: number, transition: SubscriptionTransition): Promise<void> {
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
}

interface LimitOverrides {
  maxSharedSubscriptions?: number;
  maxSharedResultBytes?: number;
  maxTransitionsPerStream?: number;
  maxHistoryBytes?: number;
  maxHistoryBytesPerStream?: number;
  maxHistoryAgeMs?: number;
}

function testLimits(overrides: LimitOverrides = {}): ServiceLimits {
  const maxHistoryBytes = overrides.maxHistoryBytes ?? PRODUCTION_LIMITS.resume.maxBytes;
  return defineServiceLimits({
    ...PRODUCTION_LIMITS,
    maxSharedSubscriptions: overrides.maxSharedSubscriptions ?? PRODUCTION_LIMITS.maxSharedSubscriptions,
    maxSharedResultBytes: overrides.maxSharedResultBytes ?? PRODUCTION_LIMITS.maxSharedResultBytes,
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
    const common = { address: "messages.list", args: { room: 7 }, policyScopeFingerprint: "room:7" };

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
    await reactive.subscribeEvent({ subscriber, id: 9, table: "messages", authEpoch: 2 });

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
    expect(subscriber.events[2]?.event.cursor).toMatchObject({ commitVersion: 3n, sequence: 3n });

    reactive.disconnect(subscriber);
    await publish(reactive, new Set(), (commitVersion) => {
      version = commitVersion;
    }, { events: [{ table: "messages", row: "not-replayed" }] });
    await reactive.subscribeEvent({ subscriber, id: 10, table: "messages", authEpoch: 2 });
    expect(subscriber.events.at(-1)?.event).toMatchObject({
      kind: "reset",
      cursor: { commitVersion: 5n, sequence: 0n },
    });
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
      subscriber,
    };
    await reactive.subscribeQuery({ ...base, context: "old-context", id: 1, authEpoch: 1 });
    await reactive.subscribeEvent({ subscriber, id: 2, table: "messages", authEpoch: 1 });

    const rotated = await reactive.rotateAuth(subscriber, 2);
    expect(rotated).toMatchObject({ queryIds: [1], eventIds: [2], deliveryFailures: [] });
    expect(subscriber.transitions.at(-1)?.transition).toMatchObject({
      kind: "revoked",
      outcome: { code: "auth_stale" },
      to: { authEpoch: 2 },
    });
    expect(subscriber.errors.at(-1)?.outcome.code).toBe("auth_stale");
    expect(reactive.snapshot()).toMatchObject({ queryListeners: 0, eventListeners: 0 });

    await reactive.subscribeQuery({
      ...base,
      policyScopeFingerprint: "user:1:refreshed",
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
});
