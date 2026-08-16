/**
 * How framework code addresses a managed table.
 *
 * `makeDbReader` and `makeDbWriter` build the same accessors for every table in
 * the composed schema, application or framework, and hand them out as an
 * untyped record because their shape is derived from a runtime plan. A
 * framework domain knows its own rows, so it declares that shape once here and
 * narrows the record it was given — the same move `ctx.db` makes for an
 * application through generated types.
 *
 * A reader's accessors carry only the read half. `ManagedTable` therefore
 * splits: framework code that reads under a snapshot names `ReadableTable`, and
 * code inside a transaction names `ManagedTable` and gets the writes with it.
 */
import type { QueryPage } from "@ackerdb/core";

export interface ManagedQuery<Row> {
  where(predicate: (row: never) => unknown): ManagedQuery<Row>;
  orderBy(order: (row: never) => unknown): ManagedQuery<Row>;
  thenBy(order: (row: never) => unknown): ManagedQuery<Row>;
  collect(): Promise<Row[]>;
  take(count: number): Promise<Row[]>;
  first(): Promise<Row | null>;
  unique(): Promise<Row | null>;
  count(): Promise<number>;
  sum(column: (row: never) => unknown): Promise<number | bigint>;
  avg(column: (row: never) => unknown): Promise<number | null>;
  min(column: (row: never) => unknown): Promise<unknown | null>;
  max(column: (row: never) => unknown): Promise<unknown | null>;
  iter(): AsyncIterable<Row>;
  paginate(options: { cursor?: string | null; pageSize: number }): Promise<QueryPage<Row>>;
}

export interface ReadableTable<Row extends { readonly id: bigint }> {
  get(id: bigint): Promise<Row | null>;
  query(): ManagedQuery<Row>;
}

export type ManagedInsert<Row extends { readonly id: bigint }> = Omit<Row, "id">;

export interface ManagedTable<Row extends { readonly id: bigint }> extends ReadableTable<Row> {
  insert(row: ManagedInsert<Row>): PromiseLike<Row["id"]>;
  patch(id: bigint, row: Partial<ManagedInsert<Row>>): PromiseLike<void>;
  delete(id: bigint): PromiseLike<void>;
  deleteMany(ids: readonly bigint[]): Promise<number>;
}
