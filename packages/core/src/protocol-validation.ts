export class ProtocolError extends Error {
  constructor(
    readonly code: "malformed" | "unsupported_protocol",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type ProtocolObject = Record<string, unknown>;

export function malformed(message: string): never {
  throw new ProtocolError("malformed", message);
}

export function protocolObject(
  value: unknown,
  name: string,
): ProtocolObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    malformed(`${name} must be an object`);
  }
  return value as ProtocolObject;
}

export function exactFields(
  value: ProtocolObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) malformed(`missing field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      malformed(`unknown field ${key}`);
    }
  }
}

export function boundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    malformed(`${name} must be a non-empty bounded string`);
  }
  return value;
}
