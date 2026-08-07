import { describe, expect, test } from "bun:test";
import { Engine } from "../../src/database/engine.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
} from "../../src/files/tables.ts";
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../src/jobs/table.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";

describe("Files framework schema", () => {
  test("injects one cohesive hidden File lifecycle beside application storage", () => {
    const engine = new Engine(defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        title: v.string(),
      }),
    }), ":memory:");

    expect([...engine.rootScope.plans.keys()]).toEqual([
      "documents",
      JOBS_TABLE,
      JOB_RUNS_TABLE,
      FILES_TABLE,
      FILE_UPLOADS_TABLE,
      FILE_GRANTS_TABLE,
      FILE_CLEANUP_TABLE,
    ]);

    expect(engine.rootScope.plan(FILES_TABLE).table.indexes.map((index) => index.columns)).toEqual([
      ["createdAt"],
      ["owner", "createdAt"],
      ["state", "createdAt"],
      ["state", "pendingExpiresAt"],
    ]);

    engine.close("clean");
  });
});
