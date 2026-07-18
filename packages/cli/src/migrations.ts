/**
 * Migration chain loading: discover `<appDir>/migrations`, validate every file
 * against its `meta/` sidecar, and assemble the ordered `MigrationStep[]` the
 * server applies at startup. Every violation is a clean, file-named error
 * raised BEFORE the engine opens.
 *
 * On-disk convention (fixed by the design; this module reads exactly it):
 *
 *   <appDir>/migrations/
 *     0001_add_count.ts        default-exports defineMigration({...})
 *     meta/
 *       0001_add_count.json    { number, name, fingerprint, pre, target }
 *
 * The recorded target fingerprint is recomputed here, so an edited target
 * snapshot is caught at load time — before the database-level immutability
 * check ever runs. The directory is optional: absent or empty yields an empty
 * chain, and startApp still calls the chain form of reconcile with it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineMigration,
  migrationFingerprint,
  validateChain,
  type Migration,
  type MigrationStep,
  type SchemaSnapshot,
} from "@dbzz/server";
import type { AppConfig } from "./config.ts";

const MIGRATION_FILE = /^(\d{4})_([A-Za-z0-9_]+)\.ts$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface DiscoveredFile {
  number: number;
  name: string;
  /** The `NNNN_name` stem shared by the module and its sidecar. */
  stem: string;
  file: string;
  metaPath: string;
}

interface MigrationMeta {
  number: number;
  name: string;
  fingerprint: string;
  pre: SchemaSnapshot;
  target: SchemaSnapshot;
}

/** Discover, validate, and order the whole chain, or `[]` when there is none. */
export async function loadMigrationChain(config: AppConfig): Promise<MigrationStep[]> {
  const dir = config.migrationsDir;
  if (!existsSync(dir)) return [];

  const discovered = discoverFiles(dir);
  if (discovered.length === 0) return [];

  const steps: MigrationStep[] = [];
  for (const found of discovered) steps.push(await loadStep(found));
  steps.sort((a, b) => a.number - b.number);
  validateChain(steps); // strict-increase / positive numbers, labelled NNNN_name
  return steps;
}

/**
 * List `migrations/` into `NNNN_name.ts` files, refusing anything else, and
 * cross-check the `meta/` directory both ways: a stray sidecar (no matching
 * module) is as much an error as a missing one.
 */
function discoverFiles(dir: string): DiscoveredFile[] {
  const metaDir = join(dir, "meta");
  const found: DiscoveredFile[] = [];
  const stems = new Set<string>();

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "meta") {
        throw new Error(
          `migrations/${entry.name}/ is not allowed; migrations/ holds NNNN_name.ts files and the meta/ directory only`,
        );
      }
      continue;
    }
    const match = MIGRATION_FILE.exec(entry.name);
    if (match === null) {
      throw new Error(
        `migrations/${entry.name} is not a valid migration file; expected NNNN_name.ts (4-digit number + identifier name)`,
      );
    }
    const number = Number(match[1]);
    if (number === 0) throw new Error(`migrations/${entry.name} has migration number 0; numbers are 1-based`);
    const stem = `${match[1]}_${match[2]}`;
    stems.add(stem);
    found.push({ number, name: match[2]!, stem, file: join(dir, entry.name), metaPath: join(metaDir, `${stem}.json`) });
  }

  if (existsSync(metaDir)) {
    for (const entry of readdirSync(metaDir, { withFileTypes: true })) {
      // `NNNN_name.types.ts` is the generated types companion the scaffold
      // imports, not a sidecar; it rides alongside the JSON and is never loaded here.
      if (entry.isFile() && entry.name.endsWith(".types.ts")) continue;
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error(`migrations/meta/${entry.name} is not a sidecar; meta/ holds NNNN_name.json files (and .types.ts companions) only`);
      }
      const stem = entry.name.slice(0, -".json".length);
      if (!stems.has(stem)) {
        throw new Error(`migrations/meta/${entry.name} has no matching migration file migrations/${stem}.ts`);
      }
    }
  }
  return found;
}

/** Validate one file against its sidecar and hydrate the step (module imported). */
async function loadStep(found: DiscoveredFile): Promise<MigrationStep> {
  const { stem, name, number, file, metaPath } = found;
  if (!existsSync(metaPath)) {
    throw new Error(`migration ${stem} is missing its meta sidecar at migrations/meta/${stem}.json`);
  }
  const meta = readMeta(metaPath, stem);
  if (meta.number !== number || meta.name !== name) {
    throw new Error(
      `migration ${stem} disagrees with its sidecar (meta names ${stepStem(meta.number, meta.name)}); ` +
        "the filename number and name must match the meta exactly",
    );
  }
  const recomputed = migrationFingerprint(meta.target);
  if (recomputed !== meta.fingerprint) {
    throw new Error(
      `migration ${stem} target snapshot no longer matches its recorded fingerprint (recomputed ${recomputed}); ` +
        "it was edited after generation",
    );
  }
  const migration = await importMigration(file, stem);
  return { number: meta.number, name: meta.name, pre: meta.pre, target: meta.target, migration };
}

function readMeta(path: string, stem: string): MigrationMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`migration ${stem} sidecar is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`migration ${stem} sidecar must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const { number, name, fingerprint } = record;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`migration ${stem} sidecar "number" must be a positive integer`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`migration ${stem} sidecar "name" must be a non-empty string`);
  }
  if (typeof fingerprint !== "string" || !SHA256.test(fingerprint)) {
    throw new Error(`migration ${stem} sidecar "fingerprint" must be a lowercase SHA-256 digest`);
  }
  return {
    number,
    name,
    fingerprint,
    pre: requireSnapshot(record.pre, stem, "pre"),
    target: requireSnapshot(record.target, stem, "target"),
  };
}

function requireSnapshot(value: unknown, stem: string, field: string): SchemaSnapshot {
  const tables = (value as { tables?: unknown } | null)?.tables;
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof tables !== "object" || tables === null) {
    throw new Error(`migration ${stem} sidecar "${field}" must be a schema snapshot`);
  }
  return value as SchemaSnapshot;
}

async function importMigration(file: string, stem: string): Promise<Migration> {
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`failed to import migration ${stem}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  try {
    // Re-running defineMigration is idempotent for a real result and the exact
    // validation we want for anything else (undefined, a schema, a function).
    return defineMigration(module.default as Migration);
  } catch (error) {
    throw new Error(
      `migration ${stem} must default-export defineMigration({...}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function stepStem(number: number, name: string): string {
  return `${String(number).padStart(4, "0")}_${name}`;
}
