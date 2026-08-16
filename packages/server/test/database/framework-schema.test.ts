/**
 * The framework schema: four domain contributions composed once, and the two
 * database capabilities derived from the result.
 */
import { describe, expect, test } from "bun:test";
import { IDENTITIES_TABLE, IDENTITY_ACCOUNTS_TABLE, identitySchema } from "../../src/auth/tables.ts";
import { CREDENTIALS_TABLE, credentialSchema } from "../../src/credentials/tables.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  applicationDatabase,
  FRAMEWORK_SCHEMA,
  FRAMEWORK_TABLES,
  internalDatabase,
  isFrameworkTable,
  withFrameworkTables,
} from "../../src/database/framework-schema.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
  filesSchema,
} from "../../src/files/tables.ts";
import { JOB_RUNS_TABLE, JOBS_TABLE, jobsSchema } from "../../src/jobs/table.ts";
import { composeSchemas, defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";

const FRAMEWORK = [
  JOBS_TABLE,
  JOB_RUNS_TABLE,
  FILES_TABLE,
  FILE_UPLOADS_TABLE,
  FILE_GRANTS_TABLE,
  FILE_CLEANUP_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_ACCOUNTS_TABLE,
  CREDENTIALS_TABLE,
];

describe("the framework schema", () => {
  test("holds every domain's tables exactly once, and derives the table set from itself", () => {
    expect(Object.keys(FRAMEWORK_SCHEMA.tables).sort()).toEqual([...FRAMEWORK].sort());
    expect([...FRAMEWORK_TABLES].sort()).toEqual(Object.keys(FRAMEWORK_SCHEMA.tables).sort());
    for (const table of FRAMEWORK) expect(isFrameworkTable(table)).toBe(true);
    expect(isFrameworkTable("documents")).toBe(false);
  });

  test("refuses a table two contributions both declare, naming both", () => {
    expect(() => composeSchemas([jobsSchema(), jobsSchema()], "framework schema"))
      .toThrow(`framework schema: table "${JOBS_TABLE}" is declared by contributions 0 and 1`);
    expect(() => composeSchemas([identitySchema(), credentialSchema(), identitySchema()], "test"))
      .toThrow(`test: table "${IDENTITIES_TABLE}" is declared by contributions 0 and 2`);
  });

  test("refuses two contributions that give one named type different definitions", () => {
    const one = defineSchema({
      a: defineTable({ id: v.primaryKey(), kind: v.enum("Kind", ["x"]) }),
    });
    const other = defineSchema({
      b: defineTable({ id: v.primaryKey(), kind: v.enum("Kind", ["x", "y"]) }),
    });
    expect(() => composeSchemas([one, other], "test"))
      .toThrow('test: named type "Kind" is declared twice with different definitions');
    // The same definition twice is one definition, not a conflict.
    expect(Object.keys(composeSchemas([one, defineSchema({
      c: defineTable({ id: v.primaryKey(), kind: v.enum("Kind", ["x"]) }),
    })], "test").tables)).toEqual(["a", "c"]);
  });

  test("the root schema is the application's tables beside the framework's", () => {
    const application = defineSchema({
      documents: defineTable({ id: v.primaryKey(), title: v.string() }),
    });
    expect(Object.keys(withFrameworkTables(application).tables))
      .toEqual(["documents", ...Object.keys(FRAMEWORK_SCHEMA.tables)]);
    // Composing an already-composed root schema is a conflict, not an identity:
    // a schema is composed once, at the one seam that owns it.
    expect(() => withFrameworkTables(withFrameworkTables(application))).toThrow(/is declared by/);
  });

  test("an Engine plans every framework table beside the application's", () => {
    const engine = new Engine(defineSchema({
      documents: defineTable({ id: v.primaryKey(), title: v.string() }),
    }), ":memory:");

    expect([...engine.plans.keys()]).toEqual(["documents", ...FRAMEWORK]);
    expect(engine.plan(FILES_TABLE).table.indexes.map((index) => index.columns)).toEqual([
      ["createdAt"],
      ["owner", "createdAt"],
      ["state", "createdAt"],
      ["state", "pendingExpiresAt"],
    ]);
    engine.close("clean");
  });

  test("splits one database handle into what an application sees and what the framework does", () => {
    const handle = Object.fromEntries(
      ["documents", ...FRAMEWORK].map((name) => [name, { name }]),
    );
    // Jobs is the one framework domain whose rows are application state.
    expect(Object.keys(applicationDatabase(handle) as object))
      .toEqual(["documents", JOBS_TABLE, JOB_RUNS_TABLE]);
    expect(Object.keys(internalDatabase(handle) as object)).toEqual(FRAMEWORK);
  });
});
