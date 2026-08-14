import { defineApp, type AppSchema } from "../../src/app/definition.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";

const rootSchema = defineSchema({
  users: defineTable({ id: v.primaryKey() }),
});

const app = defineApp({ schema: rootSchema });
const exactSchema: AppSchema<typeof app> = rootSchema;
void exactSchema;

// @ts-expect-error components is not an application assembly surface
defineApp({ schema: rootSchema, components: {} });
