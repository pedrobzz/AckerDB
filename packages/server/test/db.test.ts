import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  Engine,
  idKey,
  ixKey,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  scanKey,
  UniqueConstraintError,
  ValidationError,
  type WriteCollector,
} from "@dbzz/server";
import type { DbStatementObservation, DbStatementObserver } from "../src/db.ts";

const schema = () =>
  defineSchema({
    payments: defineTable({
      id: dbz.primaryKey(),
      userId: dbz.bigint(),
      status: dbz.enum("PayStatus", ["active", "failed", "refunded"]),
      amount: dbz.number(),
      currency: dbz.string(),
      note: dbz.nullable(dbz.string()),
    })
      .index("by_user", ["userId"])
      .index("by_user_status_amount", ["userId", "status", "amount"]),
    users: defineTable({
      id: dbz.primaryKey(),
      email: dbz.string(),
      name: dbz.string(),
      payload: dbz.union("UPayload", { text: dbz.string(), nothing: dbz.tag() }),
    })
      .index("by_email", ["email"], { unique: true })
      .index("by_payload", ["payload"]),
    pings: defineEventTable({
      id: dbz.primaryKey(),
      channel: dbz.bigint(),
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
  dir = mkdtempSync(join(tmpdir(), "dbzz-db-"));
  engine = new Engine(schema(), join(dir, "data.db"));
  engine.createAll();
  writes = newWriteCollector();
  eventSeq = 0n;
  db = makeDbWriter(engine, writes, () => ++eventSeq);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const pay = (userId: bigint, status: string, amount: number, currency = "USD") =>
  db.payments.insert({ userId, status, amount, currency, note: null });

const observedDb = (observer: DbStatementObserver): any =>
  makeDbWriter(engine, newWriteCollector(), () => ++eventSeq, observer);

describe("writes", () => {
  test("observes frozen safe summaries and observer failures stay fail-open", async () => {
    const canary = "never-export-this-row";
    const observations: DbStatementObservation[] = [];
    const observed = observedDb((observation) => observations.push(observation));
    const id = await observed.payments.insert({
      userId: 1n,
      status: "active",
      amount: 10,
      currency: "USD",
      note: canary,
    });
    await observed.payments.get(id);
    await observed.payments.scan().collect();
    await observed.payments.delete(id);

    expect(observations.map((observation) => observation.statement)).toEqual([
      "insert",
      "get",
      "collect",
      "delete",
    ]);
    expect(observations).toEqual(observations.map((observation) => expect.objectContaining({
      table: "payments",
      outcome: "ok",
      durationMs: expect.any(Number),
      rowCount: 1,
    })));
    expect(observations.every(Object.isFrozen)).toBe(true);
    const allowedKeys = new Set([
      "kind",
      "table",
      "statement",
      "outcome",
      "durationMs",
      "rowCount",
    ]);
    expect(observations.every((observation) =>
      Object.keys(observation).every((key) => allowedKeys.has(key))
    )).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(canary);

    let observerCalls = 0;
    const failOpen = observedDb(() => {
      if (++observerCalls === 1) throw new Error("telemetry failed synchronously");
      return Promise.reject(new Error("telemetry failed asynchronously"));
    });
    await expect(failOpen.payments.insert({
      userId: 2n,
      status: "active",
      amount: 20,
      currency: "BRL",
      note: null,
    })).resolves.toBeGreaterThan(0n);
    await expect(failOpen.payments.insert({
      userId: 3n,
      status: "active",
      amount: 30,
      currency: "BRL",
      note: null,
    })).resolves.toBeGreaterThan(0n);
    await Promise.resolve();
    expect(observerCalls).toBe(2);
  });

  test("upsert is the sole observation owner on insert, patch, and failure", async () => {
    const observations: DbStatementObservation[] = [];
    const observed = observedDb((observation) => observations.push(observation));
    const key = { email: "owner@x.com" };
    const inserted = await observed.users.byEmail.upsert(key, {
      name: "Owner",
      payload: { tag: "nothing", value: null },
    }).returning();
    await observed.users.byEmail.upsert(key, { name: "Updated" });
    await expect(observed.users.byEmail.upsert(key, () => {
      throw new Error("resolver failed");
    })).rejects.toThrow("resolver failed");

    expect(inserted).toMatchObject({ email: key.email, name: "Owner" });
    expect(observations.map(({ statement, outcome, rowCount }) => ({
      statement,
      outcome,
      rowCount,
    }))).toEqual([
      { statement: "upsert", outcome: "ok", rowCount: 1 },
      { statement: "upsert", outcome: "ok", rowCount: 1 },
      { statement: "upsert", outcome: "failed", rowCount: undefined },
    ]);
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

  test("unique index violations throw UniqueConstraintError and roll nothing forward", async () => {
    await db.users.insert({ email: "a@x.com", name: "A", payload: { tag: "nothing", value: null } });
    await expect(
      db.users.insert({ email: "a@x.com", name: "B", payload: { tag: "nothing", value: null } }),
    ).rejects.toThrow(UniqueConstraintError);
    const b = await db.users.insert({ email: "b@x.com", name: "B", payload: { tag: "nothing", value: null } });
    await expect(db.users.patch(b, { email: "a@x.com" })).rejects.toThrow(UniqueConstraintError);
  });

  test("upsert: insert path, patch path, function form", async () => {
    const id = await db.users.byEmail.upsert(
      { email: "ana@x.com" },
      { name: "Ana", payload: { tag: "nothing", value: null } },
    );
    expect(await db.users.get(id)).toMatchObject({ email: "ana@x.com", name: "Ana" });
    const same = await db.users.byEmail.upsert({ email: "ana@x.com" }, { name: "Ana Maria" });
    expect(same).toBe(id);
    expect((await db.users.get(id)).name).toBe("Ana Maria");
    const fn = await db.users.byEmail.upsert({ email: "ana@x.com" }, (existing: { name: string } | null) => ({
      name: `${existing?.name ?? ""}!`,
    }));
    expect(fn).toBe(id);
    expect((await db.users.get(id)).name).toBe("Ana Maria!");
    // upsert only exists on unique accessors
    expect(db.payments.byUser.upsert).toBeUndefined();
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
    const created = await db.users.byEmail
      .upsert({ email: "w@x.com" }, { name: "W", payload: { tag: "nothing", value: null } })
      .returning();
    expect(created).toMatchObject({ email: "w@x.com", name: "W" });
    const updated = await db.users.byEmail.upsert({ email: "w@x.com" }, { name: "W2" }).returning();
    expect(updated).toMatchObject({ id: created.id, name: "W2" });
  });

  test("writes execute eagerly and failures reject instead of throwing", async () => {
    // eager: the write is visible before the returned result is awaited
    const pending = db.payments.insert({ userId: 8n, status: "active", amount: 1, currency: "x", note: null });
    expect(await db.payments.byUser((q: any) => q.eq("userId", 8n)).count()).toBe(1);
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
    expect(db.pings.scan).toBeUndefined();
  });

  test("write keys cover id, scan and every index prefix level", async () => {
    const id = await pay(5n, "active", 100);
    const tag = engine.tags.get("PayStatus")!.toTag.get("active")!;
    expect(writes.keys).toEqual(
      new Set([
        idKey("payments", id),
        scanKey("payments"),
        ixKey("payments", "by_user", [5n]),
        ixKey("payments", "by_user_status_amount", [5n]),
        ixKey("payments", "by_user_status_amount", [5n, tag]),
        ixKey("payments", "by_user_status_amount", [5n, tag, 100]),
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

  test("each public read materializer owns exactly one success or failure observation", async () => {
    const observations: DbStatementObservation[] = [];
    const observed = observedDb((observation) => observations.push(observation));

    await observed.payments.scan().collect();
    await observed.payments.scan().take(2);
    await observed.payments.byUser((q: any) => q.eq("userId", 2n)).first();
    await observed.payments.byUser((q: any) => q.eq("userId", 2n)).unique();
    await observed.payments.scan().count();
    await observed.payments.scan().filter((row: any) => row.currency === "BRL").count();
    await observed.payments.scan().paginate({ cursor: null, numItems: 2 });

    let iterated = 0;
    for await (const _row of observed.payments.scan().iter()) iterated++;
    expect(iterated).toBe(5);
    for await (const _row of observed.payments.scan().iter()) break;

    await expect(
      observed.payments.byUser((q: any) => q.eq("userId", 1n)).unique(),
    ).rejects.toThrow("more than one");
    const failedIter = observed.payments.scan().filter(() => {
      throw new Error("filter failed");
    }).iter();
    await expect(failedIter.next()).rejects.toThrow("filter failed");

    expect(observations.map(({ statement, outcome, rowCount }) => ({
      statement,
      outcome,
      rowCount,
    }))).toEqual([
      { statement: "collect", outcome: "ok", rowCount: 5 },
      { statement: "take", outcome: "ok", rowCount: 2 },
      { statement: "first", outcome: "ok", rowCount: 1 },
      { statement: "unique", outcome: "ok", rowCount: 1 },
      { statement: "count", outcome: "ok", rowCount: 5 },
      { statement: "count", outcome: "ok", rowCount: 1 },
      { statement: "paginate", outcome: "ok", rowCount: 2 },
      { statement: "iter", outcome: "ok", rowCount: 5 },
      { statement: "iter", outcome: "ok", rowCount: 1 },
      { statement: "unique", outcome: "failed", rowCount: undefined },
      { statement: "iter", outcome: "failed", rowCount: undefined },
    ]);
  });

  test("index eq + range + order + take compose", async () => {
    const rows = await db.payments
      .byUserStatusAmount((q: any) => q.eq("userId", 1n).eq("status", "active").between("amount", 150, 400))
      .collect();
    expect(rows.map((r: any) => r.amount)).toEqual([200, 300]);

    const top = await db.payments
      .byUserStatusAmount((q: any) => q.eq("userId", 1n).eq("status", "active"))
      .order("desc")
      .take(2);
    expect(top.map((r: any) => r.amount)).toEqual([300, 200]);

    const gte = await db.payments
      .byUserStatusAmount((q: any) => q.eq("userId", 1n).eq("status", "active").gte("amount", 200))
      .collect();
    expect(gte.map((r: any) => r.amount)).toEqual([200, 300]);
  });

  test("first, unique, count, filter, iter, scan", async () => {
    expect((await db.payments.byUser((q: any) => q.eq("userId", 2n)).first()).amount).toBe(500);
    expect(await db.payments.byUser((q: any) => q.eq("userId", 3n)).first()).toBe(null);
    expect((await db.payments.byUser((q: any) => q.eq("userId", 2n)).unique()).amount).toBe(500);
    await expect(db.payments.byUser((q: any) => q.eq("userId", 1n)).unique()).rejects.toThrow(
      "more than one",
    );
    expect(await db.payments.byUser((q: any) => q.eq("userId", 1n)).count()).toBe(4);
    expect(await db.payments.scan().count()).toBe(5);
    const brl = await db.payments
      .byUser((q: any) => q.eq("userId", 1n))
      .filter((p: any) => p.currency === "BRL")
      .collect();
    expect(brl).toHaveLength(1);
    const seen: number[] = [];
    for await (const row of db.payments.byUser((q: any) => q.eq("userId", 1n)).iter()) {
      seen.push(row.amount);
    }
    expect(seen).toEqual([100, 300, 200, 50]);
  });

  test("nested reads inside filters do not corrupt the outer scan", async () => {
    const rows = await db.payments
      .scan()
      .filter(() => {
        // same-shape nested read mid-iteration
        void db.payments.scan().collect();
        return true;
      })
      .collect();
    expect(rows).toHaveLength(5);
  });

  test("builder misuse throws with guidance", async () => {
    expect(() => db.payments.byUserStatusAmount((q: any) => q.eq("status", "active"))).toThrow(
      'expected column "userId"',
    );
    expect(() =>
      db.payments.byUserStatusAmount((q: any) => q.eq("userId", 1n).gte("status", "active")),
    ).toThrow("not meaningful");
    expect(() =>
      db.payments.byUserStatusAmount((q: any) => q.eq("userId", 1n).gte("amount", 1)),
    ).toThrow('expected column "status"');
    expect(() =>
      db.payments.byUserStatusAmount((q: any) =>
        q.eq("userId", 1n).eq("status", "active").gte("amount", 1).lt("amount", 2),
      ),
    ).toThrow("nothing can follow the range");
  });

  test("union columns: eq by variant name", async () => {
    await db.users.insert({ email: "t@x.com", name: "T", payload: { tag: "text", value: "hi" } });
    await db.users.insert({ email: "n@x.com", name: "N", payload: { tag: "nothing", value: null } });
    const texts = await db.users.byPayload((q: any) => q.eq("payload", "text")).collect();
    expect(texts).toHaveLength(1);
    expect(texts[0].payload).toEqual({ tag: "text", value: "hi" });
    expect(() => db.users.byPayload((q: any) => q.eq("payload", "gif"))).toThrow("variant");
  });

  test("read set records precise keys", async () => {
    const reads = new Set<string>();
    const reader: any = makeDbReader(engine, engine.reader, reads);
    await reader.payments.get(1n);
    await reader.payments.byUser((q: any) => q.eq("userId", 1n)).collect();
    await reader.payments.scan().count();
    expect(reads).toEqual(
      new Set([
        idKey("payments", 1n),
        ixKey("payments", "by_user", [1n]),
        scanKey("payments"),
      ]),
    );
  });

  test("reader sees only committed data (WAL isolation)", async () => {
    const reader: any = makeDbReader(engine, engine.reader, null);
    engine.writer.exec("BEGIN IMMEDIATE");
    await pay(9n, "active", 1);
    expect(await reader.payments.byUser((q: any) => q.eq("userId", 9n)).count()).toBe(0);
    engine.writer.exec("COMMIT");
    expect(await reader.payments.byUser((q: any) => q.eq("userId", 9n)).count()).toBe(1);
  });
});

describe("pagination", () => {
  test("pages are exact, terminate, and stay consistent under inserts", async () => {
    for (let i = 0; i < 25; i++) await pay(1n, "active", i);
    const q = () => db.payments.byUserStatusAmount((q: any) => q.eq("userId", 1n).eq("status", "active"));

    const p1 = await q().paginate({ cursor: null, numItems: 10 });
    expect(p1.page.map((r: any) => r.amount)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p1.isDone).toBe(false);

    // a row inserted *behind* the cursor must not shift later pages
    await pay(1n, "active", 4.5);

    const p2 = await q().paginate({ cursor: p1.continueCursor, numItems: 10 });
    expect(p2.page.map((r: any) => r.amount)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const p3 = await q().paginate({ cursor: p2.continueCursor, numItems: 10 });
    expect(p3.page.map((r: any) => r.amount)).toEqual([20, 21, 22, 23, 24]);
    expect(p3.isDone).toBe(true);

    // desc pagination
    const d1 = await q().order("desc").paginate({ cursor: null, numItems: 24 });
    expect(d1.page[0].amount).toBe(24);
    const d2 = await q().order("desc").paginate({ cursor: d1.continueCursor, numItems: 10 });
    expect(d2.page.map((r: any) => r.amount)).toEqual([1, 0]);
    expect(d2.isDone).toBe(true);
  });

  test("nullable index columns paginate across the NULL group", async () => {
    const s = defineSchema({
      notes: defineTable({
        id: dbz.primaryKey(),
        tag: dbz.nullable(dbz.string()),
      }).index("by_tag", ["tag"]),
    });
    const d2 = mkdtempSync(join(tmpdir(), "dbzz-null-"));
    const e2 = new Engine(s, join(d2, "d.db"));
    e2.createAll();
    const w2 = newWriteCollector();
    const dbn: any = makeDbWriter(e2, w2, () => 0n);
    await dbn.notes.insert({ tag: null });
    await dbn.notes.insert({ tag: null });
    await dbn.notes.insert({ tag: "a" });
    await dbn.notes.insert({ tag: "b" });
    const all: (string | null)[] = [];
    let cursor: string | null = null;
    for (;;) {
      const res: any = await dbn.notes.scan().paginate({ cursor, numItems: 1 });
      // scan paginates by pk; also exercise the index path below
      all.push(...res.page.map((r: any) => r.tag));
      cursor = res.continueCursor;
      if (res.isDone) break;
    }
    expect(all).toHaveLength(4);

    const viaIndex: (string | null)[] = [];
    cursor = null;
    for (;;) {
      const res: any = await dbn.notes.byTag((q: any) => q).paginate({ cursor, numItems: 1 });
      viaIndex.push(...res.page.map((r: any) => r.tag));
      cursor = res.continueCursor;
      if (res.isDone) break;
    }
    expect(viaIndex).toEqual([null, null, "a", "b"]); // NULLs group first in ASC
    e2.close();
    rmSync(d2, { recursive: true, force: true });
  });
});
