/**
 * THROWAWAY audit probe (T5, finding 4): what does the Engine retain when
 * Plugin storage reconciliation refuses for want of consent?
 * Run from packages/server: bun ../../.t5scratch/plugin-leak-probe.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v, defineSchema, defineTable, Engine, reconcile } from "@ackerdb/server";
import { reconcilePluginStorage } from "@ackerdb/server";

const dir = mkdtempSync(join(tmpdir(), "ackerdb-t5-leak-"));
const path = join(dir, "data.db");

const appSchema = defineSchema({ items: defineTable({ id: v.primaryKey(), n: v.string() }) });

const vOne = defineSchema({
  notes: defineTable({ id: v.primaryKey(), body: v.string(), kind: v.enum("NoteKind", ["a", "b"]) })
    .fullText(["body"]),
});
// Same mount, INCOMPATIBLE shape: string -> int is shape-unsafe, forcing a reset requirement.
const vTwo = defineSchema({
  notes: defineTable({ id: v.primaryKey(), body: v.int(), kind: v.enum("NoteKind", ["a", "b"]) }),
});

const engine = new Engine(appSchema, path);
reconcile(engine);

const tags = (engine as unknown as { tags: Map<string, unknown> }).tags;
const fts = () => (engine as unknown as { fullTextTokenizer: unknown }).fullTextTokenizer !== null;

console.log("before any plugin work: tag identities =", [...tags.keys()].length, "fts tokenizer =", fts());

reconcilePluginStorage(engine, { demo: { definitionId: "demo", schema: vOne } } as never);
console.log("after mount v1 committed  : tag identities =", [...tags.keys()], "fts =", fts());

// Now ask for an incompatible v2 on the same mount: this must refuse for consent.
let refused = false;
try {
  reconcilePluginStorage(engine, { demo: { definitionId: "demo", schema: vTwo } } as never);
} catch (error) {
  refused = true;
  console.log("refusal:", (error as Error).name);
}
console.log("refused =", refused);

// A brand-new mount that is refused alongside: does its speculative state stick?
const other = defineSchema({
  audit: defineTable({ id: v.primaryKey(), level: v.enum("AuditLevel", ["low", "high"]) }),
});
try {
  reconcilePluginStorage(engine, {
    demo: { definitionId: "demo", schema: vTwo },
    fresh: { definitionId: "fresh", schema: other },
  } as never);
} catch {
  /* refused again */
}
console.log("after refusals            : tag identities =", [...tags.keys()]);
const persisted = engine.writer.query("SELECT DISTINCT type FROM _ackerdb_tags ORDER BY type").all();
console.log("persisted tag types       :", persisted);

engine.close("clean");
rmSync(dir, { recursive: true, force: true });
