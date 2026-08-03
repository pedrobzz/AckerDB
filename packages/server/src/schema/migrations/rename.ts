/**
 * Renames: the migration's statement that a dropped and an added name (table,
 * column, or enum/union variant) are the same thing renamed, so its data and
 * identity carry over instead of being dropped and recreated.
 *
 * `planRenames` validates the declarations (a `MigrationError` touching nothing)
 * and derives the renamed-stored snapshot the diff runs against, plus the physical
 * rename work the apply performs. `applyRenames` is the pure rewrite at its heart —
 * table keys, column keys, index/full-text references, and top-level variant
 * names — reused by migration generation, which classifies the diff of the
 * renamed-stored snapshot against the target without ever opening a database.
 */
import type { Database } from "bun:sqlite";
import type { Descriptor } from "../../validation/validator.ts";
import { compareCodeUnits } from "../../shared/ordering.ts";
import type { SchemaSnapshot, TableSnapshot } from "../snapshot.ts";
import { namedOf } from "../diff.ts";
import { MigrationError, type Migration } from "./types.ts";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function renamedName(renames: Readonly<Record<string, string>>, name: string): string {
  return Object.hasOwn(renames, name) ? renames[name]! : name;
}

export interface NormalizedRenames {
  tables: Record<string, string>; // old -> new
  columns: Record<string, Record<string, string>>; // NEW table name -> { oldCol -> newCol }
  variants: Record<string, Record<string, string>>; // type name -> { oldVariant -> newVariant }
}

export interface RenamePlan {
  /** The stored snapshot with every rename applied — what the diff runs against. */
  renamedCurrent: SchemaSnapshot;
  /** new table name -> old table name, for tables whose name changed. */
  tableOldName: Map<string, string>;
  /** new table name -> physical [old, new] column pairs (a union contributes both). */
  columnPhys: Map<string, [string, string][]>;
  /** new table name -> new physical column name -> old physical column name. */
  columnReverse: Map<string, Map<string, string>>;
  variants: { type: string; from: string; to: string }[];
  /** Every new table name touched by a table or column rename. */
  renamedTables: Set<string>;
}

export interface RenameRoutes {
  /** new table name -> old physical table name. */
  tableOldName: Map<string, string>;
  /** new table name -> physical [old, new] column pairs. */
  columnPhys: Map<string, [string, string][]>;
  /** new table name -> new physical column name -> old physical column name. */
  columnReverse: Map<string, Map<string, string>>;
}

/**
 * The one pure derivation of logical rename answers into physical read routes.
 * Both migration apply and CLI post-answer probes consume it.
 */
export function renameRoutes(target: SchemaSnapshot, raw: NormalizedRenames): RenameRoutes {
  const tableOldName = new Map<string, string>();
  for (const [oldTable, newTable] of Object.entries(raw.tables)) tableOldName.set(newTable, oldTable);

  const columnPhys = new Map<string, [string, string][]>();
  const columnReverse = new Map<string, Map<string, string>>();
  for (const [table, columns] of Object.entries(raw.columns)) {
    const targetTable = ownValue(target.tables, table);
    if (targetTable === undefined) throw new MigrationError(`rename target table "${table}" is not in the schema`);
    const pairs: [string, string][] = [];
    const reverse = new Map<string, string>();
    for (const [oldColumn, newColumn] of Object.entries(columns)) {
      const targetColumn = ownValue(targetTable.columns, newColumn);
      if (targetColumn === undefined) {
        throw new MigrationError(`rename target column "${table}.${newColumn}" is not in the schema`);
      }
      pairs.push([oldColumn, newColumn]);
      reverse.set(newColumn, oldColumn);
      if (namedOf(targetColumn)?.kind === "union") {
        pairs.push([`${oldColumn}__p`, `${newColumn}__p`]);
        reverse.set(`${newColumn}__p`, `${oldColumn}__p`);
      }
    }
    columnPhys.set(table, pairs);
    columnReverse.set(table, reverse);
  }
  return { tableOldName, columnPhys, columnReverse };
}

/**
 * Validate the rename declarations (MigrationError, nothing touched) and derive
 * the renamed-stored snapshot plus the physical rename work. `columns` are keyed
 * by the TARGET table name, so table renames are resolved first; a column's
 * physical arity comes from its TARGET descriptor (a union contributes two).
 */
export function planRenames(writer: Database, current: SchemaSnapshot, target: SchemaSnapshot, migration: Migration): RenamePlan {
  const raw: NormalizedRenames = {
    tables: migration.renames?.tables ?? {},
    columns: migration.renames?.columns ?? {},
    variants: migration.renames?.variants ?? {},
  };
  validateRenames(writer, current, target, raw);

  const { tableOldName, columnPhys, columnReverse } = renameRoutes(target, raw);

  const variants: RenamePlan["variants"] = [];
  for (const [type, vmap] of Object.entries(raw.variants)) {
    for (const [from, to] of Object.entries(vmap)) variants.push({ type, from, to });
  }

  return {
    renamedCurrent: applyRenames(current, raw),
    tableOldName,
    columnPhys,
    columnReverse,
    variants,
    renamedTables: new Set([...tableOldName.keys(), ...Object.keys(raw.columns)]),
  };
}

function validateRenames(writer: Database, current: SchemaSnapshot, target: SchemaSnapshot, raw: NormalizedRenames): void {
  const tableTargets = new Set<string>();
  for (const [oldT, newT] of Object.entries(raw.tables)) {
    const source = ownValue(current.tables, oldT);
    if (source?.kind !== "table") throw new MigrationError(`rename source table "${oldT}" does not exist`);
    if (!Object.hasOwn(target.tables, newT)) throw new MigrationError(`rename target table "${newT}" is not in the schema`);
    if (Object.hasOwn(target.tables, oldT)) {
      throw new MigrationError(`rename source table "${oldT}" still exists in the schema; it was not dropped`);
    }
    if (Object.hasOwn(current.tables, newT)) {
      throw new MigrationError(`rename target table "${newT}" already exists; cannot rename onto a live table`);
    }
    if (tableTargets.has(newT)) throw new MigrationError(`two renames target table "${newT}"`);
    tableTargets.add(newT);
  }

  for (const [table, cols] of Object.entries(raw.columns)) {
    if (!Object.hasOwn(target.tables, table)) throw new MigrationError(`rename target table "${table}" is not in the schema`);
    const oldTable = Object.keys(raw.tables).find((o) => raw.tables[o] === table) ?? table;
    const sourceTable = ownValue(current.tables, oldTable);
    const from = sourceTable?.columns ?? {};
    const to = target.tables[table]!.columns;
    const colTargets = new Set<string>();
    for (const [oldCol, newCol] of Object.entries(cols)) {
      if (!Object.hasOwn(from, oldCol)) throw new MigrationError(`rename source column "${table}.${oldCol}" does not exist`);
      if (!Object.hasOwn(to, newCol)) throw new MigrationError(`rename target column "${table}.${newCol}" is not in the schema`);
      if (Object.hasOwn(to, oldCol)) {
        throw new MigrationError(`rename source column "${table}.${oldCol}" still exists in the schema; it was not dropped`);
      }
      if (Object.hasOwn(from, newCol)) {
        throw new MigrationError(`rename target column "${table}.${newCol}" already exists; cannot rename onto a live column`);
      }
      if (colTargets.has(newCol)) throw new MigrationError(`two renames target column "${table}.${newCol}"`);
      colTargets.add(newCol);
    }
  }

  const currentVariants = variantSets(current);
  const targetVariants = variantSets(target);
  const taggedVariants = new Map<string, Set<string>>();
  for (const row of writer.query("SELECT type, variant FROM _ackerdb_tags").all() as { type: string; variant: string }[]) {
    (taggedVariants.get(row.type) ?? taggedVariants.set(row.type, new Set()).get(row.type)!).add(row.variant);
  }
  for (const [type, vmap] of Object.entries(raw.variants)) {
    const fromSet = currentVariants.get(type) ?? new Set();
    const toSet = targetVariants.get(type) ?? new Set();
    const seen = new Set<string>();
    for (const [from, to] of Object.entries(vmap)) {
      if (!fromSet.has(from)) throw new MigrationError(`rename source variant "${type}.${from}" does not exist`);
      if (!toSet.has(to)) throw new MigrationError(`rename target variant "${type}.${to}" is not in the schema`);
      if (toSet.has(from)) {
        throw new MigrationError(`rename source variant "${type}.${from}" still exists in the schema; it was not removed`);
      }
      if (fromSet.has(to)) {
        throw new MigrationError(`rename target variant "${type}.${to}" already exists; cannot rename onto a live variant`);
      }
      if (taggedVariants.get(type)?.has(to)) {
        throw new MigrationError(`rename target variant "${type}.${to}" is a retired variant; its tag is retired forever`);
      }
      if (seen.has(to)) throw new MigrationError(`two renames target variant "${type}.${to}"`);
      seen.add(to);
    }
  }
}

/**
 * Rewrite table keys, column keys, index/full-text column references, and
 * variant names. Exported for migration generation, which classifies the diff
 * of the renamed-stored snapshot against the target without opening a database.
 */
export function applyRenames(current: SchemaSnapshot, raw: NormalizedRenames): SchemaSnapshot {
  const tables = Object.create(null) as Record<string, TableSnapshot>;
  for (const [name, snap] of Object.entries(current.tables)) tables[name] = structuredClone(snap);
  for (const [oldT, newT] of Object.entries(raw.tables)) {
    const source = ownValue(tables, oldT);
    if (source === undefined) throw new MigrationError(`rename source table "${oldT}" does not exist`);
    tables[newT] = source;
    delete tables[oldT];
  }
  for (const [table, cols] of Object.entries(raw.columns)) {
    const snap = ownValue(tables, table);
    if (snap === undefined) throw new MigrationError(`rename target table "${table}" is not in the schema`);
    const columns = Object.create(null) as Record<string, Descriptor>;
    for (const [col, desc] of Object.entries(snap.columns)) columns[renamedName(cols, col)] = desc;
    snap.columns = columns;
    snap.indexes = snap.indexes.map((ix) => ({ ...ix, columns: ix.columns.map((column) => renamedName(cols, column)) }));
    snap.fullText = snap.fullText
      .map((column) => renamedName(cols, column))
      .sort(compareCodeUnits);
  }
  for (const [type, vmap] of Object.entries(raw.variants)) {
    for (const snap of Object.values(tables)) {
      for (const col of Object.keys(snap.columns)) snap.columns[col] = renameVariants(snap.columns[col]!, type, vmap);
    }
  }
  return { version: 2, tables };
}

/**
 * Rewrite variant names of the named `type` on a TOP-LEVEL column descriptor
 * only (through nullable). A tag relabel is zero-rewrite only where variants
 * are stored as interned tags — the top level; nested enum/union values are
 * wire-encoded STRINGS, so a deep rewrite would erase the diff while stranding
 * stale variant strings the new type cannot validate. Left untouched, a nested
 * use of the renamed type surfaces as an honest type-changed refusal whose
 * transform rewrites the payloads. That is correct behavior, not a limitation.
 */
function renameVariants(desc: Descriptor, type: string, vmap: Record<string, string>): Descriptor {
  if (desc["k"] === "nullable") {
    return { ...desc, inner: renameVariants(desc["inner"] as Descriptor, type, vmap) };
  }
  if (desc["k"] === "enum" && desc["name"] === type) {
    return { ...desc, values: (desc["values"] as string[]).map((variant) => renamedName(vmap, variant)) };
  }
  if (desc["k"] === "union" && desc["name"] === type) {
    const members = Object.create(null) as Record<string, Descriptor>;
    for (const [variant, d] of Object.entries(desc["members"] as Record<string, Descriptor>)) {
      members[renamedName(vmap, variant)] = d; // payload descriptors untouched: nested uses must diff
    }
    return { ...desc, members };
  }
  return desc;
}

/** Collect the variant set of every named enum/union in a snapshot, by type name. */
export function variantSets(snapshot: SchemaSnapshot): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (desc: Descriptor): void => {
    switch (desc["k"]) {
      case "nullable":
        return visit(desc["inner"] as Descriptor);
      case "array":
        return visit(desc["el"] as Descriptor);
      case "object":
        return void Object.values(desc["shape"] as Record<string, Descriptor>).forEach(visit);
      case "enum": {
        const set = out.get(desc["name"] as string) ?? out.set(desc["name"] as string, new Set()).get(desc["name"] as string)!;
        for (const v of desc["values"] as string[]) set.add(v);
        return;
      }
      case "union": {
        const set = out.get(desc["name"] as string) ?? out.set(desc["name"] as string, new Set()).get(desc["name"] as string)!;
        for (const [variant, d] of Object.entries(desc["members"] as Record<string, Descriptor>)) {
          set.add(variant);
          visit(d);
        }
        return;
      }
    }
  };
  for (const table of Object.values(snapshot.tables)) for (const desc of Object.values(table.columns)) visit(desc);
  return out;
}
