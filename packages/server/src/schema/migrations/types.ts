/**
 * The migration vocabulary: the value types a migration chain is built from, and
 * the identity math that makes an applied migration immutable. A Migration is the
 * versioned declaration of what a schema diff cannot infer — which drops-plus-adds
 * are renames, how old rows become rows of the new schema, and an explicit
 * acknowledgment for every destructive drop. A MigrationStep binds one such
 * declaration to its recorded PRE snapshot (which types the frozen before-state)
 * and TARGET snapshot (the contract the step is generated to reach).
 *
 * `defineMigration` is the authoring guard. `migrationIdentity` is the hash the
 * append-only history stamps and the on-open immutability check compares — over
 * everything that changes what a step does to data (number, name, pre, target,
 * and file bytes) — while `migrationFingerprint` is the narrower target-only
 * digest the meta sidecar recomputes at load time.
 */
import { createHash } from "node:crypto";
import type { SchemaSnapshot } from "../../snapshot.ts";

export type MigrationRow = Record<string, unknown>;

/** Read-only view of one OLD table for cross-table lookups inside a transform. */
export interface BeforeTable {
  get(id: bigint): Promise<MigrationRow | null>;
  scan(): AsyncIterableIterator<MigrationRow>;
}

export interface MigrationContext {
  /** The frozen before-state, keyed by old table name. */
  readonly before: Record<string, BeforeTable>;
  /** Emit a row into any table of the NEW schema; its pk is engine-assigned. */
  insert(table: string, row: MigrationRow): void;
}

/**
 * A per-table row transform. On a surviving table the return is the new row
 * (pk stripped and re-applied by the engine), `null` deletes the row, and
 * `undefined` keeps the row it was handed. On a dropped table the return is
 * ignored — only the emits matter.
 */
export type RowTransform = (
  row: MigrationRow,
  ctx: MigrationContext,
) => MigrationRow | null | void | Promise<MigrationRow | null | void>;

/**
 * Rename declarations: which dropped-plus-added names are the same thing
 * renamed, so data and identity carry over. `tables` maps old table name to
 * new; `columns` is keyed by the table's name in the TARGET schema; `variants`
 * is keyed by the enum/union type name. Applied to the diff first (see
 * `applyRenames`): a pure rename yields no diff, a rename with a change pairs up
 * and the normal transform machinery fires.
 */
export interface Renames {
  tables?: Record<string, string>;
  columns?: Record<string, Record<string, string>>;
  variants?: Record<string, Record<string, string>>;
}

export interface Migration {
  renames?: Renames;
  tables?: Record<string, RowTransform | null>;
}

/**
 * One link in the application's migration chain. `number` is 1-based and
 * strictly increasing across the chain; `pre` types the before-state the
 * transforms were written against; `target` is the full declared schema at
 * generation time; `code` is the migration module's file text, the last
 * component of the step's immutable identity (see `migrationIdentity`). An
 * in-memory chain (server tests, embedded users) passes any string for `code`,
 * conventionally `""` — it is a value, not an optional.
 */
export interface MigrationStep {
  number: number;
  name: string;
  pre: SchemaSnapshot;
  target: SchemaSnapshot;
  code: string;
  migration: Migration;
}

export class MigrationError extends Error {}

export function defineMigration(migration: Migration): Migration {
  if (migration === null || typeof migration !== "object") {
    throw new MigrationError("defineMigration expects a migration object");
  }
  const tables = migration.tables;
  if (tables !== undefined) {
    if (typeof tables !== "object" || tables === null) {
      throw new MigrationError("migration tables must be an object");
    }
    for (const [name, value] of Object.entries(tables)) {
      if (value !== null && typeof value !== "function") {
        throw new MigrationError(`migration entry for "${name}" must be a transform function or null`);
      }
    }
  }
  checkRenamesShape(migration.renames);
  return migration;
}

/** Shallow shape guard for `renames`; existence/conflict checks run in `planRenames`. */
function checkRenamesShape(renames: Renames | undefined): void {
  if (renames === undefined) return;
  if (typeof renames !== "object" || renames === null) throw new MigrationError("migration renames must be an object");
  const isStringMap = (value: unknown): boolean =>
    typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
  if (renames.tables !== undefined && !isStringMap(renames.tables)) {
    throw new MigrationError("migration renames.tables must map old names to new names");
  }
  for (const key of ["columns", "variants"] as const) {
    const nested = renames[key];
    if (nested === undefined) continue;
    if (typeof nested !== "object" || nested === null || !Object.values(nested).every(isStringMap)) {
      throw new MigrationError(`migration renames.${key} must map each name to a { old: new } object`);
    }
  }
}

// -- identity, fingerprint, immutability --------------------------------------

/**
 * The load-time target-integrity fingerprint: the sha256 hex of a target
 * snapshot alone. Used by meta sidecars and generation to catch an edited
 * target snapshot before the database opens — a narrower job than identity.
 */
export function migrationFingerprint(target: SchemaSnapshot): string {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

/**
 * A migration's immutable applied identity: the sha256 hex over everything that
 * changes what the step does to data — its number, name, pre snapshot, target
 * snapshot, and migration file text (`code`). Each component is netstring-framed
 * (`<byteLength>:<value>,`) before concatenation, so the encoding is injective:
 * no two distinct tuples ever collide, regardless of what any component holds.
 * This is the value `_dbz_migrations` records and `validateHistoryPrefix`
 * compares, so editing an applied migration's pre, renames, or transform code —
 * not just its target — shifts the identity and is refused loudly on the next open.
 */
export function migrationIdentity(step: MigrationStep): string {
  const part = (value: string): string => `${Buffer.byteLength(value)}:${value},`;
  const canonical =
    part(String(step.number)) +
    part(step.name) +
    part(JSON.stringify(step.pre)) +
    part(JSON.stringify(step.target)) +
    part(step.code);
  return createHash("sha256").update(canonical).digest("hex");
}

/** The zero-padded label a step is logged and named under, e.g. `0003_split_users`. */
export function stepLabel(step: { number: number; name: string }): string {
  return `${String(step.number).padStart(4, "0")}_${step.name}`;
}
