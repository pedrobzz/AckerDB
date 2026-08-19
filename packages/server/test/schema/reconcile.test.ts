import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  v,
  defineEventTable,
  defineSchema,
  defineTable,
  Engine,
  indexSqlName,
  makeDbWriter,
  newWriteCollector,
  probeUniqueIndex,
  reconcile,
  UnsafeSchemaChange,
  type Schema,
} from "@ackerdb/server";
import { withFrameworkTables } from "../../src/database/framework-schema.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ackerdb-rec-"));
  dirs.push(dir);
  return join(dir, "data.db");
}

/** Open an engine on `path` with `schema` and reconcile; returns engine + db. */
function open(schema: Schema, path: string) {
  const engine = new Engine(schema, path);
  const applied = reconcile(engine).applied;
  const writes = newWriteCollector();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = makeDbWriter(engine, writes, () => 0n);
  return { engine, db, applied };
}

/** Reconcile `v1` into a fresh empty database, then assert `v2` refuses it. */
function refusesEmpty(v1: Schema, v2: Schema, needle: string): void {
  const path = freshPath();
  const a = new Engine(v1, path);
  reconcile(a);
  a.close("clean");
  const b = new Engine(v2, path);
  expect(() => reconcile(b)).toThrow(UnsafeSchemaChange);
  expect(() => reconcile(b)).toThrow(needle);
  b.close("clean");
}

const RRole = () => v.enum("RRole", ["admin", "member", "guest"]);
const pings = () =>
  defineEventTable({ id: v.primaryKey(), n: v.bigint() }, { args: {}, access: "public", matches: () => true });

const baseSchema = () =>
  defineSchema({
    users: defineTable({
      id: v.primaryKey(),
      name: v.string(),
      role: RRole(),
    }).index(["name"]),
  });

const initializationLine = (schema: Schema): string =>
  `initialized ${Object.keys(withFrameworkTables(schema).tables).length} table(s)`;

describe("reconcile: bootstrap", () => {
  test("fresh database initializes; identical schema is a no-op", () => {
    const path = freshPath();
    const schema = baseSchema();
    const a = open(schema, path);
    expect(a.applied).toEqual([initializationLine(schema)]);
    a.engine.close("clean");
    const b = open(baseSchema(), path);
    expect(b.applied).toEqual([]);
    b.engine.close("clean");
  });

  test("reordering column declarations is not a schema change", () => {
    const path = freshPath();
    const schema = baseSchema();
    const a = open(schema, path);
    expect(a.applied).toEqual([initializationLine(schema)]);
    const stored = a.engine.loadSnapshot()!;
    a.engine.close("clean");

    // Same columns, declared in a different order. Column order is not physical
    // truth, so this must not cost a startup write or claim an update.
    const reordered = defineSchema({
      users: defineTable({
        role: RRole(),
        name: v.string(),
        id: v.primaryKey(),
      }).index(["name"]),
    });
    const b = open(reordered, path);
    expect(b.applied).toEqual([]);
    expect(b.engine.loadSnapshot()).toEqual(stored);
    b.engine.close("clean");
  });
});

describe("reconcile: shape-safe changes apply with data present", () => {
  test("adding tables (both kinds) and a nullable column", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "ana", role: "admin" });
    a.engine.close("clean");

    const grown = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        role: RRole(),
        bio: v.string().nullable(),
      }).index(["name"]),
      posts: defineTable({ id: v.primaryKey(), title: v.string() }),
      pings: pings(),
    });
    const b = open(grown, path);
    expect(b.applied).toContain("created table posts");
    expect(b.applied).toContain("added event table pings");
    expect(b.applied).toContain("added nullable column users.bio");
    expect(await b.db.users.get(1n)).toMatchObject({ name: "ana", bio: null });
    await b.db.posts.insert({ title: "t" });
    b.engine.close("clean");
  });

  test("a MID-table nullable add survives close and reopen (ALTER appends; order is not identity)", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "ana", role: "admin" });
    a.engine.close("clean");

    // `bio` declared BETWEEN existing columns: the physical ALTER appends it
    // last, so the stored snapshot's column order and the table's physical
    // order legitimately diverge. Reopening must not read that as corruption.
    const grown = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        bio: v.string().nullable(),
        role: RRole(),
      }).index(["name"]),
    });
    const b = open(grown, path);
    expect(b.applied).toContain("added nullable column users.bio");
    b.engine.close("clean");

    const c = open(grown, path);
    expect(await c.db.users.get(1n)).toMatchObject({ name: "ana", bio: null, role: "admin" });
    c.engine.close("clean");
  });

  test("widening a column to nullable rebuilds, preserving rows and ids", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "a", role: "admin" });
    await a.db.users.insert({ name: "b", role: "member" });
    await a.db.users.delete(2n); // high id gone; must not be reused
    a.engine.close("clean");

    const widened = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string().nullable(),
        role: RRole(),
      }).index(["name"]),
    });
    const b = open(widened, path);
    expect(b.applied).toEqual(["rebuilt table users"]);
    expect(await b.db.users.get(1n)).toMatchObject({ name: "a" });
    expect(await b.db.users.insert({ name: null, role: "guest" })).toBe(3n);
    b.engine.close("clean");
  });

  test("enum variants can be added and reordered with rows present", async () => {
    const path = freshPath();
    const a = open(defineSchema({
      users: defineTable({ id: v.primaryKey(), name: v.string(), role: RRole() }).index(["name"]),
    }), path);
    await a.db.users.insert({ name: "m", role: "member" });
    a.engine.close("clean");

    const grown = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        role: v.enum("RRole", ["guest", "admin", "trial", "member"]),
      }).index(["name"]),
    });
    const b = open(grown, path);
    expect((await b.db.users.get(1n)).role).toBe("member"); // stable tag
    await b.db.users.insert({ name: "t", role: "trial" }); // new variant usable
    b.engine.close("clean");
  });

  test("discriminated-union members can be added and reordered without rewriting stored objects", async () => {
    const before = defineSchema({
      events: defineTable({
        id: v.primaryKey(),
        payload: v.discriminatedUnion("type", [
          v.object({ type: v.literal("text"), text: v.string() }),
          v.object({ type: v.literal("deleted") }),
        ]),
      }).index(["payload"]),
    });
    const path = freshPath();
    const a = open(before, path);
    await a.db.events.insert({ payload: { type: "text", text: "hello" } });
    const originalPayload = (a.engine.writer.query("SELECT payload FROM events WHERE id = 1").get() as {
      payload: string;
    }).payload;
    a.engine.close("clean");

    const after = defineSchema({
      events: defineTable({
        id: v.primaryKey(),
        payload: v.discriminatedUnion("type", [
          v.object({ type: v.literal("count"), count: v.int() }),
          v.object({ type: v.literal("deleted") }),
          v.object({ type: v.literal("text"), text: v.string() }),
        ]),
      }).index(["payload"]),
    });
    const b = open(after, path);
    expect((b.engine.writer.query("SELECT payload FROM events WHERE id = 1").get() as {
      payload: string;
    }).payload).toBe(originalPayload);
    expect(await b.db.events.get(1n)).toMatchObject({ payload: { type: "text", text: "hello" } });
    await b.db.events.insert({ payload: { type: "count", count: 2 } });
    expect(await b.db.events.query().where((row: any) => row.payload.is("count")).count()).toBe(1);
    b.engine.close("clean");
  });

  test("non-unique index lifecycle: add, change, drop", async () => {
    const path = freshPath();
    const initial = baseSchema();
    const a = open(initial, path);
    await a.db.users.insert({ name: "ana", role: "admin" });
    a.engine.close("clean");

    // change the existing index's columns, add a second index
    const changed = defineSchema({
      users: defineTable({ id: v.primaryKey(), name: v.string(), role: RRole() })
        .index(["name", "role"])
        .index(["role"]),
    });
    const b = open(changed, path);
    const initialName = initial.tables.users!.indexes[0]!.name;
    const [composite, role] = changed.tables.users!.indexes;
    expect(b.applied).toContain(`dropped index users.${initialName}`);
    expect(b.applied).toContain(`created index users.${composite!.name}`);
    expect(b.applied).toContain(`created index users.${role!.name}`);
    expect(await b.db.users.get(1n)).toMatchObject({ name: "ana" });
    b.engine.close("clean");

    // drop both indexes
    const dropped = defineSchema({
      users: defineTable({ id: v.primaryKey(), name: v.string(), role: RRole() }),
    });
    const c = open(dropped, path);
    expect(c.applied).toContain(`dropped index users.${composite!.name}`);
    expect(c.applied).toContain(`dropped index users.${role!.name}`);
    c.engine.close("clean");
  });

  test("event → table conversion creates the real table", async () => {
    const path = freshPath();
    const a = open(
      defineSchema({
        users: defineTable({ id: v.primaryKey(), name: v.string() }),
        pings: pings(),
      }),
      path,
    );
    await a.db.users.insert({ name: "ana" });
    a.engine.close("clean");

    const b = open(
      defineSchema({
        users: defineTable({ id: v.primaryKey(), name: v.string() }),
        pings: defineTable({ id: v.primaryKey(), n: v.bigint() }),
      }),
      path,
    );
    expect(b.applied).toContain("converted pings to a table");
    expect(await b.db.pings.insert({ n: 1n })).toBe(1n);
    expect(await b.db.users.get(1n)).toMatchObject({ name: "ana" }); // sibling data intact
    b.engine.close("clean");
  });

  test("event table updated applies", async () => {
    const path = freshPath();
    const a = open(
      defineSchema({ users: defineTable({ id: v.primaryKey() }), pings: pings() }),
      path,
    );
    a.engine.close("clean");
    const b = open(
      defineSchema({
        users: defineTable({ id: v.primaryKey() }),
        pings: defineEventTable(
          { id: v.primaryKey(), n: v.bigint(), extra: v.string().nullable() },
          { args: {}, access: "public", matches: () => true },
        ),
      }),
      path,
    );
    expect(b.applied).toContain("updated event table pings");
    b.engine.close("clean");
  });

  test("event table dropped applies", () => {
    const path = freshPath();
    const a = open(
      defineSchema({ users: defineTable({ id: v.primaryKey() }), pings: pings() }),
      path,
    );
    a.engine.close("clean");
    const b = open(defineSchema({ users: defineTable({ id: v.primaryKey() }) }), path);
    expect(b.applied).toContain("dropped event table pings");
    b.engine.close("clean");
  });
});

describe("reconcile: shape-unsafe changes refuse even on an empty table", () => {
  const users = (extra: Record<string, ReturnType<typeof v.string>>) =>
    defineSchema({ users: defineTable({ id: v.primaryKey(), name: v.string(), ...extra }) });

  test("column type change", () => {
    refusesEmpty(
      defineSchema({ users: defineTable({ id: v.primaryKey(), tag: v.string() }) }),
      defineSchema({ users: defineTable({ id: v.primaryKey(), tag: v.float() }) }),
      "type changed",
    );
  });

  test("narrowing nullable → required", () => {
    refusesEmpty(
      defineSchema({ users: defineTable({ id: v.primaryKey(), name: v.string().nullable() }) }),
      defineSchema({ users: defineTable({ id: v.primaryKey(), name: v.string() }) }),
      "made required",
    );
  });

  test("required column added", () => {
    refusesEmpty(users({}), users({ slug: v.string() }), "required column added");
  });

  test("enum variant removed", () => {
    refusesEmpty(
      defineSchema({ users: defineTable({ id: v.primaryKey(), role: RRole() }) }),
      defineSchema({ users: defineTable({ id: v.primaryKey(), role: v.enum("RRole", ["admin", "member"]) }) }),
      "variant 'guest' removed",
    );
  });

  test("discriminated-union member removed", () => {
    refusesEmpty(
      defineSchema({
        events: defineTable({
          id: v.primaryKey(),
          payload: v.discriminatedUnion("type", [
            v.object({ type: v.literal("text"), text: v.string() }),
            v.object({ type: v.literal("deleted") }),
          ]),
        }),
      }),
      defineSchema({
        events: defineTable({
          id: v.primaryKey(),
          payload: v.discriminatedUnion("type", [
            v.object({ type: v.literal("text"), text: v.string() }),
            v.object({ type: v.literal("created"), at: v.int() }),
          ]),
        }),
      }),
      "variant 'deleted' removed",
    );
  });

  test("discriminated-union member shape changed", () => {
    refusesEmpty(
      defineSchema({
        events: defineTable({
          id: v.primaryKey(),
          payload: v.discriminatedUnion("type", [
            v.object({ type: v.literal("text"), text: v.string() }),
            v.object({ type: v.literal("deleted") }),
          ]),
        }),
      }),
      defineSchema({
        events: defineTable({
          id: v.primaryKey(),
          payload: v.discriminatedUnion("type", [
            v.object({ type: v.literal("text"), body: v.string() }),
            v.object({ type: v.literal("deleted") }),
          ]),
        }),
      }),
      "variant 'text' payload changed",
    );
  });

  test("column dropped", () => {
    refusesEmpty(users({ bio: v.string() }), users({}), "column dropped");
  });

  test("table dropped", () => {
    refusesEmpty(
      defineSchema({
        users: defineTable({ id: v.primaryKey() }),
        logs: defineTable({ id: v.primaryKey(), line: v.string() }),
      }),
      defineSchema({ users: defineTable({ id: v.primaryKey() }) }),
      "table dropped",
    );
  });

  test("table → event conversion", () => {
    refusesEmpty(
      defineSchema({
        users: defineTable({ id: v.primaryKey() }),
        logs: defineTable({ id: v.primaryKey(), line: v.string() }),
      }),
      defineSchema({
        users: defineTable({ id: v.primaryKey() }),
        logs: defineEventTable(
          { id: v.primaryKey(), line: v.string() },
          { args: {}, access: "public", matches: () => true },
        ),
      }),
      "changed to an event table",
    );
  });
});

describe("reconcile: optimistic unique index", () => {
  const uniqueName = defineSchema({
    users: defineTable({ id: v.primaryKey(), name: v.string(), role: RRole() }).index(["name"], {
      unique: true,
    }),
  });

  test("clean data applies and the physical index is unique", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "ana", role: "admin" });
    await a.db.users.insert({ name: "bea", role: "member" });
    a.engine.close("clean");

    const b = open(uniqueName, path);
    const baseIndex = baseSchema().tables.users!.indexes[0]!.name;
    const uniqueIndex = uniqueName.tables.users!.indexes[0]!.name;
    expect(b.applied).toContain(`dropped index users.${baseIndex}`);
    expect(b.applied).toContain(`created index users.${uniqueIndex}`);
    const sql = (
      b.engine.writer.query("SELECT sql FROM sqlite_master WHERE name = ?")
        .get(indexSqlName("users", uniqueIndex)) as { sql: string }
    ).sql;
    expect(sql).toContain("UNIQUE");
    b.engine.close("clean");
  });

  test("NULLs are not duplicates: the probe mirrors the constraint", async () => {
    const nullable = defineSchema({
      users: defineTable({ id: v.primaryKey(), name: v.string(), role: RRole(), nick: v.string().nullable() }),
    });
    const uniqueNick = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        role: RRole(),
        nick: v.string().nullable(),
      }).index(["nick"], { unique: true }),
    });
    const path = freshPath();
    const a = open(nullable, path);
    await a.db.users.insert({ name: "ana", role: "admin", nick: null });
    await a.db.users.insert({ name: "bea", role: "member", nick: null });
    a.engine.close("clean");

    // two NULL nicks group together in SQL but never collide in a unique index
    const b = open(uniqueNick, path);
    expect(b.applied).toContain(
      `created index users.${uniqueNick.tables.users!.indexes[0]!.name}`,
    );
    b.engine.close("clean");
  });

  test("a unique index over a column added in the same change applies", async () => {
    const withNew = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        role: RRole(),
        slug: v.string().nullable(),
      }).index(["slug"], { unique: true }),
    });
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "ana", role: "admin" });
    a.engine.close("clean");

    // the probed column is not physical yet; existing rows will hold NULL
    const b = open(withNew, path);
    expect(b.applied).toContain("added nullable column users.slug");
    expect(b.applied).toContain(
      `created index users.${withNew.tables.users!.indexes[0]!.name}`,
    );
    b.engine.close("clean");
  });

  test("duplicates refuse with counts and leave the database untouched", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "dup", role: "admin" });
    await a.db.users.insert({ name: "dup", role: "member" });
    a.engine.close("clean");

    const refusing = new Engine(uniqueName, path);
    expect(() => reconcile(refusing)).toThrow("1 duplicate group(s)");
    // nothing touched: the index is still the old non-unique one
    const baseIndex = baseSchema().tables.users!.indexes[0]!.name;
    const sql = (
      refusing.writer.query("SELECT sql FROM sqlite_master WHERE name = ?")
        .get(indexSqlName("users", baseIndex)) as { sql: string }
    ).sql;
    expect(sql).not.toContain("UNIQUE");
    // both duplicate rows survive
    expect((refusing.writer.query("SELECT COUNT(*) AS n FROM users").get() as { n: bigint }).n).toBe(2n);
    refusing.close("clean");
  });
});

describe("probeUniqueIndex (the shared duplicate probe)", () => {
  // A query function that fakes the duplicate-group count and records the SQL it ran.
  const fakeQuery = (dupes: number) => {
    const calls: string[] = [];
    const query = (sql: string): number => {
      calls.push(sql);
      return dupes;
    };
    return Object.assign(query, { calls });
  };
  const cols = { email: {} }; // a physically-present column
  const emailIndex = "s_u_5_email";

  test("clean → null; duplicates → the target-world refusal carrying the count", () => {
    expect(probeUniqueIndex(fakeQuery(0), "users", emailIndex, ["email"], cols)).toBeNull();
    expect(probeUniqueIndex(fakeQuery(3), "users", emailIndex, ["email"], cols)).toEqual({
      table: "users",
      index: emailIndex,
      reason: "unique-index-duplicates",
      question: "unique index over (email); 3 duplicate group(s) exist",
      count: 3,
    });
  });

  test("a column not physically present yet cannot have duplicates — no query runs", () => {
    const q = fakeQuery(99); // even if the DB would report dupes, an absent column is never probed
    expect(probeUniqueIndex(q, "users", "s_u_4_slug", ["slug"], cols)).toBeNull();
    expect(q.calls).toEqual([]);
  });

  test("prototype names are not mistaken for physically present columns", () => {
    const q = fakeQuery(99);
    expect(probeUniqueIndex(q, "users", "s_u_8_toString", ["toString"], {})).toBeNull();
    expect(q.calls).toEqual([]);
  });

  test("NULLs are excluded and only present columns are grouped (the constraint's own semantics)", () => {
    const q = fakeQuery(0);
    probeUniqueIndex(q, "users", emailIndex, ["email"], cols);
    expect(q.calls[0]).toBe(
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM "users" WHERE "email" IS NOT NULL GROUP BY "email" HAVING COUNT(*) > 1)',
    );
  });

  test("a renamed table probes the OLD physical names while the refusal names the target world", () => {
    const q = fakeQuery(2);
    const refusal = probeUniqueIndex(q, "members", emailIndex, ["email"], cols, {
      table: "users",
      column: (c) => (c === "email" ? "mail" : c),
    });
    // SQL reads the pre-rename physical table + column...
    expect(q.calls[0]).toBe(
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM "users" WHERE "mail" IS NOT NULL GROUP BY "mail" HAVING COUNT(*) > 1)',
    );
    // ...but the refusal points at the new (target) site and its logical columns.
    expect(refusal).toEqual({
      table: "members",
      index: emailIndex,
      reason: "unique-index-duplicates",
      question: "unique index over (email); 2 duplicate group(s) exist",
      count: 2,
    });
  });
});

describe("reconcile: refusal surface", () => {
  test("the message names the migration recourse and the acker reset escape hatch", () => {
    const path = freshPath();
    const a = new Engine(baseSchema(), path);
    reconcile(a);
    a.close("clean");

    const withRequired = defineSchema({
      users: defineTable({ id: v.primaryKey(), name: v.string(), role: RRole(), slug: v.string() })
        .index(["name"]),
    });
    const b = new Engine(withRequired, path);
    try {
      reconcile(b);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeSchemaChange);
      const refusal = error as UnsafeSchemaChange;
      expect(refusal.refusals).toEqual([
        {
          table: "users",
          column: "slug",
          reason: "required-column-added",
          question: "required column added; existing rows would have no value",
        },
      ]);
      expect(refusal.message).toContain("users.slug: required column added");
      expect(refusal.message).toContain("migration");
      expect(refusal.message).toContain("acker reset");
    }
    b.close("clean");
  });

  test("a safe change alongside an unsafe one applies nothing (all-or-nothing)", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "keeper", role: "admin" });
    a.engine.close("clean");

    // one safe change (new table + enum) + one unsafe (required column)
    const mixed = defineSchema({
      users: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        role: RRole(),
        slug: v.string(),
      }).index(["name"]),
      audit: defineTable({ id: v.primaryKey(), line: v.enum("AuditKind", ["created", "deleted"]) }),
    });
    const refusing = new Engine(mixed, path);
    expect(() => reconcile(refusing)).toThrow(UnsafeSchemaChange);
    expect(refusing.writer.query("SELECT name FROM sqlite_master WHERE name = 'audit'").get()).toBe(null);
    expect(refusing.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_tags WHERE type = 'AuditKind'").get()).toEqual({
      count: 0n,
    });
    refusing.close("clean");
  });
});
