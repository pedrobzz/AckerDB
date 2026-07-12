/**
 * The dbzz wire format: JSON plus escape objects for values JSON cannot carry.
 *
 *   bigint      -> { "$": "b", "v": "<decimal string>" }
 *   Uint8Array  -> { "$": "x", "v": "<base64>" }
 *   user object -> { "$": "o", "v": { ... } }   (only when it has an own "$" key)
 *
 * `undefined` fields are dropped (matching dbzz's "undefined = absent" write
 * semantics). Non-finite numbers are rejected: they are not representable in
 * JSON and `dbz.number()` only admits finite values.
 */

export class WireError extends Error {}

function toWire(value: unknown): unknown {
  switch (typeof value) {
    case "bigint":
      return { $: "b", v: value.toString() };
    case "number":
      if (!Number.isFinite(value)) throw new WireError(`cannot encode non-finite number ${value}`);
      return value;
    case "string":
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      throw new WireError(`cannot encode value of type ${typeof value}`);
  }
  if (value === null) return null;
  if (value instanceof Uint8Array) return { $: "x", v: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : toWire(v)));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const encoded = toWire(source[key]);
    if (encoded !== undefined) out[key] = encoded;
  }
  return Object.hasOwn(source, "$") ? { $: "o", v: out } : out;
}

function fromWire(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(fromWire);
  const obj = value as Record<string, unknown>;
  if (typeof obj["$"] === "string") {
    switch (obj["$"]) {
      case "b":
        return BigInt(obj["v"] as string);
      case "x":
        return new Uint8Array(Buffer.from(obj["v"] as string, "base64"));
      case "o": {
        // The wrapped object had a literal "$" key: rebuild it field by field
        // without re-interpreting the object itself as an escape.
        const inner = obj["v"] as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(inner)) out[key] = fromWire(inner[key]);
        return out;
      }
      default:
        throw new WireError(`unknown wire escape "${obj["$"]}"`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) out[key] = fromWire(obj[key]);
  return out;
}

/** Encode a value to its wire string. */
export function encode(value: unknown): string {
  const wire = toWire(value);
  return wire === undefined ? "null" : JSON.stringify(wire);
}

/** Decode a wire string back to a value. */
export function decode(text: string): unknown {
  return fromWire(JSON.parse(text));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
  return out;
}

/**
 * Canonical encoding: identical values produce identical strings regardless of
 * object key insertion order. Used to key subscriptions by (query, args).
 */
export function stableEncode(value: unknown): string {
  const wire = toWire(value);
  return wire === undefined ? "null" : JSON.stringify(sortDeep(wire));
}
