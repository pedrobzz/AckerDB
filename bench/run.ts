/** Apples-to-apples local microbenchmark orchestrator. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { runCodegen } from "../packages/cli/src/codegen.ts";
import { loadConfig } from "../packages/cli/src/config.ts";
import { benchmarkConfigFromEnv, type DriverResult, type SystemName } from "./benchmark.ts";
import {
  assertDbzzStartup,
  benchmarkExecutionOrder,
  benchmarkRunPolicy,
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
  FROZEN_BASELINE_PATH,
  nearTieDriftTable,
  type PerformanceAcceptanceResult,
} from "./performance-gates.ts";
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
import { persistBenchmarkOutcome, type PersistedBenchmarkOutcome } from "./result-persistence.ts";

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

interface RunRecord {
  schemaVersion: 6;
  timestamp: string;
  git: { commit: string; dirty: boolean; sourceHash: string };
  machine: {
    platform: string;
    arch: string;
    cpu: string;
    logicalCpus: number;
    memGb: number;
    osRelease: string;
    fileDescriptorLimit: number;
  };
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
  dbzzTelemetryDisabled: DbzzMeasuredDriverResult;
  dbzzExporterProfile: DbzzMeasuredDriverResult;
  dbzzTelemetryCost: ProfileComparisonMetric[];
  dbzzExporterCost: ProfileComparisonMetric[];
  validation: BenchmarkValidation;
  performanceAcceptance: PerformanceAcceptanceResult;
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
    for await (const chunk of child.stdout) {
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
      }
    }
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

function savedCurrentCount(): number {
  try {
    return readdirSync(RESULTS_DIR).filter((name) => {
      if (!name.endsWith(".json")) return false;
      try {
        const result = JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as {
          schemaVersion?: number;
          dbzzExporterProfile?: unknown;
        };
        return result.schemaVersion === 6 && result.dbzzExporterProfile !== undefined;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

function balancedOrder(savedRuns: number): SystemName[] {
  const rotation = savedRuns % ALL_SYSTEMS.length;
  return [...ALL_SYSTEMS.slice(rotation), ...ALL_SYSTEMS.slice(0, rotation)];
}

/**
 * The connection-readiness sampling protocol, derived from the record's own data: the number
 * of readiness draws taken at each ladder level that added a single connection (null for
 * batched levels). Records taken before multi-sample readiness landed report one draw per
 * single-add level; comparing their readiness setup/percentile values against multi-sample
 * records would print misleading deltas, so the protocol is part of the comparison identity.
 */
function readinessProtocol(record: RunRecord): Array<Array<number | null> | null> {
  return ALL_SYSTEMS.map(
    (name) =>
      record.systems[name]?.workload.connections.map((level) =>
        level.addedConnections === 1 ? level.readyLatency.count : null,
      ) ?? null,
  );
}

function comparisonFingerprint(record: RunRecord): string {
  return JSON.stringify({
    machine: {
      platform: record.machine.platform,
      arch: record.machine.arch,
      cpu: record.machine.cpu,
      logicalCpus: record.machine.logicalCpus,
      memGb: record.machine.memGb,
    },
    configs: ALL_SYSTEMS.map((name) => record.systems[name]?.workload.config ?? null),
    readinessProtocol: readinessProtocol(record),
    dbzzTelemetryDisabledConfig: record.dbzzTelemetryDisabled.workload.config,
    dbzzExporterProfileConfig: record.dbzzExporterProfile.workload.config,
    dbzzModes: [
      record.systems.dbzz?.startupMode,
      record.dbzzExporterProfile.startupMode,
      record.dbzzTelemetryDisabled.startupMode,
    ],
  });
}

function latestComparable(record: RunRecord): RunRecord | undefined {
  const fingerprint = comparisonFingerprint(record);
  const candidates: RunRecord[] = [];
  let filenames: string[];
  try {
    filenames = readdirSync(RESULTS_DIR);
  } catch {
    return undefined;
  }
  for (const name of filenames) {
    if (!name.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as RunRecord;
      if (
        candidate.schemaVersion !== 6 ||
        candidate.validation.status !== "passed" ||
        candidate.performanceAcceptance.status !== "passed" ||
        !candidate.dbzzTelemetryDisabled ||
        !candidate.dbzzExporterProfile ||
        !ALL_SYSTEMS.every((system) => candidate.systems[system])
      ) {
        continue;
      }
      if (comparisonFingerprint(candidate) === fingerprint) candidates.push(candidate);
    } catch {
      // Ignore old or incomplete result files.
    }
  }
  return candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
}

function comparisonMetrics(system: MeasuredDriverResult): ComparableMetric[] {
  return extractComparableMetrics(system).map((metric) => ({
    label: metric.path,
    value: metric.value,
    lowerIsBetter: metric.direction === "lower",
  }));
}

function printComparableDelta(record: RunRecord, previous: RunRecord | undefined): void {
  if (!previous) {
    console.log("\nNo previous passing schema-v6 result has the same machine and benchmark config; delta skipped.");
    return;
  }
  console.log(`\nVs comparable run ${previous.timestamp} (⚠ = regression greater than 15%)`);
  for (const name of ALL_SYSTEMS) {
    const oldByLabel = new Map(comparisonMetrics(previous.systems[name]!).map((metric) => [metric.label, metric]));
    console.log(`\n${name}`);
    console.log("| metric | current | previous | delta |");
    console.log("|---|---:|---:|---:|");
    for (const metric of comparisonMetrics(record.systems[name]!)) {
      const old = oldByLabel.get(metric.label)!;
      const delta = old.value === 0 ? 0 : (metric.value - old.value) / old.value;
      const improvement = metric.lowerIsBetter ? -delta : delta;
      const warning = improvement < -0.15 ? " ⚠" : "";
      console.log(
        `| ${metric.label} | ${fmt(metric.value)} | ${fmt(old.value)} | ${delta >= 0 ? "+" : ""}${fmt(delta * 100, 1)}%${warning} |`,
      );
    }
  }
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
  for (const reference of first.operations) {
    const cells: string[] = [];
    for (const name of names) {
      const result = systems[name]!.workload.operations.find(
        (item) => item.operation === reference.operation && item.profile.name === reference.profile.name,
      );
      cells.push(result ? fmt(result.medianThroughputPerSec, 0) : "—", result ? fmt(result.medianLatencyP95Ms) : "—");
    }
    console.log(`| ${reference.operation}/${reference.profile.name} | ${cells.join(" | ")} |`);
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
      console.log(
        `| ${name} | ${level} | ${result ? result.connected : "—"} | ${result ? fmt(result.readyConnectionsPerSec, 0) : "—"} | ${result ? fmt(result.readyLatency.p95Ms) : "—"} | ${result ? fmt(result.work.throughputPerSec, 0) : "—"} | ${result ? fmt(result.work.latency.p95Ms) : "—"} |`,
      );
    }
  }
  console.log("\nServer resources across connection plateaus");
  console.log("| system | connections | baseline RSS MB | connected RSS MB | RSS delta MB | idle CPU cores | work RSS peak MB | work CPU cores | loadgen CPU cores |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    const baseline = resourceWindow(system, system.workload.snapshots.connectionBaselineIdlePhaseId);
    for (const result of system.workload.connections) {
      const idle = resourceWindow(system, result.connectedIdlePhaseId);
      const work = resourceWindow(system, result.work.phaseId);
      const load = resourceWindow(system, result.work.phaseId, "loadGenerator");
      console.log(
        `| ${name} | ${result.connected} | ${fmt(baseline.rssMb.p50, 1)} | ${fmt(idle.rssMb.p50, 1)} | ${fmt(idle.rssMb.p50 - baseline.rssMb.p50, 1)} | ${fmt(idle.cpuCores)} | ${fmt(work.rssMb.peak, 1)} | ${fmt(work.cpuCores)} | ${fmt(load.cpuCores)} |`,
      );
    }
  }

  console.log("\nFixed-rate subscription load");
  console.log(`| pattern | system | logical queries | setup s | updates/s | deliveries/s | delivery p95 ms | missing | base RSS MB | subscribed RSS MB | RSS delta MB | idle CPU cores | work peak RSS MB | work CPU cores | loadgen CPU cores |`);
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const name of names) {
    const system = systems[name]!;
    for (const result of system.workload.subscriptions) {
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
    for (const subscription of system.workload.subscriptions) {
      for (const capacity of subscription.capacity) {
        const resources = resourceWindow(system, capacity.phaseId);
        const load = resourceWindow(system, capacity.phaseId, "loadGenerator");
        console.log(
          `| ${subscription.pattern} | ${name} | ${capacity.slots} | ${fmt(capacity.throughputPerSec, 1)} | ${fmt(capacity.deliveryThroughputPerSec, 0)} | ${fmt(capacity.updateAckLatency.p95Ms)} | ${fmt(capacity.deliveryLatency.p95Ms)} | ${fmt(capacity.latency.p95Ms)} | ${fmt(resources.rssMb.peak, 1)} | ${fmt(resources.cpuCores)} | ${fmt(load.cpuCores)} |`,
        );
      }
    }
  }
}

const requested = process.argv.slice(2) as SystemName[];
for (const name of requested) {
  if (!ALL_SYSTEMS.includes(name)) throw new Error(`unknown system ${JSON.stringify(name)}`);
}
if (new Set(requested).size !== requested.length) throw new Error("each requested system may appear only once");
const selected = requested.length > 0 ? requested : ALL_SYSTEMS;
const comparison = process.env.BENCH_COMPARISON ?? "frozen";
if (comparison !== "frozen" && comparison !== "current") {
  throw new Error(`BENCH_COMPARISON must be frozen or current`);
}
const runPolicy = benchmarkRunPolicy(selected, benchmarkConfigFromEnv().profile, comparison);
if (selected.includes("dbzz")) {
  await runCodegen(loadConfig(join(BENCH, "dbzz-app"), {
    DBZZ_DURABILITY: "balanced",
    DBZZ_TELEMETRY: "enabled",
  }));
}
const spacetimeVersion = selected.includes("spacetimedb") ? assertSpacetimeVersionAlignment() : undefined;
const savedRuns = savedCurrentCount();
const order = requested.length > 0 ? selected : balancedOrder(savedRuns);
const executionOrder = benchmarkExecutionOrder(order, runPolicy.profiledDbzz, savedRuns);
const systems: SystemResults = {};
let dbzzTelemetryDisabled: DbzzMeasuredDriverResult | undefined;
let dbzzExporterProfile: DbzzMeasuredDriverResult | undefined;
for (let index = 0; index < executionOrder.length; index++) {
  const leg = executionOrder[index]!;
  switch (leg) {
    case "dbzz-telemetry-enabled":
      systems.dbzz = await benchDbzz("enabled");
      break;
    case "dbzz-telemetry-exporter":
      dbzzExporterProfile = await benchDbzz("exporter");
      break;
    case "dbzz-telemetry-disabled":
      dbzzTelemetryDisabled = await benchDbzz("disabled");
      break;
    case "convex":
      systems.convex = await benchConvex();
      break;
    case "spacetimedb":
      systems.spacetimedb = await benchSpacetime();
      break;
  }
  if (index < executionOrder.length - 1 && COOLDOWN_MS > 0) await Bun.sleep(COOLDOWN_MS);
}

let dbzzTelemetryCost: ProfileComparisonMetric[] | undefined;
let dbzzExporterCost: ProfileComparisonMetric[] | undefined;
const validationTargets: BenchmarkValidationTarget[] = ALL_SYSTEMS.flatMap((name) => {
  const system = systems[name];
  return system === undefined
    ? []
    : [{ label: name === "dbzz" ? "dbzz/runtime-default" : name, system: name, workload: system.workload }];
});
if (dbzzExporterProfile !== undefined) {
  validationTargets.push({
    label: "dbzz/benchmark-exporter",
    system: "dbzz",
    workload: dbzzExporterProfile.workload,
  });
}
if (dbzzTelemetryDisabled !== undefined) {
  validationTargets.push({
    label: "dbzz/disabled",
    system: "dbzz",
    workload: dbzzTelemetryDisabled.workload,
  });
}
const validation = validateBenchmarkResults(validationTargets);
let persistedOutcome: PersistedBenchmarkOutcome | undefined;

if (runPolicy.profiledDbzz) {
  if (
    systems.dbzz === undefined ||
    dbzzTelemetryDisabled === undefined ||
    dbzzExporterProfile === undefined
  ) {
    throw new Error("all-system benchmark requires default, exporter, and disabled DBZZ telemetry profiles");
  }
  dbzzTelemetryCost = compareProfileMetrics(
    "runtime-default",
    comparisonMetrics(systems.dbzz),
    "disabled",
    comparisonMetrics(dbzzTelemetryDisabled),
  );
  dbzzExporterCost = compareProfileMetrics(
    "benchmark-exporter",
    comparisonMetrics(dbzzExporterProfile),
    "runtime-default",
    comparisonMetrics(systems.dbzz),
  );
}
printResults(systems);
console.log(`\n${formatBenchmarkValidation(validation)}`);
if (dbzzTelemetryCost !== undefined) {
  printDbzzProfileCost("DBZZ default telemetry cost", dbzzTelemetryCost);
}
if (dbzzExporterCost !== undefined) {
  printDbzzProfileCost("DBZZ exporter handoff cost", dbzzExporterCost);
}
if (systems.dbzz !== undefined) {
  printDbzzTelemetryStatus([
    systems.dbzz,
    ...(dbzzExporterProfile === undefined ? [] : [dbzzExporterProfile]),
    ...(dbzzTelemetryDisabled === undefined ? [] : [dbzzTelemetryDisabled]),
  ]);
}
if (runPolicy.acceptAndSave) {
  if (
    dbzzTelemetryDisabled === undefined ||
    dbzzExporterProfile === undefined ||
    dbzzTelemetryCost === undefined ||
    dbzzExporterCost === undefined
  ) {
    throw new Error("default acceptance benchmark DBZZ profile measurements are missing");
  }
  const cliVersion = spacetimeVersion!;
  const recordWithoutAcceptance: Omit<RunRecord, "performanceAcceptance"> = {
    schemaVersion: 6,
    timestamp: new Date().toISOString(),
    git: {
      commit: git(["rev-parse", "--short", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      sourceHash: sourceHash(),
    },
    machine: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      memGb: Math.round(totalmem() / 1024 ** 3),
      osRelease: release(),
      fileDescriptorLimit: fileDescriptorLimit(),
    },
    versions: {
      bun: Bun.version,
      bunRevision: Bun.spawnSync([process.execPath, "--revision"]).stdout.toString().trim(),
      convexClient: packageVersion(join(BENCH, "convex-app", "node_modules", "convex", "package.json")),
      convexBackend: systems.convex?.implementationVersion ?? "unknown",
      spacetimedbCli: cliVersion,
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
      dbzzProfiles: "systems.dbzz omits Runtime.telemetry and measures the exact default local console sink, retention, and limits; dbzzExporterProfile adds only an explicit in-process exporter callback to that default; dbzzTelemetryDisabled passes telemetry=false; all three use durability=balanced with fresh equivalent state",
      dbzzTelemetryValidation: "the parent streams DBZZ stdout/stderr into fixed counters plus a 64 KiB diagnostic tail; enabled legs validate local record/delivery accounting, bounded queue and trace-retention state, exact exporter selection and health, the query.queue/mutation.queue/procedure.admission/subscription.queue aggregate matrix, and lower-bound consistency with workload attempts; disabled telemetry must remain entirely inactive",
      spacetimeQueryTransport: "read-only procedure with explicit transaction because the 2.6 TypeScript SDK has no public one-off query API",
      subscriptionCapacity: "closed-loop end-to-end saturation at increasing independent-writer concurrency; an update completes only after every intended client validates delivery",
    },
    executionOrder,
    systems,
    dbzzTelemetryDisabled,
    dbzzExporterProfile,
    dbzzTelemetryCost,
    dbzzExporterCost,
    validation,
  };
  const frozenBaselineJson = readFileSync(join(REPO, FROZEN_BASELINE_PATH), "utf8");
  const performanceAcceptance = evaluatePerformanceAcceptance(
    recordWithoutAcceptance,
    frozenBaselineJson,
    validation,
  );
  const record: RunRecord = { ...recordWithoutAcceptance, performanceAcceptance };
  if (performanceAcceptance.status === "passed") {
    const evidence = performanceAcceptance.evidence;
    console.log(
      `\nperformance acceptance passed: ${evidence.metricCounts.frozenDbzzSpacetimeWins} frozen SpacetimeDB wins (${evidence.metricCounts.frozenNearTieWins} near-tie), ${evidence.metricCounts.convexFloorChecks} Convex floors, ${evidence.metricCounts.afterPerSystem.dbzz} comparable metrics/system`,
    );
    console.log(`\n${nearTieDriftTable(evidence.frozenDbzzSpacetimeWins)}`);
  } else if (performanceAcceptance.status === "failed") {
    console.log(
      `\nperformance acceptance FAILED (${performanceAcceptance.failures.length} ` +
        `gate${performanceAcceptance.failures.length === 1 ? "" : "s"})`,
    );
    for (const failure of performanceAcceptance.failures) {
      console.log(`  - ${failure.path} [${failure.kind}]: ${failure.message}`);
    }
  } else {
    console.log("\nperformance acceptance not evaluated: benchmark correctness validation failed");
  }
  const previous = performanceAcceptance.status === "passed" ? latestComparable(record) : undefined;
  mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${record.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}-${record.git.commit}.json`;
  persistedOutcome = await persistBenchmarkOutcome(join(RESULTS_DIR, filename), record);
  console.log(`\nsaved bench/results/${filename}`);
  if (performanceAcceptance.status === "passed") {
    printComparableDelta(record, previous);
  } else if (performanceAcceptance.status === "failed") {
    console.log("\nComparable delta skipped because performance acceptance failed.");
  } else {
    console.log("\nComparable delta skipped because benchmark correctness validation failed.");
  }
} else {
  console.log(`\n${runPolicy.diagnosticMessage}`);
}

if (validation.status === "failed" || persistedOutcome?.status === "failed") process.exitCode = 1;
