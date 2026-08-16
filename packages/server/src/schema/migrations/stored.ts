/**
 * The stored-state peek: what a database last committed, read through a plain
 * READ-ONLY `bun:sqlite` connection. No Engine, no canonical ownership, no user
 * code — safe whether the owning server is freshly dead or still alive (a
 * reader sees only committed state). The boot's hold gate counts pending
 * migrations against it before storage is opened; the CLI's plan and write
 * commands diff against it.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { SchemaSnapshot } from "../snapshot.ts";
import type { AppliedMigrationRow } from "./chain.ts";

export interface StoredState {
  /** The snapshot the database last committed — the pre-state new migrations sit on. */
  snapshot: SchemaSnapshot;
  /** The `_ackerdb_migrations` rows — the applied prefix, by positional (number, identity). */
  applied: AppliedMigrationRow[];
}

/**
 * Read the stored snapshot and applied-migration rows. Reading the full
 * (number, identity) rows — not a bare COUNT — lets callers run the exact
 * prefix validation, so an edited applied migration cannot masquerade as fully
 * applied. `null` when there is no database yet (nothing to migrate — a fresh
 * one is initialized on first boot), or when the file exists but holds no
 * snapshot.
 */
export function readStoredState(databasePath: string): StoredState | null {
  if (!existsSync(databasePath)) return null;
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM _ackerdb_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    if (row === null) return null;
    const applied = (
      db.query("SELECT number, name, identity FROM _ackerdb_migrations ORDER BY number ASC").all() as {
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
