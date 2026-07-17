import { ValidationError } from "./validation-error.ts";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

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

/** Assert bounded, finite standard JSON without interpreting DBZZ wire tags. */
export function assertStandardJson(value: unknown, path: string): void {
  visit(value, path, { nodes: 0, active: new WeakSet() }, 0);
}
