/**
 * The typed surface of `ctx.db`. Pure types — the runtime lives in db.ts.
 *
 * The index query builder is a typed state machine encoding the b-tree's
 * physical rules: equalities follow index column order, at most one range
 * column right after the eq prefix, nothing after the range. Invalid
 * combinations don't compile. An `eq` on a union column narrows the row
 * type to that variant's payload shape.
 */
import type {
  EnumValidator,
  Expand,
  InferValidator,
  NullableValidator,
  ObjectShape,
  UnionMembers,
  UnionValidator,
  Validator,
} from "./v.ts";
import type {
  CamelCase,
  IndexMeta,
  InsertShape,
  PatchShape,
  RowShape,
  Schema,
  SchemaTables,
  TableColumns,
  TableIndexes,
  TableKind,
} from "./schema.ts";

type Head<T extends readonly string[]> = T extends readonly [infer H extends string, ...string[]]
  ? H
  : never;
type Tail<T extends readonly string[]> = T extends readonly [string, ...infer R extends readonly string[]]
  ? R
  : [];

type IsNullable<V> = V extends Validator<unknown, "nullable"> ? true : false;
type BaseValidator<V> = V extends NullableValidator<infer I> ? I : V;

type EqValueOf<V> =
  BaseValidator<V> extends EnumValidator<infer S>
    ? S
    : BaseValidator<V> extends UnionValidator<infer M>
      ? keyof M & string
      : InferValidator<BaseValidator<V>>;

/** The value `.eq(column, value)` accepts: variant names for enum/union columns. */
export type EqValue<C extends ObjectShape, K extends keyof C> = IsNullable<C[K]> extends true
  ? EqValueOf<C[K]> | null
  : EqValueOf<C[K]>;

/** Ranges over enum/union tags are not meaningful; the parameter becomes `never`. */
export type RangeValue<C extends ObjectShape, K extends keyof C> =
  BaseValidator<C[K]> extends EnumValidator<infer _S>
    ? never
    : BaseValidator<C[K]> extends UnionValidator<infer _M>
      ? never
      : InferValidator<BaseValidator<C[K]>>;

/** After eq("union", "variant"), the row type narrows to that variant. */
type NarrowOnEq<C extends ObjectShape, K extends keyof C & string, V, Row> = V extends string
  ? BaseValidator<C[K]> extends UnionValidator<infer _M>
    ? Expand<{ [P in keyof Row]: P extends K ? Extract<Row[P], { tag: V }> : Row[P] }>
    : Row
  : Row;

export interface IndexQbDone<Row> {
  readonly _row?: Row;
}

export interface IndexQb<C extends ObjectShape, R extends readonly string[], Row> {
  /** Phantom anchor for result-row inference. Never set at runtime. */
  readonly _row?: Row;
  eq<K extends Head<R> & keyof C & string, const V extends EqValue<C, K>>(
    column: K,
    value: V,
  ): IndexQb<C, Tail<R>, NarrowOnEq<C, K, V, Row>>;
  gt<K extends Head<R> & keyof C>(column: K, value: RangeValue<C, K>): IndexQbDone<Row>;
  gte<K extends Head<R> & keyof C>(column: K, value: RangeValue<C, K>): IndexQbDone<Row>;
  lt<K extends Head<R> & keyof C>(column: K, value: RangeValue<C, K>): IndexQbDone<Row>;
  lte<K extends Head<R> & keyof C>(column: K, value: RangeValue<C, K>): IndexQbDone<Row>;
  between<K extends Head<R> & keyof C>(
    column: K,
    lo: RangeValue<C, K>,
    hi: RangeValue<C, K>,
  ): IndexQbDone<Row>;
}

export interface Page<Row> {
  page: Row[];
  isDone: boolean;
  continueCursor: string;
}

export interface RangeQuery<Row> {
  order(dir: "asc" | "desc"): RangeQuery<Row>;
  filter(fn: (row: Row) => boolean): RangeQuery<Row>;
  collect(): Promise<Row[]>;
  take(n: number): Promise<Row[]>;
  first(): Promise<Row | null>;
  unique(): Promise<Row | null>;
  count(): Promise<number>;
  iter(): AsyncIterable<Row>;
  paginate(opts: { cursor: string | null; numItems: number }): Promise<Page<Row>>;
}

/**
 * A write's result: awaits to the primary value (the new id for insert and
 * upsert, void otherwise) and `.returning()` resolves to the full written
 * row — free, the write already computed it. Delete returns the removed
 * row, or null when the delete was an idempotent no-op.
 */
export interface WriteResult<T, Row> extends PromiseLike<T> {
  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B>;
  finally(onfinally?: (() => void) | null): Promise<T>;
  returning(): Promise<Row>;
}

type QbResult = { readonly _row?: unknown };
type QbRow<T> = T extends { readonly _row?: infer Row } ? Row : never;

export type IndexAccessor<C extends ObjectShape, Cols extends readonly string[], Row> = <
  T extends QbResult,
>(
  fn: (q: IndexQb<C, Cols, Row>) => T,
) => RangeQuery<QbRow<T>>;

type UpsertValues<C extends ObjectShape, Cols extends readonly string[]> = Omit<
  InsertShape<C>,
  Cols[number]
>;

export interface Upsert<C extends ObjectShape, Cols extends readonly string[]> {
  upsert(
    key: { [K in Cols[number] & keyof C]: EqValue<C, K> },
    values: UpsertValues<C, Cols> | ((existing: RowShape<C> | null) => UpsertValues<C, Cols>),
  ): WriteResult<bigint, RowShape<C>>;
}

type ReaderIndexes<C extends ObjectShape, I> = {
  [N in keyof I as CamelCase<N & string>]: I[N] extends IndexMeta
    ? IndexAccessor<C, I[N]["columns"], RowShape<C>>
    : never;
};

type WriterIndexes<C extends ObjectShape, I> = {
  [N in keyof I as CamelCase<N & string>]: I[N] extends IndexMeta
    ? I[N]["unique"] extends true
      ? IndexAccessor<C, I[N]["columns"], RowShape<C>> & Upsert<C, I[N]["columns"]>
      : IndexAccessor<C, I[N]["columns"], RowShape<C>>
    : never;
};

export type TableReader<TD> = TableReaderOf<TableColumns<TD>, TableIndexes<TD>>;
type TableReaderOf<C extends ObjectShape, I> = {
  get(id: bigint): Promise<RowShape<C> | null>;
  scan(): RangeQuery<RowShape<C>>;
} & ReaderIndexes<C, I>;

export type TableWriter<TD> = TableWriterOf<TableColumns<TD>, TableIndexes<TD>>;
type TableWriterOf<C extends ObjectShape, I> = {
  get(id: bigint): Promise<RowShape<C> | null>;
  scan(): RangeQuery<RowShape<C>>;
  insert(row: InsertShape<C>): WriteResult<bigint, RowShape<C>>;
  patch(id: bigint, partial: PatchShape<C>): WriteResult<void, RowShape<C>>;
  replace(id: bigint, row: InsertShape<C>): WriteResult<void, RowShape<C>>;
  delete(id: bigint): WriteResult<void, RowShape<C> | null>;
  /** Delete at most 256 distinct rows in one database statement. */
  deleteMany(ids: readonly bigint[]): Promise<number>;
} & WriterIndexes<C, I>;

export interface EventWriter<C extends ObjectShape> {
  insert(row: InsertShape<C>): Promise<void>;
}

/** Read-only ctx.db (queries). Event tables don't appear — nothing to read. */
export type DbReader<S extends Schema> = {
  [T in keyof SchemaTables<S> as TableKind<SchemaTables<S>[T]> extends "event"
    ? never
    : T]: TableReader<SchemaTables<S>[T]>;
};

/** Read-write ctx.db (mutations / procedure transactions). */
export type DbWriter<S extends Schema> = {
  [T in keyof SchemaTables<S>]: TableKind<SchemaTables<S>[T]> extends "event"
    ? EventWriter<TableColumns<SchemaTables<S>[T]>>
    : TableWriter<SchemaTables<S>[T]>;
};
