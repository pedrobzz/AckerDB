/**
 * Shape classification: a pure, database-free verdict over a `SchemaDiff`. It
 * presumes rows always exist and judges each change by its shape alone — never
 * by data — sorting the diff into three buckets:
 *   - `safe`       physical work the reconcile applies unconditionally, the
 *                  same in an empty dev table and a full prod one;
 *   - `optimistic` data-dependent constraints: unique indexes whose rows might
 *                  collide and tightened validators rows might violate;
 *   - `refusals`   per-row questions no automatic apply may answer — each one
 *                  names its table (and column/variant where it applies) and
 *                  states the presume-data question, so the migration engine
 *                  (ticket #58) can pair every refused table with a migration
 *                  entry and generation (ticket #62) can scaffold from it, both
 *                  without opening a database.
 * The planner turns `safe` into SQL, probes `optimistic`, and throws the
 * refusals it cannot clear; this module owns every shape rule, so those
 * consumers never re-derive them.
 */
import type { Descriptor } from "../validation/v.ts";
import type { SchemaDiff, TableChange } from "./diff.ts";

/** A shape-safe unit of physical work, applied identically whether rows exist or not. */
export type SafeChange =
  | { op: "create-table"; table: string }
  | { op: "add-event-table"; table: string }
  | { op: "drop-event-table"; table: string }
  | { op: "update-event-table"; table: string }
  | { op: "event-to-table"; table: string }
  | { op: "add-column"; table: string; column: string }
  | { op: "loosen-constraints"; table: string; column: string }
  | { op: "rebuild-table"; table: string }
  | { op: "drop-index"; table: string; index: string }
  | { op: "create-index"; table: string; index: string; recreate: boolean }
  | { op: "drop-full-text"; table: string; column: string }
  | { op: "create-full-text"; table: string; column: string };

/**
 * A data-dependent target constraint. The writer probes it transactionally,
 * applies on clean data, and refuses with exact counts otherwise. Unique-index
 * changes additionally carry their physical recreation/rebuild ownership.
 */
export type OptimisticChange =
  | {
      op: "unique-index";
      table: string;
      index: string;
      recreate: boolean;
      viaRebuild: boolean;
    }
  | {
      op: "tighten-constraints";
      table: string;
      column: string;
      current: Descriptor;
      target: Descriptor;
    };

export type RefusalReason =
  | "column-type-changed"
  | "column-made-required"
  | "required-column-added"
  | "column-dropped"
  | "variant-removed"
  | "variant-payload-changed"
  | "table-dropped"
  | "table-to-event"
  | "unique-index-duplicates"
  | "constraint-violations";

/**
 * One refused change: the table it lives on, the column/variant/index site
 * where applicable, and the presume-data question it poses. `count` is set for
 * data-probed optimistic refusals (duplicate groups or violating rows), never
 * for shape-presumed refusals.
 */
export interface SchemaRefusal {
  table: string;
  column?: string;
  variant?: string;
  index?: string;
  reason: RefusalReason;
  question: string;
  count?: number;
}

export interface Classification {
  safe: SafeChange[];
  optimistic: OptimisticChange[];
  refusals: SchemaRefusal[];
}

/** The dotted site a refusal message points at: `table`, `table.column`, or `table.index`. */
export function refusalSite(refusal: SchemaRefusal): string {
  const suffix = refusal.column ?? refusal.index;
  return suffix === undefined ? refusal.table : `${refusal.table}.${suffix}`;
}

export function classifySchemaDiff(diff: SchemaDiff): Classification {
  const classification: Classification = { safe: [], optimistic: [], refusals: [] };
  for (const change of diff) classifyTable(change, classification);
  return classification;
}

function classifyTable(change: TableChange, c: Classification): void {
  const table = change.table;
  switch (change.op) {
    case "table-added":
      c.safe.push(change.kind === "table" ? { op: "create-table", table } : { op: "add-event-table", table });
      return;
    case "table-dropped":
      if (change.kind === "event") c.safe.push({ op: "drop-event-table", table });
      else c.refusals.push({ table, reason: "table-dropped", question: "table dropped; existing rows would be lost" });
      return;
    case "table-kind-changed":
      if (change.to === "table") c.safe.push({ op: "event-to-table", table });
      else c.refusals.push({ table, reason: "table-to-event", question: "changed to an event table; existing rows would be lost" });
      return;
    case "event-updated":
      c.safe.push({ op: "update-event-table", table });
      return;
    case "table-altered":
      classifyAltered(change, c);
      return;
  }
}

function classifyAltered(change: TableChange & { op: "table-altered" }, c: Classification): void {
  const table = change.table;
  const adds: SafeChange[] = [];
  let rebuild = false;

  for (const col of change.columns) {
    const column = col.column;
    switch (col.op) {
      case "added":
        if (col.nullable) adds.push({ op: "add-column", table, column });
        else c.refusals.push({ table, column, reason: "required-column-added", question: "required column added; existing rows would have no value" });
        break;
      case "dropped":
        c.refusals.push({ table, column, reason: "column-dropped", question: "column dropped; existing rows would lose data" });
        break;
      case "type-changed":
        c.refusals.push({ table, column, reason: "column-type-changed", question: "type changed; existing rows would need converting" });
        break;
      case "constraints-changed":
        if (col.direction === "loosen") {
          c.safe.push({ op: "loosen-constraints", table, column });
        } else {
          c.optimistic.push({
            op: "tighten-constraints",
            table,
            column,
            current: col.current,
            target: col.target,
          });
        }
        break;
      case "nullability-changed":
        if (col.to === "nullable") rebuild = true;
        else c.refusals.push({ table, column, reason: "column-made-required", question: "made required; existing rows may hold null" });
        break;
      case "variants-changed":
        for (const v of col.variants) {
          if (v.op === "removed") {
            c.refusals.push({ table, column, variant: v.variant, reason: "variant-removed", question: `variant '${v.variant}' removed; existing rows may still hold it` });
          } else if (v.op === "payload-changed") {
            c.refusals.push({ table, column, variant: v.variant, reason: "variant-payload-changed", question: `variant '${v.variant}' payload changed; existing rows may still hold the old shape` });
          }
        }
        break;
    }
  }

  if (rebuild) {
    // A rebuild recreates the table from the new plan, absorbing nullable adds,
    // index changes, and full-text target changes; only unique adds still need
    // their dupe probe.
    c.safe.push({ op: "rebuild-table", table });
  } else {
    // Adds land before drops before creates: a freshly indexed column exists by
    // create time, and a changed index's old shape is gone before its new one.
    c.safe.push(...adds);
    for (const ix of change.indexes) {
      if (ix.op === "dropped") c.safe.push({ op: "drop-index", table, index: ix.name });
    }
    for (const target of change.fullText) {
      c.safe.push({
        op: target.op === "added" ? "create-full-text" : "drop-full-text",
        table,
        column: target.column,
      });
    }
  }
  for (const ix of change.indexes) {
    if (ix.op === "dropped") continue;
    if (ix.unique) {
      c.optimistic.push({
        op: "unique-index",
        table,
        index: ix.name,
        recreate: ix.op === "changed",
        viaRebuild: rebuild,
      });
    }
    else if (!rebuild) c.safe.push({ op: "create-index", table, index: ix.name, recreate: ix.op === "changed" });
  }
}
