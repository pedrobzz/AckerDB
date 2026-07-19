/**
 * Migration application: the answer to a reconcile refusal, driven entirely by
 * snapshots. A migration is a pure function between two recorded snapshots — its
 * `pre` (the typed before-state) and its `target` (the declared contract) — so
 * nothing here reads the live `engine.schema`. That is what lets a *chain* of
 * pending migrations apply in order at startup, each reconciling toward its own
 * historical target rather than the final one.
 *
 * Each step:
 *   - derives its physical work from `diffSnapshots(applyRenames(stored), target)`
 *     — the STORED snapshot is the physical truth, so the diff is what the
 *     database actually is versus where this step is contracted to go;
 *   - encodes rows and builds DDL from the step's TARGET descriptors (index and
 *     column DDL, enum/union interned tags), never the live plan;
 *   - decodes old rows and the frozen before-state from the step's PRE
 *     descriptors, guarded by physical presence: a pre column not physically
 *     present reads `null`, a pre table not physically present reads empty. That
 *     is safe drift made real — the recorded types stay sound for every database
 *     the migration can legally meet.
 *
 * A step declares one entry per table that changed shape: a transform on a
 * surviving table (rebuilt from its new plan, every old row replayed preserving
 * its primary key), `null` on a dropped table (its data goes nowhere), or a
 * transform on a dropped table (a salvage — the return is ignored, only its
 * `ctx.insert` emits matter). Every write happens in the step's single
 * transaction, which also inserts the append-only history row; any error rolls
 * the whole step back byte-identical, leaving every earlier step applied.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { decode, encode, WireError } from "@dbzz/core";
import { ValidationError, type Descriptor } from "./dbz.ts";
import { physicalColumnDdl, type ColumnPlan, type Engine, type TablePlan, type TagMap } from "./engine.ts";
import { classifySchemaDiff, type SchemaRefusal } from "./schema-classify.ts";
import { diffSnapshots, namedOf, unwrapDesc } from "./schema-diff.ts";
import type { SchemaSnapshot, TableSnapshot } from "./snapshot.ts";
import { applySafe, physColsOf, probeOptimistic, UnsafeSchemaChange, type Op } from "./reconcile.ts";

const quote = (name: string) => `"${name}"`;

export type MigrationRow = Record<string, unknown>;

/** Read-only view of one OLD table for cross-table lookups inside a transform. */
export interface BeforeTable {
  get(id: bigint): Promise<MigrationRow | null>;
  scan(): AsyncIterableIterator<MigrationRow>;
}

export interface MigrationContext {
  /** The frozen before-state, keyed by old table name. */
  readonly before: Record<string, BeforeTable>;
  /** Emit a row into any table of the NEW schema; its pk is engine-assigned. */
  insert(table: string, row: MigrationRow): void;
}

/**
 * A per-table row transform. On a surviving table the return is the new row
 * (pk stripped and re-applied by the engine), `null` deletes the row, and
 * `undefined` keeps the row it was handed. On a dropped table the return is
 * ignored — only the emits matter.
 */
export type RowTransform = (
  row: MigrationRow,
  ctx: MigrationContext,
) => MigrationRow | null | void | Promise<MigrationRow | null | void>;

/**
 * Rename declarations: which dropped-plus-added names are the same thing
 * renamed, so data and identity carry over. `tables` maps old table name to
 * new; `columns` is keyed by the table's name in the TARGET schema; `variants`
 * is keyed by the enum/union type name. Applied to the diff first (see
 * `applyRenames`): a pure rename yields no diff, a rename with a change pairs up
 * and the normal transform machinery fires.
 */
export interface Renames {
  tables?: Record<string, string>;
  columns?: Record<string, Record<string, string>>;
  variants?: Record<string, Record<string, string>>;
}

export interface Migration {
  renames?: Renames;
  tables?: Record<string, RowTransform | null>;
}

/**
 * One link in the application's migration chain. `number` is 1-based and
 * strictly increasing across the chain; `pre` types the before-state the
 * transforms were written against; `target` is the full declared schema at
 * generation time; `code` is the migration module's file text, the last
 * component of the step's immutable identity (see `migrationIdentity`). An
 * in-memory chain (server tests, embedded users) passes any string for `code`,
 * conventionally `""` — it is a value, not an optional.
 */
export interface MigrationStep {
  number: number;
  name: string;
  pre: SchemaSnapshot;
  target: SchemaSnapshot;
  code: string;
  migration: Migration;
}

export class MigrationError extends Error {}

export function defineMigration(migration: Migration): Migration {
  if (migration === null || typeof migration !== "object") {
    throw new MigrationError("defineMigration expects a migration object");
  }
  const tables = migration.tables;
  if (tables !== undefined) {
    if (typeof tables !== "object" || tables === null) {
      throw new MigrationError("migration tables must be an object");
    }
    for (const [name, value] of Object.entries(tables)) {
      if (value !== null && typeof value !== "function") {
        throw new MigrationError(`migration entry for "${name}" must be a transform function or null`);
      }
    }
  }
  checkRenamesShape(migration.renames);
  return migration;
}

/** Shallow shape guard for `renames`; existence/conflict checks run in `planRenames`. */
function checkRenamesShape(renames: Renames | undefined): void {
  if (renames === undefined) return;
  if (typeof renames !== "object" || renames === null) throw new MigrationError("migration renames must be an object");
  const isStringMap = (value: unknown): boolean =>
    typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
  if (renames.tables !== undefined && !isStringMap(renames.tables)) {
    throw new MigrationError("migration renames.tables must map old names to new names");
  }
  for (const key of ["columns", "variants"] as const) {
    const nested = renames[key];
    if (nested === undefined) continue;
    if (typeof nested !== "object" || nested === null || !Object.values(nested).every(isStringMap)) {
      throw new MigrationError(`migration renames.${key} must map each name to a { old: new } object`);
    }
  }
}

// -- chain: history, identity, immutability -----------------------------------

/**
 * The load-time target-integrity fingerprint: the sha256 hex of a target
 * snapshot alone. Used by meta sidecars and generation to catch an edited
 * target snapshot before the database opens — a narrower job than identity.
 */
export function migrationFingerprint(target: SchemaSnapshot): string {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

/**
 * A migration's immutable applied identity: the sha256 hex over everything that
 * changes what the step does to data — its number, name, pre snapshot, target
 * snapshot, and migration file text (`code`). Each component is netstring-framed
 * (`<byteLength>:<value>,`) before concatenation, so the encoding is injective:
 * no two distinct tuples ever collide, regardless of what any component holds.
 * This is the value `_dbz_migrations` records and `pendingSteps` compares, so
 * editing an applied migration's pre, renames, or transform code — not just its
 * target — shifts the identity and is refused loudly on the next open.
 */
export function migrationIdentity(step: MigrationStep, code: string): string {
  const part = (value: string): string => `${Buffer.byteLength(value)}:${value},`;
  const canonical =
    part(String(step.number)) + part(step.name) + part(JSON.stringify(step.pre)) + part(JSON.stringify(step.target)) + part(code);
  return createHash("sha256").update(canonical).digest("hex");
}

/** The zero-padded label a step is logged and named under, e.g. `0003_split_users`. */
export function stepLabel(step: { number: number; name: string }): string {
  return `${String(step.number).padStart(4, "0")}_${step.name}`;
}

/** Numbers must be 1-based and strictly increasing across the whole chain. */
export function validateChain(steps: MigrationStep[]): void {
  let prev = 0;
  for (const step of steps) {
    if (!Number.isSafeInteger(step.number) || step.number <= 0) {
      throw new MigrationError(`migration ${stepLabel(step)} has an invalid number; numbers are 1-based positive integers`);
    }
    if (step.number <= prev) {
      throw new MigrationError(`migration numbers must strictly increase; ${stepLabel(step)} does not follow ${prev}`);
    }
    prev = step.number;
  }
}

interface HistoryRow {
  number: number;
  name: string;
  identity: string;
}

function loadHistory(writer: Database): HistoryRow[] {
  const rows = writer
    .query("SELECT number, name, identity FROM _dbz_migrations ORDER BY number ASC")
    .all() as { number: bigint; name: string; identity: string }[];
  return rows.map((r) => ({ number: Number(r.number), name: r.name, identity: r.identity }));
}

/**
 * Validate the chain against the append-only history and return the pending
 * suffix. The history must be a positional (number, identity) prefix of the
 * chain; a mismatch, or an applied row with no corresponding chain step, means
 * an applied migration was edited — any change to its number, name, pre, target,
 * or transform code shifts the identity — refused loudly, never silently ignored.
 */
export function pendingSteps(writer: Database, steps: MigrationStep[]): MigrationStep[] {
  validateChain(steps);
  const history = loadHistory(writer);
  for (let i = 0; i < history.length; i++) {
    const row = history[i]!;
    const step = steps[i];
    if (step === undefined || step.number !== row.number || migrationIdentity(step, step.code) !== row.identity) {
      throw new MigrationError(
        `applied migration ${stepLabel(row)} no longer matches the chain; applied migrations are immutable ` +
          "(editing its pre, target, or transform code changes its identity). Restore it, or wipe local data with `dbz reset`.",
      );
    }
  }
  return steps.slice(history.length);
}

/** Stamp a whole chain as applied on a fresh database, in one transaction. */
export function recordChain(engine: Engine, steps: MigrationStep[]): void {
  validateChain(steps);
  const writer = engine.writer;
  const insert = writer.query(
    "INSERT INTO _dbz_migrations (number, name, identity, applied_at) VALUES (?, ?, ?, ?)",
  );
  const now = Date.now();
  writer.exec("BEGIN IMMEDIATE");
  try {
    for (const step of steps) insert.run(step.number, step.name, migrationIdentity(step, step.code), now);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
}

// -- one step -----------------------------------------------------------------

/** Everything a single step's transforms and swaps read, all snapshot-derived. */
interface StepScope {
  engine: Engine;
  pre: SchemaSnapshot;
  stored: SchemaSnapshot;
  target: SchemaSnapshot;
  renames: RenamePlan;
  targetPlans: Map<string, TablePlan>;
  oldTags: OldTags;
}

/**
 * Apply one pending step against the stored snapshot, in one transaction that
 * also records the history row. Renames are a pure pre-pass whose renamed-stored
 * snapshot the diff runs against; validation runs next and touches nothing. The
 * transaction then relabels variant tags, persists this step's target tags,
 * applies the safe ops the migration does not own (creates first, so emits land),
 * replays every transform against the before-state, swaps rebuilt tables in,
 * performs pure renames last (so transforms read old physical names), drops
 * acknowledged tables, saves the target snapshot (augmented with any carried
 * columns so it keeps describing physical reality), records the history row, and
 * commits. Returns the applied lines (unprefixed) and the snapshot it saved.
 */
export async function applyStep(
  engine: Engine,
  stored: SchemaSnapshot,
  step: MigrationStep,
): Promise<{ applied: string[]; saved: SchemaSnapshot }> {
  const writer = engine.writer;
  const { pre, target, migration } = step;
  const renames = planRenames(writer, stored, target, migration);
  const diff = diffSnapshots(renames.renamedCurrent, target);
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  const entries = migration.tables ?? {};

  const oldTags = loadOldTags(writer); // pre-rename tags, for decoding old rows
  const stepTags = internStepTags(writer, target, renames.variants); // in-memory target tag maps
  const targetPlans = buildTargetPlans(target, stepTags);
  const planOf = (t: string): TablePlan => targetPlans.get(t)!;

  validateEntries(renames.renamedCurrent, targetPlans, refusals, entries);

  // A surviving table with an entry is rebuilt from its new plan; a table the
  // schema no longer keeps is dropped (after an optional salvage transform).
  const rebuilt = new Set<string>();
  const dropped = new Set<string>();
  for (const name of Object.keys(entries)) (targetPlans.has(name) ? rebuilt : dropped).add(name);

  // A renamed table with other changes cannot ALTER-rename in place. A user
  // transform rebuilds it as usual; without one its remaining changes are
  // shape-safe (validateEntries already demanded a transform for every refusal),
  // so an engine-owned identity rebuild carries every row through the rename map.
  const identityRebuilt = new Set<string>();
  for (const change of diff) {
    if (renames.renamedTables.has(change.table) && !rebuilt.has(change.table)) identityRebuilt.add(change.table);
  }

  // Plan the safe/optimistic work for tables the migration does NOT own — a
  // rebuilt table's classified ops are absorbed by its rebuild, never doubled.
  const ops: Op[] = [];
  const applied: string[] = [];
  const probeRefusals: SchemaRefusal[] = [];
  const count = (sql: string, ...params: unknown[]): number =>
    Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);
  for (const change of safe) {
    if (!rebuilt.has(change.table) && !identityRebuilt.has(change.table)) {
      applySafe(engine, change, renames.renamedCurrent, ops, applied, planOf);
    }
  }
  for (const opt of optimistic) {
    if (rebuilt.has(opt.table)) continue;
    if (identityRebuilt.has(opt.table)) {
      // The physical table still holds pre-rename names until the swap: route
      // the read-only probe through the rename map so the counted refusal
      // survives; the index itself is created from the new plan post-swap.
      const reverse = renames.columnReverse.get(opt.table);
      probeOptimistic(engine, { ...opt, viaRebuild: true }, renames.renamedCurrent, count, ops, applied, probeRefusals, planOf, {
        table: renames.tableOldName.get(opt.table) ?? opt.table,
        column: (c) => reverse?.get(c) ?? c,
      });
    } else {
      probeOptimistic(engine, opt, renames.renamedCurrent, count, ops, applied, probeRefusals, planOf);
    }
  }
  if (probeRefusals.length > 0) throw new UnsafeSchemaChange(probeRefusals);

  const scope: StepScope = { engine, pre, stored, target, renames, targetPlans, oldTags };
  const carriedOf = new Map<string, CarriedColumn[]>();
  for (const name of [...rebuilt, ...identityRebuilt]) {
    const carried = carriedColumns(scope, name);
    if (carried.length > 0) carriedOf.set(name, carried);
  }
  const saved = augmentSnapshot(target, carriedOf);

  writer.exec("BEGIN IMMEDIATE");
  try {
    // Variant renames keep their interned tag: relabel _dbz_tags so the
    // renamed-to variant resolves to the old integer, then persist this step's
    // target tags (renamed and new alike) before any write.
    for (const { type, from, to } of renames.variants) {
      writer.query("UPDATE _dbz_tags SET variant = ? WHERE type = ? AND variant = ?").run(to, type, from);
      applied.push(`renamed variant ${type}.${from} to ${to}`);
    }
    persistTagMaps(writer, stepTags);
    for (const op of ops) op();
    const tmpOf = await runTransforms(scope, entries, rebuilt, identityRebuilt, carriedOf);
    for (const name of [...tmpOf.keys()].sort()) {
      // IF EXISTS: safe drift may have left this database without the old table,
      // in which case the rebuilt tmp simply becomes the (empty) new table.
      writer.exec(`DROP TABLE IF EXISTS ${quote(renames.tableOldName.get(name) ?? name)}`);
      writer.exec(`ALTER TABLE ${quote(tmpOf.get(name)!)} RENAME TO ${quote(name)}`);
      engine.createIndexesPhysical(planOf(name)); // a unique index over bad output fails here
      applied.push(`migrated table ${name}`);
    }
    for (const name of [...renames.renamedTables].filter((t) => !tmpOf.has(t)).sort()) {
      applyPureRename(engine, name, renames, planOf, applied);
    }
    for (const name of [...dropped].sort()) {
      writer.exec(`DROP TABLE ${quote(name)}`);
      applied.push(`dropped table ${name}`);
    }
    engine.saveSnapshot(saved);
    writer
      .query("INSERT INTO _dbz_migrations (number, name, identity, applied_at) VALUES (?, ?, ?, ?)")
      .run(step.number, step.name, migrationIdentity(step, step.code), Date.now());
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
  return { applied, saved };
}

/**
 * Perform a pure structural rename LAST, once every transform has read the old
 * physical names. `ALTER TABLE ... RENAME TO` rewrites the table's stored DDL
 * canonically but leaves index names stale, so a renamed table drops and
 * recreates its indexes from the new plan; `RENAME COLUMN` (both physical
 * columns of a union) canonically rewrites the table and any index it touches,
 * so a name-stable table needs no index work.
 */
function applyPureRename(
  engine: Engine,
  newTable: string,
  renames: RenamePlan,
  planOf: (table: string) => TablePlan,
  applied: string[],
): void {
  const writer = engine.writer;
  const oldTable = renames.tableOldName.get(newTable);
  if (oldTable !== undefined) writer.exec(`ALTER TABLE ${quote(oldTable)} RENAME TO ${quote(newTable)}`);
  for (const [oldPhys, newPhys] of renames.columnPhys.get(newTable) ?? []) {
    writer.exec(`ALTER TABLE ${quote(newTable)} RENAME COLUMN ${quote(oldPhys)} TO ${quote(newPhys)}`);
  }
  if (oldTable === undefined) {
    applied.push(`renamed column(s) on ${newTable}`);
    return;
  }
  const stale = writer
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'")
    .all(newTable) as { name: string }[];
  for (const ix of stale) writer.exec(`DROP INDEX ${quote(ix.name)}`);
  engine.createIndexesPhysical(planOf(newTable));
  applied.push(`renamed table ${oldTable} to ${newTable}`);
}

/** Reject a migration that fails to answer the diff, before anything is touched. */
function validateEntries(
  current: SchemaSnapshot,
  targetPlans: Map<string, TablePlan>,
  refusals: SchemaRefusal[],
  entries: Record<string, RowTransform | null>,
): void {
  const missing = [...new Set(refusals.map((r) => r.table))].filter((t) => !(t in entries)).sort();
  if (missing.length > 0) {
    throw new MigrationError(`migration is missing a transform for refused table(s): ${missing.join(", ")}`);
  }
  for (const [name, value] of Object.entries(entries)) {
    const surviving = targetPlans.has(name);
    if (surviving) {
      if (value === null) {
        throw new MigrationError(`migration entry for "${name}" is null, but "${name}" still exists in the schema`);
      }
    } else if (current.tables[name]?.kind !== "table") {
      throw new MigrationError(`migration references unknown table "${name}"`);
    }
  }
}

// -- target-side codec (encode + DDL from the step's target descriptors) ------

/**
 * Build every real table's NEW-target plan from descriptors + this step's tag
 * maps. Structurally identical to the engine's live plans, so the engine's DDL
 * builders and `physicalInsert` operate on them unchanged.
 */
function buildTargetPlans(target: SchemaSnapshot, tags: Map<string, TagMap>): Map<string, TablePlan> {
  const plans = new Map<string, TablePlan>();
  for (const [name, snap] of Object.entries(target.tables)) {
    if (snap.kind === "table") plans.set(name, snapshotPlan(name, snap, tags));
  }
  return plans;
}

function snapshotPlan(name: string, snap: TableSnapshot, tags: Map<string, TagMap>): TablePlan {
  const columns = new Map<string, ColumnPlan>();
  const physOrder: string[] = [];
  let pk = "";
  let scheduleAt: string | null = null;
  for (const [col, desc] of Object.entries(snap.columns)) {
    const plan = snapshotColumnPlan(col, desc, tags);
    columns.set(col, plan);
    for (const p of plan.phys) physOrder.push(p.name);
    if (plan.kind === "pk") pk = col;
    if (plan.kind === "scheduleAt") scheduleAt = col;
  }
  return { name, pk, scheduleAt, columns, physOrder, indexes: snap.indexes };
}

/** The descriptor-driven encode mirror of `oldColumn`, closing over this step's tags. */
function snapshotColumnPlan(jsName: string, desc: Descriptor, tags: Map<string, TagMap>): ColumnPlan {
  const { base, nullable } = unwrapDesc(desc);
  const kind = base["k"] as string;
  const ddls = physicalColumnDdl(jsName, desc, jsName);
  const physNames = ddls.length === 2 ? [jsName, `${jsName}__p`] : [jsName];
  const phys = physNames.map((n, i) => ({ name: n, ddl: ddls[i]! }));
  const shared = { jsName, kind, nullable, phys };

  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      toSql: (value) => {
        if (value === null) return [null, null];
        const { tag, value: payload } = value as { tag: string; value: unknown };
        const tagInt = tags.get(typeName)!.toTag.get(tag);
        if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${tag}"`);
        return [tagInt, encode(payload)];
      },
      fromSql: (values) =>
        values[0] === null ? null : { tag: tags.get(typeName)!.toName.get(Number(values[0]))!, value: decode(values[1] as string) },
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      toSql: (value) => {
        if (value === null) return [null];
        const tagInt = tags.get(typeName)!.toTag.get(value as string);
        if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${String(value)}"`);
        return [tagInt];
      },
      fromSql: (values) => (values[0] === null ? null : tags.get(typeName)!.toName.get(Number(values[0]))!),
    };
  }
  return {
    ...shared,
    toSql: (value) => [value === null ? null : encodeScalar(kind, value)],
    fromSql: (values) => (values[0] === null ? null : decodeScalar(kind, values[0])),
  };
}

function encodeScalar(kind: string, value: unknown): unknown {
  switch (kind) {
    case "boolean":
      return value ? 1 : 0;
    case "array":
    case "object":
    case "jsonb":
      return encode(value);
    default:
      return value; // pk / string / number / scheduleAt / bigint / identity / bytes store as-is
  }
}

/**
 * Insert a validated row into `target`; a supplied `pk` is preserved. `carried`
 * are stored-physical columns the target plan does not know about (safe drift
 * ahead of the step) — their raw values are copied verbatim under their stored
 * physical names, which the rebuilt tmp holds alongside the plan's columns.
 */
function physicalInsert(
  engine: Engine,
  plan: TablePlan,
  target: EmitTarget,
  values: MigrationRow,
  pk?: bigint,
  carried: { name: string; value: unknown }[] = [],
): void {
  const names: string[] = [];
  const params: unknown[] = [];
  if (pk !== undefined) {
    names.push(target.translate(plan.pk));
    params.push(pk);
  }
  for (const column of plan.columns.values()) {
    if (column.kind === "pk") continue;
    for (const phys of column.phys) names.push(target.translate(phys.name));
    params.push(...column.toSql(values[column.jsName]));
  }
  for (const c of carried) {
    names.push(c.name);
    params.push(c.value);
  }
  const sql = `INSERT INTO ${quote(target.name)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  engine.writer.query(sql).run(...(params as never[]));
}

// -- target-side validation (checkRow, descriptor-driven) ---------------------

/** Validate a transform output / emit against the NEW schema, stripping the pk. */
function checkRow(table: string, snap: TableSnapshot, row: unknown, op: string): MigrationRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new ValidationError(`${table}.${op}: expected a row object`);
  }
  const input = row as MigrationRow;
  const out: MigrationRow = {};
  let pk = "";
  for (const [name, desc] of Object.entries(snap.columns)) {
    if (desc["k"] === "pk") {
      pk = name;
      continue;
    }
    out[name] = checkDescriptor(desc, input[name], `${table}.${op}.${name}`);
  }
  for (const key of Object.keys(input)) {
    if (key !== pk && !(key in snap.columns) && input[key] !== undefined) {
      throw new ValidationError(`${table}.${op}: unknown field "${key}"`);
    }
  }
  return out;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  return typeof value;
}

/**
 * Structural mirror of the dbz validators over a descriptor, for transform
 * output and emits. Every kind a column can hold is expressible: kind and
 * finiteness checks, i64 range, enum membership, union tag membership + payload
 * recursion, strict object keys, and jsonb wire-encodability. Returns the
 * normalized value (nullable/undefined collapse to null, unknown keys reject).
 */
function checkDescriptor(desc: Descriptor, value: unknown, path: string): unknown {
  const kind = desc["k"] as string;
  const expect = (ok: boolean, what: string): void => {
    if (!ok) throw new ValidationError(`${path}: expected ${what}, got ${describeValue(value)}`);
  };
  switch (kind) {
    case "nullable":
      return value === null || value === undefined ? null : checkDescriptor(desc["inner"] as Descriptor, value, path);
    case "pk":
      expect(typeof value === "bigint", "bigint (primary key)");
      return value;
    case "string":
      expect(typeof value === "string", "string");
      return value;
    case "number":
    case "scheduleAt":
      expect(typeof value === "number" && Number.isFinite(value), "finite number");
      return value;
    case "bigint":
    case "identity":
      expect(typeof value === "bigint", "bigint");
      if ((value as bigint) < I64_MIN || (value as bigint) > I64_MAX) {
        throw new ValidationError(`${path}: bigint out of 64-bit range`);
      }
      return value;
    case "boolean":
      expect(typeof value === "boolean", "boolean");
      return value;
    case "bytes":
      expect(value instanceof Uint8Array, "Uint8Array");
      return value;
    case "enum": {
      const values = desc["values"] as string[];
      expect(typeof value === "string" && values.includes(value), `one of ${values.map((v) => JSON.stringify(v)).join(" | ")}`);
      return value;
    }
    case "literal": {
      const lit = decode(JSON.stringify(desc["v"]));
      if (value !== lit) throw new ValidationError(`${path}: expected literal ${describeValue(lit)}, got ${describeValue(value)}`);
      return value;
    }
    case "tag":
      expect(value === null || value === undefined, "null (payload-less variant)");
      return null;
    case "array": {
      expect(Array.isArray(value), "array");
      const el = desc["el"] as Descriptor;
      return (value as unknown[]).map((v, i) => checkDescriptor(el, v, `${path}[${i}]`));
    }
    case "object": {
      expect(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array), "object");
      const shape = desc["shape"] as Record<string, Descriptor>;
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!(key in shape) && input[key] !== undefined) throw new ValidationError(`${path}: unknown field "${key}"`);
      }
      const outObject: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) outObject[key] = checkDescriptor(shape[key]!, input[key], `${path}.${key}`);
      return outObject;
    }
    case "union": {
      expect(value !== null && typeof value === "object" && !Array.isArray(value), "{ tag, value }");
      const input = value as Record<string, unknown>;
      const members = desc["members"] as Record<string, Descriptor>;
      const variant = input["tag"];
      if (typeof variant !== "string" || !(variant in members)) {
        throw new ValidationError(`${path}.tag: expected one of ${Object.keys(members).map((v) => JSON.stringify(v)).join(" | ")}`);
      }
      for (const key of Object.keys(input)) {
        if (key !== "tag" && key !== "value" && input[key] !== undefined) {
          throw new ValidationError(`${path}: unknown field "${key}" on union value`);
        }
      }
      return { tag: variant, value: checkDescriptor(members[variant]!, input["value"], `${path}.value`) };
    }
    case "jsonb":
      if (value === undefined) throw new ValidationError(`${path}: expected JSON value, got undefined`);
      try {
        encode(value);
      } catch (error) {
        if (error instanceof WireError) throw new ValidationError(`${path}: not wire-encodable: ${error.message}`);
        throw error;
      }
      return value;
    default:
      throw new ValidationError(`${path}: unsupported descriptor kind "${kind}"`);
  }
}

// -- old-side decode (pre descriptors, physical-presence guarded) -------------

type OldTags = Map<string, Map<number, string>>;
interface OldColumn {
  col: string;
  phys: string[];
  decode: (values: unknown[]) => unknown;
}
interface OldTable {
  pk: string;
  columns: OldColumn[];
}

/**
 * Every historical (type, variant) → tag map, read straight from `_dbz_tags`.
 * The engine's live `tags` only cover types the current schema names, so a
 * type that survives only in an old snapshot (a dropped table's enum) would be
 * missing; tags are insert-only, so every variant ever stored is here.
 */
function loadOldTags(writer: Database): OldTags {
  const tags: OldTags = new Map();
  for (const row of writer.query("SELECT type, variant, tag FROM _dbz_tags").all() as {
    type: string;
    variant: string;
    tag: bigint;
  }[]) {
    let map = tags.get(row.type);
    if (map === undefined) {
      map = new Map();
      tags.set(row.type, map);
    }
    map.set(Number(row.tag), row.variant);
  }
  return tags;
}

/**
 * Build the descriptor-driven decoder for one old table from its PRE snapshot,
 * guarded by which columns are physically present: a pre-snapshot column absent
 * from the physical table reads `null` (safe drift — the column would have been
 * a nullable add this database has not yet seen).
 */
function buildOldTable(snap: TableSnapshot, physicalCols: Set<string>, oldTags: OldTags): OldTable {
  let pk = "";
  const columns: OldColumn[] = [];
  for (const [col, desc] of Object.entries(snap.columns)) {
    if (desc["k"] === "pk") pk = col;
    columns.push(oldColumn(col, desc, physicalCols, oldTags));
  }
  return { pk, columns };
}

function decodeOldRow(old: OldTable, sqlRow: MigrationRow): MigrationRow {
  const row: MigrationRow = {};
  for (const c of old.columns) row[c.col] = c.decode(c.phys.map((p) => sqlRow[p]));
  return row;
}

function oldColumn(col: string, desc: Descriptor, physicalCols: Set<string>, oldTags: OldTags): OldColumn {
  const { base } = unwrapDesc(desc);
  const kind = base["k"] as string;
  const phys = kind === "union" ? [col, `${col}__p`] : [col];
  if (!physicalCols.has(col)) return { col, phys, decode: () => null };
  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      col,
      phys,
      decode: (v) => (v[0] === null ? null : { tag: oldTags.get(typeName)!.get(Number(v[0]))!, value: decode(v[1] as string) }),
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return { col, phys, decode: (v) => (v[0] === null ? null : oldTags.get(typeName)!.get(Number(v[0]))!) };
  }
  return { col, phys, decode: (v) => (v[0] === null ? null : decodeScalar(kind, v[0])) };
}

function decodeScalar(kind: string, value: unknown): unknown {
  switch (kind) {
    case "number":
    case "scheduleAt":
      return Number(value);
    case "boolean":
      return value === 1n || value === 1;
    case "array":
    case "object":
    case "jsonb":
      return decode(value as string);
    default:
      return value; // pk / string / bigint / identity / bytes round-trip as-is
  }
}

/**
 * Read-only before-state over every PRE table, guarded by physical presence: a
 * pre table not physically present reads empty (get → null, scan → nothing).
 */
function buildBefore(engine: Engine, pre: SchemaSnapshot, stored: SchemaSnapshot, oldTags: OldTags): Record<string, BeforeTable> {
  const writer = engine.writer;
  const before: Record<string, BeforeTable> = {};
  for (const [name, snap] of Object.entries(pre.tables)) {
    if (snap.kind !== "table") continue;
    const physical = stored.tables[name];
    if (physical === undefined || physical.kind !== "table") {
      before[name] = {
        async get() {
          return null;
        },
        // eslint-disable-next-line require-yield
        async *scan() {},
      };
      continue;
    }
    const old = buildOldTable(snap, physColsOf(physical), oldTags);
    before[name] = {
      async get(id) {
        const raw = writer.query(`SELECT * FROM ${quote(name)} WHERE ${quote(old.pk)} = ?`).get(id as never) as MigrationRow | null;
        return raw === null ? null : decodeOldRow(old, raw);
      },
      async *scan() {
        const rows = writer.query(`SELECT * FROM ${quote(name)} ORDER BY ${quote(old.pk)} ASC`).all() as MigrationRow[];
        for (const raw of rows) yield decodeOldRow(old, raw);
      },
    };
  }
  return before;
}

// -- transforms ---------------------------------------------------------------

/**
 * A physical write destination for one NEW-plan table: its physical name and a
 * translator from new physical column names to the ones actually on disk. For a
 * rebuilt table that is its tmp under new names (identity); for a purely-renamed
 * table (renamed LAST) it is the still-old-named physical table and the old
 * column names, so emits during the transform phase land correctly.
 */
interface EmitTarget {
  name: string;
  translate: (col: string) => string;
}

/** A stored-physical column a rebuild must carry through untouched (safe drift). */
interface CarriedColumn {
  jsName: string;
  descriptor: Descriptor;
  /** Stored physical names (a union contributes both `col` and `col__p`). */
  phys: string[];
  /** DDL for the tmp, from the stored descriptor (kept nullable-as-stored). */
  ddls: string[];
  nullable: boolean;
}

/**
 * The columns a rebuild of `name` must carry: every stored-physical column that
 * is absent from BOTH the step's `pre` and its target plan — safe drift that
 * landed on this database from a lineage the migration never saw. A column the
 * migration knew (in `pre`) but the target drops is a deliberate, acknowledged
 * drop and is NOT carried; a column the renames map into the target is excluded
 * (its data moves via the rename); so is the pk and every target column (they
 * are the plan). One mechanism, shared by every rebuild flavor: append the DDL
 * to the tmp, copy the raw values on replay.
 */
function carriedColumns(scope: StepScope, name: string): CarriedColumn[] {
  const { pre, stored, renames, targetPlans } = scope;
  const oldPhysName = renames.tableOldName.get(name) ?? name;
  const storedSnap = stored.tables[oldPhysName];
  if (storedSnap === undefined || storedSnap.kind !== "table") return [];
  const reverse = renames.columnReverse.get(name);
  const targetOldPhys = new Set(targetPlans.get(name)!.physOrder.map((c) => reverse?.get(c) ?? c));
  const preColumns = pre.tables[oldPhysName]?.columns ?? {};
  const carried: CarriedColumn[] = [];
  for (const [col, desc] of Object.entries(storedSnap.columns)) {
    if (col in preColumns) continue; // the migration knew this column; a target dropping it is deliberate
    const phys = namedOf(desc)?.kind === "union" ? [col, `${col}__p`] : [col];
    if (phys.some((p) => targetOldPhys.has(p))) continue;
    carried.push({ jsName: col, descriptor: desc, phys, ddls: physicalColumnDdl(col, desc, col), nullable: unwrapDesc(desc).nullable });
  }
  return carried;
}

/**
 * The snapshot a step saves: its target augmented with every carried column's
 * descriptor (target order, then carried in stored order). The physical table
 * now holds columns the bare target lacks, so the stored snapshot must keep
 * describing them or the next `verifyApplicationSchema` refuses the open. The
 * carried column simply resurfaces as drift in the next step's diff and the
 * final safe hop (live schema has it → no-op; lacks it → ordinary drop refusal).
 */
function augmentSnapshot(target: SchemaSnapshot, carriedOf: Map<string, CarriedColumn[]>): SchemaSnapshot {
  if (carriedOf.size === 0) return target;
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, snap] of Object.entries(target.tables)) {
    const carried = carriedOf.get(name);
    if (carried === undefined) {
      tables[name] = snap;
      continue;
    }
    const columns: Record<string, Descriptor> = { ...snap.columns };
    for (const c of carried) columns[c.jsName] = c.descriptor;
    tables[name] = { ...snap, columns };
  }
  return { version: 1, tables };
}

/**
 * Run every transform against the before-state and return the temporary
 * physical name of each rebuilt table. Rebuilt tables are materialized empty
 * first (with their sequence seeded so emitted ids never collide with or reuse
 * a preserved one); old tables are only read, never modified, so transforms
 * observe a single frozen image regardless of order. A rebuilt+renamed table
 * reads its rows from its OLD physical name and PRE descriptors. Identity
 * rebuilds (renamed tables whose other changes are all shape-safe, no user
 * transform) are copied wholesale through the rename map before any transform
 * runs, so emits into them land in the tmp alongside the carried rows. Each
 * rebuild also carries every stored-physical column its target plan does not
 * know about (`carriedOf`): the tmp gains those columns and replayed rows copy
 * their raw values. A target column the PRE lacks but the database already
 * holds defaults to the old row's stored value unless the transform's raw
 * output provides the key. Emits into non-rebuilt tables are buffered and
 * flushed only after every transform has run, so the frozen before-state never
 * sees them.
 */
async function runTransforms(
  scope: StepScope,
  entries: Record<string, RowTransform | null>,
  rebuilt: Set<string>,
  identityRebuilt: Set<string>,
  carriedOf: Map<string, CarriedColumn[]>,
): Promise<Map<string, string>> {
  const { engine, pre, stored, target, renames, targetPlans, oldTags } = scope;
  const writer = engine.writer;
  const planOf = (t: string): TablePlan => targetPlans.get(t)!;
  const tmpOf = new Map<string, string>();
  for (const name of [...rebuilt, ...identityRebuilt].sort()) {
    const oldPhys = renames.tableOldName.get(name) ?? name;
    const tmp = `${name}__migrate`;
    tmpOf.set(name, tmp);
    const carriedDdls = (carriedOf.get(name) ?? []).flatMap((c) => c.ddls);
    writer.exec(engine.createTableDdl(planOf(name), tmp, carriedDdls));
    const seq = writer.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(oldPhys) as { seq: bigint } | null;
    if (seq !== null) writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tmp, seq.seq);
  }

  // Identity rebuild: one INSERT..SELECT per table, new physical columns fed
  // from their pre-rename names; columns absent from the old physical table are
  // omitted (new nullable columns land NULL). Carried columns keep their stored
  // names on both sides (a verbatim copy). No per-row JS ever runs.
  for (const name of [...identityRebuilt].sort()) {
    const oldPhysName = renames.tableOldName.get(name) ?? name;
    const reverse = renames.columnReverse.get(name);
    const oldCols = physColsOf(stored.tables[oldPhysName]!);
    const pairs = planOf(name)
      .physOrder.map((c) => [reverse?.get(c) ?? c, c] as const)
      .filter(([old]) => oldCols.has(old));
    const carriedPhys = (carriedOf.get(name) ?? []).flatMap((c) => c.phys);
    const insertCols = [...pairs.map(([, c]) => c), ...carriedPhys];
    const selectCols = [...pairs.map(([old]) => old), ...carriedPhys];
    writer.exec(
      `INSERT INTO ${quote(tmpOf.get(name)!)} (${insertCols.map(quote).join(", ")}) ` +
        `SELECT ${selectCols.map(quote).join(", ")} FROM ${quote(oldPhysName)}`,
    );
  }

  const emitTargetOf = (table: string): EmitTarget => {
    if (tmpOf.has(table)) return { name: tmpOf.get(table)!, translate: (c) => c };
    if (!renames.renamedTables.has(table)) return { name: table, translate: (c) => c };
    const reverse = renames.columnReverse.get(table); // undefined for a table-only rename
    return { name: renames.tableOldName.get(table) ?? table, translate: (c) => reverse?.get(c) ?? c };
  };

  // Emits into non-rebuilt tables write to the same connection `ctx.before`
  // reads, so they are buffered here and flushed after every transform has run;
  // emits into rebuilt tables go to the (invisible) tmp and stay immediate.
  const staged: { table: string; row: MigrationRow }[] = [];
  const ctx: MigrationContext = {
    before: buildBefore(engine, pre, stored, oldTags),
    insert(table, row) {
      if (!targetPlans.has(table)) throw new ValidationError(`migration insert: unknown table "${table}"`);
      const validated = checkRow(table, target.tables[table]!, row, "insert"); // eager: error locality stays here
      if (!tmpOf.has(table)) {
        staged.push({ table, row: validated });
        return;
      }
      const notNull = (carriedOf.get(table) ?? []).find((c) => !c.nullable);
      if (notNull !== undefined) {
        throw new ValidationError(`migration insert into "${table}": carried NOT NULL column "${notNull.jsName}" cannot be emitted`);
      }
      physicalInsert(engine, planOf(table), emitTargetOf(table), validated);
    },
  };

  for (const [name, fn] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (fn === null) continue;
    const oldPhys = renames.tableOldName.get(name) ?? name;
    const preSnap = pre.tables[oldPhys];
    const physical = stored.tables[oldPhys];
    // Safe drift: a pre table with no physical presence has no old rows to
    // replay (a rebuilt table stays the empty tmp; a salvage is a no-op).
    if (preSnap === undefined || physical === undefined || physical.kind !== "table") continue;
    const old = buildOldTable(preSnap, physColsOf(physical), oldTags);
    const rows = writer.query(`SELECT * FROM ${quote(oldPhys)} ORDER BY ${quote(old.pk)} ASC`).all() as MigrationRow[];
    if (!rebuilt.has(name)) {
      for (const raw of rows) await fn(decodeOldRow(old, raw), ctx); // salvage: emits only
      continue;
    }
    const plan = planOf(name);
    const emit = emitTargetOf(name); // the tmp under new names
    const carried = carriedOf.get(name) ?? [];
    // Target columns the PRE never typed but the database already physically
    // holds (parallel-lineage drift the target re-declares): a PRE-typed
    // transform cannot see them, so when its raw output does not provide the
    // key the stored value is decoded and used as the default. `undefined`
    // counts as absent — carrying the stored value is the data-safe reading —
    // while an explicit null is a provided value and wins.
    const reverse = renames.columnReverse.get(name);
    const defaults = [...plan.columns.values()]
      .filter((c) => c.kind !== "pk")
      .map((c) => ({ jsName: c.jsName, oldJs: reverse?.get(c.phys[0]!.name) ?? c.jsName }))
      .filter(({ oldJs }) => preSnap.columns[oldJs] === undefined && physical.columns[oldJs] !== undefined)
      .map(({ jsName, oldJs }) => ({ jsName, old: oldColumn(oldJs, physical.columns[oldJs]!, physColsOf(physical), oldTags) }));
    for (const raw of rows) {
      const decoded = decodeOldRow(old, raw);
      const result = await fn(decoded, ctx);
      if (result === null) continue; // deleted: the whole row goes, carried values included
      let out = (result ?? decoded) as MigrationRow;
      if (defaults.length > 0 && typeof out === "object" && !Array.isArray(out)) {
        out = { ...out }; // never mutate the transform's returned object
        for (const d of defaults) {
          if (out[d.jsName] === undefined) out[d.jsName] = d.old.decode(d.old.phys.map((p) => raw[p]));
        }
      }
      const carriedValues = carried.flatMap((c) => c.phys.map((p) => ({ name: p, value: raw[p] })));
      physicalInsert(engine, plan, emit, checkRow(name, target.tables[name]!, out, "transform"), decoded[old.pk] as bigint, carriedValues);
    }
  }
  for (const { table, row } of staged) {
    physicalInsert(engine, planOf(table), emitTargetOf(table), row); // ids assigned now; nothing read them earlier
  }
  return tmpOf;
}

// -- tag interning for a step -------------------------------------------------

/**
 * Compute this step's target tag maps directly against `_dbz_tags` (insert-only,
 * max+1 per type in declaration order), relabelling any renamed variant so it
 * keeps its original integer. Read-only; the actual UPDATE + INSERT run inside
 * the step's transaction (`persistTagMaps`), producing the same end state.
 */
function internStepTags(writer: Database, target: SchemaSnapshot, variants: RenamePlan["variants"]): Map<string, TagMap> {
  const renameByType = new Map<string, Map<string, string>>();
  for (const { type, from, to } of variants) {
    (renameByType.get(type) ?? renameByType.set(type, new Map()).get(type)!).set(from, to);
  }
  const maps = new Map<string, TagMap>();
  for (const row of writer.query("SELECT type, variant, tag FROM _dbz_tags").all() as {
    type: string;
    variant: string;
    tag: bigint;
  }[]) {
    let map = maps.get(row.type);
    if (map === undefined) {
      map = { toTag: new Map(), toName: new Map() };
      maps.set(row.type, map);
    }
    const name = renameByType.get(row.type)?.get(row.variant) ?? row.variant;
    const tag = Number(row.tag);
    map.toTag.set(name, tag);
    map.toName.set(tag, name);
  }
  for (const [type, variantSet] of variantSets(target)) {
    let map = maps.get(type);
    if (map === undefined) {
      map = { toTag: new Map(), toName: new Map() };
      maps.set(type, map);
    }
    let max = Math.max(-1, ...map.toName.keys());
    for (const variant of variantSet) {
      if (!map.toTag.has(variant)) {
        max++;
        map.toTag.set(variant, max);
        map.toName.set(max, variant);
      }
    }
  }
  return maps;
}

/** Persist a step's tag maps (insert-only). The caller owns the transaction. */
function persistTagMaps(writer: Database, maps: Map<string, TagMap>): void {
  const insert = writer.query(
    "INSERT INTO _dbz_tags (type, variant, tag) VALUES (?, ?, ?) ON CONFLICT(type, variant) DO NOTHING",
  );
  for (const [type, map] of maps) {
    for (const [variant, tag] of map.toTag) insert.run(type, variant, tag);
  }
}

// -- renames ------------------------------------------------------------------

export interface NormalizedRenames {
  tables: Record<string, string>; // old -> new
  columns: Record<string, Record<string, string>>; // NEW table name -> { oldCol -> newCol }
  variants: Record<string, Record<string, string>>; // type name -> { oldVariant -> newVariant }
}

interface RenamePlan {
  /** The stored snapshot with every rename applied — what the diff runs against. */
  renamedCurrent: SchemaSnapshot;
  /** new table name -> old table name, for tables whose name changed. */
  tableOldName: Map<string, string>;
  /** new table name -> physical [old, new] column pairs (a union contributes both). */
  columnPhys: Map<string, [string, string][]>;
  /** new table name -> new physical column name -> old physical column name. */
  columnReverse: Map<string, Map<string, string>>;
  variants: { type: string; from: string; to: string }[];
  /** Every new table name touched by a table or column rename. */
  renamedTables: Set<string>;
}

/**
 * Validate the rename declarations (MigrationError, nothing touched) and derive
 * the renamed-stored snapshot plus the physical rename work. `columns` are keyed
 * by the TARGET table name, so table renames are resolved first; a column's
 * physical arity comes from its TARGET descriptor (a union contributes two).
 */
function planRenames(writer: Database, current: SchemaSnapshot, target: SchemaSnapshot, migration: Migration): RenamePlan {
  const raw: NormalizedRenames = {
    tables: migration.renames?.tables ?? {},
    columns: migration.renames?.columns ?? {},
    variants: migration.renames?.variants ?? {},
  };
  validateRenames(writer, current, target, raw);

  const tableOldName = new Map<string, string>();
  for (const [oldT, newT] of Object.entries(raw.tables)) tableOldName.set(newT, oldT);

  const columnPhys = new Map<string, [string, string][]>();
  const columnReverse = new Map<string, Map<string, string>>();
  for (const [table, cols] of Object.entries(raw.columns)) {
    const pairs: [string, string][] = [];
    const reverse = new Map<string, string>();
    for (const [oldCol, newCol] of Object.entries(cols)) {
      pairs.push([oldCol, newCol]);
      reverse.set(newCol, oldCol);
      if (namedOf(target.tables[table]!.columns[newCol]!)?.kind === "union") {
        pairs.push([`${oldCol}__p`, `${newCol}__p`]);
        reverse.set(`${newCol}__p`, `${oldCol}__p`);
      }
    }
    columnPhys.set(table, pairs);
    columnReverse.set(table, reverse);
  }

  const variants: RenamePlan["variants"] = [];
  for (const [type, vmap] of Object.entries(raw.variants)) {
    for (const [from, to] of Object.entries(vmap)) variants.push({ type, from, to });
  }

  return {
    renamedCurrent: applyRenames(current, raw),
    tableOldName,
    columnPhys,
    columnReverse,
    variants,
    renamedTables: new Set([...tableOldName.keys(), ...Object.keys(raw.columns)]),
  };
}

function validateRenames(writer: Database, current: SchemaSnapshot, target: SchemaSnapshot, raw: NormalizedRenames): void {
  const tableTargets = new Set<string>();
  for (const [oldT, newT] of Object.entries(raw.tables)) {
    if (current.tables[oldT]?.kind !== "table") throw new MigrationError(`rename source table "${oldT}" does not exist`);
    if (target.tables[newT] === undefined) throw new MigrationError(`rename target table "${newT}" is not in the schema`);
    if (target.tables[oldT] !== undefined) {
      throw new MigrationError(`rename source table "${oldT}" still exists in the schema; it was not dropped`);
    }
    if (current.tables[newT] !== undefined) {
      throw new MigrationError(`rename target table "${newT}" already exists; cannot rename onto a live table`);
    }
    if (tableTargets.has(newT)) throw new MigrationError(`two renames target table "${newT}"`);
    tableTargets.add(newT);
  }

  for (const [table, cols] of Object.entries(raw.columns)) {
    if (target.tables[table] === undefined) throw new MigrationError(`rename target table "${table}" is not in the schema`);
    const oldTable = Object.keys(raw.tables).find((o) => raw.tables[o] === table) ?? table;
    const from = current.tables[oldTable]?.columns ?? {};
    const to = target.tables[table]!.columns;
    const colTargets = new Set<string>();
    for (const [oldCol, newCol] of Object.entries(cols)) {
      if (from[oldCol] === undefined) throw new MigrationError(`rename source column "${table}.${oldCol}" does not exist`);
      if (to[newCol] === undefined) throw new MigrationError(`rename target column "${table}.${newCol}" is not in the schema`);
      if (to[oldCol] !== undefined) {
        throw new MigrationError(`rename source column "${table}.${oldCol}" still exists in the schema; it was not dropped`);
      }
      if (from[newCol] !== undefined) {
        throw new MigrationError(`rename target column "${table}.${newCol}" already exists; cannot rename onto a live column`);
      }
      if (colTargets.has(newCol)) throw new MigrationError(`two renames target column "${table}.${newCol}"`);
      colTargets.add(newCol);
    }
  }

  const currentVariants = variantSets(current);
  const targetVariants = variantSets(target);
  const taggedVariants = new Map<string, Set<string>>();
  for (const row of writer.query("SELECT type, variant FROM _dbz_tags").all() as { type: string; variant: string }[]) {
    (taggedVariants.get(row.type) ?? taggedVariants.set(row.type, new Set()).get(row.type)!).add(row.variant);
  }
  for (const [type, vmap] of Object.entries(raw.variants)) {
    const fromSet = currentVariants.get(type) ?? new Set();
    const toSet = targetVariants.get(type) ?? new Set();
    const seen = new Set<string>();
    for (const [from, to] of Object.entries(vmap)) {
      if (!fromSet.has(from)) throw new MigrationError(`rename source variant "${type}.${from}" does not exist`);
      if (!toSet.has(to)) throw new MigrationError(`rename target variant "${type}.${to}" is not in the schema`);
      if (toSet.has(from)) {
        throw new MigrationError(`rename source variant "${type}.${from}" still exists in the schema; it was not removed`);
      }
      if (fromSet.has(to)) {
        throw new MigrationError(`rename target variant "${type}.${to}" already exists; cannot rename onto a live variant`);
      }
      if (taggedVariants.get(type)?.has(to)) {
        throw new MigrationError(`rename target variant "${type}.${to}" is a retired variant; its tag is retired forever`);
      }
      if (seen.has(to)) throw new MigrationError(`two renames target variant "${type}.${to}"`);
      seen.add(to);
    }
  }
}

/**
 * Rewrite table keys, column keys, index column references, and variant names.
 * Exported for migration generation, which classifies the diff of the
 * renamed-stored snapshot against the target without ever opening a database.
 */
export function applyRenames(current: SchemaSnapshot, raw: NormalizedRenames): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, snap] of Object.entries(current.tables)) tables[name] = structuredClone(snap);
  for (const [oldT, newT] of Object.entries(raw.tables)) {
    tables[newT] = tables[oldT]!;
    delete tables[oldT];
  }
  for (const [table, cols] of Object.entries(raw.columns)) {
    const snap = tables[table]!;
    const columns: Record<string, Descriptor> = {};
    for (const [col, desc] of Object.entries(snap.columns)) columns[cols[col] ?? col] = desc;
    snap.columns = columns;
    snap.indexes = snap.indexes.map((ix) => ({ ...ix, columns: ix.columns.map((c) => cols[c] ?? c) }));
  }
  for (const [type, vmap] of Object.entries(raw.variants)) {
    for (const snap of Object.values(tables)) {
      for (const col of Object.keys(snap.columns)) snap.columns[col] = renameVariants(snap.columns[col]!, type, vmap);
    }
  }
  return { version: 1, tables };
}

/**
 * Rewrite variant names of the named `type` on a TOP-LEVEL column descriptor
 * only (through nullable). A tag relabel is zero-rewrite only where variants
 * are stored as interned tags — the top level; nested enum/union values are
 * wire-encoded STRINGS, so a deep rewrite would erase the diff while stranding
 * stale variant strings the new type cannot validate. Left untouched, a nested
 * use of the renamed type surfaces as an honest type-changed refusal whose
 * transform rewrites the payloads. That is correct behavior, not a limitation.
 */
function renameVariants(desc: Descriptor, type: string, vmap: Record<string, string>): Descriptor {
  if (desc["k"] === "nullable") {
    return { ...desc, inner: renameVariants(desc["inner"] as Descriptor, type, vmap) };
  }
  if (desc["k"] === "enum" && desc["name"] === type) {
    return { ...desc, values: (desc["values"] as string[]).map((v) => vmap[v] ?? v) };
  }
  if (desc["k"] === "union" && desc["name"] === type) {
    const members: Record<string, Descriptor> = {};
    for (const [variant, d] of Object.entries(desc["members"] as Record<string, Descriptor>)) {
      members[vmap[variant] ?? variant] = d; // payload descriptors untouched: nested uses must diff
    }
    return { ...desc, members };
  }
  return desc;
}

/** Collect the variant set of every named enum/union in a snapshot, by type name. */
function variantSets(snapshot: SchemaSnapshot): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (desc: Descriptor): void => {
    switch (desc["k"]) {
      case "nullable":
        return visit(desc["inner"] as Descriptor);
      case "array":
        return visit(desc["el"] as Descriptor);
      case "object":
        return void Object.values(desc["shape"] as Record<string, Descriptor>).forEach(visit);
      case "enum": {
        const set = out.get(desc["name"] as string) ?? out.set(desc["name"] as string, new Set()).get(desc["name"] as string)!;
        for (const v of desc["values"] as string[]) set.add(v);
        return;
      }
      case "union": {
        const set = out.get(desc["name"] as string) ?? out.set(desc["name"] as string, new Set()).get(desc["name"] as string)!;
        for (const [variant, d] of Object.entries(desc["members"] as Record<string, Descriptor>)) {
          set.add(variant);
          visit(d);
        }
        return;
      }
    }
  };
  for (const table of Object.values(snapshot.tables)) for (const desc of Object.values(table.columns)) visit(desc);
  return out;
}
