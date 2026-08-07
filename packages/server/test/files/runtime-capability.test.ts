import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/database/engine.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { v } from "../../src/validation/v.ts";

const NOW = 1_800_000_000_000;

describe("built-in Files capability", () => {
  let directory: string;
  let engine: Engine;
  let runtime: Runtime;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-files-runtime-"));
    engine = new Engine(defineSchema({
      documents: defineTable({ id: v.primaryKey(), title: v.string() }),
    }), join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: false,
      now: () => NOW,
      files: { publicUrl: "https://files.example.test/root/" },
    });
  });

  afterEach(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  test("creates Upload Sessions transactionally while hiding framework tables", async () => {
    const result = await runtime.system.run("test.files.upload-session", (ctx) =>
      ctx.tx(async (tx) => ({
        session: await tx.files.createUploadSession({ maxBytes: 42 }),
        applicationTables: Object.keys(tx.db),
      })),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual({
      session: {
        url: expect.stringMatching(
          /^https:\/\/files\.example\.test\/_files\/uploads\/\d+\.[A-Za-z0-9_-]+$/,
        ),
        expiresAt: NOW + 60 * 60 * 1_000,
        maxBytes: 42,
      },
      applicationTables: ["documents", "_ackerdb_jobs", "_ackerdb_job_runs"],
    });
  });
});
