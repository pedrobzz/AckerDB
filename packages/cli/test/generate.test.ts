import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import {
  v,
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
import { generateMigration } from "../src/migrations/scaffold.ts";
import { loadMigrationChain } from "../src/migrations/load.ts";
import { computePlan, planFingerprint } from "../src/migrations/plan.ts";
import { StaleConsentError, writeMigration } from "../src/migrations/write.ts";
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
  accounts: defineTable({ id: v.primaryKey(), count: v.string(), city: v.string() }),
  posts: defineTable({ id: v.primaryKey(), kind: v.int() }),
  profiles: defineTable({ id: v.primaryKey(), bio: v.string() }),
  users: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["admin", "guest"]) }),
  legacy: defineTable({ id: v.primaryKey(), x: v.string() }),
});
const TARGET = defineSchema({
  accounts: defineTable({ id: v.primaryKey(), count: v.string() }), // city dropped only
  posts: defineTable({ id: v.primaryKey(), kind: v.string() }), // type change
  profiles: defineTable({ id: v.primaryKey(), blurb: v.string() }), // bio -> blurb
  users: defineTable({ id: v.primaryKey(), role: v.enum("Role", ["admin"]), tier: v.string() }),
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

  test("an untouched prototype-named table gets exactly one surviving transform slot", () => {
    const pre = defineSchema({
      toString: defineTable({ id: v.primaryKey(), value: v.string() }),
      legacy: defineTable({ id: v.primaryKey() }),
    });
    const target = defineSchema({
      toString: defineTable({ id: v.primaryKey(), value: v.string() }),
      current: defineTable({ id: v.primaryKey() }),
    });
    const { typesTs } = generateMigration({
      number: 1,
      name: "rename_sibling",
      pre: snapshotOf(pre),
      schema: target,
      renames: { tables: { legacy: "current" } },
    });
    expect(typesTs.match(/\btoString\?:/g)).toHaveLength(1);
    expect(typesTs).not.toContain("toString?: null |");
  });

  test("mixed drops render as a hole, listing every drop and any other refusal", () => {
    // posts drops `kind`'s old value via type change; a table that has BOTH a drop
    // and a type change must be a hole, not a destructuring.
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), a: v.string(), b: v.string() }) });
    const target = defineSchema({ t: defineTable({ id: v.primaryKey(), a: v.float() }) });
    const { migrationTs } = generateMigration({ number: 1, name: "m", pre: snapshotOf(pre), schema: target });
    expect(migrationTs).toContain("t: (row): TRow => {");
    expect(migrationTs).toContain("// TODO(t.a): type changed; existing rows would need converting");
    expect(migrationTs).toContain("// TODO(t.b): column dropped; existing rows would lose data");
    expect(migrationTs).not.toContain("=> rest");
  });

  test("a probed unique-index-duplicates refusal becomes a volunteered dedupe hole", () => {
    // The shapes are identical old/new (a bare unique-index add), so the pure diff
    // sees nothing to refuse — the probed refusal is what forces the transform.
    const pre = defineSchema({ users: defineTable({ id: v.primaryKey(), email: v.string() }) });
    const target = defineSchema({
      users: defineTable({ id: v.primaryKey(), email: v.string() }).index("by_email", ["email"], { unique: true }),
    });
    const { migrationTs } = generateMigration({
      number: 1,
      name: "dedupe_email",
      pre: snapshotOf(pre),
      schema: target,
      probedRefusals: [
        {
          table: "users",
          index: "by_email",
          reason: "unique-index-duplicates",
          question: "unique index over (email); 2 duplicate group(s) exist",
          count: 2,
        },
      ],
    });
    expect(migrationTs).toContain("users: (row): UsersRow => {");
    expect(migrationTs).toContain(
      "// TODO(users.by_email): unique index over (email); 2 duplicate group(s) exist — return the surviving row, or null to drop this one",
    );
    // the hole's NEW row type is imported for annotation
    expect(migrationTs).toContain('import { defineMigration, type UsersRow } from "./meta/0001_dedupe_email.types.ts";');
  });

  test("a probed constraint refusal becomes an ordinary volunteered repair transform", () => {
    const pre = defineSchema({ users: defineTable({ id: v.primaryKey(), handle: v.string() }) });
    const target = defineSchema({ users: defineTable({ id: v.primaryKey(), handle: v.string().min(2) }) });
    const { migrationTs } = generateMigration({
      number: 1,
      name: "validate_handle",
      pre: snapshotOf(pre),
      schema: target,
      probedRefusals: [{
        table: "users",
        column: "handle",
        reason: "constraint-violations",
        question: "constraints tightened; 2 existing row(s) violate the target validator",
        count: 2,
      }],
    });
    expect(migrationTs).toContain("users: (row): UsersRow => {");
    expect(migrationTs).toContain(
      "// TODO(users.handle): constraints tightened; 2 existing row(s) violate the target validator",
    );
  });

  test("a column rename on the same table as a drop forces a hole, not a broken destructuring", () => {
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), old: v.string(), gone: v.string() }) });
    const target = defineSchema({ t: defineTable({ id: v.primaryKey(), renamed: v.string() }) });
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
    const pre = defineSchema({ t: defineTable({ id: v.primaryKey(), v: v.string() }) });
    const target = defineSchema({
      t: defineTable({ id: v.primaryKey(), v: v.float() }),
      shapes: defineTable({
        id: v.primaryKey(),
        e: v.enum("E", ["x", "y"]),
        u: v.union("U", { text: v.string(), nada: v.tag() }),
        arr: v.array(v.string().nullable()),
        obj: v.object({ a: v.bigint(), b: v.bytes() }),
        maybe: v.boolean().nullable(),
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
    const pre = defineSchema({ posts: defineTable({ id: v.primaryKey(), count: v.string() }) });
    const target = defineSchema({ posts: defineTable({ id: v.primaryKey(), count: v.int() }) });

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

// -- computePlan: the optimistic duplicate probe wired to a real database -----

describe("computePlan: optimistic unique-index duplicate probe", () => {
  const PROBE_PRE = defineSchema({ users: defineTable({ id: v.primaryKey(), email: v.string().nullable() }) });
  // The live app.ts adds a UNIQUE index over the (nullable) email column.
  const PROBE_APP_TS = `import { defineApp, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  users: defineTable({ id: v.primaryKey(), email: v.string().nullable() })
    .index("by_email", ["email"], { unique: true }),
});
export default defineApp({ schema });
`;

  async function planAfterSeeding(emails: (string | null)[]) {
    const dir = makeFixture({ "app.ts": PROBE_APP_TS });
    dirs.push(dir);
    const dbPath = join(dir, ".dbzz", "data.db");
    mkdirSync(join(dir, ".dbzz"), { recursive: true });
    await seed(PROBE_PRE, dbPath, async (d) => {
      for (const email of emails) await d.users.insert({ email });
    });
    return computePlan(loadConfig(dir));
  }

  test("duplicate rows synthesize the unique-index-duplicates refusal", async () => {
    const outcome = await planAfterSeeding(["a@x", "a@x", "b@x"]);
    expect(outcome.status).toBe("changes");
    if (outcome.status !== "changes") throw new Error("unreachable");
    expect(outcome.refusals).toEqual([
      {
        table: "users",
        index: "by_email",
        reason: "unique-index-duplicates",
        question: "unique index over (email); 1 duplicate group(s) exist",
        count: 1,
      },
    ]);
  });

  test("clean data leaves a clean plan — the optimistic change just applies", async () => {
    expect((await planAfterSeeding(["a@x", "b@x"])).status).toBe("clean");
  });

  test("NULL emails are never duplicates — the probe mirrors the constraint", async () => {
    expect((await planAfterSeeding([null, null, "c@x"])).status).toBe("clean");
  });
});

describe("computePlan: optimistic constraint probe", () => {
  const pre = defineSchema({
    items: defineTable({ id: v.primaryKey(), label: v.string().nullable() }),
  });
  const appTs = `import { defineApp, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  items: defineTable({ id: v.primaryKey(), label: v.string().min(2).nullable() }),
});
export default defineApp({ schema });
`;

  test("reports the exact violating-row count while nullable null is ignored", async () => {
    const dir = makeFixture({ "app.ts": appTs });
    dirs.push(dir);
    const dbPath = join(dir, ".dbzz", "data.db");
    mkdirSync(join(dir, ".dbzz"), { recursive: true });
    await seed(pre, dbPath, async (d) => {
      for (const label of [null, "", "x", "ok"]) await d.items.insert({ label });
    });
    const outcome = await computePlan(loadConfig(dir));
    expect(outcome.status).toBe("changes");
    if (outcome.status !== "changes") throw new Error("unreachable");
    expect(outcome.refusals).toEqual([{
      table: "items",
      column: "label",
      reason: "constraint-violations",
      question: "constraints tightened; 2 existing row(s) violate the target validator",
      count: 2,
    }]);
    expect(outcome.safe).toEqual([]);
  });

  test("post-answer generation probes through a variant rename and scaffolds the newly visible repair", async () => {
    const before = defineSchema({
      items: defineTable({
        id: v.primaryKey(),
        body: v.union("Body", { legacy: v.object({ label: v.string() }) }),
      }),
    });
    const targetAppTs = `import { defineApp, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  items: defineTable({
    id: v.primaryKey(),
    body: v.union("Body", { current: v.object({ label: v.string().min(2) }) }),
  }),
});
export default defineApp({ schema });
`;
    const dir = makeFixture({ "app.ts": targetAppTs });
    dirs.push(dir);
    const config = loadConfig(dir);
    mkdirSync(config.dbDir, { recursive: true });
    await seed(before, join(config.dbDir, "data.db"), async (d) => {
      await d.items.insert({ body: { tag: "legacy", value: { label: "x" } } });
    });

    const [migrationPath] = await writeMigration(config, {
      name: "rename_and_validate",
      renames: { variants: { Body: { legacy: "current" } } },
    });
    const migrationTs = readFileSync(migrationPath!, "utf8");
    expect(migrationTs).toContain('renames: { variants: { Body: { legacy: "current" } } },');
    expect(migrationTs).toContain(
      "// TODO(items.body): constraints tightened; 1 existing row(s) violate the target validator",
    );
    expect(migrationTs).toContain("items: (row): ItemsRow => {");
  });
});

// -- compile-time guarantees: one tsc run over generated + usage files --------

describe("generateMigration: compile-time gate (single tsc --noEmit)", () => {
  test("the hole fails, filling it compiles, old-typed / removed-variant returns fail", () => {
    // Bundle A: a nullable -> required change (an un-narrowed nullable is the trap).
    const preA = defineSchema({ users: defineTable({ id: v.primaryKey(), email: v.string().nullable() }) });
    const targetA = defineSchema({ users: defineTable({ id: v.primaryKey(), email: v.string() }) });
    const a = generateMigration({ number: 1, name: "a", pre: snapshotOf(preA), schema: targetA });

    // Bundle B: a variant removal (the removed literal is the trap).
    const preB = defineSchema({
      posts: defineTable({ id: v.primaryKey(), status: v.enum("Status", ["draft", "published", "archived"]) }),
    });
    const targetB = defineSchema({
      posts: defineTable({ id: v.primaryKey(), status: v.enum("Status", ["draft", "published"]) }),
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
    const configPath = join(dir, "tsconfig.json");
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const out = ts.formatDiagnostics(
      [...(configFile.error === undefined ? [] : [configFile.error]), ...parsed.errors, ...ts.getPreEmitDiagnostics(program)],
      {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => REPO,
        getNewLine: () => "\n",
      },
    );
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

// -- the on-disk chain must match applied history, not just its count ----------

describe("computePlan / writeMigration: applied-history prefix validation", () => {
  const B_PRE = defineSchema({ posts: defineTable({ id: v.primaryKey(), count: v.string() }) });
  const B_TARGET = defineSchema({ posts: defineTable({ id: v.primaryKey(), count: v.int() }) });
  const B_APP_TS = `import { defineApp, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  posts: defineTable({ id: v.primaryKey(), count: v.int() }),
});
export default defineApp({ schema });
`;

  /** Scaffold a filled migration, seed at PRE, apply it, and return the app dir + config. */
  async function appliedFixture(): Promise<{ dir: string; config: ReturnType<typeof loadConfig>; filled: string }> {
    const gen = generateMigration({ number: 1, name: "parse_count", pre: snapshotOf(B_PRE), schema: B_TARGET });
    const filled = gen.migrationTs.replace(
      "      // TODO(posts.count): type changed; existing rows would need converting\n",
      "      return { ...row, count: Number(row.count) || 0 };\n",
    );
    const dir = makeFixture({
      "app.ts": B_APP_TS,
      "migrations/0001_parse_count.ts": filled,
      "migrations/meta/0001_parse_count.types.ts": gen.typesTs,
      "migrations/meta/0001_parse_count.json": gen.metaJson,
    });
    dirs.push(dir);
    const config = loadConfig(dir);
    const dbPath = join(dir, ".dbzz", "data.db");
    mkdirSync(join(dir, ".dbzz"), { recursive: true });
    await seed(B_PRE, dbPath, async (d) => {
      await d.posts.insert({ count: "5" });
    });
    // Apply the chain so `_dbzz_migrations` records the identity of the ORIGINAL code.
    const engine = new Engine(B_TARGET, dbPath);
    await reconcile(engine, await loadMigrationChain(config));
    engine.close("clean");
    return { dir, config, filled };
  }

  test("a fully-applied, untouched chain is clean", async () => {
    const { config } = await appliedFixture();
    expect((await computePlan(config)).status).toBe("clean");
  });

  test("editing an applied migration (same count) diverges instead of reading as applied", async () => {
    const { dir, config, filled } = await appliedFixture();
    // Same file count, same row count — only the transform body changed, so the
    // recorded identity no longer matches the on-disk chain entry.
    writeFileSync(
      join(dir, "migrations", "0001_parse_count.ts"),
      filled.replace("Number(row.count) || 0", "Number(row.count) || -1"),
    );

    const outcome = await computePlan(config);
    expect(outcome.status).toBe("diverged");
    if (outcome.status !== "diverged") throw new Error("unreachable");
    expect(outcome.message).toContain("no longer matches the on-disk chain");
    expect(outcome.message).toContain("dbzz reset");

    await expect(writeMigration(config, { name: "next" })).rejects.toThrow("no longer matches the on-disk chain");
    // The refusal must scaffold nothing on top of the divergent chain.
    expect(readdirSync(join(dir, "migrations")).filter((f) => f.startsWith("0002"))).toEqual([]);
  });

  test("history longer than the on-disk chain diverges instead of reading as applied", async () => {
    const { dir, config } = await appliedFixture();
    // Delete the only migration on disk: history now has a row with no chain step.
    rmSync(join(dir, "migrations", "0001_parse_count.ts"));
    rmSync(join(dir, "migrations", "meta", "0001_parse_count.json"));
    rmSync(join(dir, "migrations", "meta", "0001_parse_count.types.ts"));

    expect((await computePlan(config)).status).toBe("diverged");
    await expect(writeMigration(config, { name: "next" })).rejects.toThrow("no longer matches the on-disk chain");
  });
});

// -- computePlan: pending staleness / writeMigration: consent -----------------

describe("computePlan: pending staleness + writeMigration: consent", () => {
  const P_PRE = defineSchema({ posts: defineTable({ id: v.primaryKey(), count: v.string() }) });
  const P_TARGET = defineSchema({ posts: defineTable({ id: v.primaryKey(), count: v.int() }) });
  const APP_AT_TARGET = `import { defineApp, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  posts: defineTable({ id: v.primaryKey(), count: v.int() }),
});
export default defineApp({ schema });
`;
  const APP_MOVED_ON = `import { defineApp, defineSchema, defineTable, v } from "@dbzz/server";
const schema = defineSchema({
  posts: defineTable({ id: v.primaryKey(), count: v.int(), flag: v.string() }),
});
export default defineApp({ schema });
`;

  /** A scaffolded-but-unapplied chain over a database still at PRE. */
  async function pendingFixture(appTs: string): Promise<{ dir: string; config: ReturnType<typeof loadConfig> }> {
    const gen = generateMigration({ number: 1, name: "parse_count", pre: snapshotOf(P_PRE), schema: P_TARGET });
    const dir = makeFixture({
      "app.ts": appTs,
      "migrations/0001_parse_count.ts": gen.migrationTs,
      "migrations/meta/0001_parse_count.types.ts": gen.typesTs,
      "migrations/meta/0001_parse_count.json": gen.metaJson,
    });
    dirs.push(dir);
    const config = loadConfig(dir);
    mkdirSync(join(dir, ".dbzz"), { recursive: true });
    await seed(P_PRE, join(dir, ".dbzz", "data.db"), async () => {});
    return { dir, config };
  }

  test("a pending chain whose end-state is the live schema is not stale", async () => {
    const { config } = await pendingFixture(APP_AT_TARGET);
    const outcome = await computePlan(config);
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.stale).toBe(false);
    expect(outcome.pendingFiles).toHaveLength(3);
    expect(outcome.pendingLabels).toEqual(["0001_parse_count"]);
    // The apply-decline memory key: covers file bytes, so editing the
    // migration (filling a TODO) releases a remembered decline.
    expect(outcome.pendingIdentity).toMatch(/^[0-9a-f]{64}$/);
    const before = outcome.pendingIdentity;
    const modulePath = outcome.pendingFiles[0]!;
    writeFileSync(modulePath, `${readFileSync(modulePath, "utf8")}\n// touched\n`);
    const edited = await computePlan(config);
    if (edited.status !== "pending") throw new Error("unreachable");
    expect(edited.pendingIdentity).not.toBe(before);
  });

  test("a schema that moved after the scaffold flags the pending chain stale and names its files", async () => {
    const { config } = await pendingFixture(APP_MOVED_ON);
    const outcome = await computePlan(config);
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.stale).toBe(true);
    expect(outcome.pendingFiles.map((f) => f.split("/").pop())).toEqual([
      "0001_parse_count.ts",
      "0001_parse_count.types.ts",
      "0001_parse_count.json",
    ]);
  });

  /** A chainless app whose live schema needs a migration: the consent-fingerprint stage. */
  async function changesFixture(): Promise<{ dir: string; config: ReturnType<typeof loadConfig> }> {
    const dir = makeFixture({ "app.ts": APP_AT_TARGET });
    dirs.push(dir);
    const config = loadConfig(dir);
    mkdirSync(join(dir, ".dbzz"), { recursive: true });
    await seed(P_PRE, join(dir, ".dbzz", "data.db"), async () => {});
    return { dir, config };
  }

  const fingerprintOf = async (config: ReturnType<typeof loadConfig>): Promise<string> => {
    const outcome = await computePlan(config);
    if (outcome.status !== "changes") throw new Error(`expected changes, got ${outcome.status}`);
    return outcome.fingerprint;
  };

  test("consent matching the fresh plan writes the scaffold", async () => {
    const { dir, config } = await changesFixture();
    const written = await writeMigration(config, { name: "parse_count", consent: await fingerprintOf(config) });
    expect(written).toHaveLength(3);
    expect(existsSync(join(dir, "migrations", "0001_parse_count.ts"))).toBe(true);
  });

  test("consent that no longer matches the fresh plan refuses inside the write, and writes nothing", async () => {
    const { dir, config } = await changesFixture();
    // A fingerprint over any other (pre, target) pair — what a consent becomes
    // the moment the schema moves after the ledger was shown. (The full
    // moved-schema replay lives in the process tests: in production every plan
    // and write is a fresh child, so the schema module is never stale-cached.)
    const stale = planFingerprint(snapshotOf(P_PRE), snapshotOf(P_PRE));

    await expect(writeMigration(config, { name: "parse_count", consent: stale })).rejects.toThrow(StaleConsentError);
    expect(existsSync(join(dir, "migrations"))).toBe(false);

    const written = await writeMigration(config, { name: "parse_count", consent: await fingerprintOf(config) });
    expect(written).toHaveLength(3);
  });

  test("no consent means the invocation is the consent — dbzz generate's path still writes", async () => {
    const { dir, config } = await changesFixture();
    await writeMigration(config, { name: "parse_count" });
    expect(existsSync(join(dir, "migrations", "0001_parse_count.ts"))).toBe(true);
  });
});
