/**
 * PROTOTYPE — targeted measurements for the T1 server hot-path audit.
 *
 * Question: do the proposed ownership changes reduce useful hot-path latency
 * without weakening publication, listener-ordering, or durability invariants?
 *
 * Run one experiment with:
 *   bun bench/t1-hotpath-prototype.ts event-fanout
 *   bun bench/t1-hotpath-prototype.ts query-revalidation
 */
import type { LiveEvent, Outcome, SubscriptionTransition } from "@ackerdb/core";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type Subscriber,
} from "../packages/server/src/subscriptions/reactive.ts";
import { latencyStats } from "./load-engine.ts";

const WARMUP_TRIALS = 3;
const MEASURED_TRIALS = 20;
const EVENT_LISTENERS = 100;
const DELIVERY_DELAY_MS = 1;
const REVALIDATIONS_PER_TRIAL = 500;
const QUERY_ARGUMENT_ITEMS = 1_000;

function evaluation(): QueryEvaluation {
  return {
    value: null,
    encoded: "null",
    readSet: new Set(),
    commitVersion: 0n,
  };
}

class DelayedEventSubscriber implements Subscriber {
  constructor(private readonly delayMs: number) {}

  async sendTransition(_id: number, _transition: SubscriptionTransition): Promise<void> {}

  async sendEvent(_id: number, event: LiveEvent): Promise<void> {
    if (event.kind !== "reset" && this.delayMs > 0) await Bun.sleep(this.delayMs);
  }

  async sendError(_id: number, _outcome: Outcome): Promise<void> {}
}

async function publish(
  reactive: OrderedReactive,
  table: string,
  row: unknown,
): Promise<void> {
  const slot = reactive.publication.reserve(64);
  slot.commit(new ReactiveCommit(new Set(), [{ table, row }]));
  await slot.completion;
}

async function eventTrial(): Promise<number> {
  const reactive = new OrderedReactive({ evaluate: async () => evaluation() });
  const subscriber = new DelayedEventSubscriber(DELIVERY_DELAY_MS);
  for (let id = 1; id <= EVENT_LISTENERS; id++) {
    await reactive.subscribeEvent({
      subscriber,
      id,
      table: "messages",
      authEpoch: 0,
      args: null,
      matches: () => true,
    });
  }
  const startedAt = performance.now();
  await publish(reactive, "messages", { body: "fanout" });
  const durationMs = performance.now() - startedAt;
  await reactive.close();
  return durationMs;
}

async function unrelatedCommitTrial(): Promise<number> {
  const reactive = new OrderedReactive({ evaluate: async () => evaluation() });
  await reactive.subscribeEvent({
    subscriber: new DelayedEventSubscriber(10),
    id: 1,
    table: "slow",
    authEpoch: 0,
    args: null,
    matches: () => true,
  });
  await reactive.subscribeEvent({
    subscriber: new DelayedEventSubscriber(0),
    id: 2,
    table: "fast",
    authEpoch: 0,
    args: null,
    matches: () => true,
  });
  const slow = publish(reactive, "slow", { value: 1 });
  const startedAt = performance.now();
  await publish(reactive, "fast", { value: 2 });
  const durationMs = performance.now() - startedAt;
  await slow;
  await reactive.close();
  return durationMs;
}

async function measure(trial: () => Promise<number>) {
  for (let index = 0; index < WARMUP_TRIALS; index++) await trial();
  const durations: number[] = [];
  for (let index = 0; index < MEASURED_TRIALS; index++) durations.push(await trial());
  return latencyStats(durations);
}

async function eventFanout(): Promise<void> {
  console.log(JSON.stringify({
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString().trim(),
    operation: "event-fanout",
    load: {
      listeners: EVENT_LISTENERS,
      deliveryDelayMs: DELIVERY_DELAY_MS,
      measuredTrials: MEASURED_TRIALS,
      unrelatedSlowDeliveryMs: 10,
    },
    fanoutLatencyMs: await measure(eventTrial),
    unrelatedCommitLatencyMs: await measure(unrelatedCommitTrial),
  }, null, 2));
}

async function queryRevalidationTrial(): Promise<number> {
  let version = 0n;
  const reactive = new OrderedReactive({
    evaluate: async () => ({
      value: version,
      encoded: String(version),
      readSet: new Set(["hot"]),
      commitVersion: version,
    }),
  });
  await reactive.subscribeQuery({
    subscriber: new DelayedEventSubscriber(0),
    id: 1,
    address: "messages.largeArgs",
    authEpoch: 0,
    args: {
      filters: Array.from({ length: QUERY_ARGUMENT_ITEMS }, (_, index) =>
        `filter-${index.toString().padStart(4, "0")}`),
    },
    policyScopeFingerprint: "public",
    fairnessKey: "public",
    context: undefined,
  });
  const startedAt = performance.now();
  for (let index = 0; index < REVALIDATIONS_PER_TRIAL; index++) {
    const slot = reactive.publication.reserve(64);
    version = slot.version;
    slot.commit(new ReactiveCommit(new Set(["hot"])));
    await slot.completion;
  }
  const durationMs = performance.now() - startedAt;
  await reactive.close();
  return durationMs;
}

async function queryRevalidation(): Promise<void> {
  const stats = await measure(queryRevalidationTrial);
  console.log(JSON.stringify({
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString().trim(),
    operation: "query-revalidation",
    load: {
      argumentItems: QUERY_ARGUMENT_ITEMS,
      revalidationsPerTrial: REVALIDATIONS_PER_TRIAL,
      measuredTrials: MEASURED_TRIALS,
      concurrency: 1,
    },
    trialLatencyMs: stats,
    p50RevalidationsPerSec: REVALIDATIONS_PER_TRIAL / (stats.p50Ms / 1_000),
  }, null, 2));
}

switch (process.argv[2]) {
  case "event-fanout":
    await eventFanout();
    break;
  case "query-revalidation":
    await queryRevalidation();
    break;
  default:
    throw new Error(
      "usage: bun bench/t1-hotpath-prototype.ts <event-fanout|query-revalidation>",
    );
}
