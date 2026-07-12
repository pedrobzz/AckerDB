/**
 * The storage engine: bun:sqlite with WAL, one writer connection (all
 * transactions are serialized through the runtime's writer queue) and one
 * reader connection (queries and subscription recomputes see committed
 * snapshots only).
 *
 * Physical mapping:
 *   - primary key            INTEGER PRIMARY KEY AUTOINCREMENT (ids never reused)
 *   - string                 TEXT
 *   - number / scheduleAt    REAL
 *   - bigint / identity      INTEGER
 *   - boolean                INTEGER (0/1)
 *   - bytes                  BLOB
 *   - enum                   INTEGER (stable interned tag, see _dbz_tags)
 *   - union                  INTEGER tag column + TEXT payload column "<col>__p"
 *   - array / object / jsonb TEXT (wire-encoded, so bigints/bytes round-trip)
 *
 * Enum/union tags are interned once per (type name, variant name) in
 * `_dbz_tags` and never change and are never reused: reordering variants is
 * cosmetic, renames keep storage, deletions retire the tag forever.
 *
 * Direct indexes execute as SQLite b-tree indexes: same API and semantics;
 * the array-backed layout is a later optimization if benchmarks demand it
 * (the same "only if it wins" rule the wiki applies to sized numerics).
 */
import { Database, type Statement } from "bun:sqlite";
import { decode, encode } from "@dbzz/core";
import type { Validator } from "./dbz.ts";
import type { IndexDef, Schema, TableDef } from "./schema.ts";
import { snapshotOf, type SchemaSnapshot } from "./snapshot.ts";

export interface TagMap {
  toTag: Map<string, number>;
  toName: Map<number, string>;
}

interface PhysCol {
  name: string;
  ddl: string;
}

export interface ColumnPlan {
  jsName: string;
  /** Unwrapped kind ("nullable" removed). */
  kind: string;
  nullable: boolean;
  /** For enum/union: the declared type name (tag map key). */
  typeName?: string;
  phys: PhysCol[];
  toSql(value: unknown): unknown[];
  fromSql(values: unknown[]): unknown;
}

export interface TablePlan {
  name: string;
  pk: string;
  scheduleAt: string | null;
  columns: Map<string, ColumnPlan>;
  /** Physical column names in DDL order (pk first). */
  physOrder: string[];
  indexes: IndexDef[];
}

const quote = (name: string) => `"${name}"`;

function unwrapValidator(validator: Validator<unknown, string>): {
  base: Validator<unknown, string>;
  nullable: boolean;
} {
  if (validator.kind === "nullable") {
    return { base: (validator as unknown as { inner: Validator<unknown, string> }).inner, nullable: true };
  }
  return { base: validator, nullable: false };
}

function ddlTypeOf(kind: string): string {
  switch (kind) {
    case "string":
      return "TEXT";
    case "number":
    case "scheduleAt":
      return "REAL";
    case "bigint":
    case "identity":
    case "boolean":
    case "enum":
      return "INTEGER";
    case "bytes":
      return "BLOB";
    case "array":
    case "object":
    case "jsonb":
      return "TEXT";
    default:
      throw new Error(`no DDL type for validator kind "${kind}"`);
  }
}

export class Engine {
  readonly schema: Schema;
  readonly writer: Database;
  readonly reader: Database;
  readonly tags = new Map<string, TagMap>();
  readonly plans = new Map<string, TablePlan>();

  constructor(schema: Schema, path: string) {
    this.schema = schema;
    this.writer = new Database(path, { create: true, safeIntegers: true });
    this.writer.exec("PRAGMA journal_mode = WAL");
    this.writer.exec("PRAGMA synchronous = NORMAL");
    this.writer.exec("PRAGMA busy_timeout = 5000");
    if (path === ":memory:") {
      this.reader = this.writer;
    } else {
      this.reader = new Database(path, { readonly: false, safeIntegers: true });
      this.reader.exec("PRAGMA busy_timeout = 5000");
    }
    this.writer.exec(
      `CREATE TABLE IF NOT EXISTS _dbz_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS _dbz_tags (type TEXT NOT NULL, variant TEXT NOT NULL, tag INTEGER NOT NULL, PRIMARY KEY (type, variant));
       CREATE TABLE IF NOT EXISTS _dbz_mutations (mid TEXT PRIMARY KEY, result TEXT NOT NULL, at REAL NOT NULL);`,
    );
    this.internTags();
    this.buildPlans();
  }

  /** Assign stable tags to every named enum/union variant. */
  private internTags(): void {
    const select = this.writer.query("SELECT variant, tag FROM _dbz_tags WHERE type = ?");
    const insert = this.writer.query("INSERT INTO _dbz_tags (type, variant, tag) VALUES (?, ?, ?)");
    for (const [typeName, validator] of this.schema.namedTypes) {
      const variants =
        validator.kind === "enum"
          ? [...(validator as unknown as { values: readonly string[] }).values]
          : Object.keys((validator as unknown as { members: Record<string, unknown> }).members);
      const map: TagMap = { toTag: new Map(), toName: new Map() };
      let max = -1;
      for (const row of select.all(typeName) as { variant: string; tag: bigint }[]) {
        const tag = Number(row.tag);
        map.toTag.set(row.variant, tag);
        map.toName.set(tag, row.variant);
        if (tag > max) max = tag;
      }
      for (const variant of variants) {
        if (!map.toTag.has(variant)) {
          const tag = ++max;
          insert.run(typeName, variant, tag);
          map.toTag.set(variant, tag);
          map.toName.set(tag, variant);
        }
      }
      this.tags.set(typeName, map);
    }
  }

  private buildPlans(): void {
    for (const [tableName, table] of Object.entries(this.schema.tables)) {
      if (table.kind === "event") continue;
      this.plans.set(tableName, this.planTable(tableName, table));
    }
  }

  private planTable(tableName: string, table: TableDef): TablePlan {
    const columns = new Map<string, ColumnPlan>();
    const physOrder: string[] = [];
    for (const [jsName, validator] of Object.entries(table.columns)) {
      const plan = this.planColumn(jsName, validator);
      columns.set(jsName, plan);
      for (const phys of plan.phys) physOrder.push(phys.name);
    }
    return {
      name: tableName,
      pk: table.primaryKey,
      scheduleAt: table.scheduleAtColumn,
      columns,
      physOrder,
      indexes: table.indexes,
    };
  }

  private planColumn(jsName: string, validator: Validator<unknown, string>): ColumnPlan {
    const { base, nullable } = unwrapValidator(validator);
    const notNull = nullable ? "" : " NOT NULL";

    if (base.kind === "pk") {
      return {
        jsName,
        kind: "pk",
        nullable: false,
        phys: [{ name: jsName, ddl: `${quote(jsName)} INTEGER PRIMARY KEY AUTOINCREMENT` }],
        toSql: (value) => [value],
        fromSql: (values) => values[0],
      };
    }

    if (base.kind === "union") {
      const typeName = (base as unknown as { name: string }).name;
      const payloadCol = `${jsName}__p`;
      const tagMap = () => this.tags.get(typeName)!;
      return {
        jsName,
        kind: "union",
        nullable,
        typeName,
        phys: [
          { name: jsName, ddl: `${quote(jsName)} INTEGER${notNull}` },
          { name: payloadCol, ddl: `${quote(payloadCol)} TEXT${notNull}` },
        ],
        toSql: (value) => {
          if (value === null) return [null, null];
          const { tag, value: payload } = value as { tag: string; value: unknown };
          const tagInt = tagMap().toTag.get(tag);
          if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${tag}"`);
          return [tagInt, encode(payload)];
        },
        fromSql: (values) => {
          if (values[0] === null) return null;
          return {
            tag: tagMap().toName.get(Number(values[0]))!,
            value: decode(values[1] as string),
          };
        },
      };
    }

    if (base.kind === "enum") {
      const typeName = (base as unknown as { name: string }).name;
      const tagMap = () => this.tags.get(typeName)!;
      return {
        jsName,
        kind: "enum",
        nullable,
        typeName,
        phys: [{ name: jsName, ddl: `${quote(jsName)} INTEGER${notNull}` }],
        toSql: (value) => {
          if (value === null) return [null];
          const tagInt = tagMap().toTag.get(value as string);
          if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${String(value)}"`);
          return [tagInt];
        },
        fromSql: (values) => (values[0] === null ? null : tagMap().toName.get(Number(values[0]))!),
      };
    }

    const ddl = `${quote(jsName)} ${ddlTypeOf(base.kind)}${notNull}`;
    const simple = (toSql: (v: unknown) => unknown, fromSql: (v: unknown) => unknown): ColumnPlan => ({
      jsName,
      kind: base.kind,
      nullable,
      phys: [{ name: jsName, ddl }],
      toSql: (value) => [value === null ? null : toSql(value)],
      fromSql: (values) => (values[0] === null ? null : fromSql(values[0])),
    });

    switch (base.kind) {
      case "string":
        return simple((v) => v, (v) => v);
      case "number":
      case "scheduleAt":
        return simple((v) => v, (v) => Number(v));
      case "bigint":
      case "identity":
        return simple((v) => v, (v) => v);
      case "boolean":
        return simple((v) => (v ? 1 : 0), (v) => v === 1n || v === 1);
      case "bytes":
        return simple((v) => v, (v) => v);
      case "array":
      case "object":
      case "jsonb":
        return simple((v) => encode(v), (v) => decode(v as string));
      default:
        throw new Error(`unsupported column kind "${base.kind}"`);
    }
  }

  // -- DDL -------------------------------------------------------------------

  createTableDdl(plan: TablePlan, nameOverride?: string): string {
    const cols: string[] = [];
    for (const column of plan.columns.values()) {
      for (const phys of column.phys) cols.push(phys.ddl);
    }
    return `CREATE TABLE IF NOT EXISTS ${quote(nameOverride ?? plan.name)} (${cols.join(", ")})`;
  }

  /** Create one table plus its indexes (user + internal scheduler index). */
  createTablePhysical(plan: TablePlan): void {
    this.writer.exec(this.createTableDdl(plan));
    this.createIndexesPhysical(plan);
  }

  createIndexesPhysical(plan: TablePlan): void {
    for (const index of plan.indexes) this.writer.exec(this.indexDdl(plan, index));
    if (plan.scheduleAt !== null) {
      this.writer.exec(
        `CREATE INDEX IF NOT EXISTS ${quote(`ix__sched_${plan.name}`)} ON ${quote(plan.name)} (${quote(plan.scheduleAt)})`,
      );
    }
  }

  indexDdl(plan: TablePlan, index: IndexDef): string {
    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((c) => quote(c)).join(", ");
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quote(indexSqlName(plan.name, index.name))} ON ${quote(plan.name)} (${cols})`;
  }

  /** Create all tables and indexes for a fresh database and store the snapshot. */
  createAll(): void {
    for (const plan of this.plans.values()) this.createTablePhysical(plan);
    this.saveSnapshot(snapshotOf(this.schema));
  }

  // -- Meta ------------------------------------------------------------------

  loadSnapshot(): SchemaSnapshot | null {
    const row = this.writer.query("SELECT value FROM _dbz_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    return row === null ? null : (JSON.parse(row.value) as SchemaSnapshot);
  }

  saveSnapshot(snapshot: SchemaSnapshot): void {
    this.writer
      .query("INSERT INTO _dbz_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(snapshot));
  }

  // -- Row codec + basic CRUD (ctx.db composes richer queries on top) --------

  plan(table: string): TablePlan {
    const plan = this.plans.get(table);
    if (!plan) throw new Error(`unknown table "${table}"`);
    return plan;
  }

  /** Decode one SQL result object (keyed by physical column name) to a JS row. */
  rowFromSql(plan: TablePlan, sqlRow: Record<string, unknown>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const column of plan.columns.values()) {
      row[column.jsName] = column.fromSql(column.phys.map((p) => sqlRow[p.name]));
    }
    return row;
  }

  insertSql(plan: TablePlan): { sql: string; bind(row: Record<string, unknown>): unknown[] } {
    const physCols: string[] = [];
    const columns = [...plan.columns.values()].filter((c) => c.kind !== "pk");
    for (const column of columns) for (const phys of column.phys) physCols.push(phys.name);
    const sql = `INSERT INTO ${quote(plan.name)} (${physCols.map(quote).join(", ")}) VALUES (${physCols.map(() => "?").join(", ")}) RETURNING ${quote(plan.pk)}`;
    return {
      sql,
      bind: (row) => columns.flatMap((c) => c.toSql(row[c.jsName])),
    };
  }

  statement(conn: Database, sql: string): Statement {
    return conn.query(sql);
  }

  close(): void {
    if (this.reader !== this.writer) this.reader.close();
    this.writer.close();
  }
}

export function indexSqlName(table: string, index: string): string {
  return `ix_${table}_${index}`;
}
