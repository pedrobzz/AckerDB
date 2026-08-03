export type TelemetryValue =
  | null
  | string
  | number
  | boolean
  | bigint
  | Uint8Array
  | readonly TelemetryValue[]
  | TelemetryMetadata;

export interface TelemetryMetadata {
  readonly [key: string]: TelemetryValue;
}

export interface PreparedTelemetryMetadata {
  readonly metadata?: TelemetryMetadata;
  readonly truncated: boolean;
  readonly malformed: boolean;
}

const MAX_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 128;
const MAX_STRING_LENGTH = 8_192;
const MAX_BYTES_LENGTH = 16_384;
const MAX_TOTAL_CHARACTERS = 12_000;
const MAX_TOTAL_NODES = 512;
const INVALID_VALUE = "[Unsupported telemetry value]";
const TRUNCATED_VALUE = "[Truncated]";

interface NormalizationState {
  readonly ancestors: WeakSet<object>;
  remainingCharacters: number;
  remainingBytes: number;
  remainingNodes: number;
  truncated: boolean;
  malformed: boolean;
}

function normalizedString(value: string, state: NormalizationState): string {
  const length = Math.min(value.length, MAX_STRING_LENGTH, state.remainingCharacters);
  state.remainingCharacters -= length;
  if (length === value.length) return value;
  state.truncated = true;
  return `${value.slice(0, length)}${TRUNCATED_VALUE}`;
}

function normalizeValue(
  value: unknown,
  depth: number,
  state: NormalizationState,
): TelemetryValue {
  if (state.remainingNodes-- <= 0) {
    state.truncated = true;
    return TRUNCATED_VALUE;
  }
  if (value === null || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "string") return normalizedString(value, state);
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    state.malformed = true;
    return INVALID_VALUE;
  }
  if (value instanceof Uint8Array) {
    const length = Math.min(value.byteLength, MAX_BYTES_LENGTH, state.remainingBytes);
    state.remainingBytes -= length;
    if (length < value.byteLength) state.truncated = true;
    return new Uint8Array(value.subarray(0, length));
  }
  if (typeof value !== "object") {
    state.malformed = true;
    return INVALID_VALUE;
  }
  if (depth >= MAX_DEPTH || state.ancestors.has(value)) {
    state.truncated = true;
    return TRUNCATED_VALUE;
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_COLLECTION_ITEMS);
      const normalized: TelemetryValue[] = [];
      for (let index = 0; index < length; index++) {
        let item: unknown;
        try {
          item = value[index];
        } catch {
          state.malformed = true;
          item = INVALID_VALUE;
        }
        normalized.push(normalizeValue(item, depth + 1, state));
      }
      if (value.length > length) state.truncated = true;
      return Object.freeze(normalized);
    }

    let keys: string[];
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        state.malformed = true;
        return INVALID_VALUE;
      }
      keys = Object.keys(value);
    } catch {
      state.malformed = true;
      return Object.freeze({ value: INVALID_VALUE });
    }
    const normalized = Object.create(null) as Record<string, TelemetryValue>;
    const length = Math.min(keys.length, MAX_COLLECTION_ITEMS);
    for (let index = 0; index < length; index++) {
      const key = keys[index]!;
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        state.malformed = true;
        item = INVALID_VALUE;
      }
      normalized[normalizedString(key, state)] = normalizeValue(item, depth + 1, state);
    }
    if (keys.length > length) state.truncated = true;
    return Object.freeze(normalized);
  } finally {
    state.ancestors.delete(value);
  }
}

export function prepareTelemetryMetadata(value: unknown): PreparedTelemetryMetadata {
  if (value === undefined) return Object.freeze({ truncated: false, malformed: false });
  const state: NormalizationState = {
    ancestors: new WeakSet(),
    remainingCharacters: MAX_TOTAL_CHARACTERS,
    remainingBytes: MAX_BYTES_LENGTH,
    remainingNodes: MAX_TOTAL_NODES,
    truncated: false,
    malformed: false,
  };
  const normalized = normalizeValue(value, 0, state);
  const metadata = (
    typeof normalized === "object" &&
    normalized !== null &&
    !Array.isArray(normalized) &&
    !(normalized instanceof Uint8Array)
  )
    ? normalized as TelemetryMetadata
    : Object.freeze({ value: normalized });
  return Object.freeze({ metadata, truncated: state.truncated, malformed: state.malformed });
}

export function prepareTelemetryMessage(value: unknown): {
  readonly message: string;
  readonly truncated: boolean;
  readonly malformed: boolean;
} {
  const state: NormalizationState = {
    ancestors: new WeakSet(),
    remainingCharacters: MAX_STRING_LENGTH,
    remainingBytes: 0,
    remainingNodes: 1,
    truncated: false,
    malformed: false,
  };
  let message: string;
  if (typeof value === "string") {
    message = normalizedString(value, state);
  } else {
    state.malformed = true;
    message = INVALID_VALUE;
  }
  return Object.freeze({
    message,
    truncated: state.truncated,
    malformed: state.malformed,
  });
}
