import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  newWriteCollector,
  reconcile,
  UnsafeSchemaChange,
  type Schema,
} from "@dbzz/server";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbzz-rec-"));
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

const baseSchema = () =>
  defineSchema({
    users: defineTable({
      id: dbz.primaryKey(),
      name: dbz.string(),
      role: dbz.enum("RRole", ["admin", "member", "guest"]),
    }).index("by_name", ["name"]),
  });

describe("reconcile", () => {
  test("fresh database initializes; identical schema is a no-op", () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    expect(a.applied).toEqual(["initialized 1 table(s)"]);
    a.engine.close();
    const b = open(baseSchema(), path);
    expect(b.applied).toEqual([]);
    b.engine.close();
  });

  test("adding tables and nullable columns applies with data present", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "ana", role: "admin" });
    a.engine.close();

    const grown = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
        bio: dbz.nullable(dbz.string()),
      }).index("by_name", ["name"]),
      posts: defineTable({ id: dbz.primaryKey(), title: dbz.string() }),
      pings: defineEventTable(
        { id: dbz.primaryKey(), n: dbz.bigint() },
        { args: {}, access: "public", matches: () => true },
      ),
    });
    const b = open(grown, path);
    expect(b.applied).toContain("created table posts");
    expect(b.applied).toContain("added event table pings");
    expect(b.applied).toContain("added nullable column users.bio");
    const ana = await b.db.users.get(1n);
    expect(ana).toMatchObject({ name: "ana", bio: null });
    await b.db.posts.insert({ title: "t" });
    b.engine.close();
  });

  test("required column: rebuild when empty, refuse when rows exist", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    a.engine.close();

    const withCredits = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
        credits: dbz.number(),
      }).index("by_name", ["name"]),
    });
    const b = open(withCredits, path); // empty table -> rebuild
    expect(b.applied).toEqual(["rebuilt table users"]);
    await b.db.users.insert({ name: "ana", role: "admin", credits: 5 });
    b.engine.close();

    const withMore = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
        credits: dbz.number(),
        slug: dbz.string(),
      }).index("by_name", ["name"]),
    });
    const engine = new Engine(withMore, path);
    expect(() => reconcile(engine)).toThrow(UnsafeSchemaChange);
    expect(() => reconcile(engine)).toThrow("1 row(s) with no value");
    engine.close();
  });

  test("widen keeps data and ids; sequence never reuses ids across rebuild", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "a", role: "admin" });
    await a.db.users.insert({ name: "b", role: "member" });
    await a.db.users.delete(2n); // high id gone; must not be reused
    a.engine.close();

    const widened = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.nullable(dbz.string()),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
      }).index("by_name", ["name"]),
    });
    const b = open(widened, path);
    expect(b.applied).toEqual(["rebuilt table users"]);
    expect(await b.db.users.get(1n)).toMatchObject({ name: "a" });
    const newId = await b.db.users.insert({ name: null, role: "guest" });
    expect(newId).toBe(3n);
    b.engine.close();
  });

  test("narrow refuses when NULLs exist, applies when clean", async () => {
    const path = freshPath();
    const nullable = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.nullable(dbz.string()) }),
    });
    const a = open(nullable, path);
    await a.db.users.insert({ name: null });
    a.engine.close();

    const required = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
    });
    const refusing = new Engine(required, path);
    expect(() => reconcile(refusing)).toThrow("1 row(s) hold NULL");
    refusing.close();

    const fix = open(nullable, path);
    await fix.db.users.patch(1n, { name: "fixed" });
    fix.engine.close();

    const b = open(required, path);
    expect(b.applied).toEqual(["rebuilt table users"]);
    expect((await b.db.users.get(1n)).name).toBe("fixed");
    b.engine.close();
  });

  test("enum variants: add/reorder free; removal gated on live rows", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "m", role: "member" });
    a.engine.close();

    // reorder + add: applies, tags stable
    const reordered = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["guest", "admin", "trial", "member"]),
      }).index("by_name", ["name"]),
    });
    const b = open(reordered, path);
    expect((await b.db.users.get(1n)).role).toBe("member");
    b.engine.close();

    // removing 'member' while a row holds it: refuse with the count
    const dropped = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["guest", "admin", "trial"]),
      }).index("by_name", ["name"]),
    });
    const refusing = new Engine(dropped, path);
    expect(() => reconcile(refusing)).toThrow("variant 'member' removed, but 1 row(s) still hold it");
    refusing.close();

    // clear the row, then removal applies
    const c = open(reordered, path);
    await c.db.users.patch(1n, { role: "guest" });
    c.engine.close();
    const d = open(dropped, path);
    expect((await d.db.users.get(1n)).role).toBe("guest");
    d.engine.close();
  });

  test("union payload change gated on rows holding that variant", async () => {
    const path = freshPath();
    const uSchema = (imageValidator: ReturnType<typeof dbz.object>) =>
      defineSchema({
        posts: defineTable({
          id: dbz.primaryKey(),
          body: dbz.union("PBody", { text: dbz.string(), image: imageValidator }),
        }),
      });
    const v1 = uSchema(dbz.object({ url: dbz.string() }));
    const a = open(v1, path);
    await a.db.posts.insert({ body: { tag: "text", value: "hello" } });
    a.engine.close();

    // only 'text' rows exist: changing 'image' payload is safe
    const v2 = uSchema(dbz.object({ url: dbz.string(), width: dbz.number() }));
    const b = open(v2, path);
    await b.db.posts.insert({ body: { tag: "image", value: { url: "u", width: 1 } } });
    b.engine.close();

    // now an 'image' row exists: changing it again refuses
    const v3 = uSchema(dbz.object({ href: dbz.string() }));
    const refusing = new Engine(v3, path);
    expect(() => reconcile(refusing)).toThrow("variant 'image' payload type changed");
    refusing.close();
  });

  test("index lifecycle: add, drop, unique over duplicates refuses", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "dup", role: "admin" });
    await a.db.users.insert({ name: "dup", role: "member" });
    a.engine.close();

    const uniqueName = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
      }).index("by_name", ["name"], { unique: true }),
    });
    const refusing = new Engine(uniqueName, path);
    expect(() => reconcile(refusing)).toThrow("1 group(s) of duplicate rows");
    refusing.close();

    const roleIndexed = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
      }).index("by_role", ["role"]),
    });
    const b = open(roleIndexed, path);
    expect(b.applied).toContain("dropped index users.by_name");
    expect(b.applied).toContain("created index users.by_role");
    const admins = await b.db.users.byRole((q: any) => q.eq("role", "admin")).collect();
    expect(admins).toHaveLength(1);
    b.engine.close();
  });

  test("dropping tables: empty drops, non-empty refuses", async () => {
    const path = freshPath();
    const two = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
      logs: defineTable({ id: dbz.primaryKey(), line: dbz.string() }),
    });
    const a = open(two, path);
    await a.db.logs.insert({ line: "x" });
    a.engine.close();

    const one = defineSchema({
      users: defineTable({ id: dbz.primaryKey(), name: dbz.string() }),
    });
    const refusing = new Engine(one, path);
    expect(() => reconcile(refusing)).toThrow("table logs dropped, but it still holds 1 row(s)");
    refusing.close();

    const b = open(two, path);
    await b.db.logs.delete(1n);
    b.engine.close();
    const c = open(one, path);
    expect(c.applied).toContain("dropped logs");
    c.engine.close();
  });

  test("refusal leaves the database untouched (all-or-nothing)", async () => {
    const path = freshPath();
    const a = open(baseSchema(), path);
    await a.db.users.insert({ name: "keeper", role: "admin" });
    a.engine.close();

    // one safe change (new table) + one unsafe (required column on non-empty)
    const mixed = defineSchema({
      users: defineTable({
        id: dbz.primaryKey(),
        name: dbz.string(),
        role: dbz.enum("RRole", ["admin", "member", "guest"]),
        slug: dbz.string(),
      }).index("by_name", ["name"]),
      audit: defineTable({
        id: dbz.primaryKey(),
        line: dbz.enum("AuditKind", ["created", "deleted"]),
      }),
    });
    const refusing = new Engine(mixed, path);
    expect(() => reconcile(refusing)).toThrow(UnsafeSchemaChange);
    // the safe part (audit table) must NOT have been applied
    expect(
      refusing.writer.query("SELECT name FROM sqlite_master WHERE name = 'audit'").get(),
    ).toBe(null);
    expect(
      refusing.writer.query("SELECT COUNT(*) AS count FROM _dbz_tags WHERE type = 'AuditKind'").get(),
    ).toEqual({ count: 0n });
    refusing.close();
  });
});
