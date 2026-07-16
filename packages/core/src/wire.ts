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
 *
 * This module runs on every dbzz runtime — Bun servers, browsers, and React
 * Native's Hermes engine — so it is written against bare ECMAScript plus
 * `Uint8Array`: no Node `Buffer`, no `btoa`/`atob`, no text codec globals.
 */

export class WireError extends Error {}

// ---------------------------------------------------------------------------
// Base64 over Uint8Array, platform-neutral and strict.
//
// Bytes travel as standard padded base64 (RFC 4648 alphabet). Both directions
// only ever see strings this encoder produced, so the decoder is strict: it
// requires canonical 4-char groups with at most two trailing `=`, zero
// trailing bits, and rejects every character outside the alphabet (including
// whitespace). Corruption surfaces as a WireError, never a silent skip.
//
// Two implementations with identical observable behavior:
//
//   - Engines with the ES `Uint8Array` base64 API (Bun/JSC, V8) use the
//     native `toBase64`/`fromBase64({ lastChunkHandling: "strict" })` — this
//     is the server hot path, and it matches the removed Buffer conversion's
//     throughput. Native strict decoding still skips ASCII whitespace, which
//     this codec forbids; the shared length pre-checks plus the decoded
//     length assertion below close that gap without rescanning the string.
//   - Engines without it (React Native's Hermes) fall back to pure
//     ECMAScript: encoding via a lazily built table mapping every 12-bit
//     value to its two base64 characters (two reads and one append per three
//     bytes), decoding straight into the exact-size output array. The tables
//     are built on the first byte value seen; pure-JSON traffic never pays
//     for them.

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PAD = 0x3d; // "="

// Feature-detected once at load; both members are from the same proposal, so
// they are either both present or both absent.
const NATIVE_BASE64 =
  typeof Uint8Array.prototype.toBase64 === "function" &&
  typeof Uint8Array.fromBase64 === "function";

interface Base64Tables {
  /** 12-bit value -> its two base64 characters. */
  readonly pairs: readonly string[];
  /** ASCII code -> 6-bit value, -1 for characters outside the alphabet. */
  readonly codes: Int8Array;
}

let base64Tables: Base64Tables | null = null;

function buildBase64Tables(): Base64Tables {
  const pairs = new Array<string>(4096);
  for (let i = 0; i < 4096; i++) {
    pairs[i] = BASE64_ALPHABET[i >> 6]! + BASE64_ALPHABET[i & 63]!;
  }
  const codes = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) codes[BASE64_ALPHABET.charCodeAt(i)] = i;
  base64Tables = { pairs, codes };
  return base64Tables;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Standard padded base64 is the native default, byte-identical to the
  // fallback below.
  if (NATIVE_BASE64) return bytes.toBase64();
  const { pairs } = base64Tables ?? buildBase64Tables();
  const length = bytes.length;
  const full = length - (length % 3);
  let out = "";
  for (let i = 0; i < full; i += 3) {
    const group = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += pairs[group >> 12]! + pairs[group & 0xfff]!;
  }
  const remaining = length - full;
  if (remaining === 1) {
    // 8 data bits left-packed into 12: the pair covers both characters.
    out += pairs[bytes[full]! << 4]! + "==";
  } else if (remaining === 2) {
    // 16 data bits left-packed into 18: a pair plus one single character.
    const group = ((bytes[full]! << 8) | bytes[full + 1]!) << 2;
    out += pairs[group >> 6]! + BASE64_ALPHABET[group & 63]! + "=";
  }
  return out;
}

function base64Code(codes: Int8Array, text: string, index: number): number {
  const charCode = text.charCodeAt(index);
  const value = charCode < 128 ? codes[charCode]! : -1;
  if (value < 0) throw new WireError("invalid base64 in wire bytes value");
  return value;
}

function base64ToBytes(text: string): Uint8Array {
  const length = text.length;
  if (length % 4 !== 0) throw new WireError("invalid base64 in wire bytes value");
  let dataEnd = length;
  if (length > 0 && text.charCodeAt(length - 1) === BASE64_PAD) {
    dataEnd -= text.charCodeAt(length - 2) === BASE64_PAD ? 2 : 1;
  }
  const byteLength = (length >> 2) * 3 - (length - dataEnd);
  if (NATIVE_BASE64) {
    let out: Uint8Array;
    try {
      out = Uint8Array.fromBase64(text, { lastChunkHandling: "strict" });
    } catch {
      throw new WireError("invalid base64 in wire bytes value");
    }
    // Native strict decoding still skips ASCII whitespace; any skipped
    // character makes the decoded length disagree with the length computed
    // from the raw string above, so this assertion closes the gap.
    if (out.length !== byteLength) throw new WireError("invalid base64 in wire bytes value");
    return out;
  }
  const { codes } = base64Tables ?? buildBase64Tables();
  const out = new Uint8Array(byteLength);
  let outIndex = 0;
  let i = 0;
  const fullEnd = dataEnd & ~3;
  for (; i < fullEnd; i += 4) {
    const group =
      (base64Code(codes, text, i) << 18) |
      (base64Code(codes, text, i + 1) << 12) |
      (base64Code(codes, text, i + 2) << 6) |
      base64Code(codes, text, i + 3);
    out[outIndex++] = group >> 16;
    out[outIndex++] = (group >> 8) & 0xff;
    out[outIndex++] = group & 0xff;
  }
  // Trailing groups must be canonical: bits beyond the encoded bytes are
  // required to be zero, so every byte value has exactly one wire encoding.
  const tail = dataEnd - fullEnd;
  if (tail === 2) {
    const group = (base64Code(codes, text, i) << 6) | base64Code(codes, text, i + 1);
    if ((group & 0xf) !== 0) throw new WireError("invalid base64 in wire bytes value");
    out[outIndex] = group >> 4;
  } else if (tail === 3) {
    const group =
      (base64Code(codes, text, i) << 12) |
      (base64Code(codes, text, i + 1) << 6) |
      base64Code(codes, text, i + 2);
    if ((group & 0x3) !== 0) throw new WireError("invalid base64 in wire bytes value");
    out[outIndex++] = group >> 10;
    out[outIndex] = (group >> 2) & 0xff;
  } else if (tail !== 0) {
    // A lone data character cannot carry a whole byte ("a===" style input).
    throw new WireError("invalid base64 in wire bytes value");
  }
  return out;
}

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
  if (value instanceof Uint8Array) return { $: "x", v: bytesToBase64(value) };
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
      case "x": {
        const raw = obj["v"];
        if (typeof raw !== "string") throw new WireError("wire bytes value must be a string");
        return base64ToBytes(raw);
      }
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
