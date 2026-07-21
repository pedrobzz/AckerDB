const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const DEFINITION_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isPluginIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

export function isPluginDefinitionId(value: string): boolean {
  return DEFINITION_ID.test(value);
}
