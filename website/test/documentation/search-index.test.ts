import { describe, expect, test } from "bun:test";
import { codeIdentifiersFromMarkdown } from "../../src/lib/documentation/search/code-identifiers";

describe("Product documentation search indexing", () => {
  test("indexes imported APIs and AckerDB capability paths at the owning heading", () => {
    expect(
      codeIdentifiersFromMarkdown(`
## Declare the schema [#declare-the-schema]

\`\`\`ts
import { defineApp, defineTable, v } from "@ackerdb/server";
const schema = defineTable({ createdAt: v.string(), updatedAt: Date.now() });
\`\`\`
`),
    ).toEqual([
      { content: "defineApp", heading: "declare-the-schema" },
      { content: "defineTable", heading: "declare-the-schema" },
      { content: "v.string", heading: "declare-the-schema" },
    ]);
  });
});
