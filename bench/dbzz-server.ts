import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  Engine,
  Registry,
  Runtime,
  reconcile,
  serve,
  type DbzzServer,
} from "@dbzz/server";
import { importFunctionModules, importSchema } from "../packages/cli/src/app.ts";
import { loadConfig } from "../packages/cli/src/config.ts";
import { expectedDbzzStartupMode } from "./dbzz-profile.ts";
import { createDbzzTelemetryReport } from "./dbzz-telemetry.ts";

const appDir = process.argv[2];
if (appDir === undefined) throw new Error("dbzz benchmark server requires an app directory");
const reportPath = process.env.DBZZ_BENCH_TELEMETRY_REPORT;
if (reportPath === undefined || !isAbsolute(reportPath)) {
  throw new Error("DBZZ_BENCH_TELEMETRY_REPORT must be an absolute path");
}

const config = loadConfig(appDir);
const startupMode = expectedDbzzStartupMode(config.telemetry, config.durability);
const schema = await importSchema(config);
const modules = await importFunctionModules(config);
mkdirSync(config.dbDir, { recursive: true });
const engine = new Engine(schema, join(config.dbDir, "data.db"), { durability: config.durability });
let runtime: Runtime | undefined;
let server: DbzzServer | undefined;

try {
  const { applied } = reconcile(engine);
  for (const line of applied) console.log(`[dbz] ${line}`);
  const registry = new Registry(modules);
  runtime = new Runtime({
    engine,
    registry,
    ...(config.telemetry === "disabled" ? { telemetry: false } : {}),
  });
  server = serve({ runtime, port: config.port, statusScope: config.statusScope });
  console.log(`@@dbzz-startup ${JSON.stringify(startupMode)}`);
  console.log(
    `[dbz] ready on http://127.0.0.1:${server.port} — ${registry.functions.size} function(s), ${Object.keys(schema.tables).length} table(s), db at ${relative(process.cwd(), config.dbDir) || "."}`,
  );
} catch (error) {
  if (server === undefined) await runtime?.drain().catch(() => {});
  else await server.drain().catch(() => {});
  engine.close();
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
try {
  await server.drain();
} catch (error) {
  drainError = error;
}
const report = createDbzzTelemetryReport(
  startupMode,
  beforeDrain,
  runtime.status().telemetry,
  runtime.telemetry.aggregateSnapshot(),
);
try {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} finally {
  engine.close();
}
if (drainError !== undefined) throw drainError;
