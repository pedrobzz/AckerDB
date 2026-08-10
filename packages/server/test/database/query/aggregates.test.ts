import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  defineSchema,
  defineTable,
  ixKey,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  v,
} from "@ackerdb/server";
const schema = defineSchema({
  orders: defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    status: v.enum("AggregateOrderStatus", ["paid", "refunded"]),
    amount: v.int().nullable(),
    price: v.float(),
    total: v.bigint(),
    label: v.string(),
  }).index(["tenantId"]),
  empty: defineTable({
    id: v.primaryKey(),
    amount: v.int().nullable(),
    price: v.float(),
    total: v.bigint(),
    label: v.string(),
  }),
});

describe("query aggregates", () => {
  let dir: string;
  let engine: Engine;
  let db: any;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ackerdb-query-aggregates-"));
    engine = new Engine(schema, join(dir, "data.db"));
    engine.createAll();
    db = makeDbWriter(engine, newWriteCollector(), () => 1n);
    await db.orders.insert({ tenantId: 1n, status: "paid", amount: 10, price: 1.5, total: 10n, label: "b" });
    await db.orders.insert({ tenantId: 1n, status: "paid", amount: 4, price: 2.5, total: 30n, label: "a" });
    await db.orders.insert({ tenantId: 1n, status: "refunded", amount: null, price: 4, total: -5n, label: "z" });
    await db.orders.insert({ tenantId: 2n, status: "paid", amount: 100, price: 8, total: 100n, label: "m" });
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(dir, { recursive: true, force: true });
  });

  test("sums int, float, and bigint columns under filters", async () => {
    const filtered = db.orders.query().where((row: any) => row.tenantId.eq(1n));
    expect(await filtered.sum((row: any) => row.amount)).toBe(14);
    expect(await filtered.sum((row: any) => row.price)).toBe(8);
    expect(await filtered.sum((row: any) => row.total)).toBe(35n);
    expect(await db.orders.query().sum((row: any) => row.amount)).toBe(114);
  });

  test("avg, min, and max respect filters and decode column types", async () => {
    const filtered = db.orders.query().where((row: any) => row.tenantId.eq(1n));
    expect(await filtered.avg((row: any) => row.amount)).toBe(7);
    expect(await filtered.min((row: any) => row.price)).toBe(1.5);
    expect(await filtered.max((row: any) => row.total)).toBe(30n);
    expect(await filtered.min((row: any) => row.label)).toBe("a");
    expect(await filtered.max((row: any) => row.label)).toBe("z");
    expect(await db.orders.query().min((row: any) => row.id)).toBe(1n);
  });

  test("empty sets yield the sum identity and null elsewhere", async () => {
    const none = db.empty.query();
    expect(await none.sum((row: any) => row.amount)).toBe(0);
    expect(await none.sum((row: any) => row.price)).toBe(0);
    expect(await none.sum((row: any) => row.total)).toBe(0n);
    expect(await none.avg((row: any) => row.amount)).toBeNull();
    expect(await none.min((row: any) => row.label)).toBeNull();
    expect(await none.max((row: any) => row.amount)).toBeNull();
  });

  test("NULL values are skipped, and an all-NULL column behaves as empty", async () => {
    await db.empty.insert({ amount: null, price: 0, total: 0n, label: "x" });
    expect(await db.empty.query().sum((row: any) => row.amount)).toBe(0);
    expect(await db.empty.query().avg((row: any) => row.amount)).toBeNull();
    expect(await db.empty.query().min((row: any) => row.amount)).toBeNull();
    const refunded = db.orders.query().where((row: any) => row.status.eq("refunded"));
    expect(await refunded.sum((row: any) => row.amount)).toBe(0);
    expect(await refunded.avg((row: any) => row.amount)).toBeNull();
  });

  test("an exact int sum beyond Number.MAX_SAFE_INTEGER throws instead of losing precision", async () => {
    await db.empty.insert({ amount: Number.MAX_SAFE_INTEGER, price: 0, total: 0n, label: "a" });
    await db.empty.insert({ amount: Number.MAX_SAFE_INTEGER, price: 0, total: 0n, label: "b" });
    await expect(db.empty.query().sum((row: any) => row.amount)).rejects.toThrow(
      "exceeds Number.MAX_SAFE_INTEGER; store it as a bigint column",
    );
  });

  test("a bigint sum beyond the 64-bit range surfaces as a typed error", async () => {
    const max = 2n ** 63n - 1n;
    await db.empty.insert({ amount: null, price: 0, total: max, label: "a" });
    await db.empty.insert({ amount: null, price: 0, total: max, label: "b" });
    await expect(db.empty.query().sum((row: any) => row.total)).rejects.toThrow(
      "exceeds SQLite's 64-bit integer range",
    );
  });

  test("aggregates ignore declared ordering", async () => {
    const value = await db.orders
      .query()
      .where((row: any) => row.tenantId.eq(1n))
      .orderBy((row: any) => row.price.desc())
      .sum((row: any) => row.amount);
    expect(value).toBe(14);
  });

  test("rejects non-aggregable columns and foreign callbacks", async () => {
    await expect(db.orders.query().sum((row: any) => row.label)).rejects.toThrow(
      'column "label" (string) is not supported',
    );
    await expect(db.orders.query().min((row: any) => row.status)).rejects.toThrow(
      'column "status" (enum) is not supported',
    );
    await expect(db.orders.query().sum((row: any) => row.amount.eq(1))).rejects.toThrow(
      "expected a column reference from this table",
    );
    await expect(db.orders.query().avg(42)).rejects.toThrow("expected a column callback");
  });

  test("records the same predicate-level dependencies as count()", async () => {
    const recorded = new Set<string>();
    const reader: any = makeDbReader(engine, engine.reader, {
      add: (dependency: string) => recorded.add(dependency),
    });
    await reader.orders.query().where((row: any) => row.tenantId.eq(1n)).sum((row: any) => row.amount);
    const index = engine.plan("orders").indexes.find((candidate: any) =>
      candidate.columns.length === 1 && candidate.columns[0] === "tenantId"
    )!;
    expect(recorded).toEqual(new Set([ixKey("orders", index.name, [1n])]));
  });


});
