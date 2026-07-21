import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  databasePublicationArtifactPaths,
  SQLITE_SIDECAR_SUFFIXES,
} from "./artifacts.ts";

/** ASCII `DBZZ`, persisted in SQLite's application_id header field. */
const DBZZ_COORDINATION_APPLICATION_ID = 0x44425a5a;
const COORDINATION_SUFFIX = ".dbzz-coordination";
const COORDINATION_STAGE_MARKER = ".dbzz-bootstrap-";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sqliteCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function sqliteErrno(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("errno" in error)) return undefined;
  return typeof error.errno === "number" ? error.errno : undefined;
}

function isBusy(error: unknown): boolean {
  return sqliteCode(error) === "SQLITE_BUSY" && sqliteErrno(error) === 5;
}

function errno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCanonicalDatabasePath(path: string, seenSymlinks: Set<string>): string {
  const absolutePath = resolve(path);
  let status;
  try {
    status = lstatSync(absolutePath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    return join(realpathSync(dirname(absolutePath)), basename(absolutePath));
  }
  if (!status.isSymbolicLink()) return realpathSync(absolutePath);
  if (seenSymlinks.has(absolutePath)) {
    throw new Error(`database path contains a symbolic-link cycle: ${path}`);
  }
  seenSymlinks.add(absolutePath);
  return resolveCanonicalDatabasePath(
    resolve(dirname(absolutePath), readlinkSync(absolutePath)),
    seenSymlinks,
  );
}

export function canonicalizeDatabasePath(path: string): string {
  return resolveCanonicalDatabasePath(path, new Set());
}

function combinedFailure(primary: unknown, cleanup: readonly unknown[], message: string): unknown {
  if (cleanup.length === 0) return primary;
  return new AggregateError([primary, ...cleanup], message);
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  let failure: unknown;
  try {
    fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(descriptor);
  } catch (closeError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, closeError],
        `coordination sync and descriptor close both failed: ${path}`,
      );
    }
    throw closeError;
  }
  if (failure !== undefined) throw failure;
}

function exactCoordinationStageName(path: string, name: string): boolean {
  const prefix = `${basename(path)}${COORDINATION_STAGE_MARKER}`;
  if (!name.startsWith(prefix)) return false;
  const suffix = name.slice(prefix.length);
  return UUID_V4.test(suffix) || SQLITE_SIDECAR_SUFFIXES.some(
    (sidecar) => suffix.endsWith(sidecar) && UUID_V4.test(suffix.slice(0, -sidecar.length)),
  );
}

/** Exact UUIDv4 coordination staging artifacts for one canonical data path. */
export function coordinationStagingArtifactPaths(path: string): readonly string[] {
  const coordinationPath = coordinationDatabasePath(path);
  const directory = dirname(coordinationPath);
  if (!existsSync(directory)) return Object.freeze([]);
  return Object.freeze(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && exactCoordinationStageName(coordinationPath, entry.name))
      .map((entry) => join(directory, entry.name)),
  );
}

function stageCoordinationDatabase(coordinationPath: string): string {
  const stagingPath = `${coordinationPath}${COORDINATION_STAGE_MARKER}${randomUUID()}`;
  let database: Database | undefined;
  let created = false;
  let transactionOpen = false;
  let failure: unknown;
  try {
    const descriptor = openSync(stagingPath, "wx", 0o600);
    created = true;
    closeSync(descriptor);
    database = new Database(stagingPath, { readwrite: true, safeIntegers: true, strict: true });
    database.exec("PRAGMA busy_timeout = 0");
    const journal = database.query("PRAGMA journal_mode = DELETE").get() as Record<string, unknown>;
    if (String(Object.values(journal)[0]).toLowerCase() !== "delete") {
      throw new Error(`coordination staging file did not enter DELETE journal mode: ${stagingPath}`);
    }
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.exec(`PRAGMA application_id = ${DBZZ_COORDINATION_APPLICATION_ID}`);
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    failure = error;
  }
  const cleanup: unknown[] = [];
  if (transactionOpen && database !== undefined) {
    try {
      database.exec("ROLLBACK");
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (database !== undefined) {
    try {
      database.close(false);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (failure === undefined && cleanup.length === 0) {
    try {
      fsyncPath(stagingPath);
      return stagingPath;
    } catch (error) {
      failure = error;
    }
  } else if (failure === undefined) {
    failure = cleanup.shift();
  }

  if (created) {
    try {
      removeOwnStage(stagingPath);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      fsyncPath(dirname(stagingPath));
    } catch (error) {
      cleanup.push(error);
    }
  }
  throw combinedFailure(
    failure,
    cleanup,
    `coordination staging initialization and cleanup both failed: ${stagingPath}`,
  );
}

function removeOwnStage(stagingPath: string): void {
  const failures: unknown[] = [];
  for (const artifact of [
    stagingPath,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${stagingPath}${suffix}`),
  ]) {
    try {
      rmSync(artifact, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `coordination staging cleanup failed: ${stagingPath}`);
  }
}

function publishMissingCoordinationDatabase(coordinationPath: string): void {
  if (existsSync(coordinationPath)) return;
  const directory = dirname(coordinationPath);
  let stagingPath: string | undefined;
  let failure: unknown;
  try {
    stagingPath = stageCoordinationDatabase(coordinationPath);
    try {
      linkSync(stagingPath, coordinationPath);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
  } catch (error) {
    failure = error;
  }

  const cleanup: unknown[] = [];
  if (stagingPath !== undefined) {
    try {
      removeOwnStage(stagingPath);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (stagingPath !== undefined && (failure !== undefined || cleanup.length > 0)) {
    try {
      fsyncPath(directory);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (failure !== undefined) {
    throw combinedFailure(
      failure,
      cleanup,
      `coordination publication and staging cleanup both failed: ${coordinationPath}`,
    );
  }
  if (cleanup.length === 1) throw cleanup[0];
  if (cleanup.length > 1) {
    throw new AggregateError(cleanup, `coordination publication staging cleanup failed: ${coordinationPath}`);
  }
}

/**
 * Remove only DBZZ publication aliases of the canonical inode. This must run
 * before any SQLite connection opens that inode: unlinking an alias later can
 * make macOS invalidate an otherwise-live SQLite file descriptor.
 */
function convergeCoordinationPublication(path: string, coordinationPath: string): void {
  const canonical = statSync(coordinationPath, { bigint: true });
  if (canonical.nlink === 1n) {
    fsyncPath(dirname(coordinationPath));
    return;
  }
  for (const candidatePath of coordinationStagingArtifactPaths(path)) {
    try {
      const candidate = statSync(candidatePath, { bigint: true });
      if (candidate.dev !== canonical.dev || candidate.ino !== canonical.ino) continue;
      rmSync(candidatePath);
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      throw error;
    }
  }
  const links = statSync(coordinationPath, { bigint: true }).nlink;
  if (links !== 1n) {
    throw new Error(
      `database coordination file has ${links} hard links; expected exactly one: ${coordinationPath}`,
    );
  }
  fsyncPath(dirname(coordinationPath));
}

/**
 * Remove only same-inode DBZZ main-file publication stages. The coordination
 * transaction is already retained, and no data SQLite connection is open.
 */
function convergeDatabasePublication(path: string): void {
  let canonical;
  try {
    canonical = statSync(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (canonical.nlink === 1n) return;
  let removed = false;
  for (const candidatePath of databasePublicationArtifactPaths(path)) {
    try {
      const candidate = lstatSync(candidatePath, { bigint: true });
      if (candidate.isSymbolicLink()) continue;
      if (candidate.dev !== canonical.dev || candidate.ino !== canonical.ino) continue;
      rmSync(candidatePath);
      removed = true;
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      throw error;
    }
  }
  if (removed) fsyncPath(dirname(path));
  const converged = statSync(path, { bigint: true });
  if (converged.dev !== canonical.dev || converged.ino !== canonical.ino) {
    throw new Error(`database main file changed during ownership acquisition: ${path}`);
  }
  if (converged.nlink !== 1n) {
    throw new Error(
      `database main file has ${converged.nlink} unproven hard links; expected exactly one: ${path}`,
    );
  }
}

export class DatabaseAlreadyOpenError extends Error {
  readonly path: string;
  readonly code = "DBZZ_DATABASE_ALREADY_OPEN";

  constructor(path: string, options: { cause?: unknown } = {}) {
    super(`database is already open: ${path}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DatabaseAlreadyOpenError";
    this.path = path;
  }
}

export function coordinationDatabasePath(path: string): string {
  if (path === ":memory:") throw new TypeError("in-memory databases do not have canonical ownership");
  return `${path}${COORDINATION_SUFFIX}`;
}

/** Persistent coordination entries and exact crash residues owned by one canonical data path. */
export function coordinationDatabaseEntries(path: string): readonly string[] {
  const coordination = coordinationDatabasePath(path);
  return Object.freeze([
    coordination,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${coordination}${suffix}`),
    ...coordinationStagingArtifactPaths(path),
  ]);
}

/**
 * One OS-lifetime write transaction owns a canonical database path. The
 * coordination database is permanent: process death releases SQLite's lock,
 * so no process ever decides whether another process's pathname may be reaped.
 */
export class DatabaseOwnership {
  readonly path: string;
  readonly coordinationPath: string;
  private readonly database: Database;
  private transactionOpen = true;
  private closed = false;

  private constructor(path: string, coordinationPath: string, database: Database) {
    this.path = path;
    this.coordinationPath = coordinationPath;
    this.database = database;
  }

  static acquire(path: string): DatabaseOwnership {
    const requestedPath = resolve(path);
    mkdirSync(dirname(requestedPath), { recursive: true });
    const canonicalPath = canonicalizeDatabasePath(requestedPath);
    const coordinationPath = coordinationDatabasePath(canonicalPath);
    mkdirSync(dirname(coordinationPath), { recursive: true });

    try {
      publishMissingCoordinationDatabase(coordinationPath);
      convergeCoordinationPublication(canonicalPath, coordinationPath);
    } catch (error) {
      throw new Error(
        `database coordination publication failed: ${coordinationPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let database: Database;
    try {
      database = new Database(coordinationPath, {
        readwrite: true,
        safeIntegers: true,
        strict: true,
      });
    } catch (error) {
      throw new Error(`database coordination file is not a usable SQLite database: ${coordinationPath}`, {
        cause: error,
      });
    }

    let transactionOpen = false;
    try {
      database.exec("PRAGMA busy_timeout = 0");
      try {
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
      } catch (error) {
        if (isBusy(error)) {
          throw new DatabaseAlreadyOpenError(canonicalPath, { cause: error });
        }
        throw error;
      }

      const identity = database.query("PRAGMA application_id").get() as Record<string, unknown>;
      const applicationId = Number(Object.values(identity)[0]);
      if (applicationId !== DBZZ_COORDINATION_APPLICATION_ID) {
        throw new Error(`database coordination file has invalid identity: ${coordinationPath}`);
      }
      const journal = database.query("PRAGMA journal_mode").get() as Record<string, unknown>;
      const journalMode = String(Object.values(journal)[0]).toLowerCase();
      if (journalMode !== "delete") {
        throw new Error(
          `database coordination file has unsupported journal mode ${JSON.stringify(journalMode)}: ${coordinationPath}`,
        );
      }
      const schema = database.query("SELECT count(*) AS count FROM sqlite_schema").get() as { count: bigint };
      if (schema.count !== 0n) {
        throw new Error(`database coordination file has unexpected schema objects: ${coordinationPath}`);
      }
      convergeDatabasePublication(canonicalPath);

      return new DatabaseOwnership(canonicalPath, coordinationPath, database);
    } catch (error) {
      const cleanup: unknown[] = [];
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackError) {
          cleanup.push(rollbackError);
        }
      }
      try {
        database.close(false);
      } catch (closeError) {
        cleanup.push(closeError);
      }
      throw combinedFailure(
        error,
        cleanup,
        `database ownership acquisition and cleanup both failed: ${canonicalPath}`,
      );
    }
  }

  /** Idempotently release the transaction, then the native SQLite handle. */
  release(): void {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    if (this.transactionOpen) {
      try {
        this.database.exec("ROLLBACK");
        this.transactionOpen = false;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.database.close(false);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `database ownership release failed: ${this.path}`);
    }
  }
}
