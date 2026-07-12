/**
 * Benchmark orchestrator: dbzz vs Convex local backend, same machine, same
 * workload, both through their real client SDKs over WebSocket, fresh state
 * per run. Run from the repo root: `bun bench/run.ts`.
 *
 * Measures per system:
 *   - sequential mutation round-trips (throughput + mean latency)
 *   - reactive subscription update latency (p50/p95)
 *   - server RSS after the workload, and idle RSS right after startup
 *   - server cumulative CPU time consumed by the workload
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { WorkloadResult } from "./workload.ts";

const BENCH = import.meta.dir;
const REPO = join(BENCH, "..");

interface ProcessStats {
  rssMb: number;
  cpuSeconds: number;
}

function sample(pid: number): ProcessStats {
  const out = Bun.spawnSync(["ps", "-o", "rss=,time=", "-p", String(pid)]).stdout.toString().trim();
  const [rss, time] = out.split(/\s+/);
  const parts = (time ?? "0:00.00").split(":").map(Number);
  const cpuSeconds =
    parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!;
  return { rssMb: Number(rss) / 1024, cpuSeconds };
}

interface PhaseResult extends WorkloadResult {
  idleRssMb: number;
  rssMb: number;
  cpuSeconds: number;
}

function tail(child: Subprocess<"ignore", "pipe", number>): { output: () => string; done: Promise<void> } {
  let buffer = "";
  const done = (async () => {
    for await (const chunk of child.stdout) buffer += new TextDecoder().decode(chunk);
  })();
  return { output: () => buffer, done };
}

async function waitFor(output: () => string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${output()}`);
}

async function runClient(cmd: string[], env: Record<string, string>): Promise<WorkloadResult> {
  const child = Bun.spawn(cmd, {
    cwd: REPO,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
  const { output, done } = tail(child as never);
  const code = await child.exited;
  await done;
  if (code !== 0) throw new Error(`bench client failed (${code})`);
  const lines = output().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as WorkloadResult;
}

async function benchDbzz(): Promise<PhaseResult> {
  console.log("→ dbzz: starting fresh server");
  rmSync(join(BENCH, "dbzz-app", ".zdb"), { recursive: true, force: true });
  const server = Bun.spawn(
    [process.execPath, join(REPO, "packages", "cli", "src", "main.ts"), "start", join(BENCH, "dbzz-app")],
    { stdout: "pipe", stderr: "inherit" },
  );
  const { output } = tail(server as never);
  try {
    await waitFor(output, "ready on", 15_000);
    await Bun.sleep(300);
    const idle = sample(server.pid);
    const before = sample(server.pid);
    const result = await runClient(
      [process.execPath, join(BENCH, "dbzz-client.ts")],
      { DBZZ_URL: "http://127.0.0.1:3311" },
    );
    const after = sample(server.pid);
    return {
      ...result,
      idleRssMb: idle.rssMb,
      rssMb: after.rssMb,
      cpuSeconds: after.cpuSeconds - before.cpuSeconds,
    };
  } finally {
    server.kill();
    await server.exited;
  }
}

function findConvexBackendPid(): number {
  const out = Bun.spawnSync(["ps", "-eo", "pid,command"]).stdout.toString();
  for (const line of out.split("\n")) {
    // match OUR backend by its state path, never a global name grep
    if (line.includes("convex-local-backend") && line.includes(join(BENCH, "convex-app"))) {
      return Number(line.trim().split(/\s+/)[0]);
    }
  }
  throw new Error("convex-local-backend process not found for bench/convex-app");
}

async function benchConvex(): Promise<PhaseResult> {
  console.log("→ convex: starting fresh local backend");
  rmSync(join(BENCH, "convex-app", ".convex", "local"), { recursive: true, force: true });
  const dev = Bun.spawn(["bunx", "convex", "dev"], {
    cwd: join(BENCH, "convex-app"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = tail(dev as never);
  const err = tail({ stdout: dev.stderr } as never);
  const output = () => out.output() + err.output();
  try {
    await waitFor(output, "Convex functions ready", 120_000);
    await Bun.sleep(1000);
    const pid = findConvexBackendPid();
    const idle = sample(pid);
    const before = sample(pid);
    const result = await runClient(
      ["bun", join(BENCH, "convex-app", "client.ts")],
      { CONVEX_URL: "http://127.0.0.1:3210" },
    );
    const after = sample(pid);
    const stats = {
      ...result,
      idleRssMb: idle.rssMb,
      rssMb: after.rssMb,
      cpuSeconds: after.cpuSeconds - before.cpuSeconds,
    };
    Bun.spawnSync(["kill", String(pid)]);
    return stats;
  } finally {
    dev.kill();
    await dev.exited;
    try {
      Bun.spawnSync(["kill", String(findConvexBackendPid())]);
    } catch {
      /* already gone */
    }
  }
}

const fmt = (n: number, digits = 2) => n.toFixed(digits);

const dbzz = await benchDbzz();
const convex = await benchConvex();

const rows: [string, string, string, string][] = [
  ["mutations/sec (sequential round-trips)", `${dbzz.mutationsPerSec}`, `${convex.mutationsPerSec}`, `${fmt(dbzz.mutationsPerSec / convex.mutationsPerSec, 1)}x`],
  ["mutation mean latency (ms)", fmt(dbzz.mutationMeanMs), fmt(convex.mutationMeanMs), `${fmt(convex.mutationMeanMs / dbzz.mutationMeanMs, 1)}x`],
  ["subscription update p50 (ms)", fmt(dbzz.subLatencyP50Ms), fmt(convex.subLatencyP50Ms), `${fmt(convex.subLatencyP50Ms / dbzz.subLatencyP50Ms, 1)}x`],
  ["subscription update p95 (ms)", fmt(dbzz.subLatencyP95Ms), fmt(convex.subLatencyP95Ms), `${fmt(convex.subLatencyP95Ms / dbzz.subLatencyP95Ms, 1)}x`],
  ["idle RSS (MB)", fmt(dbzz.idleRssMb, 1), fmt(convex.idleRssMb, 1), `${fmt(convex.idleRssMb / dbzz.idleRssMb, 1)}x`],
  ["RSS after workload (MB)", fmt(dbzz.rssMb, 1), fmt(convex.rssMb, 1), `${fmt(convex.rssMb / dbzz.rssMb, 1)}x`],
  ["server CPU time for workload (s)", fmt(dbzz.cpuSeconds), fmt(convex.cpuSeconds), `${fmt(convex.cpuSeconds / dbzz.cpuSeconds, 1)}x`],
];

console.log(`\n| metric | dbzz | convex | dbzz advantage |`);
console.log(`|---|---|---|---|`);
for (const [metric, a, b, ratio] of rows) console.log(`| ${metric} | ${a} | ${b} | ${ratio} |`);
