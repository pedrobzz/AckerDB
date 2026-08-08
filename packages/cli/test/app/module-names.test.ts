/**
 * How a file becomes a module name: the recursive walk, the identifier rule,
 * and the `index.ts` collapse that lets a directory hold a module of its own
 * name alongside its siblings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { listFunctionModules, listJobModules } from "../../src/app/manifest.ts";
import { loadConfig } from "../../src/app/config.ts";
import { makeFixture } from "../support/fixture.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const EMPTY = "export {};\n";

function fixture(files: Record<string, string>): string {
  const dir = makeFixture(files);
  dirs.push(dir);
  return dir;
}

describe("module names", () => {
  test("an index file takes its directory's name, not its own", () => {
    const dir = fixture({
      "functions/orders/index.ts": EMPTY,
      "functions/orders/refunds.ts": EMPTY,
      "functions/notes.ts": EMPTY,
    });
    expect(listFunctionModules(loadConfig(dir)).map((module) => module.key))
      .toEqual(["notes", "orders", "orders.refunds"]);
  });

  test("the collapse reaches every module directory, jobs included", () => {
    const dir = fixture({ "jobs/billing/index.ts": EMPTY });
    expect(listJobModules(loadConfig(dir)).map((module) => module.key)).toEqual(["billing"]);
  });

  test("nesting collapses one level at a time", () => {
    const dir = fixture({
      "functions/orders/refunds/index.ts": EMPTY,
      "functions/orders/index/nested.ts": EMPTY,
    });
    // Only a file named `index` collapses, and only into the directory holding
    // it: a directory named `index` is an ordinary name.
    expect(listFunctionModules(loadConfig(dir)).map((module) => module.key))
      .toEqual(["orders.index.nested", "orders.refunds"]);
  });

  test("refuses two files claiming one module name, naming both", () => {
    const dir = fixture({
      "functions/orders.ts": EMPTY,
      "functions/orders/index.ts": EMPTY,
    });
    expect(() => listFunctionModules(loadConfig(dir))).toThrow(
      'function modules "orders.ts" and "orders/index.ts" both publish "orders"',
    );
  });

  test("refuses an index file with no directory to take a name from", () => {
    const dir = fixture({ "functions/index.ts": EMPTY });
    expect(() => listFunctionModules(loadConfig(dir))).toThrow(
      'function module "index.ts": an "index" file takes its directory\'s name, and this one has no directory',
    );
  });

  test("still refuses a segment that cannot be a name", () => {
    const dir = fixture({ "functions/_private/hidden.ts": EMPTY });
    expect(() => listFunctionModules(loadConfig(dir))).toThrow(
      "path segments become names and must be identifiers",
    );
  });
});
