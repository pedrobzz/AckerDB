import { describe, expect, test } from "bun:test";
import {
  definePluginContract,
  pluginMutation,
  pluginProcedure,
  pluginQuery,
} from "../../src/plugins/contract.ts";
import {
  definePlugin,
  isPluginInstance,
} from "../../src/plugins/definition.ts";
import { assemblePlugins } from "../../src/plugins/assembly.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";

describe("Plugin contracts", () => {
  test("freeze one recursive tree of canonical operation metadata", () => {
    const contract = definePluginContract({
      values: {
        get: pluginQuery({
          args: { key: v.string() },
          returns: v.string().optional(),
        }),
        set: pluginMutation({
          args: { key: v.string(), value: v.string() },
          returns: v.boolean(),
        }),
      },
      health: pluginProcedure({
        args: {},
        returns: v.boolean(),
      }),
    });

    expect(contract.values.get.kind).toBe("query");
    expect(contract.values.set.kind).toBe("mutation");
    expect(contract.health.kind).toBe("procedure");
    expect(contract.values.get.argsDescriptor).toEqual({
      k: "object",
      shape: { key: { k: "string" } },
    });
    expect(contract.values.get.resultDescriptor).toEqual({
      k: "optional",
      inner: { k: "string" },
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.values)).toBe(true);
    expect(Object.isFrozen(contract.values.get)).toBe(true);
    expect(Reflect.set(contract.values, "extra", contract.health)).toBe(false);
  });
});

describe("definePlugin", () => {
  test("returns one pure callable factory that creates unique immutable instances", () => {
    const schema = defineSchema({});
    const contract = definePluginContract({
      read: pluginQuery({ args: { key: v.string() }, returns: v.string().optional() }),
      write: pluginMutation({
        args: { key: v.string(), value: v.string() },
        returns: v.boolean(),
      }),
    });
    let constructions = 0;
    const plugin = definePlugin({
      id: "@acme/key-value",
      schema,
      create: ({ query, mutation, procedure }) => {
        constructions++;
        return {
          exports: {
            read: query(contract.read, () => undefined),
            write: mutation(contract.write, () => true),
            admin: {
              ping: procedure({
                args: {},
                returns: v.boolean(),
                handler: () => true,
              }),
            },
          },
        };
      },
    });

    expect(constructions).toBe(0);
    const first = plugin();
    const second = plugin();

    expect(constructions).toBe(2);
    expect(first).not.toBe(second);
    expect(plugin.id).toBe("@acme/key-value");
    expect(plugin.schema).toBe(schema);
    expect(first.definitionId).toBe("@acme/key-value");
    expect(first.exports.read.spec).toBe(contract.read);
    expect(first.exports.admin.ping.spec.kind).toBe("procedure");
    expect(isPluginInstance(first)).toBe(true);
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.exports)).toBe(true);
    expect(Object.isFrozen(first.exports.admin)).toBe(true);
  });

  test("retains a pure lifecycle declaration without starting it during construction", () => {
    const starts: string[] = [];
    const plugin = definePlugin({
      id: "@acme/lifecycle",
      schema: defineSchema({}),
      create: () => ({
        exports: {},
        lifecycle: ({ mount }) => {
          starts.push(mount);
        },
      }),
    });

    const instance = plugin();

    expect(starts).toEqual([]);
    expect(typeof instance.lifecycle).toBe("function");
  });

  test("extracts flat dependency slots and assembles structurally compatible providers", () => {
    const schema = defineSchema({});
    const requiredStore = definePluginContract({
      values: {
        read: pluginQuery({ args: { key: v.string() }, returns: v.string().optional() }),
      },
    });
    const providerContract = definePluginContract({
      values: {
        read: pluginQuery({ args: { key: v.string() }, returns: v.string().optional() }),
      },
      extra: pluginMutation({ args: {}, returns: v.boolean() }),
    });
    const providerPlugin = definePlugin({
      id: "@acme/store",
      schema,
      create: ({ query, mutation }) => ({
        exports: {
          values: { read: query(providerContract.values.read, () => undefined) },
          extra: mutation(providerContract.extra, () => true),
        },
      }),
    });
    const provider = providerPlugin();
    let receivedConfig: unknown;
    const consumerPlugin = definePlugin({
      id: "@acme/consumer",
      schema,
      dependencies: { store: requiredStore },
      create: ({ query }, config: { prefix: string }) => {
        receivedConfig = config;
        return {
          exports: {
            inspect: query({
              args: { key: v.string() },
              returns: v.string(),
              handler: (_ctx, args) => `${config.prefix}:${args.key}`,
            }),
          },
        };
      },
    });
    const consumer = consumerPlugin({ store: provider, prefix: "tenant" });

    expect(receivedConfig).toEqual({ prefix: "tenant" });
    expect(Object.isFrozen(receivedConfig)).toBe(true);
    expect(consumer.providers.store).toBe(provider);
    const assembly = assemblePlugins({ store: provider, consumer });
    expect(assembly.mounts.store).toBe(provider);
    expect(assembly.mounts.consumer).toBe(consumer);
    expect(assembly.order).toEqual(["store", "consumer"]);
    expect(Object.isFrozen(assembly)).toBe(true);
    expect(Object.isFrozen(assembly.mounts)).toBe(true);
    expect(Object.isFrozen(assembly.order)).toBe(true);
    expect(() => assemblePlugins({ consumer })).toThrow(
      'dependency "store" provider is not mounted',
    );

    const incompatiblePlugin = definePlugin({
      id: "@acme/incompatible-store",
      schema,
      create: ({ query }) => ({
        exports: {
          values: {
            read: query({
              args: { key: v.string() },
              returns: v.int(),
              handler: () => 1,
            }),
          },
        },
      }),
    });
    const incompatible = incompatiblePlugin();
    const incompatibleConsumer = consumerPlugin({
      store: incompatible as never,
      prefix: "tenant",
    });
    expect(() => assemblePlugins({ store: incompatible, consumer: incompatibleConsumer })).toThrow(
      "result validator does not satisfy",
    );

    const wrongArgs = definePlugin({
      id: "@acme/wrong-args",
      schema,
      create: ({ query }) => ({
        exports: {
          values: {
            read: query({
              args: { key: v.int() },
              returns: v.string().optional(),
              handler: () => undefined,
            }),
          },
        },
      }),
    })();
    const wrongArgsConsumer = consumerPlugin({ store: wrongArgs as never, prefix: "tenant" });
    expect(() => assemblePlugins({ store: wrongArgs, consumer: wrongArgsConsumer })).toThrow(
      "argument validators do not satisfy",
    );

    const wrongKind = definePlugin({
      id: "@acme/wrong-kind",
      schema,
      create: ({ mutation }) => ({
        exports: {
          values: {
            read: mutation({
              args: { key: v.string() },
              returns: v.string().optional(),
              handler: () => undefined,
            }),
          },
        },
      }),
    })();
    const wrongKindConsumer = consumerPlugin({ store: wrongKind as never, prefix: "tenant" });
    expect(() => assemblePlugins({ store: wrongKind, consumer: wrongKindConsumer })).toThrow(
      "is mutation, but the dependency requires query",
    );

    const missingOperation = definePlugin({
      id: "@acme/missing-operation",
      schema,
      create: ({ query }) => ({
        exports: {
          values: {
            other: query({ args: {}, returns: v.boolean(), handler: () => true }),
          },
        },
      }),
    })();
    const missingConsumer = consumerPlugin({
      store: missingOperation as never,
      prefix: "tenant",
    });
    expect(() => assemblePlugins({ store: missingOperation, consumer: missingConsumer })).toThrow(
      "is missing from the provider",
    );
  });

  test("treats enum declaration order as cosmetic in dependency descriptors", () => {
    const required = definePluginContract({
      choose: pluginQuery({
        args: { status: v.enum("Status", ["é", "a", "Z"]) },
        returns: v.enum("Decision", ["rejected", "accepted"]),
      }),
    });
    const provider = definePlugin({
      id: "@acme/reordered-enum-provider",
      schema: defineSchema({}),
      create: ({ query }) => ({
        exports: {
          choose: query({
            args: { status: v.enum("Status", ["a", "Z", "é"]) },
            returns: v.enum("Decision", ["accepted", "rejected"]),
            handler: () => "accepted" as const,
          }),
        },
      }),
    })();
    const consumer = definePlugin({
      id: "@acme/reordered-enum-consumer",
      schema: defineSchema({}),
      dependencies: { provider: required },
      create: () => ({ exports: {} }),
    })({ provider });

    expect(required.choose.argsDescriptor).toEqual({
      k: "object",
      shape: {
        status: { k: "enum", name: "Status", values: ["Z", "a", "é"] },
      },
    });
    expect(required.choose.resultDescriptor).toEqual({
      k: "enum",
      name: "Decision",
      values: ["accepted", "rejected"],
    });
    expect(assemblePlugins({ provider, consumer }).order).toEqual([
      "provider",
      "consumer",
    ]);
  });

  test("preserves order-sensitive arrays in non-enum dependency descriptors", () => {
    const orderedValidator = (values: readonly string[]): ReturnType<typeof v.string> => {
      const string = v.string();
      return Object.freeze({
        kind: string.kind,
        check: (value: unknown, path: string) => string.check(value, path),
        tsType: () => string.tsType(),
        descriptor: () => ({ k: "ordered", values: [...values] }),
      }) as unknown as ReturnType<typeof v.string>;
    };
    const required = definePluginContract({
      inspect: pluginQuery({
        args: { value: orderedValidator(["first", "second"]) },
        returns: v.boolean(),
      }),
    });
    const provider = definePlugin({
      id: "@acme/reordered-array-provider",
      schema: defineSchema({}),
      create: ({ query }) => ({
        exports: {
          inspect: query({
            args: { value: orderedValidator(["second", "first"]) },
            returns: v.boolean(),
            handler: () => true,
          }),
        },
      }),
    })();
    const consumer = definePlugin({
      id: "@acme/reordered-array-consumer",
      schema: defineSchema({}),
      dependencies: { provider: required },
      create: () => ({ exports: {} }),
    })({ provider });

    expect(() => assemblePlugins({ provider, consumer })).toThrow(
      "argument validators do not satisfy",
    );
  });

  test("rejects invalid definition, namespace, dependency, and mount identities", () => {
    const schema = defineSchema({});
    const contract = definePluginContract({
      read: pluginQuery({ args: {}, returns: v.boolean() }),
    });

    expect(() => definePluginContract({ "not-valid": contract.read } as never)).toThrow(
      "must be an identifier",
    );
    expect(() => definePlugin({
      id: "Not a package",
      schema,
      create: () => ({ exports: {} }),
    })).toThrow("package-like stable name");
    expect(() => definePlugin({
      id: "@acme/collision",
      schema,
      dependencies: { db: contract },
      create: () => ({ exports: {} }),
    })).toThrow("collides with a built-in context field");

    const malformedExports = definePlugin({
      id: "@acme/malformed-exports",
      schema,
      create: () => ({
        exports: { "not-valid": 1 },
      } as never),
    });
    expect(() => malformedExports()).toThrow("must be an identifier");

    const valid = definePlugin({
      id: "@acme/valid",
      schema,
      create: ({ query }) => ({
        exports: { read: query(contract.read, () => true) },
      }),
    })();
    expect(() => assemblePlugins({ db: valid })).toThrow(
      "collides with a built-in context field",
    );
    expect(() => assemblePlugins({ analytics: valid })).toThrow(
      "collides with a built-in context field",
    );
    expect(() => assemblePlugins({ "not-valid": valid } as never)).toThrow(
      "must be an identifier",
    );
    expect(() => assemblePlugins({ first: valid, second: valid })).toThrow("mounted twice");
  });

  test("recognizes descriptors from another compatible package copy", async () => {
    const copySpecifier = "../../src/plugins/definition.ts?compatible-package-copy";
    const contractCopySpecifier = "../../src/plugins/contract.ts?compatible-package-copy";
    const copy = await import(copySpecifier) as typeof import("../../src/plugins/definition.ts");
    const contractCopy =
      await import(contractCopySpecifier) as typeof import("../../src/plugins/contract.ts");
    const schema = defineSchema({});
    const contract = contractCopy.definePluginContract({
      ping: contractCopy.pluginQuery({ args: {}, returns: v.boolean() }),
    });
    const instance = copy.definePlugin({
      id: "@acme/copied",
      schema,
      create: ({ query }) => ({
        exports: { ping: query(contract.ping, () => true) },
      }),
    })();

    expect(copy.definePlugin).not.toBe(definePlugin);
    expect(isPluginInstance(instance)).toBe(true);
    expect(assemblePlugins({ copied: instance }).order).toEqual(["copied"]);
  });

  test("allows one definition identity to reuse one canonical schema across factories", async () => {
    const copySpecifier = "../../src/plugins/definition.ts?compatible-schema-factory-copy";
    const copy = await import(copySpecifier) as typeof import("../../src/plugins/definition.ts");
    const first = definePlugin({
      id: "@acme/shared-schema",
      schema: defineSchema({
        records: defineTable({ id: v.primaryKey(), value: v.string() }),
      }),
      create: () => ({ exports: {} }),
    })();
    const second = copy.definePlugin({
      id: "@acme/shared-schema",
      schema: defineSchema({
        records: defineTable({ value: v.string(), id: v.primaryKey() }),
      }),
      create: () => ({ exports: {} }),
    })();

    expect(assemblePlugins({ first, second }).order).toEqual(["first", "second"]);
  });

  test("rejects divergent private schemas for one definition identity", () => {
    const first = definePlugin({
      id: "@acme/shared-schema",
      schema: defineSchema({}),
      create: () => ({ exports: {} }),
    })();
    const second = definePlugin({
      id: "@acme/shared-schema",
      schema: defineSchema({
        records: defineTable({ id: v.primaryKey(), value: v.string() }),
      }),
      create: () => ({ exports: {} }),
    })();

    expect(() => assemblePlugins({ first, second })).toThrow(
      'Plugin definition "@acme/shared-schema" has conflicting private schemas at mounts "first" and "second"',
    );
  });
});
