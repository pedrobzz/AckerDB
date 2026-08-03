import type { Database } from "bun:sqlite";
import { IncompatibleDatabaseError } from "../shared/errors.ts";
import { ValidationError } from "../validation/error.ts";

const FULL_TEXT_PREFIX = "_ackerdb_fts_";
const TOKENIZER_TABLE = "__ackerdb_fts_literal_tokens";
const CAPABILITY_TABLE = "__ackerdb_fts5_capability";
const MAX_LITERAL_BYTES = 4_096;
const MAX_LITERAL_TOKENS = 256;

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodedName(table: string, column: string): string {
  return `${FULL_TEXT_PREFIX}${table.length}:${table}${column.length}:${column}`;
}

export interface FullTextTargetPlan {
  readonly column: string;
  readonly indexTable: string;
  readonly insertTrigger: string;
  readonly deleteTrigger: string;
  readonly updateTrigger: string;
}

export interface FullTextCatalogObject {
  readonly type: "table" | "trigger";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

export function fullTextTargetPlan(
  table: string,
  column: string,
): FullTextTargetPlan {
  const indexTable = encodedName(table, column);
  return Object.freeze({
    column,
    indexTable,
    insertTrigger: `${indexTable}_insert`,
    deleteTrigger: `${indexTable}_delete`,
    updateTrigger: `${indexTable}_update`,
  });
}

function virtualTableSql(
  table: string,
  primaryKey: string,
  target: FullTextTargetPlan,
): string {
  return `CREATE VIRTUAL TABLE ${quote(target.indexTable)} USING fts5(${quote(target.column)}, content=${sqlString(table)}, content_rowid=${sqlString(primaryKey)})`;
}

function triggerSql(
  table: string,
  primaryKey: string,
  target: FullTextTargetPlan,
): readonly [string, string, string] {
  const base = quote(table);
  const index = quote(target.indexTable);
  const pk = quote(primaryKey);
  const column = quote(target.column);
  return [
    `CREATE TRIGGER ${quote(target.insertTrigger)} AFTER INSERT ON ${base} BEGIN INSERT INTO ${index}(rowid, ${column}) VALUES (new.${pk}, new.${column}); END`,
    `CREATE TRIGGER ${quote(target.deleteTrigger)} AFTER DELETE ON ${base} BEGIN INSERT INTO ${index}(${quote(target.indexTable)}, rowid, ${column}) VALUES ('delete', old.${pk}, old.${column}); END`,
    `CREATE TRIGGER ${quote(target.updateTrigger)} AFTER UPDATE OF ${column} ON ${base} WHEN old.${column} IS NOT new.${column} BEGIN INSERT INTO ${index}(${quote(target.indexTable)}, rowid, ${column}) VALUES ('delete', old.${pk}, old.${column}); INSERT INTO ${index}(rowid, ${column}) VALUES (new.${pk}, new.${column}); END`,
  ];
}

/** Exact user-visible and FTS5-owned catalog objects for one target. */
export function fullTextCatalogObjects(
  table: string,
  primaryKey: string,
  target: FullTextTargetPlan,
): FullTextCatalogObject[] {
  const [insertSql, deleteSql, updateSql] = triggerSql(table, primaryKey, target);
  const shadow = (suffix: string, sql: string): FullTextCatalogObject => ({
    type: "table",
    name: `${target.indexTable}_${suffix}`,
    table: `${target.indexTable}_${suffix}`,
    sql,
  });
  return [
    {
      type: "table",
      name: target.indexTable,
      table: target.indexTable,
      sql: virtualTableSql(table, primaryKey, target),
    },
    shadow(
      "data",
      `CREATE TABLE ${sqlString(`${target.indexTable}_data`)}(id INTEGER PRIMARY KEY, block BLOB)`,
    ),
    shadow(
      "idx",
      `CREATE TABLE ${sqlString(`${target.indexTable}_idx`)}(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`,
    ),
    shadow(
      "docsize",
      `CREATE TABLE ${sqlString(`${target.indexTable}_docsize`)}(id INTEGER PRIMARY KEY, sz BLOB)`,
    ),
    shadow(
      "config",
      `CREATE TABLE ${sqlString(`${target.indexTable}_config`)}(k PRIMARY KEY, v) WITHOUT ROWID`,
    ),
    { type: "trigger", name: target.insertTrigger, table, sql: insertSql },
    { type: "trigger", name: target.deleteTrigger, table, sql: deleteSql },
    { type: "trigger", name: target.updateTrigger, table, sql: updateSql },
  ];
}

/**
 * Create, blockingly backfill, verify, then expose synchronization triggers.
 * The caller owns the schema transaction.
 */
export function createFullTextTarget(
  connection: Database,
  table: string,
  primaryKey: string,
  target: FullTextTargetPlan,
): void {
  connection.exec(virtualTableSql(table, primaryKey, target));
  connection.exec(
    `INSERT INTO ${quote(target.indexTable)}(${quote(target.indexTable)}) VALUES ('rebuild')`,
  );
  connection.exec(
    `INSERT INTO ${quote(target.indexTable)}(${quote(target.indexTable)}, rank) VALUES ('integrity-check', 1)`,
  );
  for (const sql of triggerSql(table, primaryKey, target)) connection.exec(sql);
}

/** Drop only the derived objects owned by one declared target. */
export function dropFullTextTarget(
  connection: Database,
  target: FullTextTargetPlan,
): void {
  connection.exec(`DROP TRIGGER IF EXISTS ${quote(target.updateTrigger)}`);
  connection.exec(`DROP TRIGGER IF EXISTS ${quote(target.deleteTrigger)}`);
  connection.exec(`DROP TRIGGER IF EXISTS ${quote(target.insertTrigger)}`);
  connection.exec(`DROP TABLE IF EXISTS ${quote(target.indexTable)}`);
}

/**
 * Install the native tokenizer boundary on one connection. FTS3's unicode61
 * tokenizer is byte-for-byte compatible with FTS5's default unicode61.
 */
export function installFullTextSupport(connection: Database): void {
  try {
    connection.exec(
      `CREATE VIRTUAL TABLE temp.${quote(CAPABILITY_TABLE)} USING fts5(text)`,
    );
    connection.exec(`DROP TABLE temp.${quote(CAPABILITY_TABLE)}`);
    connection.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${quote(TOKENIZER_TABLE)} USING fts3tokenize(unicode61)`,
    );
  } catch (error) {
    throw new IncompatibleDatabaseError(
      `SQLite full-text search requires FTS5 and the unicode61 fts3tokenize interface: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Convert arbitrary literal text into a bounded FTS5 implicit-AND expression
 * using SQLite's native unicode61 tokenizer. `null` means the literal contains
 * no searchable tokens and therefore matches no rows.
 */
export function prepareFullTextLiteral(
  connection: Database,
  input: unknown,
  path: string,
): string | null {
  if (typeof input !== "string") {
    throw new ValidationError(`${path}: query must be a string`);
  }
  if (Buffer.byteLength(input) > MAX_LITERAL_BYTES) {
    throw new ValidationError(
      `${path}: query must be at most ${MAX_LITERAL_BYTES} UTF-8 bytes`,
    );
  }
  const rows = connection
    .query(
      `SELECT token FROM temp.${quote(TOKENIZER_TABLE)} WHERE input = ? ORDER BY position LIMIT ${MAX_LITERAL_TOKENS + 1}`,
    )
    .all(input) as { token: string }[];
  if (rows.length > MAX_LITERAL_TOKENS) {
    throw new ValidationError(
      `${path}: query must contain at most ${MAX_LITERAL_TOKENS} searchable tokens`,
    );
  }
  if (rows.length === 0) return null;
  return rows
    .map(({ token }) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");
}
