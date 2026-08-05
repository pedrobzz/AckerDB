const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const DEFINITION_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isPluginIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

export function isPluginDefinitionId(value: string): boolean {
  return DEFINITION_ID.test(value);
}

/** Context field names a plugin mount or dependency slot may not shadow. */
export const BUILTIN_CONTEXT_FIELDS: ReadonlySet<string> = new Set([
  "abortSignal",
  "analytics",
  "auth",
  "db",
  "files",
  "jobs",
  "linkAccount",
  "log",
  "mount",
  "timestamp",
  "tx",
  "unlinkAccount",
]);

export function assertIdentifier(name: string, path: string): void {
  if (!isPluginIdentifier(name)) {
    throw new TypeError(`${path} "${name}" must be an identifier`);
  }
}
