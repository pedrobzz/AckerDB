import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  Engine,
  Registry,
  Runtime,
  reconcile,
  serve,
  type AckerDBServer,
  type EngineCloseDisposition,
  type TelemetryAggregateSnapshot,
  type TelemetryExporter,
  type TelemetryRecord,
} from "@ackerdb/server";
import { importApp, importFunctionModules } from "../packages/cli/src/app/manifest.ts";
import { loadConfig } from "../packages/cli/src/app/config.ts";
import {
  benchmarkProfileFromConfig,
  expectedAckerDBStartupMode,
} from "./ackerdb-profile.ts";
import { createAckerDBTelemetryReport } from "./ackerdb-telemetry.ts";

let exportedAggregateSnapshot: TelemetryAggregateSnapshot | undefined;
const BENCHMARK_EXPORTER: TelemetryExporter = Object.freeze({
  // Promise-based like a production exporter so the zero-drop gate exercises
  // the asynchronous export path rather than a synchronous special case; it
  // still resolves immediately so the leg measures only AckerDB's handoff cost.
  export(
    _records: readonly TelemetryRecord[],
    aggregates?: TelemetryAggregateSnapshot,
  ): Promise<void> {
    if (aggregates !== undefined) exportedAggregateSnapshot = aggregates;
    return Promise.resolve();
  },
});

const appDir = process.argv[2];
if (appDir === undefined) throw new Error("ackerdb benchmark server requires an app directory");
const reportPath = process.env.ACKERDB_BENCH_TELEMETRY_REPORT;
if (reportPath === undefined || !isAbsolute(reportPath)) {
  throw new Error("ACKERDB_BENCH_TELEMETRY_REPORT must be an absolute path");
}

const config = loadConfig(appDir);
const exporterMode = process.env.ACKERDB_BENCH_EXPORTER;
if (exporterMode !== "disabled" && exporterMode !== "in-process") {
  throw new Error("ACKERDB_BENCH_EXPORTER must be disabled or in-process");
}
const profile = benchmarkProfileFromConfig(
  config.telemetry,
  exporterMode,
);
const startupMode = expectedAckerDBStartupMode(profile, config.durability);
const schema = (await importApp(config)).schema;
const modules = await importFunctionModules(config);
mkdirSync(config.dbDir, { recursive: true });
const engine = new Engine(schema, join(config.dbDir, "data.db"), { durability: config.durability });
let runtime: Runtime | undefined;
let server: AckerDBServer | undefined;

try {
  const { applied } = reconcile(engine);
  for (const line of applied) console.log(`[ackerdb] ${line}`);
  const registry = new Registry(modules);
  runtime = new Runtime({
    engine,
    registry,
    ...(profile === "disabled"
      ? { telemetry: false }
      : profile === "exporter"
        ? { telemetry: { exporter: BENCHMARK_EXPORTER } }
        : {}),
  });
  server = serve({ runtime, port: config.port, statusScope: config.statusScope });
  console.log(`@@ackerdb-startup ${JSON.stringify(startupMode)}`);
  console.log(
    `[ackerdb] ready on http://127.0.0.1:${server.port} — ${registry.functions.size} function(s), ${Object.keys(schema.tables).length} table(s), db at ${relative(process.cwd(), config.dbDir) || "."}`,
  );
} catch (error) {
  let shutdown: EngineCloseDisposition = "unclean";
  try {
    if (server === undefined) await runtime?.drain();
    else await server.drain();
    shutdown = "clean";
  } catch {}
  engine.close(shutdown);
  throw error;
}

await new Promise<void>((resolve) => {
  const finish = () => {
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    resolve();
  };
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
});

const beforeDrain = runtime.status().telemetry;
let drainError: unknown;
let drainFailed = false;
try {
  await server.drain();
} catch (error) {
  drainFailed = true;
  drainError = error;
}
const aggregateSnapshot = runtime.telemetry.aggregateSnapshot();
if (
  profile === "exporter" &&
  JSON.stringify(exportedAggregateSnapshot) !== JSON.stringify(aggregateSnapshot)
) {
  throw new Error("benchmark exporter did not receive the terminal cumulative aggregate snapshot");
}
const report = createAckerDBTelemetryReport(
  startupMode,
  beforeDrain,
  runtime.status().telemetry,
  aggregateSnapshot,
);
try {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} finally {
  engine.close(drainFailed ? "unclean" : "clean");
}
if (drainFailed) throw drainError;
