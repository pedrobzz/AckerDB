import { afterEach, describe, expect, test } from "bun:test";
import { noopAnalytics, noopLogger } from "ackerdb-test-support/signals";
import { Engine } from "../../src/database/engine.ts";
import { PluginRuntime } from "../../src/plugins/runtime.ts";
import {
  definePluginContract,
  pluginQuery,
} from "../../src/plugins/contract.ts";
import { definePlugin } from "../../src/plugins/definition.ts";
import { assemblePlugins } from "../../src/plugins/assembly.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";

const engines: Engine[] = [];

const pluginInvocation = (timestamp: number) => Object.freeze({
  timestamp,
  log: () => noopLogger,
  analytics: () => noopAnalytics,
});

function makePluginRuntime(
  assembly: ReturnType<typeof assemblePlugins>,
): PluginRuntime {
  const engine = new Engine(defineSchema({}), ":memory:");
  engines.push(engine);
  engine.createAll();
  const scopes = new Map(
    Object.entries(assembly.mounts).map(([mount, instance]) => [
      mount,
      engine.createPluginScope(mount, instance.schema),
    ]),
  );
  return new PluginRuntime({ engine, assembly, scopes });
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.close("clean");
});

describe("PluginRuntime lifecycle", () => {
  test("starts in dependency order and cleans up exactly once in reverse order", async () => {
    const events: string[] = [];
    const contract = definePluginContract({
      ping: pluginQuery({ args: {}, returns: v.boolean() }),
    });
    const provider = definePlugin({
      id: "@runtime/provider",
      schema: defineSchema({}),
      create: ({ query }) => ({
        exports: { ping: query(contract.ping, () => true) },
        lifecycle: (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          expect(context.abortSignal.aborted).toBe(false);
          events.push(`start:${context.mount}`);
          return () => {
            expect(context.abortSignal.aborted).toBe(true);
            events.push(`stop:${context.mount}`);
          };
        },
      }),
    })();
    const consumer = definePlugin({
      id: "@runtime/consumer",
      schema: defineSchema({}),
      dependencies: { provider: contract },
      create: () => ({
        exports: {},
        lifecycle: ({ mount }) => {
          events.push(`start:${mount}`);
          return async () => {
            await Promise.resolve();
            events.push(`stop:${mount}`);
          };
        },
      }),
    })({ provider });
    const runtime = makePluginRuntime(assemblePlugins({ consumer, provider }));

    await runtime.start();
    expect(runtime.state).toBe("ready");
    expect(events).toEqual(["start:provider", "start:consumer"]);

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;
    expect(runtime.state).toBe("stopped");
    expect(events).toEqual([
      "start:provider",
      "start:consumer",
      "stop:consumer",
      "stop:provider",
    ]);
    expect(await runtime.start().catch((error: unknown) => error)).toEqual(
      new Error("Plugin runtime cannot start from stopped"),
    );
  });

  test("tears down a partial start and preserves cleanup failures with the cause", async () => {
    const events: string[] = [];
    const cleanupError = new Error("provider cleanup failed");
    const startError = new Error("consumer start failed");
    const provider = definePlugin({
      id: "@runtime/partial-provider",
      schema: defineSchema({}),
      create: () => ({
        exports: {},
        lifecycle: ({ mount }) => {
          events.push(`start:${mount}`);
          return () => {
            events.push(`stop:${mount}`);
            throw cleanupError;
          };
        },
      }),
    })();
    const consumer = definePlugin({
      id: "@runtime/partial-consumer",
      schema: defineSchema({}),
      create: () => ({
        exports: {},
        lifecycle: ({ mount }) => {
          events.push(`start:${mount}`);
          throw startError;
        },
      }),
    })();
    const runtime = makePluginRuntime(assemblePlugins({ provider, consumer }));

    const failure = await runtime.start().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startError, cleanupError]);
    expect(events).toEqual(["start:provider", "start:consumer", "stop:provider"]);
    expect(runtime.state).toBe("failed");
    await runtime.stop();
    expect(events).toEqual(["start:provider", "start:consumer", "stop:provider"]);
  });

  test("cleans a resource returned after startup cancellation and never becomes ready", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const plugin = definePlugin({
      id: "@runtime/cancelled",
      schema: defineSchema({}),
      create: () => ({
        exports: {},
        lifecycle: async ({ abortSignal }) => {
          events.push("start");
          enter();
          await gate;
          expect(abortSignal.aborted).toBe(true);
          return () => events.push("cleanup");
        },
      }),
    })();
    const runtime = makePluginRuntime(assemblePlugins({ plugin }));
    const controller = new AbortController();
    const cancellation = new Error("startup interrupted");

    const starting = runtime.start(controller.signal);
    await entered;
    controller.abort(cancellation);
    release();

    expect(await starting.catch((error: unknown) => error)).toBe(cancellation);
    expect(runtime.state).toBe("failed");
    expect(events).toEqual(["start", "cleanup"]);
    await runtime.stop();
    expect(events).toEqual(["start", "cleanup"]);
  });

  test("runs every cleanup after a normal shutdown failure and never retries one", async () => {
    const events: string[] = [];
    const firstError = new Error("first cleanup failed");
    const secondError = new Error("second cleanup failed");
    const first = definePlugin({
      id: "@runtime/cleanup-first",
      schema: defineSchema({}),
      create: () => ({
        exports: {},
        lifecycle: () => () => {
          events.push("first");
          throw firstError;
        },
      }),
    })();
    const second = definePlugin({
      id: "@runtime/cleanup-second",
      schema: defineSchema({}),
      create: () => ({
        exports: {},
        lifecycle: () => async () => {
          events.push("second");
          throw secondError;
        },
      }),
    })();
    const runtime = makePluginRuntime(assemblePlugins({ first, second }));
    await runtime.start();

    const failure = await runtime.stop().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([secondError, firstError]);
    expect(events).toEqual(["second", "first"]);
    expect(runtime.state).toBe("failed");
    expect(await runtime.stop().catch((error: unknown) => error)).toBe(failure);
    expect(events).toEqual(["second", "first"]);
  });
});

describe("PluginRuntime invocation core", () => {
  test("shares an empty query binding and omits caller-incompatible mounts and namespaces", async () => {
    const cache = definePlugin({
      id: "@runtime/mutation-only-tree",
      schema: defineSchema({}),
      create: ({ mutation }) => ({
        exports: {
          profiles: {
            get: mutation({ args: {}, returns: v.boolean(), handler: () => true }),
            set: mutation({ args: {}, returns: v.boolean(), handler: () => true }),
          },
        },
      }),
    })();
    const mutationOnly = makePluginRuntime(assemblePlugins({ cache }));
    await mutationOnly.start();
    const mutationOnlyEngine = engines.at(-1)!;
    const firstEmpty = mutationOnly.bindQuery({
      invocation: pluginInvocation(1),
      connection: mutationOnlyEngine.reader,
      reads: null,
    });
    const secondEmpty = mutationOnly.bindQuery({
      invocation: pluginInvocation(2),
      connection: mutationOnlyEngine.reader,
      reads: null,
    });

    expect(firstEmpty).toBe(secondEmpty);
    expect(firstEmpty).toEqual({});
    expect(Object.isFrozen(firstEmpty)).toBe(true);

    const reader = definePlugin({
      id: "@runtime/mixed-tree",
      schema: defineSchema({}),
      create: ({ query, mutation }) => ({
        exports: {
          values: {
            read: query({
              args: {},
              returns: v.string(),
              handler: (ctx) => ctx.mount,
            }),
            write: mutation({ args: {}, returns: v.boolean(), handler: () => true }),
          },
          administration: {
            clear: mutation({ args: {}, returns: v.boolean(), handler: () => true }),
          },
        },
      }),
    })();
    const mixed = makePluginRuntime(assemblePlugins({ cache, reader }));
    await mixed.start();
    const mixedEngine = engines.at(-1)!;
    const capabilities = mixed.bindQuery({
      invocation: pluginInvocation(3),
      connection: mixedEngine.reader,
      reads: null,
    }) as AnyContext;

    expect(Object.keys(capabilities)).toEqual(["reader"]);
    expect(Object.keys(capabilities.reader)).toEqual(["values"]);
    expect(Object.keys(capabilities.reader.values)).toEqual(["read"]);
    expect(await capabilities.reader.values.read({})).toBe("reader");

    await mixed.stop();
    await mutationOnly.stop();
  });

  test("validates canonical args once and treats result validators as metadata", async () => {
    const string = v.string();
    const boolean = v.boolean();
    let argumentChecks = 0;
    let resultChecks = 0;
    let handlers = 0;
    const countedString = Object.freeze({
      kind: string.kind,
      check: (value: unknown, path: string) => {
        argumentChecks++;
        return string.check(value, path);
      },
      tsType: () => string.tsType(),
      descriptor: () => string.descriptor(),
    }) as typeof string;
    const countedBoolean = Object.freeze({
      kind: boolean.kind,
      check: (value: unknown, path: string) => {
        resultChecks++;
        return boolean.check(value, path);
      },
      tsType: () => boolean.tsType(),
      descriptor: () => boolean.descriptor(),
    }) as typeof boolean;
    const plugin = definePlugin({
      id: "@runtime/invocation-core",
      schema: defineSchema({}),
      create: ({ query }) => ({
        exports: {
          unchecked: query({
            args: { value: countedString },
            returns: countedBoolean,
            handler: (_ctx, args) => {
              handlers++;
              return `unchecked:${args.value}` as never;
            },
          }),
        },
      }),
    })();
    const assembly = assemblePlugins({ plugin });
    const engine = new Engine(defineSchema({}), ":memory:");
    engines.push(engine);
    engine.createAll();
    const scope = engine.createPluginScope("plugin", plugin.schema);
    const runtime = new PluginRuntime({
      engine,
      assembly,
      scopes: new Map([["plugin", scope]]),
    });
    await runtime.start();
    const capabilities = runtime.bindQuery({
      invocation: pluginInvocation(1),
      connection: engine.reader,
      reads: null,
    }) as AnyContext;

    expect(await capabilities.plugin.unchecked({ value: "ok" })).toBe("unchecked:ok");
    expect(argumentChecks).toBe(1);
    expect(resultChecks).toBe(0);
    expect(handlers).toBe(1);

    await expect(capabilities.plugin.unchecked({ value: 1 })).rejects.toThrow("args.value");
    expect(argumentChecks).toBe(2);
    expect(resultChecks).toBe(0);
    expect(handlers).toBe(1);
    await runtime.stop();
  });

  test("dependency providers validate and normalize arguments with their own implementation spec", async () => {
    const string = v.string();
    const providerString = Object.freeze({
      kind: string.kind,
      check: (value: unknown, path: string) => {
        const checked = string.check(value, path);
        if (checked === "forbidden") {
          throw new TypeError(`${path}: provider rejected forbidden value`);
        }
        return checked.trim();
      },
      tsType: () => string.tsType(),
      descriptor: () => string.descriptor(),
    }) as typeof string;
    const contract = definePluginContract({
      inspect: pluginQuery({ args: { value: string }, returns: string }),
    });
    const handled: string[] = [];
    const provider = definePlugin({
      id: "@runtime/validating-provider",
      schema: defineSchema({}),
      create: ({ query }) => ({
        exports: {
          inspect: query({
            args: { value: providerString },
            returns: string,
            handler: (_ctx, args) => {
              expect(Object.isFrozen(args)).toBe(true);
              handled.push(args.value);
              return args.value;
            },
          }),
        },
      }),
    })();
    const consumer = definePlugin({
      id: "@runtime/validating-consumer",
      schema: defineSchema({}),
      dependencies: { provider: contract },
      create: ({ query }) => ({
        exports: {
          inspect: query({
            args: { value: string },
            returns: string,
            handler: (ctx, args) => ctx.provider.inspect(args),
          }),
        },
      }),
    })({ provider });
    const runtime = makePluginRuntime(assemblePlugins({ consumer, provider }));
    await runtime.start();
    const engine = engines.at(-1)!;
    const capabilities = runtime.bindQuery({
      invocation: pluginInvocation(1),
      connection: engine.reader,
      reads: null,
    }) as AnyContext;

    expect(await capabilities.consumer.inspect({ value: "  normalized  " })).toBe(
      "normalized",
    );
    await expect(
      capabilities.consumer.inspect({ value: "forbidden" }),
    ).rejects.toThrow("args.value: provider rejected forbidden value");
    expect(handled).toEqual(["normalized"]);
    await runtime.stop();
  });
});

type AnyContext = Record<string, any>;
