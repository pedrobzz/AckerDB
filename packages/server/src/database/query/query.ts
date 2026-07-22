import type { Database } from "bun:sqlite";
import { isValidationError, ValidationError } from "../../validation/v.ts";
import type { Engine, TablePlan } from "../engine.ts";
import type { ReadRecorder } from "../access.ts";
import {
  deliverObservation,
  observeStatement,
  type DbStatementObserver,
} from "../statement-observation.ts";
import { recordPredicateDependencies } from "./dependencies.ts";
import {
  compilePredicates,
  resolveOrder,
  resolvePredicate,
  type PredicateNode,
  type QueryOrder,
} from "./predicate.ts";

const quote = (name: string): string => `"${name}"`;

interface QueryState {
  readonly predicates: readonly PredicateNode[];
  readonly order: readonly QueryOrder[];
}

interface PaginationOptions {
  readonly cursor?: string | null;
  readonly pageSize: number;
}

interface PaginationResult {
  readonly items: Record<string, unknown>[];
  readonly nextCursor: string | null;
}

type EncodedCursorValue = null | string | number | { readonly bigint: string };

interface CursorPayload {
  readonly version: 1;
  readonly values: readonly EncodedCursorValue[];
}

function encodeCursorValue(value: unknown): EncodedCursorValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return { bigint: value.toString() };
  throw new Error(`cannot encode query cursor value of type ${typeof value}`);
}

function decodeCursorValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { bigint?: unknown }).bigint === "string"
  ) {
    const encoded = (value as { bigint: string }).bigint;
    if (!/^(?:0|-?[1-9]\d{0,18})$/.test(encoded)) {
      throw new ValidationError(`${path}: invalid bigint`);
    }
    try {
      return BigInt(encoded);
    } catch {
      throw new ValidationError(`${path}: invalid bigint`);
    }
  }
  throw new ValidationError(`${path}: invalid value encoding`);
}

function opaqueCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function parseCursor(cursor: string, plan: TablePlan, order: readonly QueryOrder[]): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError(`${plan.displayName}.paginate.cursor: malformed cursor`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { values?: unknown }).values) ||
    Object.keys(parsed).some((key) => key !== "version" && key !== "values")
  ) {
    throw new ValidationError(`${plan.displayName}.paginate.cursor: malformed versioned cursor`);
  }
  const encodedValues = (parsed as { values: unknown[] }).values;
  if (encodedValues.length !== order.length) {
    throw new ValidationError(
      `${plan.displayName}.paginate.cursor: expected ${order.length} ordering values, got ${encodedValues.length}`,
    );
  }
  return encodedValues.map((encoded, position) => {
    const path = `${plan.displayName}.paginate.cursor[${position}]`;
    const value = decodeCursorValue(
      encoded,
      path,
    );
    const columnName = order[position]!.column;
    const column = plan.columns.get(columnName)!;
    if (value === null) {
      if (!column.nullable) {
        throw new ValidationError(
          `${path}: ${column.jsName} is not nullable`,
        );
      }
      return null;
    }
    const storageTypeValid = column.kind === "pk" || column.kind === "bigint" || column.kind === "identity"
      ? typeof value === "bigint"
      : column.kind === "string"
        ? typeof value === "string"
        : column.kind === "boolean"
          ? value === 0 || value === 1
          : column.kind === "enum"
            ? typeof value === "number" && Number.isSafeInteger(value)
            : typeof value === "number" && Number.isFinite(value);
    if (!storageTypeValid) {
      throw new ValidationError(
        `${path}: value is incompatible with ${column.jsName}`,
      );
    }
    if (column.kind === "pk") {
      if (typeof value !== "bigint" || value < -(2n ** 63n) || value > 2n ** 63n - 1n) {
        throw new ValidationError(`${path}: value is incompatible with ${column.jsName}`);
      }
    }
    try {
      const logical = column.fromSql([value]);
      plan.table.columns[columnName]!.check(logical, path);
    } catch (error) {
      if (!isValidationError(error)) throw error;
      throw new ValidationError(`${path}: value is incompatible with ${column.jsName}`);
    }
    return value;
  });
}

/** SQLite lexicographic `strictly after` for mixed directions and native null ordering. */
function cursorPredicate(
  order: readonly QueryOrder[],
  values: readonly unknown[],
): { readonly sql: string; readonly params: readonly unknown[] } {
  const branches: string[] = [];
  const params: unknown[] = [];
  for (let position = 0; position < order.length; position++) {
    const prefix: string[] = [];
    for (let prior = 0; prior < position; prior++) {
      const column = quote(order[prior]!.column);
      const value = values[prior];
      if (value === null) {
        prefix.push(`${column} IS NULL`);
      } else {
        prefix.push(`${column} = ?`);
        params.push(value);
      }
    }
    const current = order[position]!;
    const column = quote(current.column);
    const value = values[position];
    let after: string;
    if (current.direction === "asc") {
      if (value === null) {
        after = `${column} IS NOT NULL`;
      } else {
        after = `${column} > ?`;
        params.push(value);
      }
    } else if (value === null) {
      after = "0";
    } else {
      after = `(${column} < ? OR ${column} IS NULL)`;
      params.push(value);
    }
    branches.push(`(${[...prefix, after].join(" AND ")})`);
  }
  return { sql: `(${branches.join(" OR ")})`, params };
}

class TableQueryRuntime {
  constructor(
    private readonly engine: Engine,
    private readonly conn: Database,
    private readonly reads: ReadRecorder | null,
    private readonly plan: TablePlan,
    private readonly state: QueryState,
    private readonly observer?: DbStatementObserver,
  ) {}

  private next(state: QueryState): TableQueryRuntime {
    return new TableQueryRuntime(
      this.engine,
      this.conn,
      this.reads,
      this.plan,
      state,
      this.observer,
    );
  }

  where(callback: unknown): TableQueryRuntime {
    const predicate = resolvePredicate(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.query.where`,
    );
    return this.next({
      ...this.state,
      predicates: [...this.state.predicates, predicate],
    });
  }

  orderBy(callback: unknown): TableQueryRuntime {
    if (this.state.order.length !== 0) {
      throw new ValidationError(`${this.plan.displayName}.query: .orderBy() may only be called once`);
    }
    return this.next({
      ...this.state,
      order: [resolveOrder(this.plan.environment, callback, `${this.plan.displayName}.query.orderBy`)],
    });
  }

  thenBy(callback: unknown): TableQueryRuntime {
    if (this.state.order.length === 0) {
      throw new ValidationError(`${this.plan.displayName}.query: .thenBy() requires .orderBy()`);
    }
    const order = resolveOrder(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.query.thenBy`,
    );
    if (this.state.order.some(({ column }) => column === order.column)) {
      throw new ValidationError(
        `${this.plan.displayName}.query: column ${JSON.stringify(order.column)} is ordered more than once`,
      );
    }
    return this.next({ ...this.state, order: [...this.state.order, order] });
  }

  private orderSql(): string {
    const prefix = `${quote(this.plan.name)}.`;
    if (this.state.order.length === 0) return `${prefix}${quote(this.plan.pk)} ASC`;
    let sql = "";
    let includesPrimaryKey = false;
    for (const { column, direction } of this.state.order) {
      if (sql !== "") sql += ", ";
      sql += `${prefix}${quote(column)} ${direction.toUpperCase()}`;
      if (column === this.plan.pk) includesPrimaryKey = true;
    }
    if (!includesPrimaryKey) {
      sql += `, ${prefix}${quote(this.plan.pk)} ASC`;
    }
    return sql;
  }

  private paginationOrder(): readonly QueryOrder[] {
    if (this.state.order.length === 0) return [{ column: this.plan.pk, direction: "asc" }];
    if (this.state.order.some(({ column }) => column === this.plan.pk)) return this.state.order;
    return [...this.state.order, { column: this.plan.pk, direction: "asc" }];
  }

  private recordRead(): void {
    if (this.reads === null) return;
    recordPredicateDependencies(this.plan, this.state.predicates, this.reads);
  }

  private statement(
    limit: number,
    cursor?: { readonly sql: string; readonly params: readonly unknown[] },
  ): { readonly sql: string; readonly params: readonly unknown[] } {
    const path = `${this.plan.displayName}.query`;
    const predicate = compilePredicates(
      this.state.predicates,
      this.engine.sqliteParameterLimit,
      path,
    );
    let where = predicate.sql === "" ? "" : ` WHERE (${predicate.sql})`;
    let params = predicate.params;
    if (cursor !== undefined) {
      where += `${where === "" ? " WHERE" : " AND"} (${cursor.sql})`;
      params = predicate.params.length === 0
        ? cursor.params
        : [...predicate.params, ...cursor.params];
    }
    if (params.length > this.engine.sqliteParameterLimit) {
      throw new ValidationError(
        `${path}: statement requires ${params.length} parameters; SQLite supports at most ${this.engine.sqliteParameterLimit}`,
      );
    }
    const orderSql = this.orderSql();
    return {
      sql: `SELECT ${this.plan.readProjection} FROM ${quote(this.plan.name)}${where} ORDER BY ${orderSql}${limit >= 0 ? ` LIMIT ${limit}` : ""}`,
      params,
    };
  }

  private rowsArray(
    limit = -1,
    cursor?: { readonly sql: string; readonly params: readonly unknown[] },
  ): Record<string, unknown>[] {
    this.recordRead();
    const { sql, params } = this.statement(limit, cursor);
    const raws = this.engine
      .statement(this.conn, sql)
      .all(...(params as never[])) as Record<string, unknown>[];
    return raws.map((raw) => this.engine.rowFromSql(this.plan, raw));
  }

  private *streamRows(): IterableIterator<Record<string, unknown>> {
    this.recordRead();
    const { sql, params } = this.statement(-1);
    const prepared = this.conn.prepare(sql);
    try {
      for (const raw of prepared.iterate(...(params as never[]))) {
        yield this.engine.rowFromSql(this.plan, raw as Record<string, unknown>);
      }
    } finally {
      prepared.finalize();
    }
  }

  async collect(): Promise<Record<string, unknown>[]> {
    if (this.observer === undefined) return this.rowsArray();
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "collect",
      () => this.rowsArray(),
      (rows) => rows.length,
    );
  }

  async take(count: number): Promise<Record<string, unknown>[]> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ValidationError(`${this.plan.displayName}.query.take: count must be a non-negative safe integer`);
    }
    if (this.observer === undefined) return this.rowsArray(count);
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "take",
      () => this.rowsArray(count),
      (rows) => rows.length,
    );
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.observer === undefined) return this.rowsArray(1)[0] ?? null;
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "first",
      () => this.rowsArray(1)[0] ?? null,
      (row) => row === null ? 0 : 1,
    );
  }

  private uniqueRow(): Record<string, unknown> | null {
    const rows = this.rowsArray(2);
    if (rows.length > 1) {
      throw new Error(`${this.plan.displayName}: .unique() matched more than one row`);
    }
    return rows[0] ?? null;
  }

  async unique(): Promise<Record<string, unknown> | null> {
    if (this.observer === undefined) return this.uniqueRow();
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "unique",
      () => this.uniqueRow(),
      (row) => row === null ? 0 : 1,
    );
  }

  private countRows(): number {
    this.recordRead();
    const predicate = compilePredicates(
      this.state.predicates,
      this.engine.sqliteParameterLimit,
      `${this.plan.displayName}.query`,
    );
    const where = predicate.sql === "" ? "" : ` WHERE ${predicate.sql}`;
    const row = this.engine
      .statement(this.conn, `SELECT COUNT(*) AS n FROM ${quote(this.plan.name)}${where}`)
      .get(...(predicate.params as never[])) as { n: bigint };
    return Number(row.n);
  }

  async count(): Promise<number> {
    if (this.observer === undefined) return this.countRows();
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "count",
      () => this.countRows(),
      (count) => count,
    );
  }

  async *iter(): AsyncGenerator<Record<string, unknown>> {
    if (this.observer === undefined) {
      yield* this.streamRows();
      return;
    }
    const startedAt = performance.now();
    let rowCount = 0;
    let failed = false;
    try {
      for (const row of this.streamRows()) {
        rowCount++;
        yield row;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      deliverObservation(this.observer, {
        kind: "read",
        table: this.plan.displayName,
        statement: "iter",
        outcome: failed ? "failed" : "ok",
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(failed ? {} : { rowCount }),
      });
    }
  }

  async paginate(options: PaginationOptions): Promise<PaginationResult> {
    if (
      options === null ||
      typeof options !== "object" ||
      !Number.isSafeInteger(options.pageSize) ||
      options.pageSize <= 0
    ) {
      throw new ValidationError(
        `${this.plan.displayName}.query.paginate: pageSize must be a positive safe integer`,
      );
    }
    if (options.cursor !== undefined && options.cursor !== null && typeof options.cursor !== "string") {
      throw new ValidationError(`${this.plan.displayName}.query.paginate: cursor must be a string or null`);
    }
    if (this.observer === undefined) return this.page(options);
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "paginate",
      () => this.page(options),
      (result) => result.items.length,
    );
  }

  private page(options: PaginationOptions): PaginationResult {
    const order = this.paginationOrder();
    const cursor = options.cursor === undefined || options.cursor === null
      ? undefined
      : cursorPredicate(order, parseCursor(options.cursor, this.plan, order));
    const items = this.rowsArray(options.pageSize + 1, cursor);
    const hasMore = items.length > options.pageSize;
    if (hasMore) items.pop();
    const last = items[items.length - 1];
    const nextCursor = !hasMore || last === undefined
      ? null
      : opaqueCursor({
          version: 1,
          values: order.map(({ column }) =>
            encodeCursorValue(this.plan.columns.get(column)!.toSql(last[column])[0]),
          ),
        });
    return { items, nextCursor };
  }
}

/** Construct one immutable table-query builder rooted at the public table accessor. */
export function createTableQuery(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  plan: TablePlan,
  observer?: DbStatementObserver,
): unknown {
  return new TableQueryRuntime(
    engine,
    conn,
    reads,
    plan,
    { predicates: [], order: [] },
    observer,
  );
}
