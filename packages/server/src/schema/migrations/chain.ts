/**
 * The migration chain: the append-only history, the one immutability rule that
 * governs it, and the startup orchestration that walks a pending suffix.
 *
 * The history in `_ackerdb_migrations` must always be a positional (number, identity)
 * PREFIX of the application's on-disk chain; `validateHistoryPrefix` is the single
 * rule enforcing it, pure over plain rows so the server (rows via SQL) and the CLI
 * (rows via its read-only reader) share it exactly. Any edit to an applied
 * migration shifts its identity and is refused loudly, never silently ignored.
 *
 * `applyChain` is the startup pass the reconcile entry dispatches to when a chain
 * is present: every pending step reconciles toward its own historical target in
 * its own transaction (that same transaction records the history row), so a
 * mid-chain failure leaves every earlier step applied and rolls the failing one
 * back whole. After the chain, the in-memory tag maps refresh and the remaining
 * safe drift to the live schema folds in through the planner's safe-reconcile core
 * — so this module drives the migration apply and the planner without ever calling
 * the reconcile entry back.
 */
import type { Database } from "bun:sqlite";
import type { Engine } from "../../database/engine.ts";
import { canonicalSnapshotJson, snapshotOf } from "../snapshot.ts";
import { planAndReconcile } from "../planner.ts";
import { applyStep } from "./apply.ts";
import { migrationIdentity, MigrationError, stepLabel, type MigrationStep } from "./types.ts";

/** Numbers must be 1-based and strictly increasing across the whole chain. */
export function validateChain(steps: MigrationStep[]): void {
  let prev = 0;
  for (const step of steps) {
    if (!Number.isSafeInteger(step.number) || step.number <= 0) {
      throw new MigrationError(`migration ${stepLabel(step)} has an invalid number; numbers are 1-based positive integers`);
    }
    if (step.number <= prev) {
      throw new MigrationError(`migration numbers must strictly increase; ${stepLabel(step)} does not follow ${prev}`);
    }
    prev = step.number;
  }
}

/** One recorded `_ackerdb_migrations` row: the applied prefix's positional identity. */
export interface AppliedMigrationRow {
  number: number;
  name: string;
  identity: string;
}

function loadHistory(writer: Database): AppliedMigrationRow[] {
  const rows = writer
    .query("SELECT number, name, identity FROM _ackerdb_migrations ORDER BY number ASC")
    .all() as { number: bigint; name: string; identity: string }[];
  return rows.map((r) => ({ number: Number(r.number), name: r.name, identity: r.identity }));
}

/**
 * The ONE rule for "is this on-disk chain a valid continuation of what was
 * applied", pure over plain data so the server (rows via SQL) and the CLI (rows
 * via its read-only reader) share it exactly. The applied history must be a
 * positional (number, identity) prefix of the chain; a mismatch, or an applied
 * row with no corresponding chain step, means an applied migration was edited —
 * any change to its number, name, pre, target, or transform code shifts the
 * identity — refused loudly with a `MigrationError`, never silently ignored.
 * Returns the pending suffix (the steps after the applied prefix).
 */
export function validateHistoryPrefix(
  applied: AppliedMigrationRow[],
  steps: MigrationStep[],
): { pending: MigrationStep[] } {
  validateChain(steps);
  for (let i = 0; i < applied.length; i++) {
    const row = applied[i]!;
    const step = steps[i];
    if (step === undefined || step.number !== row.number || migrationIdentity(step) !== row.identity) {
      throw new MigrationError(
        `applied migration ${stepLabel(row)} no longer matches the on-disk chain; applied migrations are immutable ` +
          "(editing its pre, target, or transform code changes its identity). Restore it, or wipe local data with `acker reset`.",
      );
    }
  }
  return { pending: steps.slice(applied.length) };
}

/** Load the append-only history and return the pending suffix (see `validateHistoryPrefix`). */
export function pendingSteps(writer: Database, steps: MigrationStep[]): MigrationStep[] {
  return validateHistoryPrefix(loadHistory(writer), steps).pending;
}

/** Stamp a whole chain as applied on a fresh database, in one transaction. */
export function recordChain(engine: Engine, steps: MigrationStep[]): void {
  validateChain(steps);
  const writer = engine.writer;
  const insert = writer.query(
    "INSERT INTO _ackerdb_migrations (number, name, identity, applied_at) VALUES (?, ?, ?, ?)",
  );
  const now = Date.now();
  writer.exec("BEGIN IMMEDIATE");
  try {
    for (const step of steps) insert.run(step.number, step.name, migrationIdentity(step), now);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Apply an append-only migration chain at startup. Every pending step reconciles
 * toward its own historical target in its own transaction (that same transaction
 * records the history row), so a mid-chain failure leaves every earlier step
 * applied and rolls the failing one back whole. After the chain the in-memory tag
 * maps are refreshed and the remaining diff to the live schema takes the ordinary
 * shape-safe reconcile path (auto-applies, or throws naming the recourse).
 */
export async function applyChain(engine: Engine, steps: MigrationStep[]): Promise<{ applied: string[] }> {
  validateChain(steps); // reject malformed numbering before touching the database
  const stored = engine.loadSnapshot();
  if (stored === null) {
    // A fresh database is already at the live schema; stamp the whole chain
    // applied so its (number, identity) prefix holds on the next open.
    engine.createAll();
    recordChain(engine, steps);
    return { applied: [`initialized ${Object.keys(snapshotOf(engine.schema).tables).length} table(s)`] };
  }
  const pending = pendingSteps(engine.writer, steps);
  const applied: string[] = [];
  let current = stored;
  for (const step of pending) {
    // The saved snapshot (target augmented with carried columns) is physical
    // truth for the next step, so a carried column resurfaces as drift there.
    const { applied: lines, saved } = await applyStep(engine, current, step);
    const label = stepLabel(step);
    for (const line of lines.length > 0 ? lines : ["applied"]) applied.push(`${label}: ${line}`);
    current = saved;
  }
  if (pending.length > 0) engine.reinternTags();
  // Trailing safe hop: fold any remaining safe drift into the live schema. The
  // database is non-fresh here (a fresh one returned above), so this runs the
  // planner's safe-reconcile core directly — plan stored → live, refuse or apply
  // — rather than calling the reconcile entry back, keeping this module off the
  // cycle. `current` is the last snapshot each step committed, so it is physical
  // truth without a reload.
  const target = snapshotOf(engine.schema);
  if (canonicalSnapshotJson(current) !== canonicalSnapshotJson(target)) {
    applied.push(...planAndReconcile(engine, current, target));
  }
  return { applied };
}
