import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Err, Ok, Status } from "@dbzz/core";
import { newWriteCollector } from "../../src/database/access.ts";
import { createMutationInvocationScope } from "../../src/runtime/mutation-scope.ts";

function fixture() {
  const statements: string[] = [];
  const connection = {
    exec(statement: string) {
      statements.push(statement);
    },
  } as unknown as Database;
  return {
    statements,
    scope: createMutationInvocationScope(connection, newWriteCollector()),
  };
}

test("the root transaction adds no savepoint while a nested mutation owns one", async () => {
  const { scope, statements } = fixture();

  const result = await scope.runRoot(async () => {
    const nested = await scope.run(() => Ok("nested"));
    expect(nested.data).toBe("nested");
    return Ok("root");
  });

  expect(result.data).toBe("root");
  expect(statements).toEqual([
    "SAVEPOINT dbzz_result_1",
    "RELEASE dbzz_result_1",
  ]);
});

test("a nested Err rolls back only its savepoint", async () => {
  const { scope, statements } = fixture();

  const result = await scope.runRoot(() =>
    scope.run(() => Err("stock.unavailable", {}, Status.Conflict)),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "stock.unavailable", status: Status.Conflict },
  });
  expect(statements).toEqual([
    "SAVEPOINT dbzz_result_1",
    "ROLLBACK TO dbzz_result_1",
    "RELEASE dbzz_result_1",
  ]);
});
