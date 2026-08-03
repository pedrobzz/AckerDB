/**
 * THROWAWAY audit bench (T5, finding 4): cost of the scope construction that
 * resetPluginStorage / dropPluginStorage used to perform for EVERY desired
 * mount before consent, and now do not perform at all.
 * Run from packages/server: bun ../../.t5scratch/plugin-bench.ts [mounts]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v, defineSchema, defineTable, Engine, reconcile } from "@ackerdb/server";
import { dropPluginStorage, reconcilePluginStorage } from "@ackerdb/server";

const MOUNTS = Number(process.argv[2] ?? 8);
const RUNS = 60;

const dir = mkdtempSync(join(tmpdir(), "ackerdb-t5-plugbench-"));
const path = join(dir, "data.db");

const rootSchema = defineSchema({ roots: defineTable({ id: v.primaryKey(), value: v.string() }) });

function pluginSchema(n: number) {
  const tables: Record<string, unknown> = {};
  for (let t = 0; t < 4; t++) {
    tables[`t${t}`] = defineTable({
      id: v.primaryKey(),
      a: v.string(),
      b: v.int(),
      k: v.enum(`K${n}_${t}`, ["x", "y", "z"]),
      u: v.union(`U${n}_${t}`, { one: v.string(), two: v.int() }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return defineSchema(tables as any);
}

const desired: Record<string, unknown> = {};
for (let m = 0; m < MOUNTS; m++) {
  desired[`m${m}`] = { definitionId: `plug${m}`, schema: pluginSchema(m) };
}
// One extra mount that exists on disk but is NOT desired, so it can be dropped.
const stale = { definitionId: "stale", schema: pluginSchema(999) };

const engine = new Engine(rootSchema, path);
reconcile(engine);
reconcilePluginStorage(engine, { ...desired, stale } as never);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planScope = (m: number) => (engine as any).planPluginScope(`m${m}`, (desired[`m${m}`] as any).schema);

const per: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  for (let m = 0; m < MOUNTS; m++) planScope(m);
  per.push(performance.now() - t0);
}
per.sort((a, b) => a - b);
const median = per[Math.floor(per.length / 2)]!;
console.log(`${MOUNTS} mounts x 4 tables: planning every desired scope = ${median.toFixed(3)}ms (median of ${RUNS})`);
console.log(`  per mount: ${(median / MOUNTS).toFixed(3)}ms`);
console.log(`  this is what dropPluginStorage did purely to compare a mount NAME,`);
console.log(`  and what resetPluginStorage did before rebuilding one scope anyway.`);

// Sanity: the drop path still works and now costs a name comparison.
const requirement = {
  kind: "drop" as const,
  reason: "stale-mount" as const,
  mount: "stale",
  currentDefinitionId: "stale",
  targetDefinitionId: null,
  currentFingerprint: "",
  targetFingerprint: "",
  plan: { applied: [], refusals: [] },
};
try {
  dropPluginStorage(engine, desired as never, requirement as never);
  console.log("  drop executed (fingerprint check passed unexpectedly)");
} catch (error) {
  console.log(`  drop consent check reached without building scopes: ${(error as Error).message}`);
}

engine.close("clean");
rmSync(dir, { recursive: true, force: true });
