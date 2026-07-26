import { Err, Ok, Status } from "@ackerdb/core";
import type { DatabaseReader } from "@demo/ackerdb-codegen/server";

export async function activeMenuItem(
  db: DatabaseReader,
  menuItemId: bigint,
) {
  const item = await db.menuItems.get(menuItemId);
  if (item === null || !item.active) {
    return Err("menu-item.not-found", { menuItemId }, Status.NotFound);
  }
  const category = await db.menuCategories.get(item.categoryId);
  return category === null || !category.active
    ? Err("menu-item.not-found", { menuItemId }, Status.NotFound)
    : Ok(item);
}
