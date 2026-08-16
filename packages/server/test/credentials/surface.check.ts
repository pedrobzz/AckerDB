/**
 * Compile-time assertions about what the credential surface is, and about what
 * it is no longer. `bun run typecheck` is the test.
 *
 * The removed half matters as much as the kept half: an export that quietly
 * came back would let the deleted Admin model be reachable again, and a type
 * test is the only thing that notices an absence.
 */
import type * as core from "@ackerdb/core";
import type * as server from "@ackerdb/server";
import {
  v,
  defineSchema,
  defineTable,
  mutation,
  query,
  type MutationBuilder,
  type QueryBuilder,
} from "@ackerdb/server";

const schema = defineSchema({ notes: defineTable({ id: v.primaryKey(), body: v.string() }) });
const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;

// --------------------------------------------------------------------------
// The Admin product is gone from both packages.

type Absent<Surface, Name extends string> = Name extends keyof Surface ? never : Name;
type RemovedFromServer =
  | Absent<typeof server, "ADMIN_SCOPES">
  | Absent<typeof server, "ADMINISTRATIVE_GRANT">
  | Absent<typeof server, "FRAMEWORK_SCOPES">
  | Absent<typeof server, "systemCredentials">
  | Absent<typeof server, "credentials">
  | Absent<typeof server, "resetAdminCredentials">
  | Absent<typeof server, "normalizeAdminOptions">
  | Absent<typeof server, "frameworkFunctionModules">;
type RemovedFromCore =
  | Absent<typeof core, "adminApi">
  | Absent<typeof core, "ADMIN_API_PATH">;

/** Each union member is its own name, or `never` if the export came back. */
const removedFromServer: RemovedFromServer[] = [
  "ADMIN_SCOPES",
  "ADMINISTRATIVE_GRANT",
  "FRAMEWORK_SCOPES",
  "systemCredentials",
  "credentials",
  "resetAdminCredentials",
  "normalizeAdminOptions",
  "frameworkFunctionModules",
];
const removedFromCore: RemovedFromCore[] = ["adminApi", "ADMIN_API_PATH"];
void removedFromServer;
void removedFromCore;

// --------------------------------------------------------------------------
// The capability, and the boundary around the framework's own tables.

void typedQuery({
  access: "public",
  args: {},
  handler: (ctx) => {
    // Reads exist on both scopes; writes exist on neither.
    void ctx.credentials.query();
    void ctx.credentials.manage.query();
    // @ts-expect-error a query context issues nothing
    void ctx.credentials.issue;
    // @ts-expect-error a query context revokes nothing
    void ctx.credentials.manage.revokeMany;
    // @ts-expect-error the framework's own database is not an application's
    void ctx.internal;
    // @ts-expect-error framework tables are absent from the application database
    void ctx.db._ackerdb_credentials;
    return null;
  },
});

void typedMutation({
  access: "public",
  args: {},
  handler: (ctx) => {
    // @ts-expect-error the framework's own database is not an application's
    void ctx.internal;
    // @ts-expect-error framework tables are absent from the application database
    void ctx.db._ackerdb_identities;
    return null;
  },
});
