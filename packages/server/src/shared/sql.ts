/** Quote a SQL object name so any character an identifier may carry survives. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
