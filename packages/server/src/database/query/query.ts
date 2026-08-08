import type { Database } from "bun:sqlite";
import { MAX_PAGE_BYTES, MAX_PAGE_SIZE } from "@ackerdb/core";
import { isValidationError, ValidationError } from "../../validation/error.ts";
import type { Engine, TablePlan } from "../engine.ts";
import type { ReadRecorder } from "../access.ts";
import {
  deliverObservation,
  observeStatement,
  type DbStatementObserver,
} from "../statement-observation.ts";
import { assertMutationAccess } from "../../runtime/invocation-state.ts";
import { markTransactionPoisoned } from "../../runtime/transaction-context.ts";
import { recordPredicateDependencies } from "./dependencies.ts";
import {
  compilePredicates,
  MINMAX_KINDS,
  resolveAggregateColumn,
  resolveOrder,
  resolvePredicate,
  SUMMABLE_KINDS,
  type PredicateNode,
  type QueryOrder,
} from "./predicate.ts";
import { filterPredicate, tableFilterMeta } from "./filter.ts";
import {
  cursorPredicate,
  opaqueCursor,
  parseOpaqueCursor,
  type CursorColumn,
} from "../reads/cursor.ts";

const quote = (name: string): string => `"${name}"`;

// Wire costs the page budget charges per cell, from the JSON wire format:
// `null`, a number's worst-case JSON form, and the escape envelopes bigints
// and byte arrays travel in. Base64 spends four characters per three bytes.
const NULL_CELL_BYTES = 4;
const NUMBER_CELL_BYTES = 24;
const BIGINT_CELL_BYTES = 36;
const BYTES_CELL_ENVELOPE = 16;

/**
 * The approximate wire size of one raw SQLite row, which is what a page
 * budgets. Cells are charged where they already sit — no encoding pass, no
 * copy — so the measure costs one walk over the row and never the second
 * encoding an exact answer would need.
 *
 * It is a budget, not the transport's bound. A string dense in characters JSON
 * escapes still encodes larger than it measures here, and `maxFrameBytes`
 * stays the authority that answers such a row with a typed overloaded outcome,
 * exactly as it does for every other materializer. What this bound owes is
 * that an ordinary page of ordinary rows cannot grow without limit.
 */
function pageRowBytes(raw: Record<string, unknown>): number {
  let bytes = 0;
  for (const key in raw) {
    const value = raw[key];
    bytes += key.length + 3;
    if (value === null) bytes += NULL_CELL_BYTES;
    else if (typeof value === "string") bytes += Buffer.byteLength(value) + 2;
    else if (typeof value === "bigint") bytes += BIGINT_CELL_BYTES;
    else if (ArrayBuffer.isView(value)) {
      bytes += Math.ceil(value.byteLength / 3) * 4 + BYTES_CELL_ENVELOPE;
    } else bytes += NUMBER_CELL_BYTES;
  }
  return bytes;
}

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

/**
 * A table column, seen as the cursor contract sees it: nullability plus the
 * one question of whether a decoded storage value could have come out of this
 * column. The storage-type test and the column's own validator both live here
 * because both are facts about the declared schema, which the cursor codec
 * deliberately knows nothing about.
 */
function cursorColumn(plan: TablePlan, name: string): CursorColumn {
  const column = plan.columns.get(name)!;
  return {
    nullable: column.nullable,
    admit: (value, path) => {
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
        throw new ValidationError(`${path}: value is incompatible with ${column.jsName}`);
      }
      // A primary key is stored as a SQLite 64-bit integer, so a bigint the
      // column could never have produced is rejected before its validator is
      // asked a question about a value it will never see.
      if (
        column.kind === "pk" &&
        ((value as bigint) < -(2n ** 63n) || (value as bigint) > 2n ** 63n - 1n)
      ) {
        throw new ValidationError(`${path}: value is incompatible with ${column.jsName}`);
      }
      try {
        plan.table.columns[name]!.check(column.fromSql([value]), path);
      } catch (error) {
        if (!isValidationError(error)) throw error;
        throw new ValidationError(`${path}: value is incompatible with ${column.jsName}`);
      }
    },
  };
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
    // A validated serializable filter and a predicate callback arrive at the
    // same node vocabulary; only the way the caller wrote them differs. A
    // filter that matches every row adds nothing.
    const filter = tableFilterMeta(callback);
    const predicate = filter === undefined
      ? resolvePredicate(
          this.plan.environment,
          callback,
          `${this.plan.displayName}.query.where`,
        )
      : filterPredicate(this.plan, filter);
    if (predicate === null) return this;
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

  private rawRows(
    limit: number,
    cursor?: { readonly sql: string; readonly params: readonly unknown[] },
  ): Record<string, unknown>[] {
    assertMutationAccess();
    this.recordRead();
    const { sql, params } = this.statement(limit, cursor);
    return this.engine
      .statement(this.conn, sql)
      .all(...(params as never[])) as Record<string, unknown>[];
  }

  private rowsArray(limit = -1): Record<string, unknown>[] {
    return this.rawRows(limit).map((raw) => this.engine.rowFromSql(this.plan, raw));
  }

  private *streamRows(): IterableIterator<Record<string, unknown>> {
    assertMutationAccess();
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
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "unique",
      () => this.uniqueRow(),
      (row) => row === null ? 0 : 1,
    );
  }

  private aggregateRaw(select: string): unknown {
    assertMutationAccess();
    this.recordRead();
    const predicate = compilePredicates(
      this.state.predicates,
      this.engine.sqliteParameterLimit,
      `${this.plan.displayName}.query`,
    );
    const where = predicate.sql === "" ? "" : ` WHERE ${predicate.sql}`;
    const row = this.engine
      .statement(this.conn, `SELECT ${select} AS v FROM ${quote(this.plan.name)}${where}`)
      .get(...(predicate.params as never[])) as { v: unknown };
    return row.v;
  }

  async count(): Promise<number> {
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "count",
      () => Number(this.aggregateRaw("COUNT(*)")),
      (count) => count,
    );
  }

  private sumValue(column: string, kind: string): number | bigint {
    const path = `${this.plan.displayName}.query.sum`;
    let raw: unknown;
    try {
      raw = this.aggregateRaw(`SUM(${quote(column)})`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("integer overflow")) {
        throw new Error(
          `${path}: sum of ${JSON.stringify(column)} exceeds SQLite's 64-bit integer range`,
        );
      }
      throw error;
    }
    if (kind === "bigint") return raw === null ? 0n : (raw as bigint);
    if (raw === null) return 0;
    if (typeof raw !== "bigint") return raw as number;
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `${path}: exact sum of ${JSON.stringify(column)} exceeds Number.MAX_SAFE_INTEGER; store it as a bigint column`,
      );
    }
    return Number(raw);
  }

  async sum(callback: unknown): Promise<number | bigint> {
    const { column, kind } = resolveAggregateColumn(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.query.sum`,
      SUMMABLE_KINDS,
    );
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "sum",
      () => this.sumValue(column, kind),
      () => undefined,
    );
  }

  async avg(callback: unknown): Promise<number | null> {
    const { column } = resolveAggregateColumn(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.query.avg`,
      SUMMABLE_KINDS,
    );
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "avg",
      () => {
        const raw = this.aggregateRaw(`AVG(${quote(column)})`);
        return raw === null ? null : typeof raw === "bigint" ? Number(raw) : (raw as number);
      },
      () => undefined,
    );
  }

  private extremeValue(fn: "MIN" | "MAX", column: string): unknown {
    const raw = this.aggregateRaw(`${fn}(${quote(column)})`);
    return raw === null ? null : this.plan.columns.get(column)!.fromSql([raw]);
  }

  async min(callback: unknown): Promise<unknown> {
    const { column } = resolveAggregateColumn(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.query.min`,
      MINMAX_KINDS,
    );
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "min",
      () => this.extremeValue("MIN", column),
      () => undefined,
    );
  }

  async max(callback: unknown): Promise<unknown> {
    const { column } = resolveAggregateColumn(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.query.max`,
      MINMAX_KINDS,
    );
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "max",
      () => this.extremeValue("MAX", column),
      () => undefined,
    );
  }

  async *iter(): AsyncGenerator<Record<string, unknown>> {
    const startedAt = this.observer === undefined ? 0 : performance.now();
    let rowCount = 0;
    let failed = false;
    try {
      for (const row of this.streamRows()) {
        rowCount++;
        yield row;
      }
    } catch (error) {
      failed = true;
      markTransactionPoisoned(error);
      throw error;
    } finally {
      if (this.observer !== undefined) {
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
    // A page size normally arrives from a caller, so the bound is the
    // server's, not the caller's. Rejecting is the honest answer: silently
    // clamping would hand back a page that does not match what was asked for.
    if (options.pageSize > MAX_PAGE_SIZE) {
      throw new ValidationError(
        `${this.plan.displayName}.query.paginate: pageSize must be at most ${MAX_PAGE_SIZE}`,
      );
    }
    if (options.cursor !== undefined && options.cursor !== null && typeof options.cursor !== "string") {
      throw new ValidationError(`${this.plan.displayName}.query.paginate: cursor must be a string or null`);
    }
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
    const cursorPath = `${this.plan.displayName}.paginate.cursor`;
    const cursor = options.cursor === undefined || options.cursor === null
      ? undefined
      : cursorPredicate(order, parseOpaqueCursor(
          options.cursor,
          order,
          (name) => cursorColumn(this.plan, name),
          cursorPath,
        ));
    const raws = this.rawRows(options.pageSize + 1, cursor);
    const beyondPage = raws.length > options.pageSize;
    if (beyondPage) raws.pop();
    // Two bounds decide one page: the requested row count, and the byte budget
    // that keeps a handful of oversized rows from making the page undeliverable.
    // The budget takes rows away, never fields — a truncated page is a shorter
    // page whose cursor resumes at the row that did not fit. The first row is
    // always admitted, so a single row above the whole budget still advances.
    const items: Record<string, unknown>[] = [];
    let bytes = 0;
    let beyondBudget = false;
    for (const raw of raws) {
      const rowBytes = pageRowBytes(raw);
      if (items.length > 0 && bytes + rowBytes > MAX_PAGE_BYTES) {
        beyondBudget = true;
        break;
      }
      bytes += rowBytes;
      items.push(this.engine.rowFromSql(this.plan, raw));
    }
    const last = items[items.length - 1];
    const nextCursor = (!beyondPage && !beyondBudget) || last === undefined
      ? null
      : opaqueCursor(order.map(
          ({ column }) => this.plan.columns.get(column)!.toSql(last[column])[0],
        ));
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
