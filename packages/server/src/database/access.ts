/**
 * The runtime behind `ctx.db`: assembles table read/write methods and records
 * write sets for reactivity. Planner-independent reads live in `query/`.
 */
import type { Database } from "bun:sqlite";
import { ValidationError } from "../validation/error.ts";
import type { ColumnPlan, Engine, StorageScope, TablePlan } from "./engine.ts";
import { brand, hasBrand } from "../shared/identity.ts";
import type { TableDef } from "../schema/definition.ts";
import { emitFullTextWriteKeys, emitWriteKeys, idKey } from "./keys.ts";
import { createTableQuery } from "./query/query.ts";
import { createNearestQuery } from "./query/nearest.ts";
import { createFullTextQuery } from "./query/full-text.ts";
import {
  observeStatement,
  type DbStatementObserver,
} from "./statement-observation.ts";
import { assertMutationAccess } from "../runtime/invocation-state.ts";
import { poisonTransaction } from "../runtime/transaction-context.ts";
import { decode, stableEncode } from "@ackerdb/core";
import { JOBS_TABLE, JOBS_GUARDED_COLUMNS } from "../jobs/table.ts";
import { hashJobArgs } from "../jobs/identity.ts";
import { FILES_TABLE } from "../files/tables.ts";
import {
  checkpointFileObservability,
  newFileObservabilityDelta,
  rollbackFileObservability,
  stageFileObservability,
  type FileObservabilityCheckpoint,
  type FileObservabilityDelta,
} from "../files/observability.ts";

const quote = (name: string): string => `"${name}"`;

const UNIQUE_CONSTRAINT_ERROR_IDENTITY = Symbol.for("@ackerdb/server/UniqueConstraintError/v1");

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
  /** Exact scheduled tables written by this transaction — the scheduler refreshes only these. */
  scheduledTables: Set<string>;
  /** Earliest post-commit wake requested by transactional File state. */
  fileCleanupAt: number | null;
  /** Framework File state staged until the enclosing database COMMIT succeeds. */
  fileObservability: FileObservabilityDelta;
}

export interface WriteCollectorCheckpoint {
  readonly keys: number;
  readonly events: number;
  readonly scheduledTables: number;
  readonly fileCleanupAt: number | null;
  readonly fileObservability: FileObservabilityCheckpoint;
}

class JournaledSet<T> extends Set<T> {
  readonly #insertions: T[] = [];

  override add(value: T): this {
    if (!this.has(value)) this.#insertions.push(value);
    return super.add(value);
  }

  checkpoint(): number {
    return this.#insertions.length;
  }

  rollback(checkpoint: number): void {
    for (let index = this.#insertions.length - 1; index >= checkpoint; index--) {
      super.delete(this.#insertions[index]!);
    }
    this.#insertions.length = checkpoint;
  }
}

export function checkpointWriteCollector(
  writes: WriteCollector,
): WriteCollectorCheckpoint {
  const keys = writes.keys;
  const scheduledTables = writes.scheduledTables;
  if (!(keys instanceof JournaledSet) || !(scheduledTables instanceof JournaledSet)) {
    throw new TypeError("write collector was not created by newWriteCollector()");
  }
  return {
    keys: keys.checkpoint(),
    events: writes.events.length,
    scheduledTables: scheduledTables.checkpoint(),
    fileCleanupAt: writes.fileCleanupAt,
    fileObservability: checkpointFileObservability(writes.fileObservability),
  };
}

export function rollbackWriteCollector(
  writes: WriteCollector,
  checkpoint: WriteCollectorCheckpoint,
): void {
  const keys = writes.keys;
  const scheduledTables = writes.scheduledTables;
  if (!(keys instanceof JournaledSet) || !(scheduledTables instanceof JournaledSet)) {
    throw new TypeError("write collector was not created by newWriteCollector()");
  }
  keys.rollback(checkpoint.keys);
  writes.events.length = checkpoint.events;
  scheduledTables.rollback(checkpoint.scheduledTables);
  writes.fileCleanupAt = checkpoint.fileCleanupAt;
  rollbackFileObservability(writes.fileObservability, checkpoint.fileObservability);
}

// ---------------------------------------------------------------------------
// Table accessors.

function wrapUnique(table: string, error: unknown): never {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    throw new UniqueConstraintError(`${table}: ${error.message}`);
  }
  throw error;
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
      assertMutationAccess();
      return await observeStatement(
        observer,
        "read",
        plan.displayName,
        "get",
        () => {
          if (typeof id !== "bigint") {
            throw new ValidationError(`${plan.displayName}.get: expected a bigint id`);
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
    query(): unknown {
      assertMutationAccess();
      return createTableQuery(engine, conn, reads, plan, observer);
    },
  });
  if (plan.hasVectorColumns) {
    accessor["nearest"] = (column: unknown, query: unknown, options: unknown): unknown =>
      createNearestQuery(engine, conn, reads, plan, column, query, options, observer);
  }
  if (plan.fullText.length > 0) {
    accessor["fullText"] = (column: unknown, query: unknown): unknown =>
      createFullTextQuery(engine, conn, reads, plan, column, query, observer);
  }
  return accessor;
}

/** Validate a full row (insert/replace): pk must be absent, all else checked. */
function checkFullRow(plan: TablePlan, row: unknown, op: string): Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new ValidationError(`${plan.displayName}.${op}: expected a row object`);
  }
  const input = row as Record<string, unknown>;
  if (Object.hasOwn(input, plan.pk) && input[plan.pk] !== undefined) {
    throw new ValidationError(
      `${plan.displayName}.${op}: the primary key "${plan.pk}" is assigned by the database`,
    );
  }
  const table = plan.table;
  const out: Record<string, unknown> = {};
  for (const [name, validator] of Object.entries(table.columns)) {
    if (name === plan.pk) continue;
    const value = !Object.hasOwn(input, name) && validator.kind === "nullable"
      ? null
      : input[name];
    out[name] = validator.check(value, `${plan.displayName}.${op}.${name}`);
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(table.columns, key) && input[key] !== undefined) {
      throw new ValidationError(`${plan.displayName}.${op}: unknown field "${key}"`);
    }
  }
  return out;
}

interface WriteOutcome<T> {
  value: T;
  row: Record<string, unknown> | null;
}

type AnyWriteResult<T> = Promise<T> & { returning(): Promise<Record<string, unknown> | null> };

// Safely below SQLite's historical 999-variable default while large enough to
// collapse maintenance work into useful set-based batches.
const DELETE_MANY_LIMIT = 256;

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

/**
 * A schema-declared v.file() is the explicit ownership boundary: writing that
 * row atomically promotes a pending upload. No table scan or inferred bigint
 * relationship is involved, and deleting/replacing the row never cascades.
 */
function claimFileReferences(
  engine: Engine,
  writes: WriteCollector,
  plan: TablePlan,
  row: Record<string, unknown>,
): void {
  const ids = new Set<bigint>();
  for (const [column, validator] of Object.entries(plan.table.columns)) {
    const inner = (validator as { readonly inner?: { readonly kind?: string } }).inner;
    const file = validator.kind === "file" ||
      (validator.kind === "nullable" && inner?.kind === "file");
    if (file && typeof row[column] === "bigint") ids.add(row[column] as bigint);
  }
  if (ids.size === 0) return;

  const filePlan = engine.rootScope.plan(FILES_TABLE);
  for (const id of ids) {
    const raw = engine.statement(
      engine.writer,
      `SELECT ${filePlan.readProjection} FROM ${quote(filePlan.name)} WHERE ${quote(filePlan.pk)} = ?`,
    ).get(id as never) as Record<string, unknown> | null;
    const file = raw === null ? null : engine.rowFromSql(filePlan, raw);
    if (file === null || file.state === "deleting") {
      return poisonTransaction(new ValidationError(
        `${plan.displayName}: File ${id} does not exist`,
      ));
    }
    if (file.state === "pending") {
      updateRow(engine, writes, filePlan, {
        id,
        oldRow: file,
        partial: { state: "active", pendingExpiresAt: null },
      });
    }
  }
}

function updateRow(
  engine: Engine,
  writes: WriteCollector,
  plan: TablePlan,
  input: {
    readonly id: bigint;
    readonly oldRow: Record<string, unknown>;
    readonly partial: unknown;
  },
): WriteOutcome<void> {
  if (input.partial === null || typeof input.partial !== "object" || Array.isArray(input.partial)) {
    throw new ValidationError(`${plan.displayName}.patch: expected a partial row object`);
  }
  const partial = input.partial as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [];
  const updated: Record<string, unknown> = { ...input.oldRow };
  for (const key of Object.keys(partial)) {
    if (partial[key] === undefined) continue;
    if (key === plan.pk) {
      throw new ValidationError(`${plan.displayName}.patch: the primary key cannot be changed`);
    }
    if (!Object.hasOwn(plan.table.columns, key)) {
      throw new ValidationError(`${plan.displayName}.patch: unknown field "${key}"`);
    }
    const validator = plan.table.columns[key]!;
    const value = validator.check(partial[key], `${plan.displayName}.patch.${key}`);
    changed[key] = value;
    updated[key] = value;
    const columnPlan = plan.columns.get(key)!;
    const sqlValues = columnPlan.toSql(value);
    columnPlan.phys.forEach((phys, index) => {
      sets.push(`${quote(phys.name)} = ?`);
      params.push(sqlValues[index]);
    });
  }
  if (sets.length === 0) return { value: undefined, row: input.oldRow };
  try {
    engine
      .statement(
        engine.writer,
        `UPDATE ${quote(plan.name)} SET ${sets.join(", ")} WHERE ${quote(plan.pk)} = ?`,
      )
      .run(...(params as never[]), input.id as never);
  } catch (error) {
    wrapUnique(plan.displayName, error);
  }
  // A patch writes only its declared fields. Revalidating untouched File
  // columns would turn explicit File deletion into hidden reference
  // protection and could make an otherwise unrelated row edit impossible.
  claimFileReferences(engine, writes, plan, changed);
  emitWriteKeys(plan, input.oldRow, writes.keys);
  emitWriteKeys(plan, updated, writes.keys);
  emitFullTextWriteKeys(plan, input.oldRow, updated, writes.keys);
  stageFileObservability(writes.fileObservability, plan.logicalName, input.oldRow, updated);
  if (plan.scheduleAt !== null) writes.scheduledTables.add(plan.logicalName);
  return { value: undefined, row: updated };
}

function writeMethods(
  engine: Engine,
  writes: WriteCollector,
  plan: TablePlan,
  observer?: DbStatementObserver,
) {
  const conn = engine.writer;
  const touch = () => {
    if (plan.scheduleAt !== null) writes.scheduledTables.add(plan.logicalName);
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
      assertMutationAccess();
      return observedWriteResult(observer, plan.displayName, "insert", () => {
        const values = checkFullRow(plan, row, "insert");
        const { sql, bind } = engine.insertSql(plan);
        let inserted: { [k: string]: unknown };
        try {
          inserted = engine.statement(conn, sql).get(...(bind(values) as never[])) as never;
        } catch (error) {
          wrapUnique(plan.displayName, error);
        }
        const id = inserted[plan.pk] as bigint;
        const full = { ...values, [plan.pk]: id };
        claimFileReferences(engine, writes, plan, full);
        emitWriteKeys(plan, full, writes.keys);
        emitFullTextWriteKeys(plan, null, full, writes.keys);
        stageFileObservability(writes.fileObservability, plan.logicalName, null, full);
        touch();
        return { value: id, row: full };
      });
    },

    patch(id: bigint, partial: unknown): AnyWriteResult<void> {
      assertMutationAccess();
      return observedWriteResult(observer, plan.displayName, "patch", () => {
        const old = getRow(id);
        if (old === null) throw new Error(`${plan.displayName}.patch: row ${id} not found`);
        return updateRow(engine, writes, plan, { id, oldRow: old, partial });
      });
    },

    replace(id: bigint, row: unknown): AnyWriteResult<void> {
      assertMutationAccess();
      return observedWriteResult(observer, plan.displayName, "replace", () => {
        const values = checkFullRow(plan, row, "replace");
        const old = getRow(id);
        if (old === null) throw new Error(`${plan.displayName}.replace: row ${id} not found`);
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
          wrapUnique(plan.displayName, error);
        }
        const full = { ...values, [plan.pk]: id };
        claimFileReferences(engine, writes, plan, full);
        emitWriteKeys(plan, old, writes.keys);
        emitWriteKeys(plan, full, writes.keys);
        emitFullTextWriteKeys(plan, old, full, writes.keys);
        stageFileObservability(writes.fileObservability, plan.logicalName, old, full);
        touch();
        return { value: undefined, row: full };
      });
    },

    delete(id: bigint): AnyWriteResult<void> {
      assertMutationAccess();
      return observedWriteResult(observer, plan.displayName, "delete", () => {
        const old = getRow(id);
        if (old === null) return { value: undefined, row: null }; // idempotent under retry
        engine
          .statement(conn, `DELETE FROM ${quote(plan.name)} WHERE ${quote(plan.pk)} = ?`)
          .run(id as never);
        emitWriteKeys(plan, old, writes.keys);
        emitFullTextWriteKeys(plan, old, null, writes.keys);
        stageFileObservability(writes.fileObservability, plan.logicalName, old, null);
        touch();
        return { value: undefined, row: old };
      });
    },

    async deleteMany(ids: unknown): Promise<number> {
      assertMutationAccess();
      return await observeStatement(
        observer,
        "write",
        plan.displayName,
        "deleteMany",
        () => {
          if (!Array.isArray(ids)) {
            throw new ValidationError(`${plan.displayName}.deleteMany: expected an array of bigint ids`);
          }
          const distinct = new Set<bigint>();
          for (const id of ids) {
            if (typeof id !== "bigint") {
              throw new ValidationError(`${plan.displayName}.deleteMany: expected bigint ids`);
            }
            distinct.add(id);
          }
          if (distinct.size > DELETE_MANY_LIMIT) {
            throw new ValidationError(
              `${plan.displayName}.deleteMany: at most ${DELETE_MANY_LIMIT} distinct ids may be deleted at once`,
            );
          }
          const uniqueIds = [...distinct];
          if (uniqueIds.length === 0) return 0;
          const placeholders = uniqueIds.map(() => "?").join(", ");
          const rawRows = engine
            .statement(
              conn,
              `DELETE FROM ${quote(plan.name)} WHERE ${quote(plan.pk)} IN (${placeholders}) RETURNING ${plan.readProjection}`,
            )
            .all(...(uniqueIds as never[])) as Record<string, unknown>[];
          for (const raw of rawRows) {
            const row = engine.rowFromSql(plan, raw);
            emitWriteKeys(plan, row, writes.keys);
            emitFullTextWriteKeys(plan, row, null, writes.keys);
            stageFileObservability(writes.fileObservability, plan.logicalName, row, null);
          }
          if (rawRows.length > 0) touch();
          return rawRows.length;
        },
        (deleted) => deleted,
      );
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
  const candidates = plan.indexes.filter(
    (index) =>
      index.unique && index.columns.every((column) => !plan.columns.get(column)!.nullable),
  );
  if (candidates.length === 0) return;
  accessor["upsert"] = (key: unknown, values: unknown): AnyWriteResult<bigint> => {
    assertMutationAccess();
    return observedWriteResult(observer, plan.displayName, "upsert", async () => {
      if (key === null || typeof key !== "object" || Array.isArray(key)) {
        throw new ValidationError(`${plan.displayName}.upsert: expected a key object`);
      }
      const input = key as Record<string, unknown>;
      const inputColumns = Object.keys(input);
      const matches = candidates.filter(
        (index) =>
          index.columns.length === inputColumns.length &&
          index.columns.every((column) => Object.hasOwn(input, column)),
      );
      if (matches.length === 0) {
        throw new ValidationError(
          `${plan.displayName}.upsert: key fields must exactly match one non-null unique index`,
        );
      }
      if (matches.length > 1) {
        throw new ValidationError(
          `${plan.displayName}.upsert: key fields are ambiguous between unique indexes`,
        );
      }
      const index = matches[0]!;
      const checkedKey: Record<string, unknown> = {};
      const clauses: string[] = [];
      const params: unknown[] = [];
      for (const column of index.columns) {
        const checked = plan.table.columns[column]!.check(
          input[column],
          `${plan.displayName}.upsert.${column}`,
        );
        checkedKey[column] = checked;
        const columnPlan = plan.columns.get(column)!;
        const sqlValues = columnPlan.toSql(checked);
        for (let position = 0; position < columnPlan.phys.length; position++) {
          const physical = quote(columnPlan.phys[position]!.name);
          const sqlValue = sqlValues[position];
          if (sqlValue === null) {
            clauses.push(`${physical} IS NULL`);
          } else {
            clauses.push(`${physical} = ?`);
            params.push(sqlValue);
          }
        }
      }
      const where = clauses.join(" AND ");
      const raws = engine
        .statement(
          engine.writer,
          `SELECT ${plan.readProjection} FROM ${quote(plan.name)} WHERE ${where} LIMIT 2`,
        )
        .all(...(params as never[])) as Record<string, unknown>[];
      if (raws.length > 1) {
        throw new Error(`${plan.displayName}.upsert: unique key matched more than one row`);
      }
      const existing = raws[0] === undefined ? null : engine.rowFromSql(plan, raws[0]);
      const resolved = typeof values === "function" ? values(existing) : values;
      if (
        resolved !== null &&
        (typeof resolved === "object" || typeof resolved === "function") &&
        typeof (resolved as PromiseLike<unknown>).then === "function"
      ) {
        throw new ValidationError(`${plan.displayName}.upsert: values callback must be synchronous`);
      }
      if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) {
        throw new ValidationError(`${plan.displayName}.upsert: expected a values object`);
      }
      for (const column of index.columns) {
        if (Object.hasOwn(resolved, column)) {
          throw new ValidationError(
            `${plan.displayName}.upsert: key field "${column}" cannot be changed by values`,
          );
        }
      }
      const row = existing === null
        ? (await childWriter
          .insert({ ...checkedKey, ...(resolved as Record<string, unknown>) })
          .returning())!
        : updateRow(engine, writes, plan, {
          id: existing[plan.pk] as bigint,
          oldRow: existing,
          partial: resolved,
        }).row!;
      return { value: row[plan.pk] as bigint, row };
    });
  };
}

function eventWriteMethods(
  writes: WriteCollector,
  table: TableDef,
  logicalName: string,
  nextEventId: (table: string) => bigint,
) {
  const pk = table.primaryKey;
  return Object.assign(Object.create(null) as Record<never, never>, {
    async insert(row: unknown): Promise<void> {
      assertMutationAccess();
      try {
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
          throw new ValidationError(`${logicalName}.insert: expected a row object`);
        }
        const input = row as Record<string, unknown>;
        if (Object.hasOwn(input, pk) && input[pk] !== undefined) {
          throw new ValidationError(`${logicalName}.insert: the primary key "${pk}" is assigned by ackerdb`);
        }
        const out: Record<string, unknown> = {};
        for (const [name, validator] of Object.entries(table.columns)) {
          if (name === pk) continue;
          const value = !Object.hasOwn(input, name) && validator.kind === "nullable"
            ? null
            : input[name];
          out[name] = validator.check(value, `${logicalName}.insert.${name}`);
        }
        for (const key of Object.keys(input)) {
          if (!Object.hasOwn(table.columns, key) && input[key] !== undefined) {
            throw new ValidationError(`${logicalName}.insert: unknown field "${key}"`);
          }
        }
        writes.events.push({ table: logicalName, row: { [pk]: nextEventId(logicalName), ...out } });
      } catch (error) {
        return poisonTransaction(error);
      }
    },
  });
}

/** Read-only ctx.db (queries). Event tables are absent — there is nothing to read. */
export function makeDbReader(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  observer?: DbStatementObserver,
  scope: StorageScope = engine.rootScope,
): unknown {
  const db: Record<string, unknown> = Object.create(null);
  for (const plan of scope.plans.values()) {
    db[plan.logicalName] = readMethods(engine, conn, reads, plan, observer);
  }
  return db;
}

/**
 * The application-facing writer over the framework jobs table. The runner owns
 * the state machine, so its columns are guarded here — the one public write
 * seam — while scheduling intent stays open: `runAt`, `key`, and `argsJson`
 * may be patched (a patched `argsJson` recomputes the dedup hash so identity
 * cannot drift), and rows may be deleted. Inserts go through
 * `ctx.jobs.enqueue`, the door that computes identity and dedup.
 */
function guardedJobsWriter(
  writer: ReturnType<typeof writeMethods>,
  getRow: (id: bigint) => Promise<Record<string, unknown> | null>,
): ReturnType<typeof writeMethods> {
  const refuse = (op: string): never => {
    throw new ValidationError(
      `${JOBS_TABLE}.${op}: jobs are created with ctx.jobs.enqueue and settled by the runner`,
    );
  };
  return {
    ...writer,
    insert: () => refuse("insert"),
    replace: () => refuse("replace"),
    patch: (id: bigint, partial: unknown) => {
      if (partial !== null && typeof partial === "object" && !Array.isArray(partial)) {
        const input = partial as Record<string, unknown>;
        for (const key of Object.keys(input)) {
          if (input[key] !== undefined && JOBS_GUARDED_COLUMNS.has(key)) {
            throw new ValidationError(
              `${JOBS_TABLE}.patch: "${key}" belongs to the runner's state machine; use the ctx.jobs transitions`,
            );
          }
        }
        const editsIntent = ["argsJson", "key", "runAt"].some(
          (column) => input[column] !== undefined,
        );
        if (editsIntent) {
          return makeWriteResult(async () => {
            // A running row's claim already captured its arguments and gate:
            // editing them mid-flight would settle old work under a new
            // identity. Cancel first, then edit.
            const current = await getRow(id);
            if (current !== null && (current as { state?: unknown }).state === "running") {
              throw new ValidationError(
                `${JOBS_TABLE}.patch: the row is running; cancel it before editing its scheduling intent`,
              );
            }
            let patch = input;
            if (typeof input["argsJson"] === "string") {
              // Canonicalize before hashing so an equivalent encoding cannot
              // fork the dedup identity; a non-decodable payload is refused.
              let canonical: string;
              try {
                canonical = stableEncode(decode(input["argsJson"]));
              } catch {
                throw new ValidationError(
                  `${JOBS_TABLE}.patch: argsJson is not a valid canonical encoding`,
                );
              }
              patch = { ...input, argsJson: canonical, argsHash: hashJobArgs(canonical) };
            }
            await writer.patch(id, patch);
            return { value: undefined, row: await getRow(id) };
          }) as ReturnType<ReturnType<typeof writeMethods>["patch"]>;
        }
      }
      return writer.patch(id, partial);
    },
  };
}

/** Read-write ctx.db (mutations / procedure transactions). */
export function makeDbWriter(
  engine: Engine,
  writes: WriteCollector,
  nextEventId: (table: string) => bigint,
  observer?: DbStatementObserver,
  scope: StorageScope = engine.rootScope,
): unknown {
  const db: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(scope.schema.tables)) {
    if (table.kind === "event") {
      db[name] = eventWriteMethods(writes, table, name, nextEventId);
      continue;
    }
    const plan = scope.plan(name);
    const writer = writeMethods(engine, writes, plan, observer);
    const reader = readMethods(engine, engine.writer, null, plan, observer);
    const accessor: Record<string, unknown> = Object.assign(
      Object.create(null),
      reader,
      name === JOBS_TABLE
        ? guardedJobsWriter(
            writer,
            reader["get"] as (id: bigint) => Promise<Record<string, unknown> | null>,
          )
        : writer,
    );
    if (name !== JOBS_TABLE) {
      const upsertWriter = observer === undefined
        ? writer
        : writeMethods(engine, writes, plan);
      attachUpsert(engine, writes, plan, accessor, upsertWriter, observer);
    }
    db[name] = accessor;
  }
  return db;
}

/**
 * The runner's unguarded door to the jobs table: full write methods over the
 * jobs plan, with write keys and commit-wake emitted like any table write.
 * Framework code only — never handed to an application handler.
 */
export function makeJobsTableWriter(
  engine: Engine,
  writes: WriteCollector,
  observer?: DbStatementObserver,
): ReturnType<typeof writeMethods> & { plan: TablePlan } {
  const plan = engine.rootScope.plan(JOBS_TABLE);
  return Object.assign(writeMethods(engine, writes, plan, observer), { plan });
}

export function newWriteCollector(): WriteCollector {
  return {
    keys: new JournaledSet(),
    events: [],
    scheduledTables: new JournaledSet(),
    fileCleanupAt: null,
    fileObservability: newFileObservabilityDelta(),
  };
}
