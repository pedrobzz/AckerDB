/** AckerDB-only benchmark sampler; invoked by the protected PR workflow. */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { runCodegen } from "../packages/cli/src/app/codegen.ts";
import { loadConfig } from "../packages/cli/src/app/config.ts";
import {
  benchmarkConfigFromEnv,
  OPERATION_NAMES,
  subscriptionCapacitySlots,
  type DriverResult,
} from "./benchmark.ts";
import {
  assertAckerDBStartup,
  benchmarkExecutionOrder,
  expectedAckerDBStartupMode,
  type BenchmarkExecutionLeg,
  type AckerDBBenchmarkProfile,
  type AckerDBStartupMode,
} from "./ackerdb-profile.ts";
import {
  assertAckerDBTelemetryWorkload,
  AckerDBOutputCollector,
  parseAckerDBTelemetryReport,
  type AckerDBTelemetryReport,
} from "./ackerdb-telemetry.ts";
import {
  ProcessTreeMonitor,
  readProcessTable,
  type ProcessTreeSnapshot,
  type ProcessTreeWindowSummary,
} from "./process-tree.ts";
import { withTimeout } from "./load-engine.ts";
import {
  activePhaseIds,
  BENCHMARK_START_SIGNAL,
  benchmarkFailure,
  BoundedTextTail,
  stopSubprocess,
  type BenchmarkFailurePart,
} from "./process-lifecycle.ts";
import {
  collectBenchmarkObservations,
  formatBenchmarkObservations,
  type BenchmarkObservations,
} from "./result-observations.ts";

const BENCH = import.meta.dir;
const REPO = join(BENCH, "..");
const ACKERDB_PORT = 3311;
const RESOURCE_SAMPLE_MS = Number(process.env.BENCH_RESOURCE_SAMPLE_MS ?? 250);
const COOLDOWN_MS = Number(process.env.BENCH_COOLDOWN_MS ?? 2_000);
const ACKERDB_SHUTDOWN_SLACK_MS = 2_000;
const ALL_SYSTEMS = ["ackerdb"] as const;

interface ResourceCollection {
  snapshots: Record<string, ProcessTreeSnapshot>;
  phases: Record<string, ProcessTreeWindowSummary>;
}

interface MeasuredDriverResult {
  workload: DriverResult;
  startupIdle: { snapshot: ProcessTreeSnapshot; window: ProcessTreeWindowSummary };
  resources: { server: ResourceCollection; loadGenerator: ResourceCollection };
  implementationVersion?: string;
}

interface AckerDBMeasuredDriverResult extends MeasuredDriverResult {
  startupMode: AckerDBStartupMode;
  telemetryReport: AckerDBTelemetryReport;
  observations: readonly string[];
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

interface BenchmarkSample {
  schemaVersion: 1;
  source: {
    readonly label: "base" | "head";
    readonly commit: string;
    readonly version: string;
  };
  harnessCommit: string;
  timestamp: string;
  machine: MachineRecord;
  methodology: {
    serverResources: string;
    loadGeneratorResources: string;
    sampleIntervalMs: number;
    durability: string;
    telemetry: string;
    subscriptionCapacity: string;
  };
  executionOrder: BenchmarkExecutionLeg[];
  profiles: Partial<Record<AckerDBBenchmarkProfile, AckerDBMeasuredDriverResult>>;
  observations: BenchmarkObservations;
}

function assertPortFree(port: number): void {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0 && result.stdout.toString().trim() !== "") {
    throw new Error(`port ${port} is already in use:\n${result.stdout.toString().trim()}`);
  }
}

function assertPortsFree(ports: number[]): void {
  for (const port of ports) assertPortFree(port);
}

async function measureStartupIdle(rootPid: number): Promise<MeasuredDriverResult["startupIdle"]> {
  const monitor = new ProcessTreeMonitor(rootPid, RESOURCE_SAMPLE_MS);
  monitor.start();
  const startedAt = performance.timeOrigin + performance.now();
  await Bun.sleep(benchmarkConfigFromEnv().resources.idleMs);
  const endedAt = performance.timeOrigin + performance.now();
  const snapshot = monitor.sampleNow();
  monitor.stop();
  return { snapshot, window: monitor.summarize(startedAt, endedAt) };
}

function tail(
  child: { stdout: ReadableStream<Uint8Array> },
  echo = false,
): { output: () => string; done: Promise<void> } {
  const output = new BoundedTextTail();
  const done = (async () => {
    try {
      for await (const chunk of child.stdout) {
        output.write(chunk);
        if (echo) process.stderr.write(chunk);
      }
    } finally {
      output.finish();
    }
  })();
  return { output: () => output.output(), done };
}

async function waitFor(output: () => string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${output()}`);
}

function parseClientLine(
  line: string,
  sampleResources: () => { server: ProcessTreeSnapshot; load: ProcessTreeSnapshot },
  phaseStarts: Map<string, number>,
  phaseBounds: Map<string, { startMs: number; endMs: number }>,
  serverSnapshots: Record<string, ProcessTreeSnapshot>,
  loadSnapshots: Record<string, ProcessTreeSnapshot>,
  setResult: (result: DriverResult) => void,
): void {
  if (line.startsWith("@@bench ")) {
    const event = JSON.parse(line.slice("@@bench ".length)) as { type: string; id: string; timestampMs: number };
    const timestampMs = event.timestampMs;
    if (event.type === "phase-start") phaseStarts.set(event.id, timestampMs);
    if (event.type === "phase-end") {
      const startMs = phaseStarts.get(event.id);
      if (startMs === undefined) throw new Error(`phase ${event.id} ended without starting`);
      phaseBounds.set(event.id, { startMs, endMs: timestampMs });
    }
    const { server: serverSample, load: loadSample } = sampleResources();
    if (event.type === "snapshot") {
      serverSnapshots[event.id] = serverSample;
      loadSnapshots[event.id] = loadSample;
    }
    return;
  }
  if (line.startsWith("@@result ")) {
    setResult(JSON.parse(line.slice("@@result ".length)) as DriverResult);
    return;
  }
  if (line.trim() !== "") console.log(`  client: ${line}`);
}

async function runMeasuredClient(
  command: string[],
  env: Record<string, string>,
  serverPid: number,
): Promise<Omit<MeasuredDriverResult, "startupIdle" | "implementationVersion">> {
  const child = Bun.spawn(command, {
    cwd: REPO,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stderr = tail({ stdout: child.stderr }, true);
  const stdoutTail = new BoundedTextTail();
  const stdoutDecoder = new TextDecoder();
  const serverMonitor = new ProcessTreeMonitor(serverPid, RESOURCE_SAMPLE_MS);
  const loadMonitor = new ProcessTreeMonitor(child.pid, RESOURCE_SAMPLE_MS);
  const phaseStarts = new Map<string, number>();
  const phaseBounds = new Map<string, { startMs: number; endMs: number }>();
  const serverSnapshots: Record<string, ProcessTreeSnapshot> = {};
  const loadSnapshots: Record<string, ProcessTreeSnapshot> = {};
  let resourceFailure: Error | undefined;
  const sampleResources = () => {
    if (resourceFailure) throw resourceFailure;
    try {
      const table = readProcessTable();
      return { server: serverMonitor.sampleNow(table), load: loadMonitor.sampleNow(table) };
    } catch (error) {
      resourceFailure = error instanceof Error ? error : new Error(String(error));
      throw resourceFailure;
    }
  };
  let workload: DriverResult | undefined;
  let buffer = "";
  let resourceTimer: ReturnType<typeof setInterval> | undefined;
  const failures: BenchmarkFailurePart[] = [];
  let childExited = false;
  try {
    sampleResources();
    resourceTimer = setInterval(() => {
      try {
        sampleResources();
      } catch {
        if (resourceTimer !== undefined) clearInterval(resourceTimer);
      }
    }, RESOURCE_SAMPLE_MS);
    child.stdin.write(BENCHMARK_START_SIGNAL);
    child.stdin.end();
    clientOutput: for await (const chunk of child.stdout) {
      stdoutTail.write(chunk);
      buffer += stdoutDecoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseClientLine(
          line,
          sampleResources,
          phaseStarts,
          phaseBounds,
          serverSnapshots,
          loadSnapshots,
          (result) => {
            workload = result;
          },
        );
        if (workload?.failures.some((failure) => failure.terminal)) break clientOutput;
      }
    }
    if (workload?.failures.some((failure) => failure.terminal)) {
      await stopSubprocess(child, 1_000);
      childExited = true;
    } else {
      buffer += stdoutDecoder.decode();
      if (buffer.trim() !== "") {
        parseClientLine(
          buffer,
          sampleResources,
          phaseStarts,
          phaseBounds,
          serverSnapshots,
          loadSnapshots,
          (result) => {
            workload = result;
          },
        );
      }
      const exitCode = await child.exited;
      childExited = true;
      if (exitCode !== 0) throw new Error(`benchmark client failed with exit code ${exitCode}`);
    }
    if (!workload) throw new Error(`benchmark client produced no result`);
    if (resourceFailure) throw resourceFailure;
  } catch (error) {
    failures.push({ stage: "client", error });
  } finally {
    try {
      sampleResources();
    } catch {
      // The stored sampler failure is rethrown below.
    }
    if (resourceTimer !== undefined) clearInterval(resourceTimer);
    if (!childExited) {
      try {
        await stopSubprocess(child, 1_000);
        childExited = true;
      } catch (error) {
        failures.push({ stage: "client cleanup", error });
      }
    }
    try {
      await withTimeout(stderr.done, 1_000, "benchmark client stderr drain");
    } catch (error) {
      failures.push({ stage: "client stderr", error });
    }
    stdoutTail.finish();
  }

  if (resourceFailure && !failures.some(({ error }) => error === resourceFailure)) {
    failures.push({ stage: "resource sampling", error: resourceFailure });
  }
  const clientFailure = () => {
    const active = activePhaseIds(phaseStarts, phaseBounds);
    const lastCompleted = [...phaseBounds.keys()].at(-1) ?? "none";
    return benchmarkFailure("benchmark client", failures, {
      summary: [
        `active phases: ${active.length === 0 ? "none" : active.join(", ")}`,
        `last completed phase: ${lastCompleted}`,
      ],
      tail: `client stdout tail:\n${stdoutTail.output().slice(-32_000)}\n` +
        `client stderr tail:\n${stderr.output().slice(-32_000)}`,
    });
  };
  if (failures.length > 0) throw clientFailure();
  if (!workload) throw new Error("benchmark client completed without workload state");

  const serverPhases: Record<string, ProcessTreeWindowSummary> = {};
  const loadPhases: Record<string, ProcessTreeWindowSummary> = {};
  let resourcePhase = "unknown";
  try {
    for (const [id, bounds] of phaseBounds) {
      if (bounds.endMs - bounds.startMs < RESOURCE_SAMPLE_MS) continue;
      resourcePhase = id;
      serverPhases[id] = serverMonitor.summarize(bounds.startMs, bounds.endMs);
      loadPhases[id] = loadMonitor.summarize(bounds.startMs, bounds.endMs);
    }
  } catch (error) {
    failures.push({ stage: `resource window ${resourcePhase}`, error });
    throw clientFailure();
  }
  return {
    workload,
    resources: {
      server: { snapshots: serverSnapshots, phases: serverPhases },
      loadGenerator: { snapshots: loadSnapshots, phases: loadPhases },
    },
  };
}

async function benchAckerDB(profile: AckerDBBenchmarkProfile): Promise<AckerDBMeasuredDriverResult> {
  const expectedMode = expectedAckerDBStartupMode(profile, "balanced");
  const telemetry = profile === "disabled" ? "disabled" : "enabled";
  const reportPath = join(tmpdir(), `ackerdb-benchmark-telemetry-${process.pid}-${randomUUID()}.json`);
  assertPortsFree([ACKERDB_PORT]);
  console.log(
    `→ ackerdb: fresh server (telemetry=${telemetry}, profile=${expectedMode.telemetryProfile}, durability=balanced)`,
  );
  rmSync(join(BENCH, "ackerdb-app", ".ackerdb"), { recursive: true, force: true });
  const server = Bun.spawn(
    [process.execPath, join(BENCH, "ackerdb-server.ts"), join(BENCH, "ackerdb-app")],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ACKERDB_TELEMETRY: telemetry,
        ACKERDB_BENCH_EXPORTER: profile === "exporter" ? "in-process" : "disabled",
        ACKERDB_DURABILITY: "balanced",
        ACKERDB_BENCH_TELEMETRY_REPORT: reportPath,
      },
    },
  );
  const output = new AckerDBOutputCollector();
  const outputDone = Promise.allSettled([
    (async () => {
      for await (const chunk of server.stdout) output.writeStdout(chunk);
    })(),
    (async () => {
      for await (const chunk of server.stderr) output.writeStderr(chunk);
    })(),
  ]).then((readers) => {
    output.finish();
    const errors = readers.flatMap((reader) => reader.status === "rejected" ? [reader.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "ackerdb output readers failed");
  });
  let startupMode: AckerDBStartupMode | undefined;
  let startupIdle: MeasuredDriverResult["startupIdle"] | undefined;
  let measured: Omit<MeasuredDriverResult, "startupIdle" | "implementationVersion"> | undefined;
  const failures: BenchmarkFailurePart[] = [];
  const observations: string[] = [];
  try {
    await waitFor(() => output.output(), "ready on", 15_000);
    try {
      startupMode = assertAckerDBStartup(output.output(), expectedMode);
    } catch (error) {
      startupMode = expectedMode;
      observations.push(error instanceof Error ? error.message : String(error));
    }
    startupIdle = await measureStartupIdle(server.pid);
    measured = await runMeasuredClient(
      [process.execPath, join(BENCH, "ackerdb-client.ts")],
      { ACKERDB_URL: `http://127.0.0.1:${ACKERDB_PORT}` },
      server.pid,
    );
  } catch (error) {
    failures.push({ stage: "workload", error });
  }

  let serverStopped = false;
  let stopped: { exitCode: number; timedOut: boolean } | undefined;
  try {
    stopped = await stopSubprocess(
      server,
      expectedMode.gracefulShutdownMs + ACKERDB_SHUTDOWN_SLACK_MS,
    );
    serverStopped = true;
  } catch (error) {
    failures.push({ stage: "shutdown", error });
  }
  if (!serverStopped) {
    try {
      await stopSubprocess(server, 1_000);
    } catch (error) {
      failures.push({ stage: "forced cleanup", error });
    }
  }
  if (stopped?.timedOut) {
    failures.push({
      stage: "shutdown",
      error: new Error(
        `ackerdb benchmark server exceeded its ${expectedMode.gracefulShutdownMs}ms graceful shutdown deadline`,
      ),
    });
  } else if (stopped !== undefined && stopped.exitCode !== 0) {
    failures.push({
      stage: "server exit",
      error: new Error(`ackerdb benchmark server failed with exit code ${stopped.exitCode}`),
    });
  }
  try {
    await withTimeout(outputDone, 2_000, "ackerdb output drain");
  } catch (error) {
    failures.push({ stage: "server output", error });
  }

  let result: AckerDBMeasuredDriverResult | undefined;
  if (failures.length === 0) {
    try {
      if (startupMode === undefined || startupIdle === undefined || measured === undefined) {
        throw new Error("ackerdb benchmark server did not complete its measured workload");
      }
      const telemetryReport = parseAckerDBTelemetryReport(
        readFileSync(reportPath, "utf8"),
        startupMode,
        output.snapshot(),
      );
      try {
        assertAckerDBTelemetryWorkload(telemetryReport, measured.workload);
      } catch (error) {
        observations.push(error instanceof Error ? error.message : String(error));
      }
      result = {
        ...measured,
        startupIdle,
        implementationVersion: "workspace",
        startupMode,
        telemetryReport,
        observations,
      };
    } catch (error) {
      failures.push({ stage: "observation collection", error });
    }
  }
  try {
    rmSync(reportPath, { force: true });
  } catch (error) {
    failures.push({ stage: "report cleanup", error });
  }
  try {
    assertPortFree(ACKERDB_PORT);
  } catch (error) {
    failures.push({ stage: "port cleanup", error });
  }
  if (failures.length > 0) {
    throw benchmarkFailure("ackerdb benchmark", failures, {
      tail: `server output tail:\n${output.output()}`,
    });
  }
  if (result === undefined) throw new Error("ackerdb benchmark completed without a result");
  return result;
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

function aggregateCell(cell: { readonly count: number; readonly durationMs: number }): string {
  return `${cell.count}/${fmt(cell.count === 0 ? 0 : cell.durationMs / cell.count)}`;
}

function printAckerDBTelemetryStatus(results: readonly AckerDBMeasuredDriverResult[]): void {
  console.log("\nACKERDB telemetry accounting and bounded retention observations");
  console.log(
    "| profile | local records | serialized MB | retained before drain | exported during drain | drain drops | overflow drops | query queue count/mean ms | mutation queue count/mean ms | procedure admission | subscription queue count/mean ms | trace promoted/discarded | exporter records |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const result of results) {
    const report = result.telemetryReport;
    const operations = report.aggregates.operations;
    const trace = report.runtime.afterDrain.traceRetention;
    const queryQueue = operations.query.stages.queue;
    const mutationQueue = operations.mutation.stages.queue;
    const subscriptionQueue = operations.subscription.stages.queue;
    console.log(
      `| ${report.startupMode.telemetryProfile} | ${report.localOutput.records} | ${fmt(report.localOutput.bytes / 1024 ** 2)} | ${report.drainAccounting.retainedBeforeDrain} | ${report.drainAccounting.exportedDuringDrain} | ${report.drainAccounting.drainDropDelta} | ${report.runtime.afterDrain.dropped.overflow} | ${aggregateCell(queryQueue)} | ${aggregateCell(mutationQueue)} | ${operations.procedure.stages.admission.count} | ${aggregateCell(subscriptionQueue)} | ${trace.promotedTraces}/${trace.discardedTraces} | ${report.runtime.afterDrain.exporter.exportedRecords} |`,
    );
  }
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function resourceWindow(
  system: MeasuredDriverResult,
  phaseId: string,
  owner: "server" | "loadGenerator" = "server",
): ProcessTreeWindowSummary {
  const window = system.resources[owner].phases[phaseId];
  if (!window) throw new Error(`missing ${owner} resource window ${phaseId}`);
  return window;
}

function printResults(systems: Partial<Record<"ackerdb", MeasuredDriverResult>>): void {
  const names = ALL_SYSTEMS.filter((name) => systems[name]);
  const first = systems[names[0]!]!.workload;
  console.log("\nOperation throughput and latency (median of steady-state trials)");
  console.log(`| operation/profile | ${names.flatMap((name) => [`${name} TPS`, `${name} p95 ms`]).join(" | ")} |`);
  console.log(`|---|${names.flatMap(() => ["---:", "---:"]).join("|")}|`);
  for (const operation of OPERATION_NAMES) {
    for (const profile of first.config.operation.profiles) {
      const cells: string[] = [];
      for (const name of names) {
        const workload = systems[name]!.workload;
        const result = workload.operations.find(
          (item) => item.operation === operation && item.profile.name === profile.name,
        );
        const failed = workload.failures.some(
          (failure) =>
            failure.kind === "operation" &&
            failure.operation === operation &&
            failure.profile.name === profile.name,
        );
        cells.push(
          failed ? "FAIL" : result === undefined ? "—" : fmt(result.medianThroughputPerSec, 0),
          failed || result === undefined ? "—" : fmt(result.medianLatencyP95Ms),
        );
      }
      console.log(`| ${operation}/${profile.name} | ${cells.join(" | ")} |`);
    }
  }
  console.log("\nServer resources at idle (timed windows with no requests)");
  console.log("| system | state | RSS p50 MB | RSS peak MB | CPU cores | processes peak |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    const seeded = resourceWindow(system, system.workload.snapshots.seededIdlePhaseId);
    console.log(
      `| ${name} | empty/no clients | ${fmt(system.startupIdle.window.rssMb.p50, 1)} | ${fmt(system.startupIdle.window.rssMb.peak, 1)} | ${fmt(system.startupIdle.window.cpuCores)} | ${system.startupIdle.window.processCountPeak} |`,
    );
    console.log(
      `| ${name} | seeded/no clients | ${fmt(seeded.rssMb.p50, 1)} | ${fmt(seeded.rssMb.peak, 1)} | ${fmt(seeded.cpuCores)} | ${seeded.processCountPeak} |`,
    );
  }

  console.log("\nServer resources under operation load (highest default concurrency)");
  console.log("| system | operation/profile | server RSS p50 MB | server RSS peak MB | server CPU cores | loadgen CPU cores |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    const profile = system.workload.config.profile === "quick" ? "concurrent" : "saturation";
    for (const result of system.workload.operations.filter((item) => item.profile.name === profile)) {
      const windows = result.trials.map((trial) => resourceWindow(system, trial.phaseId));
      const loadWindows = result.trials.map((trial) => resourceWindow(system, trial.phaseId, "loadGenerator"));
      console.log(
        `| ${name} | ${result.operation}/${profile} | ${fmt(medianNumber(windows.map((window) => window.rssMb.p50)), 1)} | ${fmt(Math.max(...windows.map((window) => window.rssMb.peak)), 1)} | ${fmt(medianNumber(windows.map((window) => window.cpuCores)))} | ${fmt(medianNumber(loadWindows.map((window) => window.cpuCores)))} |`,
      );
    }
  }

  console.log("\nConnection scale (ready = socket/client plus one validated indexed probe)");
  console.log("| system | target | connected | ready/s | ready p95 ms | query TPS | query p95 ms |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  const levels = [...new Set(names.flatMap((name) => systems[name]!.workload.connections.map((level) => level.targetConnections)))];
  for (const level of levels) {
    for (const name of names) {
      const result = systems[name]!.workload.connections.find((item) => item.targetConnections === level);
      const failed = systems[name]!.workload.failures.some(
        (failure) => failure.kind === "connection" && failure.targetConnections === level,
      );
      if (result === undefined) {
        console.log(`| ${name} | ${level} | ${failed ? "FAIL" : "—"} | — | — | — | — |`);
      } else {
        console.log(
          `| ${name} | ${level} | ${result.connected} | ${fmt(result.readyConnectionsPerSec, 0)} | ${fmt(result.readyLatency.p95Ms)} | ${fmt(result.work.throughputPerSec, 0)} | ${fmt(result.work.latency.p95Ms)} |`,
        );
      }
    }
  }
  console.log("\nServer resources across connection plateaus");
  console.log("| system | connections | baseline RSS MB | connected RSS MB | RSS delta MB | idle CPU cores | work RSS peak MB | work CPU cores | loadgen CPU cores |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    const hasMeasuredConnections = system.workload.connections.length > 0;
    const baseline = hasMeasuredConnections
      ? resourceWindow(system, system.workload.snapshots.connectionBaselineIdlePhaseId)
      : undefined;
    for (const result of system.workload.connections) {
      const idle = resourceWindow(system, result.connectedIdlePhaseId);
      const work = resourceWindow(system, result.work.phaseId);
      const load = resourceWindow(system, result.work.phaseId, "loadGenerator");
      console.log(
        `| ${name} | ${result.connected} | ${fmt(baseline!.rssMb.p50, 1)} | ${fmt(idle.rssMb.p50, 1)} | ${fmt(idle.rssMb.p50 - baseline!.rssMb.p50, 1)} | ${fmt(idle.cpuCores)} | ${fmt(work.rssMb.peak, 1)} | ${fmt(work.cpuCores)} | ${fmt(load.cpuCores)} |`,
      );
    }
  }

  console.log("\nFixed-rate subscription load");
  console.log(`| pattern | system | logical queries | setup s | updates/s | deliveries/s | delivery p95 ms | missing | base RSS MB | subscribed RSS MB | RSS delta MB | idle CPU cores | work peak RSS MB | work CPU cores | loadgen CPU cores |`);
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    for (const pattern of system.workload.config.subscriptions.patterns) {
      const result = system.workload.subscriptions.find((subscription) => subscription.pattern === pattern);
      const failed = system.workload.failures.some(
        (failure) => failure.kind === "subscription" && failure.pattern === pattern,
      );
      if (result === undefined) {
        console.log(`| ${pattern} | ${name} | ${failed ? "FAIL" : "—"} | — | — | — | — | — | — | — | — | — | — | — | — |`);
        continue;
      }
      const resources = system.resources.server.phases[result.phaseId];
      const baseline = system.resources.server.phases[result.baselineIdlePhaseId];
      const idle = system.resources.server.phases[result.subscribedIdlePhaseId];
      const load = system.resources.loadGenerator.phases[result.phaseId];
      console.log(
        `| ${result.pattern} | ${name} | ${result.logicalSubscriptions} | ${fmt(result.setupMs / 1_000)} | ${fmt(result.updateThroughputPerSec)} | ${fmt(result.deliveryThroughputPerSec, 0)} | ${fmt(result.deliveryLatency.p95Ms)} | ${result.missingDeliveries} | ${baseline ? fmt(baseline.rssMb.p50, 1) : "—"} | ${idle ? fmt(idle.rssMb.p50, 1) : "—"} | ${baseline && idle ? fmt(idle.rssMb.p50 - baseline.rssMb.p50, 1) : "—"} | ${idle ? fmt(idle.cpuCores) : "—"} | ${resources ? fmt(resources.rssMb.peak, 1) : "—"} | ${resources ? fmt(resources.cpuCores) : "—"} | ${load ? fmt(load.cpuCores) : "—"} |`,
      );
    }
  }

  console.log("\nSubscription end-to-end saturation (an update completes only after every intended delivery)");
  console.log("| pattern | system | writer slots | updates/s | deliveries/s | ack p95 ms | delivery p95 ms | all p95 ms | server RSS peak MB | server CPU cores | loadgen CPU cores |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    for (const pattern of system.workload.config.subscriptions.patterns) {
      const subscription = system.workload.subscriptions.find((result) => result.pattern === pattern);
      for (const slots of subscriptionCapacitySlots(system.workload.config.subscriptions, pattern)) {
        const capacity = subscription?.capacity.find((result) => result.slots === slots);
        const failed = system.workload.failures.some((failure) =>
          (failure.kind === "subscription" && failure.pattern === pattern) ||
          (failure.kind === "subscription-capacity" && failure.pattern === pattern && failure.slots === slots)
        );
        if (capacity === undefined) {
          console.log(`| ${pattern} | ${name} | ${slots} | ${failed ? "FAIL" : "—"} | — | — | — | — | — | — | — |`);
          continue;
        }
        const resources = resourceWindow(system, capacity.phaseId);
        const load = resourceWindow(system, capacity.phaseId, "loadGenerator");
        console.log(
          `| ${pattern} | ${name} | ${capacity.slots} | ${fmt(capacity.throughputPerSec, 1)} | ${fmt(capacity.deliveryThroughputPerSec, 0)} | ${fmt(capacity.updateAckLatency.p95Ms)} | ${fmt(capacity.deliveryLatency.p95Ms)} | ${fmt(capacity.latency.p95Ms)} | ${fmt(resources.rssMb.peak, 1)} | ${fmt(resources.cpuCores)} | ${fmt(load.cpuCores)} |`,
        );
      }
    }
  }
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

const benchmarkConfig = benchmarkConfigFromEnv();
if (benchmarkConfig.profile !== "default") {
  throw new Error("protected-branch benchmarks use the default workload only");
}
const outputPath = process.env.BENCH_OUTPUT;
const sourceLabel = process.env.BENCH_SOURCE_LABEL;
const sourceCommit = process.env.BENCH_SOURCE_COMMIT;
const harnessCommit = process.env.BENCH_HARNESS_COMMIT;
if (
  !outputPath ||
  (sourceLabel !== "base" && sourceLabel !== "head") ||
  !sourceCommit ||
  !harnessCommit
) {
  throw new Error(
    "BENCH_OUTPUT, BENCH_SOURCE_LABEL=base|head, BENCH_SOURCE_COMMIT, and BENCH_HARNESS_COMMIT are required",
  );
}
const requestedProfiles = (process.env.BENCH_TELEMETRY_PROFILES ?? "disabled")
  .split(",") as AckerDBBenchmarkProfile[];
if (
  requestedProfiles.length === 0 ||
  requestedProfiles.some((profile) => !["enabled", "exporter", "disabled"].includes(profile)) ||
  new Set(requestedProfiles).size !== requestedProfiles.length
) {
  throw new Error("BENCH_TELEMETRY_PROFILES must contain unique enabled, exporter, or disabled profiles");
}

await runCodegen(loadConfig(join(BENCH, "ackerdb-app"), {
  ACKERDB_DURABILITY: "balanced",
  ACKERDB_TELEMETRY: requestedProfiles.every((profile) => profile === "disabled")
    ? "disabled"
    : "enabled",
}));
const executionOrder = benchmarkExecutionOrder(requestedProfiles, 0);
const profiles: Partial<Record<AckerDBBenchmarkProfile, AckerDBMeasuredDriverResult>> = {};
for (let index = 0; index < executionOrder.length; index++) {
  const leg = executionOrder[index]!;
  const profile = leg.replace("ackerdb-telemetry-", "") as AckerDBBenchmarkProfile;
  profiles[profile] = await benchAckerDB(profile);
  if (index < executionOrder.length - 1 && COOLDOWN_MS > 0) await Bun.sleep(COOLDOWN_MS);
}
const observations = collectBenchmarkObservations(requestedProfiles.map((profile) => ({
  label: `ackerdb/${profile}`,
  system: "ackerdb" as const,
  workload: profiles[profile]!.workload,
})));
const version = packageVersion(join(REPO, "packages", "core", "package.json"));
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`benchmark source version ${version} is not x.y.z`);
}
const record: BenchmarkSample = {
  schemaVersion: 1,
  source: { label: sourceLabel, commit: sourceCommit, version },
  harnessCommit,
  timestamp: new Date().toISOString(),
  machine: machineRecord(),
  methodology: {
    serverResources: `${RESOURCE_SAMPLE_MS}ms shared ps process-tree sampling; RSS is sampled summed per-process RSS (shared pages may be counted more than once) and CPU is cumulative user+system time`,
    loadGeneratorResources: "same shared process-table samples, reported separately from server resources to expose client-side saturation",
    sampleIntervalMs: RESOURCE_SAMPLE_MS,
    durability: "server-confirmed balanced profile: SQLite WAL, synchronous=NORMAL, mutation acknowledgement after COMMIT; process-crash consistent, not a power-loss durability claim",
    telemetry: requestedProfiles.length === 1 && requestedProfiles[0] === "disabled"
      ? "telemetry disabled; no telemetry work changed in this pull request"
      : "paired enabled, exporter, and disabled profiles because telemetry work changed",
    subscriptionCapacity: "closed-loop end-to-end saturation at increasing independent-writer concurrency; an update completes only after every intended client validates delivery",
  },
  executionOrder,
  profiles,
  observations,
};
await Bun.write(outputPath, `${JSON.stringify(record, null, 2)}\n`);
if (profiles.disabled) printResults({ ackerdb: profiles.disabled });
console.log(`\n${formatBenchmarkObservations(observations)}`);
printAckerDBTelemetryStatus(requestedProfiles.map((profile) => profiles[profile]!));
console.log(`\nsaved ${sourceLabel} AckerDB sample to ${outputPath} for human interpretation`);
