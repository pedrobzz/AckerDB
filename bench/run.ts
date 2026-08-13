/**
 * One side of the paired benchmark: an AckerDB server, the load generator that
 * drives it, and the resource monitors around both. The pair driver starts one
 * of these per commit and then alternates units between them, so this process
 * holds its server open for the whole comparison and answers one unit at a time
 * instead of running a workload end to end and handing back a single verdict.
 *
 * Everything a human reads goes to stderr. Stdout is the protocol the pair
 * driver parses, and a stray log line on it would be read as a measurement.
 */
import { readFileSync, rmSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { runCodegen } from "../packages/cli/src/app/codegen.ts";
import { loadConfig } from "../packages/cli/src/app/config.ts";
import { benchmarkConfigFromEnv, type DriverResult } from "./benchmark.ts";
import {
  assertAckerDBStartup,
  expectedAckerDBStartupMode,
  type AckerDBStartupMode,
} from "./ackerdb-profile.ts";
import {
  ProcessTreeMonitor,
  readProcessTable,
  type ProcessTreeSnapshot,
  type ProcessTreeWindowSummary,
} from "./process-tree.ts";
import type { Subprocess } from "bun";
import { withTimeout } from "./load-engine.ts";
import {
  BoundedTextTail,
  parentCommands,
  stopSubprocess,
} from "./process-lifecycle.ts";
import { collectBenchmarkObservations, type BenchmarkObservations } from "./result-observations.ts";
import type { BenchUnit, UnitMetric } from "./units.ts";
import type { WorkloadUnitResult } from "./workload.ts";

const BENCH = import.meta.dir;
const REPO = join(BENCH, "..");
const RESOURCE_SAMPLE_MS = Number(process.env.BENCH_RESOURCE_SAMPLE_MS ?? 250);
const ACKERDB_SHUTDOWN_SLACK_MS = 2_000;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`@@side ${JSON.stringify(message)}\n`);
}

interface MachineRecord {
  platform: string;
  arch: string;
  cpu: string;
  logicalCpus: number;
  memGb: number;
  osRelease: string;
  fileDescriptorLimit: number;
}

interface UnitRecord {
  readonly unitId: string;
  readonly repetition: number;
  readonly metrics: readonly UnitMetric[];
  readonly resources: {
    readonly server: Record<string, ProcessTreeWindowSummary>;
    readonly loadGenerator: Record<string, ProcessTreeWindowSummary>;
  };
  readonly result: WorkloadUnitResult;
}

interface SideSample {
  schemaVersion: 2;
  source: { readonly side: "base" | "head"; readonly commit: string; readonly version: string };
  harnessCommit: string;
  timestamp: string;
  machine: MachineRecord;
  executionHost: string;
  startupMode: AckerDBStartupMode;
  startupIdle: { snapshot: ProcessTreeSnapshot; window: ProcessTreeWindowSummary };
  seededIdle: { snapshot?: ProcessTreeSnapshot; window?: ProcessTreeWindowSummary };
  units: UnitRecord[];
  observations: BenchmarkObservations;
  harnessObservations: string[];
}

function assertPortFree(port: number): void {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0 && result.stdout.toString().trim() !== "") {
    throw new Error(`port ${port} is already in use:\n${result.stdout.toString().trim()}`);
  }
}

function packageVersion(path: string): string {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function fileDescriptorLimit(): number {
  const result = Bun.spawnSync(["sh", "-c", "ulimit -n"], { stdout: "pipe" });
  return Number(result.stdout.toString().trim());
}

function machineRecord(): MachineRecord {
  return {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    memGb: Math.round(totalmem() / 1024 ** 3),
    osRelease: release(),
    fileDescriptorLimit: fileDescriptorLimit(),
  };
}

async function waitFor(output: () => string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${output()}`);
}

/**
 * The load generator, held open. Phase events arrive continuously on its stdout
 * and drive resource sampling; unit answers arrive on the same stream and are
 * handed to whoever asked for them. Windows are summarized per unit, so the
 * resource record stays attached to the work that produced it.
 */
class LoadGenerator {
  private readonly child: Subprocess<"pipe", "pipe", "pipe">;
  private readonly stdoutTail = new BoundedTextTail();
  private readonly stderrTail = new BoundedTextTail();
  private readonly serverMonitor: ProcessTreeMonitor;
  private readonly loadMonitor: ProcessTreeMonitor;
  private readonly phaseStarts = new Map<string, number>();
  private readonly phaseBounds = new Map<string, { startMs: number; endMs: number }>();
  private readonly summarized = new Set<string>();
  private readonly snapshots: Record<string, { server: ProcessTreeSnapshot; load: ProcessTreeSnapshot }> = {};
  private readonly pending: Array<(line: { tag: string; body: string }) => void> = [];
  private readonly buffered: Array<{ tag: string; body: string }> = [];
  private resourceFailure: Error | undefined;
  private resourceTimer: ReturnType<typeof setInterval> | undefined;
  private readonly reader: Promise<void>;
  private readonly stderrReader: Promise<void>;

  constructor(command: string[], env: Record<string, string>, serverPid: number) {
    const child = Bun.spawn(command, {
      cwd: REPO,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    this.child = child;
    this.serverMonitor = new ProcessTreeMonitor(serverPid, RESOURCE_SAMPLE_MS);
    this.loadMonitor = new ProcessTreeMonitor(child.pid, RESOURCE_SAMPLE_MS);
    this.sampleResources();
    this.resourceTimer = setInterval(() => {
      try {
        this.sampleResources();
      } catch {
        if (this.resourceTimer !== undefined) clearInterval(this.resourceTimer);
      }
    }, RESOURCE_SAMPLE_MS);
    this.reader = this.readStdout();
    this.stderrReader = (async () => {
      for await (const chunk of child.stderr) {
        this.stderrTail.write(chunk);
        process.stderr.write(chunk);
      }
      this.stderrTail.finish();
    })();
  }

  private sampleResources(): { server: ProcessTreeSnapshot; load: ProcessTreeSnapshot } {
    if (this.resourceFailure) throw this.resourceFailure;
    try {
      const table = readProcessTable();
      return { server: this.serverMonitor.sampleNow(table), load: this.loadMonitor.sampleNow(table) };
    } catch (error) {
      this.resourceFailure = error instanceof Error ? error : new Error(String(error));
      throw this.resourceFailure;
    }
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.child.stdout) {
      this.stdoutTail.write(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        this.consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") this.consume(buffer);
    this.stdoutTail.finish();
    // A closed stream must wake anyone still waiting, or a crashed load
    // generator would hang the pair driver instead of failing it.
    for (const resolve of this.pending.splice(0)) resolve({ tag: "@@closed", body: "{}" });
  }

  private consume(line: string): void {
    if (line.startsWith("@@bench ")) {
      const event = JSON.parse(line.slice("@@bench ".length)) as {
        type: string;
        id: string;
        timestampMs: number;
      };
      if (event.type === "phase-start") this.phaseStarts.set(event.id, event.timestampMs);
      if (event.type === "phase-end") {
        const startMs = this.phaseStarts.get(event.id);
        if (startMs === undefined) throw new Error(`phase ${event.id} ended without starting`);
        this.phaseBounds.set(event.id, { startMs, endMs: event.timestampMs });
      }
      const sample = this.sampleResources();
      if (event.type === "snapshot") this.snapshots[event.id] = sample;
      return;
    }
    for (const tag of ["@@session ", "@@unit "]) {
      if (!line.startsWith(tag)) continue;
      const message = { tag: tag.trim(), body: line.slice(tag.length) };
      const resolve = this.pending.shift();
      if (resolve) resolve(message);
      else this.buffered.push(message);
      return;
    }
    if (line.trim() !== "") log(`  client: ${line}`);
  }

  private nextMessage(): Promise<{ tag: string; body: string }> {
    const buffered = this.buffered.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  private send(command: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    this.child.stdin.flush();
  }

  private async expect(tag: string): Promise<string> {
    const message = await this.nextMessage();
    if (message.tag !== tag) {
      throw new Error(
        `benchmark client answered ${message.tag} where ${tag} was expected\n` +
          `client stdout tail:\n${this.stdoutTail.output().slice(-16_000)}\n` +
          `client stderr tail:\n${this.stderrTail.output().slice(-16_000)}`,
      );
    }
    return message.body;
  }

  /** Windows that closed since the previous unit, summarized and handed over once. */
  private harvestWindows(): UnitRecord["resources"] {
    const server: Record<string, ProcessTreeWindowSummary> = {};
    const loadGenerator: Record<string, ProcessTreeWindowSummary> = {};
    for (const [id, bounds] of this.phaseBounds) {
      if (this.summarized.has(id)) continue;
      this.summarized.add(id);
      if (bounds.endMs - bounds.startMs < RESOURCE_SAMPLE_MS) continue;
      server[id] = this.serverMonitor.summarize(bounds.startMs, bounds.endMs);
      loadGenerator[id] = this.loadMonitor.summarize(bounds.startMs, bounds.endMs);
    }
    return { server, loadGenerator };
  }

  async open(): Promise<{ seededIdle: { snapshotId: string; phaseId: string } }> {
    this.send({ type: "open" });
    const body = await this.expect("@@session");
    return JSON.parse(body) as { seededIdle: { snapshotId: string; phaseId: string } };
  }

  async runUnit(unit: BenchUnit, repetition: number, measureIdle: boolean): Promise<UnitRecord> {
    this.send({ type: "unit", unit, measureIdle });
    const body = await this.expect("@@unit");
    const result = JSON.parse(body) as WorkloadUnitResult & { unitId: string };
    if (this.resourceFailure) throw this.resourceFailure;
    return {
      unitId: result.unitId,
      repetition,
      metrics: result.metrics,
      resources: this.harvestWindows(),
      result,
    };
  }

  windowFor(phaseId: string): ProcessTreeWindowSummary | undefined {
    const bounds = this.phaseBounds.get(phaseId);
    if (bounds === undefined) return undefined;
    this.summarized.add(phaseId);
    return this.serverMonitor.summarize(bounds.startMs, bounds.endMs);
  }

  snapshotFor(id: string): ProcessTreeSnapshot | undefined {
    return this.snapshots[id]?.server;
  }

  async close(): Promise<void> {
    if (this.resourceTimer !== undefined) clearInterval(this.resourceTimer);
    try {
      this.send({ type: "close" });
      this.child.stdin.end();
    } catch {
      // A client that already exited cannot be told to; the exit code below is
      // the authority on whether that was orderly.
    }
    const exitCode = await withTimeout(this.child.exited, 10_000, "benchmark client exit");
    await withTimeout(Promise.allSettled([this.reader, this.stderrReader]), 2_000, "benchmark client drain");
    if (exitCode !== 0) {
      throw new Error(
        `benchmark client failed with exit code ${exitCode}\n` +
          `client stdout tail:\n${this.stdoutTail.output().slice(-16_000)}\n` +
          `client stderr tail:\n${this.stderrTail.output().slice(-16_000)}`,
      );
    }
  }

  async kill(): Promise<void> {
    if (this.resourceTimer !== undefined) clearInterval(this.resourceTimer);
    await stopSubprocess(this.child, 1_000).catch(() => undefined);
  }
}

const side = process.env.BENCH_SIDE;
const sourceCommit = process.env.BENCH_SOURCE_COMMIT;
const harnessCommit = process.env.BENCH_HARNESS_COMMIT;
const outputPath = process.env.BENCH_OUTPUT;
const port = Number(process.env.BENCH_PORT);
const executionHost = process.env.BENCH_EXECUTION_HOST;
if (
  (side !== "base" && side !== "head") ||
  !sourceCommit ||
  !harnessCommit ||
  !outputPath ||
  !Number.isInteger(port) ||
  port <= 0 ||
  !executionHost
) {
  throw new Error(
    "BENCH_SIDE=base|head, BENCH_SOURCE_COMMIT, BENCH_HARNESS_COMMIT, BENCH_OUTPUT, BENCH_PORT, " +
      "and BENCH_EXECUTION_HOST are required",
  );
}
const benchmarkConfig = benchmarkConfigFromEnv();
if (benchmarkConfig.profile !== "default") {
  throw new Error("protected-branch benchmarks use the default workload only");
}

const expectedMode = expectedAckerDBStartupMode("balanced");
await runCodegen(loadConfig(join(BENCH, "ackerdb-app"), {
  ACKERDB_DURABILITY: "balanced",
}));
assertPortFree(port);
rmSync(join(BENCH, "ackerdb-app", ".ackerdb"), { recursive: true, force: true });
log(`→ ${side}: fresh server on ${port}`);

const server = Bun.spawn(
  [process.execPath, join(BENCH, "ackerdb-server.ts"), join(BENCH, "ackerdb-app")],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ACKERDB_BENCH_PORT: String(port),
      ACKERDB_DURABILITY: "balanced",
    },
  },
);
const serverOutput = new BoundedTextTail();
const serverDrained = Promise.allSettled([
  (async () => {
    for await (const chunk of server.stdout) serverOutput.write(chunk);
  })(),
  (async () => {
    for await (const chunk of server.stderr) serverOutput.write(chunk);
  })(),
]).then(() => serverOutput.finish());

const harnessObservations: string[] = [];
const units: UnitRecord[] = [];
let client: LoadGenerator | undefined;
let startupMode: AckerDBStartupMode = expectedMode;
try {
  await waitFor(() => serverOutput.output(), "ready on", 15_000);
  try {
    startupMode = assertAckerDBStartup(serverOutput.output(), expectedMode);
  } catch (error) {
    harnessObservations.push(error instanceof Error ? error.message : String(error));
  }

  const startupMonitor = new ProcessTreeMonitor(server.pid, RESOURCE_SAMPLE_MS);
  startupMonitor.start();
  const startupStartedAt = performance.timeOrigin + performance.now();
  await Bun.sleep(benchmarkConfig.resources.idleMs);
  const startupEndedAt = performance.timeOrigin + performance.now();
  const startupSnapshot = startupMonitor.sampleNow();
  startupMonitor.stop();
  const startupIdle = {
    snapshot: startupSnapshot,
    window: startupMonitor.summarize(startupStartedAt, startupEndedAt),
  };

  client = new LoadGenerator(
    [process.execPath, join(BENCH, "ackerdb-client.ts")],
    { ACKERDB_URL: `http://127.0.0.1:${port}` },
    server.pid,
  );
  const opened = await client.open();
  emit({ type: "ready", startupIdle, startupMode, machine: machineRecord() });

  for await (const line of parentCommands()) {
    const command = JSON.parse(line) as
      | { type: "unit"; unit: BenchUnit; repetition: number; measureIdle: boolean }
      | { type: "stop" };
    if (command.type === "stop") break;
    const record = await client.runUnit(command.unit, command.repetition, command.measureIdle);
    units.push(record);
    emit({
      type: "unit",
      unitId: record.unitId,
      repetition: record.repetition,
      metrics: record.metrics,
      failures: record.result.failures,
    });
  }

  const seededIdle = {
    snapshot: client.snapshotFor(opened.seededIdle.snapshotId),
    window: client.windowFor(opened.seededIdle.phaseId),
  };
  await client.close();
  client = undefined;

  const stopped = await stopSubprocess(server, expectedMode.gracefulShutdownMs + ACKERDB_SHUTDOWN_SLACK_MS);
  if (stopped.timedOut) {
    throw new Error(
      `ackerdb benchmark server exceeded its ${expectedMode.gracefulShutdownMs}ms graceful shutdown deadline`,
    );
  }
  if (stopped.exitCode !== 0) {
    throw new Error(`ackerdb benchmark server failed with exit code ${stopped.exitCode}`);
  }
  await withTimeout(serverDrained, 2_000, "ackerdb output drain");

  // A repetition is one complete pass over every unit, so it reconstructs
  // exactly the record the old whole-workload driver produced — which is what
  // lets the structural and accounting checks stay unchanged.
  const repetitions = [...new Set(units.map((unit) => unit.repetition))].sort((a, b) => a - b);
  const drivers: DriverResult[] = repetitions.map((repetition) => {
    const slice = units.filter((unit) => unit.repetition === repetition);
    return {
      system: "ackerdb",
      config: benchmarkConfig,
      operations: slice.flatMap((unit) => [...unit.result.operations]),
      connections: slice.flatMap((unit) => [...unit.result.connections]),
      subscriptions: slice.flatMap((unit) => [...unit.result.subscriptions]),
      failures: slice.flatMap((unit) => [...unit.result.failures]),
    };
  });
  const sample: SideSample = {
    schemaVersion: 2,
    source: {
      side,
      commit: sourceCommit,
      version: packageVersion(join(REPO, "packages", "core", "package.json")),
    },
    harnessCommit,
    timestamp: new Date().toISOString(),
    machine: machineRecord(),
    executionHost,
    startupMode,
    startupIdle,
    seededIdle,
    units,
    observations: collectBenchmarkObservations(drivers.map((workload, index) => ({
      label: `ackerdb/repetition-${repetitions[index]}`,
      system: "ackerdb" as const,
      workload,
    }))),
    harnessObservations,
  };
  if (!/^\d+\.\d+\.\d+$/.test(sample.source.version)) {
    throw new Error(`benchmark source version ${sample.source.version} is not x.y.z`);
  }
  await Bun.write(outputPath, `${JSON.stringify(sample, null, 2)}\n`);
  emit({ type: "done", units: units.length, output: outputPath });
} catch (error) {
  emit({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  log(`${side} side failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  log(`server output tail:\n${serverOutput.output().slice(-16_000)}`);
  process.exitCode = 1;
} finally {
  await client?.kill();
  await stopSubprocess(server, 1_000).catch(() => undefined);
}
