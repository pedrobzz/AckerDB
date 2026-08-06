import type { ColumnPlan } from "../engine.ts";
import type { TableDef } from "../../schema/definition.ts";
import { ValidationError } from "../../validation/error.ts";
import { baseValidator } from "../../validation/validator.ts";

const quote = (name: string): string => `"${name}"`;

export type ComparisonOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

/** JSON-path nodes carry a complete JSON1 path (`$."key"...`) bound as a parameter. */
export type PredicateNode =
  | { readonly kind: "comparison"; readonly column: string; readonly op: ComparisonOperator; readonly value: unknown }
  | { readonly kind: "in"; readonly column: string; readonly values: readonly unknown[] }
  | { readonly kind: "between"; readonly column: string; readonly lower: unknown; readonly upper: unknown }
  | { readonly kind: "null"; readonly column: string; readonly isNull: boolean }
  | { readonly kind: "json"; readonly column: string; readonly path: string; readonly op: ComparisonOperator; readonly value: string | number }
  | { readonly kind: "jsonNull"; readonly column: string; readonly path: string; readonly isNull: boolean }
  | { readonly kind: "jsonIn"; readonly column: string; readonly path: string; readonly values: readonly (string | number)[] }
  | { readonly kind: "and" | "or"; readonly left: PredicateNode; readonly right: PredicateNode }
  | { readonly kind: "not"; readonly expression: PredicateNode };

interface PredicateMeta {
  readonly owner: object;
  readonly node: PredicateNode;
}

interface OrderMeta {
  readonly owner: object;
  readonly column: string;
  readonly direction: "asc" | "desc";
}

interface ColumnReferenceMeta {
  readonly owner: object;
  readonly column: string;
  readonly kind: string;
}

const predicates = new WeakMap<object, PredicateMeta>();
const orders = new WeakMap<object, OrderMeta>();
const columnReferences = new WeakMap<object, ColumnReferenceMeta>();
export const EQUATABLE_KINDS: ReadonlySet<string> = new Set([
  "pk",
  "string",
  "int",
  "float",
  "bigint",
  "identity",
  "file",
  "fileGrant",
  "scheduleAt",
  "boolean",
  "enum",
]);
const ORDERABLE_KINDS = new Set([
  "pk",
  "string",
  "int",
  "float",
  "bigint",
  "identity",
  "scheduleAt",
  "boolean",
]);
export const ORDERED_KINDS: ReadonlySet<string> = new Set([
  "pk",
  "string",
  "int",
  "float",
  "bigint",
  "identity",
  "scheduleAt",
]);

class RuntimePredicate {
  constructor(meta: PredicateMeta) {
    predicates.set(this, meta);
  }

  and(other: unknown): RuntimePredicate {
    return composePredicate(this, other, "and");
  }

  or(other: unknown): RuntimePredicate {
    return composePredicate(this, other, "or");
  }

  not(): RuntimePredicate {
    const meta = predicates.get(this)!;
    return new RuntimePredicate({ owner: meta.owner, node: { kind: "not", expression: meta.node } });
  }
}

function composePredicate(
  left: RuntimePredicate,
  right: unknown,
  kind: "and" | "or",
): RuntimePredicate {
  const leftMeta = predicates.get(left)!;
  const rightMeta = predicateMeta(right, leftMeta.owner, `.${kind}()`);
  return new RuntimePredicate({
    owner: leftMeta.owner,
    node: { kind, left: leftMeta.node, right: rightMeta.node },
  });
}

function predicateMeta(value: unknown, owner: object, path: string): PredicateMeta {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new ValidationError(`${path}: expected a database predicate expression`);
  }
  const meta = predicates.get(value as object);
  if (meta === undefined) {
    throw new ValidationError(`${path}: expected a database predicate expression`);
  }
  if (meta.owner !== owner) {
    throw new ValidationError(`${path}: predicates from different tables cannot be combined`);
  }
  return meta;
}

interface PredicatePlanIngredients {
  readonly columns: ReadonlyMap<string, ColumnPlan>;
  readonly table: TableDef;
  readonly displayName: string;
}

function toSqlPredicateValue(
  plan: PredicatePlanIngredients,
  column: string,
  value: unknown,
  unionDiscriminant: boolean,
): unknown {
  const columnPlan = plan.columns.get(column)!;
  if (value === null) {
    throw new ValidationError(
      `${plan.displayName}.${column}: use .isNull() or .isNotNull() for nullable values`,
    );
  }
  if (columnPlan.kind === "union") {
    if (!unionDiscriminant || typeof value !== "string") {
      throw new ValidationError(`${plan.displayName}.${column}: use .is(variant) for union predicates`);
    }
    const tag = columnPlan.variantTag?.(value);
    if (tag === undefined) {
      throw new ValidationError(
        `${plan.displayName}.${column}: unknown ${columnPlan.typeName} variant ${JSON.stringify(value)}`,
      );
    }
    return tag;
  }
  if (columnPlan.kind === "enum") {
    const tag = typeof value === "string" ? columnPlan.variantTag?.(value) : undefined;
    if (tag === undefined) {
      throw new ValidationError(
        `${plan.displayName}.${column}: unknown ${columnPlan.typeName} variant ${JSON.stringify(value)}`,
      );
    }
    return tag;
  }
  const checked = baseValidator(plan.table.columns[column]!).check(
    value,
    `${plan.displayName}.${column}`,
  );
  return columnPlan.toSql(checked)[0];
}

function ownMethod(target: object, name: string, method: (...args: never[]) => unknown): void {
  Object.defineProperty(target, name, { enumerable: true, value: method });
}

function makeColumnReference(
  plan: PredicatePlanIngredients,
  owner: object,
  column: string,
): object {
  const reference = Object.create(null) as Record<string, unknown>;
  const columnPlan = plan.columns.get(column)!;
  const equatable = EQUATABLE_KINDS.has(columnPlan.kind);
  const orderable = ORDERABLE_KINDS.has(columnPlan.kind);
  const ordered = ORDERED_KINDS.has(columnPlan.kind);
  const expression = (node: PredicateNode): RuntimePredicate =>
    new RuntimePredicate({ owner, node });
  const value = (input: unknown): unknown =>
    toSqlPredicateValue(plan, column, input, false);

  if (equatable) {
    ownMethod(reference, "eq", ((input: unknown) =>
      expression({ kind: "comparison", column, op: "eq", value: value(input) })) as never);
    ownMethod(reference, "ne", ((input: unknown) =>
      expression({ kind: "comparison", column, op: "ne", value: value(input) })) as never);
    ownMethod(reference, "in", ((inputs: unknown) => {
      if (!Array.isArray(inputs)) {
        throw new ValidationError(`${plan.displayName}.${column}.in: expected an array`);
      }
      const values: unknown[] = [];
      const seen = new Set<unknown>();
      for (const input of inputs) {
        const encoded = value(input);
        if (seen.has(encoded)) continue;
        seen.add(encoded);
        values.push(encoded);
      }
      return expression({ kind: "in", column, values });
    }) as never);
  }
  if (orderable) {
    const ascending = makeOrder(owner, column, "asc");
    const descending = makeOrder(owner, column, "desc");
    ownMethod(reference, "asc", (() => ascending) as never);
    ownMethod(reference, "desc", (() => descending) as never);
  }
  if (ordered) {
    for (const op of ["lt", "lte", "gt", "gte"] as const) {
      ownMethod(reference, op, ((input: unknown) =>
        expression({ kind: "comparison", column, op, value: value(input) })) as never);
    }
    ownMethod(reference, "between", ((lower: unknown, upper: unknown) =>
      expression({
        kind: "between",
        column,
        lower: value(lower),
        upper: value(upper),
      })) as never);
  }
  if (columnPlan.kind === "union") {
    ownMethod(reference, "is", ((variant: unknown) =>
      expression({
        kind: "comparison",
        column,
        op: "eq",
        value: toSqlPredicateValue(plan, column, variant, true),
      })) as never);
  }
  if (columnPlan.nullable) {
    ownMethod(reference, "isNull", (() => expression({ kind: "null", column, isNull: true })) as never);
    ownMethod(
      reference,
      "isNotNull",
      (() => expression({ kind: "null", column, isNull: false })) as never,
    );
  }
  columnReferences.set(reference, Object.freeze({ owner, column, kind: columnPlan.kind }));
  return Object.freeze(reference);
}

function makeOrder(owner: object, column: string, direction: "asc" | "desc"): object {
  const expression = Object.freeze(Object.create(null) as object);
  orders.set(expression, Object.freeze({ owner, column, direction }));
  return expression;
}

export interface PredicateEnvironment {
  readonly row: Readonly<Record<string, object>>;
}

/** Build the immutable column-reference object shared by ordinary and nearest predicates. */
export function createPredicateEnvironment(plan: PredicatePlanIngredients): PredicateEnvironment {
  const row: Record<string, object> = Object.create(null);
  for (const column of plan.columns.keys()) {
    Object.defineProperty(row, column, {
      enumerable: true,
      value: makeColumnReference(plan, row, column),
    });
  }
  Object.freeze(row);
  return Object.freeze({ row });
}

/** Execute a `.where` callback exactly once and verify its branded result and table origin. */
export function resolvePredicate(
  environment: PredicateEnvironment,
  callback: unknown,
  path: string,
): PredicateNode {
  if (typeof callback !== "function") {
    throw new ValidationError(`${path}: expected a predicate callback`);
  }
  const result = callback(environment.row);
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as PromiseLike<unknown>).then === "function"
  ) {
    throw new ValidationError(`${path}: predicate callbacks must be synchronous`);
  }
  return predicateMeta(result, environment.row, path).node;
}

export interface QueryOrder {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

/** Execute an order callback once and verify the selected column belongs to this table query. */
export function resolveOrder(
  environment: PredicateEnvironment,
  callback: unknown,
  path: string,
): QueryOrder {
  if (typeof callback !== "function") {
    throw new ValidationError(`${path}: expected an order callback`);
  }
  const result = callback(environment.row);
  if (result === null || (typeof result !== "object" && typeof result !== "function")) {
    throw new ValidationError(`${path}: expected row.column.asc() or row.column.desc()`);
  }
  const meta = orders.get(result as object);
  if (meta === undefined || meta.owner !== environment.row) {
    throw new ValidationError(`${path}: expected an order expression from this table`);
  }
  return meta;
}

/** Numeric kinds accepted by `sum()` and `avg()`. */
export const SUMMABLE_KINDS: ReadonlySet<string> = new Set(["int", "float", "bigint"]);

/** Ordered kinds accepted by `min()` and `max()` — the `lt`/`gt` set. */
export const MINMAX_KINDS: ReadonlySet<string> = ORDERED_KINDS;

export interface AggregateColumn {
  readonly column: string;
  readonly kind: string;
}

/** Execute an aggregate column callback once and verify table origin and column kind. */
export function resolveAggregateColumn(
  environment: PredicateEnvironment,
  callback: unknown,
  path: string,
  kinds: ReadonlySet<string>,
): AggregateColumn {
  if (typeof callback !== "function") {
    throw new ValidationError(`${path}: expected a column callback like (row) => row.column`);
  }
  const result = callback(environment.row);
  if (result === null || (typeof result !== "object" && typeof result !== "function")) {
    throw new ValidationError(`${path}: expected a column reference like (row) => row.column`);
  }
  const meta = columnReferences.get(result as object);
  if (meta === undefined || meta.owner !== environment.row) {
    throw new ValidationError(`${path}: expected a column reference from this table`);
  }
  if (!kinds.has(meta.kind)) {
    throw new ValidationError(
      `${path}: column ${JSON.stringify(meta.column)} (${meta.kind}) is not supported here`,
    );
  }
  return meta;
}

export interface CompiledPredicate {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Compile one predicate tree while appending parameters in SQL placeholder order. */
function compilePredicateSql(
  node: PredicateNode,
  params: unknown[],
  parameterLimit: number,
  path: string,
): string {
  switch (node.kind) {
    case "comparison": {
      params.push(node.value);
      const operator = {
        eq: "=",
        ne: "<>",
        lt: "<",
        lte: "<=",
        gt: ">",
        gte: ">=",
      }[node.op];
      return `${quote(node.column)} ${operator} ?`;
    }
    case "in": {
      if (node.values.length === 0) return "0";
      if (node.values.length > parameterLimit - params.length) {
        throw new ValidationError(
          `${path}: statement requires at least ${params.length + node.values.length} parameters; SQLite supports at most ${parameterLimit}`,
        );
      }
      let placeholders = "";
      for (const value of node.values) {
        if (placeholders !== "") placeholders += ", ";
        placeholders += "?";
        params.push(value);
      }
      return `${quote(node.column)} IN (${placeholders})`;
    }
    case "between":
      params.push(node.lower, node.upper);
      return `${quote(node.column)} BETWEEN ? AND ?`;
    case "null":
      return `${quote(node.column)} IS ${node.isNull ? "" : "NOT "}NULL`;
    case "json": {
      params.push(node.path, node.value);
      const operator = {
        eq: "=",
        ne: "<>",
        lt: "<",
        lte: "<=",
        gt: ">",
        gte: ">=",
      }[node.op];
      return `${quote(node.column)} ->> ? ${operator} ?`;
    }
    case "jsonNull":
      params.push(node.path);
      return `${quote(node.column)} ->> ? IS ${node.isNull ? "" : "NOT "}NULL`;
    case "jsonIn": {
      if (node.values.length === 0) return "0";
      if (node.values.length + 1 > parameterLimit - params.length) {
        throw new ValidationError(
          `${path}: statement requires at least ${params.length + node.values.length + 1} parameters; SQLite supports at most ${parameterLimit}`,
        );
      }
      params.push(node.path);
      let placeholders = "";
      for (const value of node.values) {
        if (placeholders !== "") placeholders += ", ";
        placeholders += "?";
        params.push(value);
      }
      return `${quote(node.column)} ->> ? IN (${placeholders})`;
    }
    case "not":
      return `NOT (${compilePredicateSql(node.expression, params, parameterLimit, path)})`;
    case "and":
    case "or": {
      const left = compilePredicateSql(node.left, params, parameterLimit, path);
      const right = compilePredicateSql(node.right, params, parameterLimit, path);
      return `(${left}) ${node.kind.toUpperCase()} (${right})`;
    }
  }
}

export function compilePredicates(
  nodes: readonly PredicateNode[],
  parameterLimit: number,
  path: string,
): CompiledPredicate {
  const params: unknown[] = [];
  let sql = "";
  for (const node of nodes) {
    if (sql !== "") sql += " AND ";
    sql += `(${compilePredicateSql(node, params, parameterLimit, path)})`;
  }
  if (params.length > parameterLimit) {
    throw new ValidationError(
      `${path}: statement requires ${params.length} parameters; SQLite supports at most ${parameterLimit}`,
    );
  }
  return { sql, params };
}
