/**
 * Descriptor-driven reads of historical rows. Reconciliation probes and
 * migration transforms share this exact decoder so nested wire values and
 * enum/union tags can never acquire two interpretations of stored data.
 */
import type { Database } from "bun:sqlite";
import { decode } from "@dbzz/core";
import type { Descriptor } from "../v.ts";
import type { TableSnapshot } from "../snapshot.ts";
import { scalarDecoder } from "./descriptor-kinds.ts";

const quote = (name: string) => `"${name}"`;

/** Fixed paging ownership: heap use is bounded independently of table size. */
export const STORED_ROW_BATCH = 1000;

export type StoredRow = Record<string, unknown>;
export type StoredTags = ReadonlyMap<string, ReadonlyMap<number, string>>;

export interface StoredColumn {
  readonly col: string;
  readonly phys: readonly string[];
  readonly present: boolean;
  decode(values: unknown[]): unknown;
}

export interface StoredTable {
  readonly pk: string;
  readonly physicalPk: string;
  readonly columns: readonly StoredColumn[];
}

function baseOf(desc: Descriptor): Descriptor {
  return desc["k"] === "nullable" ? desc["inner"] as Descriptor : desc;
}

/** Physical column names represented by a stored table snapshot. */
export function physicalColumnsOf(table: TableSnapshot): Set<string> {
  return new Set(
    Object.entries(table.columns).flatMap(([column, descriptor]) =>
      baseOf(descriptor)["k"] === "union" ? [column, `${column}__p`] : [column],
    ),
  );
}

/**
 * Every historical (type, variant) -> tag mapping. Tags are insert-only, so
 * this includes types that exist only in an old migration snapshot.
 */
export function loadStoredTags(writer: Database): StoredTags {
  const tags = new Map<string, Map<number, string>>();
  for (const row of writer.query("SELECT type, variant, tag FROM _dbz_tags").all() as {
    type: string;
    variant: string;
    tag: bigint;
  }[]) {
    let map = tags.get(row.type);
    if (map === undefined) {
      map = new Map();
      tags.set(row.type, map);
    }
    map.set(Number(row.tag), row.variant);
  }
  return tags;
}

/** Build one descriptor-owned scalar/enum/union column decoder. */
export function storedColumn(
  col: string,
  desc: Descriptor,
  physicalCols: ReadonlySet<string>,
  tags: StoredTags,
  physicalName: (name: string) => string = (name) => name,
): StoredColumn {
  const base = baseOf(desc);
  const kind = base["k"] as string;
  const logicalPhys = kind === "union" ? [col, `${col}__p`] : [col];
  const phys = logicalPhys.map(physicalName);
  const present = phys.every((name) => physicalCols.has(name));
  if (!present) return { col, phys, present, decode: () => null };
  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      col,
      phys,
      present,
      decode: (values) => values[0] === null
        ? null
        : {
            tag: tags.get(typeName)!.get(Number(values[0]))!,
            value: decode(values[1] as string),
          },
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return {
      col,
      phys,
      present,
      decode: (values) => values[0] === null ? null : tags.get(typeName)!.get(Number(values[0]))!,
    };
  }
  const scalar = scalarDecoder(kind);
  return {
    col,
    phys,
    present,
    decode: (values) => values[0] === null ? null : scalar(values[0]),
  };
}

/**
 * Build a row decoder from one logical snapshot. `physicalName` maps its
 * logical names back to their current on-disk names during a migration rename.
 * `selected` projects probe work to only the tightened columns (plus the pk).
 */
export function buildStoredTable(
  snapshot: TableSnapshot,
  physicalCols: ReadonlySet<string>,
  tags: StoredTags,
  physicalName: (name: string) => string = (name) => name,
  selected?: ReadonlySet<string>,
): StoredTable {
  let pk = "";
  const columns: StoredColumn[] = [];
  for (const [column, desc] of Object.entries(snapshot.columns)) {
    if (desc["k"] === "pk") pk = column;
    if (selected === undefined || selected.has(column) || desc["k"] === "pk") {
      columns.push(storedColumn(column, desc, physicalCols, tags, physicalName));
    }
  }
  return { pk, physicalPk: physicalName(pk), columns };
}

export function decodeStoredRow(table: StoredTable, sqlRow: StoredRow): StoredRow {
  const row = Object.create(null) as StoredRow;
  for (const column of table.columns) {
    row[column.col] = column.decode(column.phys.map((name) => sqlRow[name]));
  }
  return row;
}

/**
 * Page an immutable physical table by primary key. A projection may narrow the
 * selected payload, but the physical pk is always included for pagination.
 */
export function* pageStoredRows(
  writer: Database,
  table: string,
  pk: string,
  projection?: readonly string[],
): IterableIterator<StoredRow> {
  const projected = projection === undefined
    ? "*"
    : [...new Set([pk, ...projection])].map(quote).join(", ");
  let last: bigint | undefined;
  for (;;) {
    const where = last === undefined ? "" : `WHERE ${quote(pk)} > ? `;
    const params = last === undefined ? [] : [last as never];
    const rows = writer
      .query(`SELECT ${projected} FROM ${quote(table)} ${where}ORDER BY ${quote(pk)} ASC LIMIT ${STORED_ROW_BATCH}`)
      .all(...params) as StoredRow[];
    for (const raw of rows) yield raw;
    if (rows.length < STORED_ROW_BATCH) return;
    last = rows[rows.length - 1]![pk] as bigint;
  }
}
