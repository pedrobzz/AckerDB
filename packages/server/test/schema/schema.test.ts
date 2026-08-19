import { describe, expect, test } from "bun:test";
import {
  v,
  defineEventTable,
  defineSchema,
  defineTable,
  rowTypeName,
  ValidationError,
} from "@ackerdb/server";

const pkCols = () => ({ id: v.primaryKey(), name: v.string() });

describe("defineTable", () => {
  test("requires exactly one primary key", () => {
    expect(() => defineTable({ name: v.string() })).toThrow("exactly one");
    expect(() => defineTable({ a: v.primaryKey(), b: v.primaryKey() })).toThrow("exactly one");
    expect(defineTable(pkCols()).primaryKey).toBe("id");
  });

  test("rejects reserved column names", () => {
    expect(() => defineTable({ id: v.primaryKey(), a__b: v.string() })).toThrow("__");
    expect(() => defineTable({ id: v.primaryKey(), "1bad": v.string() })).toThrow(ValidationError);
  });

  test("rejects column kinds that have no physical storage", () => {
    expect(() => defineTable({ id: v.primaryKey(), x: v.literal(1) as never }))
      .toThrow('column "x": v.literal() has no column storage');
    expect(() => defineTable({ id: v.primaryKey(), x: v.literal(1).nullable() as never }))
      .toThrow('column "x": v.literal() has no column storage');
  });

  test("index rules: existence, order, kinds, pk, duplicates", () => {
    const table = () =>
      defineTable({
        id: v.primaryKey(),
        channelId: v.bigint(),
        body: v.string(),
        tags: v.array(v.string()),
      });
    expect(() => table().index(["nope" as never])).toThrow("unknown column");
    expect(() => table().index(["toString" as never])).toThrow(
      'unknown column "toString"',
    );
    expect(() => table().index(["constructor" as never])).toThrow(
      'unknown column "constructor"',
    );
    expect(() => table().index(["id" as never])).toThrow("redundant");
    expect(() => table().index(["tags"])).toThrow("not indexable");
    expect(() => table().index(["channelId"]).index(["channelId"])).toThrow(
      "duplicate index columns",
    );
    expect(() => table().index(["channelId", "channelId"])).toThrow("duplicate columns");
    const ok = table().index(["channelId"]).index(["channelId", "body"]);
    expect(ok.indexes.map((index) => ({
      name: index.name,
      columns: index.columns,
    }))).toEqual([
      { name: "s_n_9_channelId", columns: ["channelId"] },
      { name: "s_n_9_channelId_4_body", columns: ["channelId", "body"] },
    ]);
  });

  test("full-text declarations accept one explicit set of direct string columns", () => {
    const table = () =>
      defineTable({
        id: v.primaryKey(),
        title: v.string(),
        body: v.string().nullable(),
        count: v.int(),
      });

    expect(table().fullText(["title", "body"]).fullTextColumns).toEqual([
      "title",
      "body",
    ]);
    expect(
      table().fullText(["body"]).index(["title"]).fullTextColumns,
    ).toEqual(["body"]);
    expect(() => table().fullText([])).toThrow("no columns");
    expect(() => table().fullText(["title", "title"])).toThrow(
      "duplicate columns",
    );
    expect(() => table().fullText(["missing" as never])).toThrow(
      'unknown column "missing"',
    );
    expect(() => table().fullText(["count" as never])).toThrow(
      'column "count" (int) is not a string',
    );
    expect(() =>
      defineTable({ id: v.primaryKey(), rank: v.string() }).fullText(["rank"])
    ).toThrow(
      'column name "rank" is reserved by FTS5',
    );
    expect(() =>
      defineTable({ id: v.primaryKey(), rowid: v.string() }).fullText(["rowid"])
    ).toThrow(
      'column name "rowid" is reserved by FTS5',
    );
    expect(() =>
      defineTable({ id: v.primaryKey(), Rank: v.string() }).fullText(["Rank"])
    ).toThrow(
      'column name "Rank" is reserved by FTS5',
    );
    expect(() => table().fullText(["title"]).fullText(["body"])).toThrow(
      "already has a full-text declaration",
    );
  });

  test("v.scheduleAt() is framework-internal", () => {
    expect(() =>
      defineTable({ id: v.primaryKey(), at: v.scheduleAt() }),
    ).not.toThrow(); // defineTable alone is fine (the framework jobs table uses it)...
    expect(() =>
      defineSchema({ jobs: defineTable({ id: v.primaryKey(), at: v.scheduleAt() }) }),
    ).toThrow("framework-internal"); // ...but application schemas refuse it
    expect(() =>
      defineTable({ id: v.primaryKey(), a: v.scheduleAt(), b: v.scheduleAt() }),
    ).toThrow("at most one");
  });

  test("event tables: no indexes, no scheduling", () => {
    const subscription = { args: {}, access: "public" as const, matches: () => true };
    expect(() => defineEventTable(pkCols(), subscription).index(["name"])).toThrow("never persist");
    expect(() => defineEventTable(pkCols(), subscription).fullText(["name"])).toThrow(
      "event tables never persist rows",
    );
    expect(() =>
      defineEventTable({ id: v.primaryKey(), at: v.scheduleAt() }, subscription),
    ).toThrow("event tables cannot");
  });

  test("event tables require a complete subscription contract", () => {
    expect(() => defineEventTable(pkCols(), undefined as never)).toThrow("metadata is required");
    expect(() => defineEventTable(pkCols(), {
      args: {},
      access: "invalid" as never,
      matches: () => true,
    })).toThrow("event subscription access");
    const withPrimaryKeyArg = defineEventTable(pkCols(), {
      args: { id: v.primaryKey() },
      access: "public",
      matches: () => true,
    });
    expect(withPrimaryKeyArg.eventSubscription?.args.decode({ id: "7" }))
      .toEqual({ id: 7n });
    expect(() => defineEventTable(pkCols(), {
      args: {},
      access: "public",
      matches: null as never,
    })).toThrow("matches must be a function");
  });
});

describe("defineSchema", () => {
  test("collects named types and rejects conflicting redeclarations", () => {
    const role = v.enum("UserRole", ["admin", "member"]);
    const schema = defineSchema({
      users: defineTable({ id: v.primaryKey(), role }),
      audits: defineTable({ id: v.primaryKey(), role }),
    });
    expect([...schema.namedTypes.keys()]).toEqual(["UserRole"]);

    expect(() =>
      defineSchema({
        users: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["a"]) }),
        posts: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["b"]) }),
      }),
    ).toThrow("declared twice");
  });

  test("nested placement rules", () => {
    expect(() =>
      defineSchema({
        t: defineTable({ id: v.primaryKey(), o: v.object({ inner: v.primaryKey() }) }),
      }),
    ).toThrow("top-level column");
    expect(() =>
      defineSchema({
        t: defineTable({ id: v.primaryKey(), o: v.array(v.scheduleAt()) }),
      }),
    ).toThrow("top-level column");
  });

  test("generated type name collisions are errors", () => {
    expect(() =>
      defineSchema({
        userConfig: defineTable(pkCols()),
        userConfigs: defineTable(pkCols()),
      }),
    ).toThrow("collides");
    expect(() =>
      defineSchema({
        messages: defineTable({ id: v.primaryKey(), m: v.enum("Message", ["a"]) }),
      }),
    ).toThrow("collides");
  });

  test("table name rules", () => {
    expect(() => defineSchema({ _meta: defineTable(pkCols()) })).toThrow(ValidationError);
  });
});

describe("naming", () => {
  test("rowTypeName pascal-cases and singularizes the last word", () => {
    expect(rowTypeName("messages")).toBe("Message");
    expect(rowTypeName("categories")).toBe("Category");
    expect(rowTypeName("userConfig")).toBe("UserConfig");
    expect(rowTypeName("userTotals")).toBe("UserTotal");
    expect(rowTypeName("statuses")).toBe("Status");
    expect(rowTypeName("address")).toBe("Address");
    expect(rowTypeName("typing_events")).toBe("TypingEvent");
  });

});
