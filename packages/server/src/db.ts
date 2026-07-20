/**
 * The runtime behind `ctx.db`: compiles index-range reads to SQL, applies
 * the write methods, and records read/write sets for reactivity. The typed
 * surface lives in dbtypes.ts; this file is deliberately untyped inside —
 * the generics at the function-constructor boundary keep users honest.
 */
import type { Database } from "bun:sqlite";
import { ValidationError, type Validator } from "./v.ts";
import type { ColumnPlan, Engine, TablePlan } from "./engine.ts";
import { brand, hasBrand } from "./identity.ts";
import { camelCase, type IndexDef } from "./schema.ts";
import { emitWriteKeys, idKey, ixKey, scanKey } from "./keys.ts";

const UNIQUE_CONSTRAINT_ERROR_IDENTITY = Symbol.for("@dbzz/server/UniqueConstraintError/v1");

export class UniqueConstraintError extends Error {
  constructor(message?: string) {
    super(message);
    brand(this, UNIQUE_CONSTRAINT_ERROR_IDENTITY);
  }
}

export function isUniqueConstraintError(value: unknown): value is UniqueConstraintError {
  return hasBrand(value, UNIQUE_CONSTRAINT_ERROR_IDENTITY);
}

export interface ReadRecorder {
  add(key: string): void;
}

export interface EventEmit {
  table: string;
  row: Record<string, unknown>;
}

export interface WriteCollector {
  keys: Set<string>;
  events: EventEmit[];
  /** True when a scheduled table was written — the scheduler re-arms. */
  scheduledTouched: boolean;
}

export interface DbStatementObservation {
  readonly kind: "read" | "write";
  readonly table: string;
  readonly statement: string;
  readonly outcome: "ok" | "failed";
  readonly durationMs: number;
  readonly rowCount?: number;
}

export type DbStatementObserver = (
  observation: Readonly<DbStatementObservation>,
) => unknown;

function deliverObservation(
  observer: DbStatementObserver | undefined,
  observation: DbStatementObservation,
): void {
  if (observer === undefined) return;
  try {
    const result = observer(Object.freeze(observation));
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Statement telemetry is diagnostic and never owns application work.
  }
}

function observeStatement<T>(
  observer: DbStatementObserver | undefined,
  kind: DbStatementObservation["kind"],
  table: string,
  statement: string,
  work: () => T | Promise<T>,
  rowCount: (value: T) => number | undefined,
): T | Promise<T> {
  if (observer === undefined) return work();
  const startedAt = performance.now();
  try {
    const result = work();
    if (result && typeof (result as PromiseLike<T>).then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          deliverObservation(observer, {
            kind,
            table,
            statement,
            outcome: "ok",
            durationMs: Math.max(0, performance.now() - startedAt),
            rowCount: rowCount(value),
          });
          return value;
        },
        (error) => {
          deliverObservation(observer, {
            kind,
            table,
            statement,
            outcome: "failed",
            durationMs: Math.max(0, performance.now() - startedAt),
          });
          throw error;
        },
      );
    }
    deliverObservation(observer, {
      kind,
      table,
      statement,
      outcome: "ok",
      durationMs: Math.max(0, performance.now() - startedAt),
      rowCount: rowCount(result as T),
    });
    return result;
  } catch (error) {
    deliverObservation(observer, {
      kind,
      table,
      statement,
      outcome: "failed",
      durationMs: Math.max(0, performance.now() - startedAt),
    });
    throw error;
  }
}

interface RangeSpec {
  column: string;
  lo?: { sql: unknown; inclusive: boolean };
  hi?: { sql: unknown; inclusive: boolean };
}

interface QuerySpec {
  plan: TablePlan;
  index: IndexDef | null; // null = scan
  eqs: { column: string; sql: unknown }[];
  range: RangeSpec | null;
  order: "asc" | "desc";
  filters: ((row: Record<string, unknown>) => boolean)[];
}

interface PaginationOptions {
  readonly cursor: string | null;
  readonly numItems: number;
}

interface PaginationResult {
  readonly page: Record<string, unknown>[];
  readonly isDone: boolean;
  readonly continueCursor: string;
}

const quote = (name: string) => `"${name}"`;

function unwrapBase(validator: Validator<unknown, string>): Validator<unknown, string> {
  return validator.kind === "nullable"
    ? (validator as unknown as { inner: Validator<unknown, string> }).inner
    : validator;
}

/**
 * Convert a query value (variant name for enum/union, JS scalar otherwise)
 * to its storage form, validating it against the column on the way.
 */
function toSqlKey(engine: Engine, plan: TablePlan, column: string, value: unknown): unknown {
  const columnPlan = plan.columns.get(column)!;
  if (value === null) {
    if (!columnPlan.nullable) {
      throw new ValidationError(`${plan.name}.${column}: column is not nullable`);
    }
    return null;
  }
  if (columnPlan.kind === "enum" || columnPlan.kind === "union") {
    const tags = engine.tags.get(columnPlan.typeName!)!;
    if (typeof value !== "string" || !tags.toTag.has(value)) {
      throw new ValidationError(
        `${plan.name}.${column}: unknown ${columnPlan.typeName} variant ${JSON.stringify(value)}`,
      );
    }
    return tags.toTag.get(value)!;
  }
  const table = engine.schema.tables[plan.name]!;
  const base = unwrapBase(table.columns[column]!);
  return columnPlan.toSql(base.check(value, `${plan.name}.${column}`))[0];
}

// ---------------------------------------------------------------------------
// Index query builder (runtime state machine mirroring the typed rules).

class IndexQb {
  readonly eqs: { column: string; sql: unknown }[] = [];
  range: RangeSpec | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly plan: TablePlan,
    private readonly index: IndexDef,
  ) {}

  private nextColumn(method: string, column: string): string {
    if (this.range !== null) {
      throw new ValidationError(
        `${this.plan.name}.${this.index.name}: nothing can follow the range column`,
      );
    }
    const expected = this.index.columns[this.eqs.length];
    if (expected === undefined) {
      throw new ValidationError(
        `${this.plan.name}.${this.index.name}: all index columns are already pinned`,
      );
    }
    if (column !== expected) {
      throw new ValidationError(
        `${this.plan.name}.${this.index.name}: .${method}("${column}") — expected column "${expected}" (equalities follow index column order)`,
      );
    }
    return column;
  }

  eq(column: string, value: unknown): this {
    this.nextColumn("eq", column);
    this.eqs.push({ column, sql: toSqlKey(this.engine, this.plan, column, value) });
    return this;
  }

  private rangeOn(method: string, column: string): RangeSpec {
    this.nextColumn(method, column);
    const columnPlan = this.plan.columns.get(column)!;
    if (columnPlan.kind === "enum" || columnPlan.kind === "union") {
      throw new ValidationError(
        `${this.plan.name}.${column}: range queries on ${columnPlan.kind} tags are not meaningful — use eq`,
      );
    }
    this.range = { column };
    return this.range;
  }

  gt(column: string, value: unknown): this {
    this.rangeOn("gt", column).lo = { sql: toSqlKey(this.engine, this.plan, column, value), inclusive: false };
    return this;
  }
  gte(column: string, value: unknown): this {
    this.rangeOn("gte", column).lo = { sql: toSqlKey(this.engine, this.plan, column, value), inclusive: true };
    return this;
  }
  lt(column: string, value: unknown): this {
    this.rangeOn("lt", column).hi = { sql: toSqlKey(this.engine, this.plan, column, value), inclusive: false };
    return this;
  }
  lte(column: string, value: unknown): this {
    this.rangeOn("lte", column).hi = { sql: toSqlKey(this.engine, this.plan, column, value), inclusive: true };
    return this;
  }
  between(column: string, lo: unknown, hi: unknown): this {
    const range = this.rangeOn("between", column);
    range.lo = { sql: toSqlKey(this.engine, this.plan, column, lo), inclusive: true };
    range.hi = { sql: toSqlKey(this.engine, this.plan, column, hi), inclusive: true };
    return this;
  }
}

// ---------------------------------------------------------------------------
// Range query: materializers over a compiled spec.

class RangeQueryImpl {
  constructor(
    private readonly engine: Engine,
    private readonly conn: Database,
    private readonly reads: ReadRecorder | null,
    private readonly spec: QuerySpec,
    private readonly observer?: DbStatementObserver,
  ) {}

  private recordRead(): void {
    if (this.reads === null) return;
    const { plan, index, eqs } = this.spec;
    if (index === null || eqs.length === 0) {
      this.reads.add(scanKey(plan.name));
    } else {
      this.reads.add(ixKey(plan.name, index.name, eqs.map((eq) => eq.sql)));
    }
  }

  private whereAndParams(): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const eq of this.spec.eqs) {
      if (eq.sql === null) {
        clauses.push(`${quote(eq.column)} IS NULL`);
      } else {
        clauses.push(`${quote(eq.column)} = ?`);
        params.push(eq.sql);
      }
    }
    const range = this.spec.range;
    if (range !== null) {
      if (range.lo !== undefined) {
        clauses.push(`${quote(range.column)} ${range.lo.inclusive ? ">=" : ">"} ?`);
        params.push(range.lo.sql);
      }
      if (range.hi !== undefined) {
        clauses.push(`${quote(range.column)} ${range.hi.inclusive ? "<=" : "<"} ?`);
        params.push(range.hi.sql);
      }
    }
    return { where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  private orderBy(): string {
    const dir = this.spec.order === "asc" ? "ASC" : "DESC";
    const cols = this.spec.index === null ? [] : [...this.spec.index.columns];
    cols.push(this.spec.plan.pk);
    const table = quote(this.spec.plan.name);
    return ` ORDER BY ${cols.map((column) => `${table}.${quote(column)} ${dir}`).join(", ")}`;
  }

  private sqlFor(extraWhere: string, limit: number): { sql: string; params: unknown[] } {
    const { where, params } = this.whereAndParams();
    const glue = extraWhere === "" ? "" : where === "" ? ` WHERE ${extraWhere}` : ` AND ${extraWhere}`;
    const sql = `SELECT ${this.spec.plan.readProjection} FROM ${quote(this.spec.plan.name)}${where}${glue}${this.orderBy()}${limit >= 0 ? ` LIMIT ${limit}` : ""}`;
    return { sql, params };
  }

  /**
   * Fetch up to `limit` rows (-1 = all) after JS filters.
   *
   * Filter-less reads use the cached statement and materialize (`.all()` with
   * LIMIT pushed down) — no live cursor survives, so reads nested inside a
   * caller's loop can never collide with it. Filtered reads and `.iter()`
   * stream on a *fresh* prepared statement (finalized when done) because a
   * JS filter or consumer can run arbitrary nested reads mid-iteration —
   * with the shared cached statement those would reset each other's cursor.
   */
  private *rows(
    limit = -1,
    extraWhere = "",
    extraParams: unknown[] = [],
    forceStream = false,
  ): Generator<Record<string, unknown>> {
    this.recordRead();
    const { plan, filters } = this.spec;
    const pushDown = filters.length === 0 ? limit : -1;
    const { sql, params } = this.sqlFor(extraWhere, pushDown);
    const bind = [...params, ...extraParams] as never[];
    if (filters.length === 0 && !forceStream) {
      const raws = this.engine.statement(this.conn, sql).all(...bind) as Record<string, unknown>[];
      for (const raw of raws) yield this.engine.rowFromSql(plan, raw);
      return;
    }
    const stmt = this.conn.prepare(sql);
    try {
      let yielded = 0;
      outer: for (const raw of stmt.iterate(...bind)) {
        const row = this.engine.rowFromSql(plan, raw as Record<string, unknown>);
        for (const filter of filters) if (!filter(row)) continue outer;
        yield row;
        if (limit >= 0 && ++yielded >= limit) return;
      }
    } finally {
      stmt.finalize();
    }
  }

  private takeSync(n: number): Record<string, unknown>[] {
    return [...this.rows(n)];
  }

  private uniqueSync(): Record<string, unknown> | null {
    const rows = this.takeSync(2);
    if (rows.length > 1) {
      throw new Error(`${this.spec.plan.name}: .unique() matched more than one row`);
    }
    return rows[0] ?? null;
  }

  private countSync(): number {
    if (this.spec.filters.length > 0) {
      let count = 0;
      for (const _ of this.rows()) count++;
      return count;
    }
    this.recordRead();
    const { where, params } = this.whereAndParams();
    const sql = `SELECT COUNT(*) AS n FROM ${quote(this.spec.plan.name)}${where}`;
    const row = this.engine.statement(this.conn, sql).get(...(params as never[])) as { n: bigint };
    return Number(row.n);
  }

  private observeRead<T>(
    statement: string,
    work: () => T | Promise<T>,
    rowCount: (value: T) => number | undefined,
  ): T | Promise<T> {
    return observeStatement(
      this.observer,
      "read",
      this.spec.plan.name,
      statement,
      work,
      rowCount,
    );
  }

  order(dir: "asc" | "desc"): RangeQueryImpl {
    return new RangeQueryImpl(
      this.engine,
      this.conn,
      this.reads,
      { ...this.spec, order: dir },
      this.observer,
    );
  }

  filter(fn: (row: Record<string, unknown>) => boolean): RangeQueryImpl {
    return new RangeQueryImpl(
      this.engine,
      this.conn,
      this.reads,
      {
        ...this.spec,
        filters: [...this.spec.filters, fn],
      },
      this.observer,
    );
  }

  async collect(): Promise<Record<string, unknown>[]> {
    if (this.observer === undefined) return [...this.rows()];
    return this.observeRead("collect", () => [...this.rows()], (rows) => rows.length);
  }

  async take(n: number): Promise<Record<string, unknown>[]> {
    if (this.observer === undefined) return this.takeSync(n);
    return this.observeRead("take", () => this.takeSync(n), (rows) => rows.length);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.observer === undefined) return this.takeSync(1)[0] ?? null;
    return this.observeRead(
      "first",
      () => this.takeSync(1)[0] ?? null,
      (row) => row === null ? 0 : 1,
    );
  }

  async unique(): Promise<Record<string, unknown> | null> {
    if (this.observer === undefined) return this.uniqueSync();
    return this.observeRead(
      "unique",
      () => this.uniqueSync(),
      (row) => row === null ? 0 : 1,
    );
  }

  async count(): Promise<number> {
    if (this.observer === undefined) return this.countSync();
    return this.observeRead(
      "count",
      () => this.countSync(),
      (count) => count,
    );
  }

  async *iter(): AsyncGenerator<Record<string, unknown>> {
    if (this.observer === undefined) {
      yield* this.rows(-1, "", [], true);
      return;
    }
    const startedAt = performance.now();
    let rowCount = 0;
    let failed = false;
    try {
      for (const row of this.rows(-1, "", [], true)) {
        rowCount++;
        yield row;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      deliverObservation(this.observer, {
        kind: "read",
        table: this.spec.plan.name,
        statement: "iter",
        outcome: failed ? "failed" : "ok",
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(failed ? {} : { rowCount }),
      });
    }
  }

  private paginateSync(opts: PaginationOptions): PaginationResult {
    const { plan, index } = this.spec;
    const cursorCols = index === null ? [plan.pk] : [...index.columns, plan.pk];
    let extraWhere = "";
    let extraParams: unknown[] = [];
    if (opts.cursor !== null) {
      const values = JSON.parse(opts.cursor) as (string | number | null | { $: string; v: string })[];
      const sqlValues = values.map((v) =>
        v !== null && typeof v === "object" ? BigInt((v as { v: string }).v) : v,
      );
      const built = cursorComparison(cursorCols, sqlValues, this.spec.order);
      extraWhere = built.sql;
      extraParams = built.params;
    }
    const page: Record<string, unknown>[] = [];
    let isDone = true;
    for (const row of this.rows(opts.numItems + 1, extraWhere, extraParams)) {
      if (page.length === opts.numItems) {
        isDone = false;
        break;
      }
      page.push(row);
    }
    const last = page[page.length - 1];
    const continueCursor = last === undefined
      ? (opts.cursor ?? "[]")
      : JSON.stringify(
          cursorCols.map((column) => {
            const sql = plan.columns.get(column)!.toSql(last[column])[0];
            return typeof sql === "bigint" ? { $: "b", v: sql.toString() } : sql;
          }),
        );
    return { page, isDone, continueCursor };
  }

  async paginate(opts: PaginationOptions): Promise<PaginationResult> {
    if (this.observer === undefined) return this.paginateSync(opts);
    return this.observeRead(
      "paginate",
      () => this.paginateSync(opts),
      (result) => result.page.length,
    );
  }
}

/**
 * Lexicographic "strictly after the cursor position" comparison, matching
 * SQLite's ordering (ASC: NULLs first; DESC: NULLs last). The final column
 * is the primary key and never NULL.
 */
function cursorComparison(
  columns: string[],
  values: unknown[],
  order: "asc" | "desc",
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const build = (i: number): string => {
    const column = quote(columns[i]!);
    const value = values[i];
    const last = i === columns.length - 1;
    if (order === "asc") {
      if (value === null) {
        return last ? "0" : `(${column} IS NOT NULL OR (${column} IS NULL AND ${build(i + 1)}))`;
      }
      params.push(value);
      if (last) return `${column} > ?`;
      params.push(value);
      return `(${column} > ? OR (${column} = ? AND ${build(i + 1)}))`;
    }
    if (value === null) {
      return last ? "0" : `(${column} IS NULL AND ${build(i + 1)})`;
    }
    params.push(value);
    if (last) return `${column} < ?`;
    params.push(value);
    return `(${column} < ? OR ${column} IS NULL OR (${column} = ? AND ${build(i + 1)}))`;
  };
  // params are pushed in visit order, which matches "?" order left-to-right
  const sql = build(0);
  return { sql: `(${sql})`, params };
}

// ---------------------------------------------------------------------------
// Table accessors.

function wrapUnique(table: string, error: unknown): never {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    throw new UniqueConstraintError(`${table}: ${error.message}`);
  }
  throw error;
}

function makeRangeQuery(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  plan: TablePlan,
  index: IndexDef | null,
  qb: IndexQb | null,
  observer?: DbStatementObserver,
): RangeQueryImpl {
  return new RangeQueryImpl(
    engine,
    conn,
    reads,
    {
      plan,
      index,
      eqs: qb?.eqs ?? [],
      range: qb?.range ?? null,
      order: "asc",
      filters: [],
    },
    observer,
  );
}

function readMethods(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  plan: TablePlan,
  observer?: DbStatementObserver,
) {
  const accessor: Record<string, unknown> = Object.assign(Object.create(null), {
    async get(id: unknown): Promise<Record<string, unknown> | null> {
      return await observeStatement(
        observer,
        "read",
        plan.name,
        "get",
        () => {
          if (typeof id !== "bigint") {
            throw new ValidationError(`${plan.name}.get: expected a bigint id`);
          }
          reads?.add(idKey(plan.name, id));
          const raw = engine
            .statement(
              conn,
              `SELECT ${plan.readProjection} FROM ${quote(plan.name)} WHERE ${quote(plan.pk)} = ?`,
            )
            .get(id as never) as Record<string, unknown> | null;
          return raw === null ? null : engine.rowFromSql(plan, raw);
        },
        (row) => row === null ? 0 : 1,
      );
    },
    scan(): RangeQueryImpl {
      return makeRangeQuery(engine, conn, reads, plan, null, null, observer);
    },
  });
  for (const index of plan.indexes) {
    const run = (fn: (q: IndexQb) => unknown) => {
      const qb = new IndexQb(engine, plan, index);
      fn(qb);
      return makeRangeQuery(engine, conn, reads, plan, index, qb, observer);
    };
    accessor[camelCase(index.name)] = run;
  }
  return accessor;
}

/** Validate a full row (insert/replace): pk must be absent, all else checked. */
function checkFullRow(plan: TablePlan, engine: Engine, row: unknown, op: string): Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new ValidationError(`${plan.name}.${op}: expected a row object`);
  }
  const input = row as Record<string, unknown>;
  if (Object.hasOwn(input, plan.pk) && input[plan.pk] !== undefined) {
    throw new ValidationError(
      `${plan.name}.${op}: the primary key "${plan.pk}" is assigned by the database`,
    );
  }
  const table = engine.schema.tables[plan.name]!;
  const out: Record<string, unknown> = {};
  for (const [name, validator] of Object.entries(table.columns)) {
    if (name === plan.pk) continue;
    const value = !Object.hasOwn(input, name) && validator.kind === "nullable"
      ? null
      : input[name];
    out[name] = validator.check(value, `${plan.name}.${op}.${name}`);
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(table.columns, key) && input[key] !== undefined) {
      throw new ValidationError(`${plan.name}.${op}: unknown field "${key}"`);
    }
  }
  return out;
}

interface WriteOutcome<T> {
  value: T;
  row: Record<string, unknown> | null;
}

type AnyWriteResult<T> = Promise<T> & { returning(): Promise<Record<string, unknown> | null> };

/**
 * The result of a write: a real Promise of the primary value (id / void)
 * with `.returning()` for the full written row — which every write already
 * computes for write-key emission, so returning is free.
 *
 * The write executes eagerly at call time; synchronous failures are
 * captured into the rejection so `.catch()` works. When the caller picks
 * the row projection, the id projection is marked handled — a failing
 * `insert(...).returning()` rejects exactly once, and a fire-and-forget
 * failing write still triggers the usual unhandled-rejection report.
 */
function makeWriteResult<T>(
  work: () => WriteOutcome<T> | Promise<WriteOutcome<T>>,
): AnyWriteResult<T> {
  const outcome = new Promise<WriteOutcome<T>>((resolve, reject) => {
    try {
      resolve(work());
    } catch (error) {
      reject(error);
    }
  });
  const main = outcome.then((o) => o.value) as AnyWriteResult<T>;
  main.returning = () => {
    main.catch(() => {}); // the caller chose the row; the id projection is covered
    return outcome.then((o) => o.row);
  };
  return main;
}

function observedWriteResult<T>(
  observer: DbStatementObserver | undefined,
  table: string,
  statement: string,
  work: () => WriteOutcome<T> | Promise<WriteOutcome<T>>,
): AnyWriteResult<T> {
  return makeWriteResult(() => observeStatement(
    observer,
    "write",
    table,
    statement,
    work,
    (outcome) => outcome.row === null ? 0 : 1,
  ));
}

function writeMethods(
  engine: Engine,
  writes: WriteCollector,
  plan: TablePlan,
  observer?: DbStatementObserver,
) {
  const conn = engine.writer;
  const table = engine.schema.tables[plan.name]!;
  const touch = () => {
    if (plan.scheduleAt !== null) writes.scheduledTouched = true;
  };

  const getRow = (id: bigint): Record<string, unknown> | null => {
    const raw = engine
      .statement(
        conn,
        `SELECT ${plan.readProjection} FROM ${quote(plan.name)} WHERE ${quote(plan.pk)} = ?`,
      )
      .get(id as never) as Record<string, unknown> | null;
    return raw === null ? null : engine.rowFromSql(plan, raw);
  };

  return {
    insert(row: unknown): AnyWriteResult<bigint> {
      return observedWriteResult(observer, plan.name, "insert", () => {
        const values = checkFullRow(plan, engine, row, "insert");
        const { sql, bind } = engine.insertSql(plan);
        let inserted: { [k: string]: unknown };
        try {
          inserted = engine.statement(conn, sql).get(...(bind(values) as never[])) as never;
        } catch (error) {
          wrapUnique(plan.name, error);
        }
        const id = inserted[plan.pk] as bigint;
        const full = { ...values, [plan.pk]: id };
        emitWriteKeys(plan, full, writes.keys);
        touch();
        return { value: id, row: full };
      });
    },

    patch(id: bigint, partial: unknown): AnyWriteResult<void> {
      return observedWriteResult(observer, plan.name, "patch", () => {
        if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
          throw new ValidationError(`${plan.name}.patch: expected a partial row object`);
        }
        const old = getRow(id);
        if (old === null) throw new Error(`${plan.name}.patch: row ${id} not found`);
        const input = partial as Record<string, unknown>;
        const sets: string[] = [];
        const params: unknown[] = [];
        const updated: Record<string, unknown> = { ...old };
        for (const key of Object.keys(input)) {
          if (input[key] === undefined) continue; // undefined = untouched
          if (key === plan.pk) {
            throw new ValidationError(`${plan.name}.patch: the primary key cannot be changed`);
          }
          if (!Object.hasOwn(table.columns, key)) {
            throw new ValidationError(`${plan.name}.patch: unknown field "${key}"`);
          }
          const validator = table.columns[key]!;
          const value = validator.check(input[key], `${plan.name}.patch.${key}`);
          updated[key] = value;
          const columnPlan = plan.columns.get(key)!;
          const sqlValues = columnPlan.toSql(value);
          columnPlan.phys.forEach((phys, i) => {
            sets.push(`${quote(phys.name)} = ?`);
            params.push(sqlValues[i]);
          });
        }
        if (sets.length === 0) return { value: undefined, row: old };
        try {
          engine
            .statement(conn, `UPDATE ${quote(plan.name)} SET ${sets.join(", ")} WHERE ${quote(plan.pk)} = ?`)
            .run(...(params as never[]), id as never);
        } catch (error) {
          wrapUnique(plan.name, error);
        }
        emitWriteKeys(plan, old, writes.keys);
        emitWriteKeys(plan, updated, writes.keys);
        touch();
        return { value: undefined, row: updated };
      });
    },

    replace(id: bigint, row: unknown): AnyWriteResult<void> {
      return observedWriteResult(observer, plan.name, "replace", () => {
        const values = checkFullRow(plan, engine, row, "replace");
        const old = getRow(id);
        if (old === null) throw new Error(`${plan.name}.replace: row ${id} not found`);
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const columnPlan of plan.columns.values()) {
          if (columnPlan.kind === "pk") continue;
          const sqlValues = columnPlan.toSql(values[columnPlan.jsName]);
          columnPlan.phys.forEach((phys, i) => {
            sets.push(`${quote(phys.name)} = ?`);
            params.push(sqlValues[i]);
          });
        }
        try {
          engine
            .statement(conn, `UPDATE ${quote(plan.name)} SET ${sets.join(", ")} WHERE ${quote(plan.pk)} = ?`)
            .run(...(params as never[]), id as never);
        } catch (error) {
          wrapUnique(plan.name, error);
        }
        const full = { ...values, [plan.pk]: id };
        emitWriteKeys(plan, old, writes.keys);
        emitWriteKeys(plan, full, writes.keys);
        touch();
        return { value: undefined, row: full };
      });
    },

    delete(id: bigint): AnyWriteResult<void> {
      return observedWriteResult(observer, plan.name, "delete", () => {
        const old = getRow(id);
        if (old === null) return { value: undefined, row: null }; // idempotent under retry
        engine
          .statement(conn, `DELETE FROM ${quote(plan.name)} WHERE ${quote(plan.pk)} = ?`)
          .run(id as never);
        emitWriteKeys(plan, old, writes.keys);
        touch();
        return { value: undefined, row: old };
      });
    },
  };
}

function attachUpsert(
  engine: Engine,
  writes: WriteCollector,
  plan: TablePlan,
  accessor: Record<string, unknown>,
  childWriter: ReturnType<typeof writeMethods>,
  observer?: DbStatementObserver,
): void {
  for (const index of plan.indexes) {
    if (!index.unique) continue;
    const name = camelCase(index.name);
    const fn = accessor[name] as Record<string, unknown>;
    fn["upsert"] = (key: Record<string, unknown>, values: unknown): AnyWriteResult<bigint> =>
      observedWriteResult(observer, plan.name, "upsert", async () => {
        const keyColumns = [...index.columns];
        for (const column of Object.keys(key)) {
          if (!keyColumns.includes(column)) {
            throw new ValidationError(
              `${plan.name}.${name}.upsert: "${column}" is not part of the unique index`,
            );
          }
        }
        const qb = new IndexQb(engine, plan, index);
        for (const column of keyColumns) {
          if (!Object.hasOwn(key, column) || key[column] === undefined) {
            throw new ValidationError(`${plan.name}.${name}.upsert: missing key column "${column}"`);
          }
          qb.eq(column, key[column]);
        }
        const existing = (await makeRangeQuery(
          engine,
          engine.writer,
          null,
          plan,
          index,
          qb,
        ).unique()) as
          | Record<string, unknown>
          | null;
        const resolved = typeof values === "function" ? values(existing) : values;
        const write = existing === null
          ? childWriter.insert({ ...key, ...resolved })
          : childWriter.patch(existing[plan.pk] as bigint, resolved);
        const row = (await write.returning())!;
        return { value: row[plan.pk] as bigint, row };
      });
  }
}

function eventWriteMethods(
  engine: Engine,
  writes: WriteCollector,
  tableName: string,
  nextEventId: (table: string) => bigint,
) {
  const table = engine.schema.tables[tableName]!;
  const pk = table.primaryKey;
  return Object.assign(Object.create(null) as Record<never, never>, {
    async insert(row: unknown): Promise<void> {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new ValidationError(`${tableName}.insert: expected a row object`);
      }
      const input = row as Record<string, unknown>;
      if (Object.hasOwn(input, pk) && input[pk] !== undefined) {
        throw new ValidationError(`${tableName}.insert: the primary key "${pk}" is assigned by dbzz`);
      }
      const out: Record<string, unknown> = {};
      for (const [name, validator] of Object.entries(table.columns)) {
        if (name === pk) continue;
        const value = !Object.hasOwn(input, name) && validator.kind === "nullable"
          ? null
          : input[name];
        out[name] = validator.check(value, `${tableName}.insert.${name}`);
      }
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(table.columns, key) && input[key] !== undefined) {
          throw new ValidationError(`${tableName}.insert: unknown field "${key}"`);
        }
      }
      writes.events.push({ table: tableName, row: { [pk]: nextEventId(tableName), ...out } });
    },
  });
}

/** Read-only ctx.db (queries). Event tables are absent — there is nothing to read. */
export function makeDbReader(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  observer?: DbStatementObserver,
): unknown {
  const db: Record<string, unknown> = Object.create(null);
  for (const plan of engine.plans.values()) {
    db[plan.name] = readMethods(engine, conn, reads, plan, observer);
  }
  return db;
}

/** Read-write ctx.db (mutations / procedure transactions). */
export function makeDbWriter(
  engine: Engine,
  writes: WriteCollector,
  nextEventId: (table: string) => bigint,
  observer?: DbStatementObserver,
): unknown {
  const db: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(engine.schema.tables)) {
    if (table.kind === "event") {
      db[name] = eventWriteMethods(engine, writes, name, nextEventId);
      continue;
    }
    const plan = engine.plan(name);
    const writer = writeMethods(engine, writes, plan, observer);
    const accessor: Record<string, unknown> = Object.assign(
      Object.create(null),
      readMethods(engine, engine.writer, null, plan, observer),
      writer,
    );
    const upsertWriter = observer === undefined
      ? writer
      : writeMethods(engine, writes, plan);
    attachUpsert(engine, writes, plan, accessor, upsertWriter, observer);
    db[name] = accessor;
  }
  return db;
}

export function newWriteCollector(): WriteCollector {
  return { keys: new Set(), events: [], scheduledTouched: false };
}
