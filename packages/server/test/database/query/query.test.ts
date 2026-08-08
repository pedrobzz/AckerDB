import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  MAX_PAGE_BYTES,
  MAX_PAGE_SIZE,
  UniqueConstraintError,
  defineSchema,
  defineTable,
  makeDbWriter,
  makeDbReader,
  newWriteCollector,
  ixKey,
  v,
} from "@ackerdb/server";
import { compilePredicates } from "../../../src/database/query/predicate.ts";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    status: v.enum("QueryDocumentStatus", ["active", "archived"]),
    score: v.float(),
    label: v.string(),
    rank: v.int().nullable(),
    flag: v.boolean().nullable(),
    bounded: v.int().min(0).max(10).nullable(),
    boundedBigint: v.bigint().min(0n).max(10n).nullable(),
    owner: v.identity().nullable(),
    code: v.string().min(2).nullable(),
  }).index(["tenantId", "status"]),
  users: defineTable({
    id: v.primaryKey(),
    email: v.string(),
    handle: v.string(),
    externalId: v.string().nullable(),
    name: v.string(),
  })
    .index(["email"], { unique: true })
    .index(["handle"], { unique: true })
    .index(["externalId"], { unique: true })
    .index(["email", "handle"], { unique: true })
    .index(["handle", "email"], { unique: true }),
  unionKeys: defineTable({
    id: v.primaryKey(),
    slug: v.string(),
    key: v.union("RuntimeUnionKey", {
      text: v.string(),
      count: v.int(),
      empty: v.tag(),
    }),
    name: v.string(),
  })
    .index(["slug"], { unique: true })
    .index(["key"], { unique: true }),
});

describe("table query", () => {
  let dir: string;
  let engine: Engine;
  let db: any;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ackerdb-table-query-"));
    engine = new Engine(schema, join(dir, "data.db"));
    engine.createAll();
    db = makeDbWriter(engine, newWriteCollector(), () => 1n);
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(dir, { recursive: true, force: true });
  });

  test("filters in SQLite and orders independently from declared indexes", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "b", rank: null });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: 2 });
    await db.documents.insert({ tenantId: 1n, status: "archived", score: 10, label: "ignored", rank: 1 });
    await db.documents.insert({ tenantId: 2n, status: "active", score: 20, label: "ignored", rank: 1 });

    const rows = await db.documents
      .query()
      .where((row: any) => row.tenantId.eq(1n).and(row.status.eq("active")))
      .orderBy((row: any) => row.score.desc())
      .thenBy((row: any) => row.label.asc())
      .collect();

    expect(rows.map((row: any) => row.label)).toEqual(["a", "b"]);
    expect(db.documents.scan).toBeUndefined();
    expect(db.documents.byTenantIdStatus).toBeUndefined();
  });

  test("lets SQLite select a declared composite index without naming it in the query", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: null });
    let issuedSql: string | undefined;
    const statement = engine.statement.bind(engine);
    engine.statement = (connection, sql) => {
      if (sql.includes('FROM "documents"') && sql.includes('"tenantId" = ?')) issuedSql = sql;
      return statement(connection, sql);
    };

    await db.documents
      .query()
      .where((row: any) => row.tenantId.eq(1n).and(row.status.eq("active")))
      .take(1);

    expect(issuedSql).toBeDefined();
    const statusTag = engine.tagMap(engine.plan("documents"), "QueryDocumentStatus").toTag.get("active")!;
    const plan = engine.reader
      .query(`EXPLAIN QUERY PLAN ${issuedSql!}`)
      .all(1n, statusTag) as { detail: string }[];
    const physicalIndex = `ix_documents_${engine.plan("documents").indexes[0]!.name}`;
    expect(plan.some(({ detail }) => detail.includes(physicalIndex))).toBe(true);
  });

  test("records the strongest declared-index prefix for predicate reads", async () => {
    const dependencies = new Set<string>();
    const reader: any = makeDbReader(engine, engine.reader, {
      add: (key: string) => dependencies.add(key),
    });

    await reader.documents
      .query()
      .where((row: any) => row.tenantId.eq(1n))
      .first();

    expect(dependencies).toEqual(new Set([
      ixKey("documents", engine.plan("documents").indexes[0]!.name, [1n]),
    ]));
  });

  test("preserves first, unique, and streaming materializers", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: null });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 5, label: "b", rank: null });

    expect((await db.documents.query().first()).label).toBe("a");
    expect(
      (await db.documents.query().where((row: any) => row.label.eq("b")).unique()).label,
    ).toBe("b");
    await expect(db.documents.query().unique()).rejects.toThrow("matched more than one row");

    const streamed: string[] = [];
    for await (const row of db.documents.query().iter()) streamed.push(row.label);
    expect(streamed).toEqual(["a", "b"]);
  });

  test("composes scalar, range, membership, null, and Boolean predicates", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: null });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 5, label: "b", rank: 2 });
    await db.documents.insert({ tenantId: 1n, status: "archived", score: 4, label: "c", rank: 3 });
    await db.documents.insert({ tenantId: 2n, status: "active", score: 4, label: "d", rank: null });

    const labels = await db.documents
      .query()
      .where((row: any) => row.tenantId.eq(1n))
      .where((row: any) => row.status.ne("archived"))
      .where((row: any) => row.score.gt(3).and(row.score.lte(5)))
      .where((row: any) => row.label.in(["a", "b", "missing"]))
      .where((row: any) => row.rank.isNull().or(row.rank.between(2, 2)))
      .orderBy((row: any) => row.id.asc())
      .collect();

    expect(labels.map((row: any) => row.label)).toEqual(["a", "b"]);
    expect(
      await db.documents
        .query()
        .where((row: any) => row.status.eq("archived").not())
        .where((row: any) => row.score.gte(4).and(row.score.lt(5)))
        .where((row: any) => row.rank.isNotNull().not().or(row.rank.gt(1)))
        .count(),
    ).toBe(2);
  });

  test("normalizes duplicate IN values before compiling SQLite parameters", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: null });
    let issuedSql: string | undefined;
    const statement = engine.statement.bind(engine);
    engine.statement = (connection, sql) => {
      if (sql.includes('FROM "documents"') && sql.includes('"score" IN')) issuedSql = sql;
      return statement(connection, sql);
    };

    const repeated = Array<number>(500_001).fill(4);
    const count = await db.documents
      .query()
      .where((row: any) => row.score.in(repeated))
      .count();

    expect(count).toBe(1);
    expect(issuedSql?.match(/\?/g)).toHaveLength(1);
  });

  test("rejects a cumulative predicate parameter count above SQLite's capability", () => {
    expect(() =>
      compilePredicates(
        [
          { kind: "in", column: "score", values: [1, 2] },
          { kind: "in", column: "rank", values: [3, 4] },
        ],
        3,
        "documents.query",
      )
    ).toThrow("SQLite supports at most 3");
  });

  test("rejects before crossing Bun's positional SQLite bind boundary", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: null });
    const accepted = Array.from(
      { length: engine.sqliteParameterLimit },
      (_, value) => value,
    );

    expect(
      await db.documents.query().where((row: any) => row.score.in(accepted)).count(),
    ).toBe(1);
    await expect(
      db.documents.query().where((row: any) => row.score.in([...accepted, accepted.length])).count(),
    ).rejects.toThrow(`SQLite supports at most ${engine.sqliteParameterLimit}`);
  });

  test("evaluates callbacks once and scopes reusable predicates to their table and engine", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 4, label: "a", rank: null });
    let callbackCalls = 0;
    const reusable = db.documents.query().where((row: any) => {
      callbackCalls++;
      return row.tenantId.eq(1n);
    });

    expect(await reusable.count()).toBe(1);
    expect(await reusable.collect()).toHaveLength(1);
    expect(callbackCalls).toBe(1);

    let reusablePredicate: unknown;
    db.documents.query().where((row: any) => {
      reusablePredicate = row.status.eq("active");
      return reusablePredicate;
    });
    expect(await db.documents.query().where(() => reusablePredicate).count()).toBe(1);
    expect(() => db.users.query().where(() => reusablePredicate)).toThrow("different tables");

    const otherDir = mkdtempSync(join(tmpdir(), "ackerdb-foreign-predicate-"));
    const otherEngine = new Engine(schema, join(otherDir, "data.db"));
    try {
      otherEngine.createAll();
      const otherDb: any = makeDbWriter(otherEngine, newWriteCollector(), () => 1n);
      expect(() => otherDb.documents.query().where(() => reusablePredicate)).toThrow("different tables");
    } finally {
      otherEngine.close("clean");
      rmSync(otherDir, { recursive: true, force: true });
    }

    expect(() => db.documents.query().where(() => true)).toThrow("predicate expression");
    expect(() => db.documents.query().where(async () => true)).toThrow("must be synchronous");
  });

  test("paginates a complete mixed-direction order with SQLite null ordering", async () => {
    await db.documents.insert({ tenantId: 1n, status: "active", score: 1, label: "a", rank: null });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 2, label: "b", rank: null });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 3, label: "c", rank: 1 });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 3, label: "d", rank: 1 });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 9, label: "e", rank: 2 });

    const query = db.documents
      .query()
      .orderBy((row: any) => row.rank.asc())
      .thenBy((row: any) => row.score.desc());
    const first = await query.paginate({ pageSize: 2 });
    const firstFromNull = await query.paginate({ pageSize: 2, cursor: null });
    const second = await query.paginate({ pageSize: 2, cursor: first.nextCursor });
    const third = await query.paginate({ pageSize: 2, cursor: second.nextCursor });

    expect(first.items.map((row: any) => row.label)).toEqual(["b", "a"]);
    expect(firstFromNull).toEqual(first);
    expect(second.items.map((row: any) => row.label)).toEqual(["c", "d"]);
    expect(third.items.map((row: any) => row.label)).toEqual(["e"]);
    expect(third.nextCursor).toBeNull();
    await expect(query.paginate({ pageSize: 2, cursor: "not-a-cursor" })).rejects.toThrow(
      "malformed cursor",
    );

    const payload = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
    payload.values[0] = "wrong-type";
    const incompatible = Buffer.from(JSON.stringify(payload)).toString("base64url");
    await expect(query.paginate({ pageSize: 2, cursor: incompatible })).rejects.toThrow(
      "incompatible with rank",
    );
  });

  test("rejects cursor values outside the ordered column's storage domain", async () => {
    const cursor = (value: unknown, id: unknown = { bigint: "1" }) =>
      Buffer.from(JSON.stringify({ version: 1, values: [value, id] })).toString("base64url");
    const rejects = async (column: string, value: unknown) => {
      const query = db.documents.query().orderBy((row: any) => row[column].asc());
      await expect(query.paginate({ pageSize: 1, cursor: cursor(value) })).rejects.toThrow(
        `incompatible with ${column}`,
      );
    };

    await rejects("flag", 2);
    await rejects("bounded", 11);
    await rejects("bounded", Number.MAX_SAFE_INTEGER + 1);
    await rejects("boundedBigint", { bigint: "11" });
    await rejects("boundedBigint", { bigint: "9223372036854775808" });
    await rejects("owner", { bigint: "9223372036854775808" });
    await rejects("code", "x");

    await expect(
      db.documents.query().orderBy((row: any) => row.tenantId.asc()).paginate({
        pageSize: 1,
        cursor: cursor({ bigint: "9".repeat(1_000) }),
      }),
    ).rejects.toThrow("invalid bigint");

    const invalidPrimaryKey = Buffer.from(JSON.stringify({
      version: 1,
      values: [{ bigint: "9223372036854775808" }],
    })).toString("base64url");
    await expect(
      db.documents.query().paginate({ pageSize: 1, cursor: invalidPrimaryKey }),
    ).rejects.toThrow("incompatible with id");
  });

  test("caps a page's rows, because the page size comes from a caller", async () => {
    await expect(db.documents.query().paginate({ pageSize: MAX_PAGE_SIZE + 1 })).rejects.toThrow(
      `at most ${MAX_PAGE_SIZE}`,
    );
    await expect(db.documents.query().paginate({ pageSize: 0 })).rejects.toThrow(
      "positive safe integer",
    );
  });

  test("a page's byte budget takes rows away, never fields", async () => {
    const wide = "w".repeat(Math.floor(MAX_PAGE_BYTES * 0.4));
    for (let index = 0; index < 4; index++) {
      await db.documents.insert({
        tenantId: 1n,
        status: "active",
        score: index,
        label: wide,
        rank: null,
      });
    }

    const first = await db.documents.query().paginate({ pageSize: 4 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0].label).toBe(wide);
    expect(first.nextCursor).not.toBeNull();

    const second = await db.documents.query().paginate({ pageSize: 4, cursor: first.nextCursor });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  test("a row larger than the whole budget still advances the cursor", async () => {
    await db.documents.insert({
      tenantId: 1n,
      status: "active",
      score: 1,
      label: "h".repeat(MAX_PAGE_BYTES + 1),
      rank: null,
    });
    await db.documents.insert({ tenantId: 1n, status: "active", score: 2, label: "next", rank: null });

    const first = await db.documents.query().paginate({ pageSize: 2 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await db.documents.query().paginate({ pageSize: 2, cursor: first.nextCursor });
    expect(second.items.map((row: any) => row.label)).toEqual(["next"]);
    expect(second.nextCursor).toBeNull();
  });

  test("does not expose enum storage-tag ordering", () => {
    expect(() =>
      db.documents.query().orderBy((row: any) => row.status.asc())
    ).toThrow();
  });

  test("upserts through an exact non-null unique key shape", async () => {
    const inserted = await db.users
      .upsert(
        { email: "a@example.com" },
        { handle: "alpha", externalId: null, name: "A" },
      )
      .returning();
    const updated = await db.users
      .upsert({ email: "a@example.com" }, (existing: any) => ({
        handle: existing.handle,
        externalId: existing.externalId,
        name: `${existing.name}+`,
      }))
      .returning();

    expect(updated).toEqual({ ...inserted, name: "A+" });
    await expect(
      db.users.upsert(
        { externalId: "nullable-key" },
        { email: "b@example.com", handle: "beta", name: "B" },
      ),
    ).rejects.toThrow("exactly match one non-null unique index");
    await expect(
      db.users.upsert(
        { email: "a@example.com", handle: "alpha" },
        { externalId: null, name: "ambiguous" },
      ),
    ).rejects.toThrow("ambiguous between unique indexes");
    await expect(
      db.users.upsert({ email: "a@example.com" }, async () => ({
        handle: "alpha",
        externalId: null,
        name: "async",
      })),
    ).rejects.toThrow("values callback must be synchronous");
    await expect(
      db.users.upsert(
        { email: "a@example.com" },
        { email: "changed@example.com", handle: "alpha", externalId: null, name: "A" },
      ),
    ).rejects.toThrow('key field "email" cannot be changed');

    await db.users.insert({
      email: "b@example.com",
      handle: "beta",
      externalId: null,
      name: "B",
    });
    await expect(
      db.users.upsert(
        { email: "a@example.com" },
        { handle: "beta", externalId: null, name: "conflict" },
      ),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  test("matches a union upsert key by both its tag and payload", async () => {
    const inserted = await db.unionKeys.upsert(
      { key: { tag: "text", value: "one" } },
      { slug: "first", name: "Initial" },
    ).returning();
    const updated = await db.unionKeys.upsert(
      { key: { tag: "text", value: "one" } },
      { slug: "first", name: "Updated" },
    ).returning();

    expect(updated).toEqual({ ...inserted, name: "Updated" });
    await expect(
      db.unionKeys.upsert(
        { key: { tag: "text", value: "different payload" } },
        { slug: "second", name: "Must conflict" },
      ),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    const tagInserted = await db.unionKeys.upsert(
      { key: { tag: "empty", value: null } },
      { slug: "empty", name: "Tag initial" },
    ).returning();
    const tagUpdated = await db.unionKeys.upsert(
      { key: { tag: "empty", value: null } },
      { slug: "empty", name: "Tag updated" },
    ).returning();
    expect(tagUpdated).toEqual({ ...tagInserted, name: "Tag updated" });
  });
});
