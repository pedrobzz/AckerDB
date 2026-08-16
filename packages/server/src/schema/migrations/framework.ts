/**
 * Framework migrations: the framework's own answer to a refusal on a table the
 * framework owns. An application declares its schema and answers refusals with
 * numbered migration files; nobody can write a migration file for
 * `_ackerdb_jobs`, so when a framework-owned table changes shape the framework
 * ships the transform with the code that changed it.
 *
 * They differ from the application chain in exactly one way: **applied-ness is
 * structural, not recorded**. A framework migration declares the stored shape it
 * transforms, so it runs precisely while that shape is on disk and never again
 * once it is not — the same rule ADR-0003 already builds everything else on,
 * that structure is the single truth. Nothing else differs: the transform runs
 * through `applyStep`, so it gets the same one-transaction-per-step, the same
 * PRE-typed decode of old rows, the same target-typed validation of new ones,
 * and the same byte-identical rollback on any error.
 *
 * They run at the same seam an application migration reaches when the chain is
 * exhausted — after the pending chain, before the safe hop to the live schema.
 * That ordering is what lets an application carry migrations generated against
 * an older framework: those steps still meet the framework tables exactly as
 * they were when they were generated.
 */
import type { Engine } from "../../database/engine.ts";
import { Schema, type TableDef } from "../definition.ts";
import { snapshotOf, type SchemaSnapshot, type TableSnapshot } from "../snapshot.ts";
import { applyStep } from "./apply.ts";
import type { Migration, MigrationStep } from "./types.ts";

export interface FrameworkMigration {
  /** Stable label; it appears in startup output, never in stored history. */
  readonly name: string;
  /** True while the stored snapshot still holds the shape this transform reads. */
  applies(stored: SchemaSnapshot): boolean;
  /** The framework tables this migration leaves behind, replacing what is stored. */
  readonly produces: Record<string, TableDef>;
  readonly migration: Migration;
}

/**
 * Every framework migration, oldest first. The last one always `produces` the
 * live framework tables; when a new one is added, the one before it freezes the
 * shape it actually targeted, exactly as an application chain records its own
 * historical targets.
 *
 * The list is empty because the engine schema version is the floor: promoting
 * Identities, Identity Accounts, and Credentials into the managed schema
 * changed physical tables an older build had already created under the same
 * names, so a database written before it is refused at open. A transform can
 * only be written for a stored shape this build can still read.
 */
export const FRAMEWORK_MIGRATIONS: readonly FrameworkMigration[] = [];

export interface FrameworkMigrationPlan {
  /** The migrations this stored snapshot still needs, oldest first. */
  readonly pending: readonly FrameworkMigration[];
  /** The snapshot the server will store once it opens this database. */
  readonly snapshot: SchemaSnapshot;
}

/**
 * What a stored snapshot still owes the framework, and where that leaves it.
 * Pure: the CLI diffs against `snapshot` so a developer is never asked to
 * migrate a framework table, and the chain-free reconcile entry refuses on
 * `pending` by name instead of reporting the framework's tables as unanswered
 * refusals.
 */
export function planFrameworkMigrations(stored: SchemaSnapshot): FrameworkMigrationPlan {
  const pending: FrameworkMigration[] = [];
  let snapshot = stored;
  for (const migration of FRAMEWORK_MIGRATIONS) {
    if (!migration.applies(snapshot)) continue;
    pending.push(migration);
    snapshot = targetOf(snapshot, migration);
  }
  return { pending, snapshot };
}

/**
 * Apply every pending framework migration, each in its own transaction, and
 * return the snapshot the database now holds. A migration that fails rolls back
 * whole and throws; earlier ones stay applied and their shape keeps them from
 * running twice.
 */
export async function applyFrameworkMigrations(
  engine: Engine,
  stored: SchemaSnapshot,
): Promise<{ applied: string[]; snapshot: SchemaSnapshot }> {
  const applied: string[] = [];
  let current = stored;
  for (const migration of FRAMEWORK_MIGRATIONS) {
    if (!migration.applies(current)) continue;
    const step: MigrationStep = {
      // A framework step carries no chain number: it records no history row,
      // so nothing positional identifies it.
      number: 0,
      name: migration.name,
      pre: current,
      target: targetOf(current, migration),
      code: "",
      migration: migration.migration,
    };
    const outcome = await applyStep(engine, current, step, "framework");
    for (const line of outcome.applied) applied.push(`${migration.name}: ${line}`);
    current = outcome.saved;
  }
  return { applied, snapshot: current };
}

/** `current` with the migration's framework tables replacing whatever it stored. */
function targetOf(current: SchemaSnapshot, migration: FrameworkMigration): SchemaSnapshot {
  const produced = snapshotOf(new Schema(migration.produces, new Map()));
  const tables = Object.create(null) as Record<string, TableSnapshot>;
  for (const name of [...new Set([...Object.keys(current.tables), ...Object.keys(produced.tables)])].sort()) {
    tables[name] = produced.tables[name] ?? current.tables[name]!;
  }
  return { version: 2, tables };
}
