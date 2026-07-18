/**
 * The migration plan: what a refused schema change asks of the developer, and
 * the on-disk generation that answers it. Everything here is pure of the dev
 * supervisor — it opens no Engine and never takes the dbzz process lock. The
 * stored snapshot is read through a plain READ-ONLY `bun:sqlite` connection, so
 * a peek is always safe whether the serve child is freshly dead or still alive
 * (a reader sees only committed state).
 *
 * Three seams the command layer drives:
 *   - `computePlan`      diff the STORED snapshot against the live schema and
 *                        classify it into an outcome the form and the supervisor
 *                        act on (no database, pending chain, clean, or changes);
 *   - `renameCandidates` the ambiguous drop/add pairs the form asks about,
 *                        derived purely from the diff (unit-testable);
 *   - `writeMigration`   re-derive pre/target fresh and lay the three artifacts
 *                        onto disk — the one generation path both the `generate`
 *                        command and the internal `__generate` child share.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifySchemaDiff,
  diffSnapshots,
  refusalSite,
  snapshotOf,
  stepLabel,
  type RefusalReason,
  type Renames,
  type SchemaDiff,
  type SchemaRefusal,
  type SchemaSnapshot,
} from "@dbzz/server";
import { importSchema } from "./app.ts";
import type { AppConfig } from "./config.ts";
import { generateMigration } from "./generate.ts";
import { loadMigrationChain } from "./migrations.ts";

// -- stored snapshot (read-only peek) -----------------------------------------

export interface StoredState {
  /** The snapshot the database last committed — the pre-state new migrations sit on. */
  snapshot: SchemaSnapshot;
  /** Rows in `_dbz_migrations`; the applied prefix of the chain. */
  appliedCount: number;
}

/**
 * Read the stored snapshot and applied-migration count through a read-only
 * connection. `null` when there is no database yet (nothing to migrate — `dbz
 * dev` initializes a fresh one), or when the file exists but holds no snapshot.
 */
export function readStoredState(config: AppConfig): StoredState | null {
  const path = join(config.dbDir, "data.db");
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT value FROM _dbz_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    if (row === null) return null;
    const counted = db.query("SELECT COUNT(*) AS n FROM _dbz_migrations").get() as { n: number };
    return { snapshot: JSON.parse(row.value) as SchemaSnapshot, appliedCount: Number(counted.n) };
  } finally {
    db.close();
  }
}

// -- rename candidates (pure projection of the diff) --------------------------

export interface CandidateGroup {
  /** Removed names, sorted — each the "old" side of a possible rename. */
  dropped: string[];
  /** Added names, sorted — the pool the form offers as rename targets. */
  added: string[];
}

/**
 * The ambiguous drop/add pairs a diff cannot resolve into renames on its own:
 * dropped vs added real TABLES (global pool), per surviving table dropped vs
 * added COLUMNS, and per enum/union type removed vs added VARIANTS. The form
 * pairs them; the diff only presents them.
 */
export interface RenameCandidates {
  tables: CandidateGroup;
  /** Keyed by the (stable) table name. */
  columns: Record<string, CandidateGroup>;
  /** Keyed by the enum/union type name. */
  variants: Record<string, CandidateGroup>;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

export function renameCandidates(diff: SchemaDiff): RenameCandidates {
  const tables: CandidateGroup = { dropped: [], added: [] };
  const columns: Record<string, CandidateGroup> = {};
  const variants: Record<string, { dropped: Set<string>; added: Set<string> }> = {};
  const variantGroup = (type: string) =>
    (variants[type] ??= { dropped: new Set(), added: new Set() });

  for (const change of diff) {
    if (change.op === "table-added") {
      if (change.kind === "table") tables.added.push(change.table);
    } else if (change.op === "table-dropped") {
      if (change.kind === "table") tables.dropped.push(change.table);
    } else if (change.op === "table-altered") {
      const group: CandidateGroup = { dropped: [], added: [] };
      for (const col of change.columns) {
        if (col.op === "dropped") group.dropped.push(col.column);
        else if (col.op === "added") group.added.push(col.column);
        else if (col.op === "variants-changed") {
          const vg = variantGroup(col.typeName);
          for (const v of col.variants) {
            if (v.op === "removed") vg.dropped.add(v.variant);
            else if (v.op === "added") vg.added.add(v.variant);
          }
        }
      }
      if (group.dropped.length > 0 || group.added.length > 0) {
        columns[change.table] = { dropped: group.dropped.sort(), added: group.added.sort() };
      }
    }
  }

  const variantOut: Record<string, CandidateGroup> = {};
  for (const [type, g] of Object.entries(variants)) {
    if (g.dropped.size > 0 || g.added.size > 0) {
      variantOut[type] = { dropped: sorted(g.dropped), added: sorted(g.added) };
    }
  }
  return { tables: { dropped: tables.dropped.sort(), added: tables.added.sort() }, columns, variants: variantOut };
}

// -- the plan outcome ---------------------------------------------------------

export type PlanOutcome =
  | { status: "no-database" }
  | { status: "pending"; pendingCount: number; nextNumber: number }
  | { status: "clean" }
  | { status: "changes"; refusals: SchemaRefusal[]; candidates: RenameCandidates; nextNumber: number };

/**
 * Diff the stored snapshot against the live schema and classify the result.
 * Pending migrations short-circuit: a new migration always sits on a
 * fully-applied chain, so `pre` (the stored snapshot) is only the right
 * pre-state once the chain is fully applied.
 */
export async function computePlan(config: AppConfig): Promise<PlanOutcome> {
  const state = readStoredState(config);
  if (state === null) return { status: "no-database" };
  const chain = await loadMigrationChain(config);
  const nextNumber = (chain.at(-1)?.number ?? 0) + 1;
  const pendingCount = chain.length - state.appliedCount;
  if (pendingCount > 0) return { status: "pending", pendingCount, nextNumber };
  const schema = await importSchema(config);
  const diff = diffSnapshots(state.snapshot, snapshotOf(schema));
  const { refusals } = classifySchemaDiff(diff);
  if (refusals.length === 0) return { status: "clean" };
  return { status: "changes", refusals, candidates: renameCandidates(diff), nextNumber };
}

// -- the wire form (one JSON line from the `__plan` child) ---------------------

export type PlanWire =
  | { error: string }
  | { clean: true }
  | {
      clean: false;
      refusals: SchemaRefusal[];
      candidates: RenameCandidates;
      nextNumber: number;
      pendingCount: number;
    };

const EMPTY_CANDIDATES: RenameCandidates = { tables: { dropped: [], added: [] }, columns: {}, variants: {} };

/** Project an outcome onto the single JSON line `__plan` prints for a fresh child. */
export function planToWire(outcome: PlanOutcome, config: AppConfig): PlanWire {
  switch (outcome.status) {
    case "no-database":
      return { error: `no database at ${join(config.dbDir, "data.db")}; \`dbz dev\` initializes a fresh one` };
    case "clean":
      return { clean: true };
    case "pending":
      return {
        clean: false,
        refusals: [],
        candidates: EMPTY_CANDIDATES,
        nextNumber: outcome.nextNumber,
        pendingCount: outcome.pendingCount,
      };
    case "changes":
      return {
        clean: false,
        refusals: outcome.refusals,
        candidates: outcome.candidates,
        nextNumber: outcome.nextNumber,
        pendingCount: 0,
      };
  }
}

// -- name slug ----------------------------------------------------------------

const REASON_WORD: Record<RefusalReason, string> = {
  "column-type-changed": "retype",
  "column-made-required": "require",
  "required-column-added": "add",
  "column-dropped": "drop",
  "variant-removed": "variant",
  "variant-payload-changed": "variant",
  "table-dropped": "drop",
  "table-to-event": "event",
  "unique-index-duplicates": "dedupe",
};

/**
 * A short, deterministic migration name derived from the first refusal (its
 * site plus a word for the reason), sanitized to the loader's `[A-Za-z0-9_]+`
 * grammar. Only used when the developer does not name the migration themselves.
 */
export function deriveSlug(refusals: SchemaRefusal[]): string {
  const first = refusals[0];
  if (first === undefined) return "migration";
  const raw = `${refusalSite(first).replace(/\./g, "_")}_${REASON_WORD[first.reason]}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "migration";
}

// -- generation (the shared on-disk write path) -------------------------------

const MIGRATION_NAME = /^[A-Za-z0-9_]+$/;

export interface GenerateRequest {
  name: string;
  renames?: Renames;
}

/**
 * Re-derive pre/target fresh and write the three artifacts of the next
 * migration, returning their absolute paths. Refuses the same states
 * `computePlan` flags — no database, or a chain that is not fully applied — so
 * the recorded `pre` is always the true pre-state. This is the single
 * generation path behind both `dbz generate` and the `__generate` child.
 */
export async function writeMigration(config: AppConfig, request: GenerateRequest): Promise<string[]> {
  if (!MIGRATION_NAME.test(request.name)) {
    throw new Error(`migration name "${request.name}" must be one or more of [A-Za-z0-9_]`);
  }
  const state = readStoredState(config);
  if (state === null) {
    throw new Error(`no database at ${join(config.dbDir, "data.db")}; run \`dbz dev\` to initialize it first`);
  }
  const chain = await loadMigrationChain(config);
  const pendingCount = chain.length - state.appliedCount;
  if (pendingCount > 0) {
    throw new Error(`apply the ${pendingCount} pending migration(s) first — start \`dbz dev\``);
  }

  const schema = await importSchema(config);
  const number = (chain.at(-1)?.number ?? 0) + 1;
  const { migrationTs, typesTs, metaJson } = generateMigration({
    number,
    name: request.name,
    pre: state.snapshot,
    schema,
    renames: request.renames ?? {},
  });

  const stem = stepLabel({ number, name: request.name });
  const metaDir = join(config.migrationsDir, "meta");
  mkdirSync(metaDir, { recursive: true });
  const artifacts: [string, string][] = [
    [join(config.migrationsDir, `${stem}.ts`), migrationTs],
    [join(metaDir, `${stem}.types.ts`), typesTs],
    [join(metaDir, `${stem}.json`), metaJson],
  ];
  for (const [path, content] of artifacts) writeFileSync(path, content);
  return artifacts.map(([path]) => path);
}
