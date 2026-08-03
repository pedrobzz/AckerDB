/**
 * PROTOTYPE — targeted measurements for the T1 server hot-path audit.
 *
 * Question: do the proposed ownership changes reduce useful hot-path latency
 * without weakening publication, listener-ordering, or durability invariants?
 *
 * Run one experiment with:
 *   bun bench/t1-hotpath-prototype.ts event-fanout
 *   bun bench/t1-hotpath-prototype.ts query-revalidation
 *   bun bench/t1-hotpath-prototype.ts http-auth-reject
 *   bun bench/t1-hotpath-prototype.ts scheduler-rearm
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveEvent, Outcome, SubscriptionTransition } from "@ackerdb/core";
import type { CredentialVerifier } from "../packages/server/src/auth/credentials.ts";
import { mutation, procedure } from "../packages/server/src/app/functions.ts";
import { Registry } from "../packages/server/src/app/registry.ts";
import { Engine } from "../packages/server/src/database/engine.ts";
import { Runtime } from "../packages/server/src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../packages/server/src/schema/definition.ts";
import { reconcile } from "../packages/server/src/schema/reconcile.ts";
import { AckerDBError } from "../packages/server/src/shared/errors.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type Subscriber,
} from "../packages/server/src/subscriptions/reactive.ts";
import { serve } from "../packages/server/src/transport/server.ts";
import { v } from "../packages/server/src/validation/v.ts";
import { latencyStats } from "./load-engine.ts";

const WARMUP_TRIALS = 3;
const MEASURED_TRIALS = 20;
const EVENT_LISTENERS = 100;
const DELIVERY_DELAY_MS = 1;
const REVALIDATIONS_PER_TRIAL = 500;
const QUERY_ARGUMENT_ITEMS = 1_000;
const HTTP_REJECTIONS_PER_TRIAL = 100;
const HTTP_REJECTION_CONCURRENCY = 10;
const HTTP_BODY_BYTES = 64 * 1024;
const SCHEDULED_TABLES = 100;
const SCHEDULER_REARMS_PER_TRIAL = 100;

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

async function httpAuthReject(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-t1-http-"));
  const schema = defineSchema({
    state: defineTable({ id: v.primaryKey() }),
  });
  const functions = {
    protected: {
      echo: procedure({
        access: "authenticated",
        http: true,
        args: { value: v.string() },
        handler: (_ctx: unknown, args: { value: string }) => args.value.length,
      }),
    },
  };
  const verifier: CredentialVerifier = {
    revocationBound: { kind: "token-expiration" },
    verify: async () => {
      throw new AckerDBError("unauthenticated", "invalid benchmark credential");
    },
    subscribeInvalidation: () => () => {},
  };
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    verifier,
    telemetry: false,
  });
  const server = serve({ runtime, port: 0 });
  const body = JSON.stringify({ value: "x".repeat(HTTP_BODY_BYTES - 12) });
  const url = `http://127.0.0.1:${server.port}/api/protected/echo`;
  const trial = async (): Promise<number> => {
    const startedAt = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: HTTP_REJECTION_CONCURRENCY }, async () => {
      for (;;) {
        const request = next++;
        if (request >= HTTP_REJECTIONS_PER_TRIAL) return;
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer invalid" },
          body,
        });
        if (response.status !== 401) throw new Error(`expected 401, received ${response.status}`);
        await response.text();
      }
    }));
    return performance.now() - startedAt;
  };
  try {
    const stats = await measure(trial);
    console.log(JSON.stringify({
      commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
        .stdout.toString().trim(),
      operation: "http-auth-reject",
      load: {
        bodyBytes: Buffer.byteLength(body),
        requestsPerTrial: HTTP_REJECTIONS_PER_TRIAL,
        concurrency: HTTP_REJECTION_CONCURRENCY,
        measuredTrials: MEASURED_TRIALS,
      },
      trialLatencyMs: stats,
      p50RequestsPerSec: HTTP_REJECTIONS_PER_TRIAL / (stats.p50Ms / 1_000),
    }, null, 2));
  } finally {
    await server.drain();
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
}

async function schedulerRearm(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-t1-scheduler-"));
  const schema = defineSchema(Object.fromEntries(
    Array.from({ length: SCHEDULED_TABLES }, (_, index) => [
      `jobs_${index}`,
      defineTable({ id: v.primaryKey(), at: v.scheduleAt() }).scheduled("jobs.fire"),
    ]),
  ));
  const functions = {
    jobs: {
      fire: mutation({
        access: "system",
        args: { id: v.bigint(), at: v.float() },
        handler: () => {},
      }),
    },
  };
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({ engine, registry: new Registry(functions), telemetry: false });
  const reader = engine.reader as unknown as { query(sql: string): unknown };
  const originalQuery = reader.query.bind(engine.reader);
  let minimumQueries = 0;
  reader.query = (sql: string) => {
    if (sql.startsWith("SELECT MIN(")) minimumQueries++;
    return originalQuery(sql);
  };
  const waitForSchedulerRead = async () => {
    for (;;) {
      const snapshot = runtime.status().reader;
      if (snapshot.active === 0 && snapshot.queue.queuedItems === 0) {
        await Bun.sleep(0);
        const settled = runtime.status().reader;
        if (settled.active === 0 && settled.queue.queuedItems === 0) return;
      }
      await Bun.sleep(0);
    }
  };
  await waitForSchedulerRead();
  const rearm = runtime.armScheduler as unknown as (tables: ReadonlySet<string>) => void;
  const trial = async (): Promise<number> => {
    minimumQueries = 0;
    const startedAt = performance.now();
    for (let index = 0; index < SCHEDULER_REARMS_PER_TRIAL; index++) {
      rearm.call(runtime, new Set(["jobs_0"]));
      await waitForSchedulerRead();
    }
    return performance.now() - startedAt;
  };
  try {
    const stats = await measure(trial);
    const queries = minimumQueries;
    console.log(JSON.stringify({
      commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
        .stdout.toString().trim(),
      operation: "scheduler-rearm",
      load: {
        scheduledTables: SCHEDULED_TABLES,
        touchedTablesPerCommit: 1,
        rearmsPerTrial: SCHEDULER_REARMS_PER_TRIAL,
        measuredTrials: MEASURED_TRIALS,
      },
      minimumQueriesPerTrial: queries,
      trialLatencyMs: stats,
    }, null, 2));
  } finally {
    await runtime.drain();
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
}

switch (process.argv[2]) {
  case "event-fanout":
    await eventFanout();
    break;
  case "query-revalidation":
    await queryRevalidation();
    break;
  case "http-auth-reject":
    await httpAuthReject();
    break;
  case "scheduler-rearm":
    await schedulerRearm();
    break;
  default:
    throw new Error(
      "usage: bun bench/t1-hotpath-prototype.ts <event-fanout|query-revalidation|http-auth-reject|scheduler-rearm>",
    );
}
