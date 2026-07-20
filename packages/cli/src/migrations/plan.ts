/**
 * The migration plan: what a refused schema change asks of the developer, and
 * the on-disk generation that answers it. Everything here is pure of the dev
 * supervisor — it opens no Engine and never takes the dbzz process lock. The
 * stored snapshot is read through a plain READ-ONLY `bun:sqlite` connection, so
 * a peek is always safe whether the serve child is freshly dead or still alive
 * (a reader sees only committed state).
 *
 * Two seams the command layer drives:
 *   - `computePlan`      diff the STORED snapshot against the live schema and
 *                        classify it into an outcome the form and the supervisor
 *                        act on (no database, pending chain, clean, or changes);
 *   - `renameCandidates` the ambiguous drop/add pairs the form asks about,
 *                        derived purely from the diff (unit-testable).
 * The generation half — re-deriving pre/target and laying the artifacts onto
 * disk — lives in its sibling `write.ts`, which consumes this module's stored-state
 * read and optimistic data probes.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  applyRenames,
  classifySchemaDiff,
  diffSnapshots,
  migrationIdentity,
  MigrationError,
  probeOptimisticChanges,
  renameRoutes,
  refusalSite,
  snapshotOf,
  stepLabel,
  validateHistoryPrefix,
  type MigrationStep,
  type NormalizedRenames,
  type Renames,
  type RefusalReason,
  type SchemaDiff,
  type SchemaRefusal,
  type SchemaSnapshot,
  type TableChange,
} from "@dbzz/server";
import { importSchema } from "../app.ts";
import type { AppConfig } from "../config.ts";
import { loadMigrationChain, migrationArtifactPaths } from "./load.ts";
import { readStoredState } from "./stored.ts";

export { readStoredState, type StoredState } from "./stored.ts";

/**
 * Preview every optimistic unique-index or validator tightening against the
 * stored database. The CLI uses this committed read to offer a repair scaffold;
 * the writer repeats the same guards transactionally before applying anything.
 */
export function probeOptimisticRefusals(
  config: AppConfig,
  current: SchemaSnapshot,
  target: SchemaSnapshot,
  renames: Renames = {},
): SchemaRefusal[] {
  const normalized: NormalizedRenames = {
    tables: renames.tables ?? {},
    columns: renames.columns ?? {},
    variants: renames.variants ?? {},
  };
  const renamedCurrent = applyRenames(current, normalized);
  const { optimistic } = classifySchemaDiff(diffSnapshots(renamedCurrent, target));
  if (optimistic.length === 0) return [];
  const routes = renameRoutes(target, normalized);
  const db = new Database(join(config.dbDir, "data.db"), { readonly: true });
  try {
    return probeOptimisticChanges(
      db,
      renamedCurrent,
      optimistic.map((change) => ({
        change,
        phys: {
          table: routes.tableOldName.get(change.table) ?? change.table,
          column: (column: string) => routes.columnReverse.get(change.table)?.get(column) ?? column,
        },
      })),
      (table, index) => target.tables[table]!.indexes.find((candidate) => candidate.name === index)!.columns,
      { variantRenames: normalized.variants },
    );
  } finally {
    db.close();
  }
}

// -- consent fingerprint ------------------------------------------------------

/**
 * The fingerprint a displayed ledger reflects: a hash over the exact (pre,
 * target) snapshot pair the plan was derived from. Consent carries it back into
 * generation, which re-derives fresh and refuses on mismatch — so a yes can
 * never authorize changes the developer was not shown. Netstring framing keeps
 * the two parts unambiguous.
 */
export function planFingerprint(pre: SchemaSnapshot, target: SchemaSnapshot): string {
  const hash = createHash("sha256");
  for (const part of [JSON.stringify(pre), JSON.stringify(target)]) {
    hash.update(`${Buffer.byteLength(part)}:${part},`);
  }
  return hash.digest("hex");
}

// -- safe-change descriptions (pure projection of the diff) -------------------

type RefusalSites = {
  tables: Set<string>;
  columns: Set<string>;
  variants: Set<string>;
  indexes: Set<string>;
};

const SEP = "\u0000";

function refusalSites(refusals: SchemaRefusal[]): RefusalSites {
  const sites: RefusalSites = { tables: new Set(), columns: new Set(), variants: new Set(), indexes: new Set() };
  for (const r of refusals) {
    if (r.variant !== undefined) sites.variants.add([r.table, r.column, r.variant].join(SEP));
    else if (r.column !== undefined) sites.columns.add([r.table, r.column].join(SEP));
    else if (r.index !== undefined) sites.indexes.add([r.table, r.index].join(SEP));
    else sites.tables.add(r.table);
  }
  return sites;
}

/**
 * One human line per diff atom that is NOT refused — the "applies
 * automatically" half of the change ledger. The classifier stays the sole owner
 * of the verdict: an atom is skipped exactly when the refusal list names its
 * site, never by re-deriving the shape rules here. A unique index that survives
 * classification and its optimistic preview therefore renders as applying.
 */
export function describeSafeChanges(diff: SchemaDiff, refusals: SchemaRefusal[]): string[] {
  const sites = refusalSites(refusals);
  const lines: string[] = [];
  for (const change of diff) describeTable(change, sites, lines);
  return lines;
}

function describeTable(change: TableChange, sites: RefusalSites, lines: string[]): void {
  const table = change.table;
  switch (change.op) {
    case "table-added":
      lines.push(`new ${change.kind === "event" ? "event table" : "table"} "${table}"`);
      return;
    case "table-dropped":
      if (!sites.tables.has(table)) {
        lines.push(`${change.kind === "event" ? "event table" : "table"} "${table}" dropped`);
      }
      return;
    case "table-kind-changed":
      if (!sites.tables.has(table)) lines.push(`"${table}" became a ${change.to === "event" ? "event table" : "table"}`);
      return;
    case "event-updated":
      lines.push(`event table "${table}" updated`);
      return;
    case "table-altered": {
      for (const col of change.columns) describeColumn(table, col, sites, lines);
      for (const ix of change.indexes) {
        if (sites.indexes.has([table, ix.name].join(SEP))) continue;
        if (ix.op === "dropped") lines.push(`index "${table}.${ix.name}" dropped`);
        else if (ix.unique) lines.push(`unique index "${table}.${ix.name}" ${ix.op} (no duplicates found)`);
        else lines.push(`index "${table}.${ix.name}" ${ix.op}`);
      }
      return;
    }
  }
}

function describeColumn(
  table: string,
  col: Extract<TableChange, { op: "table-altered" }>["columns"][number],
  sites: RefusalSites,
  lines: string[],
): void {
  const site = `"${table}.${col.column}"`;
  if (col.op === "variants-changed") {
    for (const v of col.variants) {
      if (sites.variants.has([table, col.column, v.variant].join(SEP))) continue;
      lines.push(`${col.typeName}: variant "${v.variant}" ${v.op === "payload-changed" ? "payload changed" : v.op}`);
    }
    return;
  }
  if (sites.columns.has([table, col.column].join(SEP))) return;
  switch (col.op) {
    case "added":
      lines.push(`column ${site} added${col.nullable ? " (nullable)" : ""}`);
      return;
    case "dropped":
      lines.push(`column ${site} dropped`);
      return;
    case "type-changed":
      lines.push(`column ${site} type changed`);
      return;
    case "constraints-changed":
      lines.push(
        col.direction === "loosen"
          ? `column ${site} constraints loosened`
          : `column ${site} constraints tightened (no violations found)`,
      );
      return;
    case "nullability-changed":
      lines.push(col.to === "nullable" ? `column ${site} widened to nullable` : `column ${site} made required`);
      return;
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
  const columns = Object.create(null) as Record<string, CandidateGroup>;
  const variants = new Map<string, { dropped: Set<string>; added: Set<string> }>();
  const variantGroup = (type: string) => {
    let group = variants.get(type);
    if (group === undefined) {
      group = { dropped: new Set(), added: new Set() };
      variants.set(type, group);
    }
    return group;
  };

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

  const variantOut = Object.create(null) as Record<string, CandidateGroup>;
  for (const [type, g] of variants) {
    if (g.dropped.size > 0 || g.added.size > 0) {
      variantOut[type] = { dropped: sorted(g.dropped), added: sorted(g.added) };
    }
  }
  return { tables: { dropped: tables.dropped.sort(), added: tables.added.sort() }, columns, variants: variantOut };
}

// -- the plan outcome ---------------------------------------------------------

export type PlanOutcome =
  | { status: "no-database" }
  | { status: "diverged"; message: string }
  | {
      status: "pending";
      pendingCount: number;
      nextNumber: number;
      /** The live schema moved after the pending chain was written — its end-state no longer matches. */
      stale: boolean;
      /** Every artifact of every pending migration — what the re-derive offer deletes. */
      pendingFiles: string[];
      /** `NNNN_name` per pending step — what the apply question names. */
      pendingLabels: string[];
      /** The pending steps' identities, joined — what an apply decline is remembered against. */
      pendingIdentity: string;
    }
  | { status: "clean" }
  | {
      status: "changes";
      refusals: SchemaRefusal[];
      candidates: RenameCandidates;
      nextNumber: number;
      /** The "applies automatically" half of the ledger, one line per safe change. */
      safe: string[];
      /** What consent to THIS ledger carries into generation (see `planFingerprint`). */
      fingerprint: string;
    };

/**
 * Diff the stored snapshot against the live schema and classify the result.
 * The applied history must be a (number, identity) prefix of the on-disk chain
 * (the server's exact rule, run here through `validateHistoryPrefix`): a
 * divergence — an edited applied migration, or a history longer than the chain —
 * is its own outcome, never a scaffold. Pending migrations then short-circuit:
 * a new migration always sits on a fully-applied chain, so `pre` (the stored
 * snapshot) is only the right pre-state once the chain is fully applied. A
 * pending outcome still peeks at the live schema to flag staleness — a chain
 * whose end-state is no longer the schema means the developer kept editing
 * after the scaffold, and deleting + re-deriving may serve better than filling.
 */
export async function computePlan(config: AppConfig): Promise<PlanOutcome> {
  const state = readStoredState(config);
  if (state === null) return { status: "no-database" };
  const chain = await loadMigrationChain(config);
  const nextNumber = (chain.at(-1)?.number ?? 0) + 1;
  let pending: MigrationStep[];
  try {
    ({ pending } = validateHistoryPrefix(state.applied, chain));
  } catch (error) {
    if (error instanceof MigrationError) return { status: "diverged", message: error.message };
    throw error;
  }
  if (pending.length > 0) {
    let stale = false;
    try {
      stale = diffSnapshots(chain.at(-1)!.target, snapshotOf(await importSchema(config))).length > 0;
    } catch {
      // The schema does not even import — nothing to judge staleness against.
    }
    return {
      status: "pending",
      pendingCount: pending.length,
      nextNumber,
      stale,
      pendingFiles: pending.flatMap((step) => migrationArtifactPaths(config, step)),
      pendingLabels: pending.map((step) => stepLabel(step)),
      // Identity covers pre, target, and file bytes: any edit to a pending
      // migration (filling a TODO) shifts it, so a remembered decline releases.
      pendingIdentity: pending.map((step) => migrationIdentity(step)).join("\n"),
    };
  }
  const schema = await importSchema(config);
  const target = snapshotOf(schema);
  const diff = diffSnapshots(state.snapshot, target);
  const { refusals } = classifySchemaDiff(diff);
  const allRefusals = [...refusals, ...probeOptimisticRefusals(config, state.snapshot, target)];
  if (allRefusals.length === 0) return { status: "clean" };
  return {
    status: "changes",
    refusals: allRefusals,
    candidates: renameCandidates(diff),
    nextNumber,
    safe: describeSafeChanges(diff, allRefusals),
    fingerprint: planFingerprint(state.snapshot, target),
  };
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
      safe: string[];
      fingerprint: string;
      stale: boolean;
      pendingFiles: string[];
      pendingLabels: string[];
      pendingIdentity: string;
    };

const EMPTY_CANDIDATES: RenameCandidates = { tables: { dropped: [], added: [] }, columns: {}, variants: {} };

/** Project an outcome onto the single JSON line `__plan` prints for a fresh child. */
export function planToWire(outcome: PlanOutcome, config: AppConfig): PlanWire {
  switch (outcome.status) {
    case "no-database":
      return { error: `no database at ${join(config.dbDir, "data.db")}; \`dbz dev\` initializes a fresh one` };
    case "diverged":
      return { error: outcome.message };
    case "clean":
      return { clean: true };
    case "pending":
      return {
        clean: false,
        refusals: [],
        candidates: EMPTY_CANDIDATES,
        nextNumber: outcome.nextNumber,
        pendingCount: outcome.pendingCount,
        safe: [],
        fingerprint: "",
        stale: outcome.stale,
        pendingFiles: outcome.pendingFiles,
        pendingLabels: outcome.pendingLabels,
        pendingIdentity: outcome.pendingIdentity,
      };
    case "changes":
      return {
        clean: false,
        refusals: outcome.refusals,
        candidates: outcome.candidates,
        nextNumber: outcome.nextNumber,
        pendingCount: 0,
        safe: outcome.safe,
        fingerprint: outcome.fingerprint,
        stale: false,
        pendingFiles: [],
        pendingLabels: [],
        pendingIdentity: "",
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
  "constraint-violations": "validate",
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
