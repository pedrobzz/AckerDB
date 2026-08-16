/**
 * How framework code addresses a managed table, and how it exposes one safely.
 *
 * `makeDbReader` and `makeDbWriter` build the same accessors for every table in
 * the composed schema, application or framework, and hand them out as an
 * untyped record because their shape is derived from a runtime plan. A
 * framework domain knows its own rows, so it declares that shape once here and
 * narrows the record it was given — the same move `ctx.db` makes for an
 * application through generated types.
 *
 * A framework table is private, so what a caller may *see* of it is a
 * projection: rows arrive mapped to a safe descriptor, and predicates, orders
 * and aggregates address a safe row of the domain's own choosing rather than
 * the stored one. {@link mappedTableQuery} is that projection, shared by Files
 * and Credentials, so neither can accidentally hand out a column the other
 * would have hidden.
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

export type ManagedInsert<Row extends { readonly id: bigint }> = Omit<Row, "id">;

/**
 * One table's accessors. A snapshot reader's record carries only the read half,
 * so framework code that reads under one names this type too and simply never
 * reaches for a write — the same shape `makeDbReader` and `makeDbWriter` hand
 * out, narrowed once by the domain that owns the rows.
 */
export interface ManagedTable<Row extends { readonly id: bigint }> {
  get(id: bigint): Promise<Row | null>;
  query(): ManagedQuery<Row>;
  insert(row: ManagedInsert<Row>): PromiseLike<Row["id"]>;
  patch(id: bigint, row: Partial<ManagedInsert<Row>>): PromiseLike<void>;
  delete(id: bigint): PromiseLike<void>;
  deleteMany(ids: readonly bigint[]): Promise<number>;
}

/**
 * What a private table shows: the descriptor its rows become, and the row a
 * caller's callback actually receives.
 *
 * `columns` is the whole boundary. A callback never touches the stored row
 * proxy, so a column the projection omits is unaddressable rather than merely
 * untyped — and a public name may stand for a differently named stored column
 * without the caller ever learning which.
 */
export interface SafeProjection<Row, Descriptor> {
  descriptor(row: Row): Descriptor;
  columns(row: Row): Readonly<Record<string, unknown>>;
}

/** Re-aim one caller callback from the stored row onto the safe one. */
function onSafeRow<Row, Descriptor>(
  projection: SafeProjection<Row, Descriptor>,
  callback: unknown,
): (row: never) => unknown {
  return (row) => (callback as (safe: unknown) => unknown)(projection.columns(row as Row));
}

/** Every read that turns stored rows into descriptors, plus the aggregates. */
function materializers<Row, Descriptor>(
  query: ManagedQuery<Row>,
  projection: SafeProjection<Row, Descriptor>,
): Readonly<Record<string, unknown>> {
  const map = (row: Row): Descriptor => projection.descriptor(row);
  const over = (column: unknown) => onSafeRow(projection, column) as never;
  return {
    collect: async () => (await query.collect()).map(map),
    take: async (count: number) => (await query.take(count)).map(map),
    first: async () => {
      const row = await query.first();
      return row === null ? null : map(row);
    },
    unique: async () => {
      const row = await query.unique();
      return row === null ? null : map(row);
    },
    count: () => query.count(),
    sum: (column: unknown) => query.sum(over(column)),
    avg: (column: unknown) => query.avg(over(column)),
    min: (column: unknown) => query.min(over(column)),
    max: (column: unknown) => query.max(over(column)),
    iter: async function* () {
      for await (const row of query.iter()) yield map(row);
    },
    paginate: async (options: { cursor?: string | null; pageSize: number }) => {
      const page = await query.paginate(options);
      return { items: page.items.map(map), nextCursor: page.nextCursor };
    },
  };
}

/**
 * A safe `TableQuery` over a private table. The caller casts the result to its
 * own declared query type, which is what names the safe columns in types; this
 * is what enforces them at runtime.
 */
export function mappedTableQuery<Row, Descriptor>(
  query: ManagedQuery<Row>,
  projection: SafeProjection<Row, Descriptor>,
): unknown {
  return Object.freeze({
    ...materializers(query, projection),
    where: (predicate: unknown) =>
      mappedTableQuery(query.where(onSafeRow(projection, predicate) as never), projection),
    orderBy: (order: unknown) =>
      mappedOrderedTableQuery(query.orderBy(onSafeRow(projection, order) as never), projection),
  });
}

/** The same surface once an order is declared: `thenBy` replaces `orderBy`. */
export function mappedOrderedTableQuery<Row, Descriptor>(
  query: ManagedQuery<Row>,
  projection: SafeProjection<Row, Descriptor>,
): unknown {
  return Object.freeze({
    ...materializers(query, projection),
    where: (predicate: unknown) =>
      mappedOrderedTableQuery(query.where(onSafeRow(projection, predicate) as never), projection),
    thenBy: (order: unknown) =>
      mappedOrderedTableQuery(query.thenBy(onSafeRow(projection, order) as never), projection),
  });
}

/** Materializers alone, for a read surface that composes no further. */
export function mappedMaterializers<Row, Descriptor>(
  query: ManagedQuery<Row>,
  descriptor: (row: Row) => Descriptor,
): unknown {
  return Object.freeze(materializers(query, {
    descriptor,
    columns: (row) => row as Readonly<Record<string, unknown>>,
  }));
}
