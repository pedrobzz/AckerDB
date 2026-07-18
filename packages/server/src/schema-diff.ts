/**
 * The pure structural diff: what changed between two schema snapshots, as a
 * typed change list, with no database, engine, or tag maps involved. It is a
 * total function of `(current, target)` — the seam that reconciliation's
 * data-dependent planner consumes today, and that shape classification and
 * migration generation (which never open a database) consume next. Every
 * distinction reconciliation acts on is recoverable here: table
 * added/dropped/kind-changed, per-column add/drop/type/nullability/variant
 * deltas, and per-index add/drop/change with the uniqueness that governs the
 * change's safety class.
 */
import type { Descriptor } from "./dbz.ts";
import type { SchemaSnapshot, TableSnapshot } from "./snapshot.ts";

export interface VariantChange {
  variant: string;
  op: "added" | "removed" | "payload-changed";
}

export type ColumnChange =
  | { op: "added"; column: string; nullable: boolean }
  | { op: "dropped"; column: string }
  | { op: "type-changed"; column: string }
  | { op: "nullability-changed"; column: string; to: "nullable" | "required" }
  | { op: "variants-changed"; column: string; typeName: string; variants: VariantChange[] };

/** `unique` is the flag of the resulting index (added/changed) or the removed one (dropped). */
export interface IndexChange {
  name: string;
  op: "added" | "dropped" | "changed";
  unique: boolean;
}

export type TableChange =
  | { op: "table-added"; table: string; kind: "table" | "event" }
  | { op: "table-dropped"; table: string; kind: "table" | "event" }
  | { op: "table-kind-changed"; table: string; from: "table" | "event"; to: "table" | "event" }
  | { op: "event-updated"; table: string }
  | { op: "table-altered"; table: string; columns: ColumnChange[]; indexes: IndexChange[] };

export type SchemaDiff = TableChange[];

export interface Named {
  kind: "enum" | "union";
  name: string;
  variants: string[];
  members?: Record<string, Descriptor>;
}

export function unwrapDesc(desc: Descriptor): { base: Descriptor; nullable: boolean } {
  return desc["k"] === "nullable"
    ? { base: desc["inner"] as Descriptor, nullable: true }
    : { base: desc, nullable: false };
}

export function namedOf(desc: Descriptor): Named | null {
  const { base } = unwrapDesc(desc);
  if (base["k"] === "enum") {
    return { kind: "enum", name: base["name"] as string, variants: [...(base["values"] as string[])] };
  }
  if (base["k"] === "union") {
    const members = base["members"] as Record<string, Descriptor>;
    return { kind: "union", name: base["name"] as string, variants: Object.keys(members), members };
  }
  return null;
}

export function diffSnapshots(current: SchemaSnapshot, target: SchemaSnapshot): SchemaDiff {
  const diff: SchemaDiff = [];
  const tables = new Set([...Object.keys(current.tables), ...Object.keys(target.tables)]);
  for (const table of [...tables].sort()) {
    const oldTable = current.tables[table];
    const newTable = target.tables[table];
    if (oldTable === undefined) {
      diff.push({ op: "table-added", table, kind: newTable!.kind });
    } else if (newTable === undefined) {
      diff.push({ op: "table-dropped", table, kind: oldTable.kind });
    } else if (oldTable.kind !== newTable.kind) {
      diff.push({ op: "table-kind-changed", table, from: oldTable.kind, to: newTable.kind });
    } else if (oldTable.kind === "event") {
      if (JSON.stringify(oldTable) !== JSON.stringify(newTable)) diff.push({ op: "event-updated", table });
    } else {
      const columns = diffColumns(oldTable, newTable);
      const indexes = diffIndexes(oldTable, newTable);
      if (columns.length > 0 || indexes.length > 0) {
        diff.push({ op: "table-altered", table, columns, indexes });
      }
    }
  }
  return diff;
}

function diffColumns(oldTable: TableSnapshot, newTable: TableSnapshot): ColumnChange[] {
  const changes: ColumnChange[] = [];
  for (const column of Object.keys(newTable.columns)) {
    const oldDesc = oldTable.columns[column];
    const newDesc = newTable.columns[column]!;
    if (oldDesc === undefined) {
      changes.push({ op: "added", column, nullable: unwrapDesc(newDesc).nullable });
      continue;
    }
    if (JSON.stringify(oldDesc) === JSON.stringify(newDesc)) continue;
    const variants = diffVariants(oldDesc, newDesc);
    if (variants !== null) {
      if (variants.changes.length > 0) {
        changes.push({ op: "variants-changed", column, typeName: variants.typeName, variants: variants.changes });
      }
      continue;
    }
    const { base: oldBase, nullable: wasNullable } = unwrapDesc(oldDesc);
    const { base: newBase, nullable: isNullable } = unwrapDesc(newDesc);
    if (JSON.stringify(oldBase) === JSON.stringify(newBase)) {
      changes.push({ op: "nullability-changed", column, to: isNullable ? "nullable" : "required" });
    } else {
      changes.push({ op: "type-changed", column });
    }
  }
  for (const column of Object.keys(oldTable.columns)) {
    if (newTable.columns[column] === undefined) changes.push({ op: "dropped", column });
  }
  return changes;
}

/**
 * Variant-level delta for a top-level enum/union column whose type name and
 * nullability are unchanged. `null` means this is not a variant change — the
 * column is a genuine type change and the caller classifies it as one.
 */
function diffVariants(oldDesc: Descriptor, newDesc: Descriptor): { typeName: string; changes: VariantChange[] } | null {
  const oldNamed = namedOf(oldDesc);
  const newNamed = namedOf(newDesc);
  if (
    oldNamed === null ||
    newNamed === null ||
    oldNamed.kind !== newNamed.kind ||
    oldNamed.name !== newNamed.name ||
    unwrapDesc(oldDesc).nullable !== unwrapDesc(newDesc).nullable
  ) {
    return null;
  }
  const changes: VariantChange[] = [];
  for (const variant of oldNamed.variants) {
    if (!newNamed.variants.includes(variant)) {
      changes.push({ variant, op: "removed" });
    } else if (
      oldNamed.kind === "union" &&
      JSON.stringify(oldNamed.members![variant]) !== JSON.stringify(newNamed.members![variant])
    ) {
      changes.push({ variant, op: "payload-changed" });
    }
  }
  for (const variant of newNamed.variants) {
    if (!oldNamed.variants.includes(variant)) changes.push({ variant, op: "added" });
  }
  return { typeName: newNamed.name, changes };
}

function diffIndexes(oldTable: TableSnapshot, newTable: TableSnapshot): IndexChange[] {
  const oldIx = new Map(oldTable.indexes.map((ix) => [ix.name, ix]));
  const newIx = new Map(newTable.indexes.map((ix) => [ix.name, ix]));
  const changes: IndexChange[] = [];
  for (const name of [...new Set([...oldIx.keys(), ...newIx.keys()])].sort()) {
    const before = oldIx.get(name);
    const after = newIx.get(name);
    if (before === undefined) changes.push({ name, op: "added", unique: after!.unique });
    else if (after === undefined) changes.push({ name, op: "dropped", unique: before.unique });
    else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ name, op: "changed", unique: after.unique });
    }
  }
  return changes;
}
