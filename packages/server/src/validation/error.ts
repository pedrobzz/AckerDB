import { brand, hasBrand } from "../shared/identity.ts";

const VALIDATION_ERROR_IDENTITY = Symbol.for("@ackerdb/server/ValidationError/v1");

export class ValidationError extends Error {
  constructor(message?: string) {
    super(message);
    brand(this, VALIDATION_ERROR_IDENTITY);
  }
}

export function isValidationError(value: unknown): value is ValidationError {
  return hasBrand(value, VALIDATION_ERROR_IDENTITY);
}

/**
 * The two refusals every untyped object boundary spells the same way. A key
 * whose value is `undefined` is an absence, not a field, so it is not refused.
 */
export function refuseUnknownKeys(
  input: Record<string, unknown>,
  declares: (key: string) => boolean,
  path: string,
): void {
  for (const key of Object.keys(input)) {
    if (!declares(key) && input[key] !== undefined) {
      throw new ValidationError(`${path}: unknown field "${key}"`);
    }
  }
}
