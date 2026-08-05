import { ValidationError } from "../validation/error.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function safeFileText(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTERS.test(value);
}

export function checkedFileText(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !safeFileText(value, maxLength)) {
    throw new ValidationError(`${path} must contain 1 through ${maxLength} safe characters`);
  }
  return value;
}
