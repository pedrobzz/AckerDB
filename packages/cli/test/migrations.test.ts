import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dbz,
  defineSchema,
  defineTable,
  migrationFingerprint,
  migrationIdentity,
  snapshotOf,
  type SchemaSnapshot,
} from "@dbzz/server";
import { loadConfig } from "../src/config.ts";
import { loadMigrationChain } from "../src/migrations/load.ts";
import { makeFixture } from "./fixture.ts";

const schemaV1 = defineSchema({
  items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.number() }),
});
const schemaV2 = defineSchema({
  items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.string() }),
});
const schemaV3 = defineSchema({
  items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.bigint() }),
});
const PRE = snapshotOf(schemaV1);
const TARGET = snapshotOf(schemaV2);
const FINGERPRINT = migrationFingerprint(TARGET);

const MIGRATION_TS = `import { defineMigration } from "@dbzz/server";
export default defineMigration({
  tables: { items: (row) => ({ ...row, count: String(row.count) }) },
});
`;

interface MetaOverrides {
  number?: number;
  name?: string;
  fingerprint?: string;
  pre?: SchemaSnapshot;
  target?: SchemaSnapshot;
}

function metaJson(overrides: MetaOverrides = {}): string {
  return JSON.stringify({
    number: 1,
    name: "count_to_string",
    fingerprint: FINGERPRINT,
    pre: PRE,
    target: TARGET,
    ...overrides,
  });
}

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Build an app fixture whose `migrations/` holds exactly the given files. */
function chain(files: Record<string, string>): ReturnType<typeof loadConfig> {
  const dir = makeFixture(files);
  dirs.push(dir);
  return loadConfig(dir);
}

describe("loadMigrationChain", () => {
  test("loads a valid chain in order with fully hydrated steps", async () => {
    const target3 = snapshotOf(schemaV3);
    const config = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson(),
      "migrations/0002_count_to_bigint.ts": MIGRATION_TS,
      "migrations/meta/0002_count_to_bigint.json": JSON.stringify({
        number: 2,
        name: "count_to_bigint",
        fingerprint: migrationFingerprint(target3),
        pre: TARGET,
        target: target3,
      }),
    });

    const steps = await loadMigrationChain(config);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => [s.number, s.name])).toEqual([
      [1, "count_to_string"],
      [2, "count_to_bigint"],
    ]);
    expect(steps[0]!.pre).toEqual(PRE);
    expect(steps[0]!.target).toEqual(TARGET);
    expect(typeof steps[0]!.migration.tables?.items).toBe("function");
    expect(steps[1]!.pre).toEqual(TARGET);
    expect(steps[1]!.target).toEqual(target3);
  });

  test("hydrates each step's code with the exact migration file text", async () => {
    const config = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson(),
    });
    const [step] = await loadMigrationChain(config);
    // `code` is the ORIGINAL file bytes (read pre-import), so the recorded
    // identity is pinned to exactly what was loaded.
    expect(step!.code).toBe(MIGRATION_TS);
    // The file text is part of the applied identity, so a different transform
    // body shifts it even when number, name, pre, and target are unchanged.
    const edited = MIGRATION_TS.replace("String(row.count)", "`${row.count}`");
    expect(migrationIdentity({ ...step!, code: edited })).not.toBe(migrationIdentity(step!));
  });

  test("refuses when the migration file changes between the pre-import read and the post-import read", async () => {
    // The module rewrites its own file at import time, standing in for an editor
    // save landing between the loader's two reads. The pre-import bytes are the
    // identity input, so a change is refused rather than silently recorded.
    const config = chain({
      "migrations/0001_self_tamper.ts": `import { defineMigration } from "@dbzz/server";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
writeFileSync(fileURLToPath(import.meta.url), "// tampered mid-load\\n");
export default defineMigration({ tables: { items: (row) => row } });
`,
      "migrations/meta/0001_self_tamper.json": metaJson({ name: "self_tamper" }),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("modified on disk while loading");
  });

  test("orders numerically regardless of directory listing", async () => {
    const target3 = snapshotOf(schemaV3);
    const config = chain({
      "migrations/0002_count_to_bigint.ts": MIGRATION_TS,
      "migrations/meta/0002_count_to_bigint.json": JSON.stringify({
        number: 2,
        name: "count_to_bigint",
        fingerprint: migrationFingerprint(target3),
        pre: TARGET,
        target: target3,
      }),
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson(),
    });
    expect((await loadMigrationChain(config)).map((s) => s.number)).toEqual([1, 2]);
  });

  test("an absent migrations directory is an empty chain", async () => {
    const config = chain({ "schema.ts": "export default {};" });
    expect(await loadMigrationChain(config)).toEqual([]);
  });

  test("an empty migrations directory is an empty chain", async () => {
    const config = chain({ "schema.ts": "export default {};" });
    mkdirSync(config.migrationsDir, { recursive: true });
    expect(await loadMigrationChain(config)).toEqual([]);
  });

  test("rejects a migration file with no meta sidecar", async () => {
    const config = chain({ "migrations/0001_count_to_string.ts": MIGRATION_TS });
    await expect(loadMigrationChain(config)).rejects.toThrow("missing its meta sidecar");
  });

  test("rejects a meta sidecar with no migration file", async () => {
    const config = chain({ "migrations/meta/0001_count_to_string.json": metaJson() });
    await expect(loadMigrationChain(config)).rejects.toThrow("has no matching migration file");
  });

  test("rejects a malformed migration filename", async () => {
    const config = chain({
      "migrations/1_count.ts": MIGRATION_TS,
      "migrations/meta/1_count.json": metaJson(),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("is not a valid migration file");
  });

  test("rejects migration number zero", async () => {
    const config = chain({
      "migrations/0000_count.ts": MIGRATION_TS,
      "migrations/meta/0000_count.json": metaJson({ number: 0, name: "count" }),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("migration number 0");
  });

  test("rejects an unexpected entry in migrations/", async () => {
    const config = chain({
      "migrations/README.md": "notes",
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson(),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("is not a valid migration file");
  });

  test("rejects a sidecar whose number or name disagrees with the filename", async () => {
    const numberMismatch = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson({ number: 2 }),
    });
    await expect(loadMigrationChain(numberMismatch)).rejects.toThrow("disagrees with its sidecar");

    const nameMismatch = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson({ name: "renamed" }),
    });
    await expect(loadMigrationChain(nameMismatch)).rejects.toThrow("disagrees with its sidecar");
  });

  test("rejects a target that no longer matches its recorded fingerprint", async () => {
    const config = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": metaJson({ fingerprint: "0".repeat(64) }),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("recorded fingerprint");
  });

  test("rejects a sidecar that is not valid JSON or lacks required fields", async () => {
    const badJson = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": "{ not json",
    });
    await expect(loadMigrationChain(badJson)).rejects.toThrow("not valid JSON");

    const missingTarget = chain({
      "migrations/0001_count_to_string.ts": MIGRATION_TS,
      "migrations/meta/0001_count_to_string.json": JSON.stringify({
        number: 1,
        name: "count_to_string",
        fingerprint: FINGERPRINT,
        pre: PRE,
      }),
    });
    await expect(loadMigrationChain(missingTarget)).rejects.toThrow('"target" must be a schema snapshot');
  });

  test("rejects a module that does not default-export a migration", async () => {
    const config = chain({
      "migrations/0001_count_to_string.ts": "export default 42;\n",
      "migrations/meta/0001_count_to_string.json": metaJson(),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("must default-export defineMigration");
  });

  test("rejects duplicate (non-increasing) migration numbers", async () => {
    const config = chain({
      "migrations/0001_a.ts": MIGRATION_TS,
      "migrations/meta/0001_a.json": metaJson({ name: "a" }),
      "migrations/0001_b.ts": MIGRATION_TS,
      "migrations/meta/0001_b.json": metaJson({ name: "b" }),
    });
    await expect(loadMigrationChain(config)).rejects.toThrow("strictly increase");
  });
});
