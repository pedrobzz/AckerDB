/**
 * Cursor pagination, independent of what is being paginated.
 *
 * A cursor is the ordering tuple of the last row a page delivered, encoded
 * opaquely and versioned. Resuming is a lexicographic "strictly after" over
 * that tuple, which is a property of the ordering and the SQL dialect — not of
 * the table, the schema, or the database file the rows live in. Keeping it here
 * is what lets a second store answer with the same contract instead of
 * hand-rolling a second one, and one read contract is the difference between a
 * client that learns pagination once and a client that learns it per surface.
 *
 * The column contract is deliberately one method. A caller that owns a schema
 * checks a decoded value against it; a caller that owns raw rows checks the
 * storage type it stores. Neither has to explain itself to this module.
 */
import { ValidationError } from "../../validation/error.ts";

/** One ordering term: a stored column and the direction the page walks it. */
export interface CursorOrder {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

/**
 * What a store promises about one orderable column. `admit` rejects a decoded
 * storage value the column could never hold, by throwing a `ValidationError`
 * whose message names the path — a cursor arrives from a caller, so an
 * incompatible value is a request error rather than a framework failure.
 */
export interface CursorColumn {
  readonly nullable: boolean;
  admit(value: unknown, path: string): void;
}

type EncodedCursorValue = null | string | number | { readonly bigint: string };

interface CursorPayload {
  readonly version: 1;
  readonly values: readonly EncodedCursorValue[];
}

export function encodeCursorValue(value: unknown): EncodedCursorValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return { bigint: value.toString() };
  throw new Error(`cannot encode query cursor value of type ${typeof value}`);
}

function decodeCursorValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { bigint?: unknown }).bigint === "string"
  ) {
    const encoded = (value as { bigint: string }).bigint;
    if (!/^(?:0|-?[1-9]\d{0,18})$/.test(encoded)) {
      throw new ValidationError(`${path}: invalid bigint`);
    }
    try {
      return BigInt(encoded);
    } catch {
      throw new ValidationError(`${path}: invalid bigint`);
    }
  }
  throw new ValidationError(`${path}: invalid value encoding`);
}

/** Encode one page's ordering tuple into the opaque token a caller sends back. */
export function opaqueCursor(values: readonly unknown[]): string {
  const payload: CursorPayload = {
    version: 1,
    values: values.map(encodeCursorValue),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decode one caller-supplied cursor into the ordering tuple it names, checked
 * against the ordering it must match and the columns it must be admissible for.
 * `path` prefixes every issue, so the message locates the offending position.
 */
export function parseOpaqueCursor(
  cursor: string,
  order: readonly CursorOrder[],
  column: (name: string) => CursorColumn,
  path: string,
): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError(`${path}: malformed cursor`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { values?: unknown }).values) ||
    Object.keys(parsed).some((key) => key !== "version" && key !== "values")
  ) {
    throw new ValidationError(`${path}: malformed versioned cursor`);
  }
  const encodedValues = (parsed as { values: unknown[] }).values;
  if (encodedValues.length !== order.length) {
    throw new ValidationError(
      `${path}: expected ${order.length} ordering values, got ${encodedValues.length}`,
    );
  }
  return encodedValues.map((encoded, position) => {
    const valuePath = `${path}[${position}]`;
    const value = decodeCursorValue(encoded, valuePath);
    const plan = column(order[position]!.column);
    if (value === null) {
      if (!plan.nullable) throw new ValidationError(`${valuePath}: column is not nullable`);
      return null;
    }
    plan.admit(value, valuePath);
    return value;
  });
}

/** SQLite lexicographic `strictly after` for mixed directions and native null ordering. */
export function cursorPredicate(
  order: readonly CursorOrder[],
  values: readonly unknown[],
): { readonly sql: string; readonly params: readonly unknown[] } {
  const branches: string[] = [];
  const params: unknown[] = [];
  for (let position = 0; position < order.length; position++) {
    const prefix: string[] = [];
    for (let prior = 0; prior < position; prior++) {
      const column = `"${order[prior]!.column}"`;
      const value = values[prior];
      if (value === null) {
        prefix.push(`${column} IS NULL`);
      } else {
        prefix.push(`${column} = ?`);
        params.push(value);
      }
    }
    const current = order[position]!;
    const column = `"${current.column}"`;
    const value = values[position];
    let after: string;
    if (current.direction === "asc") {
      if (value === null) {
        after = `${column} IS NOT NULL`;
      } else {
        after = `${column} > ?`;
        params.push(value);
      }
    } else if (value === null) {
      after = "0";
    } else {
      after = `(${column} < ? OR ${column} IS NULL)`;
      params.push(value);
    }
    branches.push(`(${[...prefix, after].join(" AND ")})`);
  }
  return { sql: `(${branches.join(" OR ")})`, params };
}
