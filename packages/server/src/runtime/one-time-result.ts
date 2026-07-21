import type { WriteCollector } from "../database/access.ts";

const oneTimeResults = new WeakSet<WriteCollector>();

/** Package-private mutation result disposition activated only by secret-minting capabilities. */
export function markOneTimeResult(writes: WriteCollector): void {
  oneTimeResults.add(writes);
}

export function isOneTimeResult(writes: WriteCollector): boolean {
  return oneTimeResults.has(writes);
}
