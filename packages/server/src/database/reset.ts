import { closeSync, existsSync, fsyncSync, openSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalDatabasePaths,
  initializationArtifactPaths,
  restoreArtifactPaths,
  telemetryStorePaths,
} from "./artifacts.ts";
import { DatabaseOwnership } from "./ownership.ts";

export interface DatabaseResetResult {
  readonly database: string;
  readonly removed: readonly string[];
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  let failed = false;
  let failure: unknown;
  try {
    fsyncSync(descriptor);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    closeSync(descriptor);
  } catch (closeError) {
    if (failed) {
      throw new AggregateError(
        [failure, closeError],
        `database reset directory sync and descriptor close both failed: ${path}`,
      );
    }
    throw closeError;
  }
  if (failed) throw failure;
}

/**
 * Clear only the database family and AckerDB's exact staging artifacts. The
 * persistent coordination database and every unrelated entry remain intact.
 */
export function resetDatabase(path: string): DatabaseResetResult {
  if (path === ":memory:") throw new TypeError("reset requires a file-backed database path");
  const ownership = DatabaseOwnership.acquire(path);
  const database = ownership.path;
  let failed = false;
  let failure: unknown;
  const removed: string[] = [];
  try {
    const candidates = [
      ...initializationArtifactPaths(database),
      ...restoreArtifactPaths(database),
      ...canonicalDatabasePaths(database),
      ...telemetryStorePaths(database),
    ];
    const failures: unknown[] = [];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        rmSync(candidate);
        removed.push(candidate);
      } catch (error) {
        failures.push(error);
      }
    }
    if (removed.length > 0) {
      try {
        fsyncDirectory(dirname(database));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0 && removed.length > 0) {
      throw new AggregateError(
        failures,
        `database reset removed ${removed.length} artifact(s) from ${database}, but did not complete`,
      );
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `database reset cleanup failed: ${database}`);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    ownership.release();
  } catch (releaseError) {
    if (failed) {
      throw new AggregateError(
        [failure, releaseError],
        removed.length > 0
          ? `database reset removed ${removed.length} artifact(s) from ${database}, then reset completion and ownership release both failed`
          : `database reset and ownership release both failed: ${database}`,
      );
    }
    if (removed.length > 0) {
      throw new Error(
        `database reset removed ${removed.length} artifact(s) from ${database}, but ownership release failed`,
        { cause: releaseError },
      );
    }
    throw releaseError;
  }
  if (failed) throw failure;
  return Object.freeze({ database, removed: Object.freeze(removed) });
}
