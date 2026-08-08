/**
 * Serializable filters over a declared table: the schema-facing half of the
 * contract `database/reads/filter.ts` states in the abstract. A table names the
 * fields it is willing to be filtered on, and an expression that survives
 * validation becomes an ordinary predicate node — the same node a `.where`
 * callback produces, encoded by the same column codec. There is no second query
 * path: a validated filter composes with ordering, cursor pagination,
 * aggregates, and reactive dependency recording because by the time the query
 * sees it, it is indistinguishable from a hand-written predicate.
 *
 * Only the *declaration* throws — naming a column that does not exist is the
 * developer's mistake, found at startup. A caller's expression fails as data.
 *
 * A field must be declared because the filter is an oracle: filtering on a
 * column the query never returns would let a caller binary-search a value it
 * cannot read. The declared list is that boundary, and it is a list of columns,
 * exactly like a declared index.
 */
import type { Result } from "@ackerdb/core";
import { isTableDef, type TableDef } from "../../schema/definition.ts";
import type { ObjectShape } from "../../validation/composites.ts";
import { baseValidator } from "../../validation/validator.ts";
import { ValidationError } from "../../validation/error.ts";
import type { TablePlan } from "../engine.ts";
import {
  foldFilterNode,
  validateFilterExpression,
  type FilterInvalid,
  type FilterableField,
  type ValidatedFilterNode,
} from "../reads/filter.ts";
import { EQUATABLE_KINDS, toSqlPredicateValue, type PredicateNode } from "./predicate.ts";

export {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_FILTER_VALUES,
  type FilterInvalid,
} from "../reads/filter.ts";

declare const TABLE_FILTER: unique symbol;

/**
 * A validated filter, bound to the table whose declared fields validated it.
 * Pass it to that table's `query().where(filter)`.
 */
export interface TableFilter<C extends ObjectShape = ObjectShape> {
  readonly [TABLE_FILTER]: C;
}

export interface FilterableFields<C extends ObjectShape = ObjectShape> {
  /** Validate one wire expression. Failures come back as data, never thrown. */
  validate(expression: unknown): Result<TableFilter<C>, FilterInvalid>;
}

interface TableFilterMeta {
  readonly table: TableDef;
  readonly node: ValidatedFilterNode;
}

const tableFilters = new WeakMap<object, TableFilterMeta>();

/** The runtime meta behind a branded `TableFilter`, if `value` is one. */
export function tableFilterMeta(value: unknown): TableFilterMeta | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? tableFilters.get(value)
    : undefined;
}

/**
 * Declare the columns a table accepts serializable filters on. Build it once
 * beside the schema: the declaration is checked here, so a validated
 * expression only ever describes columns that exist and can be compared.
 */
export function filterableFields<C extends ObjectShape>(
  table: TableDef<C>,
  fields: readonly (keyof C & string)[],
): FilterableFields<C> {
  if (!isTableDef(table)) {
    throw new TypeError("filterableFields: expected a table from defineTable()");
  }
  if (table.kind === "event") {
    throw new ValidationError(
      "filterableFields: event tables never persist rows, so nothing can be filtered",
    );
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ValidationError("filterableFields: declare at least one filterable column");
  }
  const plans = new Map<string, FilterableField>();
  for (const field of fields) {
    if (plans.has(field)) {
      throw new ValidationError(`filterableFields: column ${JSON.stringify(field)} is declared twice`);
    }
    const validator = table.columns[field];
    if (validator === undefined) {
      throw new ValidationError(`filterableFields: unknown column ${JSON.stringify(field)}`);
    }
    const inner = baseValidator(validator);
    if (!EQUATABLE_KINDS.has(inner.kind)) {
      throw new ValidationError(
        `filterableFields: column ${JSON.stringify(field)} (${inner.kind}) cannot be compared`,
      );
    }
    plans.set(field, {
      kind: inner.kind,
      nullable: validator.kind === "nullable",
      check: (value, path) => inner.check(value, path),
    });
  }
  const declared = table as TableDef;
  return {
    validate: (expression) => {
      const validated = validateFilterExpression(plans, expression);
      if (!validated.ok) return validated as Result<TableFilter<C>, FilterInvalid>;
      const filter = Object.freeze({}) as TableFilter;
      tableFilters.set(filter, { table: declared, node: validated.data });
      return { ok: true, data: filter } as Result<TableFilter<C>, FilterInvalid>;
    },
  };
}

/**
 * Compile a validated filter against one table plan. `null` means the filter
 * matches every row, so the query gains no predicate.
 */
export function filterPredicate(plan: TablePlan, meta: TableFilterMeta): PredicateNode | null {
  if (meta.table !== plan.table) {
    throw new ValidationError(
      `${plan.displayName}.query.where: this filter was validated for a different table`,
    );
  }
  return foldFilterNode(
    meta.node,
    (column, value) => toSqlPredicateValue(plan, column, value, false),
    plan.pk,
  );
}
