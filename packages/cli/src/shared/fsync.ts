/**
 * The two places a command can lose a failure: closing what it opened, and
 * flushing what it wrote. Both keep the original failure and carry the cleanup
 * failure beside it instead of replacing it.
 *
 * This is the CLI's own copy on purpose — `@ackerdb/server` exposes no utility
 * subpath, and a public export for four call sites would be a worse contract.
 */
import { closeSync, fsyncSync, openSync } from "node:fs";
import { open } from "node:fs/promises";

/** Run work, then cleanup whatever happened; both failures survive together. */
export function runWithCleanup<T>(work: () => T, cleanup: () => void, message: string): T {
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    cleanup();
  } catch (cleanupError) {
    if (failed) throw new AggregateError([failure, cleanupError], message);
    throw cleanupError;
  }
  if (failed) throw failure;
  return value!;
}

/** The asynchronous twin: the cleanup runs after the work settles, either way. */
export async function runWithCleanupAsync<T>(
  work: () => T | Promise<T>,
  cleanup: () => void | Promise<void>,
  message: string,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = await work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (failed) throw new AggregateError([failure, cleanupError], message);
    throw cleanupError;
  }
  if (failed) throw failure;
  return value!;
}

function bothFailed(path: string): string {
  return `fsync and descriptor close both failed: ${path}`;
}

/** Flush a file or directory to stable storage. */
export function fsyncPathSync(path: string): void {
  const descriptor = openSync(path, "r");
  runWithCleanup(() => fsyncSync(descriptor), () => closeSync(descriptor), bothFailed(path));
}

/** The asynchronous twin, with the same aggregating guarantee. */
export async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  await runWithCleanupAsync(() => handle.sync(), () => handle.close(), bothFailed(path));
}
