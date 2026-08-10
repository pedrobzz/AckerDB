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
import { ftsCorpusKey } from "../../../src/database/keys.ts";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    accountId: v.bigint(),
    title: v.string(),
    body: v.string().nullable(),
  })
    .fullText(["title", "body"])
    .index(["accountId"]),
});

describe("literal full-text search", () => {
  let directory: string;
  let engine: Engine;
  let db: any;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-full-text-query-"));
    engine = new Engine(schema, join(directory, "data.db"));
    engine.createAll();
    db = makeDbWriter(engine, newWriteCollector(), () => 1n);
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  test("returns application rows in rank order with primary-key tie-breaking", async () => {
    const first = await db.documents.insert({
      accountId: 1n,
      title: "First",
      body: "quiet restaurant",
    });
    const tied = await db.documents.insert({
      accountId: 1n,
      title: "Second",
      body: "quiet restaurant",
    });
    await db.documents.insert({
      accountId: 2n,
      title: "Filtered",
      body: "quiet restaurant",
    });
    await db.documents.insert({
      accountId: 1n,
      title: "No match",
      body: "quiet library",
    });

    const rows = await db.documents
      .fullText("body", "quiet restaurant")
      .where((row: any) => row.accountId.eq(1n))
      .take(10);

    expect(rows).toEqual([
      { id: first, accountId: 1n, title: "First", body: "quiet restaurant" },
      { id: tied, accountId: 1n, title: "Second", body: "quiet restaurant" },
    ]);
    expect(Object.keys(rows[0]!)).toEqual(["id", "accountId", "title", "body"]);
    expect((await db.documents.fullText("title", "Second").first())?.id).toBe(tied);
  });

  test("treats operators and punctuation as literal unicode61 tokens", async () => {
    const literal = await db.documents.insert({
      accountId: 1n,
      title: "Literal",
      body: "alpha or beta cafe tenant",
    });
    await db.documents.insert({
      accountId: 1n,
      title: "Operator-shaped subset",
      body: "alpha beta",
    });

    const rows = await db.documents
      .fullText("body", `Alpha OR beta, "café*" -tenant`)
      .take(10);

    expect(rows.map((row: any) => row.id)).toEqual([literal]);
    expect(await db.documents.fullText("body", "---").first()).toBeNull();
  });

  test("uses one joined ranking statement and reuses predicate dependencies", async () => {
    await db.documents.insert({
      accountId: 7n,
      title: "Observed",
      body: "searchable",
    });
    const issued: string[] = [];
    let rankedStatement: ReturnType<typeof engine.reader.prepare> | null = null;
    const prepare = engine.reader.prepare.bind(engine.reader);
    engine.reader.prepare = ((sql) => {
      const statement = prepare(sql);
      if (sql.includes('"__ackerdb_fts_matches"')) {
        issued.push(sql);
        rankedStatement = statement;
      }
      return statement;
    }) as typeof engine.reader.prepare;
    const dependencies = new Set<string>();
    const reader: any = makeDbReader(
      engine,
      engine.reader,
      { add: (key) => dependencies.add(key) },
    );

    const rows = await reader.documents
      .fullText("body", "searchable")
      .where((row: any) => row.accountId.eq(7n))
      .take(5);

    expect(rows).toHaveLength(1);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain('ORDER BY "__ackerdb_fts_matches"."__ackerdb_fts_rank" ASC');
    expect(issued[0]).toContain('"documents"."id" ASC');
    expect(() => rankedStatement!.all()).toThrow("Statement has finalized");
    expect(dependencies).toEqual(new Set([
      ixKey("documents", engine.plan("documents").indexes[0]!.name, [7n]),
      ftsCorpusKey("documents", "body"),
    ]));
    dependencies.clear();
    issued.length = 0;
    expect(
      await reader.documents
        .fullText("body", "---")
        .where((row: any) => row.accountId.eq(7n))
        .take(5),
    ).toEqual([]);
    expect(dependencies).toEqual(new Set());
    expect(issued).toEqual([]);
  });

  test("prepares literals without borrowing the application writer connection", async () => {
    await db.documents.insert({
      accountId: 1n,
      title: "Isolated",
      body: "private tokenizer",
    });
    const writerQuery = engine.writer.query.bind(engine.writer);
    engine.writer.query = ((sql) => {
      if (sql.includes("__ackerdb_fts_literal_tokens")) {
        throw new Error("literal preparation touched the application writer");
      }
      return writerQuery(sql);
    }) as typeof engine.writer.query;
    const reader: any = makeDbReader(engine, engine.reader, null);

    expect(await reader.documents.fullText("body", "tokenizer").take(1))
      .toEqual([{
        id: 1n,
        accountId: 1n,
        title: "Isolated",
        body: "private tokenizer",
      }]);
  });

  test("requires a declared target and a positive safe result bound", async () => {
    expect(() => db.documents.fullText("accountId", "1"))
      .toThrow("not a declared full-text target");
    expect(() => db.documents.fullText("missing", "value"))
      .toThrow("not a declared full-text target");
    expect(() => db.documents.fullText("body", 1))
      .toThrow("query must be a string");

    const query = db.documents.fullText("body", "value");
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(query.take(count)).rejects.toThrow("positive safe integer");
    }
  });

  test("enforces the literal byte and token bounds at their exact edges", async () => {
    const exactBytes = "é".repeat(2_048);
    expect(Buffer.byteLength(exactBytes)).toBe(4_096);
    expect(await db.documents.fullText("body", exactBytes).take(1)).toEqual([]);
    expect(() => db.documents.fullText("body", `${exactBytes}x`))
      .toThrow("at most 4096 UTF-8 bytes");

    const exactTokens = Array.from({ length: 256 }, (_, index) => `t${index}`).join(" ");
    expect(await db.documents.fullText("body", exactTokens).take(1)).toEqual([]);
    const excessTokens = `${exactTokens} t256`;
    expect(Buffer.byteLength(excessTokens)).toBeLessThan(4_096);
    expect(() => db.documents.fullText("body", excessTokens))
      .toThrow("at most 256 searchable tokens");
  });

  test("keeps full-text and vector retrieval independent on the same table", async () => {
    const hybridSchema = defineSchema({
      entries: defineTable({
        id: v.primaryKey(),
        body: v.string(),
        embedding: v.vector(2),
      }).fullText(["body"]),
    });
    const hybridEngine = new Engine(hybridSchema, ":memory:");
    hybridEngine.createAll();
    const hybridDb: any = makeDbWriter(
      hybridEngine,
      newWriteCollector(),
      () => 1n,
    );
    await hybridDb.entries.insert({
      body: "quiet restaurant",
      embedding: [1, 0],
    });

    const fullText = hybridDb.entries.fullText("body", "restaurant");
    const nearest = hybridDb.entries.nearest(
      "embedding",
      [1, 0],
      { metric: "cosine" },
    );
    expect(fullText.nearest).toBeUndefined();
    expect(nearest.fullText).toBeUndefined();
    expect(await fullText.take(1)).toEqual([{
      id: 1n,
      body: "quiet restaurant",
      embedding: [1, 0],
    }]);
    expect(await nearest.take(1)).toEqual([{
      row: {
        id: 1n,
        body: "quiet restaurant",
        embedding: [1, 0],
      },
      distance: 0,
    }]);
    hybridEngine.close("clean");
  });

  test("emits corpus writes only for full-text targets whose corpus changed", async () => {
    const writes = newWriteCollector();
    const writer: any = makeDbWriter(engine, writes, () => 1n);
    const corpusWrites = () =>
      [...writes.keys].filter((key) => key.startsWith("fts:")).sort();
    const allTargets = [
      ftsCorpusKey("documents", "body"),
      ftsCorpusKey("documents", "title"),
    ].sort();

    const id = await writer.documents.insert({
      accountId: 1n,
      title: "Original",
      body: "original text",
    });
    expect(corpusWrites()).toEqual(allTargets);

    writes.keys.clear();
    await writer.documents.patch(id, { accountId: 2n });
    expect(corpusWrites()).toEqual([]);

    writes.keys.clear();
    await writer.documents.patch(id, { body: "changed text" });
    expect(corpusWrites()).toEqual([ftsCorpusKey("documents", "body")]);

    writes.keys.clear();
    await writer.documents.delete(id);
    expect(corpusWrites()).toEqual(allTargets);
  });
});
