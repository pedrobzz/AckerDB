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
  MigrationError,
  newWriteCollector,
  reconcile,
  snapshotOf,
  type Migration,
  type Schema,
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

/** Reopen `path` under `schema` and run `migration`; returns the live engine + db. */
async function migrate(schema: Schema, path: string, migration: Migration) {
  const engine = new Engine(schema, path);
  const { applied } = await reconcile(engine, migration);
  return { engine, db: db(engine), applied };
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
    expect(applied).toContain("migrated table users");
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
    await expect(reconcile(engine, defineMigration({ tables: {} }))).rejects.toThrow(/refused table\(s\): posts/);
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
    await expect(reconcile(engine, migration)).rejects.toThrow(/unknown table "ghost"/);
    assertUntouched(engine);
    engine.close("clean");
  });

  test("null for a surviving table errors", async () => {
    const path = freshPath();
    await seedOne(path);
    const engine = new Engine(b, path);
    await expect(reconcile(engine, defineMigration({ tables: { posts: null } }))).rejects.toThrow(
      /"posts" still exists/,
    );
    assertUntouched(engine);
    engine.close("clean");
  });

  test("validation errors are MigrationError", async () => {
    const path = freshPath();
    await seedOne(path);
    const engine = new Engine(b, path);
    await expect(reconcile(engine, defineMigration({ tables: {} }))).rejects.toBeInstanceOf(MigrationError);
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
    await expect(reconcile(engine, migration)).rejects.toThrow("boom");
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
    await expect(reconcile(engine, migration)).rejects.toThrow(/UNIQUE/);
    // nothing applied: names intact, the index never became unique
    expect(engine.loadSnapshot()).toEqual(snapshotOf(a));
    const names = (engine.writer.query("SELECT name FROM users ORDER BY id").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toEqual(["ana", "bea"]);
    engine.close("clean");
  });
});
