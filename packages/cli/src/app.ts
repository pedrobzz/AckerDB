/**
 * Loading a dbzz app: the schema module, the function modules, and the
 * assembled server (engine + reconcile + runtime + transport).
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Engine,
  Registry,
  Runtime,
  reconcile,
  Schema,
  serve,
  UnsafeSchemaChange,
} from "@dbzz/server";
import type { AppConfig } from "./config.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface FunctionModuleFile {
  /** Dot-joined module key: functions/admin/users.ts -> "admin.users". */
  key: string;
  segments: string[];
  file: string;
}

/** Deterministically list function module files (sorted by key). */
export function listFunctionModules(config: AppConfig): FunctionModuleFile[] {
  if (!existsSync(config.functionsDir)) return [];
  const out: FunctionModuleFile[] = [];
  const entries = readdirSync(config.functionsDir, { recursive: true }) as string[];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    const segments = entry.slice(0, -".ts".length).split(sep);
    if (segments.some((s) => s.startsWith("_") || s.startsWith(".") || !IDENTIFIER.test(s))) {
      throw new Error(
        `function module "${entry}": path segments become API namespaces and must be identifiers (got "${segments.join("/")}")`,
      );
    }
    out.push({ key: segments.join("."), segments, file: join(config.functionsDir, entry) });
  }
  return out;
}

export async function importSchema(config: AppConfig): Promise<Schema> {
  if (!existsSync(config.schemaPath)) {
    throw new Error(`schema not found at ${config.schemaPath}`);
  }
  const module = (await import(pathToFileURL(config.schemaPath).href)) as { default?: unknown };
  if (!(module.default instanceof Schema)) {
    throw new Error(`${config.schemaPath} must default-export defineSchema(...)`);
  }
  return module.default;
}

export async function importFunctionModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const { key, file } of listFunctionModules(config)) {
    modules[key] = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
  return modules;
}

export interface RunningApp {
  server: ReturnType<typeof serve>;
  runtime: Runtime;
  engine: Engine;
}

export async function startApp(config: AppConfig): Promise<RunningApp> {
  const schema = await importSchema(config);
  const modules = await importFunctionModules(config);
  mkdirSync(config.dbDir, { recursive: true });
  const engine = new Engine(schema, join(config.dbDir, "data.db"));
  try {
    const { applied } = reconcile(engine);
    for (const line of applied) console.log(`[dbz] ${line}`);
  } catch (error) {
    if (error instanceof UnsafeSchemaChange) {
      console.error(`[dbz] ${error.message}`);
      engine.close();
      process.exit(1);
    }
    throw error;
  }
  const registry = new Registry(modules);
  const runtime = new Runtime({ engine, registry });
  const server = serve({ runtime, port: config.port });
  console.log(
    `[dbz] ready on http://127.0.0.1:${server.port} — ${registry.functions.size} function(s), ${Object.keys(schema.tables).length} table(s), db at ${relative(process.cwd(), config.dbDir) || "."}`,
  );
  return { server, runtime, engine };
}
