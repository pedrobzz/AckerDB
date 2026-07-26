import { describe, expect, test } from "bun:test";
import {
  loadVectorRuntime,
  VectorRuntimeUnavailableError,
} from "../../../src/database/query/vector-runtime.ts";

describe("native vector runtime", () => {
  test("loads native code only for schemas that persist vectors", () => {
    const functionOnly = Bun.spawnSync([
      process.execPath,
      "-e",
      `
        import { createRequire } from "node:module";
        import { v } from "@ackerdb/server";
        v.vector(3).check([1, 2, 3], "argument");
        const require = createRequire(import.meta.url);
        if (Object.keys(require.cache).some((path) => path.includes("numkong"))) process.exit(17);
      `,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(functionOnly.exitCode).toBe(0);

    const eventOnly = Bun.spawnSync([
      process.execPath,
      "-e",
      `
        import { createRequire } from "node:module";
        import { Engine, defineEventTable, defineSchema, v } from "@ackerdb/server";
        const schema = defineSchema({
          vectors: defineEventTable(
            { id: v.primaryKey(), embedding: v.vector(2) },
            { args: {}, access: "public", matches: () => true },
          ),
        });
        const engine = new Engine(schema, ":memory:");
        const require = createRequire(import.meta.url);
        const loaded = Object.keys(require.cache).some((path) => path.includes("numkong"));
        engine.close("clean");
        if (loaded) process.exit(19);
      `,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(eventOnly.exitCode).toBe(0);

    const storedSchema = Bun.spawnSync([
      process.execPath,
      "-e",
      `
        import { createRequire } from "node:module";
        import { Engine, defineSchema, defineTable, v } from "@ackerdb/server";
        const schema = defineSchema({
          documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2) }),
        });
        const engine = new Engine(schema, ":memory:");
        const require = createRequire(import.meta.url);
        const loaded = Object.keys(require.cache).some((path) => path.includes("numkong"));
        engine.close("clean");
        if (!loaded) process.exit(18);
      `,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(storedSchema.exitCode).toBe(0);

    const pluginSchema = Bun.spawnSync([
      process.execPath,
      "-e",
      `
        import { createRequire } from "node:module";
        import { Engine, defineSchema, defineTable, v } from "@ackerdb/server";
        const root = defineSchema({ roots: defineTable({ id: v.primaryKey() }) });
        const plugin = defineSchema({
          documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2) }),
        });
        const engine = new Engine(root, ":memory:");
        const require = createRequire(import.meta.url);
        if (Object.keys(require.cache).some((path) => path.includes("numkong"))) process.exit(20);
        engine.createPluginScope("vectors", plugin);
        const loaded = Object.keys(require.cache).some((path) => path.includes("numkong"));
        engine.close("clean");
        if (!loaded) process.exit(21);
      `,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(pluginSchema.exitCode).toBe(0);
  });

  test("fails Engine startup when a stored-vector schema cannot load native kernels", () => {
    const failedStartup = Bun.spawnSync([
      process.execPath,
      "-e",
      `
        import { mock } from "bun:test";
        mock.module("numkong", () => { throw new Error("missing native binary"); });
        const {
          Engine,
          VectorRuntimeUnavailableError,
          defineSchema,
          defineTable,
          v,
        } = await import("@ackerdb/server");
        try {
          new Engine(defineSchema({
            documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2) }),
          }), ":memory:");
          process.exit(22);
        } catch (error) {
          if (!(error instanceof VectorRuntimeUnavailableError)) process.exit(23);
        }
      `,
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });

    expect(failedStartup.exitCode).toBe(0);
  });

  test("loads and self-tests the installed scalar kernels", () => {
    const runtime = loadVectorRuntime();
    const left = new Float32Array([1, 2]);
    const right = new Float32Array([3, 4]);

    expect(runtime.dot(left, right)).toBe(11);
    expect(runtime.euclidean(new Float32Array([0, 0]), new Float32Array([3, 4])))
      .toBe(5);
    expect(runtime.angular(new Float32Array([1, 0]), new Float32Array([0, 1])))
      .toBe(1);
  });

  test("fails closed with a typed outcome when native kernels cannot load or self-test", () => {
    expect(() => loadVectorRuntime(() => {
      throw new Error("missing native binary");
    })).toThrow(VectorRuntimeUnavailableError);

    try {
      loadVectorRuntime(() => ({
        angular: () => 0,
        dot: () => 0,
        euclidean: () => 0,
      }));
      throw new Error("expected invalid kernels to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VectorRuntimeUnavailableError);
      expect((error as VectorRuntimeUnavailableError).code).toBe("unavailable");
      expect((error as VectorRuntimeUnavailableError).retryable).toBe(false);
    }
  });
});
