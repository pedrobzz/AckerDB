/**
 * Serializable filter expressions (#193): the closed wire vocabulary —
 * `eq/neq/gt/gte/lt/lte/anyOf/noneOf` clauses under nested `all`/`any`
 * groups — validated against a table's *declared* filterable fields with
 * failures returned as data, then compiled into the same parameterized
 * predicate nodes ordinary `.where` callbacks produce. A validated filter
 * therefore composes with ordering, cursor pagination, aggregates, and
 * reactive dependency recording for free, and both application functions and
 * the built-in `_studio.*` surface consume this one module.
 *
 * Fields resolve to declared columns; a field on a `jsonb`/`object` column is
 * addressed by path (`metadata.<key>[.<key>...]`) and evaluated with JSON1's
 * `->>` operator, the path bound as a parameter. `eq`/`neq` against `null`
 * test presence (SQL NULL semantics; a missing JSON key reads as NULL).
 */
import type { FilterIssue } from "@ackerdb/core";
import { isTableDef, type TableDef } from "../../schema/definition.ts";
import type { ObjectShape } from "../../validation/composites.ts";
import { baseValidator } from "../../validation/validator.ts";
import { isValidationError, ValidationError } from "../../validation/error.ts";
import type { TablePlan } from "../engine.ts";
import {
  EQUATABLE_KINDS,
  ORDERED_KINDS,
  type ComparisonOperator,
  type PredicateNode,
} from "./predicate.ts";

/** Contract bound: groups may nest at most this deep. */
export const MAX_FILTER_DEPTH = 8;
/** Contract bound: one expression may hold at most this many clauses. */
export const MAX_FILTER_CLAUSES = 128;

const JSON_KINDS = new Set(["jsonb", "object"]);

const OPERATOR_MAP: Readonly<Record<string, ComparisonOperator>> = {
  eq: "eq",
  neq: "ne",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
};

declare const TABLE_FILTER: unique symbol;

/**
 * A successfully validated filter, bound to the table whose fields validated
 * it. Pass it to that table's `query().where(filter)`.
 */
export interface TableFilter<C extends ObjectShape = ObjectShape> {
  readonly [TABLE_FILTER]: C;
}

export type FilterValidation<C extends ObjectShape = ObjectShape> =
  | { readonly ok: true; readonly filter: TableFilter<C> }
  | { readonly ok: false; readonly errors: readonly FilterIssue[] };

/** `true` filters the same-named column; `{ column }` declares an alias. */
export type FilterFieldDeclaration<C extends ObjectShape> =
  | true
  | { readonly column: keyof C & string };

export interface FilterableFields<C extends ObjectShape = ObjectShape> {
  /** Validate one wire expression; failures come back as data, never thrown. */
  validate(expression: unknown): FilterValidation<C>;
}

interface FieldPlan {
  readonly column: string;
  readonly kind: string;
  readonly nullable: boolean;
  readonly json: boolean;
  check(value: unknown, path: string): unknown;
}

/** Logical (checked, un-encoded) clause tree; SQL encoding waits for the plan. */
type ValidatedNode =
  | { readonly kind: "column"; readonly column: string; readonly op: ComparisonOperator; readonly value: unknown }
  | { readonly kind: "columnNull"; readonly column: string; readonly isNull: boolean }
  | { readonly kind: "columnSet"; readonly column: string; readonly negated: boolean; readonly values: readonly unknown[] }
  | { readonly kind: "json"; readonly column: string; readonly path: string; readonly op: ComparisonOperator; readonly value: string | number }
  | { readonly kind: "jsonNull"; readonly column: string; readonly path: string; readonly isNull: boolean }
  | { readonly kind: "jsonSet"; readonly column: string; readonly path: string; readonly negated: boolean; readonly values: readonly (string | number)[] }
  | { readonly kind: "group"; readonly op: "all" | "any"; readonly children: readonly ValidatedNode[] };

interface TableFilterMeta {
  readonly table: TableDef;
  readonly node: ValidatedNode;
}

const tableFilters = new WeakMap<object, TableFilterMeta>();

/** The runtime meta behind a branded `TableFilter`, if `value` is one. */
export function tableFilterMeta(value: unknown): TableFilterMeta | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? tableFilters.get(value)
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the declared-field table once; declaration mistakes are programmer errors and throw. */
export function filterableFields<C extends ObjectShape>(
  table: TableDef<C>,
  fields: Readonly<Record<string, FilterFieldDeclaration<C>>>,
): FilterableFields<C> {
  if (!isTableDef(table)) {
    throw new TypeError("filterableFields: expected a table from defineTable()");
  }
  if (table.kind === "event") {
    throw new ValidationError(
      "filterableFields: event tables never persist rows, so nothing can be filtered",
    );
  }
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    throw new ValidationError("filterableFields: declare at least one filterable field");
  }
  const plans = new Map<string, FieldPlan>();
  for (const [field, declaration] of Object.entries(fields)) {
    if (field.length === 0 || field.includes(".")) {
      throw new ValidationError(
        `filterableFields: field ${JSON.stringify(field)} must not contain "." — dots address JSON paths at filter time`,
      );
    }
    const column = declaration === true ? field : declaration.column;
    if (
      declaration !== true &&
      (!isPlainObject(declaration) || typeof declaration.column !== "string")
    ) {
      throw new ValidationError(
        `filterableFields: field ${JSON.stringify(field)} must be true or { column }`,
      );
    }
    const validator = table.columns[column];
    if (validator === undefined) {
      throw new ValidationError(
        `filterableFields: field ${JSON.stringify(field)} names unknown column ${JSON.stringify(column)}`,
      );
    }
    const inner = baseValidator(validator);
    if (!EQUATABLE_KINDS.has(inner.kind) && !JSON_KINDS.has(inner.kind)) {
      throw new ValidationError(
        `filterableFields: column ${JSON.stringify(column)} (${inner.kind}) is not filterable`,
      );
    }
    plans.set(field, {
      column,
      kind: inner.kind,
      nullable: validator.kind === "nullable",
      json: JSON_KINDS.has(inner.kind),
      check: (value, path) => inner.check(value, path),
    });
  }
  const validator = new FilterValidator(table as TableDef, plans);
  return {
    validate: (expression) => validator.validate(expression) as FilterValidation<C>,
  };
}

interface ResolvedField {
  readonly plan: FieldPlan;
  /** Complete JSON1 path (`$."key"...`) when the field addresses a JSON column. */
  readonly jsonPath: string | undefined;
}

class FilterValidator {
  constructor(
    private readonly table: TableDef,
    private readonly fields: ReadonlyMap<string, FieldPlan>,
  ) {}

  validate(expression: unknown): FilterValidation {
    const issues: FilterIssue[] = [];
    const budget = { clauses: 0, reported: false };
    const node = this.node(expression, "$", 0, budget, issues);
    if (issues.length > 0) return { ok: false, errors: Object.freeze(issues) };
    const filter = Object.freeze({}) as TableFilter;
    tableFilters.set(filter, { table: this.table, node: node! });
    return { ok: true, filter };
  }

  private node(
    raw: unknown,
    path: string,
    depth: number,
    budget: { clauses: number; reported: boolean },
    issues: FilterIssue[],
  ): ValidatedNode | undefined {
    if (!isPlainObject(raw)) {
      issues.push({ path, message: "expected a filter expression object" });
      return undefined;
    }
    const keys = Object.keys(raw);
    if (keys.includes("all") || keys.includes("any")) {
      if (keys.length !== 1) {
        issues.push({
          path,
          message: 'a group has exactly one key: "all" or "any"',
        });
        return undefined;
      }
      const op = keys[0] as "all" | "any";
      const members = raw[op];
      if (!Array.isArray(members)) {
        issues.push({ path: `${path}.${op}`, message: `"${op}" must be an array` });
        return undefined;
      }
      if (depth >= MAX_FILTER_DEPTH) {
        issues.push({
          path,
          message: `groups may not be nested deeper than ${MAX_FILTER_DEPTH} levels`,
        });
        return undefined;
      }
      const children: ValidatedNode[] = [];
      let failed = false;
      for (let index = 0; index < members.length; index++) {
        const child = this.node(
          members[index],
          `${path}.${op}[${index}]`,
          depth + 1,
          budget,
          issues,
        );
        if (child === undefined) failed = true;
        else children.push(child);
      }
      return failed ? undefined : { kind: "group", op, children };
    }
    return this.clause(raw, path, budget, issues);
  }

  private clause(
    raw: Record<string, unknown>,
    path: string,
    budget: { clauses: number; reported: boolean },
    issues: FilterIssue[],
  ): ValidatedNode | undefined {
    budget.clauses++;
    if (budget.clauses > MAX_FILTER_CLAUSES) {
      if (!budget.reported) {
        budget.reported = true;
        issues.push({
          path,
          message: `a filter may hold at most ${MAX_FILTER_CLAUSES} clauses`,
        });
      }
      return undefined;
    }
    const op = raw["op"];
    if (typeof raw["field"] !== "string" || typeof op !== "string") {
      issues.push({
        path,
        message: 'a clause declares "field" and "op" (or is an "all"/"any" group)',
      });
      return undefined;
    }
    const membership = op === "anyOf" || op === "noneOf";
    if (!membership && OPERATOR_MAP[op] === undefined) {
      issues.push({ path: `${path}.op`, message: `unknown operator ${JSON.stringify(op)}` });
      return undefined;
    }
    const valueKey = membership ? "values" : "value";
    for (const key of Object.keys(raw)) {
      if (key !== "field" && key !== "op" && key !== valueKey) {
        issues.push({ path: `${path}.${key}`, message: `unexpected key ${JSON.stringify(key)}` });
        return undefined;
      }
    }
    if (!Object.hasOwn(raw, valueKey)) {
      issues.push({ path, message: `operator "${op}" requires "${valueKey}"` });
      return undefined;
    }
    const field = this.resolveField(raw["field"], `${path}.field`, issues);
    if (field === undefined) return undefined;
    return membership
      ? this.membershipClause(field, op === "noneOf", raw["values"], path, issues)
      : this.comparisonClause(field, op, raw["value"], path, issues);
  }

  private resolveField(
    name: string,
    path: string,
    issues: FilterIssue[],
  ): ResolvedField | undefined {
    const direct = this.fields.get(name);
    if (direct !== undefined) {
      if (direct.json) {
        issues.push({
          path,
          message: `field ${JSON.stringify(name)} is a JSON column — filter one of its keys by path, like ${JSON.stringify(`${name}.<key>`)}`,
        });
        return undefined;
      }
      return { plan: direct, jsonPath: undefined };
    }
    const dot = name.indexOf(".");
    const head = dot < 0 ? name : name.slice(0, dot);
    const root = this.fields.get(head);
    if (root === undefined || dot < 0) {
      issues.push({ path, message: `unknown filterable field ${JSON.stringify(name)}` });
      return undefined;
    }
    if (!root.json) {
      issues.push({
        path,
        message: `field ${JSON.stringify(head)} does not support paths`,
      });
      return undefined;
    }
    const segments = name.slice(dot + 1).split(".");
    let jsonPath = "$";
    for (const segment of segments) {
      if (segment.length === 0 || segment.includes('"')) {
        issues.push({
          path,
          message: `JSON path segments must be non-empty and must not contain '"'`,
        });
        return undefined;
      }
      jsonPath += `."${segment}"`;
    }
    return { plan: root, jsonPath };
  }

  private comparisonClause(
    field: ResolvedField,
    op: string,
    value: unknown,
    path: string,
    issues: FilterIssue[],
  ): ValidatedNode | undefined {
    const operator = OPERATOR_MAP[op]!;
    const equality = op === "eq" || op === "neq";
    if (value === null) {
      if (!equality) {
        issues.push({
          path: `${path}.value`,
          message: `null only combines with "eq" and "neq" (presence tests)`,
        });
        return undefined;
      }
      if (field.jsonPath !== undefined) {
        return {
          kind: "jsonNull",
          column: field.plan.column,
          path: field.jsonPath,
          isNull: op === "eq",
        };
      }
      if (!field.plan.nullable) {
        issues.push({
          path: `${path}.value`,
          message: `field is not nullable`,
        });
        return undefined;
      }
      return { kind: "columnNull", column: field.plan.column, isNull: op === "eq" };
    }
    if (field.jsonPath !== undefined) {
      const encoded = this.jsonValue(value, `${path}.value`, issues);
      if (encoded === undefined) return undefined;
      return {
        kind: "json",
        column: field.plan.column,
        path: field.jsonPath,
        op: operator,
        value: encoded,
      };
    }
    if (!equality && !ORDERED_KINDS.has(field.plan.kind)) {
      issues.push({
        path: `${path}.op`,
        message: `field (${field.plan.kind}) does not support "${op}"`,
      });
      return undefined;
    }
    const checked = this.checkedValue(field.plan, value, `${path}.value`, issues);
    if (checked === undefined) return undefined;
    return { kind: "column", column: field.plan.column, op: operator, value: checked.value };
  }

  private membershipClause(
    field: ResolvedField,
    negated: boolean,
    raw: unknown,
    path: string,
    issues: FilterIssue[],
  ): ValidatedNode | undefined {
    if (!Array.isArray(raw)) {
      issues.push({ path: `${path}.values`, message: '"values" must be an array' });
      return undefined;
    }
    let failed = false;
    if (field.jsonPath !== undefined) {
      const values: (string | number)[] = [];
      for (let index = 0; index < raw.length; index++) {
        const entryPath = `${path}.values[${index}]`;
        if (raw[index] === null) {
          issues.push({
            path: entryPath,
            message: 'null is not allowed in "values" — use eq/neq null',
          });
          failed = true;
          continue;
        }
        const encoded = this.jsonValue(raw[index], entryPath, issues);
        if (encoded === undefined) failed = true;
        else values.push(encoded);
      }
      if (failed) return undefined;
      return { kind: "jsonSet", column: field.plan.column, path: field.jsonPath, negated, values };
    }
    const values: unknown[] = [];
    for (let index = 0; index < raw.length; index++) {
      const entryPath = `${path}.values[${index}]`;
      if (raw[index] === null) {
        issues.push({
          path: entryPath,
          message: 'null is not allowed in "values" — use eq/neq null',
        });
        failed = true;
        continue;
      }
      const checked = this.checkedValue(field.plan, raw[index], entryPath, issues);
      if (checked === undefined) failed = true;
      else values.push(checked.value);
    }
    if (failed) return undefined;
    return { kind: "columnSet", column: field.plan.column, negated, values };
  }

  private checkedValue(
    plan: FieldPlan,
    value: unknown,
    path: string,
    issues: FilterIssue[],
  ): { readonly value: unknown } | undefined {
    try {
      return { value: plan.check(value, path) };
    } catch (error) {
      if (!isValidationError(error)) throw error;
      const message = error.message.startsWith(`${path}: `)
        ? error.message.slice(path.length + 2)
        : error.message;
      issues.push({ path, message });
      return undefined;
    }
  }

  private jsonValue(
    value: unknown,
    path: string,
    issues: FilterIssue[],
  ): string | number | undefined {
    // JSON1's `->>` reads JSON booleans as 0/1 and numbers/strings as
    // themselves; bigints and structures have no comparable `->>` form.
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    issues.push({
      path,
      message: "JSON path values must be strings, numbers, or booleans",
    });
    return undefined;
  }
}

const TRUE: unique symbol = Symbol("filter.true");
const FALSE: unique symbol = Symbol("filter.false");
type FoldedNode = PredicateNode | typeof TRUE | typeof FALSE;

/**
 * Compile a validated filter for one table plan. Returns `null` when the
 * filter matches every row (no predicate to add). Constant folding keeps
 * empty groups exact: `all: []` matches everything, `any: []` nothing.
 */
export function filterPredicate(
  plan: TablePlan,
  meta: TableFilterMeta,
): PredicateNode | null {
  if (meta.table !== plan.table) {
    throw new ValidationError(
      `${plan.displayName}.query.where: this filter was validated for a different table`,
    );
  }
  const folded = fold(plan, meta.node);
  if (folded === TRUE) return null;
  if (folded === FALSE) return { kind: "in", column: plan.pk, values: [] };
  return folded;
}

function encodeColumnValue(plan: TablePlan, column: string, value: unknown): unknown {
  const columnPlan = plan.columns.get(column)!;
  if (columnPlan.kind === "enum") return columnPlan.variantTag!(value as string)!;
  return columnPlan.toSql(value)[0];
}

function fold(plan: TablePlan, node: ValidatedNode): FoldedNode {
  switch (node.kind) {
    case "column":
      return {
        kind: "comparison",
        column: node.column,
        op: node.op,
        value: encodeColumnValue(plan, node.column, node.value),
      };
    case "columnNull":
      return { kind: "null", column: node.column, isNull: node.isNull };
    case "columnSet": {
      if (node.values.length === 0) return node.negated ? TRUE : FALSE;
      const membership: PredicateNode = {
        kind: "in",
        column: node.column,
        values: node.values.map((value) => encodeColumnValue(plan, node.column, value)),
      };
      return node.negated ? { kind: "not", expression: membership } : membership;
    }
    case "json":
      return { kind: "json", column: node.column, path: node.path, op: node.op, value: node.value };
    case "jsonNull":
      return { kind: "jsonNull", column: node.column, path: node.path, isNull: node.isNull };
    case "jsonSet": {
      if (node.values.length === 0) return node.negated ? TRUE : FALSE;
      const membership: PredicateNode = {
        kind: "jsonIn",
        column: node.column,
        path: node.path,
        values: node.values,
      };
      return node.negated ? { kind: "not", expression: membership } : membership;
    }
    case "group": {
      const identity = node.op === "all" ? TRUE : FALSE;
      const absorbing = node.op === "all" ? FALSE : TRUE;
      let combined: FoldedNode = identity;
      for (const child of node.children) {
        const folded = fold(plan, child);
        if (folded === absorbing) return absorbing;
        if (folded === identity) continue;
        combined = combined === identity
          ? folded
          : {
              kind: node.op === "all" ? "and" : "or",
              left: combined as PredicateNode,
              right: folded as PredicateNode,
            };
      }
      return combined;
    }
  }
}
