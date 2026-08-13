import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  Engine,
  Registry,
  Runtime,
  reconcile,
  serve,
  type AckerDBServer,
  type EngineCloseDisposition,
} from "@ackerdb/server";
import { importApp, importFunctionModules } from "../packages/cli/src/app/manifest.ts";
import { loadConfig } from "../packages/cli/src/app/config.ts";
import { expectedAckerDBStartupMode } from "./ackerdb-profile.ts";

const appDir = process.argv[2];
if (appDir === undefined) throw new Error("ackerdb benchmark server requires an app directory");

const port = Number(process.env.ACKERDB_BENCH_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("ACKERDB_BENCH_PORT must be an integer from 1 through 65535");
}

const config = loadConfig(appDir);
const startupMode = expectedAckerDBStartupMode(config.durability);
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
  runtime = new Runtime({ engine, registry });
  server = serve({ runtime, port, statusScope: config.statusScope });
  console.log(`@@ackerdb-startup ${JSON.stringify(startupMode)}`);
  console.log(
    `[ackerdb] ready on http://127.0.0.1:${server.port} — ${registry.functions.size} function(s), ` +
      `${Object.keys(schema.tables).length} table(s), db at ${relative(process.cwd(), config.dbDir) || "."}`,
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

let drainError: unknown;
let drainFailed = false;
try {
  await server.drain();
} catch (error) {
  drainFailed = true;
  drainError = error;
} finally {
  engine.close(drainFailed ? "unclean" : "clean");
}
if (drainFailed) throw drainError;
