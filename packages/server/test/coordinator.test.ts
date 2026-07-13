import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableEncode } from "@dbzz/core";
import {
  CommitCoordinator,
  withFetchObserver,
  type CommitTelemetryEvent,
  type FetchObservation,
} from "../src/coordinator.ts";
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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
    expect(result).toMatchObject({
      value: 1n,
      commitVersion: 1n,
      durability: "production",
      replay: "executed",
    });
    expect(engine.commitVersion()).toBe(1n);
    expect(published).toEqual([1n]);
  });

  test("releases the writer turn after handoff while ordered publication is pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dbzz-coordinator-handoff-"));
    dirs.push(dir);
    const engine = new Engine(schema, join(dir, "data.db"));
    engines.push(engine);
    reconcile(engine);
    const release = deferred();
    const started = deferred();
    const publication = new OrderedPublication<{ version: bigint }>({
      limits: { maxItems: 2, maxBytes: PRODUCTION_LIMITS.publication.maxBytes },
      initialVersion: 0n,
      process: async ({ version }) => {
        if (version === 1n) {
          started.resolve();
          await release.promise;
        }
      },
    });
    const coordinator = new CommitCoordinator({
      engine,
      limits: defineServiceLimits({
        ...PRODUCTION_LIMITS,
        publication: publication.limits,
      }),
      reservePublication: (bytes) => publication.reserve(bytes),
    });
    const request = (body: string) => coordinator.execute({
      operation: "transaction" as const,
      fairnessKey: "connection-1",
      requestBytes: 1,
      work: (db: any) => db.notes.insert({ body }),
      publication: (version: bigint) => ({ version }),
    });

    const first = request("first");
    await started.promise;
    let firstResolved = false;
    void first.then(() => {
      firstResolved = true;
    });
    const second = request("second");
    for (let turn = 0; turn < 20 && engine.commitVersion() < 2n; turn++) await Promise.resolve();
    expect(engine.commitVersion()).toBe(2n);
    expect(publication.snapshot()).toMatchObject({ items: 2, highWater: 2n });
    expect(firstResolved).toBe(false);

    release.resolve();
    await Promise.all([first, second]);
  });

  test("gives a cold connection a writer turn before one hot connection drains its queue", async () => {
    const { coordinator } = fixture();
    const release = deferred();
    const started = deferred();
    const order: string[] = [];
    const request = (fairnessKey: string, label: string, block = false) =>
      coordinator.execute({
        operation: "transaction",
        fairnessKey,
        requestBytes: 1,
        work: async () => {
          if (block) {
            started.resolve();
            await release.promise;
          }
          order.push(label);
          return label;
        },
        publication: (version) => ({ version }),
      });

    const blocker = request("blocker", "blocker", true);
    await started.promise;
    const hotFirst = request("hot", "hot-1");
    const hotSecond = request("hot", "hot-2");
    const cold = request("cold", "cold");
    release.resolve();

    await Promise.all([blocker, hotFirst, hotSecond, cold]);
    expect(order).toEqual(["blocker", "hot-1", "cold", "hot-2"]);
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

  test("replays the durability persisted with the original mutation", async () => {
    const { coordinator, engine } = fixture();
    engine.writer.exec("BEGIN IMMEDIATE");
    engine.insertStoredMutation({
      ...identity,
      result: "1",
      resultBytes: 1,
      commitVersion: 1n,
      durability: "balanced",
    });
    engine.writer.query(
      "UPDATE _dbz_state SET commit_version = 1, mutation_records = 1, mutation_result_bytes = 1 WHERE singleton = 1",
    ).run();
    engine.writer.exec("COMMIT");

    const replay = await coordinator.execute({
      operation: "mutation",
      fairnessKey: "session-1",
      requestBytes: 1,
      idempotency: identity,
      work: () => {
        throw new Error("must not execute");
      },
      publication: (version) => ({ version }),
    });
    expect(replay).toMatchObject({
      value: 1,
      commitVersion: 1n,
      durability: "balanced",
      replay: "replayed",
    });
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

  test("measures publication bytes independently from the wire frame limit", async () => {
    const { coordinator, engine } = fixture({
      maxFrameBytes: 32,
      webSocket: { ...PRODUCTION_LIMITS.webSocket, maxBytesPerConnection: 64 },
      sse: { ...PRODUCTION_LIMITS.sse, maxBytesPerStream: 32 },
    });
    const result = await coordinator.execute({
      operation: "transaction",
      fairnessKey: "connection-1",
      requestBytes: 1,
      work: (db: any) => db.notes.insert({ body: "a descriptor larger than one tiny frame" }),
      publication: (version) => ({ version }),
    });
    expect(result.commitVersion).toBe(1n);
    expect(engine.writer.query('SELECT COUNT(*) AS n FROM "notes"').get()).toEqual({ n: 1n });
  });

  test("rolls back when the final response shape cannot be published", async () => {
    const { coordinator, engine, publication } = fixture();
    await expect(coordinator.execute({
      operation: "transaction",
      fairnessKey: "connection-1",
      requestBytes: 1,
      work: (db: any) => db.notes.insert({ body: "must disappear" }),
      publication: (version) => ({ version }),
      validate: () => {
        throw new DbzzError("overloaded", "response is too large", { resource: "operation" });
      },
    })).rejects.toMatchObject({ code: "overloaded", resource: "operation" });
    expect(engine.commitVersion()).toBe(0n);
    expect(engine.writer.query('SELECT COUNT(*) AS n FROM "notes"').get()).toEqual({ n: 0n });
    expect(publication.snapshot()).toMatchObject({ items: 0, highWater: 0n });
  });

  test("fetch and nested transactions are rejected at the owning boundary", async () => {
    const { coordinator } = fixture();
    const observations: FetchObservation[] = [];
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
    await expect(withFetchObserver(
      (observation) => {
        observations.push(observation);
      },
      () => coordinator.execute({
        operation: "transaction",
        fairnessKey: "connection-1",
        requestBytes: 1,
        work: () => fetch("data:text/plain,nope"),
        publication: (version) => ({ version }),
      }),
    )).rejects.toBeInstanceOf(DbzzError);
    expect(observations).toEqual([expect.objectContaining({ outcome: "validation" })]);
    expect(observations.every(Object.isFrozen)).toBe(true);

    const response = await withFetchObserver(
      () => {
        throw new Error("telemetry failed");
      },
      () => fetch("data:text/plain,allowed"),
    );
    expect(await response.text()).toBe("allowed");
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

  test("observes writer queue, storage, encoding, commit, replay, and post-commit publication", async () => {
    const { coordinator } = fixture();
    const events: CommitTelemetryEvent[] = [];
    const request = {
      operation: "mutation" as const,
      fairnessKey: "session-1",
      requestBytes: 10,
      idempotency: identity,
      telemetry: (event: CommitTelemetryEvent) => {
        events.push(event);
      },
      work: (db: any) => db.notes.insert({ body: "hello" }),
      publication: (version: bigint) => ({ version }),
    };

    await coordinator.execute(request);
    expect(new Set(events.map((event) => event.stage))).toEqual(new Set([
      "queue",
      "storage",
      "encoding",
      "commit",
      "publication",
    ]));
    const commit = events.find((event) => event.stage === "commit");
    expect(commit).toMatchObject({
      outcome: "ok",
      commitVersion: 1n,
    });
    expect(commit!.dependencyCount).toBeGreaterThan(0);
    expect(events.find((event) => event.stage === "publication" && event.postCommit)).toMatchObject({
      outcome: "ok",
      commitVersion: 1n,
      postCommit: true,
    });
    expect(events.find((event) => event.stage === "storage" && event.replayed === false)).toBeDefined();

    events.length = 0;
    await coordinator.execute(request);
    expect(events).toContainEqual(expect.objectContaining({
      stage: "storage",
      outcome: "ok",
      replayed: true,
      commitVersion: 1n,
    }));
    expect(events.some((event) => event.stage === "commit")).toBe(false);
  });

  test("observes rollback and telemetry observer failures never affect a transaction", async () => {
    const { coordinator, engine } = fixture();
    const events: CommitTelemetryEvent[] = [];
    await expect(coordinator.execute({
      operation: "transaction",
      fairnessKey: "connection-1",
      requestBytes: 1,
      telemetry: (event) => {
        events.push(event);
      },
      work: (db: any) => {
        void db.notes.insert({ body: "rolled back" });
        throw new Error("boom");
      },
      publication: (version) => ({ version }),
    })).rejects.toThrow("boom");
    expect(events).toContainEqual(expect.objectContaining({ stage: "rollback", outcome: "ok" }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "storage", outcome: "internal" }));
    expect(engine.commitVersion()).toBe(0n);

    await expect(coordinator.execute({
      operation: "transaction",
      fairnessKey: "connection-1",
      requestBytes: 1,
      telemetry: async () => {
        throw new Error("export failed");
      },
      work: (db: any) => db.notes.insert({ body: "committed" }),
      publication: (version) => ({ version }),
    })).resolves.toMatchObject({ commitVersion: 1n });
  });
});
