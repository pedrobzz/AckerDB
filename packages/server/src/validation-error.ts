import { brand, hasBrand } from "./identity.ts";

const VALIDATION_ERROR_IDENTITY = Symbol.for("@dbzz/server/ValidationError/v1");

export class ValidationError extends Error {
  constructor(message?: string) {
    super(message);
    brand(this, VALIDATION_ERROR_IDENTITY);
  }
}

export function isValidationError(value: unknown): value is ValidationError {
  return hasBrand(value, VALIDATION_ERROR_IDENTITY);
}
