import { describe, expect, test } from "bun:test";
import { defineApp, isApp, type AppSchema } from "../../src/app/definition.ts";
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
    expect(isApp(app)).toBe(true);
    expect(Object.keys(app)).toEqual(["schema", "scopes"]);
    expect(Object.isFrozen(app)).toBe(true);
    expect(Reflect.set(app, "schema", defineSchema({}))).toBe(false);
    expect(app.schema).toBe(schema);
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

});
