/** Deep-freeze one validated value without recursing through cyclic graphs. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const seen = new Set<object>();
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}
