/**
 * Schema snapshots: the JSON descriptor of a schema as stored in `_ackerdb_meta`.
 * Reconciliation diffs the stored snapshot against the live schema's
 * descriptor; equality of descriptors means "nothing changed".
 */
import type { Descriptor } from "../validation/v.ts";
import type { Schema } from "./definition.ts";
import { compareCodeUnits } from "../shared/ordering.ts";

export interface TableSnapshot {
  kind: "table" | "event";
  columns: Record<string, Descriptor>;
  indexes: { name: string; columns: string[]; unique: boolean; algorithm: "btree" | "direct" }[];
  fullText: string[];
}

export interface SchemaSnapshot {
  version: 2;
  tables: Record<string, TableSnapshot>;
}

export function snapshotOf(schema: Schema): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = Object.create(null);
  for (const name of Object.keys(schema.tables).sort()) {
    const table = schema.tables[name]!;
    const columns: Record<string, Descriptor> = Object.create(null);
    for (const column of Object.keys(table.columns)) {
      columns[column] = table.columns[column]!.descriptor();
    }
    tables[name] = {
      kind: table.kind,
      columns,
      indexes: [...table.indexes]
        .sort((a, b) => compareCodeUnits(a.name, b.name))
        .map((ix) => ({
          name: ix.name,
          columns: [...ix.columns],
          unique: ix.unique,
          algorithm: ix.algorithm,
        })),
      fullText: [...table.fullTextColumns].sort(compareCodeUnits),
    };
  }
  return { version: 2, tables };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    normalized[key] = canonicalJson((value as Record<string, unknown>)[key]);
  }
  return normalized;
}

/** Stable snapshot encoding independent of declaration order or package instance. */
export function canonicalSnapshotJson(snapshot: SchemaSnapshot): string {
  return JSON.stringify(canonicalJson(snapshot));
}

/** Stable schema identity derived from the same representation persisted for Plugins. */
export function canonicalSchemaSnapshot(schema: Schema): string {
  return canonicalSnapshotJson(snapshotOf(schema));
}
