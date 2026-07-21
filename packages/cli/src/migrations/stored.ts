/**
 * The stored-state peek: what the database last committed, read through a
 * plain READ-ONLY `bun:sqlite` connection. No Engine, no canonical ownership, no user
 * code — safe whether a serve child is freshly dead or still alive (a reader
 * sees only committed state). The planner diffs against it; startup's
 * hold-pending gate counts against it.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppliedMigrationRow, SchemaSnapshot } from "@dbzz/server";
import type { AppConfig } from "../app/config.ts";

export interface StoredState {
  /** The snapshot the database last committed — the pre-state new migrations sit on. */
  snapshot: SchemaSnapshot;
  /** The `_dbzz_migrations` rows — the applied prefix, by positional (number, identity). */
  applied: AppliedMigrationRow[];
}

/**
 * Read the stored snapshot and applied-migration rows. Reading the full
 * (number, identity) rows — not a bare COUNT — lets callers run the server's
 * exact prefix validation, so an edited applied migration cannot masquerade as
 * fully applied. `null` when there is no database yet (nothing to migrate —
 * `dbzz dev` initializes a fresh one), or when the file exists but holds no
 * snapshot.
 */
export function readStoredState(config: AppConfig): StoredState | null {
  const path = join(config.dbDir, "data.db");
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT value FROM _dbzz_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    if (row === null) return null;
    const applied = (
      db.query("SELECT number, name, identity FROM _dbzz_migrations ORDER BY number ASC").all() as {
        number: bigint;
        name: string;
        identity: string;
      }[]
    ).map((r) => ({ number: Number(r.number), name: r.name, identity: r.identity }));
    return { snapshot: JSON.parse(row.value) as SchemaSnapshot, applied };
  } finally {
    db.close();
  }
}
