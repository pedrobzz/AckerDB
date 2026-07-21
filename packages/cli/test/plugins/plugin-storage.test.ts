import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";
import {
  Engine,
  defineApp,
  definePlugin,
  defineSchema,
  defineTable,
  reconcile,
  reconcilePluginStorage,
  v,
  type PluginStorageRequirement,
} from "@dbzz/server";
import { loadConfig } from "../../src/app/config.ts";
import { startApp } from "../../src/app/start.ts";
import {
  applyPluginStorageConsent,
  executePluginStorageCommand,
  planPluginStorage,
  renderPluginStorageRequirement,
  runPluginStorageConsentForm,
} from "../../src/plugins/storage.ts";
import { desiredPluginMounts } from "@dbzz/server";
import { makeFixture } from "../support/fixture.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const rootSchema = defineSchema({
  roots: defineTable({ id: v.primaryKey(), value: v.string() }),
});
const pluginV1 = defineSchema({
  entries: defineTable({ id: v.primaryKey(), value: v.string() }),
});

const APP = (pluginSchema: string | null, rootExtra = "", pluginExtra = "") => `
import { defineApp, definePlugin, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  roots: defineTable({ id: v.primaryKey(), value: v.string() }),
  ${rootExtra}
});
${pluginSchema === null ? "" : `
const cachePlugin = definePlugin({
  id: "@test/cache",
  schema: defineSchema({ entries: defineTable({ id: v.primaryKey(), value: ${pluginSchema}, ${pluginExtra} }) }),
  create: () => ({ exports: {} }),
});`}
export default defineApp({ schema${pluginSchema === null ? "" : ", plugins: { cache: cachePlugin() }"} });
`;

function seed(
  pluginSchema: string | null,
  options: {
    readonly rootExtra?: string;
    readonly files?: Record<string, string>;
    readonly port?: number;
  } = {},
): { dir: string; config: ReturnType<typeof loadConfig> } {
  const dir = makeFixture({
    "app.ts": APP(pluginSchema, options.rootExtra),
    ".dbzz.config.json": JSON.stringify(
      options.port === undefined ? {} : { port: options.port },
    ),
    ...options.files,
  });
  dirs.push(dir);
  const config = loadConfig(dir);
  mkdirSync(config.dbDir, { recursive: true });
  const engine = new Engine(rootSchema, join(config.dbDir, "data.db"));
  reconcile(engine);
  reconcilePluginStorage(engine, { cache: { definitionId: "@test/cache", schema: pluginV1 } });
  engine.writer.query("INSERT INTO roots (id, value) VALUES (1, 'root')").run();
  engine.writer.query('INSERT INTO "_dbzz_plugin_5:cacheentries" (id, value) VALUES (1, \'cached\')').run();
  engine.close("clean");
  return { dir, config };
}

function runCli(args: string[]): number {
  const child = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DBZZ_TELEMETRY: "disabled" },
  });
  return child.exitCode;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = probe.address();
  if (typeof address !== "object" || address === null) throw new Error("port probe has no address");
  await new Promise<void>((resolve, reject) => probe.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

function rowCounts(config: ReturnType<typeof loadConfig>): { root: number; plugin: number | null } {
  const db = new Database(join(config.dbDir, "data.db"), { readonly: true });
  try {
    const count = (table: string) => Number((db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
    return {
      root: count("roots"),
      plugin: existsSync(join(config.dbDir, "data.db")) &&
        (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get("_dbzz_plugin_5:cacheentries") !== null)
        ? count('"_dbzz_plugin_5:cacheentries"')
        : null,
    };
  } finally {
    db.close();
  }
}

function cleanShutdown(config: ReturnType<typeof loadConfig>): number {
  const db = new Database(join(config.dbDir, "data.db"), { readonly: true });
  try {
    return Number((db.query("SELECT clean_shutdown FROM _dbzz_state WHERE singleton = 1").get() as {
      clean_shutdown: number;
    }).clean_shutdown);
  } finally {
    db.close();
  }
}

describe("Plugin storage CLI boundary", () => {
  test("projects the assembled app mounts onto the persistence contract", () => {
    const plugin = definePlugin({
      id: "@test/cache",
      schema: pluginV1,
      create: () => ({ exports: {} }),
    })();
    const app = defineApp({ schema: rootSchema, plugins: { cache: plugin } });
    expect(desiredPluginMounts(app)).toEqual({
      cache: { definitionId: "@test/cache", schema: pluginV1 },
    });
  });

  test("renders the exact mount, reason, plan, and a default-safe prompt", async () => {
    const requirement: PluginStorageRequirement = {
      kind: "reset",
      reason: "unsafe-schema",
      mount: "cache",
      currentDefinitionId: "@test/cache",
      targetDefinitionId: "@test/cache",
      currentFingerprint: "a".repeat(64),
      targetFingerprint: "b".repeat(64),
      plan: {
        applied: ["entries: index added"],
        refusals: [{ table: "entries", column: "value", reason: "column-type-changed", question: "existing values need conversion" }],
      },
    };
    const rendered = renderPluginStorageRequirement(requirement);
    expect(rendered).toContain('Plugin storage mount "cache" must be reset');
    expect(rendered).toContain("unsafe private-schema change");
    expect(rendered).toContain("entries.value: existing values need conversion");
    expect(rendered).toContain("entries: index added");

    const prompts: string[] = [];
    expect(await runPluginStorageConsentForm(requirement, async (prompt) => {
      prompts.push(prompt);
      return "";
    })).toBe(false);
    expect(prompts[0]).toContain('reset Plugin storage mount "cache"');
  });

  test("stale consent cannot clear data; matching consent resets only the selected Plugin mount", async () => {
    const { config } = seed("v.bigint()");
    const plan = await planPluginStorage(config);
    if (plan.clean) throw new Error("expected reset requirement");
    expect(plan.requirement.kind).toBe("reset");

    expect(await applyPluginStorageConsent(config, {
      kind: "reset",
      mount: "cache",
      currentFingerprint: "stale",
      targetFingerprint: plan.requirement.targetFingerprint,
    })).toEqual({ stale: true });
    expect(rowCounts(config)).toEqual({ root: 1, plugin: 1 });

    expect(await applyPluginStorageConsent(config, {
      kind: "reset",
      mount: "cache",
      currentFingerprint: plan.requirement.currentFingerprint,
      targetFingerprint: plan.requirement.targetFingerprint,
    })).toEqual({ applied: true });
    expect(rowCounts(config)).toEqual({ root: 1, plugin: 0 });
  });

  test("stale destructive consent never clears data even when replacement safe drift reconciles", async () => {
    const unsafe = seed("v.bigint()");
    const displayed = await planPluginStorage(unsafe.config);
    if (displayed.clean) throw new Error("expected reset requirement");

    const safeDir = makeFixture({
      "app.ts": APP("v.string()", "", "note: v.string().nullable(),"),
      ".dbzz.config.json": JSON.stringify({ db: unsafe.config.dbDir }),
    });
    dirs.push(safeDir);
    const safe = loadConfig(safeDir);
    expect(await applyPluginStorageConsent(safe, {
      kind: displayed.requirement.kind,
      mount: displayed.requirement.mount,
      currentFingerprint: displayed.requirement.currentFingerprint,
      targetFingerprint: displayed.requirement.targetFingerprint,
    })).toEqual({ stale: true });

    expect(rowCounts(unsafe.config)).toEqual({ root: 1, plugin: 1 });
    const db = new Database(join(unsafe.config.dbDir, "data.db"), { readonly: true });
    try {
      const columns = db.query('PRAGMA table_info("_dbzz_plugin_5:cacheentries")').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("note");
    } finally {
      db.close();
    }
  });

  test("explicit reset/drop commands re-prove the current requirement and preserve root storage", async () => {
    const reset = seed("v.bigint()");
    await expect(executePluginStorageCommand(reset.config, "drop", "cache")).rejects.toThrow(
      'requires `dbzz plugin reset cache',
    );
    expect(rowCounts(reset.config)).toEqual({ root: 1, plugin: 1 });
    expect(cleanShutdown(reset.config)).toBe(1);
    await executePluginStorageCommand(reset.config, "reset", "cache");
    expect(rowCounts(reset.config)).toEqual({ root: 1, plugin: 0 });

    const drop = seed(null);
    await executePluginStorageCommand(drop.config, "drop", "cache");
    expect(rowCounts(drop.config)).toEqual({ root: 1, plugin: null });
  });

  test("explicit Plugin consent does not load or apply pending root schema/migrations", async () => {
    const { dir, config } = seed("v.bigint()", {
      rootExtra: "newRoots: defineTable({ id: v.primaryKey() }),",
      files: {
        // If the Plugin command imports the migration chain, this deliberate
        // pending placeholder fails. It is root-startup work, outside consent.
        "migrations/0001_pending.ts": 'throw new Error("Plugin command loaded a root migration");',
      },
    });

    await executePluginStorageCommand(config, "reset", "cache");
    const db = new Database(join(config.dbDir, "data.db"), { readonly: true });
    try {
      expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'newRoots'").get()).toBeNull();
      expect((db.query("SELECT count(*) AS count FROM _dbzz_migrations").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
    expect(existsSync(join(dir, "migrations", "0001_pending.ts"))).toBe(true);
    expect(rowCounts(config)).toEqual({ root: 1, plugin: 0 });
  });

  test("noninteractive startup prints the exact command and the public CLI re-proves it", async () => {
    const { dir, config } = seed("v.bigint()", { port: await freePort() });

    await expect(startApp(config)).rejects.toThrow(
      new RegExp(`Plugin storage requires explicit consent[\\s\\S]*dbzz plugin reset cache ${dir}`),
    );
    expect(rowCounts(config)).toEqual({ root: 1, plugin: 1 });

    expect(runCli(["plugin", "drop", "cache", dir])).toBe(1);
    expect(rowCounts(config)).toEqual({ root: 1, plugin: 1 });

    expect(runCli(["plugin", "reset", "cache", dir])).toBe(0);
    expect(rowCounts(config)).toEqual({ root: 1, plugin: 0 });
  }, 20_000);
});
