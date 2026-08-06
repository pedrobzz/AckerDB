import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  defineEventTable,
  defineSchema,
  defineTable,
  filterableFields,
  ixKey,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  scanKey,
  MAX_FILTER_CLAUSES,
  MAX_FILTER_DEPTH,
  v,
  type FilterExpression,
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
    metadata: v.jsonb().nullable(),
  }).index(["level"]),
  vectors: defineTable({
    id: v.primaryKey(),
    embedding: v.vector(3),
  }),
});

const fields = filterableFields(schema.tables.logs!, {
  level: true,
  fn: true,
  durationMs: true,
  count: true,
  requestId: true,
  active: true,
  metadata: true,
  duration: { column: "durationMs" },
});

function okFilter(expression: FilterExpression) {
  const validation = fields.validate(expression);
  if (!validation.ok) {
    throw new Error(`expected a valid filter: ${JSON.stringify(validation.errors)}`);
  }
  return validation.filter;
}

function issuesOf(expression: unknown): readonly { path: string; message: string }[] {
  const validation = fields.validate(expression);
  if (validation.ok) throw new Error("expected validation issues");
  return validation.errors;
}

describe("filterableFields declaration", () => {
  test("rejects unknown and unsupported columns, dotted names, and empty specs", () => {
    expect(() => filterableFields(schema.tables.logs!, {} as never)).toThrow(
      "at least one filterable field",
    );
    expect(() =>
      filterableFields(schema.tables.logs!, { missing: { column: "nope" } } as never),
    ).toThrow('unknown column "nope"');
    expect(() =>
      filterableFields(schema.tables.vectors!, { embedding: true } as never),
    ).toThrow("not filterable");
    expect(() =>
      filterableFields(schema.tables.logs!, { "meta.userId": { column: "metadata" } }),
    ).toThrow("must not contain");
    expect(() => filterableFields({} as never, { level: true })).toThrow(
      "expected a table",
    );
  });

  test("rejects event tables — they never persist rows", () => {
    const clicks = defineEventTable(
      { id: v.primaryKey(), at: v.float() },
      { access: "public", args: {}, matches: () => true },
    );
    expect(() => filterableFields(clicks, { at: true })).toThrow("event table");
  });
});

describe("filter validation returns errors as data", () => {
  test("structural failures carry a path and never throw", () => {
    expect(issuesOf(null)[0]).toEqual({
      path: "$",
      message: "expected a filter expression object",
    });
    expect(issuesOf([])[0]!.path).toBe("$");
    expect(issuesOf({ all: [], any: [] })[0]!.message).toContain("exactly one");
    expect(issuesOf({ field: "level" })[0]!.message).toContain("op");
    expect(issuesOf({ field: "level", op: "like", value: "a" })[0]!.message).toContain(
      "unknown operator",
    );
    expect(issuesOf({ field: "level", op: "eq" })[0]!.message).toContain('"value"');
    expect(issuesOf({ field: "level", op: "anyOf", values: "err" })[0]!.message).toContain(
      "array",
    );
    expect(issuesOf({ field: "level", op: "eq", value: "info", values: [] })[0]!.message)
      .toContain("unexpected");
    expect(issuesOf({ field: "level", op: "anyOf", values: ["info"], value: "x" })[0]!.message)
      .toContain("unexpected");
  });

  test("field failures: unknown fields, paths on scalars, bare JSON columns", () => {
    expect(issuesOf({ field: "nope", op: "eq", value: 1 })[0]).toEqual({
      path: "$.field",
      message: 'unknown filterable field "nope"',
    });
    expect(issuesOf({ field: "level.deep", op: "eq", value: "x" })[0]!.message).toContain(
      "does not support paths",
    );
    expect(issuesOf({ field: "metadata", op: "eq", value: "x" })[0]!.message).toContain(
      "path",
    );
  });

  test("operator and value failures follow column capabilities", () => {
    expect(issuesOf({ field: "active", op: "gt", value: false })[0]!.message).toContain(
      "does not support",
    );
    expect(issuesOf({ field: "level", op: "eq", value: "fatal" })[0]!.path).toBe("$.value");
    expect(issuesOf({ field: "count", op: "eq", value: 1.5 })[0]!.path).toBe("$.value");
    expect(issuesOf({ field: "fn", op: "eq", value: null })[0]!.message).toContain(
      "not nullable",
    );
    expect(issuesOf({ field: "requestId", op: "gt", value: null })[0]!.message).toContain(
      "eq",
    );
    expect(issuesOf({ field: "requestId", op: "anyOf", values: ["a", null] })[0]!.path).toBe(
      "$.values[1]",
    );
    expect(issuesOf({ field: "metadata.k", op: "eq", value: 7n })[0]!.message).toContain(
      "strings, numbers, or booleans",
    );
    expect(issuesOf({ field: 'metadata."bad"', op: "eq", value: 1 })[0]!.path).toBe("$.field");
  });

  test("several failures in one expression are all reported", () => {
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

  test("bounded depth and clause count are contract limits, reported as data", () => {
    let deep: FilterExpression = { field: "fn", op: "eq", value: "x" };
    for (let i = 0; i <= MAX_FILTER_DEPTH; i++) deep = { all: [deep] };
    expect(issuesOf(deep)[0]!.message).toContain("nested deeper");

    const wide = {
      all: Array.from({ length: MAX_FILTER_CLAUSES + 1 }, () => ({
        field: "fn",
        op: "eq" as const,
        value: "x",
      })),
    };
    expect(issuesOf(wide)[0]!.message).toContain("clauses");
  });
});

describe("filter compilation into table queries", () => {
  let dir: string;
  let engine: Engine;
  let db: any;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ackerdb-filter-query-"));
    engine = new Engine(schema, join(dir, "data.db"));
    engine.createAll();
    db = makeDbWriter(engine, newWriteCollector(), () => 1n);
    await db.logs.insert({
      level: "error",
      fn: "orders.create",
      durationMs: 40,
      count: 4n,
      requestId: "r1",
      active: true,
      metadata: { userId: "u1", attempt: 2, flagged: true },
    });
    await db.logs.insert({
      level: "info",
      fn: "orders.create",
      durationMs: 8,
      count: 1n,
      requestId: null,
      active: false,
      metadata: { userId: "u2", attempt: 1, flagged: false },
    });
    await db.logs.insert({
      level: "warn",
      fn: "billing.charge",
      durationMs: 90,
      count: 9n,
      requestId: "r3",
      active: true,
      metadata: null,
    });
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(dir, { recursive: true, force: true });
  });

  async function fns(expression: FilterExpression): Promise<string[]> {
    const rows = await db.logs.query().where(okFilter(expression)).collect();
    return rows.map((row: { fn: string; level: string }) => `${row.level}:${row.fn}`);
  }

  test("column comparisons, aliases, enums, and booleans", async () => {
    expect(await fns({ field: "level", op: "eq", value: "error" })).toEqual([
      "error:orders.create",
    ]);
    expect(await fns({ field: "duration", op: "gte", value: 40 })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await fns({ field: "active", op: "eq", value: false })).toEqual([
      "info:orders.create",
    ]);
    expect(await fns({ field: "count", op: "lt", value: 4n })).toEqual([
      "info:orders.create",
    ]);
    expect(await fns({ field: "level", op: "neq", value: "info" })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
  });

  test("null equality is presence, membership is anyOf/noneOf", async () => {
    expect(await fns({ field: "requestId", op: "eq", value: null })).toEqual([
      "info:orders.create",
    ]);
    expect(await fns({ field: "requestId", op: "neq", value: null })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await fns({ field: "level", op: "anyOf", values: ["warn", "error"] })).toEqual([
      "error:orders.create",
      "warn:billing.charge",
    ]);
    expect(await fns({ field: "level", op: "noneOf", values: ["warn", "error"] })).toEqual([
      "info:orders.create",
    ]);
    expect(await fns({ field: "level", op: "anyOf", values: [] })).toEqual([]);
    expect(await fns({ field: "level", op: "noneOf", values: [] })).toEqual([
      "error:orders.create",
      "info:orders.create",
      "warn:billing.charge",
    ]);
  });

  test("groups compose with OR in the contract and fold empty groups", async () => {
    expect(
      await fns({
        any: [
          { field: "level", op: "eq", value: "error" },
          { all: [
            { field: "fn", op: "eq", value: "billing.charge" },
            { field: "duration", op: "gt", value: 50 },
          ] },
        ],
      }),
    ).toEqual(["error:orders.create", "warn:billing.charge"]);
    expect(await fns({ all: [] })).toEqual([
      "error:orders.create",
      "info:orders.create",
      "warn:billing.charge",
    ]);
    expect(await fns({ any: [] })).toEqual([]);
    expect(await fns({ all: [{ any: [] }] })).toEqual([]);
    expect(await fns({ any: [{ all: [] }] })).toEqual([
      "error:orders.create",
      "info:orders.create",
      "warn:billing.charge",
    ]);
  });

  test("JSON paths evaluate with ->> over jsonb columns", async () => {
    expect(await fns({ field: "metadata.userId", op: "eq", value: "u1" })).toEqual([
      "error:orders.create",
    ]);
    expect(await fns({ field: "metadata.attempt", op: "gt", value: 1 })).toEqual([
      "error:orders.create",
    ]);
    expect(await fns({ field: "metadata.flagged", op: "eq", value: true })).toEqual([
      "error:orders.create",
    ]);
    // Presence: neq null matches only rows where the key exists.
    expect(await fns({ field: "metadata.userId", op: "neq", value: null })).toEqual([
      "error:orders.create",
      "info:orders.create",
    ]);
    expect(await fns({ field: "metadata.userId", op: "eq", value: null })).toEqual([
      "warn:billing.charge",
    ]);
    expect(
      await fns({ field: "metadata.userId", op: "anyOf", values: ["u2", "u9"] }),
    ).toEqual(["info:orders.create"]);
    expect(
      await fns({ field: "metadata.userId", op: "noneOf", values: ["u2"] }),
    ).toEqual(["error:orders.create"]);
  });

  test("filters compose with ordering, pagination, and further predicates", async () => {
    const query = db.logs
      .query()
      .where(okFilter({ field: "duration", op: "gt", value: 5 }))
      .where((row: any) => row.fn.eq("orders.create"))
      .orderBy((row: any) => row.durationMs.desc());
    const first = await query.paginate({ pageSize: 1 });
    expect(first.items.map((row: any) => row.durationMs)).toEqual([40]);
    const second = await query.paginate({ pageSize: 1, cursor: first.nextCursor });
    expect(second.items.map((row: any) => row.durationMs)).toEqual([8]);
    expect(second.nextCursor).toBeNull();
    expect(await query.count()).toBe(2);
  });

  test("filters record the same reactive dependencies as .where callbacks", async () => {
    const reads = new Set<string>();
    const reader: any = makeDbReader(engine, engine.reader, reads);
    const plan = engine.plan("logs");
    const levelIndex = plan.indexes[0]!;
    const errorTag = plan.columns.get("level")!.variantTag!("error")!;

    await reader.logs.query().where(okFilter({ field: "level", op: "eq", value: "error" })).collect();
    expect(reads).toEqual(new Set([ixKey("logs", levelIndex.name, [errorTag])]));

    reads.clear();
    await reader.logs
      .query()
      .where(okFilter({ field: "metadata.userId", op: "eq", value: "u1" }))
      .collect();
    expect(reads).toEqual(new Set([scanKey("logs")]));
  });

  test("a filter validated for another table is rejected at the query", async () => {
    const other = defineSchema({
      logs: defineTable({ id: v.primaryKey(), fn: v.string() }),
    });
    const foreign = filterableFields(other.tables.logs!, { fn: true });
    const validation = foreign.validate({ field: "fn", op: "eq", value: "x" });
    if (!validation.ok) throw new Error("expected ok");
    expect(() => db.logs.query().where(validation.filter)).toThrow(
      "different table",
    );
  });
});
