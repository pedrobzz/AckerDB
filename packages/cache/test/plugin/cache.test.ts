import { describe, expect, test } from "bun:test";
import { decode, encode } from "@ackerdb/core";
import {
  assemblePlugins,
  definePlugin,
  definePluginContract,
  defineSchema,
  Engine,
  makeDbWriter,
  newWriteCollector,
  pluginMutation,
  PluginRuntime,
  reconcilePluginStorage,
  v,
  type DbStatementObservation,
  type PluginExportTree,
  type PluginInstance,
} from "@ackerdb/server";
import {
  CacheEntryTooLargeError,
  CacheStoreError,
  InvalidCacheExpirationError,
  cachePlugin,
  defineCacheStore,
  type CacheKey,
  type CacheSetOptions,
} from "../../src/index.ts";
import { encodeCacheKey } from "../../src/storage/key.ts";

type TestPlugin = PluginInstance;
type TestPluginOperation = Exclude<PluginExportTree[string], PluginExportTree>;
const NOOP_LOG = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});
const NOOP_ANALYTICS = Object.freeze({ track: () => {} });

interface TestEntryRow {
  readonly id: bigint;
  readonly key: string;
  readonly payload: string;
  readonly bytes: number;
  readonly deadline: number | null;
}

interface TestStateRow {
  readonly id: bigint;
  readonly totalBytes: number;
  readonly entryCount: number;
}

interface TestRange<Row> {
  unique(): Promise<Row | null>;
  collect(): Promise<Row[]>;
}

interface TestEntryQuery extends TestRange<TestEntryRow> {
  where(
    predicate: (entry: { readonly key: { eq(value: string): unknown } }) => unknown,
  ): TestEntryQuery;
}

interface TestDb {
  readonly entries: {
    query(): TestEntryQuery;
    patch(id: bigint, value: Partial<TestEntryRow>): PromiseLike<unknown>;
  };
  readonly state: {
    query(): TestRange<TestStateRow>;
    patch(id: bigint, value: Partial<TestStateRow>): PromiseLike<unknown>;
  };
}

function operation(
  plugin: TestPlugin,
  path: readonly string[],
): TestPluginOperation {
  let node: unknown = plugin.exports;
  for (const part of path) {
    if (typeof node !== "object" || node === null) throw new Error(`missing ${path.join(".")}`);
    node = (node as Record<string, unknown>)[part];
  }
  if (
    typeof node !== "object" ||
    node === null ||
    typeof (node as { handler?: unknown }).handler !== "function"
  ) {
    throw new Error(`missing operation ${path.join(".")}`);
  }
  return node as TestPluginOperation;
}

async function invoke(
  plugin: TestPlugin,
  path: readonly string[],
  ctx: unknown,
  args: unknown,
): Promise<unknown> {
  const implementation = operation(plugin, path);
  const checked = implementation.spec.args.check(args, "cache args");
  return implementation.handler(ctx, checked);
}

function createBuiltInRig(
  plugin: TestPlugin,
  observations: DbStatementObservation[] = [],
  sqlStatements?: string[],
) {
  const engine = new Engine(defineSchema({}), ":memory:");
  if (sqlStatements !== undefined) {
    const issueStatement = engine.statement.bind(engine);
    engine.statement = (connection, sql) => {
      sqlStatements.push(sql);
      return issueStatement(connection, sql);
    };
  }
  engine.createAll();
  const scope = engine.createPluginScope("cache", plugin.schema);
  engine.writer.exec("BEGIN IMMEDIATE");
  try {
    engine.persistTags(scope);
    for (const plan of scope.plans.values()) engine.createTablePhysical(plan);
    engine.writer.exec("COMMIT");
  } catch (error) {
    if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
    engine.close("clean");
    throw error;
  }

  const call = async (
    path: readonly string[],
    args: unknown,
    timestamp: number,
  ): Promise<unknown> => {
    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      const db = makeDbWriter(
        engine,
        newWriteCollector(),
        () => 0n,
        (observation) => observations.push(observation),
        scope,
      );
      const result = await invoke(plugin, path, { db, mount: "cache", timestamp }, args);
      engine.writer.exec("COMMIT");
      return result;
    } catch (error) {
      if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
      throw error;
    }
  };

  const inspect = async <T>(
    work: (db: TestDb) => T | Promise<T>,
  ): Promise<T> => {
    const db = makeDbWriter(
      engine,
      newWriteCollector(),
      () => 0n,
      undefined,
      scope,
    ) as TestDb;
    return work(db);
  };

  return { call, close: () => engine.close("clean"), inspect, observations };
}

describe("cachePlugin configuration and keys", () => {
  test("puts external prefixes first and frames AckerDB-owned key segments", () => {
    const frame = (
      key: string | number | bigint,
      namespace = "profiles",
    ) => encodeCacheKey("prefix", "cache", namespace, key);

    expect(frame(-0)).toBe(frame(0));
    expect(new Set([frame("1"), frame(1), frame(1n)]).size).toBe(3);
    expect(frame("1", "profiles")).not.toBe(frame("1", "settings"));
    expect(frame("a|1:b")).not.toBe(frame("a") + frame("b"));
    expect(frame("key")).toBe(
      "prefix|ackerdb-cache:v1|5:cache|8:profiles|string|3:key",
    );
    expect(encodeCacheKey("", "cache", "profiles", "key")).toBe(
      "ackerdb-cache:v1|5:cache|8:profiles|string|3:key",
    );
    expect(() => frame(Number.NaN)).toThrow("finite");
  });

  test("validates configuration without opening external stores", () => {
    let opens = 0;
    const store = defineCacheStore({
      keyPrefix: "test",
      open: () => {
        opens++;
        return {
          get: () => undefined,
          set: () => true,
          delete: () => false,
        };
      },
    });

    const builtin = cachePlugin();
    const plugin = cachePlugin({ store });
    expect(builtin.definitionId).toBe("@ackerdb/cache");
    expect(plugin.definitionId).toBe("@ackerdb/cache-external");
    expect(opens).toBe(0);
    expect(Object.isFrozen(store)).toBe(true);
    expect(() => cachePlugin({ maxBytes: 0 })).toThrow("positive safe integer");
    expect(() => cachePlugin({ maxBytes: 8, maxEntryBytes: 9 })).toThrow(
      "maxEntryBytes",
    );
    const construct = cachePlugin as (options: unknown) => unknown;
    expect(() => construct({ store, maxBytes: 8 })).toThrow("forbids");
  });
});

describe("built-in cache operations", () => {
  test("retains Cache validation and normalization when injected into another Plugin", async () => {
    const cacheContract = definePluginContract({
      get: pluginMutation({
        args: { key: v.jsonb<CacheKey>() },
        returns: v.jsonb<unknown>().optional(),
        expose: (call) => (key: CacheKey) => call({ key }),
      }),
      set: pluginMutation({
        args: {
          key: v.jsonb<CacheKey>(),
          value: v.jsonb<unknown>(),
          options: v.jsonb<CacheSetOptions>().optional(),
        },
        returns: v.boolean(),
        expose: (call) => (
          key: CacheKey,
          value: unknown,
          options?: CacheSetOptions,
        ) => call({ key, value, options }),
      }),
    });
    const cache = cachePlugin();
    const consumer = definePlugin({
      id: "@cache/runtime-consumer",
      schema: defineSchema({}),
      dependencies: { cache: cacheContract },
      create: ({ mutation }) => ({
        exports: {
          roundTrip: mutation({
            args: {
              key: v.jsonb<CacheKey>(),
              value: v.jsonb<unknown>(),
              options: v.jsonb<CacheSetOptions>().optional(),
            },
            returns: v.jsonb<unknown>().optional(),
            handler: async (ctx, args) => {
              const stored = await ctx.cache.set(args.key, args.value, args.options);
              return stored ? ctx.cache.get(args.key) : undefined;
            },
          }),
        },
      }),
    })({ cache });
    const assembly = assemblePlugins({ cache, consumer });
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();
    const { scopes } = reconcilePluginStorage(engine, assembly.mounts);
    const runtime = new PluginRuntime({ engine, assembly, scopes });

    const call = async (args: {
      readonly key: CacheKey;
      readonly value: unknown;
      readonly options?: CacheSetOptions;
    }): Promise<unknown> => {
      engine.writer.exec("BEGIN IMMEDIATE");
      try {
        const capabilities = runtime.bindMutation({
          timestamp: 10,
          analyticsFor: () => NOOP_ANALYTICS,
          logFor: () => NOOP_LOG,
          writes: newWriteCollector(),
        }) as unknown as {
          readonly consumer: {
            roundTrip(input: typeof args): Promise<unknown>;
          };
        };
        const result = await capabilities.consumer.roundTrip(args);
        engine.writer.exec("COMMIT");
        return result;
      } catch (error) {
        if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
        throw error;
      }
    };

    try {
      await runtime.start();
      await expect(
        call({ key: "invalid", value: "value", options: { expiresInMs: 0 } }),
      ).rejects.toBeInstanceOf(InvalidCacheExpirationError);
      expect(
        await call({ key: "profile", value: { name: "Pedro" } }),
      ).toEqual({ name: "Pedro" });
    } finally {
      await runtime.stop();
      engine.close("clean");
    }
  });

  test("normalizes caller values before PluginRuntime freezes validated arguments", async () => {
    const callerValue = { profile: { name: "Pedro" } };
    const callerOptions = { expiresInMs: 100 };
    const plugin = cachePlugin();
    const assembly = assemblePlugins({ cache: plugin });
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();
    const scope = engine.createPluginScope("cache", plugin.schema);
    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      engine.persistTags(scope);
      for (const plan of scope.plans.values()) engine.createTablePhysical(plan);
      engine.writer.exec("COMMIT");
    } catch (error) {
      if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
      engine.close("clean");
      throw error;
    }
    const runtime = new PluginRuntime({
      engine,
      assembly,
      scopes: new Map([["cache", scope]]),
    });

    try {
      await runtime.start();
      engine.writer.exec("BEGIN IMMEDIATE");
      try {
        const capabilities = runtime.bindMutation({
          timestamp: 10,
          analyticsFor: () => NOOP_ANALYTICS,
          logFor: () => NOOP_LOG,
          writes: newWriteCollector(),
        }) as unknown as {
          readonly cache: {
            set(
              key: string,
              value: unknown,
              options?: { readonly expiresInMs?: number },
            ): Promise<boolean>;
          };
        };
        expect(
          await capabilities.cache.set("profile", callerValue, callerOptions),
        ).toBe(true);
        engine.writer.exec("COMMIT");
      } catch (error) {
        if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
        throw error;
      }

      expect(Object.isFrozen(callerValue)).toBe(false);
      expect(Object.isFrozen(callerValue.profile)).toBe(false);
      expect(Object.isFrozen(callerOptions)).toBe(false);
      callerValue.profile.name = "Changed after set";
      callerOptions.expiresInMs = 200;

      const db = makeDbWriter(
        engine,
        newWriteCollector(),
        () => 0n,
        undefined,
        scope,
      ) as TestDb;
      const encodedKey = encodeCacheKey("", "cache", "", "profile");
      const row = await db.entries.query().where((entry) => entry.key.eq(encodedKey)).unique();
      if (row === null) throw new Error("expected normalized cache entry");
      expect(decode(row.payload)).toEqual({ profile: { name: "Pedro" } });
    } finally {
      await runtime.stop();
      engine.close("clean");
    }
  });

  test("caches null, distinguishes miss, rejects undefined, and encodes once", async () => {
    const plugin = cachePlugin();
    const rig = createBuiltInRig(plugin);
    try {
      expect(await rig.call(["get"], { key: "missing" }, 10)).toBeUndefined();
      expect(await rig.call(["set"], { key: "null", value: null }, 10)).toBe(true);
      expect(await rig.call(["get"], { key: "null" }, 10)).toBeNull();
      await expect(
        rig.call(["set"], { key: "undefined", value: undefined }, 10),
      ).rejects.toThrow("top-level undefined");

      let reads = 0;
      const value = {
        get field() {
          reads++;
          return "once";
        },
      };
      expect(await rig.call(["set"], { key: "one-encode", value }, 10)).toBe(true);
      expect(reads).toBe(1);
      expect(await rig.call(["get"], { key: "one-encode" }, 10)).toEqual({ field: "once" });
    } finally {
      rig.close();
    }
  });

  test("applies expiration, atomic conditions, and live-delete semantics", async () => {
    const plugin = cachePlugin();
    const rig = createBuiltInRig(plugin);
    try {
      await expect(
        rig.call(["set"], { key: "bad", value: 1, options: { expiresInMs: 0 } }, 100),
      ).rejects.toBeInstanceOf(InvalidCacheExpirationError);
      await expect(
        rig.call(
          ["set"],
          { key: "overflow", value: 1, options: { expiresInMs: 10 } },
          Number.MAX_SAFE_INTEGER - 5,
        ),
      ).rejects.toThrow("safe integer range");

      expect(
        await rig.call(
          ["set"],
          { key: "temporary", value: "value", options: { expiresInMs: 5 } },
          100,
        ),
      ).toBe(true);
      expect(await rig.call(["get"], { key: "temporary" }, 104)).toBe("value");
      expect(await rig.call(["get"], { key: "temporary" }, 105)).toBeUndefined();
      expect(await rig.call(["delete"], { key: "temporary" }, 105)).toBe(false);

      expect(
        await rig.call(
          ["set"],
          { key: "conditional", value: 1, options: { if: "present" } },
          200,
        ),
      ).toBe(false);
      expect(
        await rig.call(
          ["set"],
          { key: "conditional", value: 1, options: { if: "missing" } },
          200,
        ),
      ).toBe(true);
      expect(
        await rig.call(
          ["set"],
          { key: "conditional", value: 2, options: { if: "missing" } },
          200,
        ),
      ).toBe(false);
      expect(
        await rig.call(
          ["set"],
          { key: "conditional", value: 2, options: { if: "present" } },
          200,
        ),
      ).toBe(true);
      expect(await rig.call(["delete"], { key: "conditional" }, 200)).toBe(true);
      expect(await rig.call(["delete"], { key: "conditional" }, 200)).toBe(false);
    } finally {
      rig.close();
    }
  });

  test("validates namespaces on write and read without a root bypass", async () => {
    const plugin = cachePlugin({ namespaces: { profile: v.string() } });
    expect(Object.keys(plugin.exports)).toEqual(["profile"]);
    const rig = createBuiltInRig(plugin);
    try {
      expect(await rig.call(["profile", "set"], { key: 1, value: "Pedro" }, 10)).toBe(true);
      expect(await rig.call(["profile", "get"], { key: 1 }, 10)).toBe("Pedro");
      await expect(
        rig.call(["profile", "set"], { key: 2, value: 42 }, 10),
      ).rejects.toThrow("expected string");

      const encodedKey = encodeCacheKey("", "cache", "profile", 1);
      await rig.inspect(async (db) => {
        const row = await db.entries.query().where((entry) => entry.key.eq(encodedKey)).unique();
        if (row === null) throw new Error("expected cache row");
        const payload = encode(42);
        const nextBytes = new TextEncoder().encode(encodedKey).byteLength +
          new TextEncoder().encode(payload).byteLength;
        const state = await db.state.query().unique();
        if (state === null) throw new Error("expected cache state");
        await db.entries.patch(row.id, { payload, bytes: nextBytes });
        await db.state.patch(state.id, {
          totalBytes: state.totalBytes - row.bytes + nextBytes,
        });
      });

      expect(await rig.call(["profile", "get"], { key: 1 }, 10)).toBeUndefined();
      expect(
        await rig.call(
          ["profile", "set"],
          { key: 1, value: "new", options: { if: "missing" } },
          10,
        ),
      ).toBe(false);
      expect(
        await rig.call(
          ["profile", "set"],
          { key: 1, value: "new", options: { if: "present" } },
          10,
        ),
      ).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("evicts expired then oldest-written entries and keeps exact counters", async () => {
    const plugin = cachePlugin({ maxEntries: 2 });
    const rig = createBuiltInRig(plugin);
    try {
      await rig.call(["set"], { key: "old-live", value: 1 }, 1);
      await rig.call(
        ["set"],
        { key: "new-expired", value: 2, options: { expiresInMs: 1 } },
        2,
      );
      await rig.call(["set"], { key: "third", value: 3 }, 3);
      expect(await rig.call(["get"], { key: "old-live" }, 3)).toBe(1);
      expect(await rig.call(["get"], { key: "new-expired" }, 3)).toBeUndefined();

      await rig.call(["set"], { key: "old-live", value: 10 }, 4);
      await rig.call(["set"], { key: "fourth", value: 4 }, 5);
      expect(await rig.call(["get"], { key: "third" }, 5)).toBeUndefined();
      expect(await rig.call(["get"], { key: "old-live" }, 5)).toBe(10);
      expect(await rig.call(["get"], { key: "fourth" }, 5)).toBe(4);

      await rig.inspect(async (db) => {
        const entries = await db.entries.query().collect();
        const state = await db.state.query().unique();
        expect(state?.entryCount).toBe(entries.length);
        expect(state?.totalBytes).toBe(entries.reduce((total, row) => total + row.bytes, 0));
      });
    } finally {
      rig.close();
    }
  });

  test("bulk-evicts the minimal oldest prefix with one delete statement", async () => {
    const observations: DbStatementObservation[] = [];
    const sqlStatements: string[] = [];
    const plugin = cachePlugin({ maxEntries: 100, maxBytes: 500, maxEntryBytes: 500 });
    const rig = createBuiltInRig(plugin, observations, sqlStatements);
    try {
      for (const key of ["first", "second", "third", "fourth"]) {
        await rig.call(["set"], { key, value: 1 }, 1);
      }
      const before = await rig.inspect(async (db) => ({
        entries: await db.entries.query().collect(),
        state: await db.state.query().unique(),
      }));
      if (before.state === null) throw new Error("expected cache state");
      const incomingPayload = encode("x".repeat(400));
      const incomingKey = encodeCacheKey("", "cache", "", "large");
      const incomingBytes = new TextEncoder().encode(incomingKey).byteLength +
        new TextEncoder().encode(incomingPayload).byteLength;
      let projectedBytes = before.state.totalBytes + incomingBytes;
      let expectedDeleted = 0;
      while (projectedBytes > 500) {
        projectedBytes -= before.entries[expectedDeleted]!.bytes;
        expectedDeleted++;
      }
      expect(expectedDeleted).toBeGreaterThan(1);
      expect(expectedDeleted).toBeLessThan(before.entries.length);
      observations.length = 0;
      sqlStatements.length = 0;

      await rig.call(["set"], { key: "large", value: "x".repeat(400) }, 2);

      const bulkDeletes = observations.filter(({ statement }) => statement === "deleteMany");
      expect(bulkDeletes).toHaveLength(1);
      expect(bulkDeletes[0]?.rowCount).toBe(expectedDeleted);
      expect(observations.some(({ statement }) => statement === "delete")).toBe(false);
      expect(sqlStatements.filter((sql) => sql.startsWith("DELETE FROM"))).toHaveLength(1);

      await rig.inspect(async (db) => {
        const entries = await db.entries.query().collect();
        const state = await db.state.query().unique();
        const remainingIds = new Set(entries.map((row) => row.id));
        for (const evicted of before.entries.slice(0, expectedDeleted)) {
          expect(remainingIds.has(evicted.id)).toBe(false);
        }
        expect(remainingIds.has(before.entries[expectedDeleted]!.id)).toBe(true);
        expect(entries.some((row) => row.key.includes("large"))).toBe(true);
        expect(state?.entryCount).toBe(entries.length);
        expect(state?.totalBytes).toBe(entries.reduce((total, row) => total + row.bytes, 0));
      });
    } finally {
      rig.close();
    }
  });

  test("shares capacity across namespaces and enforces byte limits", async () => {
    const plugin = cachePlugin({
      namespaces: { alpha: v.string(), beta: v.string() },
      maxEntries: 1,
      maxBytes: 200,
      maxEntryBytes: 200,
    });
    const rig = createBuiltInRig(plugin);
    try {
      await rig.call(["alpha", "set"], { key: "key", value: "first" }, 1);
      await rig.call(["beta", "set"], { key: "key", value: "second" }, 2);
      expect(await rig.call(["alpha", "get"], { key: "key" }, 2)).toBeUndefined();
      expect(await rig.call(["beta", "get"], { key: "key" }, 2)).toBe("second");

      await expect(
        rig.call(["beta", "set"], { key: "large", value: "x".repeat(500) }, 3),
      ).rejects.toBeInstanceOf(CacheEntryTooLargeError);
    } finally {
      rig.close();
    }
  });

  test("get performs no writes", async () => {
    const observations: DbStatementObservation[] = [];
    const plugin = cachePlugin();
    const rig = createBuiltInRig(plugin, observations);
    try {
      await rig.call(["set"], { key: "key", value: "value" }, 1);
      observations.length = 0;
      expect(await rig.call(["get"], { key: "key" }, 1)).toBe("value");
      expect(observations.some((observation) => observation.kind === "write")).toBe(false);
      expect(observations.filter((observation) => observation.kind === "read")).toHaveLength(1);
    } finally {
      rig.close();
    }
  });
});

describe("external cache store contract", () => {
  test("receives the same single encoded payload without freezing caller values", async () => {
    let payload: string | undefined;
    const store = defineCacheStore({
      keyPrefix: "normalized",
      open: () => ({
        get: () => payload,
        set: (_key, nextPayload) => {
          payload = nextPayload;
          return true;
        },
        delete: () => false,
      }),
    });
    const callerValue = { profile: { name: "Pedro" } };
    const callerOptions: { if: "missing" | "present" } = { if: "missing" };
    const plugin = cachePlugin({ store });
    const assembly = assemblePlugins({ cache: plugin });
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();
    const scope = engine.createPluginScope("cache", plugin.schema);
    engine.persistTags(scope);
    const runtime = new PluginRuntime({
      engine,
      assembly,
      scopes: new Map([["cache", scope]]),
    });

    try {
      await runtime.start();
      const unavailable = () => Promise.reject(new Error("unused DB boundary"));
      const capabilities = runtime.bindProcedure({
        timestamp: 10,
        analyticsFor: () => NOOP_ANALYTICS,
        logFor: () => NOOP_LOG,
        abortSignal: new AbortController().signal,
        runQuery: unavailable,
        runMutation: unavailable,
        runTransaction: unavailable,
      }) as unknown as {
        readonly cache: {
          get<T>(key: string): Promise<T | undefined>;
          set(
            key: string,
            value: unknown,
            options?: { readonly if?: "missing" | "present" },
          ): Promise<boolean>;
        };
      };

      expect(
        await capabilities.cache.set("profile", callerValue, callerOptions),
      ).toBe(true);
      if (payload === undefined) throw new Error("expected normalized cache payload");
      expect(decode(payload)).toEqual({ profile: { name: "Pedro" } });
      expect(Object.isFrozen(callerValue)).toBe(false);
      expect(Object.isFrozen(callerValue.profile)).toBe(false);
      expect(Object.isFrozen(callerOptions)).toBe(false);
      callerValue.profile.name = "Changed after set";
      callerOptions.if = "present";
      expect(
        await capabilities.cache.get<{ profile: { name: string } }>("profile"),
      ).toEqual({
        profile: { name: "Pedro" },
      });
    } finally {
      await runtime.stop();
      engine.close("clean");
    }
  });

  test("owns clock, TTL, conditions, cancellation, and lifecycle", async () => {
    let now = 100;
    let opens = 0;
    let closes = 0;
    const lifecycleAbort = new AbortController();
    const requestAbort = new AbortController();
    const seenRequestSignals: AbortSignal[] = [];
    const seenTtls: Array<number | undefined> = [];
    const rows = new Map<string, { payload: string; deadline?: number }>();
    const store = defineCacheStore({
      keyPrefix: "ext",
      open: ({ abortSignal }) => {
        opens++;
        expect(abortSignal).toBe(lifecycleAbort.signal);
        return {
          get(key, request) {
            seenRequestSignals.push(request.abortSignal);
            const row = rows.get(key);
            if (row === undefined) return undefined;
            if (row.deadline !== undefined && row.deadline <= now) return undefined;
            return row.payload;
          },
          set(key, payload, request) {
            seenRequestSignals.push(request.abortSignal);
            seenTtls.push(request.expiresInMs);
            const row = rows.get(key);
            const present = row !== undefined &&
              (row.deadline === undefined || row.deadline > now);
            if (request.if === "missing" && present) return false;
            if (request.if === "present" && !present) return false;
            rows.set(key, {
              payload,
              ...(request.expiresInMs === undefined
                ? {}
                : { deadline: now + request.expiresInMs }),
            });
            return true;
          },
          delete(key, request) {
            seenRequestSignals.push(request.abortSignal);
            const row = rows.get(key);
            if (row === undefined) return false;
            rows.delete(key);
            return row.deadline === undefined || row.deadline > now;
          },
          close() {
            closes++;
          },
        };
      },
    });
    const plugin = cachePlugin({ store, namespaces: { value: v.string() } });
    expect(Object.keys(plugin.schema.tables)).toEqual([]);
    expect(Object.keys(cachePlugin().schema.tables)).toEqual(["entries", "state"]);
    expect(opens).toBe(0);
    const cleanup = await plugin.lifecycle?.({
      mount: "cache",
      abortSignal: lifecycleAbort.signal,
    });
    expect(opens).toBe(1);

    const ctx = {
      mount: "cache",
      timestamp: 999_999,
      abortSignal: requestAbort.signal,
      tx: () => Promise.reject(new Error("external cache should not open a DB transaction")),
    };
    expect(
      await invoke(
        plugin,
        ["value", "set"],
        ctx,
        { key: "ttl", value: "alive", options: { expiresInMs: 5 } },
      ),
    ).toBe(true);
    expect(seenTtls).toEqual([5]);
    now = 104;
    expect(await invoke(plugin, ["value", "get"], ctx, { key: "ttl" })).toBe("alive");
    now = 105;
    expect(await invoke(plugin, ["value", "get"], ctx, { key: "ttl" })).toBeUndefined();
    expect(await invoke(plugin, ["value", "delete"], ctx, { key: "ttl" })).toBe(false);

    now = 200;
    expect(
      await invoke(
        plugin,
        ["value", "set"],
        ctx,
        { key: "condition", value: "one", options: { if: "missing" } },
      ),
    ).toBe(true);
    const conditionKey = [...rows.keys()][0];
    if (conditionKey === undefined) throw new Error("expected external cache row");
    rows.set(conditionKey, { payload: encode(42) });
    expect(await invoke(plugin, ["value", "get"], ctx, { key: "condition" })).toBeUndefined();
    expect(
      await invoke(
        plugin,
        ["value", "set"],
        ctx,
        { key: "condition", value: "two", options: { if: "missing" } },
      ),
    ).toBe(false);
    expect(
      await invoke(
        plugin,
        ["value", "set"],
        ctx,
        { key: "condition", value: "two", options: { if: "present" } },
      ),
    ).toBe(true);
    expect(seenRequestSignals.every((signal) => signal === requestAbort.signal)).toBe(true);
    expect(
      [...rows.keys()].every((key) => key.startsWith("ext|ackerdb-cache:v1|")),
    ).toBe(true);

    if (typeof cleanup === "function") await cleanup();
    expect(closes).toBe(1);
  });

  test("keeps primitive key types distinct and retains store error causes", async () => {
    const sentinel = new Error("offline");
    const rows = new Map<string, string>();
    let failReads = false;
    const store = defineCacheStore({
      keyPrefix: "errors",
      open: () => ({
        get(key) {
          if (failReads) throw sentinel;
          return rows.get(key);
        },
        set(key, payload) {
          rows.set(key, payload);
          return true;
        },
        delete(key) {
          return rows.delete(key);
        },
      }),
    });
    const plugin = cachePlugin({ store });
    const cleanup = await plugin.lifecycle?.({
      mount: "cache",
      abortSignal: new AbortController().signal,
    });
    const ctx = {
      mount: "cache",
      timestamp: 0,
      abortSignal: new AbortController().signal,
      tx: () => Promise.reject(new Error("unused")),
    };
    await invoke(plugin, ["set"], ctx, { key: "1", value: "string" });
    await invoke(plugin, ["set"], ctx, { key: 1, value: "number" });
    await invoke(plugin, ["set"], ctx, { key: 1n, value: "bigint" });
    expect(rows.size).toBe(3);
    expect(
      [...rows.keys()].every((key) => key.startsWith("errors|ackerdb-cache:v1|")),
    ).toBe(true);
    expect(await invoke(plugin, ["get"], ctx, { key: "1" })).toBe("string");
    expect(await invoke(plugin, ["get"], ctx, { key: 1 })).toBe("number");
    expect(await invoke(plugin, ["get"], ctx, { key: 1n })).toBe("bigint");

    failReads = true;
    try {
      await invoke(plugin, ["get"], ctx, { key: "1" });
      throw new Error("expected cache store failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CacheStoreError);
      expect((error as CacheStoreError).cause).toBe(sentinel);
    }
    if (typeof cleanup === "function") await cleanup();
  });
});
