const BYTE_MUTATORS = new Set<PropertyKey>([
  "copyWithin",
  "fill",
  "reverse",
  "set",
  "sort",
]);

function readonlyBytes(bytes: Uint8Array): Uint8Array {
  const target = new Uint8Array(bytes);
  return new Proxy(target, {
    defineProperty: () => false,
    deleteProperty: () => false,
    set: () => false,
    get(current, property) {
      if (property === "buffer") return current.buffer.slice(0);
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== "function") return value;
      if (BYTE_MUTATORS.has(property)) {
        return () => {
          throw new TypeError("validated bytes are immutable");
        };
      }
      // Typed-array methods reject Proxy receivers. Run reads against a copy,
      // which also prevents callbacks and returned views from exposing target.
      return (...args: unknown[]) => Reflect.apply(value, new Uint8Array(current), args);
    },
  });
}

/** Deep-freeze one validated value without recursing forever through cycles. */
export function deepFreeze<T>(value: T): T {
  const seen = new Map<object, object>();
  const visit = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) return current;
    const known = seen.get(current);
    if (known !== undefined) return known;
    if (current instanceof Uint8Array) {
      const bytes = readonlyBytes(current);
      seen.set(current, bytes);
      return bytes;
    }
    if (ArrayBuffer.isView(current)) return current;
    seen.set(current, current);
    for (const [key, child] of Object.entries(current)) {
      const immutable = visit(child);
      if (immutable !== child) Reflect.set(current, key, immutable);
    }
    return Object.freeze(current);
  };
  return visit(value) as T;
}
