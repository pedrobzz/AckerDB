import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { importEntrypoint } from "../../src/app/manifest.ts";
import { loadConfig } from "../../src/app/config.ts";
import { makeFixture } from "../support/fixture.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("application manifest loading", () => {
  test("loads the default defineApp export as the executable application", async () => {
    const dir = makeFixture({
      "app.ts": `
import { defineApp, defineSchema, defineTable, v } from "@ackerdb/server";
const schema = defineSchema({ records: defineTable({ id: v.primaryKey() }) });
export default defineApp({ schema });
`,
    });
    dirs.push(dir);

    const app = await importEntrypoint(loadConfig(dir));
    expect(Object.keys(app.schema.tables)).toEqual(["records"]);
  });

  test("does not fall back to schema.ts and rejects a default export that is only a schema", async () => {
    const legacyOnly = makeFixture({
      "schema.ts": `
import { defineSchema } from "@ackerdb/server";
export default defineSchema({});
`,
    });
    dirs.push(legacyOnly);
    await expect(importEntrypoint(loadConfig(legacyOnly))).rejects.toThrow(
      `application entrypoint not found at ${join(legacyOnly, "app.ts")}`,
    );

    const schemaOnly = makeFixture({
      "app.ts": `
import { defineSchema } from "@ackerdb/server";
export default defineSchema({});
`,
    });
    dirs.push(schemaOnly);
    await expect(importEntrypoint(loadConfig(schemaOnly))).rejects.toThrow(
      "must default-export defineApp(...)",
    );
  });
});
