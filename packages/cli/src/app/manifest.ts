/** Application manifest and host function-module loading. */
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isApp, type App } from "@ackerdb/server";
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
    if (segments.some((segment) =>
      segment.startsWith("_") || segment.startsWith(".") || !IDENTIFIER.test(segment)
    )) {
      throw new Error(
        `function module "${entry}": path segments become API namespaces and must be identifiers (got "${segments.join("/")}")`,
      );
    }
    out.push({ key: segments.join("."), segments, file: join(config.functionsDir, entry) });
  }
  return out;
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

export async function importFunctionModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const { key, file } of listFunctionModules(config)) {
    modules[key] = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
  return modules;
}
