import { Buffer } from "node:buffer";
import { ValidationError } from "./error.ts";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

/** Canonical proto3-style int64 text. */
export const DECIMAL_PATTERN = "^(?:0|-?[1-9][0-9]*)$";
/** Canonical padded base64, the only bytes form a JSON boundary carries. */
export const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

const DECIMAL = new RegExp(DECIMAL_PATTERN);
const BASE64 = new RegExp(BASE64_PATTERN);

interface JsonState {
  nodes: number;
  readonly active: WeakSet<object>;
}

function visit(value: unknown, path: string, state: JsonState, depth: number): void {
  if (++state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ValidationError(`${path}: standard JSON value is too deeply nested or complex`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value instanceof Uint8Array) {
    throw new ValidationError(`${path}: expected a standard JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${path}: expected a standard JSON value`);
  }
  if (state.active.has(value)) throw new ValidationError(`${path}: cyclic JSON value`);
  state.active.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      visit(value[index], `${path}[${index}]`, state, depth + 1);
    }
  } else {
    for (const [key, field] of Object.entries(value)) {
      visit(field, `${path}.${key}`, state, depth + 1);
    }
  }
  state.active.delete(value);
}

/** Assert bounded, finite standard JSON without interpreting AckerDB wire tags. */
export function assertStandardJson(value: unknown, path: string): void {
  visit(value, path, { nodes: 0, active: new WeakSet() }, 0);
}

function expected(path: string, expectation: string, value: unknown): never {
  const got = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : value instanceof Uint8Array
        ? "bytes"
        : typeof value;
  throw new ValidationError(`${path}: expected ${expectation}, got ${got}`);
}

/** Decode the lossless JSON representation shared by every signed i64 validator. */
export function decodeDecimal(value: unknown, path: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      expected(
        path,
        "a safe integer or a canonical decimal string (values beyond ±2^53-1 must be decimal strings)",
        value,
      );
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    expected(path, "a canonical decimal string", value);
  }
  return BigInt(value);
}

export function encodeDecimal(value: bigint): string {
  return value.toString();
}

/** Decode and verify one canonical padded base64 value. */
export function decodeBase64(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string" || !BASE64.test(value)) {
    expected(path, "a canonical base64 string", value);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    expected(path, "a canonical base64 string", value);
  }
  return new Uint8Array(decoded);
}

export function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

/**
 * The JSON text a standard-JSON boundary emits. An absent value is JSON `null`,
 * the same normalization the AckerDB wire encoder applies, so a body is always a
 * parseable JSON document. Values that are not standard JSON — a bigint, a
 * Uint8Array — throw here; every published boundary converts them first.
 */
export function standardJsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}
