import type { Database } from "bun:sqlite";
import { ValidationError } from "../../validation/error.ts";
import type { Engine, TablePlan } from "../engine.ts";
import type { ReadRecorder } from "../access.ts";
import { ftsCorpusKey } from "../keys.ts";
import { runStatement } from "../transaction.ts";
import { assertMutationAccess } from "../../runtime/invocation-state.ts";
import { recordPredicateDependencies } from "./dependencies.ts";
import {
  compilePredicates,
  resolvePredicate,
  type PredicateNode,
} from "./predicate.ts";
import { quoteIdentifier } from "../../shared/sql.ts";

interface FullTextState {
  readonly predicates: readonly PredicateNode[];
}

type FullTextTarget = TablePlan["fullText"][number];

function declaredTarget(plan: TablePlan, column: unknown): FullTextTarget {
  const target = typeof column === "string"
    ? plan.fullText.find((candidate) => candidate.column === column)
    : undefined;
  if (target === undefined) {
    throw new ValidationError(
      `${plan.displayName}.fullText: ${JSON.stringify(column)} is not a declared full-text target`,
    );
  }
  return target;
}

class FullTextQueryRuntime {
  constructor(
    private readonly engine: Engine,
    private readonly conn: Database,
    private readonly reads: ReadRecorder | null,
    private readonly plan: TablePlan,
    private readonly target: FullTextTarget,
    private readonly expression: string | null,
    private readonly state: FullTextState,
  ) {}

  where(callback: unknown): FullTextQueryRuntime {
    const predicate = resolvePredicate(
      this.plan.environment,
      callback,
      `${this.plan.displayName}.fullText.where`,
    );
    return new FullTextQueryRuntime(
      this.engine,
      this.conn,
      this.reads,
      this.plan,
      this.target,
      this.expression,
      { predicates: [...this.state.predicates, predicate] },
    );
  }

  async take(count: number): Promise<Record<string, unknown>[]> {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new ValidationError(
        `${this.plan.displayName}.fullText.take: count must be a positive safe integer`,
      );
    }
    return await this.observed(count);
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (await this.observed(1))[0] ?? null;
  }

  private execute(count: number): Record<string, unknown>[] {
    assertMutationAccess();
    if (this.expression === null) return [];
    if (this.reads !== null) {
      recordPredicateDependencies(this.plan, this.state.predicates, this.reads);
      this.reads.add(ftsCorpusKey(this.plan.name, this.target.column));
    }

    const predicate = compilePredicates(
      this.state.predicates,
      this.engine.sqliteParameterLimit,
      `${this.plan.displayName}.fullText`,
    );
    if (predicate.params.length + 1 > this.engine.sqliteParameterLimit) {
      throw new ValidationError(
        `${this.plan.displayName}.fullText: query uses ${
          predicate.params.length + 1
        } parameters but SQLite supports at most ${this.engine.sqliteParameterLimit}`,
      );
    }
    const matches = "__ackerdb_fts_matches";
    const matchPk = "__ackerdb_fts_pk";
    const matchRank = "__ackerdb_fts_rank";
    const where = predicate.sql === "" ? "" : ` WHERE (${predicate.sql})`;
    const sql = [
      `WITH ${quoteIdentifier(matches)} AS (`,
      `SELECT rowid AS ${quoteIdentifier(matchPk)}, rank AS ${quoteIdentifier(matchRank)}`,
      `FROM ${quoteIdentifier(this.target.indexTable)}`,
      `WHERE ${quoteIdentifier(this.target.indexTable)} MATCH ?`,
      ")",
      `SELECT ${this.plan.readProjection}`,
      `FROM ${quoteIdentifier(this.plan.name)}`,
      `JOIN ${quoteIdentifier(matches)} ON ${quoteIdentifier(this.plan.name)}.${quoteIdentifier(this.plan.pk)} = ${quoteIdentifier(matches)}.${quoteIdentifier(matchPk)}`,
      where,
      `ORDER BY ${quoteIdentifier(matches)}.${quoteIdentifier(matchRank)} ASC, ${quoteIdentifier(this.plan.name)}.${quoteIdentifier(this.plan.pk)} ASC`,
      `LIMIT ${count}`,
    ].join(" ");
    const statement = this.conn.prepare(sql);
    let rows: Record<string, unknown>[];
    try {
      rows = statement
        .all(this.expression, ...(predicate.params as never[])) as Record<string, unknown>[];
    } finally {
      statement.finalize();
    }
    return rows.map((row) => this.engine.rowFromSql(this.plan, row));
  }

  private observed(count: number): Record<string, unknown>[] | Promise<Record<string, unknown>[]> {
    return runStatement(() => this.execute(count));
  }
}

export function createFullTextQuery(
  engine: Engine,
  conn: Database,
  reads: ReadRecorder | null,
  plan: TablePlan,
  column: unknown,
  query: unknown,
): FullTextQueryRuntime {
  const target = declaredTarget(plan, column);
  const expression = engine.prepareFullTextLiteral(
    query,
    `${plan.displayName}.fullText`,
  );
  return new FullTextQueryRuntime(
    engine,
    conn,
    reads,
    plan,
    target,
    expression,
    { predicates: [] },
  );
}
