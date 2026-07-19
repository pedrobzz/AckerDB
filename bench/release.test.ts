import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  finalBenchmarkFilename,
  iterationBenchmarkFilename,
  previousFinalBenchmark,
  retainReleaseBenchmark,
} from "./release.ts";

describe("version-bound benchmark retention", () => {
  test("uses a final version name and a distinct recovery iteration name", () => {
    expect(finalBenchmarkFilename("0.3.2")).toBe("v0.3.2.json");
    expect(iterationBenchmarkFilename("0.3.3", 2)).toBe("v0.3.3.iteration-2.json");
  });

  test("selects the latest prior final, never an iteration", () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-release-bench-"));
    try {
      writeFileSync(join(directory, "v0.3.1.json"), "{}");
      writeFileSync(join(directory, "v0.3.2.iteration-1.json"), "{}");
      writeFileSync(join(directory, "v0.3.0.json"), "{}");
      expect(previousFinalBenchmark(directory, "0.3.3")).toMatchObject({ version: "0.3.1" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("deletes recovery iterations only after the final version record is retained", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-release-bench-"));
    const context = { version: "0.3.3", iteration: 2, host: "hetzner" as const };
    try {
      await retainReleaseBenchmark(directory, context, false, { status: "recovery-needed" });
      const finalPath = await retainReleaseBenchmark(directory, context, true, { status: "passed" });
      expect(await Bun.file(finalPath).json()).toEqual({ status: "passed" });
      expect(await Bun.file(join(directory, "v0.3.3.iteration-2.json")).exists()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never overwrites retained evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-release-bench-"));
    const context = { version: "0.3.3", iteration: 1, host: "hetzner" as const };
    try {
      await retainReleaseBenchmark(directory, context, false, { status: "recovery-needed" });
      await expect(retainReleaseBenchmark(directory, context, false, { status: "recovery-needed" }))
        .rejects.toThrow("already exists");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
