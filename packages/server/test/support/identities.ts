import type { Identity } from "@ackerdb/core";
import type { Engine } from "../../src/database/engine.ts";
import { IDENTITY_ACCOUNTS_TABLE } from "../../src/auth/tables.ts";

/**
 * The Identity one exact external account resolves to, read straight off the
 * managed table. Suites use it to assert what the framework's own writes left
 * behind, which is a claim about stored rows rather than about the capability
 * that wrote them.
 */
export function storedIdentityForAccount(
  engine: Engine,
  issuer: string,
  subject: string,
): Identity | null {
  const row = engine.reader
    .query(`SELECT identity FROM "${IDENTITY_ACCOUNTS_TABLE}" WHERE issuer = ? AND subject = ?`)
    .get(issuer, subject) as { identity: bigint } | null;
  return row === null ? null : row.identity as Identity;
}
