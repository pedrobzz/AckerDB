import { Err, Ok, Status } from "@ackerdb/core";
import type { Identity } from "@ackerdb/server";
import type { DatabaseReader } from "@demo/ackerdb-codegen/server";

export async function userForIdentity(
  db: DatabaseReader,
  identity: Identity,
) {
  return db.users.query().where((user) => user.identity.eq(identity)).unique();
}

export async function currentUser(
  db: DatabaseReader,
  identity: Identity,
) {
  const user = await userForIdentity(db, identity);
  return user === null
    ? Err("guest.profile-required", {}, Status.NotFound)
    : Ok(user);
}
