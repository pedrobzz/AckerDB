import { describe, expect, test } from "bun:test";
import { codeIdentifiersFromMarkdown } from "../src/lib/documentation/search/code-identifiers";

describe("Product documentation search indexing", () => {
  test("indexes code identifiers at the heading that owns the example", () => {
    expect(
      codeIdentifiersFromMarkdown(`
## Declare the schema [#declare-the-schema]

\`\`\`ts
import { defineApp, defineTable } from "@ackerdb/server";
const schema = defineTable({ createdAt: Date.now() });
\`\`\`
`),
    ).toEqual([
      { content: "defineApp", heading: "declare-the-schema" },
      { content: "defineTable", heading: "declare-the-schema" },
      { content: "ackerdb", heading: "declare-the-schema" },
      { content: "server", heading: "declare-the-schema" },
      { content: "schema", heading: "declare-the-schema" },
      { content: "createdAt", heading: "declare-the-schema" },
      { content: "Date.now", heading: "declare-the-schema" },
    ]);
  });
});
