/** Application manifest and host function-module loading. */
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isApp, type App } from "@ackerdb/server";
import type { AppConfig } from "./config.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * The file name that takes its directory's name instead of its own, so
 * `functions/orders/index.ts` publishes `orders.*` rather than
 * `orders.index.*`. It is the one name a module file cannot keep, which is why
 * two files can now claim one module key and why the two refusals below exist.
 */
const INDEX_MODULE = "index";

export interface ModuleFile {
  /** Dot-joined module key: functions/admin/users.ts -> "admin.users". */
  key: string;
  segments: string[];
  file: string;
}

/** Deterministically list one module directory's files (sorted by key). */
function listModules(dir: string, kind: string): ModuleFile[] {
  if (!existsSync(dir)) return [];
  const claimed = new Map<string, string>();
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
    if (segments[segments.length - 1] === INDEX_MODULE) {
      segments.pop();
      // At the root there is no directory to take a name from, and the
      // alternative — publishing exports directly below `api` — is a module
      // with no name at all, which neither the tree nor an address can hold.
      // Refusing it keeps the collapse one rule with no exception.
      if (segments.length === 0) {
        throw new Error(
          `${kind} module "${entry}": an "${INDEX_MODULE}" file takes its directory's name, and this one has no directory — move it into one or give it a name`,
        );
      }
    }
    const key = segments.join(".");
    // One address, one file. The collapse is what makes this reachable —
    // `orders.ts` and `orders/index.ts` both publish `orders` — and it would
    // otherwise be settled silently by whichever the walk reached second.
    const owner = claimed.get(key);
    if (owner !== undefined) {
      throw new Error(
        `${kind} modules "${owner}" and "${entry}" both publish "${key}": an "${INDEX_MODULE}" file takes its directory's name, so one of them must be renamed`,
      );
    }
    claimed.set(key, entry);
    out.push({ key, segments, file: join(dir, entry) });
  }
  // Sorted by key rather than by path, because the collapse reorders them:
  // `orders/list.ts` walks before `orders/index.ts` and publishes after it.
  return out.sort((left, right) => left.key.localeCompare(right.key));
}

/** Deterministically list function module files (sorted by key). */
export function listFunctionModules(config: AppConfig): ModuleFile[] {
  return listModules(config.functionsDir, "function");
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

/** Import one serving-only configured module while preserving its owner in failures. */
export async function importConfiguredDefault(
  path: string,
  owner: string,
): Promise<unknown> {
  if (!existsSync(path)) throw new Error(`${owner} not found at ${path}`);
  try {
    return ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`failed to import ${owner} at ${path}${detail}`, { cause: error });
  }
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
 * Import job modules. The serving path and dev reloads call this; codegen
 * only lists files, so job handler imports stay out of schema tooling.
 */
export async function importJobModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  return importModules(listJobModules(config));
}
