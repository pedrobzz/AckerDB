/**
 * Targeted development microbenchmark for production DBzz hot paths.
 *
 * Question: how much useful procedure throughput, latency, and server RSS does
 * the branch's real client/server implementation sustain without the release
 * benchmark's unrelated workloads?
 *
 * Run on the idle Hetzner host:
 *   bun bench/hot-path-microbenchmark.ts procedure
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyApi, type ApplicationError } from "@dbzz/core";
import { DbzzClient, type ClientResult } from "@dbzz/client";
import {
  Engine,
  Registry,
  Runtime,
  reconcile,
  serve,
  type EngineCloseDisposition,
} from "@dbzz/server";
import { loadConfig } from "../packages/cli/src/app/config.ts";
import { runCodegen } from "../packages/cli/src/app/codegen.ts";
import {
  importApp,
  importFunctionModules,
} from "../packages/cli/src/app/manifest.ts";
import {
  PROCEDURE_PAYLOAD_BYTES,
  computeChecksum,
  fixedPayload,
} from "./benchmark.ts";
import { latencyStats } from "./load-engine.ts";

const APP = join(import.meta.dir, "dbzz-app");
const PORT = 3311;
const WARMUP_MS = 500;
const STEADY_MS = 2_000;
const TRIALS = 3;
const COMPUTE_ROUNDS = 8;

interface Profile {
  readonly name: "latency" | "saturation";
  readonly connections: number;
  readonly inFlightPerConnection: number;
}

const PROFILES: readonly Profile[] = [
  { name: "latency", connections: 1, inFlightPerConnection: 1 },
  { name: "saturation", connections: 32, inFlightPerConnection: 4 },
];

async function success<Data, Error extends ApplicationError = never>(
  pending: Promise<ClientResult<Data, Error>>,
): Promise<Data> {
  const result = await pending;
  if (!result.ok) throw result.error;
  return result.data;
}

function rssBytes(pid: number): number {
  const status = `/proc/${pid}/status`;
  const text = Bun.spawnSync(["sed", "-n", "s/^VmRSS:[[:space:]]*\\([0-9]*\\).*/\\1/p", status], {
    stdout: "pipe",
  }).stdout.toString().trim();
  const kib = Number(text);
  if (!Number.isFinite(kib)) throw new Error(`could not read RSS for server pid ${pid}`);
  return kib * 1024;
}

async function runWindow(
  clients: readonly DbzzClient[],
  profile: Profile,
  durationMs: number,
  nonce: { value: number },
  serverPid: number,
) {
  const payload = fixedPayload("procedure-payload:", PROCEDURE_PAYLOAD_BYTES);
  const deadline = performance.now() + durationMs;
  let completed = 0;
  const latencies: number[] = [];
  const rss: number[] = [];
  const sampler = setInterval(() => rss.push(rssBytes(serverPid)), 20);
  const slots = profile.connections * profile.inFlightPerConnection;
  try {
    await Promise.all(Array.from({ length: slots }, async (_, slot) => {
      const client = clients[Math.floor(slot / profile.inFlightPerConnection)]!;
      while (performance.now() < deadline) {
        const operationStartedAt = performance.now();
        const currentNonce = nonce.value++;
        const seed = Math.imul(currentNonce, 2_654_435_761) >>> 0;
        const value = await success(
          client.procedure<
            { nonce: number; seed: number; payload: string; rounds: number },
            { nonce: number; checksum: number }
          >(
            anyApi.bench.compute,
            { nonce: currentNonce, seed, payload, rounds: COMPUTE_ROUNDS },
          ),
        );
        if (
          value.nonce !== currentNonce ||
          value.checksum !== computeChecksum(currentNonce, seed, payload, COMPUTE_ROUNDS)
        ) {
          throw new Error("procedure returned an invalid result");
        }
        const completedAt = performance.now();
        if (completedAt <= deadline) completed++;
        latencies.push(completedAt - operationStartedAt);
      }
    }));
  } finally {
    clearInterval(sampler);
    rss.push(rssBytes(serverPid));
  }
  return {
    throughputPerSec: completed / (durationMs / 1_000),
    latency: latencyStats(latencies),
    rss: {
      baselineBytes: rss[0]!,
      peakBytes: Math.max(...rss),
    },
  };
}

async function runClient(serverPid: number) {
  const nonce = { value: 1 };
  const clients = Array.from(
    { length: Math.max(...PROFILES.map((profile) => profile.connections)) },
    () => new DbzzClient({
      url: `http://127.0.0.1:${PORT}`,
      credential: { kind: "anonymous" },
    }),
  );
  try {
    const results = [];
    for (const profile of PROFILES) {
      const active = clients.slice(0, profile.connections);
      await runWindow(active, profile, WARMUP_MS, nonce, serverPid);
      const trials = [];
      for (let trial = 0; trial < TRIALS; trial++) {
        await Bun.sleep(250);
        trials.push(await runWindow(active, profile, STEADY_MS, nonce, serverPid));
      }
      results.push({ profile, trials });
    }
    return results;
  } finally {
    for (const client of clients) client.close();
  }
}

async function server(dbDir: string): Promise<never> {
  const config = loadConfig(APP);
  const schema = (await importApp(config)).schema;
  const modules = await importFunctionModules(config);
  mkdirSync(dbDir, { recursive: true });
  const engine = new Engine(schema, join(dbDir, "data.db"), { durability: "balanced" });
  let runtime: Runtime | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let closeDisposition: EngineCloseDisposition = "unclean";
  try {
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry(modules),
      telemetry: false,
    });
    listener = serve({ runtime, port: PORT });
    console.log("@@ready");
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await listener.drain();
    closeDisposition = "clean";
  } finally {
    if (listener === undefined) await runtime?.drain().catch(() => {});
    engine.close(closeDisposition);
  }
  process.exit(0);
}

async function waitForReady(
  output: ReadableStream<Uint8Array>,
): Promise<{ readonly text: () => string; readonly done: Promise<void> }> {
  let text = "";
  const done = (async () => {
    for await (const chunk of output) text += Buffer.from(chunk).toString();
  })();
  const deadline = Date.now() + 15_000;
  while (!text.includes("@@ready")) {
    if (Date.now() >= deadline) throw new Error(`server readiness timed out:\n${text}`);
    await Bun.sleep(20);
  }
  return { text: () => text, done };
}

function collect(
  output: ReadableStream<Uint8Array>,
): { readonly text: () => string; readonly done: Promise<void> } {
  let text = "";
  const done = (async () => {
    for await (const chunk of output) text += Buffer.from(chunk).toString();
  })();
  return { text: () => text, done };
}

async function main(): Promise<void> {
  if (process.argv[2] === "--server") {
    const dbDir = process.argv[3];
    if (dbDir === undefined) throw new Error("server mode requires a database directory");
    await server(dbDir);
  }
  if (process.argv[2] !== "procedure") {
    throw new Error("usage: bun bench/hot-path-microbenchmark.ts procedure");
  }

  await runCodegen(loadConfig(APP));
  const scratch = mkdtempSync(join(tmpdir(), "dbzz-hot-path-"));
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "--server", scratch],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = collect(child.stderr);
  const stdout = await waitForReady(child.stdout);
  try {
    const results = await runClient(child.pid);
    console.log(JSON.stringify({
      commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim(),
      operation: "procedure",
      host: Bun.spawnSync(["hostname"], { stdout: "pipe" }).stdout.toString().trim(),
      warmupMs: WARMUP_MS,
      steadyMs: STEADY_MS,
      trials: TRIALS,
      results,
    }, null, 2));
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await stdout.done;
    await stderr.done;
    if (child.exitCode !== 0) {
      throw new Error(`server exited ${child.exitCode}:\n${stdout.text()}\n${stderr.text()}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
