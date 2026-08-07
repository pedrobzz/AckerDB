import { describe, expect, test } from "bun:test";
import { defineApp, isApp, type AppSchema } from "../../src/app/definition.ts";
import { definePluginContract, pluginQuery } from "../../src/plugins/contract.ts";
import { definePlugin } from "../../src/plugins/definition.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";

describe("defineApp", () => {
  test("creates one immutable descriptor for the exact root schema", () => {
    const schema = defineSchema({
      users: defineTable({ id: v.primaryKey(), name: v.string() }),
    });

    const app = defineApp({ schema });
    type RootSchema = AppSchema<typeof app>;
    const rootSchema: RootSchema = schema;
    // @ts-expect-error codegen retains the manifest's exact schema, not any Schema.
    const wrongRootSchema: RootSchema = defineSchema({});

    void wrongRootSchema;
    expect(rootSchema).toBe(schema);
    expect(app.schema).toBe(schema);
    expect(app.plugins).toEqual({});
    expect(Object.isFrozen(app.plugins)).toBe(true);
    expect(isApp(app)).toBe(true);
    expect(app.apiPaths).toEqual([]);
    expect(Object.keys(app)).toEqual(["schema", "plugins", "apiPaths"]);
    expect(Object.isFrozen(app)).toBe(true);
    expect(Reflect.set(app, "schema", defineSchema({}))).toBe(false);
    expect(app.schema).toBe(schema);
  });

  test("assembles and freezes mounted Plugin instances during manifest construction", () => {
    let constructions = 0;
    const storePlugin = definePlugin({
      id: "@app/store",
      schema: defineSchema({}),
      create: ({ query }) => {
        constructions++;
        return {
          exports: {
            read: query({
              args: { key: v.string() },
              returns: v.string().optional(),
              handler: () => undefined,
            }),
          },
        };
      },
    });
    const store = storePlugin();
    const input = { store };

    const app = defineApp({ schema: defineSchema({}), plugins: input });

    expect(constructions).toBe(1);
    expect(app.plugins).not.toBe(input);
    expect(app.plugins).toEqual({ store });
    expect(Object.isFrozen(app.plugins)).toBe(true);
  });

  test("rejects Plugin graph errors before returning the manifest", () => {
    const storeContract = definePluginContract({
      read: pluginQuery({ args: { key: v.string() }, returns: v.string().optional() }),
    });
    const storePlugin = definePlugin({
      id: "@app/provider",
      schema: defineSchema({}),
      create: ({ query }) => ({
        exports: {
          read: query(storeContract.read, () => undefined),
        },
      }),
    });
    const consumerPlugin = definePlugin({
      id: "@app/consumer",
      schema: defineSchema({}),
      dependencies: { store: storeContract },
      create: () => ({ exports: {} }),
    });
    const store = storePlugin();
    const consumer = consumerPlugin({ store });

    expect(() => defineApp({ schema: defineSchema({}), plugins: { consumer } })).toThrow(
      'plugin "consumer" dependency "store" provider is not mounted',
    );
    expect(() => defineApp({ schema: defineSchema({}), plugins: { first: store, second: store } }))
      .toThrow("mounted twice");
    expect(() => defineApp({ schema: defineSchema({}), plugins: { db: store } })).toThrow(
      'plugin mount "db" collides with a built-in context field',
    );
  });

  test("rejects conflicting schemas for one Plugin identity during manifest construction", () => {
    const first = definePlugin({
      id: "@app/shared",
      schema: defineSchema({}),
      create: () => ({ exports: {} }),
    })();
    const second = definePlugin({
      id: "@app/shared",
      schema: defineSchema({
        records: defineTable({ id: v.primaryKey() }),
      }),
      create: () => ({ exports: {} }),
    })();

    expect(() => defineApp({
      schema: defineSchema({}),
      plugins: { first, second },
    })).toThrow('Plugin definition "@app/shared" has conflicting private schemas');
  });

  test("rejects malformed manifest definitions immediately", () => {
    const schema = defineSchema({});

    expect(() => defineApp(null as never)).toThrow("application definition must be a plain object");
    expect(() => defineApp([] as never)).toThrow("application definition must be a plain object");
    expect(() => defineApp({ schema: {} } as never)).toThrow(
      "application schema must be created with defineSchema(...)",
    );
    expect(() => defineApp({ schema, unexpected: true } as never)).toThrow(
      'unknown application option "unexpected"',
    );
    expect(() => defineApp({ schema, components: {} } as never)).toThrow(
      'unknown application option "components"',
    );
  });

  test("declares the extra API paths whose bindings code generation emits", () => {
    const schema = defineSchema({});

    // Sorted like every other list code generation reads, so reordering the
    // manifest never rewrites a generated file.
    expect(defineApp({ schema, apiPaths: ["internal", "admin"] }).apiPaths).toEqual([
      "admin",
      "internal",
    ]);
    expect(Object.isFrozen(defineApp({ schema, apiPaths: [] }).apiPaths)).toBe(true);
  });

  test("rejects malformed API path declarations", () => {
    const schema = defineSchema({});

    expect(() => defineApp({ schema, apiPaths: "internal" as never })).toThrow(
      "application apiPaths must be an array of group names",
    );
    expect(() => defineApp({ schema, apiPaths: ["_admin"] })).toThrow(
      '"_" is reserved to AckerDB',
    );
    expect(() => defineApp({ schema, apiPaths: ["api"] })).toThrow(
      'application apiPaths must not list "api" — every application publishes it',
    );
    // `events` is refused by the group rule itself, wherever it is written, so
    // the manifest needs no separate carve-out for it.
    expect(() => defineApp({ schema, apiPaths: ["events"] })).toThrow(
      'must not be "events" — the generated api module already binds that name',
    );
    expect(() => defineApp({ schema, apiPaths: ["class"] })).toThrow(
      'must not be "class"',
    );
    expect(() => defineApp({ schema, apiPaths: ["internal", "internal"] })).toThrow(
      'application apiPaths repeats "internal"',
    );
  });

  test("recognizes manifests from another compatible package copy", async () => {
    const copySpecifier = "../../src/app/definition.ts?compatible-package-copy";
    const copy = await import(copySpecifier) as typeof import("../../src/app/definition.ts");
    const schema = defineSchema({});
    const localApp = defineApp({ schema });
    const copiedApp = copy.defineApp({ schema });

    expect(copy.defineApp).not.toBe(defineApp);
    expect(isApp(copiedApp)).toBe(true);
    expect(copy.isApp(localApp)).toBe(true);
  });
});
