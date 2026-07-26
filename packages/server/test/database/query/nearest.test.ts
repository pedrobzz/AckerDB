import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptDatabaseError,
  Engine,
  defineSchema,
  defineTable,
  indexSqlName,
  ixKey,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  v,
} from "@ackerdb/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    accountId: v.bigint(),
    title: v.string(),
    embedding: v.vector(2).nullable(),
  }).index(["accountId"]),
});

describe("exact nearest search", () => {
  let directory: string;
  let engine: Engine;
  let db: any;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-nearest-"));
    engine = new Engine(schema, join(directory, "data.db"));
    engine.createAll();
    db = makeDbWriter(engine, newWriteCollector(), () => 1n);
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  test("filters in SQLite before exact cosine ranking and materializes only winners", async () => {
    const first = await db.documents.insert({
      accountId: 1n,
      title: "same direction",
      embedding: [1, 0],
    });
    const tied = await db.documents.insert({
      accountId: 1n,
      title: "same direction, later id",
      embedding: [1, 0],
    });
    const orthogonal = await db.documents.insert({
      accountId: 1n,
      title: "orthogonal",
      embedding: [0, 1],
    });
    await db.documents.insert({
      accountId: 1n,
      title: "zero excluded from cosine",
      embedding: [0, 0],
    });
    await db.documents.insert({
      accountId: 1n,
      title: "null excluded",
      embedding: null,
    });
    await db.documents.insert({
      accountId: 2n,
      title: "closer but filtered out",
      embedding: [1, 0],
    });

    const matches = await db.documents
      .nearest("embedding", [1, 0], { metric: "cosine" })
      .where((document: any) => document.accountId.eq(1n))
      .take(2);

    expect(matches).toEqual([
      {
        row: { id: first, accountId: 1n, title: "same direction", embedding: [1, 0] },
        distance: 0,
      },
      {
        row: {
          id: tied,
          accountId: 1n,
          title: "same direction, later id",
          embedding: [1, 0],
        },
        distance: 0,
      },
    ]);

    const allEligible = await db.documents
      .nearest("embedding", [1, 0], { metric: "cosine" })
      .where((document: any) => document.accountId.eq(1n))
      .take(1_000);
    expect(allEligible.map(({ row }: any) => row.id)).toEqual([first, tied, orthogonal]);
  });

  test("supports lower-is-nearer L2 and dot distance with deterministic ties", async () => {
    const positive = await db.documents.insert({
      accountId: 1n,
      title: "positive",
      embedding: [1, 0],
    });
    const vertical = await db.documents.insert({
      accountId: 1n,
      title: "vertical",
      embedding: [0, 1],
    });
    const zero = await db.documents.insert({
      accountId: 1n,
      title: "zero",
      embedding: [0, 0],
    });
    await db.documents.insert({ accountId: 1n, title: "null", embedding: null });

    const l2 = await db.documents
      .nearest("embedding", [0, 0], { metric: "l2" })
      .take(3);
    expect(l2.map(({ row }: any) => row.id)).toEqual([zero, positive, vertical]);
    expect(l2[0].distance).toBe(0);
    expect(l2[1].distance).toBeCloseTo(1);
    expect(l2[2].distance).toBeCloseTo(1);

    const dot = await db.documents
      .nearest("embedding", [1, 0], { metric: "dot" })
      .take(3);
    expect(dot.map(({ row, distance }: any) => [row.id, distance])).toEqual([
      [positive, -1],
      [vertical, 0],
      [zero, 0],
    ]);
    expect((await db.documents
      .nearest("embedding", [0, 1], { metric: "l2" })
      .first()).row.id).toBe(vertical);
  });

  test("validates the vector, metric, bound, and cosine zero-query contract", async () => {
    expect(() => db.documents.nearest("embedding", [1], { metric: "l2" }))
      .toThrow("2-dimensional");
    expect(() => db.documents.nearest("embedding", [NaN, 0], { metric: "dot" }))
      .toThrow("finite number");
    expect(() => db.documents.nearest("embedding", [Number.MAX_VALUE, 0], { metric: "l2" }))
      .toThrow("overflows Float32");
    expect(() => db.documents.nearest("embedding", [0, 0], { metric: "cosine" }))
      .toThrow("must not be zero");
    expect(() => db.documents.nearest("embedding", [1, 0], { metric: "manhattan" }))
      .toThrow("metric must be");

    const nearest = db.documents.nearest("embedding", [1, 0], { metric: "l2" });
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(nearest.take(count)).rejects.toThrow("positive safe integer");
    }
  });

  test("normalizes stored and query coordinates at the Float32 boundary", async () => {
    const halfwayToNextFloat = 1 + 2 ** -24;
    const inserted = await db.documents.insert({
      accountId: 1n,
      title: "rounded",
      embedding: [halfwayToNextFloat, -0],
    }).returning();

    expect(inserted.embedding).toEqual([1, 0]);
    const match = await db.documents
      .nearest("embedding", [halfwayToNextFloat, -0], { metric: "l2" })
      .first();
    expect(match).toEqual({ row: inserted, distance: 0 });
  });

  test("decodes only winners and records the candidate-population dependency", async () => {
    for (let index = 0; index < 400; index++) {
      await db.documents.insert({
        accountId: 1n,
        title: `document ${index}`,
        embedding: [index + 1, 1],
      });
    }
    let decodedRows = 0;
    const originalRowFromSql = engine.rowFromSql.bind(engine);
    engine.rowFromSql = ((...args: Parameters<Engine["rowFromSql"]>) => {
      decodedRows++;
      return originalRowFromSql(...args);
    }) as Engine["rowFromSql"];
    const readSet = new Set<string>();
    let nearestObservation: {
      readonly candidateRowCount?: number;
      readonly retainedRowCount?: number;
    } | undefined;
    const reader: any = makeDbReader(
      engine,
      engine.reader,
      { add: (key) => readSet.add(key) },
      (observation) => {
        if (observation.statement === "nearest") nearestObservation = observation;
      },
    );

    const matches = await reader.documents
      .nearest("embedding", [1, 1], { metric: "cosine" })
      .where((document: any) => document.accountId.eq(1n))
      .take(3);

    expect(matches).toHaveLength(3);
    expect(decodedRows).toBe(3);
    expect(nearestObservation).toMatchObject({
      candidateRowCount: 400,
      retainedRowCount: 3,
    });
    expect(readSet).toEqual(new Set([
      ixKey("documents", engine.plan("documents").indexes[0]!.name, [1n]),
    ]));
  });

  test("projects only candidate ids and vectors while SQLite uses a metadata index", async () => {
    await db.documents.insert({ accountId: 1n, title: "one", embedding: [1, 0] });
    let candidateSql: string | undefined;
    const prepare = engine.reader.prepare.bind(engine.reader);
    engine.reader.prepare = ((sql: string) => {
      if (sql.includes('AS "__ackerdb_vector"')) candidateSql = sql;
      return prepare(sql);
    }) as typeof engine.reader.prepare;
    const reader: any = makeDbReader(engine, engine.reader, null);

    await reader.documents
      .nearest("embedding", [1, 0], { metric: "cosine" })
      .where((document: any) => document.accountId.eq(1n))
      .first();

    expect(candidateSql).toStartWith(
      'SELECT "id" AS "__ackerdb_pk", "embedding" AS "__ackerdb_vector" FROM "documents"',
    );
    const index = engine.plan("documents").indexes[0]!;
    const plan = engine.reader
      .query(`EXPLAIN QUERY PLAN ${candidateSql!}`)
      .all(1n) as Array<{ readonly detail: string }>;

    expect(plan.some(({ detail }) =>
      detail.includes(`USING INDEX ${indexSqlName("documents", index.name)}`)
    )).toBe(true);
  });

  test("reuses an ambient writer transaction without committing it", async () => {
    await db.documents.insert({ accountId: 1n, title: "one", embedding: [1, 0] });
    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      const result = await db.documents
        .nearest("embedding", [1, 0], { metric: "cosine" })
        .first();
      expect(result?.row.title).toBe("one");
      expect(engine.writer.inTransaction).toBe(true);
    } finally {
      engine.writer.exec("ROLLBACK");
    }
  });

  test("ranks candidates and fetches winners from one reader snapshot", async () => {
    const id = await db.documents.insert({
      accountId: 1n,
      title: "before concurrent write",
      embedding: [1, 0],
    });
    const originalStatement = engine.statement.bind(engine);
    let concurrentWrite = false;
    engine.statement = ((connection, sql) => {
      if (!concurrentWrite && sql.includes(" IN (")) {
        concurrentWrite = true;
        engine.writer.query('UPDATE "documents" SET "title" = ? WHERE "id" = ?')
          .run("after concurrent write", id);
      }
      return originalStatement(connection, sql);
    }) as Engine["statement"];
    const reader: any = makeDbReader(engine, engine.reader, null);

    const match = await reader.documents
      .nearest("embedding", [1, 0], { metric: "cosine" })
      .first();

    expect(concurrentWrite).toBe(true);
    expect(match?.row.title).toBe("before concurrent write");
    expect((await db.documents.get(id))?.title).toBe("after concurrent write");
  });

  test("reports malformed stored vector blobs as corruption", async () => {
    const id = await db.documents.insert({
      accountId: 1n,
      title: "corrupt",
      embedding: [1, 0],
    });
    engine.writer.query('UPDATE "documents" SET "embedding" = ? WHERE "id" = ?')
      .run(new Uint8Array([1, 2, 3]), id);

    const malformedSearch = db.documents
      .nearest("embedding", [1, 0], { metric: "l2" })
      .first();
    await expect(malformedSearch).rejects.toBeInstanceOf(CorruptDatabaseError);
    await expect(malformedSearch).rejects.toThrow(
      `stored vector documents.embedding at row ${id} is corrupt: expected 8 bytes, got 3`,
    );

    const nonFinite = new Uint8Array(8);
    new DataView(nonFinite.buffer).setFloat32(0, NaN, true);
    engine.writer.query('UPDATE "documents" SET "embedding" = ? WHERE "id" = ?')
      .run(nonFinite, id);
    const nonFiniteSearch = db.documents
      .nearest("embedding", [1, 0], { metric: "l2" })
      .first();
    await expect(nonFiniteSearch).rejects.toBeInstanceOf(CorruptDatabaseError);
    await expect(nonFiniteSearch).rejects.toThrow(
      `stored vector documents.embedding at row ${id} is corrupt: coordinate 0 is not finite`,
    );
  });
});
