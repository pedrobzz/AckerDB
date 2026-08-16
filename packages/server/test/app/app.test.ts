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
    expect(app.apiPaths).toEqual([]);
    expect(Object.keys(app)).toEqual(["schema", "apiPaths", "scopes"]);
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
  });

  test("declares the extra API paths whose bindings code generation emits", () => {
    const schema = defineSchema({});
    expect(defineApp({ schema, apiPaths: ["reports", "internal"] }).apiPaths).toEqual([
      "internal",
      "reports",
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
    // `admin` is an ordinary group name an application may claim for itself.
    expect(defineApp({ schema, apiPaths: ["admin"] }).apiPaths).toEqual(["admin"]);
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
});
