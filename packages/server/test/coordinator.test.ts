import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableEncode } from "@dbzz/core";
import { CommitCoordinator } from "../src/coordinator.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { DbzzError } from "../src/errors.ts";
import { PRODUCTION_LIMITS, defineServiceLimits } from "../src/limits.ts";
import { OrderedPublication } from "../src/publication.ts";
import { reconcile } from "../src/reconcile.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({
  notes: defineTable({ id: dbz.primaryKey(), body: dbz.string() }),
});

const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(overrides: Partial<typeof PRODUCTION_LIMITS> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dbzz-coordinator-"));
  dirs.push(dir);
  const engine = new Engine(schema, join(dir, "data.db"));
  engines.push(engine);
  reconcile(engine);
  const published: bigint[] = [];
  const publication = new OrderedPublication<{ version: bigint }>({
    limits: overrides.publication ?? PRODUCTION_LIMITS.publication,
    initialVersion: engine.commitVersion(),
    process: ({ value }) => {
      published.push(value.version);
    },
  });
  const limits = defineServiceLimits({ ...PRODUCTION_LIMITS, ...overrides });
  const coordinator = new CommitCoordinator({
    engine,
    limits,
    now: () => identity.issuedAt,
    reservePublication: (bytes) => publication.reserve(bytes),
  });
  return { coordinator, engine, publication, published };
}

const identity = {
  sessionId: "session-1",
  requestId: "01890a5d-ac96-774b-b4c0-123456789abc",
  issuedAt: 1_688_096_058_518,
  principalFingerprint: "principal",
  functionRef: "notes.add",
  argsFingerprint: stableEncode({ body: "hello" }),
};

describe("CommitCoordinator", () => {
  test("persists one monotonic version and hands publication off before resolving", async () => {
    const { coordinator, engine, published } = fixture();
    const result = await coordinator.execute({
      operation: "mutation",
      fairnessKey: "session-1",
      requestBytes: 10,
      idempotency: identity,
      work: (db: any) => db.notes.insert({ body: "hello" }),
      publication: (version) => ({ version }),
    });
    expect(result).toMatchObject({ value: 1n, commitVersion: 1n, replay: "executed" });
    expect(engine.commitVersion()).toBe(1n);
    expect(published).toEqual([1n]);
  });

  test("replays an identical scoped request and rejects changed semantics", async () => {
    const { coordinator, engine } = fixture();
    let executions = 0;
    const request = {
      operation: "mutation" as const,
      fairnessKey: "session-1",
      requestBytes: 10,
      idempotency: identity,
      work: async (db: any) => {
        executions++;
        return db.notes.insert({ body: "hello" });
      },
      publication: (version: bigint) => ({ version }),
    };
    await coordinator.execute(request);
    expect(await coordinator.execute(request)).toMatchObject({ replay: "replayed", value: 1n });
    expect(executions).toBe(1);
    expect(engine.commitVersion()).toBe(1n);
    await expect(
      coordinator.execute({
        ...request,
        idempotency: { ...identity, argsFingerprint: "different" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("handler failure rolls back data, version, and publication reservation", async () => {
    const { coordinator, engine, publication } = fixture();
    await expect(
      coordinator.execute({
        operation: "transaction",
        fairnessKey: "connection-1",
        requestBytes: 1,
        work: async (db: any) => {
          await db.notes.insert({ body: "nope" });
          throw new Error("boom");
        },
        publication: (version) => ({ version }),
      }),
    ).rejects.toThrow("boom");
    expect(engine.commitVersion()).toBe(0n);
    expect(engine.writer.query('SELECT COUNT(*) AS n FROM "notes"').get()).toEqual({ n: 0n });
    expect(publication.snapshot()).toMatchObject({ items: 0, highWater: 0n });
  });

  test("fetch and nested transactions are rejected at the owning boundary", async () => {
    const { coordinator } = fixture();
    const nested = () => coordinator.execute({
      operation: "transaction",
      fairnessKey: "connection-1",
      requestBytes: 1,
      work: () => null,
      publication: (version) => ({ version }),
    });
    await expect(
      coordinator.execute({
        operation: "transaction",
        fairnessKey: "connection-1",
        requestBytes: 1,
        work: nested,
        publication: (version) => ({ version }),
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      coordinator.execute({
        operation: "transaction",
        fairnessKey: "connection-1",
        requestBytes: 1,
        work: () => fetch("data:text/plain,nope"),
        publication: (version) => ({ version }),
      }),
    ).rejects.toBeInstanceOf(DbzzError);
  });

  test("oversized result fails before commit and does not consume replay capacity", async () => {
    const limits = {
      ...PRODUCTION_LIMITS.mutationReplay,
      maxResultBytes: 8,
    };
    const { coordinator, engine } = fixture({ mutationReplay: limits });
    await expect(
      coordinator.execute({
        operation: "mutation",
        fairnessKey: "session-1",
        requestBytes: 1,
        idempotency: identity,
        work: () => "this result is too long",
        publication: (version) => ({ version }),
      }),
    ).rejects.toMatchObject({ code: "overloaded", resource: "idempotency" });
    expect(engine.status()).toMatchObject({ commitVersion: 0n, mutationRecords: 0 });
  });

  test("an unknown expired request is never re-executed after ledger pruning", async () => {
    const now = identity.issuedAt + 100;
    const { coordinator, engine } = (() => {
      const dir = mkdtempSync(join(tmpdir(), "dbzz-coordinator-expired-"));
      dirs.push(dir);
      const engine = new Engine(schema, join(dir, "data.db"));
      engines.push(engine);
      reconcile(engine);
      const publication = new OrderedPublication<{ version: bigint }>({
        limits: PRODUCTION_LIMITS.publication,
        initialVersion: 0n,
        process: () => {},
      });
      const limits = defineServiceLimits({
        ...PRODUCTION_LIMITS,
        mutationReplay: { ...PRODUCTION_LIMITS.mutationReplay, maxAgeMs: 50 },
      });
      return {
        engine,
        coordinator: new CommitCoordinator({
          engine,
          limits,
          now: () => now,
          reservePublication: (bytes) => publication.reserve(bytes),
        }),
      };
    })();
    let executed = false;
    await expect(
      coordinator.execute({
        operation: "mutation",
        fairnessKey: "session-1",
        requestBytes: 1,
        idempotency: identity,
        work: () => {
          executed = true;
          return null;
        },
        publication: (version) => ({ version }),
      }),
    ).rejects.toMatchObject({ code: "conflict", resource: "idempotency" });
    expect(executed).toBe(false);
    expect(engine.commitVersion()).toBe(0n);
  });

  test("uses the UUID timestamp rather than a forgeable issuedAt for replay age", async () => {
    const now = identity.issuedAt + PRODUCTION_LIMITS.mutationReplay.maxAgeMs + 1;
    const dir = mkdtempSync(join(tmpdir(), "dbzz-coordinator-uuid-age-"));
    dirs.push(dir);
    const engine = new Engine(schema, join(dir, "data.db"));
    engines.push(engine);
    reconcile(engine);
    const publication = new OrderedPublication<{ version: bigint }>({
      limits: PRODUCTION_LIMITS.publication,
      initialVersion: 0n,
      process: () => {},
    });
    const coordinator = new CommitCoordinator({
      engine,
      limits: PRODUCTION_LIMITS,
      now: () => now,
      reservePublication: (bytes) => publication.reserve(bytes),
    });

    await expect(
      coordinator.execute({
        operation: "mutation",
        fairnessKey: "session-1",
        requestBytes: 1,
        idempotency: { ...identity, issuedAt: now },
        work: () => null,
        publication: (version) => ({ version }),
      }),
    ).rejects.toMatchObject({ code: "conflict", resource: "idempotency" });
    expect(engine.commitVersion()).toBe(0n);
  });
});
