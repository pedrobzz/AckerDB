import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UUID_V4 } from "../shared/identity.ts";

export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function exactStagingArtifacts(
  path: string,
  kind: "init" | "restore",
  includeSidecars: boolean,
): string[] {
  const directory = dirname(path);
  if (!existsSync(directory)) return [];
  const prefix = `${basename(path)}.ackerdb-${kind}-`;
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isDirectory() || !entry.name.startsWith(prefix)) return false;
      const suffix = entry.name.slice(prefix.length);
      return UUID_V4.test(suffix) || includeSidecars && SQLITE_SIDECAR_SUFFIXES.some(
        (sidecar) => suffix.endsWith(sidecar) && UUID_V4.test(suffix.slice(0, -sidecar.length)),
      );
    })
    .map((entry) => join(directory, entry.name));
}

export function initializationArtifactPaths(path: string): string[] {
  return exactStagingArtifacts(path, "init", true);
}

export function restoreArtifactPaths(path: string): string[] {
  return exactStagingArtifacts(path, "restore", true);
}

/** Main-file stages that can remain hard-linked after AckerDB publication crashes. */
export function databasePublicationArtifactPaths(path: string): string[] {
  return [
    ...exactStagingArtifacts(path, "init", false),
    ...exactStagingArtifacts(path, "restore", false),
  ];
}

export function canonicalDatabasePaths(path: string): readonly string[] {
  return Object.freeze([path, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${path}${suffix}`)]);
}
