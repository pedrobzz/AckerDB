import type { IndexDef } from "../../schema/definition.ts";
import type { ReadRecorder } from "../access.ts";
import type { TablePlan } from "../engine.ts";
import { ixKey, scanKey } from "../keys.ts";
import type { PredicateNode } from "./predicate.ts";

/**
 * Caps both Boolean expansion and reactive index edges for one table read.
 * Crossing it widens to a shorter declared prefix or the table scan key.
 */
export const MAX_REACTIVE_DEPENDENCY_KEYS = 64;

type ScalarStorageValue = null | string | number | bigint;
type ExactValues = readonly ScalarStorageValue[];

interface ExactConstraint {
  readonly column: string;
  readonly values: ExactValues;
}

type Branch = ExactConstraint[];

interface IndexPrefix {
  readonly branch: Branch;
  readonly index: IndexDef;
  readonly depth: number;
  readonly keyCount: number;
}

interface ConcreteIndexPrefix {
  readonly index: IndexDef;
  readonly values: readonly ScalarStorageValue[];
}

function isScalarStorageValue(value: unknown): value is ScalarStorageValue {
  return value === null ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value));
}

function exactBranches(column: string, values: readonly unknown[]): Branch[] {
  const exact: ScalarStorageValue[] = [];
  for (const value of values) {
    if (!isScalarStorageValue(value)) return [[]];
    if (!exact.includes(value)) exact.push(value);
    if (exact.length > MAX_REACTIVE_DEPENDENCY_KEYS) return [[]];
  }
  return exact.length === 0 ? [] : [[{ column, values: exact }]];
}

function exactValueBranch(column: string, value: unknown): Branch[] {
  return isScalarStorageValue(value) ? [[{ column, values: [value] }]] : [[]];
}

function constraint(branch: Branch, column: string): ExactConstraint | undefined {
  for (const candidate of branch) {
    if (candidate.column === column) return candidate;
  }
  return undefined;
}

function sameValues(left: ExactValues, right: ExactValues): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameValueZero(left: ScalarStorageValue, right: ScalarStorageValue): boolean {
  return Object.is(left, right) || (left === 0 && right === 0);
}

function isSameValueZeroPrefix(prefix: ExactValues, values: ExactValues): boolean {
  return prefix.length <= values.length &&
    prefix.every((value, position) => sameValueZero(value, values[position]!));
}

/** Exact constraints shared by every alternative remain safe after widening. */
function commonBranch(branches: readonly Branch[]): Branch {
  const first = branches[0] ?? [];
  if (branches.length === 1) return first;
  return first.filter((expected) =>
    branches.every((candidate) => {
      const actual = constraint(candidate, expected.column);
      return actual !== undefined && sameValues(expected.values, actual.values);
    })
  );
}

function intersectValues(left: ExactValues, right: ExactValues): ExactValues {
  const [smaller, larger] = left.length <= right.length ? [left, right] : [right, left];
  return smaller.filter((value) => larger.includes(value));
}

function mergeBranches(left: Branch, right: Branch): Branch | null {
  const merged = left.slice();
  for (const rightConstraint of right) {
    const position = merged.findIndex((candidate) => candidate.column === rightConstraint.column);
    if (position < 0) {
      merged.push(rightConstraint);
      continue;
    }
    const leftValues = merged[position]!.values;
    if (sameValues(leftValues, rightConstraint.values)) continue;
    const intersection = intersectValues(leftValues, rightConstraint.values);
    if (intersection.length === 0) return null;
    merged[position] = { column: rightConstraint.column, values: intersection };
  }
  return merged;
}

function andBranches(left: Branch[], right: Branch[]): Branch[] {
  if (left.length === 0 || right.length === 0) return [];
  if (left.length === 1 && left[0]!.length === 0) return right;
  if (right.length === 1 && right[0]!.length === 0) return left;
  if (left.length * right.length > MAX_REACTIVE_DEPENDENCY_KEYS) {
    const widened = mergeBranches(commonBranch(left), commonBranch(right));
    return widened === null ? [] : [widened];
  }
  const combined: Branch[] = [];
  for (const leftBranch of left) {
    for (const rightBranch of right) {
      const merged = mergeBranches(leftBranch, rightBranch);
      if (merged !== null) combined.push(merged);
    }
  }
  return combined;
}

function orBranches(left: Branch[], right: Branch[]): Branch[] {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  left.push(...right);
  return left.length <= MAX_REACTIVE_DEPENDENCY_KEYS ? left : [commonBranch(left)];
}

/**
 * Normalize to bounded positive exact alternatives. Negative and range
 * predicates contribute no exact constraint, so an enclosing AND may still
 * retain a safe index prefix.
 */
function predicateBranches(node: PredicateNode): Branch[] {
  switch (node.kind) {
    case "comparison":
      return node.op === "eq" ? exactValueBranch(node.column, node.value) : [[]];
    case "in":
      return exactBranches(node.column, node.values);
    case "null":
      return node.isNull ? exactValueBranch(node.column, null) : [[]];
    case "between":
    case "not":
      return [[]];
    case "and":
      return andBranches(predicateBranches(node.left), predicateBranches(node.right));
    case "or":
      return orBranches(predicateBranches(node.left), predicateBranches(node.right));
  }
}

function allPredicateBranches(predicates: readonly PredicateNode[]): Branch[] {
  if (predicates.length === 0) return [[]];
  let branches = predicateBranches(predicates[0]!);
  for (let position = 1; position < predicates.length; position++) {
    branches = andBranches(branches, predicateBranches(predicates[position]!));
  }
  return branches;
}

function bestPrefix(plan: TablePlan, branch: Branch): IndexPrefix | null {
  let bestIndex = -1;
  let bestDepth = 0;
  let bestKeyCount = 0;
  for (let indexPosition = 0; indexPosition < plan.indexes.length; indexPosition++) {
    const index = plan.indexes[indexPosition]!;
    let depth = 0;
    let keyCount = 1;
    for (const column of index.columns) {
      const values = constraint(branch, column)?.values;
      if (values === undefined ||
        values.length > Math.floor(MAX_REACTIVE_DEPENDENCY_KEYS / keyCount)) {
        break;
      }
      keyCount *= values.length;
      depth++;
    }
    if (
      depth > 0 &&
      (depth > bestDepth || (depth === bestDepth && keyCount < bestKeyCount))
    ) {
      bestIndex = indexPosition;
      bestDepth = depth;
      bestKeyCount = keyCount;
    }
  }
  if (bestIndex < 0) return null;
  return { branch, index: plan.indexes[bestIndex]!, depth: bestDepth, keyCount: bestKeyCount };
}

function retainPrefixValues(
  prefix: IndexPrefix,
  retained: ConcreteIndexPrefix[],
  values: ScalarStorageValue[],
  position: number,
): boolean {
  if (position === prefix.depth) {
    for (const candidate of retained) {
      if (candidate.index === prefix.index && isSameValueZeroPrefix(candidate.values, values)) {
        return true;
      }
    }
    if (retained.length === MAX_REACTIVE_DEPENDENCY_KEYS) return false;
    retained.push({ index: prefix.index, values: values.slice(0, prefix.depth) });
    return true;
  }

  const exact = constraint(prefix.branch, prefix.index.columns[position]!)!.values;
  for (const value of exact) {
    values[position] = value;
    if (!retainPrefixValues(prefix, retained, values, position + 1)) return false;
  }
  return true;
}

/**
 * Select every multi-branch winner before recording: the recorder cannot
 * retract keys if a later uncovered tuple exceeds the retained-key bound.
 * Branch normalization leaves at most 64 prefixes and each winner has at most
 * 64 Cartesian tuples, so pathological selection can enumerate ~4,096 tuples,
 * each with up to 64 retained-prefix short-circuit checks.
 */
function preciseMultiBranchPrefixes(
  plan: TablePlan,
  branches: readonly Branch[],
): ConcreteIndexPrefix[] | null {
  const prefixes: IndexPrefix[] = [];
  for (const branch of branches) {
    const prefix = bestPrefix(plan, branch);
    if (prefix === null) return null;
    prefixes.push(prefix);
  }
  // Shallow-first coverage is monotone, so retained tuples never need removal.
  prefixes.sort((left, right) => left.depth - right.depth);

  const retained: ConcreteIndexPrefix[] = [];
  for (const prefix of prefixes) {
    if (!retainPrefixValues(prefix, retained, [], 0)) return null;
  }
  return retained;
}

function recordPrefixValues(
  table: string,
  prefix: IndexPrefix,
  reads: ReadRecorder,
  values: ScalarStorageValue[],
  position: number,
): void {
  if (position === prefix.depth) {
    reads.add(ixKey(table, prefix.index.name, values));
    return;
  }
  const exact = constraint(prefix.branch, prefix.index.columns[position]!)!.values;
  for (const value of exact) {
    values[position] = value;
    recordPrefixValues(table, prefix, reads, values, position + 1);
  }
}

function recordPrefix(table: string, prefix: IndexPrefix, reads: ReadRecorder): void {
  recordPrefixValues(table, prefix, reads, [], 0);
}

/**
 * Record dependencies directly into the subscription's real recorder.
 * Contradictions record nothing; unsafe expressions widen once through their
 * common declared prefix before falling back to the table scan key.
 */
export function recordPredicateDependencies(
  plan: TablePlan,
  predicates: readonly PredicateNode[],
  reads: ReadRecorder,
): void {
  const branches = allPredicateBranches(predicates);
  if (branches.length === 0) return;

  if (branches.length === 1) {
    const prefix = bestPrefix(plan, branches[0]!);
    if (prefix === null) reads.add(scanKey(plan.name));
    else recordPrefix(plan.name, prefix, reads);
    return;
  }

  const precise = preciseMultiBranchPrefixes(plan, branches);
  if (precise !== null) {
    for (const prefix of precise) {
      reads.add(ixKey(plan.name, prefix.index.name, prefix.values));
    }
    return;
  }

  const prefix = bestPrefix(plan, commonBranch(branches));
  if (prefix === null) reads.add(scanKey(plan.name));
  else recordPrefix(plan.name, prefix, reads);
}
