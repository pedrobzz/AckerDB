/**
 * Schema snapshots: the JSON descriptor of a schema as stored in `_dbz_meta`.
 * Reconciliation diffs the stored snapshot against the live schema's
 * descriptor; equality of descriptors means "nothing changed".
 */
import type { Descriptor } from "./v.ts";
import type { Schema } from "./schema.ts";

export interface TableSnapshot {
  kind: "table" | "event";
  columns: Record<string, Descriptor>;
  indexes: { name: string; columns: string[]; unique: boolean; algorithm: "btree" | "direct" }[];
}

export interface SchemaSnapshot {
  version: 1;
  tables: Record<string, TableSnapshot>;
}

export function snapshotOf(schema: Schema): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = {};
  for (const name of Object.keys(schema.tables).sort()) {
    const table = schema.tables[name]!;
    const columns: Record<string, Descriptor> = {};
    for (const column of Object.keys(table.columns)) {
      columns[column] = table.columns[column]!.descriptor();
    }
    tables[name] = {
      kind: table.kind,
      columns,
      indexes: [...table.indexes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((ix) => ({
          name: ix.name,
          columns: [...ix.columns],
          unique: ix.unique,
          algorithm: ix.algorithm,
        })),
    };
  }
  return { version: 1, tables };
}
