/**
 * Read/write-set keys — the currency of reactivity.
 *
 * A query records, for every ctx.db read, one key describing what it
 * depended on. A mutation records, for every row it writes, the keys that
 * write could have affected. A subscription re-runs iff the two sets
 * intersect. Keys use *storage-form* values (enum variants as their
 * integer tags), so both sides agree by construction.
 *
 *   id:<table>:<pk>                    one row, by primary key
 *   scan:<table>                       any row of the table
 *   ix:<table>:<index>:<eq-prefix>     an index range pinned by an eq prefix
 *   fts:<table>:<target>                one target's global ranking corpus
 *
 * A write to a row emits: its id key, the table's scan key, and one ix key
 * per index per eq-prefix length (a read pinning [a] must see a write to
 * [a, b]). A read with no eq columns depends on the whole table -> scan key.
 * Ranges are covered by the eq-prefix key one level up, at the cost of some
 * over-invalidation (a re-run that finds an identical result is deduped
 * before fan-out, never shipped).
 */
import { stableEncode } from "@ackerdb/core";
import { columnIndexValue, type TablePlan } from "./engine.ts";

export function idKey(table: string, id: bigint): string {
  return `id:${table}:${id}`;
}

export function scanKey(table: string): string {
  return `scan:${table}`;
}

export function ixKey(table: string, index: string, prefixSqlValues: readonly unknown[]): string {
  return `ix:${table}:${index}:${stableEncode(prefixSqlValues)}`;
}

export function ftsCorpusKey(table: string, column: string): string {
  return `fts:${table}:${column}`;
}

/** All keys a write of `row` (full JS row, including pk) can affect. */
export function emitWriteKeys(plan: TablePlan, row: Record<string, unknown>, into: Set<string>): void {
  into.add(idKey(plan.name, row[plan.pk] as bigint));
  into.add(scanKey(plan.name));
  for (const index of plan.indexes) {
    const prefix: unknown[] = [];
    for (const column of index.columns) {
      prefix.push(columnIndexValue(plan.columns.get(column)!, row[column]));
      into.add(ixKey(plan.name, index.name, prefix));
    }
  }
}

/**
 * Global FTS5 BM25 statistics make every row in one target part of that
 * target's ranking corpus. Inserts/deletes always change it; updates do so only
 * when the selected text value actually changes, matching the FTS trigger.
 */
export function emitFullTextWriteKeys(
  plan: TablePlan,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  into: Set<string>,
): void {
  for (const target of plan.fullText) {
    if (
      before === null ||
      after === null ||
      !Object.is(before[target.column], after[target.column])
    ) {
      into.add(ftsCorpusKey(plan.name, target.column));
    }
  }
}
