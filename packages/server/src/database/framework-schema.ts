/**
 * The one place the framework's own tables are composed, and the one place
 * they meet an application's.
 *
 * Each domain declares its tables where it implements them — Jobs, Files,
 * Identities, Credentials — and contributes them here as an ordinary schema.
 * Composition refuses a duplicate table name or a conflicting named type rather
 * than letting one contribution overwrite another, so adding a domain cannot
 * silently take a name another domain already answers to.
 *
 * Everything downstream reads the *result*: Engine construction, boot, schema
 * fingerprinting, snapshots, migration generation and planning, reconciliation,
 * and the hiding rule below. The framework-table set is derived from the
 * composed schema rather than maintained beside it, so the two cannot drift.
 */
import { identitySchema } from "../auth/tables.ts";
import { credentialSchema } from "../credentials/tables.ts";
import { filesSchema } from "../files/tables.ts";
import { JOB_RUNS_TABLE, JOBS_TABLE, jobsSchema } from "../jobs/table.ts";
import { composeSchemas, type Schema } from "../schema/definition.ts";

/** Every table AckerDB itself declares, composed once. */
export const FRAMEWORK_SCHEMA: Schema = composeSchemas(
  [jobsSchema(), filesSchema(), identitySchema(), credentialSchema()],
  "framework schema",
);

export const FRAMEWORK_TABLES: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(FRAMEWORK_SCHEMA.tables)),
);

export function isFrameworkTable(value: unknown): value is string {
  return typeof value === "string" && FRAMEWORK_TABLES.has(value);
}

/** The root schema: the application's tables beside the framework's. */
export function withFrameworkTables(schema: Schema): Schema {
  return composeSchemas([schema, FRAMEWORK_SCHEMA], "root schema");
}

/**
 * The framework tables an application handler addresses directly.
 *
 * Jobs is the one framework domain whose rows are application state: a Job's
 * scheduling intent is the application's to read and edit, which is why the
 * table has a column-by-column guard at the write seam instead of a curtain in
 * front of it. Every other framework table holds state whose invariants live in
 * a capability — a File's bytes, a credential's authority, an Identity's
 * account links — and a generic read or write would step around that capability
 * rather than use it.
 */
const APPLICATION_VISIBLE: ReadonlySet<string> = Object.freeze(
  new Set([JOBS_TABLE, JOB_RUNS_TABLE]),
);

/** `ctx.db`: every application table, plus the framework tables applications own. */
export function applicationDatabase(db: unknown): unknown {
  const source = db as Readonly<Record<string, unknown>>;
  const application: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(source)) {
    if (!isFrameworkTable(name) || APPLICATION_VISIBLE.has(name)) application[name] = table;
  }
  return application;
}

/**
 * `ctx.internal.db`: the framework's own managed tables, and nothing else.
 *
 * Framework implementations reach their tables through the ordinary managed
 * reader and writer the invocation already carries, so they get its transaction,
 * its write keys, and its read dependencies rather than a second database
 * interface. Engine bookkeeping — metadata, tags, replay state, migrations — is
 * not here: it is physical, not logical, and was never a managed table.
 */
export function internalDatabase(db: unknown): unknown {
  const source = db as Readonly<Record<string, unknown>>;
  const internal: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(source)) {
    if (isFrameworkTable(name)) internal[name] = table;
  }
  return internal;
}
