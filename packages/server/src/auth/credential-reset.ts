/**
 * Break-glass: clearing administrative authority from a stopped database.
 *
 * The other two issuance paths assume a server that runs and an operator who
 * can still authenticate. This one exists for when neither holds — a lost
 * secret, or an application that no longer compiles — so it must not need the
 * application, the Engine, or a schema. It opens the database file, deletes the
 * rows the vault calls administrative, and leaves the next boot to mint a fresh
 * master and print it.
 *
 * **Stopped is not a flag it checks; it is a lock it takes.** `DatabaseOwnership`
 * holds one immediate write transaction on the coordination sidecar with no
 * busy timeout, so a running server already owning the path makes this fail
 * with `DatabaseAlreadyOpenError` before anything is read. That is the same
 * guarantee `acker reset` gets, from the same place, rather than a second
 * liveness test that could disagree with it.
 *
 * **The definition of "administrative" is not restated here.** It is
 * `CredentialVault.listAdministrative`, the one boot-mint reads, and the
 * revocation is the vault's own cascade — so what this clears and what the next
 * boot counts can never drift apart, and a delegate of a cleared master is
 * never left behind holding an authority with no source.
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { DatabaseOwnership } from "../database/ownership.ts";
import { CredentialVault } from "./credential-vault.ts";

export interface AdminCredentialResetResult {
  /** The canonical database path the reset ran against. */
  readonly database: string;
  /** Every credential id removed: the masters, and everything delegated beneath them. */
  readonly cleared: readonly string[];
}

const NOTHING_CLEARED: readonly string[] = Object.freeze([]);

/**
 * Remove every Admin Credential from a stopped database, returning what went.
 *
 * An absent database, or one that has never been reconciled, is not an error:
 * both are states in which no administrative authority exists, which is exactly
 * what the caller asked for. Reporting them as failures would make the recovery
 * command refuse the one case it is easiest to reach it from — a fresh checkout
 * whose data directory has not been created yet.
 */
export function resetAdminCredentials(path: string): AdminCredentialResetResult {
  if (path === ":memory:") {
    throw new TypeError("credential reset requires a file-backed database path");
  }
  const ownership = DatabaseOwnership.acquire(path);
  const database = ownership.path;
  try {
    if (!existsSync(database)) {
      return Object.freeze({ database, cleared: NOTHING_CLEARED });
    }
    const connection = new Database(database);
    try {
      const table = connection.query(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_ackerdb_credentials'",
      ).get();
      if (table === null) return Object.freeze({ database, cleared: NOTHING_CLEARED });
      const vault = new CredentialVault(connection);
      const cleared: string[] = [];
      connection.transaction(() => {
        for (const credential of vault.listAdministrative(connection)) {
          cleared.push(...vault.revoke(null, credential.id));
        }
      })();
      return Object.freeze({ database, cleared: Object.freeze(cleared) });
    } finally {
      connection.close();
    }
  } finally {
    ownership.release();
  }
}
