import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalDatabasePaths,
  initializationArtifactPaths,
  restoreArtifactPaths,
} from "./artifacts.ts";
import { DatabaseOwnership } from "./ownership.ts";
import { fsyncPathSync } from "../shared/durability.ts";

export interface DatabaseResetResult {
  readonly database: string;
  readonly removed: readonly string[];
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
        fsyncPathSync(dirname(database));
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
