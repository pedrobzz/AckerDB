/**
 * The descriptor seam: one per-kind table carrying the facets the storage and
 * migration layers used to re-derive in their own switches — physical SQLite
 * type, scalar wire encode/decode, and structural validation. Adding a kind is
 * one entry here; every descriptor-driven site reads its facet from this table.
 *
 * Two facets stay at their sites by necessity: enum/union encode/decode need the
 * site-specific tag maps (live engine tags, a step's interned tags, an old
 * snapshot's tags), and the CLI's structural TYPE renderer emits TypeScript text
 * (a codegen concern owning its own error type), so it stays co-located in the
 * CLI as a table keyed by these same kinds. DDL type and `check` still live here.
 */
import { decode, encode, WireError } from "@dbzz/core";
import { ValidationError, type Descriptor } from "../v.ts";

export type SqlType = "TEXT" | "REAL" | "INTEGER" | "BLOB";

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  return typeof value;
}

interface CheckArgs {
  desc: Descriptor;
  value: unknown;
  path: string;
  /** Throw `${path}: expected ${what}, got ${describeValue(value)}` when `ok` is false. */
  expect: (ok: boolean, what: string) => void;
}
type CheckFn = (args: CheckArgs) => unknown;

export interface DescriptorKind {
  /** SQLite type of the single-column layout; absent for pk/union (custom DDL) and non-storable kinds. */
  sqlType?: SqlType;
  /** Wire-encode a non-null scalar; absent means identity (or a tag/identity-mapped kind, whose codec lives at its site). */
  encode?: (value: unknown) => unknown;
  /** Wire-decode a stored non-null scalar; absent means identity. */
  decode?: (value: unknown) => unknown;
  /** Structural validation against this descriptor; returns the normalized value. */
  check: CheckFn;
}

/** A `check` that asserts a predicate and passes the value through unchanged. */
const guard = (ok: (v: unknown) => boolean, what: string): CheckFn => ({ value, expect }) => {
  expect(ok(value), what);
  return value;
};

const checkFiniteNumber = guard((v) => typeof v === "number" && Number.isFinite(v), "finite number");
const checkSafeInteger = guard((v) => typeof v === "number" && Number.isSafeInteger(v), "safe integer");
const checkI64: CheckFn = ({ value, path, expect }) => {
  expect(typeof value === "bigint", "bigint");
  if ((value as bigint) < I64_MIN || (value as bigint) > I64_MAX) throw new ValidationError(`${path}: bigint out of 64-bit range`);
  return value;
};
const wire = { encode: (v: unknown) => encode(v), decode: (v: unknown) => decode(v as string) };

const KINDS: Record<string, DescriptorKind> = {
  nullable: {
    check: ({ desc, value, path }) =>
      value === null ? null : checkDescriptor(desc["inner"] as Descriptor, value, path),
  },
  optional: {
    check: ({ desc, value, path }) =>
      value === undefined ? undefined : checkDescriptor(desc["inner"] as Descriptor, value, path),
  },
  nullish: {
    check: ({ desc, value, path }) =>
      value === null || value === undefined
        ? value
        : checkDescriptor(desc["inner"] as Descriptor, value, path),
  },
  pk: { check: guard((v) => typeof v === "bigint", "bigint (primary key)") },
  string: { sqlType: "TEXT", check: guard((v) => typeof v === "string", "string") },
  int: { sqlType: "INTEGER", decode: (v) => Number(v), check: checkSafeInteger },
  float: { sqlType: "REAL", decode: (v) => Number(v), check: checkFiniteNumber },
  scheduleAt: { sqlType: "REAL", decode: (v) => Number(v), check: checkFiniteNumber },
  bigint: { sqlType: "INTEGER", check: checkI64 },
  identity: { sqlType: "INTEGER", check: checkI64 },
  boolean: {
    sqlType: "INTEGER",
    encode: (v) => (v ? 1 : 0),
    decode: (v) => v === 1n || v === 1,
    check: guard((v) => typeof v === "boolean", "boolean"),
  },
  bytes: { sqlType: "BLOB", check: guard((v) => v instanceof Uint8Array, "Uint8Array") },
  enum: {
    sqlType: "INTEGER",
    check: ({ desc, value, expect }) => {
      const values = desc["values"] as string[];
      expect(typeof value === "string" && values.includes(value), `one of ${values.map((v) => JSON.stringify(v)).join(" | ")}`);
      return value;
    },
  },
  literal: {
    check: ({ desc, value, path }) => {
      const lit = decode(JSON.stringify(desc["v"]));
      if (value !== lit) throw new ValidationError(`${path}: expected literal ${describeValue(lit)}, got ${describeValue(value)}`);
      return value;
    },
  },
  tag: {
    check: ({ value, expect }) => {
      expect(value === null || value === undefined, "null (payload-less variant)");
      return null;
    },
  },
  array: {
    sqlType: "TEXT",
    ...wire,
    check: ({ desc, value, path, expect }) => {
      expect(Array.isArray(value), "array");
      const el = desc["el"] as Descriptor;
      return (value as unknown[]).map((v, i) => checkDescriptor(el, v, `${path}[${i}]`));
    },
  },
  object: {
    sqlType: "TEXT",
    ...wire,
    check: ({ desc, value, path, expect }) => {
      expect(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array), "object");
      const shape = desc["shape"] as Record<string, Descriptor>;
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!(key in shape) && input[key] !== undefined) throw new ValidationError(`${path}: unknown field "${key}"`);
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const field = shape[key]!;
        if (
          !Object.hasOwn(input, key) &&
          (field["k"] === "optional" || field["k"] === "nullish")
        ) {
          continue;
        }
        out[key] = checkDescriptor(field, input[key], `${path}.${key}`);
      }
      return out;
    },
  },
  union: {
    check: ({ desc, value, path, expect }) => {
      expect(value !== null && typeof value === "object" && !Array.isArray(value), "{ tag, value }");
      const input = value as Record<string, unknown>;
      const members = desc["members"] as Record<string, Descriptor>;
      const variant = input["tag"];
      if (typeof variant !== "string" || !(variant in members)) {
        throw new ValidationError(`${path}.tag: expected one of ${Object.keys(members).map((v) => JSON.stringify(v)).join(" | ")}`);
      }
      for (const key of Object.keys(input)) {
        if (key !== "tag" && key !== "value" && input[key] !== undefined) {
          throw new ValidationError(`${path}: unknown field "${key}" on union value`);
        }
      }
      const member = members[variant]!;
      if (
        !Object.hasOwn(input, "value") &&
        (member["k"] === "optional" || member["k"] === "nullish")
      ) {
        return { tag: variant };
      }
      return { tag: variant, value: checkDescriptor(member, input["value"], `${path}.value`) };
    },
  },
  jsonb: {
    sqlType: "TEXT",
    ...wire,
    check: ({ value, path }) => {
      if (value === undefined) throw new ValidationError(`${path}: expected JSON value, got undefined`);
      try {
        encode(value);
      } catch (error) {
        if (error instanceof WireError) throw new ValidationError(`${path}: not wire-encodable: ${error.message}`);
        throw error;
      }
      return value;
    },
  },
};

const identity = (value: unknown): unknown => value;

/** The SQLite type of a kind's single-column layout, or `undefined` when it has none (pk/union/non-storable). */
export function sqlTypeOf(kind: string): SqlType | undefined {
  return KINDS[kind]?.sqlType;
}

/** The construction-time wire encoder for a scalar `kind` (identity when it stores verbatim). */
export function scalarEncoder(kind: string): (value: unknown) => unknown {
  return KINDS[kind]?.encode ?? identity;
}

/** The construction-time wire decoder for a scalar `kind` (identity when it stores verbatim). */
export function scalarDecoder(kind: string): (value: unknown) => unknown {
  return KINDS[kind]?.decode ?? identity;
}

/**
 * Structural mirror of the v validators over a descriptor, for migration
 * transform output and emits: kind + finiteness checks, i64 range, enum/union
 * membership with payload recursion, strict object keys, jsonb wire-encodability.
 * Returns the normalized value while preserving optional-key presence; unknown keys reject.
 */
export function checkDescriptor(desc: Descriptor, value: unknown, path: string): unknown {
  const spec = KINDS[desc["k"] as string];
  if (spec === undefined) throw new ValidationError(`${path}: unsupported descriptor kind "${String(desc["k"])}"`);
  const expect = (ok: boolean, what: string): void => {
    if (!ok) throw new ValidationError(`${path}: expected ${what}, got ${describeValue(value)}`);
  };
  return spec.check({ desc, value, path, expect });
}
