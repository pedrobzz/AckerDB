import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Err, Ok, Status } from "@ackerdb/core";
import { newWriteCollector } from "../../src/database/access.ts";
import { createMutationInvocationScope } from "../../src/runtime/mutation-scope.ts";

function fixture() {
  const statements: string[] = [];
  const writes = newWriteCollector();
  const connection = {
    exec(statement: string) {
      statements.push(statement);
    },
  } as unknown as Database;
  return {
    statements,
    writes,
    scope: createMutationInvocationScope(connection, writes),
  };
}

test("the root transaction adds no savepoint while a nested mutation owns one", async () => {
  const { scope, statements } = fixture();

  const result = await scope.runRoot(async (root) => {
    const nested = await scope.run(root, () => Ok("nested"));
    expect(nested.data).toBe("nested");
    return Ok("root");
  });

  expect(result.data).toBe("root");
  expect(statements).toEqual([
    "SAVEPOINT ackerdb_result_1",
    "RELEASE ackerdb_result_1",
  ]);
});

test("a nested Err rolls back only its savepoint", async () => {
  const { scope, statements } = fixture();

  const result = await scope.runRoot((root) =>
    scope.run(root, () => Err("stock.unavailable", {}, Status.Conflict)),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "stock.unavailable", status: Status.Conflict },
  });
  expect(statements).toEqual([
    "SAVEPOINT ackerdb_result_1",
    "ROLLBACK TO ackerdb_result_1",
    "RELEASE ackerdb_result_1",
  ]);
});

test("a nested Err removes only the scheduled-table refreshes it added", async () => {
  const { scope, writes } = fixture();
  writes.scheduledTables.add("outer_jobs");

  await scope.runRoot((root) => scope.run(root, () => {
    writes.scheduledTables.add("nested_jobs");
    return Err("job.rejected", {}, Status.Conflict);
  }));

  expect([...writes.scheduledTables]).toEqual(["outer_jobs"]);
});
