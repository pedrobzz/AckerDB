/** Apples-to-apples local microbenchmark orchestrator. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";
import { benchmarkConfigFromEnv, type DriverResult, type SystemName } from "./benchmark.ts";
import {
  assertDbzzStartup,
  benchmarkExecutionOrder,
  compareProfileMetrics,
  expectedDbzzStartupMode,
  type BenchmarkExecutionLeg,
  type DbzzStartupMode,
  type DbzzTelemetryMode,
  type PairedProfileMetric,
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
import {
  assertPerformanceAcceptance,
  extractComparableMetrics,
  FROZEN_BASELINE_PATH,
  type PerformanceAcceptanceEvidence,
} from "./performance-gates.ts";

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
  schemaVersion: 4;
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
  dbzzTelemetryCost: PairedProfileMetric[];
  performanceAcceptance: PerformanceAcceptanceEvidence;
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

function tail(child: { stdout: ReadableStream<Uint8Array> }): { output: () => string; done: Promise<void> } {
  let buffer = "";
  const done = (async () => {
    for await (const chunk of child.stdout) buffer += new TextDecoder().decode(chunk);
  })();
  return { output: () => buffer, done };
}

async function stopDbzzServer(
  server: Subprocess,
  timeoutMs: number,
): Promise<{ exitCode: number; timedOut: boolean }> {
  if (server.exitCode === null) server.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const graceful = await Promise.race([
    server.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: number; timedOut: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ exitCode: -1, timedOut: true }), timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!graceful.timedOut) return graceful;
  if (server.exitCode === null) server.kill("SIGKILL");
  return { exitCode: await server.exited, timedOut: true };
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
  const output = Bun.spawnSync(["ps", "-eo", "pid,command"]).stdout.toString();
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
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
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
  sampleResources();
  const resourceTimer = setInterval(() => {
    try {
      sampleResources();
    } catch {
      clearInterval(resourceTimer);
    }
  }, RESOURCE_SAMPLE_MS);
  try {
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
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
    if (exitCode !== 0) throw new Error(`benchmark client failed with exit code ${exitCode}`);
    if (!workload) throw new Error(`benchmark client produced no result`);
  } finally {
    try {
      sampleResources();
    } catch {
      // The stored sampler failure is rethrown below.
    }
    clearInterval(resourceTimer);
  }

  if (resourceFailure) throw resourceFailure;

  const serverPhases: Record<string, ProcessTreeWindowSummary> = {};
  const loadPhases: Record<string, ProcessTreeWindowSummary> = {};
  for (const [id, bounds] of phaseBounds) {
    if (bounds.endMs - bounds.startMs < RESOURCE_SAMPLE_MS) continue;
    serverPhases[id] = serverMonitor.summarize(bounds.startMs, bounds.endMs);
    loadPhases[id] = loadMonitor.summarize(bounds.startMs, bounds.endMs);
  }
  return {
    workload,
    resources: {
      server: { snapshots: serverSnapshots, phases: serverPhases },
      loadGenerator: { snapshots: loadSnapshots, phases: loadPhases },
    },
  };
}

async function benchDbzz(telemetry: DbzzTelemetryMode): Promise<DbzzMeasuredDriverResult> {
  const expectedMode = expectedDbzzStartupMode(telemetry, "balanced");
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
        DBZZ_DURABILITY: "balanced",
        DBZZ_BENCH_TELEMETRY_REPORT: reportPath,
      },
    },
  );
  const output = new DbzzOutputCollector();
  const outputDone = Promise.all([
    (async () => {
      for await (const chunk of server.stdout) output.writeStdout(chunk);
    })(),
    (async () => {
      for await (const chunk of server.stderr) output.writeStderr(chunk);
    })(),
  ]).then(() => output.finish());
  let startupMode: DbzzStartupMode | undefined;
  let startupIdle: MeasuredDriverResult["startupIdle"] | undefined;
  let measured: Omit<MeasuredDriverResult, "startupIdle" | "implementationVersion"> | undefined;
  let workloadError: unknown;
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
    workloadError = error;
  }
  try {
    const stopped = await stopDbzzServer(
      server,
      expectedMode.gracefulShutdownMs + DBZZ_SHUTDOWN_SLACK_MS,
    );
    await outputDone;
    if (stopped.timedOut) {
      throw new Error(
        `dbzz benchmark server exceeded its ${expectedMode.gracefulShutdownMs}ms graceful shutdown deadline`,
      );
    }
    if (workloadError !== undefined) throw workloadError;
    if (stopped.exitCode !== 0) {
      throw new Error(`dbzz benchmark server failed with exit code ${stopped.exitCode}:\n${output.output()}`);
    }
    if (startupMode === undefined || startupIdle === undefined || measured === undefined) {
      throw new Error("dbzz benchmark server did not complete its measured workload");
    }
    const telemetryReport = parseDbzzTelemetryReport(
      readFileSync(reportPath, "utf8"),
      startupMode,
      output.snapshot(),
    );
    assertDbzzTelemetryWorkload(telemetryReport, measured.workload);
    return { ...measured, startupIdle, implementationVersion: "workspace", startupMode, telemetryReport };
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await server.exited;
    }
    await outputDone.catch(() => {});
    output.finish();
    rmSync(reportPath, { force: true });
    assertPortFree(DBZZ_PORT);
  }
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
  const result = Bun.spawnSync(["zsh", "-c", "ulimit -n"], { stdout: "pipe" });
  return Number(result.stdout.toString().trim());
}

function savedCurrentCount(): number {
  try {
    return readdirSync(RESULTS_DIR).filter((name) => {
      if (!name.endsWith(".json")) return false;
      try {
        return (JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as { schemaVersion?: number }).schemaVersion === 4;
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
    dbzzTelemetryDisabledConfig: record.dbzzTelemetryDisabled.workload.config,
    dbzzModes: [record.systems.dbzz?.startupMode, record.dbzzTelemetryDisabled.startupMode],
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
        candidate.schemaVersion !== 4 ||
        !candidate.dbzzTelemetryDisabled ||
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
    console.log("\nNo previous schema-v4 result has the same machine and benchmark config; delta skipped.");
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

function printDbzzTelemetryCost(metrics: PairedProfileMetric[]): void {
  console.log("\nDBZZ telemetry enabled vs disabled (positive delta means enabled measured higher)");
  console.log("| metric | enabled | disabled | enabled vs disabled |");
  console.log("|---|---:|---:|---:|");
  for (const metric of metrics) {
    const delta = metric.enabledVsDisabledPercent;
    console.log(
      `| ${metric.label} | ${fmt(metric.enabled)} | ${fmt(metric.disabled)} | ${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${fmt(delta, 1)}%`} |`,
    );
  }
}

function printDbzzTelemetryStatus(results: readonly DbzzMeasuredDriverResult[]): void {
  console.log("\nDBZZ default-local telemetry validation and bounded retention status");
  console.log(
    "| profile | local records | serialized MB | retained before drain | drain drops | overflow drops | query queue | mutation queue | procedure admission | subscription queue | trace promoted/discarded | exporter configured |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const result of results) {
    const report = result.telemetryReport;
    const operations = report.aggregates.operations;
    const trace = report.runtime.afterDrain.traceRetention;
    console.log(
      `| ${report.startupMode.telemetryProfile} | ${report.localOutput.records} | ${fmt(report.localOutput.bytes / 1024 ** 2)} | ${report.drainAccounting.retainedBeforeDrain} | ${report.drainAccounting.drainDropDelta} | ${report.runtime.afterDrain.dropped.overflow} | ${operations.query.stages.queue.count} | ${operations.mutation.stages.queue.count} | ${operations.procedure.stages.admission.count} | ${operations.subscription.stages.queue.count} | ${trace.promotedTraces}/${trace.discardedTraces} | ${report.runtime.afterDrain.exporter.configured ? "yes" : "no"} |`,
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
  for (const name of names) {
    for (const result of systems[name]!.workload.operations) {
      const invalid = result.trials.filter((trial) => !trial.correctness.ok);
      if (invalid.length > 0) {
        console.log(
          `  INVALID ${name} ${result.operation}/${result.profile.name}: ${invalid.flatMap((trial) => trial.correctness.errors).join("; ")}`,
        );
      }
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
      console.log(
        `| ${name} | ${level} | ${result ? result.connected : "—"} | ${result ? fmt(result.readyConnectionsPerSec, 0) : "—"} | ${result ? fmt(result.readyLatency.p95Ms) : "—"} | ${result ? fmt(result.work.throughputPerSec, 0) : "—"} | ${result ? fmt(result.work.latency.p95Ms) : "—"} |`,
      );
    }
  }
  for (const name of names) {
    for (const result of systems[name]!.workload.connections) {
      if (result.work.failed > 0 || result.errors.length > 0) {
        console.log(
          `  INVALID ${name} connections/${result.targetConnections}: ${[...result.errors, ...result.work.errors].join("; ")}`,
        );
      }
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
      if (!result.correctness.ok) {
        console.log(`  INVALID ${name} subscriptions/${result.pattern}: ${result.correctness.errors.join("; ")}`);
      }
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
        if (!capacity.correctness.ok) {
          console.log(`  INVALID ${name} subscriptions/${subscription.pattern}/capacity-${capacity.slots}: ${capacity.correctness.errors.join("; ")}`);
        }
      }
    }
  }
}

function assertValidResults(
  systems: Partial<Record<SystemName, MeasuredDriverResult>>,
  expectedWorkload?: DriverResult,
): void {
  const errors: string[] = [];
  const entries = Object.entries(systems) as Array<[SystemName, MeasuredDriverResult]>;
  const reference = expectedWorkload ?? entries[0]?.[1].workload;
  const referenceConfig = reference ? JSON.stringify(reference.config) : "";
  const operationShape = reference?.operations.map((item) => `${item.operation}/${item.profile.name}`).join(",");
  const connectionShape = reference?.connections.map((item) => item.targetConnections).join(",");
  const subscriptionShape = reference?.subscriptions
    .map((item) => `${item.pattern}:${item.capacity.map((capacity) => capacity.slots).join("/")}`)
    .join(",");
  for (const [name, system] of entries) {
    if (system.workload.system !== name) errors.push(`${name}: workload identified itself as ${system.workload.system}`);
    if (JSON.stringify(system.workload.config) !== referenceConfig) errors.push(`${name}: workload config differs`);
    if (system.workload.operations.map((item) => `${item.operation}/${item.profile.name}`).join(",") !== operationShape) {
      errors.push(`${name}: operation case shape differs`);
    }
    if (system.workload.connections.map((item) => item.targetConnections).join(",") !== connectionShape) {
      errors.push(`${name}: connection ladder differs`);
    }
    if (
      system.workload.subscriptions
        .map((item) => `${item.pattern}:${item.capacity.map((capacity) => capacity.slots).join("/")}`)
        .join(",") !== subscriptionShape
    ) {
      errors.push(`${name}: subscription case shape differs`);
    }
    for (const operation of system.workload.operations) {
      for (const trial of operation.trials) {
        if (!trial.correctness.ok) {
          errors.push(`${name} ${operation.operation}/${operation.profile.name}: ${trial.correctness.errors.join("; ")}`);
        }
        if (trial.attempted !== trial.completedInWindow + trial.completedAfterWindow + trial.failed) {
          errors.push(`${name} ${operation.operation}/${operation.profile.name}: request accounting mismatch`);
        }
      }
    }
    for (const level of system.workload.connections) {
      if (level.connected !== level.targetConnections) {
        errors.push(`${name} connections/${level.targetConnections}: connected ${level.connected}`);
      }
      if (level.errors.length > 0 || level.work.failed > 0) {
        errors.push(`${name} connections/${level.targetConnections}: ${[...level.errors, ...level.work.errors].join("; ")}`);
      }
    }
    for (const subscription of system.workload.subscriptions) {
      if (!subscription.correctness.ok) {
        errors.push(`${name} subscriptions/${subscription.pattern}: ${subscription.correctness.errors.join("; ")}`);
      }
      for (const capacity of subscription.capacity) {
        if (!capacity.correctness.ok) {
          errors.push(
            `${name} subscriptions/${subscription.pattern}/capacity-${capacity.slots}: ${capacity.correctness.errors.join("; ")}`,
          );
        }
        if (capacity.attempted !== capacity.completedInWindow + capacity.completedAfterWindow + capacity.failed) {
          errors.push(`${name} subscriptions/${subscription.pattern}/capacity-${capacity.slots}: request accounting mismatch`);
        }
      }
    }
  }
  if (errors.length > 0) throw new Error(`benchmark produced invalid results:\n${errors.join("\n")}`);
}

const requested = process.argv.slice(2) as SystemName[];
for (const name of requested) {
  if (!ALL_SYSTEMS.includes(name)) throw new Error(`unknown system ${JSON.stringify(name)}`);
}
if (new Set(requested).size !== requested.length) throw new Error("each requested system may appear only once");
const selected = requested.length > 0 ? requested : ALL_SYSTEMS;
const fullRun = ALL_SYSTEMS.every((name) => selected.includes(name)) && selected.length === ALL_SYSTEMS.length;
const savedRuns = savedCurrentCount();
const order = requested.length > 0 ? selected : balancedOrder(savedRuns);
const executionOrder = benchmarkExecutionOrder(order, fullRun, savedRuns);
const systems: SystemResults = {};
let dbzzTelemetryDisabled: DbzzMeasuredDriverResult | undefined;
for (let index = 0; index < executionOrder.length; index++) {
  const leg = executionOrder[index]!;
  switch (leg) {
    case "dbzz-telemetry-enabled":
      systems.dbzz = await benchDbzz("enabled");
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

assertValidResults(systems);
let dbzzTelemetryCost: PairedProfileMetric[] | undefined;
if (fullRun) {
  if (systems.dbzz === undefined || dbzzTelemetryDisabled === undefined) {
    throw new Error("full benchmark requires telemetry-enabled and telemetry-disabled DBZZ profiles");
  }
  assertValidResults({ dbzz: dbzzTelemetryDisabled }, systems.dbzz.workload);
  dbzzTelemetryCost = compareProfileMetrics(
    comparisonMetrics(systems.dbzz),
    comparisonMetrics(dbzzTelemetryDisabled),
  );
}
printResults(systems);
if (dbzzTelemetryCost !== undefined) printDbzzTelemetryCost(dbzzTelemetryCost);
if (systems.dbzz !== undefined) {
  printDbzzTelemetryStatus(
    dbzzTelemetryDisabled === undefined ? [systems.dbzz] : [systems.dbzz, dbzzTelemetryDisabled],
  );
}
if (fullRun) {
  if (dbzzTelemetryDisabled === undefined || dbzzTelemetryCost === undefined) {
    throw new Error("full benchmark DBZZ profile comparison is missing");
  }
  const cliVersion = assertSpacetimeVersionAlignment();
  const recordWithoutAcceptance: Omit<RunRecord, "performanceAcceptance"> = {
    schemaVersion: 4,
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
      dbzzProfiles: "systems.dbzz omits Runtime.telemetry and therefore measures the exact default local console sink, retention, and limits; dbzzTelemetryDisabled passes telemetry=false; neither profile configures an exporter and both use durability=balanced with fresh equivalent state",
      dbzzTelemetryValidation: "the parent streams DBZZ stdout/stderr into fixed counters plus a 64 KiB diagnostic tail; every saved leg validates local record/delivery accounting, bounded queue and trace-retention state, exporter absence, the query.queue/mutation.queue/procedure.admission/subscription.queue aggregate matrix, and lower-bound consistency with workload attempts; disabled telemetry must remain entirely inactive",
      spacetimeQueryTransport: "read-only procedure with explicit transaction because the 2.6 TypeScript SDK has no public one-off query API",
      subscriptionCapacity: "closed-loop end-to-end saturation at increasing independent-writer concurrency; an update completes only after every intended client validates delivery",
    },
    executionOrder,
    systems,
    dbzzTelemetryDisabled,
    dbzzTelemetryCost,
  };
  const frozenBaselineJson = readFileSync(join(REPO, FROZEN_BASELINE_PATH), "utf8");
  const performanceAcceptance = assertPerformanceAcceptance(recordWithoutAcceptance, frozenBaselineJson);
  const record: RunRecord = { ...recordWithoutAcceptance, performanceAcceptance };
  console.log(
    `\nperformance acceptance passed: ${performanceAcceptance.metricCounts.frozenDbzzSpacetimeWins} frozen SpacetimeDB wins, ${performanceAcceptance.metricCounts.convexFloorChecks} Convex floors, ${performanceAcceptance.metricCounts.afterPerSystem.dbzz} comparable metrics/system`,
  );
  const previous = latestComparable(record);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${record.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}-${record.git.commit}.json`;
  await Bun.write(join(RESULTS_DIR, filename), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nsaved bench/results/${filename}`);
  printComparableDelta(record, previous);
} else {
  console.log("\npartial run: result not saved");
}
