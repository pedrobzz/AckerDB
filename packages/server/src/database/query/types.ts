/** Public, planner-independent `ctx.db` query and table types. */
import type {
  Expand,
  InferValidator,
  NullableValidator,
  Validator,
} from "../../validation/validator.ts";
import type {
  EnumValidator,
  ObjectShape,
  UnionMembers,
  UnionValidator,
} from "../../validation/composites.ts";
import type {
  IndexMeta,
  InsertShape,
  PatchShape,
  RowShape,
  Schema,
  SchemaTables,
  TableColumns,
  TableFullTextColumns,
  TableIndexes,
  TableKind,
} from "../../schema/definition.ts";

type BaseValidator<V> = V extends NullableValidator<infer Inner> ? Inner : V;
type IsNullable<V> = V extends Validator<unknown, "nullable"> ? true : false;

type ComparableValue<V> = BaseValidator<V> extends EnumValidator<infer Variant>
  ? Variant
  : InferValidator<BaseValidator<V>>;

type NarrowUnionColumn<Row, K extends keyof Row, Variant extends string> = Expand<{
  [P in keyof Row]: P extends K ? Extract<Row[P], { tag: Variant }> : Row[P];
}>;

declare const PREDICATE_EXPRESSION: unique symbol;
declare const ORDER_EXPRESSION: unique symbol;
declare const UNSUPPORTED_COLUMN: unique symbol;
declare const SUMMABLE_COLUMN: unique symbol;
declare const MINMAX_COLUMN: unique symbol;

/** Phantom capability of numeric columns (int, float, bigint): accepted by `sum()`/`avg()`. */
export interface SummableColumn<Value> {
  readonly [SUMMABLE_COLUMN]: Value;
}

/** Phantom capability of ordered columns (the `lt`/`gt` set): accepted by `min()`/`max()`. */
export interface MinMaxColumn<Value> {
  readonly [MINMAX_COLUMN]: Value;
}

/** A SQL predicate. Its row phantom carries only sound positive narrowing. */
export interface PredicateExpression<NarrowRow, BaseRow = NarrowRow> {
  readonly [PREDICATE_EXPRESSION]: {
    readonly narrowRow: NarrowRow;
    readonly baseRow: BaseRow;
  };
  and<Other>(
    other: PredicateExpression<Other, BaseRow>,
  ): PredicateExpression<NarrowRow & Other, BaseRow>;
  or<Other>(
    other: PredicateExpression<Other, BaseRow>,
  ): PredicateExpression<NarrowRow | Other, BaseRow>;
  not(): PredicateExpression<BaseRow, BaseRow>;
}

export interface OrderExpression {
  readonly [ORDER_EXPRESSION]: true;
}

interface UnsupportedColumn {
  readonly [UNSUPPORTED_COLUMN]: true;
}

interface OrderableColumn {
  asc(): OrderExpression;
  desc(): OrderExpression;
}

interface EquatableColumn<Value, Row> {
  eq(value: Value): PredicateExpression<Row>;
  ne(value: Value): PredicateExpression<Row>;
  in(values: readonly Value[]): PredicateExpression<Row>;
}

interface ComparableColumn<Value, Row> extends EquatableColumn<Value, Row>, OrderableColumn {}

interface OrderedColumn<Value, Row> extends ComparableColumn<Value, Row> {
  lt(value: Value): PredicateExpression<Row>;
  lte(value: Value): PredicateExpression<Row>;
  gt(value: Value): PredicateExpression<Row>;
  gte(value: Value): PredicateExpression<Row>;
  between(lower: Value, upper: Value): PredicateExpression<Row>;
}

interface NullableColumn<Row> {
  isNull(): PredicateExpression<Row>;
  isNotNull(): PredicateExpression<Row>;
}

type UnionColumn<
  Members extends UnionMembers,
  Row,
  Key extends keyof Row,
> = {
  is<const Variant extends keyof Members & string>(
    variant: Variant,
  ): PredicateExpression<NarrowUnionColumn<Row, Key, Variant>, Row>;
};

type ScalarColumn<V, Row, Key extends keyof Row> =
  BaseValidator<V> extends UnionValidator<infer Members>
    ? UnionColumn<Members, Row, Key>
    : BaseValidator<V> extends Validator<unknown, infer Kind>
      ? Kind extends "string" | "int" | "float" | "bigint" | "identity" | "pk" | "scheduleAt"
        ? OrderedColumn<ComparableValue<V>, Row> &
            MinMaxColumn<ComparableValue<V>> &
            (Kind extends "int" | "float" | "bigint"
              ? SummableColumn<ComparableValue<V>>
              : object)
        : Kind extends "boolean"
          ? ComparableColumn<ComparableValue<V>, Row>
          : Kind extends "enum"
            ? EquatableColumn<ComparableValue<V>, Row>
            : never
      : never;

type ColumnReference<V, Row, Key extends keyof Row> = ScalarColumn<V, Row, Key> extends infer Ref
  ? [Ref] extends [never]
    ? IsNullable<V> extends true
      ? NullableColumn<Row>
      : UnsupportedColumn
    : Ref & (IsNullable<V> extends true ? NullableColumn<Row> : object)
  : never;

/** Immutable typed SQL-column references passed to `.where` and ordering callbacks. */
export type QueryRow<C extends ObjectShape, Row = RowShape<C>> = {
  readonly [K in keyof C]: ColumnReference<C[K], Row, K & keyof Row>;
};

type NarrowedRow<Expression> = Expression extends PredicateExpression<infer Row, unknown>
  ? Row
  : never;

export interface QueryPage<Row> {
  readonly items: Row[];
  readonly nextCursor: string | null;
}

export interface QueryMaterializers<Row> {
  collect(): Promise<Row[]>;
  take(count: number): Promise<Row[]>;
  first(): Promise<Row | null>;
  unique(): Promise<Row | null>;
  count(): Promise<number>;
  iter(): AsyncIterable<Row>;
  paginate(options: { cursor?: string | null; pageSize: number }): Promise<QueryPage<Row>>;
}

/**
 * Scalar SQL aggregates over the filtered set. Ordering is ignored, NULLs are
 * skipped per SQL semantics, and an empty set yields `sum` 0/0n and `null`
 * elsewhere. An `int` sum whose exact value exceeds `Number.MAX_SAFE_INTEGER`
 * throws instead of losing precision.
 */
export interface AggregateMaterializers<C extends ObjectShape> {
  sum<Value extends number | bigint>(
    column: (row: QueryRow<C>) => SummableColumn<Value>,
  ): Promise<Value>;
  avg(column: (row: QueryRow<C>) => SummableColumn<number | bigint>): Promise<number | null>;
  min<Value>(column: (row: QueryRow<C>) => MinMaxColumn<Value>): Promise<Value | null>;
  max<Value>(column: (row: QueryRow<C>) => MinMaxColumn<Value>): Promise<Value | null>;
}

export interface TableQuery<C extends ObjectShape, Row = RowShape<C>>
  extends QueryMaterializers<Row>, AggregateMaterializers<C> {
  where<Expression extends PredicateExpression<unknown, RowShape<C>>>(
    predicate: (row: QueryRow<C>) => Expression,
  ): TableQuery<C, Row & NarrowedRow<Expression>>;
  orderBy(order: (row: QueryRow<C>) => OrderExpression): OrderedTableQuery<C, Row>;
}

export interface OrderedTableQuery<C extends ObjectShape, Row = RowShape<C>>
  extends QueryMaterializers<Row>, AggregateMaterializers<C> {
  where<Expression extends PredicateExpression<unknown, RowShape<C>>>(
    predicate: (row: QueryRow<C>) => Expression,
  ): OrderedTableQuery<C, Row & NarrowedRow<Expression>>;
  thenBy(order: (row: QueryRow<C>) => OrderExpression): OrderedTableQuery<C, Row>;
}

export type VectorMetric = "cosine" | "l2" | "dot";

export interface NearestMatch<Row> {
  readonly row: Row;
  readonly distance: number;
}

export interface NearestQuery<C extends ObjectShape, Row = RowShape<C>> {
  where<Expression extends PredicateExpression<unknown, RowShape<C>>>(
    predicate: (row: QueryRow<C>) => Expression,
  ): NearestQuery<C, Row & NarrowedRow<Expression>>;
  take(count: number): Promise<Array<NearestMatch<Row>>>;
  first(): Promise<NearestMatch<Row> | null>;
}

export interface FullTextQuery<C extends ObjectShape, Row = RowShape<C>> {
  where<Expression extends PredicateExpression<unknown, RowShape<C>>>(
    predicate: (row: QueryRow<C>) => Expression,
  ): FullTextQuery<C, Row & NarrowedRow<Expression>>;
  take(count: number): Promise<Row[]>;
  first(): Promise<Row | null>;
}

type VectorColumnKeys<C extends ObjectShape> = {
  [K in keyof C]: BaseValidator<C[K]> extends Validator<readonly number[], "vector">
    ? K
    : never;
}[keyof C];

type NearestAccessor<C extends ObjectShape> = [VectorColumnKeys<C>] extends [never]
  ? object
  : {
      nearest<Column extends VectorColumnKeys<C>>(
        column: Column,
        query: readonly number[],
        options: { readonly metric: VectorMetric },
      ): NearestQuery<C>;
    };

type FullTextColumnKeys<Table> = TableFullTextColumns<Table>[number] & string;

type FullTextAccessor<Table, C extends ObjectShape> = [FullTextColumnKeys<Table>] extends [never]
  ? object
  : {
      fullText<Column extends FullTextColumnKeys<Table>>(
        column: Column,
        query: string,
      ): FullTextQuery<C>;
    };

/**
 * A write's primary result is awaitable; `.returning()` selects the full row
 * already computed by the write path.
 */
export interface WriteResult<T, Row> extends PromiseLike<T> {
  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B>;
  finally(onfinally?: (() => void) | null): Promise<T>;
  returning(): Promise<Row>;
}

type TupleColumns<Index> = Index extends { readonly columns: infer Columns extends readonly string[] }
  ? Columns
  : never;

type ContainsNullable<C extends ObjectShape, Columns extends readonly string[]> = true extends {
  [K in Columns[number] & keyof C]: IsNullable<C[K]>;
}[Columns[number] & keyof C]
  ? true
  : false;

type ExactUpsertKey<C extends ObjectShape, Columns extends readonly string[]> = Expand<
  { [K in Columns[number] & keyof C]: InferValidator<C[K]> } &
    { [K in Exclude<keyof C, Columns[number]>]?: never }
>;

type UpsertValues<C extends ObjectShape, Columns extends readonly string[]> = Expand<
  Omit<InsertShape<C>, Columns[number]> &
    { [K in Columns[number] & keyof C]?: never }
>;

type UpsertCall<C extends ObjectShape, Index> = Index extends {
  readonly unique: true;
  readonly columns: readonly string[];
}
  ? ContainsNullable<C, TupleColumns<Index>> extends true
    ? never
    : (
        key: ExactUpsertKey<C, TupleColumns<Index>>,
        values:
          | UpsertValues<C, TupleColumns<Index>>
          | ((existing: RowShape<C> | null) => UpsertValues<C, TupleColumns<Index>>),
      ) => WriteResult<bigint, RowShape<C>>
  : never;

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type UpsertCalls<C extends ObjectShape, Indexes extends readonly IndexMeta[]> = UpsertCall<
  C,
  Indexes[number]
>;

type StructuralUpsert<C extends ObjectShape, Indexes extends readonly IndexMeta[]> = [
  UpsertCalls<C, Indexes>,
] extends [never]
  ? object
  : { upsert: UnionToIntersection<UpsertCalls<C, Indexes>> };

export type TableReader<Table> = TableReaderOf<Table, TableColumns<Table>>;
type TableReaderOf<Table, C extends ObjectShape> = {
  get(id: bigint): Promise<RowShape<C> | null>;
  query(): TableQuery<C>;
} & NearestAccessor<C> & FullTextAccessor<Table, C>;

export type TableWriter<Table> = TableWriterOf<
  Table,
  TableColumns<Table>,
  TableIndexes<Table>
>;
type TableWriterOf<
  Table,
  C extends ObjectShape,
  Indexes extends readonly IndexMeta[],
> = {
  get(id: bigint): Promise<RowShape<C> | null>;
  query(): TableQuery<C>;
  insert(row: InsertShape<C>): WriteResult<bigint, RowShape<C>>;
  patch(id: bigint, partial: PatchShape<C>): WriteResult<void, RowShape<C>>;
  replace(id: bigint, row: InsertShape<C>): WriteResult<void, RowShape<C>>;
  delete(id: bigint): WriteResult<void, RowShape<C> | null>;
  /** Delete at most 256 distinct rows in one database statement. */
  deleteMany(ids: readonly bigint[]): Promise<number>;
} & StructuralUpsert<C, Indexes> & NearestAccessor<C> & FullTextAccessor<Table, C>;

export interface EventWriter<C extends ObjectShape> {
  insert(row: InsertShape<C>): Promise<void>;
}

/** Read-only ctx.db (queries). Event tables do not persist rows. */
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
