import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  finalBenchmarkFilename,
  previousFinalBenchmark,
  retainReleaseBenchmark,
} from "./release.ts";

describe("version-bound benchmark evidence", () => {
  test("uses one final version name", () => {
    expect(finalBenchmarkFilename("0.3.2")).toBe("v0.3.2.json");
  });

  test("selects the latest prior final and ignores non-final files", () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-release-bench-"));
    try {
      writeFileSync(join(directory, "v0.3.1.json"), "{}");
      writeFileSync(join(directory, "telemetry-v0.3.2.json"), "{}");
      writeFileSync(join(directory, "v0.3.0.json"), "{}");
      expect(previousFinalBenchmark(directory, "0.3.3")).toMatchObject({ version: "0.3.1" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains observations under the final name regardless of their content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-release-bench-"));
    const context = { version: "0.3.3", host: "hetzner" as const };
    try {
      const record = {
        schemaVersion: 10,
        validation: {
          failures: [{ target: "dbzz", case: "query", errors: ["wrong value"] }],
          integrityAnomalies: [],
        },
      };
      const path = await retainReleaseBenchmark(directory, context, record);
      expect(path).toBe(join(directory, "v0.3.3.json"));
      expect(await Bun.file(path).json()).toEqual(record);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never overwrites retained evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-release-bench-"));
    const context = { version: "0.3.3", host: "hetzner" as const };
    try {
      await retainReleaseBenchmark(directory, context, { observations: [] });
      await expect(retainReleaseBenchmark(directory, context, { observations: [] }))
        .rejects.toThrow("already exists");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
