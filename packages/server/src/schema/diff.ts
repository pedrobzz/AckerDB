/**
 * The pure structural diff: what changed between two schema snapshots, as a
 * typed change list, with no database, engine, or tag maps involved. It is a
 * total function of `(current, target)` — the seam that reconciliation's
 * data-dependent planner consumes today, and that shape classification and
 * migration generation (which never open a database) consume next. Every
 * distinction reconciliation acts on is recoverable here: table
 * added/dropped/kind-changed, per-column add/drop/type/nullability/variant
 * deltas, per-index add/drop/change with the uniqueness that governs the
 * change's safety class, and full-text target additions/drops.
 */
import type { Descriptor } from "../validation/validator.ts";
import type { SchemaSnapshot, TableSnapshot } from "./snapshot.ts";

export interface VariantChange {
  variant: string;
  op: "added" | "removed" | "payload-changed";
}

export type ColumnChange =
  | { op: "added"; column: string; nullable: boolean }
  | { op: "dropped"; column: string }
  | { op: "type-changed"; column: string }
  | {
      op: "constraints-changed";
      column: string;
      direction: "loosen" | "tighten";
      current: Descriptor;
      target: Descriptor;
    }
  | { op: "nullability-changed"; column: string; to: "nullable" | "required" }
  | ({
      op: "variants-changed";
      column: string;
      variants: VariantChange[];
    } & (
      | { kind: "enum"; typeName: string }
      | { kind: "discriminatedUnion" }
    ));

/** `unique` is the flag of the resulting index (added/changed) or the removed one (dropped). */
export interface IndexChange {
  name: string;
  op: "added" | "dropped" | "changed";
  unique: boolean;
}

export interface FullTextChange {
  column: string;
  op: "added" | "dropped";
}

export type TableChange =
  | { op: "table-added"; table: string; kind: "table" | "event" }
  | { op: "table-dropped"; table: string; kind: "table" | "event" }
  | { op: "table-kind-changed"; table: string; from: "table" | "event"; to: "table" | "event" }
  | { op: "event-updated"; table: string }
  | {
      op: "table-altered";
      table: string;
      columns: ColumnChange[];
      indexes: IndexChange[];
      fullText: FullTextChange[];
    };

export type SchemaDiff = TableChange[];

export interface Named {
  kind: "enum";
  name: string;
  variants: string[];
}

export function unwrapDesc(desc: Descriptor): { base: Descriptor; nullable: boolean } {
  return desc["k"] === "nullable"
    ? { base: desc["inner"] as Descriptor, nullable: true }
    : { base: desc, nullable: false };
}

export function namedOf(desc: Descriptor): Named | null {
  const { base } = unwrapDesc(desc);
  if (base["k"] === "enum") {
    return { kind: "enum", name: base["name"] as string, variants: [...(base["values"] as string[])] };
  }
  return null;
}

/**
 * How two descriptors relate when their storage/TypeScript shape is held
 * constant. The walk is kind-aware: only the durable constraint slots on the
 * five constrained validator kinds are ignored for structural comparison, so
 * an object field literally named `min`, `max`, or `regex`
 * remains ordinary schema structure.
 */
export type ConstraintDirection = "same" | "loosen" | "tighten" | "incompatible";

function structuralDescriptor(desc: Descriptor): unknown {
  switch (desc["k"]) {
    case "string":
    case "int":
    case "float":
    case "bigint":
      return { k: desc["k"] };
    case "array":
      return { k: "array", el: structuralDescriptor(desc["el"] as Descriptor) };
    case "object": {
      const shape = Object.create(null) as Record<string, unknown>;
      for (const [key, field] of Object.entries(desc["shape"] as Record<string, Descriptor>)) {
        shape[key] = structuralDescriptor(field);
      }
      return { k: "object", shape };
    }
    case "discriminatedUnion": {
      const members = discriminatedMembers(desc);
      return {
        k: "discriminatedUnion",
        discriminator: desc["discriminator"],
        members: [...members].map(([variant, member]) => [variant, structuralDescriptor(member)]),
      };
    }
    case "nullable":
    case "optional":
    case "nullish":
      return { k: desc["k"], inner: structuralDescriptor(desc["inner"] as Descriptor) };
    default:
      return desc;
  }
}

type ConstraintMotion = Exclude<ConstraintDirection, "incompatible">;

function mergeMotion(current: ConstraintMotion, next: ConstraintMotion): ConstraintMotion {
  if (current === "tighten" || next === "tighten") return "tighten";
  if (current === "loosen" || next === "loosen") return "loosen";
  return "same";
}

function compareBound(
  before: unknown,
  after: unknown,
  side: "min" | "max",
  bigint: boolean,
): ConstraintMotion {
  if (before === after) return "same";
  if (before === undefined) return "tighten";
  if (after === undefined) return "loosen";
  const oldValue = bigint ? BigInt(before as string) : before as number;
  const newValue = bigint ? BigInt(after as string) : after as number;
  if (oldValue === newValue) return "same";
  const narrowed = side === "min" ? newValue > oldValue : newValue < oldValue;
  return narrowed ? "tighten" : "loosen";
}

function localConstraintMotion(before: Descriptor, after: Descriptor): ConstraintMotion {
  const kind = before["k"];
  if (kind !== "string" && kind !== "int" && kind !== "float" && kind !== "bigint" && kind !== "array") {
    return "same";
  }
  let motion = compareBound(before["min"], after["min"], "min", kind === "bigint");
  motion = mergeMotion(motion, compareBound(before["max"], after["max"], "max", kind === "bigint"));
  if (kind === "string" && before["regex"] !== after["regex"]) {
    // A changed pattern is tightening: proving regex-language implication is
    // intentionally outside the schema engine. Removing one is a loosening.
    motion = mergeMotion(motion, after["regex"] === undefined ? "loosen" : "tighten");
  }
  return motion;
}

function nestedConstraintMotion(before: Descriptor, after: Descriptor): ConstraintMotion {
  let motion = localConstraintMotion(before, after);
  switch (before["k"]) {
    case "array":
      return mergeMotion(
        motion,
        nestedConstraintMotion(before["el"] as Descriptor, after["el"] as Descriptor),
      );
    case "object": {
      const oldShape = before["shape"] as Record<string, Descriptor>;
      const newShape = after["shape"] as Record<string, Descriptor>;
      for (const key of Object.keys(oldShape)) {
        motion = mergeMotion(motion, nestedConstraintMotion(oldShape[key]!, newShape[key]!));
      }
      return motion;
    }
    case "discriminatedUnion": {
      const oldMembers = discriminatedMembers(before);
      const newMembers = discriminatedMembers(after);
      for (const [variant, member] of oldMembers) {
        motion = mergeMotion(motion, nestedConstraintMotion(member, newMembers.get(variant)!));
      }
      return motion;
    }
    case "nullable":
    case "optional":
    case "nullish":
      return mergeMotion(
        motion,
        nestedConstraintMotion(before["inner"] as Descriptor, after["inner"] as Descriptor),
      );
    default:
      return motion;
  }
}

export function constraintDirection(before: Descriptor, after: Descriptor): ConstraintDirection {
  if (JSON.stringify(structuralDescriptor(before)) !== JSON.stringify(structuralDescriptor(after))) {
    return "incompatible";
  }
  return nestedConstraintMotion(before, after);
}

export function diffSnapshots(current: SchemaSnapshot, target: SchemaSnapshot): SchemaDiff {
  const diff: SchemaDiff = [];
  const tables = new Set([...Object.keys(current.tables), ...Object.keys(target.tables)]);
  for (const table of [...tables].sort()) {
    const hasOldTable = Object.hasOwn(current.tables, table);
    const hasNewTable = Object.hasOwn(target.tables, table);
    if (!hasOldTable) {
      diff.push({ op: "table-added", table, kind: target.tables[table]!.kind });
      continue;
    }
    if (!hasNewTable) {
      diff.push({ op: "table-dropped", table, kind: current.tables[table]!.kind });
      continue;
    }
    const oldTable = current.tables[table]!;
    const newTable = target.tables[table]!;
    if (oldTable.kind !== newTable.kind) {
      diff.push({ op: "table-kind-changed", table, from: oldTable.kind, to: newTable.kind });
    } else if (oldTable.kind === "event") {
      if (JSON.stringify(oldTable) !== JSON.stringify(newTable)) diff.push({ op: "event-updated", table });
    } else {
      const columns = diffColumns(oldTable, newTable);
      const indexes = diffIndexes(oldTable, newTable);
      const fullText = diffFullText(oldTable, newTable);
      if (columns.length > 0 || indexes.length > 0 || fullText.length > 0) {
        diff.push({ op: "table-altered", table, columns, indexes, fullText });
      }
    }
  }
  return diff;
}

function diffColumns(oldTable: TableSnapshot, newTable: TableSnapshot): ColumnChange[] {
  const changes: ColumnChange[] = [];
  for (const column of Object.keys(newTable.columns)) {
    const newDesc = newTable.columns[column]!;
    if (!Object.hasOwn(oldTable.columns, column)) {
      changes.push({ op: "added", column, nullable: unwrapDesc(newDesc).nullable });
      continue;
    }
    const oldDesc = oldTable.columns[column]!;
    if (JSON.stringify(oldDesc) === JSON.stringify(newDesc)) continue;
    const direction = constraintDirection(oldDesc, newDesc);
    if (direction === "loosen" || direction === "tighten") {
      changes.push({
        op: "constraints-changed",
        column,
        direction,
        current: oldDesc,
        target: newDesc,
      });
      continue;
    }
    if (direction === "same") continue;
    const variants = diffVariants(oldDesc, newDesc) ?? diffDiscriminatedVariants(oldDesc, newDesc);
    if (variants !== null) {
      if (variants.changes.length > 0) {
        changes.push(variants.kind === "enum"
          ? { op: "variants-changed", column, kind: "enum", typeName: variants.typeName, variants: variants.changes }
          : { op: "variants-changed", column, kind: "discriminatedUnion", variants: variants.changes });
      }
      continue;
    }
    const { base: oldBase, nullable: wasNullable } = unwrapDesc(oldDesc);
    const { base: newBase, nullable: isNullable } = unwrapDesc(newDesc);
    if (JSON.stringify(oldBase) === JSON.stringify(newBase)) {
      changes.push({ op: "nullability-changed", column, to: isNullable ? "nullable" : "required" });
    } else {
      changes.push({ op: "type-changed", column });
    }
  }
  for (const column of Object.keys(oldTable.columns)) {
    if (!Object.hasOwn(newTable.columns, column)) changes.push({ op: "dropped", column });
  }
  return changes;
}

/**
 * Variant-level delta for a top-level enum column whose type name and
 * nullability are unchanged. `null` means this is not a variant change — the
 * column is a genuine type change and the caller classifies it as one.
 */
function diffVariants(oldDesc: Descriptor, newDesc: Descriptor): {
  kind: "enum";
  typeName: string;
  changes: VariantChange[];
} | null {
  const oldNamed = namedOf(oldDesc);
  const newNamed = namedOf(newDesc);
  if (
    oldNamed === null ||
    newNamed === null ||
    oldNamed.kind !== newNamed.kind ||
    oldNamed.name !== newNamed.name ||
    unwrapDesc(oldDesc).nullable !== unwrapDesc(newDesc).nullable
  ) {
    return null;
  }
  const changes: VariantChange[] = [];
  for (const variant of oldNamed.variants) {
    if (!newNamed.variants.includes(variant)) {
      changes.push({ variant, op: "removed" });
    }
  }
  for (const variant of newNamed.variants) {
    if (!oldNamed.variants.includes(variant)) changes.push({ variant, op: "added" });
  }
  return { kind: "enum", typeName: newNamed.name, changes };
}

function discriminatedMembers(desc: Descriptor): Map<string, Descriptor> {
  const entries = Object.entries(desc["members"] as Record<string, Descriptor>);
  entries.sort(([left], [right]) => left.localeCompare(right));
  return new Map(entries);
}

function diffDiscriminatedVariants(oldDesc: Descriptor, newDesc: Descriptor): {
  kind: "discriminatedUnion";
  changes: VariantChange[];
} | null {
  const oldBase = unwrapDesc(oldDesc);
  const newBase = unwrapDesc(newDesc);
  if (
    oldBase.base["k"] !== "discriminatedUnion" ||
    newBase.base["k"] !== "discriminatedUnion" ||
    oldBase.base["discriminator"] !== newBase.base["discriminator"] ||
    oldBase.nullable !== newBase.nullable
  ) {
    return null;
  }
  const before = discriminatedMembers(oldBase.base);
  const after = discriminatedMembers(newBase.base);
  const changes: VariantChange[] = [];
  for (const [key, member] of before) {
    const target = after.get(key);
    if (target === undefined) changes.push({ variant: key, op: "removed" });
    else if (JSON.stringify(member) !== JSON.stringify(target)) {
      changes.push({ variant: key, op: "payload-changed" });
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key)) changes.push({ variant: key, op: "added" });
  }
  return {
    kind: "discriminatedUnion",
    changes,
  };
}

function diffIndexes(oldTable: TableSnapshot, newTable: TableSnapshot): IndexChange[] {
  const oldIx = new Map(oldTable.indexes.map((ix) => [ix.name, ix]));
  const newIx = new Map(newTable.indexes.map((ix) => [ix.name, ix]));
  const changes: IndexChange[] = [];
  for (const name of [...new Set([...oldIx.keys(), ...newIx.keys()])].sort()) {
    const before = oldIx.get(name);
    const after = newIx.get(name);
    if (before === undefined) changes.push({ name, op: "added", unique: after!.unique });
    else if (after === undefined) changes.push({ name, op: "dropped", unique: before.unique });
    else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ name, op: "changed", unique: after.unique });
    }
  }
  return changes;
}

function diffFullText(
  oldTable: TableSnapshot,
  newTable: TableSnapshot,
): FullTextChange[] {
  const before = new Set(oldTable.fullText);
  const after = new Set(newTable.fullText);
  const changes: FullTextChange[] = [];
  for (const column of [...before].filter((name) => !after.has(name)).sort()) {
    changes.push({ column, op: "dropped" });
  }
  for (const column of [...after].filter((name) => !before.has(name)).sort()) {
    changes.push({ column, op: "added" });
  }
  return changes;
}
