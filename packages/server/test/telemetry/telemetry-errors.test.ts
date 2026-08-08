import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ERROR_FINGERPRINT_ALGO_VERSION,
  TelemetryErrorStore,
  TelemetryStore,
  fingerprintError,
  parameterizeErrorMessage,
} from "@ackerdb/server";

const directories = new Set<string>();
const stores = new Set<TelemetryStore>();
const NOW = Date.now();

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // A suite that already closed its store owns that outcome.
    }
  }
  stores.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function store(): TelemetryStore {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-errors-"));
  directories.add(directory);
  const created = new TelemetryStore({ path: join(directory, "data.db.telemetry") });
  stores.add(created);
  return created;
}

function group(shared: TelemetryStore, hash: string) {
  return shared.database.query(`
    SELECT times_seen AS timesSeen, status, regressed, revision, message
    FROM _ackerdb_telemetry_error_groups WHERE hash = ?
  `).get(hash) as {
    readonly timesSeen: bigint;
    readonly status: string;
    readonly regressed: bigint;
    readonly revision: bigint;
    readonly message: string;
  };
}

describe("error fingerprinting", () => {
  test("collapses volatile values so one bug is one group", () => {
    expect(parameterizeErrorMessage("user 4211 not found at 2026-08-08T10:00:00Z"))
      .toBe("user <num> not found at <date>");
    expect(parameterizeErrorMessage("user 87 not found at 2026-01-01T00:00:00Z"))
      .toBe("user <num> not found at <date>");
    expect(parameterizeErrorMessage("token 3f6a91bc2d4e5f70 for a@b.com"))
      .toBe("token <hex> for <email>");
  });

  test("hashes the same failure site to the same group and a different site apart", () => {
    const first = () => { throw new Error("user 1 not found"); };
    const second = () => { throw new Error("user 2 not found"); };
    const capture = (work: () => void): ReturnType<typeof fingerprintError> => {
      try {
        work();
      } catch (error) {
        return fingerprintError(error);
      }
      throw new Error("expected a throw");
    };

    const a = capture(first);
    const b = capture(first);
    const c = capture(second);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.algoVersion).toBe(ERROR_FINGERPRINT_ALGO_VERSION);
    expect(a.message).toBe("user <num> not found");
  });

  test("an author's fingerprint replaces the default and can salt it instead", () => {
    const declared = Object.assign(new Error("boom"), { fingerprint: ["billing", "charge"] });
    const other = Object.assign(new Error("entirely different"), {
      fingerprint: ["billing", "charge"],
    });
    expect(fingerprintError(declared).hash).toBe(fingerprintError(other).hash);

    const salted = Object.assign(new Error("boom"), { fingerprint: ["{{ default }}", "eu"] });
    expect(fingerprintError(salted).hash).not.toBe(fingerprintError(declared).hash);
  });
});

describe("TelemetryErrorStore", () => {
  test("counts occurrences into one never-expiring group", () => {
    const shared = store();
    const errors = new TelemetryErrorStore({ store: shared });
    const failure = Object.assign(new Error("boom"), { fingerprint: ["one"] });

    expect(errors.ingest({ error: failure, timestampMs: NOW })).toBe(true);
    expect(errors.ingest({ error: failure, timestampMs: NOW + 1, functionAddress: "ops.pay" }))
      .toBe(true);

    const hash = fingerprintError(failure).hash;
    expect(group(shared, hash)).toMatchObject({ timesSeen: 2n, status: "unresolved" });
    expect(shared.database.query(
      "SELECT COUNT(*) AS n FROM _ackerdb_telemetry_error_occurrences",
    ).get()).toEqual({ n: 2n });
    expect(errors.snapshot()).toEqual({ ingestedErrors: 2, droppedErrors: 0 });
  });

  test("a new occurrence reopens a resolved group and marks it regressed", () => {
    const shared = store();
    const errors = new TelemetryErrorStore({ store: shared });
    const failure = Object.assign(new Error("boom"), { fingerprint: ["reopen"] });
    const hash = fingerprintError(failure).hash;

    errors.ingest({ error: failure, timestampMs: NOW });
    expect(errors.resolve(hash, true, group(shared, hash).revision)).toBe("applied");
    expect(group(shared, hash)).toMatchObject({ status: "resolved", regressed: 0n });

    errors.ingest({ error: failure, timestampMs: NOW + 1 });
    expect(group(shared, hash)).toMatchObject({ status: "unresolved", regressed: 1n });
  });

  test("a stale resolve is a conflict, never a silently erased regression", () => {
    const shared = store();
    const errors = new TelemetryErrorStore({ store: shared });
    const failure = Object.assign(new Error("boom"), { fingerprint: ["cas"] });
    const hash = fingerprintError(failure).hash;

    errors.ingest({ error: failure, timestampMs: NOW });
    const observed = group(shared, hash).revision;
    // An occurrence lands between the operator's read and their resolve.
    errors.ingest({ error: failure, timestampMs: NOW + 1 });

    expect(errors.resolve(hash, true, observed)).toBe("conflict");
    expect(group(shared, hash).status).toBe("unresolved");
    expect(errors.resolve("0".repeat(64), true, 1n)).toBe("not_found");
    expect(errors.resolve(hash, true, group(shared, hash).revision)).toBe("applied");
  });

  test("a storage failure is an accounted drop, never the failing operation's problem", () => {
    const shared = store();
    const errors = new TelemetryErrorStore({ store: shared });
    shared.database.close(false);

    expect(errors.ingest({ error: new Error("boom"), timestampMs: NOW })).toBe(false);
    expect(errors.snapshot()).toEqual({ ingestedErrors: 0, droppedErrors: 1 });
    expect(shared.snapshot()).toMatchObject({ state: "failed" });
  });
});
