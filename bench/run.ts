/** Apples-to-apples release benchmark runner; invoked only by the Hetzner worker. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { runCodegen } from "../packages/cli/src/codegen.ts";
import { loadConfig } from "../packages/cli/src/config.ts";
import {
  benchmarkConfigFromEnv,
  OPERATION_NAMES,
  subscriptionCapacitySlots,
  type DriverResult,
  type SystemName,
} from "./benchmark.ts";
import {
  assertDbzzStartup,
  benchmarkExecutionOrder,
  compareProfileMetrics,
  expectedDbzzStartupMode,
  type BenchmarkExecutionLeg,
  type DbzzBenchmarkProfile,
  type DbzzStartupMode,
  type ProfileComparisonMetric,
} from "./dbzz-profile.ts";
import {
  assertDbzzTelemetryWorkload,
  DbzzOutputCollector,
  parseDbzzTelemetryReport,
  type DbzzTelemetryReport,
} from "./dbzz-telemetry.ts";
import {
  ProcessTreeMonitor,
  readProcessTable,
  type ProcessTreeSnapshot,
  type ProcessTreeWindowSummary,
} from "./process-tree.ts";
import { withTimeout } from "./load-engine.ts";
import {
  evaluatePerformanceAcceptance,
  extractComparableMetrics,
  type PerformanceAcceptanceResult,
} from "./performance-gates.ts";
import {
  readPreviousFinalBenchmark,
  readPreviousIterationBenchmark,
  releaseBenchmarkContext,
  retainReleaseBenchmark,
  type ReleaseBenchmarkContext,
} from "./release.ts";
import {
  activePhaseIds,
  BENCHMARK_START_SIGNAL,
  benchmarkFailure,
  BoundedTextTail,
  stopSubprocess,
  type BenchmarkFailurePart,
} from "./process-lifecycle.ts";
import {
  formatBenchmarkValidation,
  validateBenchmarkResults,
  type BenchmarkValidation,
  type BenchmarkValidationTarget,
} from "./result-validation.ts";

const BENCH = import.meta.dir;
const REPO = join(BENCH, "..");
const RESULTS_DIR = join(BENCH, "results");
const DBZZ_PORT = 3311;
const CONVEX_PORTS = [3210, 3211];
const SPACETIME_PORT = 5321;
const REQUIRED_SPACETIME_VERSION = "2.6.1";
const RESOURCE_SAMPLE_MS = Number(process.env.BENCH_RESOURCE_SAMPLE_MS ?? 250);
const COOLDOWN_MS = Number(process.env.BENCH_COOLDOWN_MS ?? 2_000);
const DBZZ_SHUTDOWN_SLACK_MS = 2_000;
const ALL_SYSTEMS: SystemName[] = ["dbzz", "convex", "spacetimedb"];

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

interface DbzzMeasuredDriverResult extends MeasuredDriverResult {
  startupMode: DbzzStartupMode;
  telemetryReport: DbzzTelemetryReport;
}

type SystemResults = Partial<Record<SystemName, MeasuredDriverResult>> & {
  dbzz?: DbzzMeasuredDriverResult;
};

interface MachineRecord {
  platform: string;
  arch: string;
  cpu: string;
  logicalCpus: number;
  memGb: number;
  osRelease: string;
  fileDescriptorLimit: number;
}

/**
 * The release evidence: apples-to-apples. The DBZZ leg runs telemetry=false
 * because the comparative targets ship no equivalent always-on telemetry;
 * telemetry cost has its own optional run (`TelemetryRunRecord`).
 */
interface RunRecord {
  schemaVersion: 9;
  release: ReleaseBenchmarkContext & { readonly previousVersion: string | null };
  timestamp: string;
  git: { commit: string; dirty: boolean; sourceHash: string };
  machine: MachineRecord;
  versions: Record<string, string>;
  methodology: {
    serverResources: string;
    loadGeneratorResources: string;
    sampleIntervalMs: number;
    durability: Record<SystemName, string>;
    dbzzProfiles: string;
    dbzzTelemetryValidation: string;
    spacetimeQueryTransport: string;
    subscriptionCapacity: string;
  };
  executionOrder: BenchmarkExecutionLeg[];
  systems: SystemResults;
  validation: BenchmarkValidation;
  performanceAcceptance: PerformanceAcceptanceResult;
}

/** The optional telemetry-cost run: DBZZ against itself, no comparative legs. */
interface TelemetryRunRecord {
  kind: "telemetry";
  schemaVersion: 1;
  version: string;
  timestamp: string;
  git: { commit: string; dirty: boolean; sourceHash: string };
  machine: MachineRecord;
  executionOrder: BenchmarkExecutionLeg[];
  profiles: {
    enabled: DbzzMeasuredDriverResult;
    exporter: DbzzMeasuredDriverResult;
    disabled: DbzzMeasuredDriverResult;
  };
  telemetryCost: ProfileComparisonMetric[] | null;
  exporterCost: ProfileComparisonMetric[] | null;
  validation: BenchmarkValidation;
}

interface ComparableMetric {
  label: string;
  value: number;
  lowerIsBetter: boolean;
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

function findPidByCommand(...fragments: string[]): number {
  const output = Bun.spawnSync(["ps", "-ww", "-eo", "pid,command"]).stdout.toString();
  for (const line of output.split("\n")) {
    if (fragments.every((fragment) => line.includes(fragment))) return Number(line.trim().split(/\s+/)[0]);
  }
  throw new Error(`no process matching ${JSON.stringify(fragments)}`);
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

async function benchDbzz(profile: DbzzBenchmarkProfile): Promise<DbzzMeasuredDriverResult> {
  const expectedMode = expectedDbzzStartupMode(profile, "balanced");
  const telemetry = profile === "disabled" ? "disabled" : "enabled";
  const reportPath = join(tmpdir(), `dbzz-benchmark-telemetry-${process.pid}-${randomUUID()}.json`);
  assertPortsFree([DBZZ_PORT]);
  console.log(
    `→ dbzz: fresh server (telemetry=${telemetry}, profile=${expectedMode.telemetryProfile}, durability=balanced)`,
  );
  rmSync(join(BENCH, "dbzz-app", ".zdb"), { recursive: true, force: true });
  const server = Bun.spawn(
    [process.execPath, join(BENCH, "dbzz-server.ts"), join(BENCH, "dbzz-app")],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DBZZ_TELEMETRY: telemetry,
        DBZZ_BENCH_EXPORTER: profile === "exporter" ? "in-process" : "disabled",
        DBZZ_DURABILITY: "balanced",
        DBZZ_BENCH_TELEMETRY_REPORT: reportPath,
      },
    },
  );
  const output = new DbzzOutputCollector();
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
    if (errors.length > 0) throw new AggregateError(errors, "dbzz output readers failed");
  });
  let startupMode: DbzzStartupMode | undefined;
  let startupIdle: MeasuredDriverResult["startupIdle"] | undefined;
  let measured: Omit<MeasuredDriverResult, "startupIdle" | "implementationVersion"> | undefined;
  const failures: BenchmarkFailurePart[] = [];
  try {
    await waitFor(() => output.output(), "ready on", 15_000);
    startupMode = assertDbzzStartup(output.output(), expectedMode);
    startupIdle = await measureStartupIdle(server.pid);
    measured = await runMeasuredClient(
      [process.execPath, join(BENCH, "dbzz-client.ts")],
      { DBZZ_URL: `http://127.0.0.1:${DBZZ_PORT}` },
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
      expectedMode.gracefulShutdownMs + DBZZ_SHUTDOWN_SLACK_MS,
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
        `dbzz benchmark server exceeded its ${expectedMode.gracefulShutdownMs}ms graceful shutdown deadline`,
      ),
    });
  } else if (stopped !== undefined && stopped.exitCode !== 0) {
    failures.push({
      stage: "server exit",
      error: new Error(`dbzz benchmark server failed with exit code ${stopped.exitCode}`),
    });
  }
  try {
    await withTimeout(outputDone, 2_000, "dbzz output drain");
  } catch (error) {
    failures.push({ stage: "server output", error });
  }

  let result: DbzzMeasuredDriverResult | undefined;
  if (failures.length === 0) {
    try {
      if (startupMode === undefined || startupIdle === undefined || measured === undefined) {
        throw new Error("dbzz benchmark server did not complete its measured workload");
      }
      const telemetryReport = parseDbzzTelemetryReport(
        readFileSync(reportPath, "utf8"),
        startupMode,
        output.snapshot(),
      );
      assertDbzzTelemetryWorkload(telemetryReport, measured.workload);
      result = { ...measured, startupIdle, implementationVersion: "workspace", startupMode, telemetryReport };
    } catch (error) {
      failures.push({ stage: "validation", error });
    }
  }
  try {
    rmSync(reportPath, { force: true });
  } catch (error) {
    failures.push({ stage: "report cleanup", error });
  }
  try {
    assertPortFree(DBZZ_PORT);
  } catch (error) {
    failures.push({ stage: "port cleanup", error });
  }
  if (failures.length > 0) {
    throw benchmarkFailure("dbzz benchmark", failures, {
      tail: `server output tail:\n${output.output()}`,
    });
  }
  if (result === undefined) throw new Error("dbzz benchmark completed without a result");
  return result;
}

function convexBackendPid(): number {
  return findPidByCommand("convex-local-backend", join(BENCH, "convex-app"));
}

async function benchConvex(): Promise<MeasuredDriverResult> {
  assertPortsFree(CONVEX_PORTS);
  console.log("→ convex: fresh local backend");
  rmSync(join(BENCH, "convex-app", ".convex", "local"), { recursive: true, force: true });
  const dev = Bun.spawn(
    ["bunx", "convex", "dev", "--tail-logs", "disable", "--typecheck", "disable"],
    { cwd: join(BENCH, "convex-app"), stdout: "pipe", stderr: "pipe" },
  );
  const stdout = tail(dev as never);
  const stderr = tail({ stdout: dev.stderr } as never);
  const output = () => stdout.output() + stderr.output();
  try {
    await waitFor(output, "Convex functions ready", 120_000);
    const pid = convexBackendPid();
    const startupIdle = await measureStartupIdle(pid);
    const measured = await runMeasuredClient(
      [process.execPath, join(BENCH, "convex-app", "client.ts")],
      { CONVEX_URL: `http://127.0.0.1:${CONVEX_PORTS[0]}` },
      pid,
    );
    const config = JSON.parse(
      readFileSync(join(BENCH, "convex-app", ".convex", "local", "default", "config.json"), "utf8"),
    ) as { backendVersion?: string };
    return { ...measured, startupIdle, implementationVersion: config.backendVersion ?? "unknown" };
  } finally {
    try {
      Bun.spawnSync(["kill", String(convexBackendPid())]);
    } catch {
      // The dev process may already have stopped the backend.
    }
    dev.kill();
    await dev.exited;
    await Promise.all([stdout.done, stderr.done]);
  }
}

function spacetimeServerPid(dataDir: string): number {
  return findPidByCommand("spacetimedb-standalone", dataDir);
}

async function benchSpacetime(): Promise<MeasuredDriverResult> {
  const version = assertSpacetimeVersionAlignment();
  assertPortsFree([SPACETIME_PORT]);
  console.log(`→ spacetimedb ${version}: fresh standalone server`);
  const appDir = join(BENCH, "spacetime-app");
  const moduleDir = join(appDir, "spacetimedb");
  const bindingsDir = join(appDir, "module_bindings");
  const dataDir = join(appDir, ".stdb-data");
  rmSync(dataDir, { recursive: true, force: true });
  const starter = Bun.spawn(
    ["spacetime", "start", "--listen-addr", `127.0.0.1:${SPACETIME_PORT}`, "--data-dir", dataDir, "--non-interactive"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = tail(starter as never);
  const stderr = tail({ stdout: starter.stderr } as never);
  const output = () => stdout.output() + stderr.output();
  try {
    await waitFor(output, `listening on 127.0.0.1:${SPACETIME_PORT}`, 30_000);
    const generate = Bun.spawnSync(
      ["spacetime", "generate", "--lang", "typescript", "--out-dir", bindingsDir, "--module-path", moduleDir, "-y", "--no-config"],
      { cwd: appDir, stdout: "pipe", stderr: "pipe" },
    );
    if (generate.exitCode !== 0) throw new Error(`spacetime generate failed:\n${generate.stderr}`);
    const publish = Bun.spawnSync(
      [
        "spacetime",
        "publish",
        "dbzz-bench",
        "--module-path",
        moduleDir,
        "-s",
        `http://127.0.0.1:${SPACETIME_PORT}`,
        "--anonymous",
        "-y",
        "--no-config",
      ],
      { cwd: appDir, stdout: "pipe", stderr: "pipe" },
    );
    if (publish.exitCode !== 0) throw new Error(`spacetime publish failed:\n${publish.stderr}`);
    const pid = spacetimeServerPid(dataDir);
    const startupIdle = await measureStartupIdle(pid);
    const measured = await runMeasuredClient(
      [process.execPath, join(appDir, "client.ts")],
      { SPACETIMEDB_URL: `ws://127.0.0.1:${SPACETIME_PORT}`, SPACETIMEDB_DB: "dbzz-bench" },
      pid,
    );
    return { ...measured, startupIdle, implementationVersion: version };
  } finally {
    try {
      Bun.spawnSync(["kill", String(spacetimeServerPid(dataDir))]);
    } catch {
      // Server may already be gone.
    }
    starter.kill();
    await starter.exited;
    await Promise.all([stdout.done, stderr.done]);
  }
}

function packageVersion(path: string): string {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function spacetimeCliVersion(): string {
  return Bun.spawnSync(["spacetime", "--version"])
    .stdout.toString()
    .match(/tool version ([\d.]+)/)?.[1] ?? "unknown";
}

function assertSpacetimeVersionAlignment(): string {
  const versions = {
    cli: spacetimeCliVersion(),
    client: packageVersion(join(BENCH, "spacetime-app", "node_modules", "spacetimedb", "package.json")),
    module: packageVersion(
      join(BENCH, "spacetime-app", "spacetimedb", "node_modules", "spacetimedb", "package.json"),
    ),
  };
  for (const [component, version] of Object.entries(versions)) {
    if (version !== REQUIRED_SPACETIME_VERSION) {
      throw new Error(
        `SpacetimeDB ${component} is ${version}; this benchmark requires every component to be ${REQUIRED_SPACETIME_VERSION}`,
      );
    }
  }
  return REQUIRED_SPACETIME_VERSION;
}

function sourceHash(): string {
  const output = Bun.spawnSync(["rg", "--files", "bench", "packages", "package.json", "bun.lock"], {
    cwd: REPO,
    stdout: "pipe",
  });
  const files = output.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .filter(
      (file) =>
        !file.startsWith("bench/results/") &&
        file !== "bench/README.md" &&
        !file.endsWith(".test.ts") &&
        !file.includes("/.stdb-data/") &&
        !file.includes("/.convex/"),
    )
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(REPO, join(REPO, file)));
    hash.update("\0");
    hash.update(readFileSync(join(REPO, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd: REPO }).stdout.toString().trim();
}

function fileDescriptorLimit(): number {
  const result = Bun.spawnSync(["sh", "-c", "ulimit -n"], { stdout: "pipe" });
  return Number(result.stdout.toString().trim());
}

function comparisonMetrics(system: MeasuredDriverResult): ComparableMetric[] {
  return extractComparableMetrics(system).map((metric) => ({
    label: metric.path,
    value: metric.value,
    lowerIsBetter: metric.direction === "lower",
  }));
}

function validationTargetIsSystem(target: string, system: SystemName): boolean {
  return target === system || target.startsWith(`${system}/`);
}

function systemPassedValidation(record: RunRecord, system: SystemName): boolean {
  return !record.validation.failures.some((failure) => validationTargetIsSystem(failure.target, system));
}

function printDbzzProfileCost(title: string, metrics: ProfileComparisonMetric[]): void {
  const first = metrics[0];
  if (first === undefined) throw new Error(`${title} has no comparable metrics`);
  console.log(`\n${title} (positive delta means ${first.measuredProfile} measured higher)`);
  console.log(`| metric | ${first.measuredProfile} | ${first.referenceProfile} | measured vs reference |`);
  console.log("|---|---:|---:|---:|");
  for (const metric of metrics) {
    if (
      metric.measuredProfile !== first.measuredProfile ||
      metric.referenceProfile !== first.referenceProfile
    ) {
      throw new Error(`${title} mixes telemetry profile comparisons`);
    }
    const delta = metric.measuredVsReferencePercent;
    console.log(
      `| ${metric.label} | ${fmt(metric.measured)} | ${fmt(metric.reference)} | ${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${fmt(delta, 1)}%`} |`,
    );
  }
}

function aggregateCell(cell: { readonly count: number; readonly durationMs: number }): string {
  return `${cell.count}/${fmt(cell.count === 0 ? 0 : cell.durationMs / cell.count)}`;
}

function printDbzzTelemetryStatus(results: readonly DbzzMeasuredDriverResult[]): void {
  console.log("\nDBZZ default-local telemetry validation and bounded retention status");
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

function printResults(systems: Partial<Record<SystemName, MeasuredDriverResult>>): void {
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

function gitRecord(): RunRecord["git"] {
  return {
    commit: process.env.BENCH_RELEASE_SOURCE_COMMIT ?? git(["rev-parse", "--short", "HEAD"]),
    dirty: git(["status", "--porcelain"]).length > 0,
    sourceHash: sourceHash(),
  };
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

/**
 * The optional telemetry-cost run: three DBZZ profiles against each other —
 * enabled (runtime default), exporter handoff, and disabled. No comparative
 * legs, no release gating; the record lands beside the release evidence as
 * telemetry-v<version>.json and is overwritten freely.
 */
async function runTelemetryBenchmark(version: string): Promise<void> {
  await runCodegen(loadConfig(join(BENCH, "dbzz-app"), {
    DBZZ_DURABILITY: "balanced",
    DBZZ_TELEMETRY: "enabled",
  }));
  const executionOrder = benchmarkExecutionOrder(["dbzz"], ["enabled", "exporter", "disabled"], 0);
  const measured = new Map<BenchmarkExecutionLeg, DbzzMeasuredDriverResult>();
  for (let index = 0; index < executionOrder.length; index++) {
    const leg = executionOrder[index]!;
    const profile = leg.replace("dbzz-telemetry-", "") as DbzzBenchmarkProfile;
    measured.set(leg, await benchDbzz(profile));
    if (index < executionOrder.length - 1 && COOLDOWN_MS > 0) await Bun.sleep(COOLDOWN_MS);
  }
  const profiles = {
    enabled: measured.get("dbzz-telemetry-enabled")!,
    exporter: measured.get("dbzz-telemetry-exporter")!,
    disabled: measured.get("dbzz-telemetry-disabled")!,
  };
  const validation = validateBenchmarkResults([
    { label: "dbzz/runtime-default", system: "dbzz", workload: profiles.enabled.workload },
    { label: "dbzz/benchmark-exporter", system: "dbzz", workload: profiles.exporter.workload },
    { label: "dbzz/disabled", system: "dbzz", workload: profiles.disabled.workload },
  ]);
  const clean = validation.dbzzStatus === "passed";
  const telemetryCost = clean
    ? compareProfileMetrics("runtime-default", comparisonMetrics(profiles.enabled), "disabled", comparisonMetrics(profiles.disabled))
    : null;
  const exporterCost = clean
    ? compareProfileMetrics("benchmark-exporter", comparisonMetrics(profiles.exporter), "runtime-default", comparisonMetrics(profiles.enabled))
    : null;

  console.log(`\n${formatBenchmarkValidation(validation)}`);
  if (telemetryCost !== null) printDbzzProfileCost("DBZZ default telemetry cost", telemetryCost);
  if (exporterCost !== null) printDbzzProfileCost("DBZZ exporter handoff cost", exporterCost);
  printDbzzTelemetryStatus([profiles.enabled, profiles.exporter, profiles.disabled]);

  const record: TelemetryRunRecord = {
    kind: "telemetry",
    schemaVersion: 1,
    version,
    timestamp: new Date().toISOString(),
    git: gitRecord(),
    machine: machineRecord(),
    executionOrder,
    profiles,
    telemetryCost,
    exporterCost,
    validation,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const savedPath = join(RESULTS_DIR, `telemetry-v${version}.json`);
  await Bun.write(savedPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nsaved ${relative(REPO, savedPath)}`);
  if (!clean) {
    console.log("\ntelemetry benchmark correctness failed; fix before trusting the cost tables.");
    process.exitCode = 1;
  }
}

const requested = process.argv.slice(2) as SystemName[];
for (const name of requested) {
  if (!ALL_SYSTEMS.includes(name)) throw new Error(`unknown system ${JSON.stringify(name)}`);
}
if (new Set(requested).size !== requested.length) throw new Error("each requested system may appear only once");
if (requested.length > 0) throw new Error("release benchmarks always run DBZZ, Convex, and SpacetimeDB together");

const benchmarkConfig = benchmarkConfigFromEnv();
if (benchmarkConfig.profile !== "default") {
  throw new Error("release benchmarks use the default workload only");
}
const releaseContext = releaseBenchmarkContext(packageVersion(join(REPO, "packages", "core", "package.json")));

if (process.env.BENCH_RUN_KIND === "telemetry") {
  await runTelemetryBenchmark(releaseContext.version);
  process.exit(process.exitCode ?? 0);
}

const bootstrap = process.env.BENCH_RELEASE_BOOTSTRAP === "1";
const previous = bootstrap ? undefined : readPreviousFinalBenchmark<RunRecord>(RESULTS_DIR, releaseContext.version);
if (previous && (previous.record.schemaVersion !== 9 || previous.record.release?.host !== "hetzner")) {
  throw new Error(`v${previous.version} is not a final Hetzner release benchmark`);
}
const previousIteration = releaseContext.iteration > 1
  ? readPreviousIterationBenchmark<RunRecord>(RESULTS_DIR, releaseContext.version, releaseContext.iteration)
  : undefined;
if (releaseContext.iteration > 1 && previousIteration === undefined) {
  throw new Error(`release benchmark iteration ${releaseContext.iteration} requires a retained prior iteration`);
}
if (previousIteration && (
  previousIteration.record.schemaVersion !== 9 ||
  previousIteration.record.release?.host !== "hetzner" ||
  previousIteration.record.release.version !== releaseContext.version ||
  previousIteration.record.release.iteration !== previousIteration.iteration ||
  previousIteration.record.performanceAcceptance.status !== "recovery-needed"
)) {
  throw new Error(
    `v${releaseContext.version} iteration ${previousIteration.iteration} is not same-version Hetzner recovery evidence`,
  );
}

// Apples-to-apples: the comparative targets ship no equivalent always-on
// telemetry, so the release leg runs telemetry=false. Telemetry cost is the
// separate optional run above.
await runCodegen(loadConfig(join(BENCH, "dbzz-app"), {
  DBZZ_DURABILITY: "balanced",
  DBZZ_TELEMETRY: "disabled",
}));
const spacetimeVersion = assertSpacetimeVersionAlignment();
const executionOrder = benchmarkExecutionOrder(ALL_SYSTEMS, ["disabled"], releaseContext.iteration - 1);
const systems: SystemResults = {};
for (let index = 0; index < executionOrder.length; index++) {
  const leg = executionOrder[index]!;
  switch (leg) {
    case "dbzz-telemetry-disabled":
      systems.dbzz = await benchDbzz("disabled");
      break;
    case "convex":
      systems.convex = await benchConvex();
      break;
    case "spacetimedb":
      systems.spacetimedb = await benchSpacetime();
      break;
    default:
      throw new Error(`release benchmark does not run leg ${leg}`);
  }
  if (index < executionOrder.length - 1 && COOLDOWN_MS > 0) await Bun.sleep(COOLDOWN_MS);
}

if (systems.dbzz === undefined) {
  throw new Error("release benchmark DBZZ measurements are missing");
}
const validationTargets: BenchmarkValidationTarget[] = [
  { label: "dbzz", system: "dbzz", workload: systems.dbzz.workload },
  { label: "convex", system: "convex", workload: systems.convex!.workload },
  { label: "spacetimedb", system: "spacetimedb", workload: systems.spacetimedb!.workload },
];
const validation = validateBenchmarkResults(validationTargets);
const dbzzFailed = validation.dbzzStatus === "failed";

printResults(systems);
console.log(`\n${formatBenchmarkValidation(validation)}`);
// The release leg must prove its telemetry really is inactive.
printDbzzTelemetryStatus([systems.dbzz]);

const recordWithoutAcceptance: Omit<RunRecord, "performanceAcceptance"> = {
  schemaVersion: 9,
  release: { ...releaseContext, previousVersion: previous?.version ?? null },
  timestamp: new Date().toISOString(),
  git: gitRecord(),
  machine: machineRecord(),
  versions: {
    bun: Bun.version,
    bunRevision: Bun.spawnSync([process.execPath, "--revision"]).stdout.toString().trim(),
    convexClient: packageVersion(join(BENCH, "convex-app", "node_modules", "convex", "package.json")),
    convexBackend: systems.convex?.implementationVersion ?? "unknown",
    spacetimedbCli: spacetimeVersion,
    spacetimedbClient: packageVersion(join(BENCH, "spacetime-app", "node_modules", "spacetimedb", "package.json")),
    spacetimedbModule: packageVersion(join(BENCH, "spacetime-app", "spacetimedb", "node_modules", "spacetimedb", "package.json")),
  },
  methodology: {
    serverResources: `${RESOURCE_SAMPLE_MS}ms shared ps process-tree sampling; RSS is sampled summed per-process RSS (shared pages may be counted more than once) and CPU is cumulative user+system time`,
    loadGeneratorResources: "same shared process-table samples, reported separately from server resources to expose client-side saturation",
    sampleIntervalMs: RESOURCE_SAMPLE_MS,
    durability: {
      dbzz: "server-confirmed balanced profile: SQLite WAL, synchronous=NORMAL, mutation acknowledgement after COMMIT; process-crash consistent, not a power-loss durability claim",
      convex: "current local backend native default",
      spacetimedb: "confirmed reads explicitly enabled; standalone native durable commit log",
    },
    dbzzProfiles: "apples-to-apples: systems.dbzz runs telemetry=false because the comparative targets ship no equivalent always-on telemetry; telemetry cost is measured by the separate optional telemetry run (telemetry-v<version>.json), not re-proven on every release",
    dbzzTelemetryValidation: "the parent streams DBZZ stdout/stderr into fixed counters plus a 64 KiB diagnostic tail; the release leg runs telemetry=false and must prove it stays entirely inactive; enabled-profile accounting is validated by the telemetry run",
    spacetimeQueryTransport: "read-only procedure with explicit transaction because the 2.6 TypeScript SDK has no public one-off query API",
    subscriptionCapacity: "closed-loop end-to-end saturation at increasing independent-writer concurrency; an update completes only after every intended client validates delivery",
  },
  executionOrder,
  systems,
  validation,
};
// The release verdict judges DBZZ itself: a comparative harness failure is
// recorded in `validation.failures` but never vetoes a DBZZ release.
const performanceAcceptance: PerformanceAcceptanceResult = dbzzFailed
  ? { status: "not-evaluated", reason: "correctness-failed" }
  : bootstrap
    ? { status: "passed", evidence: {
      schemaVersion: 1,
      previousVersion: null,
      currentVersion: releaseContext.version,
      metricCount: 0,
      rerunOfIteration: null,
      observedRegressionCount: 0,
      regressions: [],
    } }
    : evaluatePerformanceAcceptance(previous!.record, recordWithoutAcceptance, {
      previousVersion: previous!.version,
      currentVersion: releaseContext.version,
    }, previousIteration && {
      previousIteration: previousIteration.iteration,
      record: previousIteration.record,
    });
const record: RunRecord = { ...recordWithoutAcceptance, performanceAcceptance };
mkdirSync(RESULTS_DIR, { recursive: true });
const approved = performanceAcceptance.status === "passed";
const savedPath = await retainReleaseBenchmark(RESULTS_DIR, releaseContext, approved, record);
console.log(`\nsaved ${relative(REPO, savedPath)}`);

if (performanceAcceptance.status === "not-evaluated") {
  console.log("\nbenchmark correctness failed; rerun after fixing the benchmark or product failure.");
} else if (performanceAcceptance.status === "recovery-needed") {
  const count = performanceAcceptance.evidence.regressions.length;
  if (releaseContext.iteration === 1) {
    console.log(`\nbenchmark verification rerun required (${count} material regression${count === 1 ? "" : "s"}). Rerun once; if it repeats, enter performance recovery and redesign the hot path before approving the release.`);
  } else {
    console.log(`\nperformance recovery required after a repeated benchmark regression (${count} material regression${count === 1 ? "" : "s"}). Treat intended behavior as a wrong design: find the hot path and redesign it before approving the release.`);
  }
  for (const regression of performanceAcceptance.evidence.regressions) {
    const delta = regression.deltaPercent === null ? "n/a" : `${regression.deltaPercent >= 0 ? "+" : ""}${regression.deltaPercent.toFixed(1)}%`;
    console.log(`  - ${regression.path}: ${regression.previous} → ${regression.current} (${delta})`);
  }
} else {
  console.log(bootstrap
    ? `\nrelease benchmark bootstrap approved: v${releaseContext.version} is the baseline for its successor.`
    : previousIteration
      ? `\nrelease benchmark approved: v${releaseContext.version} has no material DBZZ regression repeated from iteration ${previousIteration.iteration}.`
      : `\nrelease benchmark approved: v${releaseContext.version} has no material DBZZ regression against v${previous!.version}.`);
  if (validation.status === "failed") {
    console.log("comparative-target validation failures are recorded in the evidence (non-blocking; the gate judges DBZZ).");
  }
}

if (dbzzFailed || performanceAcceptance.status === "recovery-needed") process.exitCode = 1;
