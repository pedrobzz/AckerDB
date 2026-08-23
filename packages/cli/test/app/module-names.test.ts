import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { listDefinitionModules } from "../../src/app/manifest.ts";
import { loadConfig } from "../../src/app/config.ts";
import { makeFixture } from "../support/fixture.ts";

const dirs: string[] = [];
const EMPTY = "export {};\n";

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = makeFixture(files);
  dirs.push(dir);
  return dir;
}

const names = (dir: string) =>
  listDefinitionModules(loadConfig(dir)).map((module) => module.key);

describe("definition module names", () => {
  test("collapses an index file into its directory beside sibling modules", () => {
    const dir = fixture({
      "app/orders/index.ts": EMPTY,
      "app/orders/refunds.ts": EMPTY,
      "app/notes.ts": EMPTY,
    });
    expect(names(dir)).toEqual(["notes", "orders", "orders.refunds"]);
  });

  test("combines directories and configured files into one logical namespace", () => {
    const dir = fixture({
      ".ackerdb.config.json": JSON.stringify({
        definitions: ["./sales", "./support/tickets.ts"],
      }),
      "sales/orders.ts": EMPTY,
      "support/tickets.ts": EMPTY,
    });
    expect(names(dir)).toEqual(["orders", "tickets"]);
  });

  test("collapses only files named index", () => {
    const dir = fixture({
      "app/orders/refunds/index.ts": EMPTY,
      "app/orders/index/nested.ts": EMPTY,
    });
    expect(names(dir)).toEqual(["orders.index.nested", "orders.refunds"]);
  });

  test("refuses two files publishing one logical module name", () => {
    const dir = fixture({
      "app/orders.ts": EMPTY,
      "app/orders/index.ts": EMPTY,
    });
    expect(() => names(dir)).toThrow(/both publish "orders"/);
  });

  test("refuses an index file with no directory to name", () => {
    const dir = fixture({ "app/index.ts": EMPTY });
    expect(() => names(dir)).toThrow(
      /an "index" file takes its directory's name, and this one has no directory/,
    );
  });

  test("refuses path segments that cannot become definition names", () => {
    const dir = fixture({ "app/_private/hidden.ts": EMPTY });
    expect(() => names(dir)).toThrow("path segments become names and must be identifiers");
  });

  test("refuses one physical file discovered through overlapping roots", () => {
    const dir = fixture({
      ".ackerdb.config.json": JSON.stringify({ definitions: ["./app", "./app/orders.ts"] }),
      "app/orders.ts": EMPTY,
    });
    expect(() => names(dir)).toThrow(/is discovered through both/);
  });
});
