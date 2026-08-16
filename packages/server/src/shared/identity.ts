/** A v4 UUID exactly as this framework mints and stores one. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Package-copy identity only; never treat this cooperative marker as authorization. */
export function brand(value: object, identity: symbol): void {
  Object.defineProperty(value, identity, { value: identity });
}

export function hasBrand(value: unknown, identity: symbol): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, identity)?.value === identity
  );
}
