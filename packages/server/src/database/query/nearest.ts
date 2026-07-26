import type { Database } from "bun:sqlite";
import { CorruptDatabaseError } from "../../shared/errors.ts";
import {
  baseValidator,
  ValidationError,
  type VectorValidator,
} from "../../validation/v.ts";
import {
  assertFiniteVector,
  isZeroFiniteVector,
  vectorBlobKernelView,
} from "../../validation/vector.ts";
import type { Engine, TablePlan } from "../engine.ts";
import type { ReadRecorder } from "../access.ts";
import {
  observeStatement,
  type DbStatementObserver,
} from "../statement-observation.ts";
import { assertMutationAccess } from "../../runtime/invocation-state.ts";
import { recordPredicateDependencies } from "./dependencies.ts";
import {
  compilePredicates,
  resolvePredicate,
  type PredicateNode,
} from "./predicate.ts";
import {
  loadVectorRuntime,
  VectorRuntimeUnavailableError,
  type VectorRuntime,
} from "./vector-runtime.ts";
import type { VectorMetric } from "./types.ts";

const quote = (name: string): string => `"${name}"`;
const WINNER_FETCH_SIZE = 256;

interface Candidate {
  readonly id: bigint;
  readonly distance: number;
}

interface RankedCandidates {
  readonly winners: readonly Candidate[];
  readonly candidateRowCount: number;
  readonly retainedRowCount: number;
}

interface NearestExecution {
  readonly matches: Array<{ row: Record<string, unknown>; distance: number }>;
  readonly candidateRowCount: number;
  readonly retainedRowCount: number;
}

interface NearestState {
  readonly predicates: readonly PredicateNode[];
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return compareDistanceAndId(left.distance, left.id, right);
}

function compareDistanceAndId(
  distance: number,
  id: bigint,
  right: Candidate,
): number {
  if (distance < right.distance) return -1;
  if (distance > right.distance) return 1;
  return id < right.id ? -1 : id > right.id ? 1 : 0;
}

/** Worst-first binary heap retaining at most the requested winner count. */
class WinnerHeap {
  private readonly values: Candidate[] = [];

  constructor(private readonly limit: number) {}

  add(id: bigint, distance: number): void {
    if (this.values.length < this.limit) {
      this.values.push({ id, distance });
      this.bubbleUp(this.values.length - 1);
      return;
    }
    if (compareDistanceAndId(distance, id, this.values[0]!) >= 0) return;
    this.values[0] = { id, distance };
    this.bubbleDown(0);
  }

  sorted(): Candidate[] {
    return [...this.values].sort(compareCandidate);
  }

  get size(): number {
    return this.values.length;
  }

  private bubbleUp(start: number): void {
    let position = start;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (compareCandidate(this.values[parent]!, this.values[position]!) >= 0) return;
      [this.values[parent], this.values[position]] = [
        this.values[position]!,
        this.values[parent]!,
      ];
      position = parent;
    }
  }

  private bubbleDown(start: number): void {
    let position = start;
    while (true) {
      const left = position * 2 + 1;
      if (left >= this.values.length) return;
      const right = left + 1;
      const worse = right < this.values.length &&
          compareCandidate(this.values[right]!, this.values[left]!) > 0
        ? right
        : left;
      if (compareCandidate(this.values[position]!, this.values[worse]!) >= 0) return;
      [this.values[position], this.values[worse]] = [
        this.values[worse]!,
        this.values[position]!,
      ];
      position = worse;
    }
  }
}

function vectorColumn(
  plan: TablePlan,
  column: unknown,
): { readonly name: string; readonly validator: VectorValidator; readonly physical: string } {
  if (typeof column !== "string" || !Object.hasOwn(plan.table.columns, column)) {
    throw new ValidationError(`${plan.displayName}.nearest: unknown vector column ${JSON.stringify(column)}`);
  }
  const validator = baseValidator(plan.table.columns[column]!);
  if (validator.kind !== "vector") {
    throw new ValidationError(`${plan.displayName}.nearest: ${column} is not a vector column`);
  }
  const physical = plan.columns.get(column)!.phys[0]?.name;
  if (physical === undefined) {
    throw new Error(`${plan.displayName}.${column}: vector column has no physical storage`);
  }
  return { name: column, validator: validator as VectorValidator, physical };
}

function vectorMetric(plan: TablePlan, options: unknown): VectorMetric {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ValidationError(`${plan.displayName}.nearest: options must contain a metric`);
  }
  const metric = (options as { readonly metric?: unknown }).metric;
  if (metric !== "cosine" && metric !== "l2" && metric !== "dot") {
    throw new ValidationError(
      `${plan.displayName}.nearest: metric must be "cosine", "l2", or "dot"`,
    );
  }
  return metric;
}

function isZero(vector: Float32Array): boolean {
  for (const coordinate of vector) if (coordinate !== 0) return false;
  return true;
}

function distance(
  runtime: VectorRuntime,
  metric: VectorMetric,
  query: Float32Array,
  stored: Float32Array,
  storedPath: string,
  rowId: bigint,
): number | null {
  let result: number;
  switch (metric) {
    case "cosine":
      if (isZeroFiniteVector(stored, storedPath, rowId)) return null;
      result = runtime.angular(query, stored);
      break;
    case "l2":
      result = runtime.euclidean(query, stored);
      break;
    case "dot":
      result = -runtime.dot(query, stored);
      break;
  }
  if (!Number.isFinite(result)) {
    assertFiniteVector(stored, storedPath, rowId);
    throw new VectorRuntimeUnavailableError(
      `NumKong returned a non-finite ${metric} distance for valid stored vectors`,
    );
  }
  if (metric === "cosine" && Math.abs(result) <= Number.EPSILON) return 0;
  return Object.is(result, -0) ? 0 : result;
}

class NearestQueryRuntime {
  constructor(
    private readonly engine: Engine,
    private readonly conn: Database,
    private readonly reads: ReadRecorder | null,
    private readonly plan: TablePlan,
    private readonly vector: ReturnType<typeof vectorColumn>,
    private readonly queryVector: Float32Array,
    private readonly metric: VectorMetric,
    private readonly state: NearestState,
    private readonly observer?: DbStatementObserver,
  ) {}

  where(callback: unknown): NearestQueryRuntime {
    const predicate = resolvePredicate(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.nearest.where`,
    );
    return new NearestQueryRuntime(
      this.engine,
      this.conn,
      this.reads,
      this.plan,
      this.vector,
      this.queryVector,
      this.metric,
      { predicates: [...this.state.predicates, predicate] },
      this.observer,
    );
  }

  async take(count: number): Promise<Array<{ row: Record<string, unknown>; distance: number }>> {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new ValidationError(
        `${this.plan.displayName}.nearest.take: count must be a positive safe integer`,
      );
    }
    return (await this.observed(() => this.execute(count))).matches;
  }

  async first(): Promise<{ row: Record<string, unknown>; distance: number } | null> {
    return (await this.observed(() => this.execute(1))).matches[0] ?? null;
  }

  private execute(count: number): NearestExecution {
    assertMutationAccess();
    const ownsTransaction = !this.conn.inTransaction;
    let transactionOpen = false;
    try {
      if (ownsTransaction) {
        this.conn.exec("BEGIN DEFERRED");
        transactionOpen = true;
      }
      if (this.reads !== null) {
        recordPredicateDependencies(this.plan, this.state.predicates, this.reads);
      }
      const ranked = this.rank(count);
      const rows = this.fetchRows(ranked.winners);
      if (ownsTransaction) {
        this.conn.exec("COMMIT");
        transactionOpen = false;
      }
      return {
        matches: ranked.winners.map((winner) => ({
          row: rows.get(winner.id)!,
          distance: winner.distance,
        })),
        candidateRowCount: ranked.candidateRowCount,
        retainedRowCount: ranked.retainedRowCount,
      };
    } catch (error) {
      if (transactionOpen && this.conn.inTransaction) {
        try {
          this.conn.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `${this.plan.displayName}.nearest failed and its snapshot could not be closed`,
          );
        }
      }
      throw error;
    }
  }

  private rank(count: number): RankedCandidates {
    const predicate = compilePredicates(
      this.state.predicates,
      this.engine.sqliteParameterLimit,
      `${this.plan.displayName}.nearest`,
    );
    const where = [
      `${quote(this.vector.physical)} IS NOT NULL`,
      predicate.sql,
    ].filter((clause) => clause !== "").map((clause) => `(${clause})`).join(" AND ");
    const sql = `SELECT ${quote(this.plan.pk)} AS "__ackerdb_pk", ${quote(this.vector.physical)} AS "__ackerdb_vector" FROM ${quote(this.plan.name)} WHERE ${where}`;
    const statement = this.conn.prepare(sql);
    const runtime = loadVectorRuntime();
    const heap = new WinnerHeap(count);
    const storedPath = `${this.plan.displayName}.${this.vector.name}`;
    let candidateRowCount = 0;
    try {
      for (const raw of statement.iterate(...(predicate.params as never[])) as Iterable<Record<string, unknown>>) {
        candidateRowCount++;
        const id = raw["__ackerdb_pk"];
        if (typeof id !== "bigint") {
          throw new CorruptDatabaseError(
            `${this.plan.displayName}.nearest: stored primary key is not an integer`,
          );
        }
        const stored = vectorBlobKernelView(
          raw["__ackerdb_vector"],
          this.vector.validator.dimensions,
          storedPath,
          id,
        );
        const candidateDistance = distance(
          runtime,
          this.metric,
          this.queryVector,
          stored,
          storedPath,
          id,
        );
        if (candidateDistance !== null) heap.add(id, candidateDistance);
      }
    } finally {
      statement.finalize();
    }
    return {
      winners: heap.sorted(),
      candidateRowCount,
      retainedRowCount: heap.size,
    };
  }

  private fetchRows(winners: readonly Candidate[]): Map<bigint, Record<string, unknown>> {
    const rows = new Map<bigint, Record<string, unknown>>();
    for (let offset = 0; offset < winners.length; offset += WINNER_FETCH_SIZE) {
      const chunk = winners.slice(offset, offset + WINNER_FETCH_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rawRows = this.engine
        .statement(
          this.conn,
          `SELECT ${this.plan.readProjection} FROM ${quote(this.plan.name)} WHERE ${quote(this.plan.pk)} IN (${placeholders})`,
        )
        .all(...(chunk.map(({ id }) => id) as never[])) as Record<string, unknown>[];
      for (const raw of rawRows) {
        const row = this.engine.rowFromSql(this.plan, raw);
        rows.set(row[this.plan.pk] as bigint, row);
      }
    }
    for (const { id } of winners) {
      if (!rows.has(id)) {
        throw new CorruptDatabaseError(
          `${this.plan.displayName}.nearest: winner row ${id} disappeared inside one SQLite snapshot`,
        );
      }
    }
    return rows;
  }

  private async observed(work: () => NearestExecution): Promise<NearestExecution> {
    return await observeStatement(
      this.observer,
      "read",
      this.plan.displayName,
      "nearest",
      work,
      (execution) => execution.matches.length,
      (execution) => ({
        candidateRowCount: execution.candidateRowCount,
        retainedRowCount: execution.retainedRowCount,
      }),
    );
  }
}

/** Construct a validated, bounded exact-nearest query for one direct vector column. */
export function createNearestQuery(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  plan: TablePlan,
  column: unknown,
  query: unknown,
  options: unknown,
  observer?: DbStatementObserver,
): unknown {
  const selected = vectorColumn(plan, column);
  const normalized = selected.validator.check(
    query,
    `${plan.displayName}.nearest.${selected.name}`,
  );
  const queryVector = Float32Array.from(normalized);
  const metric = vectorMetric(plan, options);
  if (metric === "cosine" && isZero(queryVector)) {
    throw new ValidationError(`${plan.displayName}.nearest: cosine query vector must not be zero`);
  }
  return new NearestQueryRuntime(
    engine,
    conn,
    reads,
    plan,
    selected,
    queryVector,
    metric,
    { predicates: [] },
    observer,
  );
}
