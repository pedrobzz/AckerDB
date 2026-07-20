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
  type SchemaRefusal,
} from "@dbzz/server";
import { renderLedger, runApplyForm, runConsentForm, runDivergenceForm } from "../src/migrations/consent.ts";
import type { Ask } from "../src/migrations/form.ts";
import { describeSafeChanges, planFingerprint, renameCandidates } from "../src/migrations/plan.ts";

const diffOf = (pre: Schema, target: Schema) => diffSnapshots(snapshotOf(pre), snapshotOf(target));

/** Diff + classify in one go: the exact inputs `computePlan` hands the describer. */
const describeOf = (pre: Schema, target: Schema, extraRefusals: SchemaRefusal[] = []) => {
  const diff = diffOf(pre, target);
  return describeSafeChanges(diff, [...classifySchemaDiff(diff).refusals, ...extraRefusals]);
};

/** A scripted `ask`: returns queued answers in order and records every prompt. */
function scriptedAsk(answers: string[]): Ask & { prompts: string[] } {
  const prompts: string[] = [];
  const queue = [...answers];
  const ask = (async (prompt: string) => {
    prompts.push(prompt);
    if (queue.length === 0) throw new Error(`unexpected prompt with no scripted answer: ${prompt}`);
    return queue.shift()!;
  }) as Ask & { prompts: string[] };
  Object.defineProperty(ask, "prompts", { get: () => prompts });
  return ask;
}

const EVENT_OPTS = { args: {}, access: "public", matches: () => true } as const;

describe("describeSafeChanges", () => {
  test("safe column work renders; refused columns are subtracted by site", () => {
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), keep: v.string() }) });
    const target = defineSchema({
      t: defineTable({
        id: v.primaryKey(),
        keep: v.string().nullable(), // widened
        bio: v.string().nullable(), // nullable add — safe
        score: v.float(), // required add — refused
      }),
    });
    expect(describeOf(pre, target)).toEqual([
      'column "t.keep" widened to nullable',
      'column "t.bio" added (nullable)',
    ]);
  });

  test("tables: new tables and event drops render; a dropped real table is refused away", () => {
    const pre = defineSchema({
      gone: defineTable({ id: v.primaryKey() }),
      ping: defineEventTable({ id: v.primaryKey() }, EVENT_OPTS),
    });
    const target = defineSchema({ fresh: defineTable({ id: v.primaryKey() }) });
    expect(describeOf(pre, target)).toEqual(['new table "fresh"', 'event table "ping" dropped']);
    // The label follows the diff atom's kind, never an assumption about what
    // survives refusal: with no refusals passed, the real drop renders honestly.
    expect(describeSafeChanges(diffOf(pre, target), [])).toContain('table "gone" dropped');
  });

  test("variants: additions render under the type name; removals are refused away", () => {
    const pre = defineSchema({ u: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["admin", "guest"]) }) });
    const target = defineSchema({
      u: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["admin", "visitor"]) }),
    });
    expect(describeOf(pre, target)).toEqual(['Role: variant "visitor" added']);
  });

  test("indexes: drops and non-unique adds render; a clean unique add names the probe result", () => {
    const pre = defineSchema({
      t: defineTable({ id: v.primaryKey(), a: v.string(), b: v.string() }).index("by_a", ["a"]),
    });
    const target = defineSchema({
      t: defineTable({ id: v.primaryKey(), a: v.string(), b: v.string() })
        .index("by_b", ["b"])
        .index("by_ab", ["a", "b"], { unique: true }),
    });
    expect(describeOf(pre, target)).toEqual([
      'index "t.by_a" dropped',
      'unique index "t.by_ab" added (no duplicates found)',
      'index "t.by_b" added',
    ]);
  });

  test("a probed duplicate refusal subtracts its unique index from the safe lines", () => {
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), a: v.string() }) });
    const target = defineSchema({
      t: defineTable({ id: v.primaryKey(), a: v.string() }).index("by_a", ["a"], { unique: true }),
    });
    const probed: SchemaRefusal = {
      table: "t",
      index: "by_a",
      reason: "unique-index-duplicates",
      question: "2 duplicate groups",
      count: 2,
    };
    expect(describeOf(pre, target, [probed])).toEqual([]);
  });
});

describe("planFingerprint", () => {
  const a = snapshotOf(defineSchema({ t: defineTable({ id: v.primaryKey() }) }));
  const b = snapshotOf(defineSchema({ t: defineTable({ id: v.primaryKey(), x: v.string() }) }));

  test("deterministic over the same pair, distinct across pairs", () => {
    expect(planFingerprint(a, b)).toBe(planFingerprint(a, b));
    expect(planFingerprint(a, b)).not.toBe(planFingerprint(a, a));
    expect(planFingerprint(a, b)).not.toBe(planFingerprint(b, a));
  });
});

describe("renderLedger", () => {
  const pre = defineSchema({
    t: defineTable({ id: v.primaryKey(), old: v.string(), gone: v.string() }),
  });
  const target = defineSchema({
    t: defineTable({ id: v.primaryKey(), fresh: v.string(), extra: v.string().nullable() }),
  });

  test("groups refusals, rename candidates, and safe lines under their sections", () => {
    const diff = diffOf(pre, target);
    const refusals = classifySchemaDiff(diff).refusals;
    const text = renderLedger({
      refusals,
      safe: describeSafeChanges(diff, refusals),
      candidates: renameCandidates(diff),
    });
    expect(text).toContain("[dbz] the change ledger:");
    expect(text).toContain("  needs a migration:");
    expect(text).toContain("    - t.gone: column dropped; existing rows would lose data");
    expect(text).toContain("  possible renames (asked before generating):");
    expect(text).toContain('    - column "t.gone" → one of "extra", "fresh"?');
    expect(text).toContain("  applies automatically:");
    expect(text).toContain('    - column "t.extra" added (nullable)');
  });

  test("multiple rename targets render as a choice; empty sections vanish", () => {
    const text = renderLedger({
      refusals: [{ table: "t", column: "a", reason: "column-dropped", question: "column dropped" }],
      safe: [],
      candidates: { tables: { dropped: [], added: [] }, columns: { t: { dropped: ["a"], added: ["x", "y"] } }, variants: {} },
    });
    expect(text).toContain('    - column "t.a" → one of "x", "y"?');
    expect(text).not.toContain("applies automatically");
  });

  test("a ledger with only refusals is just the one section", () => {
    const text = renderLedger({
      refusals: [{ table: "t", reason: "table-dropped", question: "table dropped; existing rows would be lost" }],
      safe: [],
      candidates: { tables: { dropped: [], added: [] }, columns: {}, variants: {} },
    });
    expect(text).toBe("[dbz] the change ledger:\n  needs a migration:\n    - t: table dropped; existing rows would be lost");
  });
});

describe("runConsentForm", () => {
  test("a bare Enter declines — nothing is ever written by default", async () => {
    expect(await runConsentForm("slug", scriptedAsk([""]))).toEqual({ generate: false });
  });

  test("no declines", async () => {
    expect(await runConsentForm("slug", scriptedAsk(["n"]))).toEqual({ generate: false });
  });

  test("yes then Enter accepts the derived name", async () => {
    expect(await runConsentForm("posts_count_retype", scriptedAsk(["y", ""]))).toEqual({
      generate: true,
      name: "posts_count_retype",
    });
  });

  test("yes then a custom name uses it", async () => {
    expect(await runConsentForm("slug", scriptedAsk(["yes", "split_names"]))).toEqual({
      generate: true,
      name: "split_names",
    });
  });

  test("an invalid name re-asks until the loader grammar is met", async () => {
    const ask = scriptedAsk(["y", "bad name!", "good_name"]);
    expect(await runConsentForm("slug", ask)).toEqual({ generate: true, name: "good_name" });
    expect(ask.prompts).toHaveLength(3);
  });

  test("garbage re-asks the consent question itself", async () => {
    const ask = scriptedAsk(["wat", "y", ""]);
    expect(await runConsentForm("slug", ask)).toEqual({ generate: true, name: "slug" });
    expect(ask.prompts[1]).toContain("generate a migration");
  });

  test("a rejecting ask propagates — the interrupt path the caller maps to decline", async () => {
    const interrupted = new Error("interrupted");
    const ask: Ask = () => Promise.reject(interrupted);
    await expect(runConsentForm("slug", ask)).rejects.toBe(interrupted);
    await expect(runDivergenceForm(["/x.ts"], ask)).rejects.toBe(interrupted);
  });
});

describe("runApplyForm", () => {
  test("yes applies; the prompt names every pending migration", async () => {
    const ask = scriptedAsk(["y"]);
    expect(await runApplyForm(["0001_add_slug", "0002_drop_note"], ask)).toBe("apply");
    expect(ask.prompts[0]).toContain("0001_add_slug, 0002_drop_note");
    expect(ask.prompts[0]).toContain("migrations");
  });

  test("a bare Enter waits — applying is never the default", async () => {
    expect(await runApplyForm(["0001_x"], scriptedAsk([""]))).toBe("wait");
    expect(await runApplyForm(["0001_x"], scriptedAsk(["n"]))).toBe("wait");
  });

  test("garbage re-asks", async () => {
    const ask = scriptedAsk(["wat", "yes"]);
    expect(await runApplyForm(["0001_x"], ask)).toBe("apply");
    expect(ask.prompts).toHaveLength(2);
  });
});

describe("runDivergenceForm", () => {
  const FILES = ["/app/migrations/0001_x.ts", "/app/migrations/meta/0001_x.json"];

  test("d deletes; the prompt names every file the deletion would remove", async () => {
    const ask = scriptedAsk(["d"]);
    expect(await runDivergenceForm(FILES, ask)).toBe("delete");
    for (const file of FILES) expect(ask.prompts[0]).toContain(file);
  });

  test("a bare Enter keeps — deletion is never the default", async () => {
    expect(await runDivergenceForm(FILES, scriptedAsk([""]))).toBe("keep");
  });

  test("k and full words work, case-insensitively", async () => {
    expect(await runDivergenceForm(FILES, scriptedAsk(["K"]))).toBe("keep");
    expect(await runDivergenceForm(FILES, scriptedAsk(["DELETE"]))).toBe("delete");
  });

  test("garbage re-asks", async () => {
    const ask = scriptedAsk(["x", "d"]);
    expect(await runDivergenceForm(FILES, ask)).toBe("delete");
    expect(ask.prompts).toHaveLength(2);
  });
});
