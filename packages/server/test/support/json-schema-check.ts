/**
 * A deliberately small JSON Schema 2020-12 checker for the keywords AckerDB's
 * documents actually publish. It is fail-closed: a keyword it does not
 * implement throws instead of being ignored, so a passing check can never mean
 * "the validator did not look". Nothing here is production code — it exists so
 * a test can hold a served response against the document AckerDB published.
 */
const SUPPORTED = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "contentEncoding",
  "format",
  "x-ackerdb-untyped",
]);

type Schema = Readonly<Record<string, unknown>>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(declared: string, actual: string): boolean {
  return declared === actual || (declared === "number" && actual === "integer");
}

function check(schema: Schema, value: unknown, path: string, violations: string[]): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(`${path}: unsupported JSON Schema keyword "${keyword}"`);
    }
  }
  const actual = typeOf(value);
  if (schema["type"] !== undefined) {
    const declared = Array.isArray(schema["type"])
      ? (schema["type"] as readonly string[])
      : [schema["type"] as string];
    if (!declared.some((candidate) => matchesType(candidate, actual))) {
      violations.push(`${path}: expected type ${declared.join("|")}, got ${actual}`);
      return;
    }
  }
  if (schema["const"] !== undefined && value !== schema["const"]) {
    violations.push(`${path}: expected const ${JSON.stringify(schema["const"])}`);
  }
  const enumeration = schema["enum"];
  if (Array.isArray(enumeration) && !enumeration.includes(value)) {
    violations.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(enumeration)}`);
  }
  for (const branch of ["oneOf", "anyOf"] as const) {
    const members = schema[branch];
    if (!Array.isArray(members)) continue;
    const matched = members.filter((member) => {
      const branchViolations: string[] = [];
      check(member as Schema, value, path, branchViolations);
      return branchViolations.length === 0;
    }).length;
    if (branch === "oneOf" ? matched !== 1 : matched === 0) {
      violations.push(`${path}: matched ${matched} ${branch} members`);
    }
  }
  if (typeof value === "string") {
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      violations.push(`${path}: ${JSON.stringify(value)} does not match ${pattern}`);
    }
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      violations.push(`${path}: shorter than minLength`);
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      violations.push(`${path}: longer than maxLength`);
    }
    if (schema["contentEncoding"] === "base64" && Buffer.from(value, "base64").toString("base64") !== value) {
      violations.push(`${path}: ${JSON.stringify(value)} is not canonical base64`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      violations.push(`${path}: below minimum`);
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      violations.push(`${path}: above maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
      violations.push(`${path}: fewer than minItems`);
    }
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
      violations.push(`${path}: more than maxItems`);
    }
    const items = schema["items"];
    if (items !== undefined) {
      value.forEach((item, index) => check(items as Schema, item, `${path}[${index}]`, violations));
    }
    return;
  }
  if (actual !== "object") return;
  const fields = value as Record<string, unknown>;
  const properties = (schema["properties"] ?? {}) as Record<string, Schema>;
  for (const name of (schema["required"] ?? []) as readonly string[]) {
    if (!Object.hasOwn(fields, name)) violations.push(`${path}.${name}: required property is missing`);
  }
  for (const [name, field] of Object.entries(fields)) {
    const property = properties[name];
    if (property === undefined) {
      if (schema["additionalProperties"] === false) {
        violations.push(`${path}.${name}: additional property is not allowed`);
      }
      continue;
    }
    check(property, field, `${path}.${name}`, violations);
  }
}

/** Every way `value` violates `schema`; empty means the document describes it. */
export function jsonSchemaViolations(schema: Schema, value: unknown): readonly string[] {
  const violations: string[] = [];
  check(schema, value, "$", violations);
  return violations;
}
