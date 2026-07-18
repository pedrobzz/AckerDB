import { describe, expect, test } from "bun:test";
import {
  classifySchemaDiff,
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  diffSnapshots,
  snapshotOf,
  type Schema,
} from "@dbzz/server";
import { runRenameForm, type Ask } from "../src/form.ts";
import { deriveSlug, renameCandidates, type RenameCandidates } from "../src/plan.ts";

const diffOf = (pre: Schema, target: Schema) => diffSnapshots(snapshotOf(pre), snapshotOf(target));
const refusalsOf = (pre: Schema, target: Schema) => classifySchemaDiff(diffOf(pre, target)).refusals;

/** A scripted `ask`: returns queued answers in order and records every prompt. */
function scriptedAsk(answers: string[]): Ask & { prompts: string[]; calls: number } {
  const prompts: string[] = [];
  const queue = [...answers];
  const ask = (async (prompt: string) => {
    prompts.push(prompt);
    if (queue.length === 0) throw new Error(`unexpected prompt with no scripted answer: ${prompt}`);
    return queue.shift()!;
  }) as Ask & { prompts: string[]; calls: number };
  Object.defineProperty(ask, "prompts", { get: () => prompts });
  Object.defineProperty(ask, "calls", { get: () => prompts.length });
  return ask;
}

describe("renameCandidates", () => {
  test("a lone dropped/added table pair", () => {
    const pre = defineSchema({ keep: defineTable({ id: dbz.primaryKey() }), legacy: defineTable({ id: dbz.primaryKey() }) });
    const target = defineSchema({ keep: defineTable({ id: dbz.primaryKey() }), archive: defineTable({ id: dbz.primaryKey() }) });
    expect(renameCandidates(diffOf(pre, target)).tables).toEqual({ dropped: ["legacy"], added: ["archive"] });
  });

  test("multiple dropped and added tables become one global pool, sorted", () => {
    const pre = defineSchema({ b: defineTable({ id: dbz.primaryKey() }), a: defineTable({ id: dbz.primaryKey() }) });
    const target = defineSchema({ y: defineTable({ id: dbz.primaryKey() }), x: defineTable({ id: dbz.primaryKey() }) });
    expect(renameCandidates(diffOf(pre, target)).tables).toEqual({ dropped: ["a", "b"], added: ["x", "y"] });
  });

  test("event tables are never rename candidates (they hold no data to carry)", () => {
    const pre = defineSchema({
      ping: defineEventTable({ id: dbz.primaryKey() }, { args: {}, access: "public", matches: () => true }),
    });
    const target = defineSchema({});
    expect(renameCandidates(diffOf(pre, target)).tables).toEqual({ dropped: [], added: [] });
  });

  test("per-table dropped and added columns, keyed by table", () => {
    const pre = defineSchema({ t: defineTable({ id: dbz.primaryKey(), foo: dbz.string(), bar: dbz.string() }) });
    const target = defineSchema({ t: defineTable({ id: dbz.primaryKey(), baz: dbz.string() }) });
    expect(renameCandidates(diffOf(pre, target)).columns).toEqual({ t: { dropped: ["bar", "foo"], added: ["baz"] } });
  });

  test("per-type removed and added variants, keyed by type name", () => {
    const pre = defineSchema({ u: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["admin", "guest"]) }) });
    const target = defineSchema({ u: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["admin", "member"]) }) });
    expect(renameCandidates(diffOf(pre, target)).variants).toEqual({ Role: { dropped: ["guest"], added: ["member"] } });
  });

  test("a pure type change yields no candidates", () => {
    const pre = defineSchema({ items: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const target = defineSchema({ items: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    expect(renameCandidates(diffOf(pre, target))).toEqual({ tables: { dropped: [], added: [] }, columns: {}, variants: {} });
  });
});

describe("runRenameForm", () => {
  const loneTable: RenameCandidates = { tables: { dropped: ["legacy"], added: ["archive"] }, columns: {}, variants: {} };

  test("a lone pair is still asked — never auto-decided", async () => {
    const yes = scriptedAsk(["y"]);
    const result = await runRenameForm(loneTable, yes);
    expect(yes.calls).toBe(1);
    expect(result.renames).toEqual({ tables: { legacy: "archive" } });
    expect(result.dropsAcknowledged).toEqual([]);
  });

  test("a lone pair declined stays a drop", async () => {
    const no = scriptedAsk(["n"]);
    const result = await runRenameForm(loneTable, no);
    expect(no.calls).toBe(1);
    expect(result.renames).toEqual({});
    expect(result.dropsAcknowledged).toEqual(['table "legacy"']);
  });

  test("re-prompts until the answer is a recognized yes/no", async () => {
    const ask = scriptedAsk(["maybe", "", "yes"]);
    const result = await runRenameForm(loneTable, ask);
    expect(ask.calls).toBe(3);
    expect(result.renames).toEqual({ tables: { legacy: "archive" } });
  });

  test("multiple candidates are a numbered choice", async () => {
    const candidates: RenameCandidates = { tables: { dropped: ["a"], added: ["x", "y"] }, columns: {}, variants: {} };
    const result = await runRenameForm(candidates, scriptedAsk(["2"]));
    expect(result.renames).toEqual({ tables: { a: "y" } });
  });

  test("the trailing 'none' option keeps the drop", async () => {
    const candidates: RenameCandidates = { tables: { dropped: ["a"], added: ["x", "y"] }, columns: {}, variants: {} };
    const result = await runRenameForm(candidates, scriptedAsk(["3"])); // 3 = none (delete + add)
    expect(result.renames).toEqual({});
    expect(result.dropsAcknowledged).toEqual(['table "a"']);
  });

  test("a claimed target is consumed, so a two-into-two pool degrades to a lone y/n", async () => {
    const candidates: RenameCandidates = {
      tables: { dropped: [], added: [] },
      columns: { t: { dropped: ["a", "b"], added: ["x", "y"] } },
      variants: {},
    };
    const ask = scriptedAsk(["1", "y"]); // a -> x (choice 1), then b -> y as the lone remaining
    const result = await runRenameForm(candidates, ask);
    expect(result.renames).toEqual({ columns: { t: { a: "x", b: "y" } } });
    // the second prompt is a y/n, not a numbered menu
    expect(ask.prompts[1]).toContain("[y/n]");
  });

  test("a drop with no candidate is neither asked nor acknowledged", async () => {
    const candidates: RenameCandidates = {
      tables: { dropped: ["gone"], added: [] },
      columns: {},
      variants: {},
    };
    const ask = scriptedAsk([]);
    const result = await runRenameForm(candidates, ask);
    expect(ask.calls).toBe(0);
    expect(result).toEqual({ renames: {}, dropsAcknowledged: [] });
  });

  test("assembles tables, columns, and variants into one Renames object", async () => {
    const candidates: RenameCandidates = {
      tables: { dropped: ["legacy"], added: ["archive"] },
      columns: { profiles: { dropped: ["bio"], added: ["blurb"] } },
      variants: { Role: { dropped: ["guest"], added: ["member"] } },
    };
    // table lone y/n -> y; column lone y/n -> y; variant lone y/n -> y
    const result = await runRenameForm(candidates, scriptedAsk(["y", "y", "y"]));
    expect(result.renames).toEqual({
      tables: { legacy: "archive" },
      columns: { profiles: { bio: "blurb" } },
      variants: { Role: { guest: "member" } },
    });
  });
});

describe("deriveSlug", () => {
  test("a type change names its site and reason", () => {
    const pre = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), kind: dbz.number() }) });
    const target = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), kind: dbz.string() }) });
    expect(deriveSlug(refusalsOf(pre, target))).toBe("posts_kind_retype");
  });

  test("a dropped table names the table", () => {
    const pre = defineSchema({ keep: defineTable({ id: dbz.primaryKey() }), legacy: defineTable({ id: dbz.primaryKey() }) });
    const target = defineSchema({ keep: defineTable({ id: dbz.primaryKey() }) });
    expect(deriveSlug(refusalsOf(pre, target))).toBe("legacy_drop");
  });

  test("no refusals falls back to a stable default", () => {
    expect(deriveSlug([])).toBe("migration");
  });

  test("always matches the loader's name grammar", () => {
    const pre = defineSchema({ t: defineTable({ id: dbz.primaryKey(), c: dbz.string() }) });
    const target = defineSchema({ t: defineTable({ id: dbz.primaryKey() }) });
    expect(deriveSlug(refusalsOf(pre, target))).toMatch(/^[A-Za-z0-9_]+$/);
  });
});
