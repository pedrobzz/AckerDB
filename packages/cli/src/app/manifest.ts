/** Application manifest and host function-module loading. */
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isApp, type App } from "@ackerdb/server";
import type { AppConfig } from "./config.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface ModuleFile {
  /** Dot-joined module key: functions/admin/users.ts -> "admin.users". */
  key: string;
  segments: string[];
  file: string;
}

/** Deterministically list one module directory's files (sorted by key). */
function listModules(dir: string, kind: string): ModuleFile[] {
  if (!existsSync(dir)) return [];
  const out: ModuleFile[] = [];
  const entries = readdirSync(dir, { recursive: true }) as string[];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    const segments = entry.slice(0, -".ts".length).split(sep);
    if (segments.some((segment) =>
      segment.startsWith("_") || segment.startsWith(".") || !IDENTIFIER.test(segment)
    )) {
      throw new Error(
        `${kind} module "${entry}": path segments become names and must be identifiers (got "${segments.join("/")}")`,
      );
    }
    out.push({ key: segments.join("."), segments, file: join(dir, entry) });
  }
  return out;
}

/** Deterministically list function module files (sorted by key). */
export function listFunctionModules(config: AppConfig): ModuleFile[] {
  return listModules(config.functionsDir, "function");
}

/** Deterministically list application service module files (sorted by key). */
export function listServiceModules(config: AppConfig): ModuleFile[] {
  return listModules(config.servicesDir, "service");
}

/** Deterministically list job module files (sorted by key). */
export function listJobModules(config: AppConfig): ModuleFile[] {
  return listModules(config.jobsDir, "job");
}

export async function importApp(config: AppConfig): Promise<App> {
  if (!existsSync(config.appPath)) {
    throw new Error(`application manifest not found at ${config.appPath}`);
  }
  const module = (await import(pathToFileURL(config.appPath).href)) as { default?: unknown };
  if (!isApp(module.default)) {
    throw new Error(`${config.appPath} must default-export defineApp(...)`);
  }
  return module.default;
}

async function importModules(
  files: readonly ModuleFile[],
): Promise<Record<string, Record<string, unknown>>> {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const { key, file } of files) {
    modules[key] = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
  return modules;
}

export async function importFunctionModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  return importModules(listFunctionModules(config));
}

/**
 * Import service modules. Only the serving path calls this: manifest
 * inspection, code generation, and migration tooling never do, which is what
 * keeps a broker connection out of `acker codegen`.
 */
export async function importServiceModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  return importModules(listServiceModules(config));
}

/**
 * Import job modules. The serving path and dev reloads call this; codegen
 * only lists files, so job handler imports stay out of schema tooling.
 */
export async function importJobModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  return importModules(listJobModules(config));
}
