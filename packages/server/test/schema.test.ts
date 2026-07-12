import { describe, expect, test } from "bun:test";
import {
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  rowTypeName,
  camelCase,
  ValidationError,
} from "@dbzz/server";

const pkCols = () => ({ id: dbz.primaryKey(), name: dbz.string() });

describe("defineTable", () => {
  test("requires exactly one primary key", () => {
    expect(() => defineTable({ name: dbz.string() })).toThrow("exactly one");
    expect(() => defineTable({ a: dbz.primaryKey(), b: dbz.primaryKey() })).toThrow("exactly one");
    expect(defineTable(pkCols()).primaryKey).toBe("id");
  });

  test("rejects reserved column names", () => {
    expect(() => defineTable({ id: dbz.primaryKey(), a__b: dbz.string() })).toThrow("__");
    expect(() => defineTable({ id: dbz.primaryKey(), "1bad": dbz.string() })).toThrow(ValidationError);
  });

  test("index rules: existence, order, kinds, pk, duplicates", () => {
    const table = () =>
      defineTable({
        id: dbz.primaryKey(),
        channelId: dbz.bigint(),
        body: dbz.string(),
        tags: dbz.array(dbz.string()),
      });
    expect(() => table().index("by_missing", ["nope" as never])).toThrow("unknown column");
    expect(() => table().index("by_id", ["id" as never])).toThrow("redundant");
    expect(() => table().index("by_tags", ["tags"])).toThrow("not indexable");
    expect(() => table().index("by_c", ["channelId"]).index("by_c", ["channelId"])).toThrow(
      "duplicate index",
    );
    expect(() => table().index("by_cc", ["channelId", "channelId"])).toThrow("duplicate columns");
    const ok = table().index("by_channel", ["channelId"]).index("by_channel_body", ["channelId", "body"]);
    expect(ok.indexes.map((ix) => ix.name)).toEqual(["by_channel", "by_channel_body"]);
  });

  test("direct indexes: single dense-integer column only", () => {
    const make = () =>
      defineTable({
        id: dbz.primaryKey(),
        seq: dbz.bigint(),
        role: dbz.enum("SRole", ["a", "b"]),
        name: dbz.string(),
      });
    expect(make().index("by_seq", ["seq"], { algorithm: "direct" }).indexes[0]!.algorithm).toBe("direct");
    expect(make().index("by_role", ["role"], { algorithm: "direct" }).indexes[0]!.algorithm).toBe("direct");
    expect(() => make().index("by_name", ["name"], { algorithm: "direct" })).toThrow("dense");
    expect(() => make().index("by_two", ["seq", "role"] as never, { algorithm: "direct" })).toThrow(
      "single-column",
    );
  });

  test("scheduled tables need scheduleAt and vice versa", () => {
    expect(() =>
      defineTable({ id: dbz.primaryKey(), at: dbz.scheduleAt() }),
    ).not.toThrow(); // defineTable alone is fine...
    expect(() =>
      defineSchema({ jobs: defineTable({ id: dbz.primaryKey(), at: dbz.scheduleAt() }) }),
    ).toThrow("no .scheduled"); // ...but the schema demands the handler
    expect(() => defineTable(pkCols()).scheduled("jobs.run")).toThrow("requires a dbz.scheduleAt()");
    const ok = defineTable({ id: dbz.primaryKey(), at: dbz.scheduleAt() }).scheduled("jobs.run");
    expect(ok.scheduledHandler).toBe("jobs.run");
    expect(() =>
      defineTable({ id: dbz.primaryKey(), a: dbz.scheduleAt(), b: dbz.scheduleAt() }),
    ).toThrow("at most one");
  });

  test("event tables: no indexes, no scheduling", () => {
    expect(() => defineEventTable(pkCols()).index("by_name", ["name"])).toThrow("never persist");
    expect(() => defineEventTable(pkCols()).scheduled("x.y")).toThrow("cannot be scheduled");
    expect(() =>
      defineEventTable({ id: dbz.primaryKey(), at: dbz.scheduleAt() }),
    ).toThrow("event tables cannot");
  });
});

describe("defineSchema", () => {
  test("collects named types and rejects conflicting redeclarations", () => {
    const role = dbz.enum("UserRole", ["admin", "member"]);
    const schema = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), role }),
      audits: defineTable({ id: dbz.primaryKey(), role }),
    });
    expect([...schema.namedTypes.keys()]).toEqual(["UserRole"]);

    expect(() =>
      defineSchema({
        users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["a"]) }),
        posts: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["b"]) }),
      }),
    ).toThrow("declared twice");
  });

  test("nested placement rules", () => {
    expect(() =>
      defineSchema({
        t: defineTable({ id: dbz.primaryKey(), o: dbz.object({ inner: dbz.primaryKey() }) }),
      }),
    ).toThrow("top-level column");
    expect(() =>
      defineSchema({
        t: defineTable({ id: dbz.primaryKey(), o: dbz.array(dbz.scheduleAt()) }),
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
        messages: defineTable({ id: dbz.primaryKey(), m: dbz.enum("Message", ["a"]) }),
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

  test("camelCase converts index names", () => {
    expect(camelCase("by_channel_time")).toBe("byChannelTime");
    expect(camelCase("by_user")).toBe("byUser");
    expect(camelCase("byUser")).toBe("byUser");
  });
});
