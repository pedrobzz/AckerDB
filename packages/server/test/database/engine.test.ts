import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v, defineSchema, defineTable, Engine } from "@dbzz/server";

const dirs: string[] = [];
const freshPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "dbzz-engine-"));
  dirs.push(dir);
  return join(dir, "data.db");
};
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const role = () => v.enum("Role", ["admin", "member", "guest"]);
const payload = () =>
  v.union("Payload", {
    text: v.string(),
    image: v.object({ url: v.string(), width: v.int() }),
    nothing: v.tag(),
  });

const kitchenSinkSchema = () =>
  defineSchema({
    things: defineTable({
      id: v.primaryKey(),
      name: v.string(),
      rank: v.int(),
      score: v.float(),
      count: v.bigint(),
      ok: v.boolean(),
      blob: v.bytes(),
      tags: v.array(v.string()),
      meta: v.object({ a: v.bigint(), b: v.string().nullable() }),
      extra: v.jsonb<{ deep: bigint[] }>(),
      role: role(),
      payload: payload(),
      maybe: v.string().nullable(),
      maybeRole: role().nullable(),
      maybePayload: payload().nullable(),
    }).index(["name"]),
  });

function insertAndReadBack(engine: Engine, row: Record<string, unknown>) {
  const plan = engine.plan("things");
  const { sql, bind } = engine.insertSql(plan);
  const inserted = engine.writer.query(sql).get(...(bind(row) as never[])) as { id: bigint };
  const sqlRow = engine.writer
    .query(`SELECT * FROM "things" WHERE "id" = ?`)
    .get(inserted.id) as Record<string, unknown>;
  return { id: inserted.id, row: engine.rowFromSql(plan, sqlRow) };
}

describe("engine storage", () => {
  test("createAll preserves the schema failure when rollback also fails", () => {
    const engine = new Engine(kitchenSinkSchema(), ":memory:");
    const primary = new Error("injected schema creation failure");
    const rollback = new Error("injected schema rollback failure");
    const originalExec = engine.writer.exec;
    engine.writer.exec = ((sql: string) => {
      if (sql.startsWith("CREATE TABLE")) throw primary;
      if (sql === "ROLLBACK") throw rollback;
      return originalExec.call(engine.writer, sql);
    }) as typeof engine.writer.exec;

    let failure: unknown;
    try {
      engine.createAll();
    } catch (error) {
      failure = error;
    } finally {
      engine.writer.exec = originalExec;
      if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "database schema creation and rollback both failed",
    );
    expect((failure as AggregateError).errors).toEqual([primary, rollback]);
    engine.close("unclean");
  });

  test("isolates in-memory reads from an uncommitted writer transaction", () => {
    const engine = new Engine(
      defineSchema({ notes: defineTable({ id: v.primaryKey(), body: v.string() }) }),
      ":memory:",
      { busyTimeoutMs: 1 },
    );
    try {
      engine.createAll();
      expect(engine.reader).not.toBe(engine.writer);
      engine.writer.exec("BEGIN IMMEDIATE");
      engine.writer.query('INSERT INTO "notes" ("body") VALUES (?)').run("uncommitted");
      let rows: unknown[] | undefined;
      try {
        rows = engine.reader.query('SELECT * FROM "notes"').all();
      } catch (error) {
        expect(error).toMatchObject({ code: "SQLITE_LOCKED_SHAREDCACHE" });
      }
      expect(rows ?? []).toEqual([]);
      engine.writer.exec("ROLLBACK");
      expect(engine.reader.query('SELECT * FROM "notes"').all()).toEqual([]);
    } finally {
      engine.close("clean");
    }
  });

  test("every column kind round-trips through SQL", () => {
    const engine = new Engine(kitchenSinkSchema(), freshPath());
    engine.createAll();
    const input = {
      name: "n1",
      rank: 7,
      score: 4.5,
      count: 9007199254740993n,
      ok: true,
      blob: new Uint8Array([7, 8]),
      tags: ["a", "b"],
      meta: { a: 42n, b: null },
      extra: { deep: [1n, 2n] },
      role: "member",
      payload: { tag: "image", value: { url: "u", width: 10 } },
      maybe: null,
      maybeRole: null,
      maybePayload: null,
    };
    const { id, row } = insertAndReadBack(engine, input);
    expect(id).toBe(1n);
    expect(row).toEqual({ id: 1n, ...input });
    const storageTypes = Object.fromEntries(
      (engine.writer.query('PRAGMA table_info("things")').all() as {
        readonly name: string;
        readonly type: string;
      }[]).map((column) => [column.name, column.type]),
    );
    expect(storageTypes).toMatchObject({ rank: "INTEGER", score: "REAL", count: "INTEGER" });

    const second = insertAndReadBack(engine, {
      ...input,
      payload: { tag: "nothing", value: null },
      maybe: "present",
      maybeRole: "guest",
      maybePayload: { tag: "text", value: "t" },
    });
    expect(second.row["payload"]).toEqual({ tag: "nothing", value: null });
    expect(second.row["maybeRole"]).toBe("guest");
    expect(second.row["maybePayload"]).toEqual({ tag: "text", value: "t" });
    engine.close("clean");
  });

  test("enum and union values are stored as integer tags", () => {
    const engine = new Engine(kitchenSinkSchema(), freshPath());
    engine.createAll();
    insertAndReadBack(engine, {
      name: "n",
      rank: 0,
      score: 0,
      count: 0n,
      ok: false,
      blob: new Uint8Array(0),
      tags: [],
      meta: { a: 0n, b: null },
      extra: {},
      role: "guest",
      payload: { tag: "text", value: "x" },
      maybe: null,
      maybeRole: null,
      maybePayload: null,
    });
    const raw = engine.writer.query(`SELECT "role", "payload", "payload__p" FROM "things"`).get() as {
      role: bigint;
      payload: bigint;
      payload__p: string;
    };
    expect(raw.role).toBe(2n); // guest is the third declared variant
    expect(raw.payload).toBe(0n); // text is the first
    expect(raw.payload__p).toBe('"x"');
    engine.close("clean");
  });
});

describe("tag interning", () => {
  const schemaWith = (values: [string, ...string[]]) =>
    defineSchema({
      items: defineTable({ id: v.primaryKey(), status: v.enum("Status", values) }),
    });

  test("tags are stable across reopen, reorder, delete and re-add", () => {
    const path = freshPath();

    const first = new Engine(schemaWith(["draft", "published", "archived"]), path);
    first.createAll();
    expect(first.tags.get("Status")!.toTag).toEqual(
      new Map([["draft", 0], ["published", 1], ["archived", 2]]),
    );
    first.close("clean");

    // reorder: purely cosmetic, tags unchanged
    const reordered = new Engine(schemaWith(["archived", "draft", "published"]), path);
    expect(reordered.tags.get("Status")!.toTag).toEqual(
      new Map([["draft", 0], ["published", 1], ["archived", 2]]),
    );
    reordered.close("clean");

    // drop "published", add "trashed": new variant gets a fresh tag (3), never 1
    const changed = new Engine(schemaWith(["draft", "archived", "trashed"]), path);
    expect(changed.tags.get("Status")!.toTag.get("trashed")).toBe(3);
    changed.close("clean");

    // re-adding "published" finds its original tag again
    const readded = new Engine(schemaWith(["draft", "published", "archived", "trashed"]), path);
    expect(readded.tags.get("Status")!.toTag.get("published")).toBe(1);
    readded.close("clean");
  });
});
