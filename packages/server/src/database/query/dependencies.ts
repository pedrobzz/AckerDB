import { stableEncode } from "@dbzz/core";
import type { TablePlan } from "../engine.ts";
import { ixKey, scanKey } from "../keys.ts";
import type { PredicateNode } from "./predicate.ts";

/**
 * Caps both Boolean expansion and the number of reactive index edges recorded
 * by one table read. Crossing the bound deliberately widens to a shorter
 * declared prefix (or the table scan key) instead of retaining unbounded
 * per-subscription state.
 */
export const MAX_REACTIVE_DEPENDENCY_KEYS = 64;

interface ExactValue {
  readonly encoded: string;
  readonly value: unknown;
}

type ExactValues = ReadonlyMap<string, ExactValue>;
type Branch = ReadonlyMap<string, ExactValues>;

interface CandidateKey {
  readonly encodedPrefix: readonly string[];
  readonly key: string;
}

interface IndexCandidate {
  readonly depth: number;
  readonly index: string;
  readonly keys: readonly CandidateKey[];
}

const EMPTY_BRANCH: Branch = new Map();

function exactValues(values: readonly unknown[]): ExactValues | null {
  const exact = new Map<string, ExactValue>();
  for (const value of values) {
    const encoded = stableEncode(value);
    if (exact.has(encoded)) continue;
    exact.set(encoded, { encoded, value });
    if (exact.size > MAX_REACTIVE_DEPENDENCY_KEYS) return null;
  }
  return exact;
}

function exactBranch(column: string, values: readonly unknown[]): Branch[] {
  const exact = exactValues(values);
  if (exact === null) return [EMPTY_BRANCH];
  if (exact.size === 0) return [];
  return [new Map([[column, exact]])];
}

function sameValues(left: ExactValues, right: ExactValues): boolean {
  if (left.size !== right.size) return false;
  for (const encoded of left.keys()) if (!right.has(encoded)) return false;
  return true;
}

/** Exact constraints shared by every alternative remain safe after widening. */
function commonBranch(branches: readonly Branch[]): Branch {
  const first = branches[0];
  if (first === undefined) return EMPTY_BRANCH;
  const common = new Map<string, ExactValues>();
  for (const [column, values] of first) {
    if (branches.every((branch) => {
      const other = branch.get(column);
      return other !== undefined && sameValues(values, other);
    })) {
      common.set(column, values);
    }
  }
  return common;
}

function intersectValues(left: ExactValues, right: ExactValues): ExactValues {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  const intersection = new Map<string, ExactValue>();
  for (const [encoded, value] of smaller) {
    if (larger.has(encoded)) intersection.set(encoded, value);
  }
  return intersection;
}

function mergeBranches(left: Branch, right: Branch): Branch | null {
  const merged = new Map(left);
  for (const [column, rightValues] of right) {
    const leftValues = merged.get(column);
    if (leftValues === undefined) {
      merged.set(column, rightValues);
      continue;
    }
    const intersection = intersectValues(leftValues, rightValues);
    if (intersection.size === 0) return null;
    merged.set(column, intersection);
  }
  return merged;
}

function andBranches(left: readonly Branch[], right: readonly Branch[]): Branch[] {
  if (left.length === 0 || right.length === 0) return [];
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

function orBranches(left: readonly Branch[], right: readonly Branch[]): Branch[] {
  const alternatives = [...left, ...right];
  if (alternatives.length <= MAX_REACTIVE_DEPENDENCY_KEYS) return alternatives;
  return [commonBranch(alternatives)];
}

/**
 * Convert a predicate to bounded positive exact alternatives. Negative and
 * range predicates intentionally contribute no exact constraint; an enclosing
 * AND may still provide a safe declared-index prefix.
 */
function predicateBranches(node: PredicateNode): Branch[] {
  switch (node.kind) {
    case "comparison":
      return node.op === "eq" ? exactBranch(node.column, [node.value]) : [EMPTY_BRANCH];
    case "in":
      return exactBranch(node.column, node.values);
    case "null":
      return node.isNull ? exactBranch(node.column, [null]) : [EMPTY_BRANCH];
    case "between":
    case "not":
      return [EMPTY_BRANCH];
    case "and":
      return andBranches(predicateBranches(node.left), predicateBranches(node.right));
    case "or":
      return orBranches(predicateBranches(node.left), predicateBranches(node.right));
  }
}

function allPredicateBranches(predicates: readonly PredicateNode[]): Branch[] {
  let branches: Branch[] = [EMPTY_BRANCH];
  for (const predicate of predicates) {
    branches = andBranches(branches, predicateBranches(predicate));
  }
  return branches;
}

function candidatesForBranch(plan: TablePlan, branch: Branch): IndexCandidate[] {
  const candidates: IndexCandidate[] = [];
  for (const index of plan.indexes) {
    let prefixes: Array<{ encoded: string[]; values: unknown[] }> = [{ encoded: [], values: [] }];
    let depth = 0;
    for (const column of index.columns) {
      const values = branch.get(column);
      if (values === undefined) break;
      if (values.size > Math.floor(MAX_REACTIVE_DEPENDENCY_KEYS / prefixes.length)) break;

      const expanded: Array<{ encoded: string[]; values: unknown[] }> = [];
      for (const prefix of prefixes) {
        for (const value of values.values()) {
          expanded.push({
            encoded: [...prefix.encoded, value.encoded],
            values: [...prefix.values, value.value],
          });
        }
      }
      prefixes = expanded;
      depth++;
      candidates.push({
        depth,
        index: index.name,
        keys: prefixes.map((prefix) => ({
          encodedPrefix: prefix.encoded,
          key: ixKey(plan.name, index.name, prefix.values),
        })),
      });
    }
  }
  return candidates.sort((left, right) =>
    right.depth - left.depth || left.keys.length - right.keys.length || left.index.localeCompare(right.index)
  );
}

function selectedKeys(candidates: readonly IndexCandidate[]): string[] {
  const selected = candidates
    .flatMap((candidate) => candidate.keys.map((key) => ({ ...key, index: candidate.index })))
    .sort((left, right) => left.encodedPrefix.length - right.encodedPrefix.length);
  const retained = new Map<string, string>();
  for (const candidate of selected) {
    let covered = false;
    for (let depth = 1; depth < candidate.encodedPrefix.length; depth++) {
      const prefix = stableEncode([candidate.index, candidate.encodedPrefix.slice(0, depth)]);
      if (retained.has(prefix)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      retained.set(
        stableEncode([candidate.index, candidate.encodedPrefix]),
        candidate.key,
      );
    }
  }
  return [...retained.values()];
}

function chooseCandidates(candidateSets: readonly (readonly IndexCandidate[])[]): string[] | null {
  if (candidateSets.some((candidates) => candidates.length === 0)) return null;
  const selected = candidateSets.map((candidates) => candidates[0]!);

  while (true) {
    const keys = selectedKeys(selected);
    if (keys.length <= MAX_REACTIVE_DEPENDENCY_KEYS) return keys;

    let best:
      | { readonly branch: number; readonly candidate: IndexCandidate; readonly keyCount: number }
      | undefined;
    for (let branch = 0; branch < selected.length; branch++) {
      const current = selected[branch]!;
      const candidate = candidateSets[branch]!.find(({ depth }) => depth < current.depth);
      if (candidate === undefined) continue;
      const next = selected.with(branch, candidate);
      const keyCount = selectedKeys(next).length;
      if (
        best === undefined ||
        keyCount < best.keyCount ||
        (keyCount === best.keyCount && candidate.depth > best.candidate.depth)
      ) {
        best = { branch, candidate, keyCount };
      }
    }
    if (best === undefined) return null;
    selected[best.branch] = best.candidate;
  }
}

/**
 * Reactive dependencies for a filtered table read. The empty array is valid
 * for a statically contradictory predicate; otherwise an unsafe expression
 * widens to the table scan key.
 */
export function predicateDependencyKeys(
  plan: TablePlan,
  predicates: readonly PredicateNode[],
): readonly string[] {
  const branches = allPredicateBranches(predicates);
  if (branches.length === 0) return [];
  const keys = chooseCandidates(branches.map((branch) => candidatesForBranch(plan, branch)));
  return keys ?? [scanKey(plan.name)];
}
