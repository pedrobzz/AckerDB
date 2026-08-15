import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  v,
  defineEventTable,
  defineSchema,
  defineTable,
  Engine,
  idKey,
  indexSqlName,
  ixKey,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  scanKey,
  UniqueConstraintError,
  ValidationError,
  type WriteCollector,
} from "@ackerdb/server";

const schema = () =>
  defineSchema({
    payments: defineTable({
      id: v.primaryKey(),
      userId: v.bigint(),
      status: v.enum("PayStatus", ["active", "failed", "refunded"]),
      amount: v.float(),
      currency: v.string(),
      note: v.string().nullable(),
    })
      .index(["userId"])
      .index(["userId", "status", "amount"]),
    users: defineTable({
      id: v.primaryKey(),
      email: v.string(),
      name: v.string(),
      payload: v.union("UPayload", { text: v.string(), nothing: v.tag() }),
    })
      .index(["email"], { unique: true })
      .index(["payload"]),
    numericRows: defineTable({
      id: v.primaryKey(),
      rank: v.int(),
      maybeRank: v.int().nullable(),
      exact: v.bigint(),
      owner: v.identity(),
    }).index(["rank"]),
    pings: defineEventTable({
      id: v.primaryKey(),
      channel: v.bigint(),
    }, {
      args: {},
      access: "public",
      matches: () => true,
    }),
  });

let dir: string;
let engine: Engine;
let writes: WriteCollector;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let eventSeq: bigint;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ackerdb-db-"));
  engine = new Engine(schema(), join(dir, "data.db"));
  engine.createAll();
  writes = newWriteCollector();
  eventSeq = 0n;
  db = makeDbWriter(engine, writes, () => ++eventSeq);
});
afterEach(() => {
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

const pay = (userId: bigint, status: string, amount: number, currency = "USD") =>
  db.payments.insert({ userId, status, amount, currency, note: null });

describe("writes", () => {
  test("keeps the native wildcard read path for tables without logical ints", () => {
    expect(engine.plan("payments").readProjection).toBe("*");
    expect(engine.plan("users").readProjection).toBe("*");
  });

  test("projects mixed numeric rows explicitly and casts only logical ints", () => {
    expect(engine.plan("numericRows").readProjection).toBe(
      '"id", CAST("rank" AS REAL) AS "rank", CAST("maybeRank" AS REAL) AS "maybeRank", "exact", "owner"',
    );
  });

  test("materializes int columns as numbers without narrowing integer-backed bigint kinds", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const min = Number.MIN_SAFE_INTEGER;
    const exact = 2n ** 63n - 1n;
    const owner = 7n;
    const id = await db.numericRows.insert({
      rank: max,
      maybeRank: null,
      exact,
      owner,
    });

    const materialized: {
      id: string;
      rank: string;
      maybeRank: string;
      exact: string;
      owner: string;
    }[] = [];
    const decodeRow = engine.rowFromSql.bind(engine);
    engine.rowFromSql = (plan, sqlRow) => {
      if (plan.name === "numericRows") {
        materialized.push({
          id: typeof sqlRow["id"],
          rank: typeof sqlRow["rank"],
          maybeRank: sqlRow["maybeRank"] === null ? "null" : typeof sqlRow["maybeRank"],
          exact: typeof sqlRow["exact"],
          owner: typeof sqlRow["owner"],
        });
      }
      return decodeRow(plan, sqlRow);
    };
    let indexedSql: string | undefined;
    const issueStatement = engine.statement.bind(engine);
    engine.statement = (connection, sql) => {
      if (sql.includes('FROM "numericRows"') && sql.includes(" ORDER BY ")) indexedSql = sql;
      return issueStatement(connection, sql);
    };

    const reader: any = makeDbReader(engine, engine.reader, null);
    expect(await reader.numericRows.get(id)).toEqual({
      id,
      rank: max,
      maybeRank: null,
      exact,
      owner,
    });
    const page = await reader.numericRows
      .query()
      .where((row: any) => row.rank.gte(min))
      .orderBy((row: any) => row.rank.asc())
      .paginate({ pageSize: 1 });
    expect(page.items).toEqual([{ id, rank: max, maybeRank: null, exact, owner }]);
    expect(indexedSql).toBeDefined();
    const queryPlan = engine.reader
      .query(`EXPLAIN QUERY PLAN ${indexedSql!}`)
      .all(min) as { detail: string }[];
    const rankIndex = engine.plan("numericRows").indexes[0]!;
    expect(queryPlan.some(({ detail }) =>
      detail.includes(indexSqlName("numericRows", rankIndex.name))
    )).toBe(true);
    expect(queryPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE"))).toBe(false);

    await db.numericRows.patch(id, { maybeRank: min });
    expect(await db.numericRows.get(id)).toEqual({
      id,
      rank: max,
      maybeRank: min,
      exact,
      owner,
    });
    expect(materialized).toEqual([
      { id: "bigint", rank: "number", maybeRank: "null", exact: "bigint", owner: "bigint" },
      { id: "bigint", rank: "number", maybeRank: "null", exact: "bigint", owner: "bigint" },
      { id: "bigint", rank: "number", maybeRank: "null", exact: "bigint", owner: "bigint" },
      { id: "bigint", rank: "number", maybeRank: "number", exact: "bigint", owner: "bigint" },
    ]);
  });

  test("prototype-shaped table and column names remain own runtime entries", async () => {
    const prototypeSchema = defineSchema({
      toString: defineTable({
        constructor: v.primaryKey(),
        toString: v.string(),
      }),
      constructor: defineEventTable({
        toString: v.primaryKey(),
        constructor: v.string(),
      }, {
        args: {},
        access: "public",
        matches: () => true,
      }),
      plain: defineTable({ id: v.primaryKey(), value: v.string() }),
      plainEvents: defineEventTable({ id: v.primaryKey(), value: v.string() }, {
        args: {},
        access: "public",
        matches: () => true,
      }),
    });
    const prototypeEngine = new Engine(prototypeSchema, join(dir, "prototype-names.db"));
    prototypeEngine.createAll();
    const prototypeWrites = newWriteCollector();
    let prototypeEventId = 0n;
    const prototypeDb: any = makeDbWriter(
      prototypeEngine,
      prototypeWrites,
      () => ++prototypeEventId,
    );
    try {
      const snapshot = prototypeEngine.loadSnapshot()!;
      expect(Object.hasOwn(snapshot.tables, "toString")).toBe(true);
      expect(Object.hasOwn(snapshot.tables, "constructor")).toBe(true);
      expect(Object.hasOwn(snapshot.tables["toString"]!.columns, "toString")).toBe(true);
      expect(Object.hasOwn(snapshot.tables["toString"]!.columns, "constructor")).toBe(true);
      expect(Object.hasOwn(prototypeDb, "toString")).toBe(true);
      expect(Object.hasOwn(prototypeDb, "constructor")).toBe(true);

      const id = await prototypeDb.toString.insert({ toString: "before" });
      await prototypeDb.toString.patch(id, { toString: "after" });
      const row = await prototypeDb.toString.get(id);
      expect(row).toEqual({ constructor: 1n, toString: "after" });
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.hasOwn(row, "constructor")).toBe(true);
      expect(Object.hasOwn(row, "toString")).toBe(true);

      await prototypeDb.constructor.insert({ constructor: "event" });
      expect(prototypeWrites.events).toEqual([{
        table: "constructor",
        row: { toString: 1n, constructor: "event" },
      }]);

      await expect(prototypeDb.plain.insert({ value: "x", toString: "unknown" }))
        .rejects.toThrow('plain.insert: unknown field "toString"');
      const plainId = await prototypeDb.plain.insert({ value: "x" });
      await expect(prototypeDb.plain.patch(plainId, { constructor: "unknown" }))
        .rejects.toThrow('plain.patch: unknown field "constructor"');
      await expect(prototypeDb.plainEvents.insert({ value: "x", toString: "unknown" }))
        .rejects.toThrow('plainEvents.insert: unknown field "toString"');

      expect(Object.hasOwn(db, "toString")).toBe(false);
      expect(Object.hasOwn(db, "constructor")).toBe(false);
      expect(db.toString).toBeUndefined();
      expect(db.constructor).toBeUndefined();
    } finally {
      prototypeEngine.close("clean");
    }
  });

  test("enforces constraints on insert, patch, replace, upsert, and event insert", async () => {
    const constrainedSchema = defineSchema({
      articles: defineTable({
        id: v.primaryKey(),
        externalId: v.string(),
        slug: v.string().min(2).max(4).regex(/^[a-z]+$/),
      }).index(["externalId"], { unique: true }),
      articleEvents: defineEventTable({
        id: v.primaryKey(),
        slug: v.string().min(2),
      }, {
        args: {},
        access: "public",
        matches: () => true,
      }),
    });
    const constrainedDir = mkdtempSync(join(tmpdir(), "ackerdb-constrained-writes-"));
    const constrainedEngine = new Engine(constrainedSchema, join(constrainedDir, "data.db"));
    constrainedEngine.createAll();
    const constrainedDb: any = makeDbWriter(
      constrainedEngine,
      newWriteCollector(),
      () => 1n,
    );
    try {
      await expect(constrainedDb.articles.insert({ externalId: "a", slug: "x" }))
        .rejects.toThrow("articles.insert.slug");
      const id = await constrainedDb.articles.insert({ externalId: "a", slug: "good" });
      await expect(constrainedDb.articles.patch(id, { slug: "BAD" }))
        .rejects.toThrow("articles.patch.slug");
      await expect(constrainedDb.articles.replace(id, { externalId: "a", slug: "toolong" }))
        .rejects.toThrow("articles.replace.slug");
      await expect(constrainedDb.articles.upsert(
        { externalId: "b" },
        { slug: "1" },
      )).rejects.toThrow("articles.insert.slug");
      await expect(constrainedDb.articles.upsert(
        { externalId: "a" },
        { slug: "1" },
      )).rejects.toThrow("articles.patch.slug");
      await expect(constrainedDb.articleEvents.insert({ slug: "x" }))
        .rejects.toThrow("articleEvents.insert.slug");
    } finally {
      constrainedEngine.close("clean");
      rmSync(constrainedDir, { recursive: true, force: true });
    }
  });


  test("insert returns sequential bigint ids and validates", async () => {
    expect(await pay(1n, "active", 10)).toBe(1n);
    expect(await pay(1n, "failed", 20)).toBe(2n);
    await expect(db.payments.insert({ userId: 1n })).rejects.toThrow(ValidationError);
    await expect(pay(1n, "bogus", 1)).rejects.toThrow("PayStatus");
    await expect(
      db.payments.insert({ id: 9n, userId: 1n, status: "active", amount: 1, currency: "x" }),
    ).rejects.toThrow("assigned by the database");
  });

  test("patch: null sets NULL, undefined untouched, missing row throws", async () => {
    const id = await pay(1n, "active", 10);
    await db.payments.patch(id, { note: "hello" });
    expect((await db.payments.get(id)).note).toBe("hello");
    await db.payments.patch(id, { note: undefined, amount: 15 });
    expect(await db.payments.get(id)).toMatchObject({ note: "hello", amount: 15 });
    await db.payments.patch(id, { note: null });
    expect((await db.payments.get(id)).note).toBe(null);
    await expect(db.payments.patch(id, { currency: null })).rejects.toThrow(ValidationError);
    await expect(db.payments.patch(999n, { amount: 1 })).rejects.toThrow("not found");
    await expect(db.payments.patch(id, { id: 5n })).rejects.toThrow("primary key");
    await expect(db.payments.patch(id, { nope: 1 })).rejects.toThrow('unknown field "nope"');
  });

  test("replace swaps the whole row; delete is idempotent", async () => {
    const id = await pay(1n, "active", 10);
    await db.payments.replace(id, { userId: 2n, status: "refunded", amount: 1, currency: "BRL", note: null });
    expect(await db.payments.get(id)).toEqual({
      id,
      userId: 2n,
      status: "refunded",
      amount: 1,
      currency: "BRL",
      note: null,
    });
    await db.payments.delete(id);
    expect(await db.payments.get(id)).toBe(null);
    await db.payments.delete(id); // no-op, no throw
  });

  test("deleteMany removes one bounded set and emits keys only for deleted rows", async () => {
    const first = await pay(1n, "active", 10);
    const second = await pay(2n, "failed", 20);
    const survivor = await pay(3n, "active", 30);
    const batchWrites = newWriteCollector();
    const batchDb: any = makeDbWriter(engine, batchWrites, () => ++eventSeq);

    expect(await batchDb.payments.deleteMany([first, second, second, 999n])).toBe(2);
    expect(await batchDb.payments.query().collect()).toEqual([
      expect.objectContaining({ id: survivor }),
    ]);
    expect(batchWrites.keys).toContain(idKey("payments", first));
    expect(batchWrites.keys).toContain(idKey("payments", second));
    expect(batchWrites.keys).not.toContain(idKey("payments", 999n));
    expect(await batchDb.payments.deleteMany([])).toBe(0);
    await expect(batchDb.payments.deleteMany([survivor, 1]))
      .rejects.toThrow("expected bigint ids");
    expect(await batchDb.payments.get(survivor)).toEqual(expect.objectContaining({ id: survivor }));
    const oversizedIds: bigint[] = [];
    for (let index = 0; index < 257; index++) {
      oversizedIds.push(await pay(BigInt(10_000 + index), "active", index));
    }
    await expect(batchDb.payments.deleteMany(oversizedIds))
      .rejects.toThrow("at most 256 distinct ids");
    const remainingIds = new Set(
      (await batchDb.payments.query().collect()).map((row: { id: bigint }) => row.id),
    );
    expect(oversizedIds.every((id) => remainingIds.has(id))).toBe(true);
  });

  test("unique index violations throw UniqueConstraintError and roll nothing forward", async () => {
    await db.users.insert({ email: "a@x.com", name: "A", payload: { tag: "nothing", value: null } });
    await expect(
      db.users.insert({ email: "a@x.com", name: "B", payload: { tag: "nothing", value: null } }),
    ).rejects.toThrow(UniqueConstraintError);
    const b = await db.users.insert({ email: "b@x.com", name: "B", payload: { tag: "nothing", value: null } });
    await expect(db.users.patch(b, { email: "a@x.com" })).rejects.toThrow(UniqueConstraintError);
  });

  test("upsert: insert path, patch path, function form", async () => {
    const id = await db.users.upsert(
      { email: "ana@x.com" },
      { name: "Ana", payload: { tag: "nothing", value: null } },
    );
    expect(await db.users.get(id)).toMatchObject({ email: "ana@x.com", name: "Ana" });
    const same = await db.users.upsert({ email: "ana@x.com" }, { name: "Ana Maria" });
    expect(same).toBe(id);
    expect((await db.users.get(id)).name).toBe("Ana Maria");
    const fn = await db.users.upsert({ email: "ana@x.com" }, (existing: { name: string } | null) => ({
      name: `${existing?.name ?? ""}!`,
    }));
    expect(fn).toBe(id);
    expect((await db.users.get(id)).name).toBe("Ana Maria!");
    // upsert only exists when the table declares a non-null unique index
    expect(db.payments.upsert).toBeUndefined();
  });

  test("existing-row upsert reuses its selected row for the update", async () => {
    await db.users.insert({
      email: "single-read@x.com",
      name: "Before",
      payload: { tag: "nothing", value: null },
    });
    const statement = engine.statement.bind(engine);
    let selects = 0;
    engine.statement = ((connection, sql) => {
      if (sql.startsWith("SELECT ")) selects++;
      return statement(connection, sql);
    }) as typeof engine.statement;

    await db.users.upsert({ email: "single-read@x.com" }, { name: "After" });

    expect(selects).toBe(1);
  });

  test(".returning() resolves to the full written row on every write", async () => {
    // insert: same row a get would produce, no extra read needed
    const inserted = await db.payments
      .insert({ userId: 3n, status: "active", amount: 9, currency: "EUR", note: null })
      .returning();
    expect(inserted).toEqual(await db.payments.get(inserted.id));

    // patch: the updated row; empty patch returns the unchanged row
    const patched = await db.payments.patch(inserted.id, { amount: 11 }).returning();
    expect(patched).toMatchObject({ id: inserted.id, amount: 11, currency: "EUR" });
    const untouched = await db.payments.patch(inserted.id, {}).returning();
    expect(untouched).toEqual(patched);

    // replace: the new row
    const replaced = await db.payments
      .replace(inserted.id, { userId: 4n, status: "failed", amount: 1, currency: "BRL", note: "r" })
      .returning();
    expect(replaced).toEqual({ id: inserted.id, userId: 4n, status: "failed", amount: 1, currency: "BRL", note: "r" });

    // delete: the removed row; idempotent no-op returns null
    const removed = await db.payments.delete(inserted.id).returning();
    expect(removed).toEqual(replaced);
    expect(await db.payments.delete(inserted.id).returning()).toBe(null);

    // upsert: the post-write row on both paths
    const created = await db.users
      .upsert({ email: "w@x.com" }, { name: "W", payload: { tag: "nothing", value: null } })
      .returning();
    expect(created).toMatchObject({ email: "w@x.com", name: "W" });
    const updated = await db.users.upsert({ email: "w@x.com" }, { name: "W2" }).returning();
    expect(updated).toMatchObject({ id: created.id, name: "W2" });
  });

  test("writes execute eagerly and failures reject instead of throwing", async () => {
    // eager: the write is visible before the returned result is awaited
    const pending = db.payments.insert({ userId: 8n, status: "active", amount: 1, currency: "x", note: null });
    expect(await db.payments.query().where((row: any) => row.userId.eq(8n)).count()).toBe(1);
    await pending;

    // validation failures reject the promise — .catch() works on both projections
    const bad = () => db.payments.insert({ userId: 8n });
    expect(await bad().catch((e: Error) => e.message)).toContain("payments.insert");
    expect(await bad().returning().catch((e: Error) => e.message)).toContain("payments.insert");
  });

  test("event table insert buffers a broadcast row, persists nothing", async () => {
    await db.pings.insert({ channel: 7n });
    await db.pings.insert({ channel: 8n });
    expect(writes.events).toEqual([
      { table: "pings", row: { id: 1n, channel: 7n } },
      { table: "pings", row: { id: 2n, channel: 8n } },
    ]);
    expect(engine.writer.query(`SELECT name FROM sqlite_master WHERE name = 'pings'`).get()).toBe(null);
    expect(db.pings.get).toBeUndefined();
    expect(db.pings.query).toBeUndefined();
  });

  test("write keys cover id, scan and every index prefix level", async () => {
    const id = await pay(5n, "active", 100);
    const tag = engine.plan("payments").columns.get("status")!.variantTag!("active")!;
    const [userIndex, compositeIndex] = engine.plan("payments").indexes;
    expect(writes.keys).toEqual(
      new Set([
        idKey("payments", id),
        scanKey("payments"),
        ixKey("payments", userIndex!.name, [5n]),
        ixKey("payments", compositeIndex!.name, [5n]),
        ixKey("payments", compositeIndex!.name, [5n, tag]),
        ixKey("payments", compositeIndex!.name, [5n, tag, 100]),
      ]),
    );
  });
});

describe("reads", () => {
  beforeEach(async () => {
    await pay(1n, "active", 100);
    await pay(1n, "active", 300);
    await pay(1n, "active", 200, "BRL");
    await pay(1n, "failed", 50);
    await pay(2n, "active", 500);
  });

  test("get by primary key", async () => {
    expect((await db.payments.get(1n)).amount).toBe(100);
    expect(await db.payments.get(99n)).toBe(null);
  });


  test("predicates, ordering, and take compose independently from declared indexes", async () => {
    const rows = await db.payments
      .query()
      .where((row: any) =>
        row.userId.eq(1n)
          .and(row.status.eq("active"))
          .and(row.amount.between(150, 400)),
      )
      .orderBy((row: any) => row.amount.asc())
      .collect();
    expect(rows.map((r: any) => r.amount)).toEqual([200, 300]);

    const top = await db.payments
      .query()
      .where((row: any) => row.userId.eq(1n).and(row.status.eq("active")))
      .orderBy((row: any) => row.amount.desc())
      .take(2);
    expect(top.map((r: any) => r.amount)).toEqual([300, 200]);

    const gte = await db.payments
      .query()
      .where((row: any) =>
        row.userId.eq(1n)
          .and(row.status.eq("active"))
          .and(row.amount.gte(200)),
      )
      .orderBy((row: any) => row.amount.asc())
      .collect();
    expect(gte.map((r: any) => r.amount)).toEqual([200, 300]);
  });

  test("first, unique, count, predicates, and iter", async () => {
    expect((await db.payments.query().where((row: any) => row.userId.eq(2n)).first()).amount).toBe(500);
    expect(await db.payments.query().where((row: any) => row.userId.eq(3n)).first()).toBe(null);
    expect((await db.payments.query().where((row: any) => row.userId.eq(2n)).unique()).amount).toBe(500);
    await expect(db.payments.query().where((row: any) => row.userId.eq(1n)).unique()).rejects.toThrow(
      "more than one",
    );
    expect(await db.payments.query().where((row: any) => row.userId.eq(1n)).count()).toBe(4);
    expect(await db.payments.query().count()).toBe(5);
    const brl = await db.payments
      .query()
      .where((row: any) => row.userId.eq(1n).and(row.currency.eq("BRL")))
      .collect();
    expect(brl).toHaveLength(1);
    const seen: number[] = [];
    for await (const row of db.payments.query().where((column: any) => column.userId.eq(1n)).iter()) {
      seen.push(row.amount);
    }
    expect(seen).toEqual([100, 300, 200, 50]);
  });

  test("union columns use an explicit variant predicate", async () => {
    await db.users.insert({ email: "t@x.com", name: "T", payload: { tag: "text", value: "hi" } });
    await db.users.insert({ email: "n@x.com", name: "N", payload: { tag: "nothing", value: null } });
    const texts = await db.users.query().where((row: any) => row.payload.is("text")).collect();
    expect(texts).toHaveLength(1);
    expect(texts[0].payload).toEqual({ tag: "text", value: "hi" });
    expect(() => db.users.query().where((row: any) => row.payload.is("gif"))).toThrow("variant");
  });

  test("read set records precise keys", async () => {
    const reads = new Set<string>();
    const reader: any = makeDbReader(engine, engine.reader, reads);
    await reader.payments.get(1n);
    await reader.payments.query().where((row: any) => row.userId.eq(1n)).collect();
    await reader.payments.query().count();
    const userIndex = engine.plan("payments").indexes[0]!;
    expect(reads).toEqual(
      new Set([
        idKey("payments", 1n),
        ixKey("payments", userIndex.name, [1n]),
        scanKey("payments"),
      ]),
    );
  });

  test("reader sees only committed data (WAL isolation)", async () => {
    const reader: any = makeDbReader(engine, engine.reader, null);
    engine.writer.exec("BEGIN IMMEDIATE");
    await pay(9n, "active", 1);
    expect(await reader.payments.query().where((row: any) => row.userId.eq(9n)).count()).toBe(0);
    engine.writer.exec("COMMIT");
    expect(await reader.payments.query().where((row: any) => row.userId.eq(9n)).count()).toBe(1);
  });
});

describe("pagination", () => {
  test("pages are exact, terminate, and stay consistent under inserts", async () => {
    for (let i = 0; i < 25; i++) await pay(1n, "active", i);
    const q = () => db.payments
      .query()
      .where((row: any) => row.userId.eq(1n).and(row.status.eq("active")))
      .orderBy((row: any) => row.amount.asc());

    const p1 = await q().paginate({ pageSize: 10 });
    expect(p1.items.map((r: any) => r.amount)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p1.nextCursor).not.toBeNull();

    // a row inserted *behind* the cursor must not shift later pages
    await pay(1n, "active", 4.5);

    const p2 = await q().paginate({ cursor: p1.nextCursor, pageSize: 10 });
    expect(p2.items.map((r: any) => r.amount)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const p3 = await q().paginate({ cursor: p2.nextCursor, pageSize: 10 });
    expect(p3.items.map((r: any) => r.amount)).toEqual([20, 21, 22, 23, 24]);
    expect(p3.nextCursor).toBeNull();

    // desc pagination
    const descending = db.payments
      .query()
      .where((row: any) => row.userId.eq(1n).and(row.status.eq("active")))
      .orderBy((row: any) => row.amount.desc());
    const d1 = await descending.paginate({ pageSize: 24 });
    expect(d1.items[0].amount).toBe(24);
    const d2 = await descending.paginate({ cursor: d1.nextCursor, pageSize: 10 });
    expect(d2.items.map((r: any) => r.amount)).toEqual([1, 0]);
    expect(d2.nextCursor).toBeNull();
  });

  test("nullable index columns paginate across the NULL group", async () => {
    const s = defineSchema({
      notes: defineTable({
        id: v.primaryKey(),
        tag: v.string().nullable(),
      }).index(["tag"]),
    });
    const d2 = mkdtempSync(join(tmpdir(), "ackerdb-null-"));
    const e2 = new Engine(s, join(d2, "d.db"));
    e2.createAll();
    const w2 = newWriteCollector();
    const dbn: any = makeDbWriter(e2, w2, () => 0n);
    await dbn.notes.insert({ tag: null });
    await dbn.notes.insert({ tag: null });
    await dbn.notes.insert({ tag: "a" });
    await dbn.notes.insert({ tag: "b" });
    const all: (string | null)[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res: any = await dbn.notes.query().paginate({ cursor, pageSize: 1 });
      all.push(...res.items.map((r: any) => r.tag));
      if (res.nextCursor === null) break;
      cursor = res.nextCursor;
    }
    expect(all).toHaveLength(4);

    const viaIndex: (string | null)[] = [];
    cursor = undefined;
    for (;;) {
      const res: any = await dbn.notes
        .query()
        .orderBy((row: any) => row.tag.asc())
        .paginate({ cursor, pageSize: 1 });
      viaIndex.push(...res.items.map((r: any) => r.tag));
      if (res.nextCursor === null) break;
      cursor = res.nextCursor;
    }
    expect(viaIndex).toEqual([null, null, "a", "b"]); // NULLs group first in ASC
    e2.close("clean");
    rmSync(d2, { recursive: true, force: true });
  });
});
