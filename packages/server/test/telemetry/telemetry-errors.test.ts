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

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function createStore(): TelemetryStore {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-errors-"));
  directories.add(directory);
  return new TelemetryStore({
    path: join(directory, "telemetry.db"),
    now: () => NOW,
  });
}

const ROOT = "/srv/app";

function stackedError(
  name: string,
  message: string,
  frames: readonly string[],
  cause?: Error,
): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = name;
  error.stack = [`${name}: ${message}`, ...frames].join("\n");
  return error;
}

describe("fingerprintError", () => {
  test("groups by name and in-app frame pairs, ignoring line numbers", () => {
    const first = fingerprintError(stackedError("TypeError", "boom at row 12", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
      `    at handle (${ROOT}/src/router.ts:44:12)`,
    ]), ROOT);
    const second = fingerprintError(stackedError("TypeError", "boom at row 99", [
      `    at createItem (${ROOT}/src/items.ts:222:9)`,
      `    at handle (${ROOT}/src/router.ts:1:1)`,
    ]), ROOT);
    const differentFrame = fingerprintError(stackedError("TypeError", "boom at row 12", [
      `    at deleteItem (${ROOT}/src/items.ts:10:5)`,
      `    at handle (${ROOT}/src/router.ts:44:12)`,
    ]), ROOT);

    expect(first.hash).toBe(second.hash);
    expect(first.hash).not.toBe(differentFrame.hash);
    expect(first.algoVersion).toBe(ERROR_FINGERPRINT_ALGO_VERSION);
    expect(first.stack).toContain("at createItem (src/items.ts:10:5)");
    expect(first.stack).not.toContain(ROOT);
  });

  test("excludes dependency, runtime, and framework frames from the group key", () => {
    const withNoise = fingerprintError(stackedError("TypeError", "boom", [
      `    at validate (${ROOT}/node_modules/zod/lib/index.js:5:1)`,
      "    at run (bun:main:1:1)",
      "    at process (node:events:10:2)",
      `    at invoke (${ROOT}/node_modules/@ackerdb/server/dist/index.js:9:9)`,
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]), ROOT);
    const clean = fingerprintError(stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:77:1)`,
    ]), ROOT);

    expect(withNoise.hash).toBe(clean.hash);
  });

  test("collapses consecutive recursion frames", () => {
    const recursive = fingerprintError(stackedError("RangeError", "too deep", [
      `    at recurse (${ROOT}/src/deep.ts:3:1)`,
      `    at recurse (${ROOT}/src/deep.ts:3:1)`,
      `    at recurse (${ROOT}/src/deep.ts:3:1)`,
      `    at start (${ROOT}/src/deep.ts:9:1)`,
    ]), ROOT);
    const flat = fingerprintError(stackedError("RangeError", "too deep", [
      `    at recurse (${ROOT}/src/deep.ts:3:1)`,
      `    at start (${ROOT}/src/deep.ts:9:1)`,
    ]), ROOT);

    expect(recursive.hash).toBe(flat.hash);
  });

  test("walks Error.cause into the group key and the sample stack", () => {
    const cause = stackedError("ConnectionError", "socket closed", [
      `    at dial (${ROOT}/src/net.ts:5:1)`,
    ]);
    const withCause = fingerprintError(
      stackedError("StorageError", "write failed", [
        `    at persist (${ROOT}/src/storage.ts:12:1)`,
      ], cause),
      ROOT,
    );
    const withoutCause = fingerprintError(
      stackedError("StorageError", "write failed", [
        `    at persist (${ROOT}/src/storage.ts:12:1)`,
      ]),
      ROOT,
    );

    expect(withCause.hash).not.toBe(withoutCause.hash);
    expect(withCause.stack).toContain("Caused by: ConnectionError: socket closed");
    expect(withCause.stack).toContain("at dial (src/net.ts:5:1)");
  });

  test("falls back to name plus parameterized message without in-app frames", () => {
    const first = fingerprintError(stackedError("QueryError", "row 4211 missing in \"items\"", [
      "    at run (bun:sqlite:1:1)",
    ]), ROOT);
    const second = fingerprintError(stackedError("QueryError", "row 87 missing in \"users\"", [
      "    at run (bun:sqlite:9:9)",
    ]), ROOT);

    expect(first.hash).toBe(second.hash);
    expect(first.message).toBe("row <num> missing in <str>");
  });

  test("parameterizes uuids, urls, emails, dates, hexes, strings, and numbers", () => {
    expect(parameterizeErrorMessage(
      "id 0193a0e2-1111-7000-8000-000000000001 at https://api.example.com/v1 " +
        "for pedro@pedrobzz.dev on 2026-08-06T12:00:00Z token deadbeefcafe " +
        "'left' costs 12.5",
    )).toBe("id <uuid> at <url> for <email> on <date> token <hex> <str> costs <num>");
  });

  test("honors the fingerprint escape hatch with default salting", () => {
    const base = stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);
    const replaced = stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);
    (replaced as { fingerprint?: string[] }).fingerprint = ["billing", "charge-failed"];
    const salted = stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);
    (salted as { fingerprint?: string[] }).fingerprint = ["tenant-42", "{{ default }}"];

    const baseHash = fingerprintError(base, ROOT).hash;
    const replacedHash = fingerprintError(replaced, ROOT).hash;
    const saltedHash = fingerprintError(salted, ROOT).hash;
    expect(replacedHash).not.toBe(baseHash);
    expect(saltedHash).not.toBe(baseHash);
    expect(saltedHash).not.toBe(replacedHash);
    expect(fingerprintError(replaced, ROOT).hash).toBe(replacedHash);
  });

  test("fingerprints non-Error throws through the message fallback", () => {
    const fingerprinted = fingerprintError("catastrophe 99");
    expect(fingerprinted.name).toBe("UnknownError");
    expect(fingerprinted.message).toBe("catastrophe <num>");
    expect(fingerprinted.hash).toBe(fingerprintError("catastrophe 12").hash);
  });
});

describe("TelemetryErrorStore", () => {
  test("upserts groups with counts, first/last seen, and preserved latest sample", () => {
    const store = createStore();
    const errors = new TelemetryErrorStore({ store });
    const boom = () => stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);

    expect(errors.ingest({
      error: boom(),
      timestampMs: NOW - 2_000,
      functionAddress: "items.create",
      traceId: "trace-1",
    })).toBe(true);
    expect(errors.ingest({
      error: boom(),
      timestampMs: NOW - 1_000,
      functionAddress: "items.create",
      traceId: "trace-2",
    })).toBe(true);

    const groups = store.database.query(`
      SELECT hash, algo_version AS algoVersion, name, message, times_seen AS timesSeen,
             first_seen AS firstSeen, last_seen AS lastSeen, status, regressed,
             sample_trace_id AS sampleTraceId
      FROM _ackerdb_telemetry_error_groups
    `).all() as Record<string, unknown>[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      algoVersion: BigInt(ERROR_FINGERPRINT_ALGO_VERSION),
      name: "TypeError",
      message: "boom",
      timesSeen: 2n,
      firstSeen: NOW - 2_000,
      lastSeen: NOW - 1_000,
      status: "unresolved",
      regressed: 0n,
      sampleTraceId: "trace-2",
    });
    const occurrences = store.database.query(`
      SELECT group_hash AS groupHash, trace_id AS traceId, function_address AS functionAddress
      FROM _ackerdb_telemetry_error_occurrences
      ORDER BY id
    `).all();
    expect(occurrences).toEqual([
      { groupHash: groups[0]!.hash, traceId: "trace-1", functionAddress: "items.create" },
      { groupHash: groups[0]!.hash, traceId: "trace-2", functionAddress: "items.create" },
    ]);
    expect(errors.snapshot()).toEqual({ ingestedErrors: 2, droppedErrors: 0 });
    store.close();
  });

  test("a new occurrence reopens a resolved group with the regressed mark", () => {
    const store = createStore();
    const errors = new TelemetryErrorStore({ store });
    const boom = () => stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);
    expect(errors.ingest({ error: boom(), timestampMs: NOW - 3_000 })).toBe(true);
    const hash = (store.database.query(
      "SELECT hash FROM _ackerdb_telemetry_error_groups",
    ).get() as { readonly hash: string }).hash;

    expect(errors.resolve(hash, true, 1n)).toBe("applied");
    expect(store.database.query(
      "SELECT status, regressed FROM _ackerdb_telemetry_error_groups",
    ).get()).toEqual({ status: "resolved", regressed: 0n });

    expect(errors.ingest({ error: boom(), timestampMs: NOW - 1_000 })).toBe(true);
    expect(store.database.query(
      "SELECT status, regressed, times_seen AS timesSeen FROM _ackerdb_telemetry_error_groups",
    ).get()).toEqual({ status: "unresolved", regressed: 1n, timesSeen: 2n });

    // A resolve carrying the revision the operator OBSERVED is stale once a
    // new occurrence arrived: it conflicts as data, not erases the regression.
    expect(errors.resolve(hash, true, 1n)).toBe("conflict");
    expect(store.database.query(
      "SELECT status, regressed FROM _ackerdb_telemetry_error_groups",
    ).get()).toEqual({ status: "unresolved", regressed: 1n });

    // Resolving against the current revision clears the mark for the next cycle.
    expect(errors.resolve(hash, true, 2n)).toBe("applied");
    expect(store.database.query(
      "SELECT status, regressed FROM _ackerdb_telemetry_error_groups",
    ).get()).toEqual({ status: "resolved", regressed: 0n });
    expect(errors.resolve("missing-hash", true, 1n)).toBe("not_found");
    store.close();
  });

  test("same-millisecond occurrences never share a resolve token", () => {
    const store = createStore();
    const errors = new TelemetryErrorStore({ store });
    const boom = () => stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);
    // Two occurrences in the SAME millisecond: a timestamp token could not
    // tell them apart; the monotonic revision can.
    expect(errors.ingest({ error: boom(), timestampMs: NOW })).toBe(true);
    const observed = (store.database.query(
      "SELECT hash, revision FROM _ackerdb_telemetry_error_groups",
    ).get() as { readonly hash: string; readonly revision: bigint });
    expect(observed.revision).toBe(1n);
    expect(errors.ingest({ error: boom(), timestampMs: NOW })).toBe(true);

    // The operator observed revision 1; the second occurrence moved it on.
    expect(errors.resolve(observed.hash, true, observed.revision)).toBe("conflict");
    expect(store.database.query(
      "SELECT status, revision FROM _ackerdb_telemetry_error_groups",
    ).get()).toEqual({ status: "unresolved", revision: 2n });
    expect(errors.resolve(observed.hash, true, 2n)).toBe("applied");
    store.close();
  });

  test("occurrences expire on the error clock while groups never do", () => {
    const store = createStore();
    const errors = new TelemetryErrorStore({ store });
    const boom = () => stackedError("TypeError", "boom", [
      `    at createItem (${ROOT}/src/items.ts:10:5)`,
    ]);
    expect(errors.ingest({ error: boom(), timestampMs: NOW - 40 * DAY_MS })).toBe(true);
    expect(errors.ingest({ error: boom(), timestampMs: NOW - DAY_MS })).toBe(true);
    store.maintain();

    const occurrences = store.database.query(
      "SELECT COUNT(*) AS rows FROM _ackerdb_telemetry_error_occurrences",
    ).get() as { readonly rows: bigint };
    expect(occurrences.rows).toBe(1n);
    const groups = store.database.query(`
      SELECT times_seen AS timesSeen, sample_stack AS sampleStack
      FROM _ackerdb_telemetry_error_groups
    `).get() as { readonly timesSeen: bigint; readonly sampleStack: string };
    expect(groups.timesSeen).toBe(2n);
    expect(groups.sampleStack).toContain("at createItem (");
    expect(store.snapshot().expiredRecords.error).toBe(1);
    store.close();
  });

  test("a poisoned ingest counts as dropped without escaping", () => {
    const store = createStore();
    const errors = new TelemetryErrorStore({ store });
    store.close();
    expect(errors.ingest({ error: new Error("after close"), timestampMs: NOW })).toBe(false);
    expect(errors.snapshot()).toEqual({ ingestedErrors: 0, droppedErrors: 1 });
  });
});
