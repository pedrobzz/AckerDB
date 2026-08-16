import { closeSync, fsyncSync, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { runWithCleanup, runWithCleanupAsync } from "./cleanup.ts";

function bothFailed(path: string): string {
  return `fsync and descriptor close both failed: ${path}`;
}

/**
 * Flush a file or directory to stable storage. A failed flush surfaces even when
 * closing the descriptor fails too: both failures travel together.
 */
export function fsyncPathSync(path: string): void {
  const descriptor = openSync(path, "r");
  runWithCleanup(() => fsyncSync(descriptor), () => closeSync(descriptor), bothFailed(path));
}

/** The asynchronous twin, with the same aggregating guarantee. */
export async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  await runWithCleanupAsync(() => handle.sync(), () => handle.close(), bothFailed(path));
}
