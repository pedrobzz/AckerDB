import { describe, expect, test } from "bun:test";
import {
  assertReleaseEvidence,
  benchmarkSourceHashAt,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "./release-evidence";
import { git } from "./lib";

const commit = git("rev-parse", "HEAD");
const sourceHash = benchmarkSourceHashAt("HEAD");
const repositoryRoot = git("rev-list", "--max-parents=0", "HEAD").split("\n")[0]!;

function evidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    release: { version: "1.2.3", previousVersion: "1.2.2", host: "hetzner" },
    timestamp: "2026-07-20T00:00:00.000Z",
    git: { commit, dirty: false, sourceHash },
    machine: {},
    systems: { ackerdb: {}, convex: {}, spacetimedb: {} },
    validation: { status: "failed", failures: [], integrityAnomalies: [] },
    performanceAcceptance: { status: "failed" },
    ...overrides,
  });
}

const expected = {
  path: "bench/results/v1.2.3.json",
  version: "1.2.3",
  previousVersion: "1.2.2",
  productRef: "HEAD",
};

describe("release evidence", () => {
  test("accepts matching provenance regardless of benchmark observations", () => {
    expect(() => assertReleaseEvidence(evidence(), expected)).not.toThrow();
  });

  test("requires the exact schema, release, predecessor, and host", () => {
    expect(() => assertReleaseEvidence(evidence({ schemaVersion: 9 }), expected)).toThrow("schema 10");
    expect(() =>
      assertReleaseEvidence(
        evidence({ release: { version: "1.2.3", previousVersion: null, host: "hetzner" } }),
        expected,
      ),
    ).toThrow("comparison against v1.2.2");
    expect(() =>
      assertReleaseEvidence(
        evidence({ release: { version: "1.2.3", previousVersion: "1.2.2", host: "local" } }),
        expected,
      ),
    ).toThrow("Hetzner evidence");
  });

  test("requires raw system and validation observations without interpreting them", () => {
    expect(() => assertReleaseEvidence(evidence({ systems: undefined }), expected)).toThrow(
      "missing raw benchmark observation sections",
    );
    expect(() => assertReleaseEvidence(evidence({ validation: undefined }), expected)).toThrow(
      "missing raw benchmark observation sections",
    );
  });

  test("rejects dirty, unavailable, or source-mismatched provenance", () => {
    expect(() =>
      assertReleaseEvidence(
        evidence({ git: { commit, dirty: true, sourceHash } }),
        expected,
      ),
    ).toThrow("dirty source provenance");
    expect(() =>
      assertReleaseEvidence(
        evidence({ git: { commit: "f".repeat(40), dirty: false, sourceHash } }),
        expected,
      ),
    ).toThrow("unavailable benchmark source commit");
    expect(() =>
      assertReleaseEvidence(
        evidence({ git: { commit, dirty: false, sourceHash: "0".repeat(64) } }),
        expected,
      ),
    ).toThrow("different product or benchmark sources");
    expect(() =>
      assertReleaseEvidence(evidence(), { ...expected, productRef: repositoryRoot }),
    ).toThrow("different product or benchmark sources");
  });
});
