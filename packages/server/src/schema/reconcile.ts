/**
 * Reconcile: the startup pass that compares the application's declared schema
 * against what the database last stored and makes the database match. It is the
 * public entry over the schema-evolution seams — the pure structural diff
 * (`diff.ts`), the pure shape classification (`classify.ts`), and the planner
 * (`planner.ts`) that turns them into physical work.
 *
 * Safety is a property of the change's shape, never of the data underneath it. A
 * shape-safe change applies automatically and identically on an empty dev table
 * and a full prod one; a shape-unsafe change is refused on both, with the
 * presume-data question and no row-count probing — even on a provably empty
 * table. A migration file is the answer to a refusal; `acker reset` is the dev
 * escape hatch. Unique indexes and tightened validators are attempted under the
 * writer lock and refused cleanly with exact counts if they cannot hold.
 *
 * This module owns only policy: the fresh-DB path (create every table), the
 * no-op short-circuit, and the dispatch to the append-only migration chain. The
 * short-circuit compares canonical snapshots, the same order-independent
 * identity the physical layer uses — declaration order is not physical truth, so
 * reordering columns is not a schema change and must not cost a startup write.
 * All
 * mechanical planning lives in the planner it consumes; a chain applies through
 * its own module and folds its trailing safe drift back through that same planner
 * core, so no cycle crosses between reconcile and the migration engine.
 */
import type { Engine } from "../database/engine.ts";
import { canonicalSnapshotJson, snapshotOf } from "./snapshot.ts";
import { applyChain } from "./migrations/chain.ts";
import type { MigrationStep } from "./migrations/types.ts";
import { planAndReconcile } from "./planner.ts";

export function reconcile(engine: Engine): { applied: string[] };
export function reconcile(engine: Engine, steps: MigrationStep[]): Promise<{ applied: string[] }>;
export function reconcile(
  engine: Engine,
  steps?: MigrationStep[],
): { applied: string[] } | Promise<{ applied: string[] }> {
  if (steps !== undefined) return applyChain(engine, steps);

  const target = snapshotOf(engine.schema);
  const current = engine.loadSnapshot();
  if (current === null) {
    engine.createAll();
    return { applied: [`initialized ${Object.keys(target.tables).length} table(s)`] };
  }
  if (canonicalSnapshotJson(current) === canonicalSnapshotJson(target)) return { applied: [] };
  return { applied: planAndReconcile(engine, current, target) };
}
