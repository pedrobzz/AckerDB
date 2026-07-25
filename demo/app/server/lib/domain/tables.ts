import { Err, Ok, Status } from "@dbzz/core";
import type { DatabaseReader } from "@demo/dbzz-codegen/server";

export async function activeTable(
  db: DatabaseReader,
  tableId: bigint,
) {
  const table = await db.restaurantTables.get(tableId);
  return table === null || !table.active
    ? Err("table.not-found", { tableId }, Status.NotFound)
    : Ok(table);
}
