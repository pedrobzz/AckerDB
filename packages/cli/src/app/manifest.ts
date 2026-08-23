/** Application entrypoint and definition-module discovery. */
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  extname,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  isApp,
  type App,
  type ImportedDefinitionModule,
} from "@ackerdb/server";
import type { AppConfig } from "./config.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const INDEX_MODULE = "index";

export interface ModuleFile {
  /** Dot-joined logical module name. */
  readonly key: string;
  readonly segments: readonly string[];
  readonly file: string;
}

function moduleSegments(entry: string, directoryRoot: boolean): string[] {
  const segments = entry.slice(0, -".ts".length).split(sep);
  if (segments.some((segment) =>
    segment.startsWith("_") || segment.startsWith(".") || !IDENTIFIER.test(segment)
  )) {
    throw new Error(
      `definition module "${entry}": path segments become names and must be identifiers (got "${segments.join("/")}")`,
    );
  }
  if (directoryRoot && segments.at(-1) === INDEX_MODULE) {
    segments.pop();
    if (segments.length === 0) {
      throw new Error(
        `definition module "${entry}": an "${INDEX_MODULE}" file takes its directory's name, and this one has no directory — move it into one or configure the file directly`,
      );
    }
  }
  return segments;
}

/** Deterministically list every configured definition file in one namespace. */
export function listDefinitionModules(config: AppConfig): ModuleFile[] {
  const entrypoint = normalize(resolve(config.entrypoint));
  const entrypointPhysical = existsSync(entrypoint) ? realpathSync(entrypoint) : entrypoint;
  const claimedFiles = new Map<string, string>();
  const claimedModules = new Map<string, string>();
  const modules: ModuleFile[] = [];

  const contribute = (
    file: string,
    entry: string,
    directoryRoot: boolean,
    rootOrigin: string,
  ): void => {
    const resolved = normalize(resolve(file));
    const physical = realpathSync(resolved);
    if (resolved === entrypoint || physical === entrypointPhysical) {
      throw new Error(
        `application entrypoint "${config.entrypoint}" is also discovered as definition module "${resolved}"`,
      );
    }
    const fileOwner = claimedFiles.get(physical);
    if (fileOwner !== undefined) {
      throw new Error(
        `definition file "${physical}" is discovered through both ${fileOwner} and ${rootOrigin}`,
      );
    }
    const segments = moduleSegments(entry, directoryRoot);
    const key = segments.join(".");
    const moduleOwner = claimedModules.get(key);
    if (moduleOwner !== undefined) {
      throw new Error(
        `definition modules "${moduleOwner}" and "${resolved}" both publish "${key}"`,
      );
    }
    claimedFiles.set(physical, rootOrigin);
    claimedModules.set(key, resolved);
    modules.push({ key, segments, file: resolved });
  };

  for (const [index, root] of config.definitions.entries()) {
    const rootOrigin = `definitions[${index}] "${root}"`;
    if (!existsSync(root)) continue;
    const stats = statSync(root);
    if (stats.isFile()) {
      if (extname(root) !== ".ts" || root.endsWith(".d.ts")) {
        throw new Error(`definition entry "${root}" must be a directory or TypeScript file`);
      }
      contribute(root, basename(root), false, rootOrigin);
      continue;
    }
    if (!stats.isDirectory()) {
      throw new Error(`definition entry "${root}" must be a directory or TypeScript file`);
    }
    for (const entry of (readdirSync(root, { recursive: true }) as string[]).sort()) {
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
      contribute(join(root, entry), entry, true, rootOrigin);
    }
  }
  return modules.sort((left, right) => left.key.localeCompare(right.key));
}

export async function importEntrypoint(config: AppConfig): Promise<App> {
  if (!existsSync(config.entrypoint)) {
    throw new Error(`application entrypoint not found at ${config.entrypoint}`);
  }
  const module = (await import(pathToFileURL(config.entrypoint).href)) as { default?: unknown };
  if (!isApp(module.default)) {
    throw new Error(`${config.entrypoint} must default-export defineApp(...)`);
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

export async function importDefinitionModules(
  config: AppConfig,
): Promise<readonly ImportedDefinitionModule[]> {
  const modules: ImportedDefinitionModule[] = [];
  for (const { key, file } of listDefinitionModules(config)) {
    modules.push(Object.freeze({
      name: key,
      origin: file,
      exports: (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    }));
  }
  return Object.freeze(modules);
}
