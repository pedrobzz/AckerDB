/**
 * The untyped JSON documents this CLI reads back from disk — a migration
 * journal line, a backup manifest — must carry exactly the fields their format
 * declares. An extra field means a newer writer produced the file; a missing one
 * means it is truncated or hand-edited. Both are the same refusal.
 */
export function exactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  subject: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${subject} has an unsupported shape`);
  }
}
