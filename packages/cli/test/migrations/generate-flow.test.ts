import { describe, expect, test } from "bun:test";
import {
  classifySchemaDiff,
  v,
  defineEventTable,
  defineSchema,
  defineTable,
  diffSnapshots,
  snapshotOf,
  type Schema,
} from "@dbzz/server";
import { runRenameForm, type Ask } from "../../src/migrations/form.ts";
import { deriveSlug, renameCandidates, type RenameCandidates } from "../../src/migrations/plan.ts";

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
    const pre = defineSchema({ keep: defineTable({ id: v.primaryKey() }), legacy: defineTable({ id: v.primaryKey() }) });
    const target = defineSchema({ keep: defineTable({ id: v.primaryKey() }), archive: defineTable({ id: v.primaryKey() }) });
    expect(renameCandidates(diffOf(pre, target)).tables).toEqual({ dropped: ["legacy"], added: ["archive"] });
  });

  test("multiple dropped and added tables become one global pool, sorted", () => {
    const pre = defineSchema({ b: defineTable({ id: v.primaryKey() }), a: defineTable({ id: v.primaryKey() }) });
    const target = defineSchema({ y: defineTable({ id: v.primaryKey() }), x: defineTable({ id: v.primaryKey() }) });
    expect(renameCandidates(diffOf(pre, target)).tables).toEqual({ dropped: ["a", "b"], added: ["x", "y"] });
  });

  test("event tables are never rename candidates (they hold no data to carry)", () => {
    const pre = defineSchema({
      ping: defineEventTable({ id: v.primaryKey() }, { args: {}, access: "public", matches: () => true }),
    });
    const target = defineSchema({});
    expect(renameCandidates(diffOf(pre, target)).tables).toEqual({ dropped: [], added: [] });
  });

  test("per-table dropped and added columns, keyed by table", () => {
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), foo: v.string(), bar: v.string() }) });
    const target = defineSchema({ t: defineTable({ id: v.primaryKey(), baz: v.string() }) });
    expect(renameCandidates(diffOf(pre, target)).columns).toEqual({ t: { dropped: ["bar", "foo"], added: ["baz"] } });
  });

  test("per-type removed and added variants, keyed by type name", () => {
    const pre = defineSchema({ u: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["admin", "guest"]) }) });
    const target = defineSchema({ u: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["admin", "member"]) }) });
    expect(renameCandidates(diffOf(pre, target)).variants).toEqual({ Role: { dropped: ["guest"], added: ["member"] } });
  });

  test("a prototype-named type is an ordinary variant candidate key", () => {
    const pre = defineSchema({
      u: defineTable({
        id: v.primaryKey(),
        role: v.enum("toString", ["stable", "legacy"]),
      }),
    });
    const target = defineSchema({
      u: defineTable({
        id: v.primaryKey(),
        role: v.enum("toString", ["stable", "current"]),
      }),
    });
    const variants = renameCandidates(diffOf(pre, target)).variants;
    expect(Object.hasOwn(variants, "toString")).toBe(true);
    expect(variants["toString"]).toEqual({ dropped: ["legacy"], added: ["current"] });

    const prototypeCandidates = renameCandidates([{
      op: "table-altered",
      table: "__proto__",
      columns: [
        { op: "dropped", column: "old" },
        { op: "added", column: "current", nullable: false },
        {
          op: "variants-changed",
          column: "kind",
          typeName: "__proto__",
          variants: [
            { op: "removed", variant: "old" },
            { op: "added", variant: "new" },
          ],
        },
      ],
      indexes: [],
    }]);
    const columns = prototypeCandidates.columns;
    expect(Object.hasOwn(columns, "__proto__")).toBe(true);
    expect(columns["__proto__"]).toEqual({ dropped: ["old"], added: ["current"] });
    expect(Object.hasOwn(prototypeCandidates.variants, "__proto__")).toBe(true);
    expect(prototypeCandidates.variants["__proto__"]).toEqual({ dropped: ["old"], added: ["new"] });
  });

  test("a pure type change yields no candidates", () => {
    const pre = defineSchema({ items: defineTable({ id: v.primaryKey(), count: v.int() }) });
    const target = defineSchema({ items: defineTable({ id: v.primaryKey(), count: v.string() }) });
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

  test("prototype-named rename answers remain own table, scope, and source keys", async () => {
    const candidates: RenameCandidates = {
      tables: { dropped: ["__proto__"], added: ["constructor"] },
      columns: Object.fromEntries([["__proto__", { dropped: ["toString"], added: ["label"] }]]),
      variants: Object.fromEntries([["constructor", { dropped: ["__proto__"], added: ["current"] }]]),
    };
    const result = await runRenameForm(candidates, scriptedAsk(["y", "y", "y"]));
    expect(Object.hasOwn(result.renames.tables!, "__proto__")).toBe(true);
    expect(result.renames.tables!["__proto__"]).toBe("constructor");
    expect(Object.hasOwn(result.renames.columns!, "__proto__")).toBe(true);
    expect(result.renames.columns!["__proto__"]!["toString"]).toBe("label");
    expect(Object.hasOwn(result.renames.variants!["constructor"]!, "__proto__")).toBe(true);
    expect(result.renames.variants!["constructor"]!["__proto__"]).toBe("current");
  });
});

describe("deriveSlug", () => {
  test("a type change names its site and reason", () => {
    const pre = defineSchema({ posts: defineTable({ id: v.primaryKey(), kind: v.int() }) });
    const target = defineSchema({ posts: defineTable({ id: v.primaryKey(), kind: v.string() }) });
    expect(deriveSlug(refusalsOf(pre, target))).toBe("posts_kind_retype");
  });

  test("a dropped table names the table", () => {
    const pre = defineSchema({ keep: defineTable({ id: v.primaryKey() }), legacy: defineTable({ id: v.primaryKey() }) });
    const target = defineSchema({ keep: defineTable({ id: v.primaryKey() }) });
    expect(deriveSlug(refusalsOf(pre, target))).toBe("legacy_drop");
  });

  test("a counted constraint refusal names the validator repair", () => {
    expect(deriveSlug([{
      table: "posts",
      column: "title",
      reason: "constraint-violations",
      question: "constraints tightened; 1 existing row(s) violate the target validator",
      count: 1,
    }])).toBe("posts_title_validate");
  });

  test("no refusals falls back to a stable default", () => {
    expect(deriveSlug([])).toBe("migration");
  });

  test("always matches the loader's name grammar", () => {
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), c: v.string() }) });
    const target = defineSchema({ t: defineTable({ id: v.primaryKey() }) });
    expect(deriveSlug(refusalsOf(pre, target))).toMatch(/^[A-Za-z0-9_]+$/);
  });
});
