import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Flush a file or directory to stable storage. A failed flush surfaces even when
 * closing the descriptor fails too: both failures travel together.
 */
export function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  let failed = false;
  let failure: unknown;
  try {
    fsyncSync(fd);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (closeError) {
    if (failed) throw new AggregateError([failure, closeError], `fsync and descriptor close both failed: ${path}`);
    throw closeError;
  }
  if (failed) throw failure;
}
