import { afterEach, describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  decode,
  type MutationMessage,
  type QueryMessage,
} from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { Engine, type StorageScope } from "../../src/database/engine.ts";
import { mutation, procedure, query } from "../../src/app/functions.ts";
import { PluginRuntime } from "../../src/plugins/runtime.ts";
import {
  assemblePlugins,
  definePlugin,
  definePluginContract,
  pluginMutation,
  pluginProcedure,
  pluginQuery,
} from "../../src/plugins/definition.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeHttpResponse } from "../../src/runtime/contracts/requests.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionRuntimeContext,
} from "../../src/subscriptions/session.ts";
import { v } from "../../src/validation/v.ts";

type AnyContext = Record<string, any>;

function request<Message>(message: Message): RuntimeRequest<Message> {
  return { message, bytes: 1 };
}

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence
    .toString(16)
    .padStart(12, "0")}`;
}

function createPluginTables(engine: Engine, scopes: ReadonlyMap<string, StorageScope>): void {
  engine.writer.exec("BEGIN IMMEDIATE");
  try {
    for (const scope of scopes.values()) {
      engine.persistTags(scope);
      for (const plan of scope.plans.values()) engine.createTablePhysical(plan);
    }
    engine.writer.exec("COMMIT");
  } catch (error) {
    if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
    throw error;
  }
}

interface Harness {
  readonly engine: Engine;
  readonly runtime: Runtime;
  readonly plugins: PluginRuntime;
  readonly session: SessionRuntimeContext;
  readonly controller: AbortController;
  readonly storeScope: StorageScope;
  nextId: number;
}

const harnesses: Harness[] = [];

async function closeHarness(harness: Harness): Promise<void> {
  harness.controller.abort();
  await harness.runtime.drain().catch(() => {});
  harness.engine.close("clean");
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await closeHarness(harness);
});

async function callMutation(
  harness: Harness,
  ref: string,
  args: unknown,
): Promise<unknown> {
  const id = harness.nextId++;
  const issuedAt = Date.now();
  const message: MutationMessage = {
    v: PROTOCOL_VERSION,
    t: "m",
    id,
    ref,
    args,
    mutationRequestId: uuidV7(issuedAt, id),
    issuedAt,
  };
  return (await harness.runtime.mutation(harness.session, request(message))).value;
}

async function callQuery(
  harness: Harness,
  ref: string,
  args: unknown,
): Promise<unknown> {
  const message: QueryMessage = {
    v: PROTOCOL_VERSION,
    t: "q",
    id: harness.nextId++,
    ref,
    args,
  };
  return harness.runtime.query(harness.session, request(message));
}

async function callProcedure(
  harness: Harness,
  ref: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const response = await harness.runtime.runProcedure({
    id: harness.nextId++,
    address: ref,
    args,
    principal: ANONYMOUS_PRINCIPAL,
    fairnessKey: "test:plugin-invocation",
    respond: (result: RuntimeHttpResponse) => new Response(result.body, { status: result.status }),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function storedValues(harness: Harness): string[] {
  const table = harness.storeScope.plan("entries").name;
  return (harness.engine.writer
    .query(`SELECT value FROM "${table}" ORDER BY value`)
    .all() as { value: string }[]).map((row) => row.value);
}

function rootLogs(harness: Harness): string[] {
  return (harness.engine.writer
    .query("SELECT label FROM logs ORDER BY label")
    .all() as { label: string }[]).map((row) => row.label);
}

async function makeHarness(
  storeLifecycle?: () => () => unknown | Promise<unknown>,
): Promise<Harness> {
  const rootSchema = defineSchema({
    logs: defineTable({ id: v.primaryKey(), label: v.string() }),
  });
  const storeSchema = defineSchema({
    entries: defineTable({
      id: v.primaryKey(),
      key: v.string(),
      value: v.string(),
    }).index(["key"], { unique: true }),
  });
  const emptySchema = defineSchema({});
  const stamp = () => v.object({
    timestamp: v.float(),
    mount: v.string(),
    hasAuth: v.boolean(),
  });
  const readResult = () => v.object({
    value: v.string().optional(),
    timestamp: v.float(),
    mount: v.string(),
    hasAuth: v.boolean(),
  });

  const providerSet = pluginMutation({
    args: { key: v.string(), value: v.string() },
    returns: stamp(),
  });
  const providerRead = pluginQuery({
    args: { key: v.string() },
    returns: readResult(),
  });
  const providerFail = pluginMutation({
    args: { key: v.string(), value: v.string() },
    returns: v.boolean(),
  });
  const providerProcedure = pluginProcedure({
    args: {},
    returns: stamp(),
  });

  const store = definePlugin({
    id: "@runtime/store",
    schema: storeSchema,
    create: ({ query: pluginQueryBuilder, mutation: pluginMutationBuilder, procedure: pluginProcedureBuilder }) => ({
      exports: {
        set: pluginMutationBuilder(providerSet, async (ctx, args) => {
          ctx.log.info("plugin set", { key: args.key });
          ctx.analytics.track("plugin set tracked", { key: args.key });
          await ctx.db.entries.upsert({ key: args.key }, { value: args.value });
          return {
            timestamp: ctx.timestamp,
            mount: ctx.mount,
            hasAuth: "auth" in ctx,
          };
        }),
        read: pluginQueryBuilder(providerRead, async (ctx, args) => {
          ctx.log.debug("plugin read", { key: args.key });
          return {
            value: (await ctx.db.entries
              .query()
              .where((row) => row.key.eq(args.key))
              .unique())?.value,
            timestamp: ctx.timestamp,
            mount: ctx.mount,
            hasAuth: "auth" in ctx,
          };
        }),
        fail: pluginMutationBuilder(providerFail, async (ctx, args) => {
          await ctx.db.entries.insert(args);
          throw new Error(`store failure:${args.key}`);
        }),
        external: pluginProcedureBuilder(providerProcedure, (ctx) => {
          ctx.log.warn("plugin procedure");
          return {
            timestamp: ctx.timestamp,
            mount: ctx.mount,
            hasAuth: "auth" in ctx,
          };
        }),
      },
      ...(storeLifecycle === undefined ? {} : { lifecycle: storeLifecycle }),
    }),
  })();

  const requiredStore = definePluginContract({
    set: pluginMutation({
      args: { key: v.string(), value: v.string() },
      returns: stamp(),
      expose: (call) => (key: string, value: string) => call({ key, value }),
    }),
    read: pluginQuery({
      args: { key: v.string() },
      returns: readResult(),
      expose: (call) => (key: string) => call({ key }),
    }),
    external: pluginProcedure({
      args: {},
      returns: stamp(),
      expose: (call) => () => call({}),
    }),
  });
  const facade = definePlugin({
    id: "@runtime/facade",
    schema: emptySchema,
    dependencies: { store: requiredStore },
    create: ({ query: pluginQueryBuilder, mutation: pluginMutationBuilder, procedure: pluginProcedureBuilder }) => ({
      exports: {
        read: pluginQueryBuilder({
          args: { key: v.string() },
          returns: v.object({
            value: v.string().optional(),
            consumerTimestamp: v.float(),
            providerTimestamp: v.float(),
            providerMount: v.string(),
            dependencyOperations: v.array(v.string()),
          }),
          handler: async (ctx, args) => {
            ctx.log.debug("facade read", { key: args.key });
            const result = await ctx.store.read(args.key);
            return {
              value: result.value,
              consumerTimestamp: ctx.timestamp,
              providerTimestamp: result.timestamp,
              providerMount: result.mount,
              dependencyOperations: Object.keys(ctx.store).sort(),
            };
          },
        }),
        put: pluginMutationBuilder({
          args: { key: v.string(), value: v.string() },
          returns: v.object({
            consumerTimestamp: v.float(),
            providerTimestamp: v.float(),
            providerMount: v.string(),
            providerHasAuth: v.boolean(),
            dependencyOperations: v.array(v.string()),
          }),
          handler: async (ctx, args) => {
            ctx.log.info("facade put", { key: args.key });
            const result = await ctx.store.set(args.key, args.value);
            return {
              consumerTimestamp: ctx.timestamp,
              providerTimestamp: result.timestamp,
              providerMount: result.mount,
              providerHasAuth: result.hasAuth,
              dependencyOperations: Object.keys(ctx.store).sort(),
            };
          },
        }),
        flow: pluginProcedureBuilder({
          args: {},
          returns: v.object({
            procedureTimestamp: v.float(),
            directTimestamp: v.float(),
            transactionTimestamp: v.float(),
            externalTimestamp: v.float(),
            procedureDependencyOperations: v.array(v.string()),
            transactionDependencyOperations: v.array(v.string()),
          }),
          handler: async (ctx) => {
            if (false) {
              // @ts-expect-error Plugin procedures track only inside transaction-owned work.
              ctx.analytics.track("invalid outer procedure event");
            }
            ctx.log.warn("facade flow");
            const direct = await ctx.store.set("flow-direct", "flow-direct");
            const transaction = await ctx.tx(async (tx) => {
              tx.analytics.track("plugin transaction tracked");
              const result = await tx.store.set("flow-tx", "flow-tx");
              expect("external" in tx.store).toBe(false);
              return {
                timestamp: result.timestamp,
                operations: Object.keys(tx.store).sort(),
              };
            });
            const external = await ctx.store.external();
            return {
              procedureTimestamp: ctx.timestamp,
              directTimestamp: direct.timestamp,
              transactionTimestamp: transaction.timestamp,
              externalTimestamp: external.timestamp,
              procedureDependencyOperations: Object.keys(ctx.store).sort(),
              transactionDependencyOperations: transaction.operations,
            };
          },
        }),
      },
    }),
  })({ store });

  const assembly = assemblePlugins({ store, facade });
  const engine = new Engine(rootSchema, ":memory:");
  reconcile(engine);
  const scopes = new Map<string, StorageScope>();
  for (const [mount, instance] of Object.entries(assembly.mounts)) {
    scopes.set(mount, engine.createPluginScope(mount, instance.schema));
  }
  createPluginTables(engine, scopes);
  const pluginRuntime = new PluginRuntime({ engine, assembly, scopes });
  await pluginRuntime.start();

  const functions = {
    plugins: {
      inspect: query({
        args: { key: v.string() },
        access: "public",
        handler: async (ctx: AnyContext, args: AnyContext) => {
          const result = await ctx.facade.read({ key: args.key });
          return {
            hostTimestamp: ctx.timestamp,
            consumerTimestamp: result.consumerTimestamp,
            providerTimestamp: result.providerTimestamp,
            value: result.value,
            hostMounts: Object.keys(ctx).filter((key) => key === "store" || key === "facade").sort(),
            storeOperations: Object.keys(ctx.store).sort(),
            facadeOperations: Object.keys(ctx.facade).sort(),
            dependencyOperations: result.dependencyOperations,
          };
        },
      }),
      sameTransaction: mutation({
        args: { key: v.string(), value: v.string() },
        access: "public",
        handler: async (ctx: AnyContext, args: AnyContext) => {
          await ctx.db.logs.insert({ label: `same:${args.key}` });
          const written = await ctx.facade.put(args);
          const read = await ctx.store.read({ key: args.key });
          return {
            hostTimestamp: ctx.timestamp,
            consumerTimestamp: written.consumerTimestamp,
            providerTimestamp: written.providerTimestamp,
            readTimestamp: read.timestamp,
            value: read.value,
            providerMount: written.providerMount,
            providerHasAuth: written.providerHasAuth,
            storeOperations: Object.keys(ctx.store).sort(),
            facadeOperations: Object.keys(ctx.facade).sort(),
            dependencyOperations: written.dependencyOperations,
          };
        },
      }),
      caughtFailure: mutation({
        args: {},
        access: "public",
        handler: async (ctx: AnyContext) => {
          try {
            await ctx.store.fail({ key: "caught", value: "caught" });
          } catch (error) {
            expect((error as Error).message).toBe("store failure:caught");
          }
          await ctx.db.logs.insert({ label: "caught" });
          return true;
        },
      }),
      uncaughtFailure: mutation({
        args: {},
        access: "public",
        handler: async (ctx: AnyContext) => {
          await ctx.db.logs.insert({ label: "uncaught" });
          await ctx.store.fail({ key: "uncaught", value: "uncaught" });
        },
      }),
      independentFailure: procedure({
        args: {},
        access: "public",
        http: true,
        handler: async (ctx: AnyContext) => {
          await ctx.facade.put({ key: "independent", value: "independent" });
          throw new Error("procedure failed after Plugin mutation");
        },
      }),
      independentRead: procedure({
        args: { key: v.string() },
        access: "public",
        http: true,
        handler: (ctx: AnyContext, args: AnyContext) => ctx.facade.read({ key: args.key }),
      }),
      hostTransaction: procedure({
        args: {},
        access: "public",
        http: true,
        handler: (ctx: AnyContext) => ctx.tx(async (tx: AnyContext) => {
          await tx.db.logs.insert({ label: "host-tx" });
          const plugin = await tx.facade.put({ key: "host-tx", value: "host-tx" });
          return {
            hostTimestamp: ctx.timestamp,
            txTimestamp: tx.timestamp,
            pluginTimestamp: plugin.providerTimestamp,
            storeOperations: Object.keys(tx.store).sort(),
            facadeOperations: Object.keys(tx.facade).sort(),
            dependencyOperations: plugin.dependencyOperations,
          };
        }),
      }),
      pluginFlow: procedure({
        args: {},
        access: "public",
        http: true,
        handler: async (ctx: AnyContext) => ({
          hostTimestamp: ctx.timestamp,
          ...await ctx.facade.flow({}),
        }),
      }),
      procedureVocabulary: procedure({
        args: {},
        access: "public",
        http: true,
        handler: async (ctx: AnyContext) => {
          const transaction = await ctx.tx((tx: AnyContext) => ({
            storeOperations: Object.keys(tx.store).sort(),
            facadeOperations: Object.keys(tx.facade).sort(),
          }));
          return {
            storeOperations: Object.keys(ctx.store).sort(),
            facadeOperations: Object.keys(ctx.facade).sort(),
            transaction: transaction.data,
          };
        },
      }),
    },
  };
  let clock = Date.now();
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    pluginRuntime,
    telemetry: false,
    now: () => ++clock,
  });
  const controller = new AbortController();
  const session: SessionRuntimeContext = Object.freeze({
    clientSessionId: "plugin-invocation",
    principal: ANONYMOUS_PRINCIPAL,
    fairnessKey: "test:plugin-invocation",
    authEpoch: 0,
    signal: controller.signal,
    publish: async (_publication: RuntimePublication) => true,
  });
  await runtime.openSession(session);
  const harness: Harness = {
    engine,
    runtime,
    plugins: pluginRuntime,
    session,
    controller,
    storeScope: scopes.get("store")!,
    nextId: 1,
  };
  harnesses.push(harness);
  return harness;
}

describe("Plugin invocation boundaries", () => {
  test("logs from query, mutation, procedure, and nested Plugin contexts", async () => {
    const harness = await makeHarness();

    await callQuery(harness, "plugins.inspect", { key: "logged" });
    await callMutation(harness, "plugins.sameTransaction", {
      key: "logged",
      value: "value",
    });
    await callProcedure(harness, "plugins.pluginFlow", {});
    await harness.runtime.telemetryJournal.flush();

    const records = (await harness.runtime.telemetryJournal.readBatch(0n, 64))
      .filter((record) => record.kind === "log");
    expect(records.map((record) => [record.message, record.functionAddress])).toEqual([
      ["facade read", "facade.read"],
      ["plugin read", "store.read"],
      ["facade put", "facade.put"],
      ["plugin set", "store.set"],
      ["plugin read", "store.read"],
      ["facade flow", "facade.flow"],
      ["plugin set", "store.set"],
      ["plugin set", "store.set"],
      ["plugin procedure", "store.external"],
    ]);
  });

  test("publishes Plugin mutation and transaction analytics only after commit", async () => {
    const harness = await makeHarness();

    await callMutation(harness, "plugins.sameTransaction", {
      key: "tracked",
      value: "value",
    });
    await callProcedure(harness, "plugins.pluginFlow", {});
    await harness.runtime.telemetryJournal.flush();

    const records = (await harness.runtime.telemetryJournal.readBatch(0n, 64))
      .filter((record) => record.kind === "analytics");
    expect(records.map((record) => [record.event, record.functionAddress])).toEqual([
      ["plugin set tracked", "store.set"],
      ["plugin set tracked", "store.set"],
      ["plugin transaction tracked", "facade.flow"],
      ["plugin set tracked", "store.set"],
    ]);
    expect(records.every((record) => record.identity === undefined)).toBe(true);
    expect(records.every((record) => record.commitId !== undefined)).toBe(true);
  });

  test("binds procedure and transaction capabilities to a system execution root", async () => {
    const harness = await makeHarness();

    const result = await harness.runtime.system.run("test.plugin-system", async (context) => {
      const ctx = context as AnyContext;
      const direct = await ctx.store.set({ key: "system-direct", value: "system-direct" });
      const external = await ctx.store.external({});
      const transaction = await ctx.tx(async (tx: AnyContext) => {
        const written = await tx.facade.put({ key: "system-tx", value: "system-tx" });
        return {
          auth: tx.auth.kind,
          timestamp: tx.timestamp,
          pluginTimestamp: written.providerTimestamp,
          storeOperations: Object.keys(tx.store).sort(),
          facadeOperations: Object.keys(tx.facade).sort(),
        };
      });
      return {
        auth: ctx.auth.kind,
        timestamp: ctx.timestamp,
        directTimestamp: direct.timestamp,
        externalTimestamp: external.timestamp,
        storeOperations: Object.keys(ctx.store).sort(),
        facadeOperations: Object.keys(ctx.facade).sort(),
        transaction: transaction.data,
      };
    });

    expect(result).toMatchObject({
      auth: "system",
      storeOperations: ["external", "fail", "read", "set"],
      facadeOperations: ["flow", "put", "read"],
      transaction: {
        auth: "system",
        storeOperations: ["fail", "read", "set"],
        facadeOperations: ["put", "read"],
      },
    });
    expect(new Set([
      result.timestamp,
      result.directTimestamp,
      result.externalTimestamp,
      result.transaction.timestamp,
      result.transaction.pluginTimestamp,
    ]).size).toBe(1);
    expect(storedValues(harness)).toEqual(["system-direct", "system-tx"]);
    expect(harness.plugins.state).toBe("ready");
  });

  test("reuses query and mutation transactions, filters kinds, and inherits one timestamp", async () => {
    const harness = await makeHarness();

    const mutationResult = await callMutation(
      harness,
      "plugins.sameTransaction",
      { key: "same", value: "same" },
    ) as AnyContext;

    expect(mutationResult).toMatchObject({
      value: "same",
      providerMount: "store",
      providerHasAuth: false,
      storeOperations: ["fail", "read", "set"],
      facadeOperations: ["put", "read"],
      dependencyOperations: ["read", "set"],
    });
    expect(new Set([
      mutationResult.hostTimestamp,
      mutationResult.consumerTimestamp,
      mutationResult.providerTimestamp,
      mutationResult.readTimestamp,
    ]).size).toBe(1);
    expect(rootLogs(harness)).toEqual(["same:same"]);
    expect(storedValues(harness)).toEqual(["same"]);

    const queryResult = await callQuery(harness, "plugins.inspect", { key: "same" }) as AnyContext;
    expect(queryResult).toMatchObject({
      value: "same",
      hostMounts: ["facade", "store"],
      storeOperations: ["read"],
      facadeOperations: ["read"],
      dependencyOperations: ["read"],
    });
    expect(new Set([
      queryResult.hostTimestamp,
      queryResult.consumerTimestamp,
      queryResult.providerTimestamp,
    ]).size).toBe(1);
  });

  test("keeps caught errors caught and rolls back an uncaught Plugin error normally", async () => {
    const harness = await makeHarness();

    expect(await callMutation(harness, "plugins.caughtFailure", {})).toBe(true);
    expect(storedValues(harness)).toEqual(["caught"]);
    expect(rootLogs(harness)).toEqual(["caught"]);

    await expect(callMutation(harness, "plugins.uncaughtFailure", {}))
      .rejects.toThrow("store failure:uncaught");
    expect(storedValues(harness)).toEqual(["caught"]);
    expect(rootLogs(harness)).toEqual(["caught"]);
  });

  test("runs direct procedure reads/writes independently and explicit tx work atomically", async () => {
    const harness = await makeHarness();

    const failed = await callProcedure(harness, "plugins.independentFailure", {});
    expect(failed).toMatchObject({ code: "internal" });
    expect(storedValues(harness)).toEqual(["independent"]);
    const independentRead = await callProcedure(
      harness,
      "plugins.independentRead",
      { key: "independent" },
    );
    expect(independentRead).toMatchObject({ value: "independent", providerMount: "store" });

    const hostValue = await callProcedure(harness, "plugins.hostTransaction", {}) as AnyContext;
    expect(new Set([
      hostValue.hostTimestamp,
      hostValue.txTimestamp,
      hostValue.pluginTimestamp,
    ]).size).toBe(1);
    expect(hostValue).toMatchObject({
      storeOperations: ["fail", "read", "set"],
      facadeOperations: ["put", "read"],
      dependencyOperations: ["read", "set"],
    });

    const flowValue = await callProcedure(harness, "plugins.pluginFlow", {}) as AnyContext;
    expect(new Set([
      flowValue.hostTimestamp,
      flowValue.procedureTimestamp,
      flowValue.directTimestamp,
      flowValue.transactionTimestamp,
      flowValue.externalTimestamp,
    ]).size).toBe(1);
    expect(flowValue).toMatchObject({
      procedureDependencyOperations: ["external", "read", "set"],
      transactionDependencyOperations: ["read", "set"],
    });
    const vocabulary = await callProcedure(harness, "plugins.procedureVocabulary", {});
    expect(vocabulary).toMatchObject({
      storeOperations: ["external", "fail", "read", "set"],
      facadeOperations: ["flow", "put", "read"],
      transaction: {
        storeOperations: ["fail", "read", "set"],
        facadeOperations: ["put", "read"],
      },
    });
    expect(storedValues(harness)).toEqual([
      "flow-direct",
      "flow-tx",
      "host-tx",
      "independent",
    ]);
    expect(rootLogs(harness)).toEqual(["host-tx"]);
  });

  test("Runtime drain owns Plugin cleanup and does not close it twice", async () => {
    const harness = await makeHarness();

    expect(harness.plugins.state).toBe("ready");
    await harness.runtime.drain();
    expect(harness.plugins.state).toBe("stopped");
    await harness.runtime.drain();
    expect(harness.plugins.state).toBe("stopped");
  });

  test("Runtime drain preserves a core failure and still reports Plugin cleanup failure", async () => {
    const coreError = new Error("reader drain failed");
    const cleanupError = new Error("Plugin cleanup failed");
    let cleanups = 0;
    const harness = await makeHarness(() => () => {
      cleanups++;
      throw cleanupError;
    });
    let settleCore!: () => void;
    const coreGate = new Promise<void>((resolve) => {
      settleCore = resolve;
    });
    const internals = harness.runtime as unknown as {
      reader: { drain: () => Promise<void> };
      coordinator: { drain: () => Promise<void> };
    };
    internals.reader.drain = () => Promise.reject(coreError);
    internals.coordinator.drain = () => coreGate;

    const draining = harness.runtime.drain();
    await Promise.resolve();
    expect(cleanups).toBe(0);
    settleCore();

    const failure = await draining.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([coreError, cleanupError]);
    expect(cleanups).toBe(1);
    expect(harness.plugins.state).toBe("failed");
    expect(harness.runtime.telemetryJournal.snapshot().state).toBe("stopped");
    expect(await harness.runtime.drain().catch((error: unknown) => error)).toBe(failure);
    expect(cleanups).toBe(1);
  });
});
