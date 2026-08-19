import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_FILTER_VALUES,
  defineEventTable,
  defineSchema,
  defineTable,
  filterableFields,
  ixKey,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  v,
  type FilterExpression,
  type FilterIssue,
  type TableFilter,
} from "@ackerdb/server";

const schema = defineSchema({
  logs: defineTable({
    id: v.primaryKey(),
    level: v.enum("FilterLogLevel", ["debug", "info", "warn", "error"]),
    fn: v.string(),
    durationMs: v.float(),
    count: v.bigint(),
    requestId: v.string().nullable(),
    active: v.boolean(),
  }).index(["level"]),
  vectors: defineTable({
    id: v.primaryKey(),
    embedding: v.vector(3),
  }),
});

const fields = filterableFields(schema.tables.logs!, [
  "level",
  "fn",
  "durationMs",
  "count",
  "requestId",
  "active",
]);

function okFilter(expression: FilterExpression): TableFilter {
  const validated = fields.validate(expression);
  if (!validated.ok) {
    throw new Error(`expected a valid filter: ${JSON.stringify(validated.error.body.issues)}`);
  }
  return validated.data;
}

function issuesOf(expression: unknown): readonly FilterIssue[] {
  const validated = fields.validate(expression);
  if (validated.ok) throw new Error("expected the expression to be rejected");
  expect(validated.error.kind).toBe("application");
  expect(validated.error.code).toBe("filter.invalid");
  expect(validated.error.status).toBe(400);
  return validated.error.body.issues;
}

describe("filterable field declaration", () => {
  test("rejects unknown columns, uncomparable kinds, duplicates, and empty lists", () => {
    expect(() => filterableFields(schema.tables.logs!, [])).toThrow(
      "at least one filterable column",
    );
    expect(() => filterableFields(schema.tables.logs!, ["nope" as never])).toThrow(
      'unknown column "nope"',
    );
    expect(() => filterableFields(schema.tables.vectors!, ["embedding"])).toThrow(
      "cannot be compared",
    );
    expect(() => filterableFields(schema.tables.logs!, ["fn", "fn"])).toThrow(
      "declared twice",
    );
    expect(() => filterableFields({} as never, ["fn" as never])).toThrow("expected a table");
  });

  test("rejects event tables — they never persist rows", () => {
    const clicks = defineEventTable(
      { id: v.primaryKey(), at: v.float() },
      { access: "public", args: {}, matches: () => true },
    );
    expect(() => filterableFields(clicks, ["at"])).toThrow("event table");
  });
});

describe("filter validation returns its failures as data", () => {
  test("structural failures carry a path and never throw", () => {
    expect(issuesOf(null)[0]).toEqual({
      path: "$",
      message: "expected a filter expression object",
    });
    expect(issuesOf([])[0]!.path).toBe("$");
    expect(issuesOf({ all: [], any: [] })[0]!.message).toContain("exactly one");
    expect(issuesOf({ all: "everything" })[0]!.message).toContain("must be an array");
    expect(issuesOf({ field: "level" })[0]!.message).toContain('"op"');
    expect(issuesOf({ field: "level", op: "like", value: "a" })[0]!.message).toContain(
      "unknown operator",
    );
    expect(issuesOf({ field: "level", op: "eq" })[0]!.message).toContain('"value"');
    expect(issuesOf({ field: "level", op: "anyOf", values: "err" })[0]!.message).toContain(
      "must be an array",
    );
    expect(issuesOf({ field: "level", op: "eq", value: "info", values: [] })[0]!.message)
      .toContain("unexpected key");
    expect(issuesOf({ field: "level", op: "anyOf", values: ["info"], value: "x" })[0]!.message)
      .toContain("unexpected key");
  });

  test("an undeclared field is unknown even when the column exists", () => {
    expect(issuesOf({ field: "id", op: "eq", value: 1n })[0]).toEqual({
      path: "$.field",
      message: 'unknown filterable field "id"',
    });
    expect(issuesOf({ field: "nope", op: "eq", value: 1 })[0]!.path).toBe("$.field");
  });

  test("operator and value failures follow the column's own capabilities", () => {
    expect(issuesOf({ field: "active", op: "gt", value: false })[0]!.message).toContain(
      "does not support",
    );
    expect(issuesOf({ field: "level", op: "eq", value: "fatal" })[0]!.path).toBe("$.value");
    expect(issuesOf({ field: "count", op: "eq", value: 1.5 })[0]!.path).toBe("$.value");
    expect(issuesOf({ field: "fn", op: "eq", value: null })[0]!.message).toContain(
      "not nullable",
    );
    expect(issuesOf({ field: "requestId", op: "gt", value: null })[0]!.message).toContain(
      "test presence",
    );
    expect(issuesOf({ field: "requestId", op: "anyOf", values: ["a", null] })[0]!.path).toBe(
      "$.values[1]",
    );
  });

  test("every failure in one expression is reported, located by path", () => {
    const issues = issuesOf({
      all: [
        { field: "nope", op: "eq", value: 1 },
        { any: [{ field: "level", op: "eq", value: "fatal" }] },
      ],
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "$.all[0].field",
      "$.all[1].any[0].value",
    ]);
  });

  test("depth, node count, and value count are bounds, also reported as data", () => {
    let deep: FilterExpression = { field: "fn", op: "eq", value: "x" };
    for (let level = 0; level <= MAX_FILTER_DEPTH; level++) deep = { all: [deep] };
    expect(issuesOf(deep)[0]!.message).toContain("nest deeper");

    const wide = {
      all: Array.from({ length: MAX_FILTER_NODES }, () => ({
        field: "fn",
        op: "eq" as const,
        value: "x",
      })),
    };
    expect(issuesOf(wide)[0]!.message).toContain(`at most ${MAX_FILTER_NODES}`);
    // Groups count too, so a wall of empty groups cannot buy an unbounded walk.
    expect(
      issuesOf({ all: Array.from({ length: MAX_FILTER_NODES }, () => ({ all: [] })) })[0]!
        .message,
    ).toContain(`at most ${MAX_FILTER_NODES}`);

    // A group far past the bound is not walked past it: one issue, at the node
    // that overran, and nothing read behind it.
    const huge = issuesOf({
      all: Array.from({ length: MAX_FILTER_NODES * 50 }, () => ({ all: [] })),
    });
    expect(huge).toHaveLength(1);
    expect(huge[0]!.path).toBe(`$.all[${MAX_FILTER_NODES - 1}]`);
  });

  test("membership members are values, so one clause cannot outrun SQLite", () => {
    const members = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, index) => `fn-${index}`);
    const issues = issuesOf({ field: "fn", op: "anyOf", values: members });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      path: `$.values[${MAX_FILTER_VALUES}]`,
      message: `a filter may hold at most ${MAX_FILTER_VALUES} values`,
    });

    // The budget is the whole expression's, not one clause's.
    const half = Math.ceil(MAX_FILTER_VALUES / 2) + 1;
    expect(
      issuesOf({
        all: [
          { field: "fn", op: "anyOf", values: members.slice(0, half) },
          { field: "fn", op: "anyOf", values: members.slice(0, half) },
        ],
      })[0]!.message,
    ).toContain(`at most ${MAX_FILTER_VALUES} values`);

    // A rejected member list reports its bound, never a per-member issue wall.
    expect(
      issuesOf({
        field: "fn",
        op: "anyOf",
        values: Array.from({ length: MAX_FILTER_VALUES * 4 }, () => null),
      }),
    ).toHaveLength(MAX_FILTER_VALUES + 1);

    // Exactly at the bound the filter is valid and compiles.
    const exact = fields.validate({
      field: "fn",
      op: "anyOf",
      values: members.slice(0, MAX_FILTER_VALUES),
    });
    expect(exact.ok).toBe(true);
  });
});

describe("a validated filter is an ordinary predicate", () => {
  let directory: string;
  let engine: Engine;
  let db: any;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-query-filter-"));
    engine = new Engine(schema, join(directory, "data.db"));
    engine.createAll();
    db = makeDbWriter(engine, newWriteCollector(), () => 1n);
    await db.logs.insert({
      level: "error",
      fn: "orders.create",
      durationMs: 40,
      count: 4n,
      requestId: "r1",
      active: true,
    });
    await db.logs.insert({
      level: "info",
      fn: "orders.create",
      durationMs: 8,
      count: 1n,
      requestId: null,
      active: false,
    });
    await db.logs.insert({
      level: "warn",
      fn: "billing.charge",
      durationMs: 90,
      count: 9n,
      requestId: "r3",
      active: true,
    });
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  async function matches(expression: FilterExpression): Promise<string[]> {
    const rows = await db.logs.query().where(okFilter(expression)).collect();
    return rows.map((row: { fn: string; level: string }) => `${row.level}:${row.fn}`);
  }

  test("comparisons cross the column's validator and storage codec", async () => {
    expect(await matches({ field: "level", op: "eq", value: "error" })).toEqual([
      "error:orders.create",
    ]);
    expect(await matches({ field: "level", op: "neq", value: "info" })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await matches({ field: "durationMs", op: "gte", value: 40 })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await matches({ field: "durationMs", op: "lte", value: 8 })).toEqual([
      "info:orders.create",
    ]);
    expect(await matches({ field: "count", op: "lt", value: 4n })).toEqual([
      "info:orders.create",
    ]);
    expect(await matches({ field: "count", op: "gt", value: 4n })).toEqual([
      "warn:billing.charge",
    ]);
    expect(await matches({ field: "active", op: "eq", value: false })).toEqual([
      "info:orders.create",
    ]);
  });

  test("null equality tests presence; membership is anyOf and noneOf", async () => {
    expect(await matches({ field: "requestId", op: "eq", value: null })).toEqual([
      "info:orders.create",
    ]);
    expect(await matches({ field: "requestId", op: "neq", value: null })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await matches({ field: "level", op: "anyOf", values: ["warn", "error"] })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await matches({ field: "level", op: "noneOf", values: ["warn", "error"] })).toEqual([
      "info:orders.create",
    ]);
    expect(await matches({ field: "level", op: "anyOf", values: [] })).toEqual([]);
    expect(await matches({ field: "level", op: "noneOf", values: [] })).toEqual([
      "error:orders.create",
      "info:orders.create",
      "warn:billing.charge",
    ]);
  });

  test("groups compose with OR, and empty groups keep their exact meaning", async () => {
    expect(
      await matches({
        any: [
          { field: "level", op: "eq", value: "error" },
          {
            all: [
              { field: "fn", op: "eq", value: "billing.charge" },
              { field: "durationMs", op: "gt", value: 50 },
            ],
          },
        ],
      }),
    ).toEqual(["error:orders.create", "warn:billing.charge"]);
    expect(await matches({ all: [] })).toEqual([
      "error:orders.create",
      "info:orders.create",
      "warn:billing.charge",
    ]);
    expect(await matches({ any: [] })).toEqual([]);
    expect(await matches({ all: [{ any: [] }] })).toEqual([]);
    expect(await matches({ any: [{ all: [] }] })).toEqual([
      "error:orders.create",
      "info:orders.create",
      "warn:billing.charge",
    ]);
  });

  test("a filter composes with callbacks, ordering, pagination, and aggregates", async () => {
    const query = db.logs
      .query()
      .where(okFilter({ field: "durationMs", op: "gt", value: 5 }))
      .where((row: any) => row.fn.eq("orders.create"))
      .orderBy((row: any) => row.durationMs.desc());

    const first = await query.paginate({ pageSize: 1 });
    expect(first.items.map((row: any) => row.durationMs)).toEqual([40]);
    const second = await query.paginate({ pageSize: 1, cursor: first.nextCursor });
    expect(second.items.map((row: any) => row.durationMs)).toEqual([8]);
    expect(second.nextCursor).toBeNull();
    expect(await query.count()).toBe(2);
    expect(await query.sum((row: any) => row.durationMs)).toBe(48);
  });

  test("a filter records the same reactive dependency a callback would", async () => {
    const plan = engine.plan("logs");
    const levelIndex = plan.indexes[0]!;
    const errorTag = plan.columns.get("level")!.toSql("error") as number;
    const recorded = async (where: unknown): Promise<Set<string>> => {
      const reads = new Set<string>();
      const reader: any = makeDbReader(engine, engine.reader, {
        add: (dependency: string) => reads.add(dependency),
      });
      await reader.logs.query().where(where).collect();
      return reads;
    };

    const expected = new Set([ixKey("logs", levelIndex.name, [errorTag])]);
    expect(await recorded(okFilter({ field: "level", op: "eq", value: "error" }))).toEqual(
      expected,
    );
    expect(await recorded((row: any) => row.level.eq("error"))).toEqual(expected);
  });

  test("a filter validated for another table is rejected at the query", () => {
    const other = defineSchema({
      logs: defineTable({ id: v.primaryKey(), fn: v.string() }),
    });
    const foreign = filterableFields(other.tables.logs!, ["fn"]);
    const validated = foreign.validate({ field: "fn", op: "eq", value: "x" });
    if (!validated.ok) throw new Error("expected a valid filter");
    expect(() => db.logs.query().where(validated.data)).toThrow("different table");
  });
});
