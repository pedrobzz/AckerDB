/** The single composition point for tables owned by the AckerDB framework. */
import { FILE_TABLES, withFilesTables } from "../files/tables.ts";
import { JOBS_TABLE, withJobsTable } from "../jobs/table.ts";
import type { Schema } from "../schema/definition.ts";

export const FRAMEWORK_TABLES: ReadonlySet<string> = new Set([
  JOBS_TABLE,
  ...FILE_TABLES,
]);

export function isFrameworkTable(value: unknown): value is string {
  return typeof value === "string" && FRAMEWORK_TABLES.has(value);
}

export function withFrameworkTables(schema: Schema): Schema {
  return withFilesTables(withJobsTable(schema));
}
