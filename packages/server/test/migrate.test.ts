import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dbz,
  defineMigration,
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  migrationIdentity,
  MigrationError,
  newWriteCollector,
  reconcile,
  snapshotOf,
  type Migration,
  type MigrationStep,
  type Schema,
  type SchemaSnapshot,
} from "@dbzz/server";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbzz-mig-"));
  dirs.push(dir);
  return join(dir, "data.db");
}

function db(engine: Engine) {
  const writes = newWriteCollector();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return makeDbWriter(engine, writes, () => 0n) as any;
}

/** Reconcile `schema` into a fresh database, seed it via `fn`, close. */
async function seed(schema: Schema, path: string, fn: (d: ReturnType<typeof db>) => Promise<void>): Promise<void> {
  const engine = new Engine(schema, path);
  reconcile(engine);
  await fn(db(engine));
  engine.close("clean");
}

/**
 * Wrap a single migration into a one-step chain: `pre` is the snapshot the DB
 * was seeded with (its stored snapshot), `target` is the new declared schema.
 */
function chain(engine: Engine, migration: Migration, number = 1, name = "m"): MigrationStep[] {
  return [{ number, name, pre: engine.loadSnapshot()!, target: snapshotOf(engine.schema), code: "", migration }];
}

/** Reopen `path` under `schema` and run `migration` as a one-step chain. */
async function migrate(schema: Schema, path: string, migration: Migration) {
  const engine = new Engine(schema, path);
  const { applied } = await reconcile(engine, chain(engine, migration));
  return { engine, db: db(engine), applied };
}

/**
 * Reopen `path` under `schema` from scratch — the constructor runs every
 * reopen-time verifier (`verifyApplicationSchema`, `verifySnapshotTags`, tag
 * density), so a successful `new Engine` IS the assertion that the open holds.
 */
function reopen(schema: Schema, path: string) {
  const engine = new Engine(schema, path);
  reconcile(engine); // snapshot already matches; asserts nothing drifted
  return { engine, db: db(engine) };
}

describe("migrate: rebuild transforms", () => {
  test("a type change is resolved by a transform, preserving pks and converting data", async () => {
    const a = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const b = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.posts.insert({ count: "5" }); // id 1
      await d.posts.insert({ count: "nope" }); // id 2
      await d.posts.insert({ count: "9" }); // id 3
      await d.posts.delete(2n); // gap: id 2 gone, must not be reused
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({ tables: { posts: (row) => ({ ...row, count: Number(row.count) || 0 }) } }),
    );
    expect((await d.posts.get(1n)).count).toBe(5);
    expect((await d.posts.get(3n)).count).toBe(9);
    expect(await d.posts.get(2n)).toBe(null);
    // id 2 stays retired; the next insert lands on 4
    expect(await d.posts.insert({ count: 1 })).toBe(4n);
    engine.close("clean");
  });

  test("a null return deletes the row", async () => {
    const a = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const b = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.posts.insert({ count: "1" }); // id 1
      await d.posts.insert({ count: "drop" }); // id 2
      await d.posts.insert({ count: "3" }); // id 3
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({ tables: { posts: (row) => (row.count === "drop" ? null : { count: Number(row.count) }) } }),
    );
    expect(await d.posts.get(2n)).toBe(null);
    expect((await d.posts.get(1n)).count).toBe(1);
    expect((await d.posts.get(3n)).count).toBe(3);
    expect((await d.posts.scan().collect()).length).toBe(2);
    engine.close("clean");
  });

  test("an async transform merges a sibling table through ctx.before", async () => {
    const a = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string(), score: dbz.string() }),
      bonuses: defineTable({ id: dbz.primaryKey(), userId: dbz.bigint(), extra: dbz.number() }),
    });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string(), score: dbz.number() }),
      bonuses: defineTable({ id: dbz.primaryKey(), userId: dbz.bigint(), extra: dbz.number() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ name: "ana", score: "10" }); // id 1
      await d.users.insert({ name: "bea", score: "20" }); // id 2
      await d.bonuses.insert({ userId: 1n, extra: 3 });
      await d.bonuses.insert({ userId: 1n, extra: 4 });
      await d.bonuses.insert({ userId: 2n, extra: 100 });
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          users: async (row, ctx) => {
            let total = Number(row.score);
            for await (const bonus of ctx.before.bonuses!.scan()) {
              if (bonus.userId === row.id) total += bonus.extra as number;
            }
            return { ...row, score: total };
          },
        },
      }),
    );
    expect((await d.users.get(1n)).score).toBe(17); // 10 + 3 + 4
    expect((await d.users.get(2n)).score).toBe(120); // 20 + 100
    engine.close("clean");
  });
});

describe("migrate: emits", () => {
  test("a column drop salvages into a freshly created junction table", async () => {
    const a = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), ownerId: dbz.bigint() }) });
    const b = defineSchema({
      posts: defineTable({ id: dbz.primaryKey() }),
      post_owners: defineTable({ id: dbz.primaryKey(), postId: dbz.bigint(), ownerId: dbz.bigint() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.posts.insert({ ownerId: 7n }); // id 1
      await d.posts.insert({ ownerId: 8n }); // id 2
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          posts: (row, ctx) => {
            ctx.insert("post_owners", { postId: row.id, ownerId: row.ownerId });
            return {};
          },
        },
      }),
    );
    const links = await d.post_owners.scan().collect();
    expect(links.map((l: Record<string, unknown>) => [l.postId, l.ownerId])).toEqual([
      [1n, 7n],
      [2n, 8n],
    ]);
    expect(await d.posts.get(1n)).toEqual({ id: 1n }); // ownerId is gone
    engine.close("clean");
  });

  test("a salvage emits into a table being rebuilt this same step", async () => {
    const a = defineSchema({
      source: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      dest: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
    });
    const b = defineSchema({ dest: defineTable({ id: dbz.primaryKey(), val: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.dest.insert({ val: "10" }); // id 1
      await d.dest.insert({ val: "20" }); // id 2
      await d.source.insert({ val: "100" }); // id 1
      await d.source.insert({ val: "200" }); // id 2
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          dest: (row) => ({ val: Number(row.val) }),
          source: (row, ctx) => {
            ctx.insert("dest", { val: Number(row.val) });
          },
        },
      }),
    );
    // rebuilt rows keep their ids (1, 2); emitted rows get fresh ids past the high-water (3, 4)
    const rows = await d.dest.scan().collect();
    expect(rows.map((r: Record<string, unknown>) => [r.id, r.val])).toEqual([
      [1n, 10],
      [2n, 20],
      [3n, 100],
      [4n, 200],
    ]);
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'source'").get()).toBe(null);
    engine.close("clean");
  });
});

describe("migrate: volunteered transforms", () => {
  test("a volunteered transform backfills a shape-safe nullable column, its add-column absorbed", async () => {
    const a = defineSchema({ users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }) });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string(), slug: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ name: "ana" }); // id 1
      await d.users.insert({ name: "bea" }); // id 2
    });

    const { engine, db: d, applied } = await migrate(
      b,
      path,
      defineMigration({ tables: { users: (row) => ({ ...row, slug: (row.name as string).toUpperCase() }) } }),
    );
    expect((await d.users.get(1n)).slug).toBe("ANA");
    expect((await d.users.get(2n)).slug).toBe("BEA");
    // the classified add-column is absorbed by the rebuild, never applied twice
    expect(applied).toContain("0001_m: migrated table users");
    expect(applied).not.toContain("added nullable column users.slug");
    engine.close("clean");
  });
});

describe("migrate: drops", () => {
  test("null acknowledges a dropped table", async () => {
    const a = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
      temp: defineTable({ id: dbz.primaryKey(), x: dbz.string() }),
    });
    const b = defineSchema({ users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ name: "ana" });
      await d.temp.insert({ x: "gone" });
    });

    const { engine, db: d } = await migrate(b, path, defineMigration({ tables: { temp: null } }));
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'temp'").get()).toBe(null);
    expect(await d.users.get(1n)).toEqual({ id: 1n, name: "ana" });
    engine.close("clean");
  });

  test("a salvage transform emits then drops", async () => {
    const a = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
      legacy: defineTable({ id: dbz.primaryKey(), data: dbz.string() }),
    });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
      archive: defineTable({ id: dbz.primaryKey(), data: dbz.string() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ name: "ana" });
      await d.legacy.insert({ data: "keep-me" });
      await d.legacy.insert({ data: "and-me" });
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({ tables: { legacy: (row, ctx) => ctx.insert("archive", { data: row.data }) } }),
    );
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'legacy'").get()).toBe(null);
    expect((await d.archive.scan().collect()).map((r: Record<string, unknown>) => r.data)).toEqual(["keep-me", "and-me"]);
    engine.close("clean");
  });
});

describe("migrate: enum variant removal", () => {
  test("a transform maps the removed variant's rows, enums read as strings both sides", async () => {
    const a = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("RRole", ["admin", "member", "guest"]) }),
    });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("RRole", ["admin", "member"]) }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ role: "admin" }); // id 1
      await d.users.insert({ role: "guest" }); // id 2
    });

    const seen: unknown[] = [];
    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          users: (row) => {
            seen.push(row.role); // the retired variant arrives as its string name
            return { ...row, role: row.role === "guest" ? "member" : row.role };
          },
        },
      }),
    );
    expect(seen).toEqual(["admin", "guest"]);
    expect((await d.users.get(1n)).role).toBe("admin");
    expect((await d.users.get(2n)).role).toBe("member");
    engine.close("clean");
  });
});

describe("migrate: validation refuses before touching anything", () => {
  const a = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
  const b = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });

  async function seedOne(path: string): Promise<void> {
    await seed(a, path, async (d) => {
      await d.posts.insert({ count: "1" });
    });
  }

  function assertUntouched(engine: Engine): void {
    // the stored snapshot is still schema A, and the row still holds a string
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a));
    const row = engine.writer.query("SELECT count FROM posts WHERE id = 1").get() as { count: unknown };
    expect(typeof row.count).toBe("string");
  }

  test("a refused table without an entry errors, naming the table, database untouched", async () => {
    const path = freshPath();
    await seedOne(path);
    const engine = new Engine(b, path);
    await expect(reconcile(engine, chain(engine, defineMigration({ tables: {} })))).rejects.toThrow(/refused table\(s\): posts/);
    assertUntouched(engine);
    engine.close("clean");
  });

  test("an entry for an unknown table errors", async () => {
    const path = freshPath();
    await seedOne(path);
    const engine = new Engine(b, path);
    const migration = defineMigration({
      tables: { posts: (row) => ({ count: Number(row.count) }), ghost: (row) => row },
    });
    await expect(reconcile(engine, chain(engine, migration))).rejects.toThrow(/unknown table "ghost"/);
    assertUntouched(engine);
    engine.close("clean");
  });

  test("null for a surviving table errors", async () => {
    const path = freshPath();
    await seedOne(path);
    const engine = new Engine(b, path);
    await expect(reconcile(engine, chain(engine, defineMigration({ tables: { posts: null } })))).rejects.toThrow(
      /"posts" still exists/,
    );
    assertUntouched(engine);
    engine.close("clean");
  });

  test("validation errors are MigrationError", async () => {
    const path = freshPath();
    await seedOne(path);
    const engine = new Engine(b, path);
    await expect(reconcile(engine, chain(engine, defineMigration({ tables: {} })))).rejects.toBeInstanceOf(MigrationError);
    engine.close("clean");
  });
});

describe("migrate: transactional integrity", () => {
  test("a throwing transform rolls the whole step back, byte-identical", async () => {
    const a = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const b = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.posts.insert({ count: "1" });
      await d.posts.insert({ count: "2" });
      await d.posts.insert({ count: "3" });
    });

    const engine = new Engine(b, path);
    const migration = defineMigration({
      tables: {
        posts: (row) => {
          if (row.count === "2") throw new Error("boom");
          return { count: Number(row.count) };
        },
      },
    });
    await expect(reconcile(engine, chain(engine, migration))).rejects.toThrow("boom");
    // snapshot unchanged, all rows intact and still strings
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a));
    const rows = engine.writer.query("SELECT id, count FROM posts ORDER BY id").all() as {
      id: bigint;
      count: unknown;
    }[];
    expect(rows).toEqual([
      { id: 1n, count: "1" },
      { id: 2n, count: "2" },
      { id: 3n, count: "3" },
    ]);
    engine.close("clean");
  });

  test("a unique index over duplicate transform output fails the migration cleanly", async () => {
    const a = defineSchema({ users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }) });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }).index("by_name", ["name"], { unique: true }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ name: "ana" });
      await d.users.insert({ name: "bea" });
    });

    const engine = new Engine(b, path);
    // the volunteered transform collapses every name to a constant → a duplicate group
    const migration = defineMigration({ tables: { users: () => ({ name: "same" }) } });
    await expect(reconcile(engine, chain(engine, migration))).rejects.toThrow(/UNIQUE/);
    // nothing applied: names intact, the index never became unique
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a));
    const names = (engine.writer.query("SELECT name FROM users ORDER BY id").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toEqual(["ana", "bea"]);
    engine.close("clean");
  });
});

describe("migrate: renames", () => {
  test("a pure table rename keeps rows, ids, and indexes; reopen passes", async () => {
    const a = defineSchema({ logs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }).index("by_msg", ["msg"]) });
    const b = defineSchema({
      auditLogs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }).index("by_msg", ["msg"]),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.logs.insert({ msg: "one" }); // id 1
      await d.logs.insert({ msg: "two" }); // id 2
      await d.logs.delete(1n); // gap: id 1 gone, must stay retired
      await d.logs.insert({ msg: "three" }); // id 3
    });

    const { engine, db: d, applied } = await migrate(
      b,
      path,
      defineMigration({ renames: { tables: { logs: "auditLogs" } } }),
    );
    expect(applied).toContain("0001_m: renamed table logs to auditLogs");
    expect((await d.auditLogs.get(2n)).msg).toBe("two");
    expect((await d.auditLogs.get(3n)).msg).toBe("three");
    expect(await d.auditLogs.get(1n)).toBe(null);
    // old name gone, index usable under the new name
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'logs'").get()).toBe(null);
    const found = await d.auditLogs.byMsg((q: any) => q.eq("msg", "two")).collect();
    expect(found.map((r: any) => r.id)).toEqual([2n]);
    // id 1 stays retired: the next insert lands on 4
    expect(await d.auditLogs.insert({ msg: "four" })).toBe(4n);
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.auditLogs.get(3n)).msg).toBe("three");
    again.engine.close("clean");
  });

  test("a pure column rename keeps data for a plain and a union column; reopen passes", async () => {
    const a = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        street: dbz.string(),
        note: dbz.union("Payload", { text: dbz.string(), nothing: dbz.tag() }),
      }).index("by_street", ["street"]),
    });
    const b = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        streetName: dbz.string(),
        memo: dbz.union("Payload", { text: dbz.string(), nothing: dbz.tag() }),
      }).index("by_street", ["streetName"]),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ street: "main", note: { tag: "text", value: "hi" } }); // id 1
      await d.users.insert({ street: "elm", note: { tag: "nothing", value: null } }); // id 2
    });

    const { engine, db: d, applied } = await migrate(
      b,
      path,
      defineMigration({ renames: { columns: { users: { street: "streetName", note: "memo" } } } }),
    );
    expect(applied).toContain("0001_m: renamed column(s) on users");
    expect(await d.users.get(1n)).toEqual({ id: 1n, streetName: "main", memo: { tag: "text", value: "hi" } });
    expect((await d.users.get(2n)).memo).toEqual({ tag: "nothing", value: null });
    // the index followed the renamed column
    const found = await d.users.byStreet((q: any) => q.eq("streetName", "main")).collect();
    expect(found.map((r: any) => r.id)).toEqual([1n]);
    engine.close("clean");

    const again = reopen(b, path);
    expect(await again.db.users.get(1n)).toEqual({ id: 1n, streetName: "main", memo: { tag: "text", value: "hi" } });
    again.engine.close("clean");
  });

  test("a variant rename keeps the interned tag; no transform; reopen passes", async () => {
    const a = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), status: dbz.enum("Status", ["Test", "Live", "Off"]) }),
    });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), status: dbz.enum("Status", ["Foo", "Live", "Off"]) }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ status: "Test" }); // id 1, interned tag 0
      await d.users.insert({ status: "Live" }); // id 2, interned tag 1
    });

    const { engine, db: d, applied } = await migrate(
      b,
      path,
      defineMigration({ renames: { variants: { Status: { Test: "Foo" } } } }),
    );
    expect(applied).toContain("0001_m: renamed variant Status.Test to Foo");
    // ZERO row rewrites: the stored integer is unchanged
    const rawStatus = (engine.writer.query("SELECT status FROM users WHERE id = 1").get() as { status: bigint }).status;
    expect(rawStatus).toBe(0n);
    // _dbz_tags now maps the NEW name to the OLD tag, and the old name is gone
    const foo = engine.writer.query("SELECT tag FROM _dbz_tags WHERE type = 'Status' AND variant = 'Foo'").get() as {
      tag: bigint;
    };
    expect(foo.tag).toBe(0n);
    expect(engine.writer.query("SELECT 1 FROM _dbz_tags WHERE type = 'Status' AND variant = 'Test'").get()).toBe(null);
    // and the value reads back under the new name
    expect((await d.users.get(1n)).status).toBe("Foo");
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.users.get(1n)).status).toBe("Foo");
    again.engine.close("clean");
  });

  test("an undeclared drop+add is not inferred as a rename", async () => {
    const a = defineSchema({ logs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }) });
    const b = defineSchema({ auditLogs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.logs.insert({ msg: "x" });
    });

    const engine = new Engine(b, path);
    // no rename declared: the drop of logs is refused, the add of auditLogs is not paired to it
    await expect(reconcile(engine, chain(engine, defineMigration({ tables: {} })))).rejects.toThrow(/refused table\(s\): logs/);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a));
    engine.close("clean");
  });

  test("a rename composed with a type change pairs up; old column names in, new shape out", async () => {
    const a = defineSchema({ logs: defineTable({ id: dbz.primaryKey(), rawCount: dbz.string() }) });
    const b = defineSchema({ auditLogs: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.logs.insert({ rawCount: "5" }); // id 1
      await d.logs.insert({ rawCount: "nope" }); // id 2
    });

    const seenKeys: string[][] = [];
    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        renames: { tables: { logs: "auditLogs" }, columns: { auditLogs: { rawCount: "count" } } },
        // keyed by the NEW table name; the input row still carries the OLD column name
        tables: { auditLogs: (row) => (seenKeys.push(Object.keys(row)), { count: Number(row.rawCount) || 0 }) },
      }),
    );
    expect(seenKeys).toEqual([
      ["id", "rawCount"],
      ["id", "rawCount"],
    ]);
    expect((await d.auditLogs.get(1n)).count).toBe(5); // pk preserved
    expect((await d.auditLogs.get(2n)).count).toBe(0);
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'logs'").get()).toBe(null);
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.auditLogs.get(1n)).count).toBe(5);
    again.engine.close("clean");
  });

  test("a table rename composes with a column rename on the same table", async () => {
    const a = defineSchema({ notes: defineTable({ id: dbz.primaryKey(), body: dbz.string() }) });
    const b = defineSchema({ memos: defineTable({ id: dbz.primaryKey(), text: dbz.string() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.notes.insert({ body: "hello" }); // id 1
      await d.notes.insert({ body: "world" }); // id 2
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      // columns keyed by the NEW table name
      defineMigration({ renames: { tables: { notes: "memos" }, columns: { memos: { body: "text" } } } }),
    );
    expect((await d.memos.get(1n)).text).toBe("hello");
    expect((await d.memos.get(2n)).text).toBe("world");
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'notes'").get()).toBe(null);
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.memos.get(2n)).text).toBe("world");
    again.engine.close("clean");
  });

  test("a table rename plus a nullable column add needs no transform", async () => {
    const a = defineSchema({ logs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }) });
    const b = defineSchema({
      auditLogs: defineTable({ id: dbz.primaryKey(), msg: dbz.string(), extra: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.logs.insert({ msg: "one" }); // id 1
      await d.logs.insert({ msg: "two" }); // id 2
      await d.logs.insert({ msg: "three" }); // id 3
      await d.logs.delete(3n); // high-water mark must carry through the identity rebuild
    });

    const { engine, db: d, applied } = await migrate(
      b,
      path,
      defineMigration({ renames: { tables: { logs: "auditLogs" } } }), // no tables section at all
    );
    expect(applied).toContain("0001_m: migrated table auditLogs");
    expect(await d.auditLogs.get(1n)).toEqual({ id: 1n, msg: "one", extra: null });
    expect(await d.auditLogs.get(2n)).toEqual({ id: 2n, msg: "two", extra: null });
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'logs'").get()).toBe(null);
    // id 3 stays retired: the next insert lands on 4
    expect(await d.auditLogs.insert({ msg: "four", extra: "x" })).toBe(4n);
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.auditLogs.get(4n)).extra).toBe("x");
    again.engine.close("clean");
  });

  test("a column rename plus another nullable column add on the same table needs no transform", async () => {
    const a = defineSchema({ users: defineTable({ id: dbz.primaryKey(), street: dbz.string() }) });
    const b = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), streetName: dbz.string(), note: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.users.insert({ street: "main" }); // id 1
      await d.users.insert({ street: "elm" }); // id 2
    });

    const { engine, db: d, applied } = await migrate(
      b,
      path,
      defineMigration({ renames: { columns: { users: { street: "streetName" } } } }),
    );
    expect(applied).toContain("0001_m: migrated table users");
    expect(await d.users.get(1n)).toEqual({ id: 1n, streetName: "main", note: null });
    expect(await d.users.get(2n)).toEqual({ id: 2n, streetName: "elm", note: null });
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.users.get(1n)).streetName).toBe("main");
    again.engine.close("clean");
  });

  test("a unique index added on a renamed table probes the old physical names and refuses with counts", async () => {
    const a = defineSchema({ logs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }) });
    const b = defineSchema({
      auditLogs: defineTable({ id: dbz.primaryKey(), text: dbz.string() }).index("by_text", ["text"], { unique: true }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.logs.insert({ msg: "dup" });
      await d.logs.insert({ msg: "dup" });
    });

    const engine = new Engine(b, path);
    const migration = defineMigration({
      renames: { tables: { logs: "auditLogs" }, columns: { auditLogs: { msg: "text" } } },
    });
    // the counted refusal names the target-world site; the probe read old names
    await expect(reconcile(engine, chain(engine, migration))).rejects.toThrow(
      /auditLogs\.by_text: unique index over \(text\); 1 duplicate group\(s\) exist/,
    );
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a)); // database untouched
    expect(engine.writer.query("SELECT COUNT(*) AS n FROM logs").get()).toEqual({ n: 2n });
    engine.close("clean");
  });

  test("a rename plus a type change still demands a transform", async () => {
    const a = defineSchema({ logs: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const b = defineSchema({ auditLogs: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.logs.insert({ count: "1" });
    });

    const engine = new Engine(b, path);
    await expect(reconcile(engine, chain(engine, defineMigration({ renames: { tables: { logs: "auditLogs" } } })))).rejects.toThrow(
      /refused table\(s\): auditLogs/,
    );
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a));
    engine.close("clean");
  });

  test("a variant rename with a nested use refuses the nested column until a transform rewrites the payloads", async () => {
    const a = defineSchema({
      hosts: defineTable({ id: dbz.primaryKey(), status: dbz.enum("Status", ["Test", "Live"]) }),
      checks: defineTable({ id: dbz.primaryKey(), meta: dbz.object({ s: dbz.enum("Status", ["Test", "Live"]) }) }),
    });
    const b = defineSchema({
      hosts: defineTable({ id: dbz.primaryKey(), status: dbz.enum("Status", ["Foo", "Live"]) }),
      checks: defineTable({ id: dbz.primaryKey(), meta: dbz.object({ s: dbz.enum("Status", ["Foo", "Live"]) }) }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.hosts.insert({ status: "Test" }); // id 1, interned tag 0
      await d.checks.insert({ meta: { s: "Test" } }); // id 1, wire-encoded string, NOT a tag
    });

    // nested values are strings, not tags: the rename covers hosts (top-level),
    // but checks.meta honestly surfaces as type-changed and demands a transform
    const renamesOnly = defineMigration({ renames: { variants: { Status: { Test: "Foo" } } } });
    const refused = new Engine(b, path);
    await expect(reconcile(refused, chain(refused, renamesOnly))).rejects.toThrow(/refused table\(s\): checks/);
    expect(refused.loadSnapshot()).toEqual(snapshotOf(a)); // untouched
    refused.close("clean");

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        renames: { variants: { Status: { Test: "Foo" } } },
        tables: {
          checks: (row) => {
            const meta = row.meta as { s: string };
            return { ...row, meta: { s: meta.s === "Test" ? "Foo" : meta.s } };
          },
        },
      }),
    );
    // top-level storage untouched (tag preserved), nested payload rewritten
    expect((engine.writer.query("SELECT status FROM hosts WHERE id = 1").get() as { status: bigint }).status).toBe(0n);
    expect((await d.hosts.get(1n)).status).toBe("Foo");
    expect((await d.checks.get(1n)).meta).toEqual({ s: "Foo" });
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.checks.get(1n)).meta).toEqual({ s: "Foo" });
    again.engine.close("clean");
  });

  test("an emit into a purely-renamed table lands correctly", async () => {
    const a = defineSchema({
      inbox: defineTable({ id: dbz.primaryKey(), text: dbz.string() }),
      drafts: defineTable({ id: dbz.primaryKey(), text: dbz.string() }),
    });
    const b = defineSchema({ messages: defineTable({ id: dbz.primaryKey(), text: dbz.string() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.inbox.insert({ text: "hi" }); // id 1
      await d.drafts.insert({ text: "draft-a" });
      await d.drafts.insert({ text: "draft-b" });
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        renames: { tables: { inbox: "messages" } },
        // drafts is dropped; its salvage emits into the table renamed this same step
        tables: { drafts: (row, ctx) => ctx.insert("messages", { text: row.text }) },
      }),
    );
    const rows = await d.messages.scan().collect();
    expect(rows.map((r: any) => r.text).sort()).toEqual(["draft-a", "draft-b", "hi"]);
    expect((await d.messages.get(1n)).text).toBe("hi"); // original id preserved
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name IN ('inbox', 'drafts')").all()).toEqual([]);
    engine.close("clean");

    const again = reopen(b, path);
    expect((await again.db.messages.scan().collect()).length).toBe(3);
    again.engine.close("clean");
  });
});

describe("migrate: rename validation refuses before touching anything", () => {
  const one = defineSchema({ a: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });

  async function seedOne(path: string): Promise<void> {
    await seed(one, path, async (d) => {
      await d.a.insert({ v: "x" });
    });
  }

  async function expectRefused(target: Schema, path: string, migration: Migration, pattern: RegExp): Promise<void> {
    const engine = new Engine(target, path);
    await expect(reconcile(engine, chain(engine, migration))).rejects.toThrow(pattern);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(one)); // database untouched
    engine.close("clean");
  }

  test("rename source table must exist in the current snapshot", async () => {
    const path = freshPath();
    await seedOne(path);
    const b = defineSchema({ b: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    await expectRefused(b, path, defineMigration({ renames: { tables: { ghost: "b" } } }), /source table "ghost" does not exist/);
  });

  test("rename target table must exist in the schema", async () => {
    const path = freshPath();
    await seedOne(path);
    const b = defineSchema({ b: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    await expectRefused(b, path, defineMigration({ renames: { tables: { a: "ghost" } } }), /target table "ghost" is not in the schema/);
  });

  test("rename source table must not still exist in the target", async () => {
    const path = freshPath();
    await seedOne(path);
    const b = defineSchema({
      a: defineTable({ id: dbz.primaryKey(), v: dbz.string() }),
      b: defineTable({ id: dbz.primaryKey(), v: dbz.string() }),
    });
    await expectRefused(b, path, defineMigration({ renames: { tables: { a: "b" } } }), /source table "a" still exists/);
  });

  test("rename target table must not already exist in the current snapshot", async () => {
    const path = freshPath();
    await seed(
      defineSchema({
        a: defineTable({ id: dbz.primaryKey(), v: dbz.string() }),
        b: defineTable({ id: dbz.primaryKey(), v: dbz.string() }),
      }),
      path,
      async (d) => {
        await d.a.insert({ v: "x" });
      },
    );
    const b = defineSchema({ b: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    const engine = new Engine(b, path);
    await expect(reconcile(engine, chain(engine, defineMigration({ renames: { tables: { a: "b" } } })))).rejects.toThrow(
      /cannot rename onto a live table/,
    );
    engine.close("clean");
  });

  test("two renames may not share a target table", async () => {
    const path = freshPath();
    await seed(
      defineSchema({
        a: defineTable({ id: dbz.primaryKey(), v: dbz.string() }),
        b: defineTable({ id: dbz.primaryKey(), v: dbz.string() }),
      }),
      path,
      async (d) => {
        await d.a.insert({ v: "x" });
      },
    );
    const c = defineSchema({ c: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    const engine = new Engine(c, path);
    await expect(reconcile(engine, chain(engine, defineMigration({ renames: { tables: { a: "c", b: "c" } } })))).rejects.toThrow(
      /two renames target table "c"/,
    );
    engine.close("clean");
  });

  test("rename source column must exist in the current snapshot", async () => {
    const path = freshPath();
    await seedOne(path);
    const b = defineSchema({ a: defineTable({ id: dbz.primaryKey(), w: dbz.string() }) });
    await expectRefused(
      b,
      path,
      defineMigration({ renames: { columns: { a: { ghost: "w" } } } }),
      /source column "a.ghost" does not exist/,
    );
  });

  test("a variant rename onto a retired historical variant is refused", async () => {
    const s1 = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["Live", "Old"]) }),
    });
    const s2 = defineSchema({ users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["Live"]) }) });
    const s3 = defineSchema({ users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["Old"]) }) });
    const path = freshPath();
    // seed s1 (interns Live=0, Old=1), then retire "Old" — its tag stays in _dbz_tags forever
    const engine1 = new Engine(s1, path);
    reconcile(engine1);
    engine1.close("clean");
    const m2 = await migrate(s2, path, defineMigration({ tables: { users: (row) => ({ ...row, role: "Live" }) } }));
    m2.engine.close("clean");

    // s2 -> s3 renames Live -> Old, but Old is a retired variant (its integer tag is retired).
    // The chain re-presents migration 1 (already applied) plus the pending rename.
    const engine3 = new Engine(s3, path);
    const steps: MigrationStep[] = [
      { number: 1, name: "m", pre: snapshotOf(s1), target: snapshotOf(s2), code: "", migration: defineMigration({}) },
      {
        number: 2,
        name: "retire",
        pre: snapshotOf(s2),
        target: snapshotOf(s3),
        code: "",
        migration: defineMigration({ renames: { variants: { Role: { Live: "Old" } } } }),
      },
    ];
    await expect(reconcile(engine3, steps)).rejects.toThrow(/variant "Role.Old" is a retired variant/);
    expect(engine3.loadSnapshot()).toEqual(snapshotOf(s2)); // untouched
    engine3.close("clean");
  });
});

/** The recorded, ordered migration history of a database. */
function history(engine: Engine): { number: bigint; name: string; identity: string }[] {
  return engine.writer
    .query("SELECT number, name, identity FROM _dbz_migrations ORDER BY number ASC")
    .all() as { number: bigint; name: string; identity: string }[];
}

/**
 * Build a chain from consecutive stages; the first stage's `pre` is the seed's
 * snapshot, and each later stage's `pre` is the previous stage's target.
 */
function buildChain(seed: Schema, stages: { schema: Schema; migration: Migration; name?: string; code?: string }[]): MigrationStep[] {
  const steps: MigrationStep[] = [];
  let pre = snapshotOf(seed);
  stages.forEach((stage, i) => {
    const target = snapshotOf(stage.schema);
    steps.push({ number: i + 1, name: stage.name ?? `m${i + 1}`, pre, target, code: stage.code ?? "", migration: stage.migration });
    pre = target;
  });
  return steps;
}

describe("migrate: the chain", () => {
  test("two pending migrations apply in order; history and data reflect both", async () => {
    const seedS = defineSchema({ items: defineTable({ id: dbz.primaryKey(), qty: dbz.string() }) });
    const s1 = defineSchema({ items: defineTable({ id: dbz.primaryKey(), qty: dbz.number() }) });
    const s2 = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), qty: dbz.number(), label: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5" }); // id 1
      await d.items.insert({ qty: "20" }); // id 2
    });

    const engine = new Engine(s2, path);
    const steps = buildChain(seedS, [
      { name: "parse_qty", schema: s1, code: "A", migration: defineMigration({ tables: { items: (row) => ({ qty: Number(row.qty) }) } }) },
      {
        name: "add_label",
        schema: s2,
        code: "B",
        migration: defineMigration({ tables: { items: (row) => ({ ...row, label: `q${row.qty}` }) } }),
      },
    ]);
    const { applied } = await reconcile(engine, steps);
    // per-step prefixes name each migration
    expect(applied).toContain("0001_parse_qty: migrated table items");
    expect(applied).toContain("0002_add_label: migrated table items");

    const d = db(engine);
    expect(await d.items.get(1n)).toEqual({ id: 1n, qty: 5, label: "q5" });
    expect(await d.items.get(2n)).toEqual({ id: 2n, qty: 20, label: "q20" });

    const rows = history(engine);
    expect(rows.map((r) => [Number(r.number), r.name])).toEqual([
      [1, "parse_qty"],
      [2, "add_label"],
    ]);
    // Identity covers the whole step (number, name, pre, target, code), not just the target.
    expect(rows[0]!.identity).toBe(migrationIdentity(steps[0]!));
    expect(rows[1]!.identity).toBe(migrationIdentity(steps[1]!));
    engine.close("clean");

    // fresh Engine passes every reopen-time verifier (schema version, internals, tags)
    const again = reopen(s2, path);
    expect((await again.db.items.get(2n)).label).toBe("q20");
    again.engine.close("clean");
  });

  test("mid-chain failure keeps earlier steps applied and rolls the failing one back whole", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), qty: dbz.string() }) });
    const s1 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), qty: dbz.number() }) });
    const s2 = defineSchema({
      posts: defineTable({ id: dbz.primaryKey(), qty: dbz.number(), note: dbz.nullable(dbz.string()) }),
    });
    const s3 = defineSchema({
      posts: defineTable({
        id: dbz.primaryKey(),
        qty: dbz.number(),
        note: dbz.nullable(dbz.string()),
        extra: dbz.nullable(dbz.string()),
      }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ qty: "1" });
      await d.posts.insert({ qty: "2" });
      await d.posts.insert({ qty: "3" });
    });

    const engine = new Engine(s3, path);
    const reached: string[] = [];
    await expect(
      reconcile(
        engine,
        buildChain(seedS, [
          { name: "parse", schema: s1, migration: defineMigration({ tables: { posts: (row) => ({ qty: Number(row.qty) }) } }) },
          {
            name: "note",
            schema: s2,
            migration: defineMigration({
              tables: {
                posts: (row) => {
                  if (row.qty === 2) throw new Error("boom");
                  return { ...row, note: `n${row.qty}` };
                },
              },
            }),
          },
          {
            name: "extra",
            schema: s3,
            migration: defineMigration({ tables: { posts: (row) => (reached.push("step3"), { ...row, extra: "x" }) } }),
          },
        ]),
      ),
    ).rejects.toThrow("boom");

    // step 1 committed + recorded; step 2 fully rolled back; step 3 never attempted
    expect(reached).toEqual([]);
    expect(history(engine).map((r) => Number(r.number))).toEqual([1]);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(s1)); // no `note` column; step-2 schema never saved
    const rows = engine.writer.query("SELECT id, qty FROM posts ORDER BY id").all() as { id: bigint; qty: unknown }[];
    expect(rows).toEqual([
      { id: 1n, qty: 1 },
      { id: 2n, qty: 2 },
      { id: 3n, qty: 3 },
    ]);
    engine.close("clean");
  });

  test("editing an applied migration refuses at the next run, naming it", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const applied = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const edited = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.bigint() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ count: "5" });
    });
    const m1 = await migrate(applied, path, defineMigration({ tables: { posts: (row) => ({ count: Number(row.count) }) } }));
    m1.engine.close("clean");

    // same number 1, different target (count: bigint) -> different fingerprint
    const engine = new Engine(edited, path);
    const steps: MigrationStep[] = [
      { number: 1, name: "m", pre: snapshotOf(seedS), target: snapshotOf(edited), code: "", migration: defineMigration({ tables: { posts: (row) => ({ count: BigInt(row.count as number) }) } }) },
    ];
    await expect(reconcile(engine, steps)).rejects.toThrow(/applied migration 0001_m no longer matches.*immutable/s);
    await expect(reconcile(engine, steps)).rejects.toBeInstanceOf(MigrationError);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(applied)); // untouched
    engine.close("clean");
  });

  test("editing only an applied migration's transform code refuses, naming it", async () => {
    // Same number, name, pre, and target: only the migration's file text differs.
    // Identity must cover the code, or two databases could run different data
    // transformations while their histories look identical.
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const target = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ count: "5" });
    });
    const migration = defineMigration({ tables: { posts: (row) => ({ count: Number(row.count) }) } });
    const step = (code: string): MigrationStep => ({ number: 1, name: "m", pre: snapshotOf(seedS), target: snapshotOf(target), code, migration });

    const first = new Engine(target, path);
    await reconcile(first, [step("A")]);
    first.close("clean");

    const second = new Engine(target, path);
    await expect(reconcile(second, [step("B")])).rejects.toThrow(/applied migration 0001_m no longer matches.*immutable/s);
    await expect(reconcile(second, [step("B")])).rejects.toBeInstanceOf(MigrationError);
    expect(second.loadSnapshot()).toEqual(snapshotOf(target)); // untouched
    second.close("clean");
  });

  test("editing only an applied migration's pre snapshot refuses, naming it", async () => {
    // Same number, name, target, and code: only the recorded pre differs.
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const altPre = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string(), note: dbz.nullable(dbz.string()) }) });
    const target = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ count: "5" });
    });
    const migration = defineMigration({ tables: { posts: (row) => ({ count: Number(row.count) }) } });
    const step = (pre: SchemaSnapshot): MigrationStep => ({ number: 1, name: "m", pre, target: snapshotOf(target), code: "", migration });

    const first = new Engine(target, path);
    await reconcile(first, [step(snapshotOf(seedS))]);
    first.close("clean");

    const second = new Engine(target, path);
    await expect(reconcile(second, [step(snapshotOf(altPre))])).rejects.toThrow(/applied migration 0001_m no longer matches.*immutable/s);
    expect(second.loadSnapshot()).toEqual(snapshotOf(target)); // untouched
    second.close("clean");
  });

  test("an applied history row with no corresponding chain step refuses", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    const s1 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), v: dbz.number() }) });
    const s2 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), v: dbz.number(), w: dbz.nullable(dbz.string()) }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ v: "1" });
    });
    const engine = new Engine(s2, path);
    await reconcile(
      engine,
      buildChain(seedS, [
        { schema: s1, migration: defineMigration({ tables: { posts: (row) => ({ v: Number(row.v) }) } }) },
        { schema: s2, migration: defineMigration({ tables: { posts: (row) => ({ ...row, w: "x" }) } }) },
      ]),
    );
    engine.close("clean");

    // reopen presenting only the first step: step 2 is applied but absent from the chain
    const truncated = new Engine(s1, path);
    await expect(
      reconcile(truncated, buildChain(seedS, [{ schema: s1, migration: defineMigration({ tables: { posts: (row) => ({ v: Number(row.v) }) } }) }])),
    ).rejects.toThrow(/applied migration 0002_m2 no longer matches.*immutable/s);
    truncated.close("clean");
  });

  test("duplicate or non-increasing numbers refuse before touching anything", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    const s1 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), v: dbz.number() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ v: "1" });
    });
    const engine = new Engine(s1, path);
    const parse = defineMigration({ tables: { posts: (row) => ({ v: Number(row.v) }) } });
    const dupNumbers: MigrationStep[] = [
      { number: 1, name: "a", pre: snapshotOf(seedS), target: snapshotOf(s1), code: "", migration: parse },
      { number: 1, name: "b", pre: snapshotOf(s1), target: snapshotOf(s1), code: "", migration: defineMigration({}) },
    ];
    await expect(reconcile(engine, dupNumbers)).rejects.toThrow(/numbers must strictly increase/);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(seedS)); // untouched, string still a string
    expect(history(engine)).toEqual([]);
    engine.close("clean");
  });

  test("partial prefix: a chain of 3 with 2 already applied runs only the third", async () => {
    const seedS = defineSchema({ items: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    const s1 = defineSchema({ items: defineTable({ id: dbz.primaryKey(), v: dbz.number() }) });
    const s2 = defineSchema({ items: defineTable({ id: dbz.primaryKey(), v: dbz.number(), w: dbz.nullable(dbz.number()) }) });
    const s3 = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), v: dbz.number(), w: dbz.nullable(dbz.number()), z: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ v: "5" });
    });

    const stage1 = { schema: s1, migration: defineMigration({ tables: { items: (row) => ({ v: Number(row.v) }) } }) };
    const stage2 = { schema: s2, migration: defineMigration({ tables: { items: (row) => ({ ...row, w: (row.v as number) * 2 }) } }) };
    const stage3 = { schema: s3, migration: defineMigration({ tables: { items: (row) => ({ ...row, z: `z${row.v}` }) } }) };

    const first = new Engine(s2, path);
    await reconcile(first, buildChain(seedS, [stage1, stage2]));
    first.close("clean");

    const engine = new Engine(s3, path);
    const { applied } = await reconcile(engine, buildChain(seedS, [stage1, stage2, stage3]));
    // only the third step ran
    expect(applied.some((l) => l.startsWith("0001_"))).toBe(false);
    expect(applied.some((l) => l.startsWith("0002_"))).toBe(false);
    expect(applied).toContain("0003_m3: migrated table items");
    expect(history(engine).map((r) => Number(r.number))).toEqual([1, 2, 3]);
    expect(await db(engine).items.get(1n)).toEqual({ id: 1n, v: 5, w: 10, z: "z5" });
    engine.close("clean");
  });

  test("after the chain, a remaining shape-safe diff to the live schema auto-applies", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.string() }) });
    const stepTarget = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.number() }) });
    // live schema is one shape-safe nullable column ahead of the last migration's target
    const live = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.number(), extra: dbz.nullable(dbz.string()) }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ n: "7" });
    });
    const engine = new Engine(live, path);
    const { applied } = await reconcile(
      engine,
      [{ number: 1, name: "parse", pre: snapshotOf(seedS), target: snapshotOf(stepTarget), code: "", migration: defineMigration({ tables: { posts: (row) => ({ n: Number(row.n) }) } }) }],
    );
    expect(applied).toContain("0001_parse: migrated table posts");
    expect(applied).toContain("added nullable column posts.extra"); // the final hop, unprefixed
    expect(await db(engine).posts.get(1n)).toEqual({ id: 1n, n: 7, extra: null });
    expect(engine.loadSnapshot()).toEqual(snapshotOf(live));
    engine.close("clean");
  });

  test("after the chain, a remaining shape-unsafe diff refuses naming the recourse", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.string() }) });
    const stepTarget = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.number() }) });
    // live schema demands a required column no migration answered
    const live = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.number(), req: dbz.string() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ n: "7" });
    });
    const engine = new Engine(live, path);
    await expect(
      reconcile(
        engine,
        [{ number: 1, name: "parse", pre: snapshotOf(seedS), target: snapshotOf(stepTarget), code: "", migration: defineMigration({ tables: { posts: (row) => ({ n: Number(row.n) }) } }) }],
      ),
    ).rejects.toThrow(/unsafe schema changes.*dbz reset/s);
    // the chain step itself still committed (history records it)
    expect(history(engine).map((r) => Number(r.number))).toEqual([1]);
    engine.close("clean");
  });

  test("safe drift: a pre column and table the database lacks read null / empty", async () => {
    // The migration was generated against a richer pre-state (a nullable column
    // and a whole table) that this database never physically acquired.
    const preSchema = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string(), bio: dbz.nullable(dbz.string()) }),
      logs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }),
    });
    const live = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string(), bio: dbz.nullable(dbz.string()), summary: dbz.string() }),
      logs: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }),
    });
    const seedS = defineSchema({ users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.users.insert({ name: "ana" }); // id 1
      await d.users.insert({ name: "bea" }); // id 2
    });

    const engine = new Engine(live, path);
    const seen: unknown[] = [];
    await reconcile(engine, [
      {
        number: 1,
        name: "summarize",
        pre: snapshotOf(preSchema),
        target: snapshotOf(live),
        code: "",
        migration: defineMigration({
          tables: {
            users: async (row, ctx) => {
              let logCount = 0;
              for await (const _ of ctx.before.logs!.scan()) logCount++; // absent table -> empty
              seen.push(row.bio); // absent nullable column -> null
              return { name: row.name, bio: row.bio, summary: `${row.name}:${row.bio ?? "none"}:${logCount}` };
            },
          },
        }),
      },
    ]);
    expect(seen).toEqual([null, null]); // bio read as null for every row
    const d = db(engine);
    expect(await d.users.get(1n)).toEqual({ id: 1n, name: "ana", bio: null, summary: "ana:none:0" });
    expect((await d.logs.scan().collect()).length).toBe(0);
    engine.close("clean");

    const again = reopen(live, path);
    expect((await again.db.users.get(2n)).summary).toBe("bea:none:0");
    again.engine.close("clean");
  });

  test("an intermediate target's tags encode an enum value the final schema also holds", async () => {
    const seedS = defineSchema({
      events: defineTable({ id: dbz.primaryKey(), kind: dbz.enum("K", ["x"]), n: dbz.string() }),
    });
    // step 1's target (NOT the live schema) is where variant "y" is first interned
    const s1 = defineSchema({
      events: defineTable({ id: dbz.primaryKey(), kind: dbz.enum("K", ["x", "y"]), n: dbz.number() }),
    });
    const live = defineSchema({
      events: defineTable({ id: dbz.primaryKey(), kind: dbz.enum("K", ["x", "y", "z"]), n: dbz.number() }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.events.insert({ kind: "x", n: "5" }); // id 1, kind tag 0
    });

    const engine = new Engine(live, path);
    await reconcile(
      engine,
      buildChain(seedS, [
        // encodes "y" through step 1's tags, not the live engine's speculative ones
        { name: "widen", schema: s1, migration: defineMigration({ tables: { events: (row) => ({ kind: "y", n: Number(row.n) }) } }) },
        { name: "add_z", schema: live, migration: defineMigration({}) },
      ]),
    );
    expect(await db(engine).events.get(1n)).toEqual({ id: 1n, kind: "y", n: 5 });
    engine.close("clean");

    const again = reopen(live, path);
    expect((await again.db.events.get(1n)).kind).toBe("y");
    again.engine.close("clean");
  });

  test("safe drift: a transform on a table the database lacks materializes it empty", async () => {
    const preSchema = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
      archive: defineTable({ id: dbz.primaryKey(), tag: dbz.string() }),
    });
    const live = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string(), note: dbz.string() }),
      archive: defineTable({ id: dbz.primaryKey(), tag: dbz.string() }),
    });
    const seedS = defineSchema({ users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.users.insert({ name: "ana" }); // id 1
    });

    const engine = new Engine(live, path);
    await reconcile(engine, [
      {
        number: 1,
        name: "note",
        pre: snapshotOf(preSchema),
        target: snapshotOf(live),
        code: "",
        migration: defineMigration({
          tables: {
            users: (row) => ({ ...row, note: `note-${row.name}` }),
            archive: (row) => row, // volunteered on a table this database never had
          },
        }),
      },
    ]);
    const d = db(engine);
    expect(await d.users.get(1n)).toEqual({ id: 1n, name: "ana", note: "note-ana" });
    expect((await d.archive.scan().collect()).length).toBe(0); // created empty, no crash
    engine.close("clean");

    const again = reopen(live, path); // physical archive table verified against the snapshot
    expect((await again.db.users.get(1n)).note).toBe("note-ana");
    again.engine.close("clean");
  });

  test("a fresh database stamps the whole chain applied and reopens as a no-op", async () => {
    const seedS = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.string() }) });
    const s1 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.number() }) });
    const live = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), n: dbz.number(), tag: dbz.nullable(dbz.string()) }) });
    const path = freshPath();
    const steps = buildChain(seedS, [
      { schema: s1, migration: defineMigration({ tables: { posts: (row) => ({ n: Number(row.n) }) } }) },
      { schema: live, migration: defineMigration({ tables: { posts: (row) => ({ ...row, tag: "x" }) } }) },
    ]);

    const engine = new Engine(live, path); // brand-new database, no data
    const { applied } = await reconcile(engine, steps);
    expect(applied.some((l) => l.startsWith("initialized"))).toBe(true);
    // the chain is stamped vacuously applied — its prefix must hold on reopen
    expect(history(engine).map((r) => Number(r.number))).toEqual([1, 2]);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(live));
    await db(engine).posts.insert({ n: 3, tag: "y" }); // id 1
    engine.close("clean");

    const again = new Engine(live, path);
    const { applied: none } = await reconcile(again, steps); // full prefix match → nothing pending
    expect(none).toEqual([]);
    expect(await db(again).posts.get(1n)).toEqual({ id: 1n, n: 3, tag: "y" });
    again.close("clean");
  });
});

describe("migrate: carried columns (safe drift ahead of the step)", () => {
  test("a rebuild carries a stored column the step's pre and target both lack", async () => {
    // The DB physically holds `note` (safe drift from a lineage the migration
    // never saw); the step only retypes `qty` and knows nothing about `note`.
    const seedS = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), qty: dbz.string(), note: dbz.nullable(dbz.string()) }),
    });
    const pre = defineSchema({ items: defineTable({ id: dbz.primaryKey(), qty: dbz.string() }) });
    const stepTarget = defineSchema({ items: defineTable({ id: dbz.primaryKey(), qty: dbz.number() }) });
    const live = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), qty: dbz.number(), note: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5", note: "keep-me" }); // id 1
      await d.items.insert({ qty: "9", note: "and-me" }); // id 2
    });

    const engine = new Engine(live, path);
    await reconcile(engine, [
      {
        number: 1,
        name: "retype",
        pre: snapshotOf(pre),
        target: snapshotOf(stepTarget),
        code: "",
        migration: defineMigration({ tables: { items: (row) => ({ qty: Number(row.qty) }) } }),
      },
    ]);
    const d = db(engine);
    expect(await d.items.get(1n)).toEqual({ id: 1n, qty: 5, note: "keep-me" });
    expect(await d.items.get(2n)).toEqual({ id: 2n, qty: 9, note: "and-me" });
    engine.close("clean");

    const again = reopen(live, path); // physical `note` verified against the augmented snapshot
    expect((await again.db.items.get(1n)).note).toBe("keep-me");
    again.engine.close("clean");
  });

  test("a carried column survives two consecutive rebuilds and the final safe hop", async () => {
    const seedS = defineSchema({
      posts: defineTable({ id: dbz.primaryKey(), qty: dbz.string(), note: dbz.nullable(dbz.string()) }),
    });
    const pre1 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), qty: dbz.string() }) });
    const t1 = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), qty: dbz.number() }) });
    const t2 = defineSchema({
      posts: defineTable({ id: dbz.primaryKey(), qty: dbz.number(), label: dbz.nullable(dbz.string()) }),
    });
    const live = defineSchema({
      posts: defineTable({
        id: dbz.primaryKey(),
        qty: dbz.number(),
        label: dbz.nullable(dbz.string()),
        note: dbz.nullable(dbz.string()),
      }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.posts.insert({ qty: "5", note: "keep-me" }); // id 1
      await d.posts.insert({ qty: "20", note: "and-me" }); // id 2
    });

    const engine = new Engine(live, path);
    await reconcile(engine, [
      {
        number: 1,
        name: "parse",
        pre: snapshotOf(pre1),
        target: snapshotOf(t1),
        code: "",
        migration: defineMigration({ tables: { posts: (row) => ({ qty: Number(row.qty) }) } }),
      },
      {
        number: 2,
        name: "label",
        pre: snapshotOf(t1),
        target: snapshotOf(t2),
        code: "",
        migration: defineMigration({ tables: { posts: (row) => ({ ...row, label: `q${row.qty}` }) } }),
      },
    ]);
    const d = db(engine);
    expect(await d.posts.get(1n)).toEqual({ id: 1n, qty: 5, label: "q5", note: "keep-me" });
    expect(await d.posts.get(2n)).toEqual({ id: 2n, qty: 20, label: "q20", note: "and-me" });
    // the final safe hop is a no-op: the live schema still carries `note`
    expect(engine.loadSnapshot()).toEqual(snapshotOf(live));
    engine.close("clean");

    const again = reopen(live, path);
    expect((await again.db.posts.get(1n)).note).toBe("keep-me");
    again.engine.close("clean");
  });

  test("a stored NOT NULL column the pre and target both lack is refused up front, naming it", async () => {
    // A NOT NULL column drifted in on a parallel branch; the step's pre/target
    // both lack it. Legal safe drift (widening-only) can never produce a NOT NULL
    // stored-only column, so the lineage is not shape-safe drift — refused before
    // the transaction ever opens, never accommodated mid-flight.
    const seedS = defineSchema({
      dest: defineTable({ id: dbz.primaryKey(), val: dbz.string(), tag: dbz.string() }),
      source: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
    });
    const pre = defineSchema({
      dest: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      source: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
    });
    const stepTarget = defineSchema({ dest: defineTable({ id: dbz.primaryKey(), val: dbz.number() }) });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.dest.insert({ val: "10", tag: "t1" }); // id 1
      await d.source.insert({ val: "99" }); // id 1
    });

    const engine = new Engine(stepTarget, path);
    await expect(
      reconcile(engine, [
        {
          number: 1,
          name: "salvage",
          pre: snapshotOf(pre),
          target: snapshotOf(stepTarget),
          code: "",
          migration: defineMigration({
            tables: {
              dest: (row) => ({ val: Number(row.val) }),
              source: (row, ctx) => ctx.insert("dest", { val: Number(row.val) }),
            },
          }),
        },
      ]),
    ).rejects.toThrow(/"tag".*not shape-safe drift/);
    await expect(
      reconcile(engine, [
        { number: 1, name: "salvage", pre: snapshotOf(pre), target: snapshotOf(stepTarget), code: "", migration: defineMigration({ tables: { dest: (row) => ({ val: Number(row.val) }) } }) },
      ]),
    ).rejects.toBeInstanceOf(MigrationError);
    // nothing touched: the DB and its history are untouched, the drifted column intact
    expect(engine.loadSnapshot()).toEqual(snapshotOf(seedS));
    expect(history(engine)).toEqual([]);
    engine.close("clean");
  });

  test("a defaults column whose stored descriptor conflicts with the target's is refused up front", async () => {
    // The DB physically holds `note` as nullable string (parallel-lineage drift);
    // the step's pre lacks it and its target re-declares it as nullable NUMBER.
    // A PRE-typed transform cannot see the column, so a stored string could not be
    // coerced into a number at row time — hoisted to a clean up-front refusal.
    const seedS = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), qty: dbz.string(), note: dbz.nullable(dbz.string()) }),
    });
    const pre = defineSchema({ items: defineTable({ id: dbz.primaryKey(), qty: dbz.string() }) });
    const live = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), qty: dbz.number(), note: dbz.nullable(dbz.number()) }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5", note: "keep-me" }); // id 1
    });

    const engine = new Engine(live, path);
    await expect(
      reconcile(engine, [
        {
          number: 1,
          name: "retype",
          pre: snapshotOf(pre),
          target: snapshotOf(live),
          code: "",
          migration: defineMigration({ tables: { items: (row) => ({ qty: Number(row.qty) }) } }),
        },
      ]),
    ).rejects.toThrow(/"note".*conflicts/);
    // nothing touched: still the seed schema, no history, row still a string
    expect(engine.loadSnapshot()).toEqual(snapshotOf(seedS));
    expect(history(engine)).toEqual([]);
    const raw = engine.writer.query("SELECT note FROM items WHERE id = 1").get() as { note: unknown };
    expect(typeof raw.note).toBe("string");
    engine.close("clean");
  });
});

describe("migrate: pre-absent target columns default to stored values", () => {
  // The step's PRE lacks `note`, its TARGET has it, and the database already
  // physically holds it populated (parallel-lineage drift). A PRE-typed
  // transform cannot see the column, so an output that never mentions the key
  // must not destroy its data.
  const seedS = defineSchema({
    items: defineTable({ id: dbz.primaryKey(), qty: dbz.string(), note: dbz.nullable(dbz.string()) }),
  });
  const pre = defineSchema({ items: defineTable({ id: dbz.primaryKey(), qty: dbz.string() }) });
  const live = defineSchema({
    items: defineTable({ id: dbz.primaryKey(), qty: dbz.number(), note: dbz.nullable(dbz.string()) }),
  });

  async function run(path: string, transform: (row: Record<string, unknown>) => unknown) {
    const engine = new Engine(live, path);
    await reconcile(engine, [
      {
        number: 1,
        name: "retype",
        pre: snapshotOf(pre),
        target: snapshotOf(live),
        code: "",
        migration: defineMigration({ tables: { items: transform as never } }),
      },
    ]);
    return { engine, db: db(engine) };
  }

  test("a transform that never mentions the key keeps the stored value", async () => {
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5", note: "keep-me" }); // id 1
      await d.items.insert({ qty: "9", note: null }); // id 2
    });
    const { engine, db: d } = await run(path, (row) => ({ ...row, qty: Number(row.qty) }));
    expect(await d.items.get(1n)).toEqual({ id: 1n, qty: 5, note: "keep-me" });
    expect(await d.items.get(2n)).toEqual({ id: 2n, qty: 9, note: null });
    engine.close("clean");

    const again = reopen(live, path);
    expect((await again.db.items.get(1n)).note).toBe("keep-me");
    again.engine.close("clean");
  });

  test("an undefined return (keep the handed row) flows through the same default", async () => {
    // target only re-declares `note`; qty is unchanged, the transform is a
    // volunteered no-op returning undefined — the kept row still carries note.
    const same = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), qty: dbz.string(), note: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5", note: "keep-me" }); // id 1
    });
    const engine = new Engine(same, path);
    await reconcile(engine, [
      {
        number: 1,
        name: "noop",
        pre: snapshotOf(pre),
        target: snapshotOf(same),
        code: "",
        migration: defineMigration({ tables: { items: () => undefined } }),
      },
    ]);
    expect(await db(engine).items.get(1n)).toEqual({ id: 1n, qty: "5", note: "keep-me" });
    engine.close("clean");
  });

  test("an explicit backfill wins over the stored value", async () => {
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5", note: "keep-me" }); // id 1
    });
    const { engine, db: d } = await run(path, (row) => ({ qty: Number(row.qty), note: "backfilled" }));
    expect(await d.items.get(1n)).toEqual({ id: 1n, qty: 5, note: "backfilled" });
    engine.close("clean");
  });

  test("an explicit null is a provided value, not a carry", async () => {
    const path = freshPath();
    await seed(seedS, path, async (d) => {
      await d.items.insert({ qty: "5", note: "keep-me" }); // id 1
    });
    const { engine, db: d } = await run(path, (row) => ({ qty: Number(row.qty), note: null }));
    expect(await d.items.get(1n)).toEqual({ id: 1n, qty: 5, note: null });
    engine.close("clean");
  });

  test("a genuinely new column (stored also lacks it) still lands NULL", async () => {
    const path = freshPath();
    await seed(pre, path, async (d) => {
      await d.items.insert({ qty: "5" }); // id 1 — no `note` anywhere in this lineage
    });
    const { engine, db: d } = await run(path, (row) => ({ ...row, qty: Number(row.qty) }));
    expect(await d.items.get(1n)).toEqual({ id: 1n, qty: 5, note: null });
    engine.close("clean");
  });

  test("emits into the rebuilt table get the emitter's value or null, never a stored carry", async () => {
    const seedBoth = defineSchema({
      dest: defineTable({ id: dbz.primaryKey(), val: dbz.string(), note: dbz.nullable(dbz.string()) }),
      source: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
    });
    const preBoth = defineSchema({
      dest: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      source: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
    });
    const target = defineSchema({
      dest: defineTable({ id: dbz.primaryKey(), val: dbz.number(), note: dbz.nullable(dbz.string()) }),
    });
    const path = freshPath();
    await seed(seedBoth, path, async (d) => {
      await d.dest.insert({ val: "10", note: "keep-me" }); // id 1
      await d.source.insert({ val: "99" }); // id 1
    });
    const engine = new Engine(target, path);
    await reconcile(engine, [
      {
        number: 1,
        name: "merge",
        pre: snapshotOf(preBoth),
        target: snapshotOf(target),
        code: "",
        migration: defineMigration({
          tables: {
            dest: (row) => ({ ...row, val: Number(row.val) }),
            source: (row, ctx) => ctx.insert("dest", { val: Number(row.val) }),
          },
        }),
      },
    ]);
    const d = db(engine);
    expect(await d.dest.get(1n)).toEqual({ id: 1n, val: 10, note: "keep-me" }); // replayed: carried
    expect(await d.dest.get(2n)).toEqual({ id: 2n, val: 99, note: null }); // emitted: no old row, no carry
    engine.close("clean");
  });
});

describe("migrate: frozen before-state (emits never observed by transforms)", () => {
  test("ctx.before does not observe an emit into an unchanged table", async () => {
    const a = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      log: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }),
    });
    const b = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), val: dbz.number() }),
      log: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.items.insert({ val: "1" }); // id 1
      await d.items.insert({ val: "2" }); // id 2
      await d.log.insert({ msg: "orig" }); // id 1
    });

    const seenCounts: number[] = [];
    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          items: async (row, ctx) => {
            ctx.insert("log", { msg: `from-${row.val}` });
            let count = 0;
            for await (const _ of ctx.before.log!.scan()) count++;
            seenCounts.push(count);
            return { val: Number(row.val) };
          },
        },
      }),
    );
    // every transform sees the single frozen original, never its own or a sibling's emit
    expect(seenCounts).toEqual([1, 1]);
    // the emits still landed after the transforms froze the before-state
    expect((await d.log.scan().collect()).map((r: Record<string, unknown>) => r.msg).sort()).toEqual([
      "from-1",
      "from-2",
      "orig",
    ]);
    engine.close("clean");
  });

  test("a later transform's ctx.before does not observe an earlier transform's emit", async () => {
    const a = defineSchema({
      aa: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      bb: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      cc: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }),
    });
    const b = defineSchema({
      aa: defineTable({ id: dbz.primaryKey(), val: dbz.number() }),
      bb: defineTable({ id: dbz.primaryKey(), val: dbz.number() }),
      cc: defineTable({ id: dbz.primaryKey(), msg: dbz.string() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.aa.insert({ val: "1" });
      await d.bb.insert({ val: "1" });
      await d.cc.insert({ msg: "orig" });
    });

    let bbSaw = -1;
    const { engine, db: d } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          // aa runs first (alphabetical) and emits into the unchanged cc
          aa: (row, ctx) => (ctx.insert("cc", { msg: "from-aa" }), { val: Number(row.val) }),
          // bb runs later and must still see cc frozen
          bb: async (row, ctx) => {
            let c = 0;
            for await (const _ of ctx.before.cc!.scan()) c++;
            bbSaw = c;
            return { val: Number(row.val) };
          },
        },
      }),
    );
    expect(bbSaw).toBe(1); // only the original cc row, not aa's emit
    expect((await d.cc.scan().collect()).map((r: Record<string, unknown>) => r.msg).sort()).toEqual(["from-aa", "orig"]);
    engine.close("clean");
  });
});

// The migration engine's internal page size. Tests seed past it (and past twice
// it) to prove every accumulation is bounded and still walks every row exactly
// once — heap use is not assertable in bun:test, so paging is proven by counts,
// spot values, pk preservation, and order rather than by measuring memory.
const MIGRATE_BATCH = 1000;

describe("migrate: bounded accumulation (paging + emit spool)", () => {
  test("a rebuild transform over more than twice the batch converts every row, preserving pks", async () => {
    const n = 2 * MIGRATE_BATCH + 1; // 2001: two full pages plus a partial one
    const a = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), val: dbz.string() }) });
    const b = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), val: dbz.number() }) });
    const path = freshPath();
    await seed(a, path, async (d) => {
      for (let i = 1; i <= n; i++) await d.posts.insert({ val: String(i) });
    });

    const { engine, db: d } = await migrate(b, path, defineMigration({ tables: { posts: (row) => ({ val: Number(row.val) }) } }));
    expect((await d.posts.scan().collect()).length).toBe(n);
    // pk preserved and value converted at both page boundaries and the tail
    expect(await d.posts.get(1n)).toEqual({ id: 1n, val: 1 });
    expect(await d.posts.get(BigInt(MIGRATE_BATCH))).toEqual({ id: BigInt(MIGRATE_BATCH), val: MIGRATE_BATCH });
    expect(await d.posts.get(BigInt(MIGRATE_BATCH + 1))).toEqual({ id: BigInt(MIGRATE_BATCH + 1), val: MIGRATE_BATCH + 1 });
    expect(await d.posts.get(BigInt(n))).toEqual({ id: BigInt(n), val: n });
    // the next insert lands past the preserved high-water mark
    expect(await d.posts.insert({ val: n + 1 })).toBe(BigInt(n + 1));
    engine.close("clean");
  });

  test("ctx.before.scan() over more than the batch yields every row in pk order", async () => {
    const n = MIGRATE_BATCH + 500; // 1500: one full page plus a partial one
    const a = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
      log: defineTable({ id: dbz.primaryKey(), seq: dbz.number() }),
    });
    const b = defineSchema({
      items: defineTable({ id: dbz.primaryKey(), val: dbz.number() }),
      log: defineTable({ id: dbz.primaryKey(), seq: dbz.number() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      await d.items.insert({ val: "1" });
      for (let i = 1; i <= n; i++) await d.log.insert({ seq: i });
    });

    const seen: number[] = [];
    const { engine } = await migrate(
      b,
      path,
      defineMigration({
        tables: {
          items: async (row, ctx) => {
            for await (const entry of ctx.before.log!.scan()) seen.push(entry.seq as number);
            return { val: Number(row.val) };
          },
        },
      }),
    );
    expect(seen.length).toBe(n);
    expect(seen[0]).toBe(1);
    expect(seen[n - 1]).toBe(n);
    expect(seen.every((v, i) => v === i + 1)).toBe(true); // strictly ascending pk (== seq) order
    engine.close("clean");
  });

  test("an emit-per-source-row salvage spools more than the batch and lands every emit, enum included", async () => {
    const n = MIGRATE_BATCH + 1; // 1001: past a full spool page
    const a = defineSchema({
      events: defineTable({ id: dbz.primaryKey(), kind: dbz.enum("K", ["even", "odd"]), amount: dbz.number() }),
      source: defineTable({ id: dbz.primaryKey(), val: dbz.string() }),
    });
    const b = defineSchema({
      events: defineTable({ id: dbz.primaryKey(), kind: dbz.enum("K", ["even", "odd"]), amount: dbz.number() }),
    });
    const path = freshPath();
    await seed(a, path, async (d) => {
      for (let i = 1; i <= n; i++) await d.source.insert({ val: String(i) });
    });

    const { engine, db: d } = await migrate(
      b,
      path,
      // events is unchanged (not rebuilt): every emit takes the spool path
      defineMigration({
        tables: {
          source: (row, ctx) => {
            const amount = Number(row.val);
            ctx.insert("events", { kind: amount % 2 === 0 ? "even" : "odd", amount });
          },
        },
      }),
    );
    const rows = (await d.events.scan().collect()) as Record<string, unknown>[];
    expect(rows.length).toBe(n);
    // enum values round-tripped through the spool, amounts intact
    expect(rows.every((r) => r.kind === ((r.amount as number) % 2 === 0 ? "even" : "odd"))).toBe(true);
    const amounts = rows.map((r) => r.amount as number).sort((x, y) => x - y);
    expect(amounts[0]).toBe(1);
    expect(amounts[n - 1]).toBe(n);
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = 'source'").get()).toBe(null);
    engine.close("clean");
  });
});
