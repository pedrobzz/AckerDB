import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dbz,
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  migrationFingerprint,
  newWriteCollector,
  reconcile,
  snapshotOf,
  type Schema,
} from "@dbzz/server";
import { loadConfig } from "../src/config.ts";
import { generateMigration } from "../src/generate.ts";
import { loadMigrationChain } from "../src/migrations.ts";
import { makeFixture } from "./fixture.ts";

const REPO = new URL("../../..", import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A schema pair exercising every stub class at once: a pure column drop
// (destructuring), a type change and a variant-removal + required-add (holes), a
// dropped table (null), and a pure column rename (no entry, but rendered).
const PRE = defineSchema({
  accounts: defineTable({ id: dbz.primaryKey(), count: dbz.string(), city: dbz.string() }),
  posts: defineTable({ id: dbz.primaryKey(), kind: dbz.number() }),
  profiles: defineTable({ id: dbz.primaryKey(), bio: dbz.string() }),
  users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["admin", "guest"]) }),
  legacy: defineTable({ id: dbz.primaryKey(), x: dbz.string() }),
});
const TARGET = defineSchema({
  accounts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }), // city dropped only
  posts: defineTable({ id: dbz.primaryKey(), kind: dbz.string() }), // type change
  profiles: defineTable({ id: dbz.primaryKey(), blurb: dbz.string() }), // bio -> blurb
  users: defineTable({ id: dbz.primaryKey(), role: dbz.enum("Role", ["admin"]), tier: dbz.string() }),
  // legacy dropped
});
const RENAMES = { columns: { profiles: { bio: "blurb" } } };

function generate() {
  return generateMigration({ number: 3, name: "restructure", pre: snapshotOf(PRE), schema: TARGET, renames: RENAMES });
}

describe("generateMigration: scaffold", () => {
  test("a type change becomes a typed hole annotated with the NEW row type", () => {
    const { migrationTs } = generate();
    expect(migrationTs).toContain("posts: (row): PostsRow => {");
    expect(migrationTs).toContain("// TODO(posts.kind): type changed; existing rows would need converting");
    // the hole's NEW row type is imported, nothing else spurious
    expect(migrationTs).toContain('import { defineMigration, type PostsRow, type UsersRow } from "./meta/0003_restructure.types.ts";');
  });

  test("a variant removal and a required add stack their TODOs in classification order", () => {
    const { migrationTs } = generate();
    expect(migrationTs).toContain("users: (row): UsersRow => {");
    const roleAt = migrationTs.indexOf("// TODO(users.role): variant 'guest' removed; existing rows may still hold it");
    const tierAt = migrationTs.indexOf("// TODO(users.tier): required column added; existing rows would have no value");
    expect(roleAt).toBeGreaterThan(-1);
    expect(tierAt).toBeGreaterThan(roleAt);
  });

  test("a column-drops-only table becomes a destructuring transform naming exactly the dropped fields", () => {
    const { migrationTs } = generate();
    expect(migrationTs).toContain("accounts: ({ city, ...rest }) => rest,");
  });

  test("a dropped table becomes a null acknowledgment", () => {
    const { migrationTs } = generate();
    expect(migrationTs).toContain("legacy: null, // table dropped; existing rows would be lost");
  });

  test("rename answers render literally; a pure rename yields no table entry", () => {
    const { migrationTs } = generate();
    expect(migrationTs).toContain('renames: { columns: { profiles: { bio: "blurb" } } },');
    expect(migrationTs).not.toContain("\n    profiles:"); // a pure rename is not a refusal, so no transform entry
  });

  test("mixed drops render as a hole, listing every drop and any other refusal", () => {
    // posts drops `kind`'s old value via type change; a table that has BOTH a drop
    // and a type change must be a hole, not a destructuring.
    const pre = defineSchema({ t: defineTable({ id: dbz.primaryKey(), a: dbz.string(), b: dbz.string() }) });
    const target = defineSchema({ t: defineTable({ id: dbz.primaryKey(), a: dbz.number() }) });
    const { migrationTs } = generateMigration({ number: 1, name: "m", pre: snapshotOf(pre), schema: target });
    expect(migrationTs).toContain("t: (row): TRow => {");
    expect(migrationTs).toContain("// TODO(t.a): type changed; existing rows would need converting");
    expect(migrationTs).toContain("// TODO(t.b): column dropped; existing rows would lose data");
    expect(migrationTs).not.toContain("=> rest");
  });

  test("a column rename on the same table as a drop forces a hole, not a broken destructuring", () => {
    const pre = defineSchema({ t: defineTable({ id: dbz.primaryKey(), old: dbz.string(), gone: dbz.string() }) });
    const target = defineSchema({ t: defineTable({ id: dbz.primaryKey(), renamed: dbz.string() }) });
    const { migrationTs } = generateMigration({
      number: 1,
      name: "m",
      pre: snapshotOf(pre),
      schema: target,
      renames: { columns: { t: { old: "renamed" } } },
    });
    // only `gone` is dropped, but the rename means a plain destructuring would emit
    // the old column name — so it must be a typed hole instead.
    expect(migrationTs).toContain("t: (row): TRow => {");
    expect(migrationTs).toContain("// TODO(t.gone): column dropped; existing rows would lose data");
    expect(migrationTs).not.toContain("=> rest");
  });
});

describe("generateMigration: types companion", () => {
  test("renders OLD vs NEW row types that differ exactly where the schema differs", () => {
    const { typesTs } = generate();
    // type change: old kind is number, new kind is string
    expect(typesTs).toContain("type PostsBefore = { id: bigint; kind: number };");
    expect(typesTs).toContain("export type PostsRow = { id: bigint; kind: string };");
    // variant removal + required add: old role holds guest, new drops it and adds tier
    expect(typesTs).toContain('type UsersBefore = { id: bigint; role: "admin" | "guest" };');
    expect(typesTs).toContain('export type UsersRow = { id: bigint; role: "admin"; tier: string };');
    // pure rename: old bio, new blurb
    expect(typesTs).toContain("type ProfilesBefore = { id: bigint; bio: string };");
    expect(typesTs).toContain("export type ProfilesRow = { id: bigint; blurb: string };");
  });

  test("renders structural enums, unions, arrays, objects, nullables and scalars", () => {
    const pre = defineSchema({ t: defineTable({ id: dbz.primaryKey(), v: dbz.string() }) });
    const target = defineSchema({
      t: defineTable({ id: dbz.primaryKey(), v: dbz.number() }),
      shapes: defineTable({
        id: dbz.primaryKey(),
        e: dbz.enum("E", ["x", "y"]),
        u: dbz.union("U", { text: dbz.string(), nada: dbz.tag() }),
        arr: dbz.array(dbz.nullable(dbz.string())),
        obj: dbz.object({ a: dbz.bigint(), b: dbz.bytes() }),
        maybe: dbz.nullable(dbz.boolean()),
      }),
    });
    const { typesTs } = generateMigration({ number: 1, name: "m", pre: snapshotOf(pre), schema: target });
    expect(typesTs).toContain(
      'export type ShapesRow = { id: bigint; e: "x" | "y"; u: { tag: "text"; value: string } | { tag: "nada"; value: null }; arr: (string | null)[]; obj: { a: bigint; b: Uint8Array }; maybe: boolean | null };',
    );
    // insert shape: pk omitted, nullable optional
    expect(typesTs).toContain(
      'type ShapesInsert = { e: "x" | "y"; u: { tag: "text"; value: string } | { tag: "nada"; value: null }; arr: (string | null)[]; obj: { a: bigint; b: Uint8Array }; maybe?: boolean | null };',
    );
  });

  test("specializes defineMigration: surviving transforms exclude void, dropped tables allow null", () => {
    const { typesTs } = generate();
    expect(typesTs).toContain(
      "posts?: (row: PostsBefore, ctx: MigrationContext) => PostsRow | null | Promise<PostsRow | null>;",
    );
    expect(typesTs).toContain(
      "legacy?: null | ((row: LegacyBefore, ctx: MigrationContext) => void | Promise<void>);",
    );
    // the void-exclusion gate: no surviving transform admits a bare void return
    expect(typesTs).not.toContain("=> PostsRow | null | void");
    expect(typesTs).toContain("export const defineMigration = defineMigrationRuntime as unknown as (");
  });
});

describe("generateMigration: meta sidecar", () => {
  test("matches the loader contract with a correct fingerprint", () => {
    const { metaJson } = generate();
    const meta = JSON.parse(metaJson);
    expect(Object.keys(meta)).toEqual(["number", "name", "fingerprint", "pre", "target"]);
    expect(meta.number).toBe(3);
    expect(meta.name).toBe("restructure");
    expect(meta.pre).toEqual(snapshotOf(PRE));
    expect(meta.target).toEqual(snapshotOf(TARGET));
    expect(meta.fingerprint).toBe(migrationFingerprint(snapshotOf(TARGET)));
  });
});

describe("generateMigration: determinism", () => {
  test("same inputs produce byte-identical artifacts", () => {
    const a = generate();
    const b = generate();
    expect(a.migrationTs).toBe(b.migrationTs);
    expect(a.typesTs).toBe(b.typesTs);
    expect(a.metaJson).toBe(b.metaJson);
  });
});

// -- round-trip: generate, fill, load through the chain, apply, assert --------

function writer(engine: Engine) {
  const writes = newWriteCollector();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return makeDbWriter(engine, writes, () => 0n) as any;
}

async function seed(schema: Schema, path: string, fn: (d: ReturnType<typeof writer>) => Promise<void>): Promise<void> {
  const engine = new Engine(schema, path);
  reconcile(engine);
  await fn(writer(engine));
  engine.close("clean");
}

describe("generateMigration: round-trip through loadMigrationChain + reconcile", () => {
  test("generated pre/target load and apply, transforming real seeded data", async () => {
    const pre = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.string() }) });
    const target = defineSchema({ posts: defineTable({ id: dbz.primaryKey(), count: dbz.number() }) });

    const { migrationTs, typesTs, metaJson } = generateMigration({
      number: 1,
      name: "parse_count",
      pre: snapshotOf(pre),
      schema: target,
    });
    // fill the generated hole with a real conversion (string surgery is fine)
    const filled = migrationTs.replace(
      "      // TODO(posts.count): type changed; existing rows would need converting\n",
      "      return { ...row, count: Number(row.count) || 0 };\n",
    );
    expect(filled).toContain("return { ...row, count: Number(row.count) || 0 };");

    const dir = makeFixture({
      "migrations/0001_parse_count.ts": filled,
      "migrations/meta/0001_parse_count.types.ts": typesTs,
      "migrations/meta/0001_parse_count.json": metaJson,
    });
    dirs.push(dir);

    const dbPath = join(dir, "data.db");
    await seed(pre, dbPath, async (d) => {
      await d.posts.insert({ count: "5" }); // id 1
      await d.posts.insert({ count: "nope" }); // id 2
      await d.posts.insert({ count: "9" }); // id 3
    });

    const config = loadConfig(dir);
    const steps = await loadMigrationChain(config);
    expect(steps.map((s) => [s.number, s.name])).toEqual([[1, "parse_count"]]);

    const engine = new Engine(target, dbPath);
    await reconcile(engine, steps);
    const d = writer(engine);
    expect((await d.posts.get(1n)).count).toBe(5);
    expect((await d.posts.get(2n)).count).toBe(0); // "nope" -> 0
    expect((await d.posts.get(3n)).count).toBe(9);
    engine.close("clean");
  });
});

// -- compile-time guarantees: one tsc run over generated + usage files --------

describe("generateMigration: compile-time gate (single tsc --noEmit)", () => {
  test("the hole fails, filling it compiles, old-typed / removed-variant returns fail", () => {
    // Bundle A: a nullable -> required change (an un-narrowed nullable is the trap).
    const preA = defineSchema({ users: defineTable({ id: dbz.primaryKey(), email: dbz.nullable(dbz.string()) }) });
    const targetA = defineSchema({ users: defineTable({ id: dbz.primaryKey(), email: dbz.string() }) });
    const a = generateMigration({ number: 1, name: "a", pre: snapshotOf(preA), schema: targetA });

    // Bundle B: a variant removal (the removed literal is the trap).
    const preB = defineSchema({
      posts: defineTable({ id: dbz.primaryKey(), status: dbz.enum("Status", ["draft", "published", "archived"]) }),
    });
    const targetB = defineSchema({
      posts: defineTable({ id: dbz.primaryKey(), status: dbz.enum("Status", ["draft", "published"]) }),
    });
    const b = generateMigration({ number: 2, name: "b", pre: snapshotOf(preB), schema: targetB });

    const dir = mkdtempSync(join(tmpdir(), "dbzz-gen-tsc-"));
    dirs.push(dir);
    mkdirSync(join(dir, "meta"), { recursive: true });

    // generated artifacts (the unfilled scaffolds are cases (a) and (d))
    writeFileSync(join(dir, "meta", "0001_a.types.ts"), a.typesTs);
    writeFileSync(join(dir, "0001_a.ts"), a.migrationTs);
    writeFileSync(join(dir, "meta", "0002_b.types.ts"), b.typesTs);
    writeFileSync(join(dir, "0002_b.ts"), b.migrationTs);

    // small usage files that must / must not compile
    const uses: Record<string, string> = {
      // (b) filling the hole with `?? default` compiles
      "a_filled.ts": `import { defineMigration } from "./meta/0001_a.types.ts";
export default defineMigration({ tables: { users: (row) => ({ ...row, email: row.email ?? "" }) } });
`,
      // (c) returning the old-typed value (un-narrowed nullable) FAILS
      "a_badold.ts": `import { defineMigration } from "./meta/0001_a.types.ts";
export default defineMigration({ tables: { users: (row) => row } });
`,
      // (d) returning a removed variant string FAILS
      "b_removed.ts": `import { defineMigration } from "./meta/0002_b.types.ts";
export default defineMigration({ tables: { posts: (row) => ({ ...row, status: "archived" }) } });
`,
      // control: handling the removed case compiles
      "b_handled.ts": `import { defineMigration } from "./meta/0002_b.types.ts";
export default defineMigration({
  tables: { posts: (row) => ({ ...row, status: row.status === "archived" ? "published" : row.status }) },
});
`,
    };
    for (const [name, content] of Object.entries(uses)) writeFileSync(join(dir, name), content);

    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ESNext"],
          types: ["bun"],
          typeRoots: [join(REPO, "node_modules", "@types")],
          strict: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          baseUrl: REPO,
          paths: {
            "@dbzz/core": ["packages/core/src/index.ts"],
            "@dbzz/server": ["packages/server/src/index.ts"],
          },
        },
        include: ["./**/*.ts"],
      }),
    );

    const started = Date.now();
    const result = spawnSync(join(REPO, "node_modules", ".bin", "tsc"), ["-p", join(dir, "tsconfig.json"), "--pretty", "false"], {
      encoding: "utf8",
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // eslint-disable-next-line no-console
    console.log(`[generate tsc gate] ${Date.now() - started}ms`);

    // the graph itself must compile clean — only our intended files may error
    expect(out).not.toContain("packages/server/");
    expect(out).not.toContain("packages/core/");

    // failures: the two unfilled holes, the old-typed return, the removed variant
    expect(out).toContain("0001_a.ts");
    expect(out).toContain("0002_b.ts");
    expect(out).toContain("a_badold.ts");
    expect(out).toContain("b_removed.ts");
    // a declared return type with no return is exactly the gate
    expect(out).toContain("TS2355");

    // successes: filled hole and handled removed-case compile
    expect(out).not.toContain("a_filled.ts");
    expect(out).not.toContain("b_handled.ts");
  }, 120_000);
});
