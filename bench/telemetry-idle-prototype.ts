/**
 * THROWAWAY AUDIT PROTOTYPE.
 *
 * Question: does the periodic telemetry projection keep idle sampling cost
 * constant as retained shared-query entries grow from 0 to 1k and 10k?
 *
 * `periodicSnapshot` deliberately falls back to the current full snapshot so
 * the same harness measures the base commit before the cheap projection exists.
 */
import {
  OrderedReactive,
  PRODUCTION_LIMITS,
  type ReactiveSnapshot,
  type Subscriber,
} from "@ackerdb/server";

const TARGETS = [0, 1_000, 10_000] as const;
const ITERATIONS = [100_000, 10_000, 2_000] as const;

const subscriber: Subscriber = Object.freeze({
  sendTransition: async () => {},
  sendEvent: async () => {},
  sendError: async () => {},
});

type PeriodicReactive = OrderedReactive<undefined> & {
  metricsSnapshot?(): ReactiveSnapshot;
};

function periodicSnapshot(reactive: PeriodicReactive): ReactiveSnapshot {
  return reactive.metricsSnapshot?.() ?? reactive.snapshot();
}

async function retainEntries(reactive: OrderedReactive<undefined>, from: number, to: number) {
  for (let index = from; index < to; index++) {
    await reactive.subscribeQuery({
      subscriber,
      id: 1,
      authEpoch: 0,
      address: "audit.idle",
      args: { index },
      policyScopeFingerprint: "anonymous",
      fairnessKey: "audit",
      context: undefined,
    });
    reactive.unsubscribe(subscriber, 1);
  }
}

function measure(reactive: PeriodicReactive, retainedEntries: number, iterations: number) {
  for (let index = 0; index < 100; index++) periodicSnapshot(reactive);
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let index = 0; index < iterations; index++) periodicSnapshot(reactive);
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMicros = cpu.user + cpu.system;
  const cpuMicrosPerSample = cpuMicros / iterations;
  return Object.freeze({
    retainedEntries,
    iterations,
    cpuMicrosPerSample,
    wallMicrosPerSample: wallMs * 1_000 / iterations,
    estimatedCorePercentAtOneHertz: cpuMicrosPerSample / 10_000,
    state: periodicSnapshot(reactive),
  });
}

const reactive = new OrderedReactive<undefined>({
  initialVersion: 0n,
  limits: PRODUCTION_LIMITS,
  now: () => 0,
  generation: (() => {
    let id = 0;
    return () => `audit-${++id}`;
  })(),
  evaluate: async () => ({
    value: null,
    encoded: "null",
    readSet: new Set(),
    commitVersion: 0n,
  }),
});

const results = [];
let retained = 0;
for (let targetIndex = 0; targetIndex < TARGETS.length; targetIndex++) {
  const target = TARGETS[targetIndex]!;
  await retainEntries(reactive, retained, target);
  retained = target;
  results.push(measure(reactive, target, ITERATIONS[targetIndex]!));
}
await reactive.close();

console.log(JSON.stringify({
  commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim(),
  operation: "periodic telemetry projection at one sample/second",
  results,
}, null, 2));
