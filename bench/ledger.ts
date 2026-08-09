/**
 * What this gate has already measured, kept so the next question about its own
 * noise is a query rather than a campaign.
 *
 * The gate computes a median paired ratio, an interval, and a verdict for every
 * metric on every run, prints them into a step summary, uploads them as an
 * artifact that expires in thirty days — and used to read none of it ever again.
 * Every comparable system does the opposite: rustc-perf fences each benchmark
 * against its own historical distribution of relative changes, Mozilla's
 * Perfherder runs a t-test over the preceding revisions, and Bencher stores each
 * metric and derives an IQR, z-score, or t-test from what it stored. Their
 * history *is* a null distribution, collected for free, because most pull
 * requests do not move most benchmarks — where a bespoke null campaign has to be
 * paid for every time somebody asks whether a metric is trustworthy.
 *
 * **Only the paired ratio is stored, never an absolute number.** Absolute
 * throughput on an ephemeral runner is not comparable from one run to the next,
 * which is why rustc-perf and Perfherder both need dedicated stable hardware
 * before their history means anything. A paired interleaved ratio is
 * machine-independent by construction — both sides met the same machine in the
 * same second — so a history that spans runners is available here where an
 * absolute one would not be.
 *
 * Nothing reads this yet, and that is deliberate. It is a record, not a rule: no
 * threshold, floor, or gated-metric set consults it.
 *
 * **The rows are computed here, from the run's raw paired samples, and never
 * taken from the pull request as summaries.** This module runs from the default
 * branch inside a privileged workflow, so the statistic, the interval, the
 * verdict, and whether the metric gates are all this branch's answers rather
 * than head's claims about them. What remains head's is the samples themselves:
 * a commit that lies to the gate lies to the ledger in the same breath, which is
 * unclosable from inside a workflow the pull request supplies, and is why every
 * row carries the commit that produced it.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { metricPolicy, type MetricPolicy } from "./units.ts";
import {
  comparePaired,
  DEFAULT_POLICY,
  PAIRED_SCHEMA_VERSION,
  type MetricSignal,
  type PairedRunRecord,
} from "./paired-statistics.ts";

export const LEDGER_SCHEMA_VERSION = 1;

/**
 * A run contributes at most one row per metric per profile. The default
 * workload produces 91 of them per profile and runs at most three profiles; the
 * cap is an order of magnitude above that, so a pull request cannot grow the
 * ledger branch by writing a file nobody asked for.
 */
export const MAXIMUM_ROWS_PER_RUN = 2_000;

/** One metric's verdict on one run, as a ratio. No absolute value belongs here. */
export interface LedgerRow {
  readonly schema: number;
  /** The workflow run that produced it, and which of its attempts. */
  readonly run: string;
  readonly attempt: number;
  /** When the appender recorded it, and the ledger's partition key. */
  readonly recordedAt: string;
  readonly host: string;
  /** The commit the run says it measured against. Head's claim; only head is authenticated. */
  readonly base: string;
  readonly head: string;
  readonly repetitions: number;
  readonly profile: string;
  readonly unit: string;
  readonly metric: string;
  /** Whether a regression in this metric fails the check, by this branch's policy. */
  readonly gated: boolean;
  /** Repetitions that produced a usable pair; below `repetitions` when either side had none. */
  readonly pairs: number;
  readonly medianPercent: number | null;
  readonly lowPercent: number | null;
  readonly highPercent: number | null;
  readonly signal: MetricSignal;
}

/** What the appender knows on its own authority rather than from the artifact. */
export interface LedgerProvenance {
  readonly run: string;
  readonly attempt: number;
  readonly head: string;
  readonly recordedAt: string;
}

const SIGNALS: readonly string[] = ["regression", "improvement", "no signal", "not measured"];
const COMMIT = /^[0-9a-f]{7,40}$/;
const LONGEST_FIELD = 200;

/** A percentage that survives JSON, or `null` where the run could not resolve one. */
function ratio(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

/**
 * Turns a run's raw paired samples into ledger rows, recomputing every verdict
 * with this branch's statistic and this branch's metric policy. Head supplies
 * numbers; it does not supply conclusions about them.
 *
 * A metric this branch has no policy for is skipped and counted rather than
 * recorded, because a row whose `gated` flag came from somewhere else is worth
 * less than no row: head may legitimately add a metric before the policy table
 * that judges it reaches the default branch.
 */
export function ledgerRows(
  record: PairedRunRecord,
  provenance: LedgerProvenance,
): { readonly rows: LedgerRow[]; readonly unknownMetrics: string[] } {
  if (record.schemaVersion !== PAIRED_SCHEMA_VERSION) {
    throw new Error(`unsupported paired benchmark schema ${JSON.stringify(record.schemaVersion)}`);
  }
  if (record.head !== provenance.head) {
    throw new Error(`the run describes head ${record.head} where this workflow measured ${provenance.head}`);
  }
  const rows: LedgerRow[] = [];
  const unknownMetrics = new Set<string>();
  const seen = new Set<string>();
  for (const profile of record.profiles) {
    for (const series of profile.series) {
      const key = `${profile.profile} ${series.unitId} ${series.metric}`;
      if (seen.has(key)) throw new Error(`the run reports ${key} more than once`);
      seen.add(key);
      let policy: MetricPolicy;
      try {
        policy = metricPolicy(series.metric);
      } catch {
        unknownMetrics.add(series.metric);
        continue;
      }
      const comparison = comparePaired(series.samples, { ...DEFAULT_POLICY, better: policy.better });
      rows.push({
        schema: LEDGER_SCHEMA_VERSION,
        run: provenance.run,
        attempt: provenance.attempt,
        recordedAt: provenance.recordedAt,
        host: record.executionHost,
        base: record.base,
        head: record.head,
        repetitions: record.repetitions,
        profile: profile.profile,
        unit: series.unitId,
        metric: series.metric,
        gated: policy.gated,
        pairs: comparison.pairs,
        medianPercent: ratio(comparison.medianPercent),
        lowPercent: ratio(comparison.lowPercent),
        highPercent: ratio(comparison.highPercent),
        signal: comparison.signal,
      });
    }
  }
  if (rows.length > MAXIMUM_ROWS_PER_RUN) {
    throw new Error(`a single run may not file ${rows.length} rows, the cap is ${MAXIMUM_ROWS_PER_RUN}`);
  }
  // The verdicts are this branch's, but the host, the base, and the unit and
  // metric names still came out of the artifact, so they meet the same reader
  // the stored ledger meets.
  for (const row of rows) validRow(row, `${row.profile} ${row.unit} ${row.metric}`);
  return { rows, unknownMetrics: [...unknownMetrics].sort() };
}

export function formatLedger(rows: readonly LedgerRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

/**
 * Reads the stored ledger back. Every field is checked rather than trusted: the
 * branch is written by an automated job and read by whatever eventually asks it
 * a question, and a row that is subtly wrong is worse than a row that is absent.
 */
export function parseLedger(text: string): LedgerRow[] {
  return text.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`ledger line ${index + 1} is not JSON: ${(error as Error).message}`);
    }
    return [validRow(parsed, `line ${index + 1}`)];
  });
}

function validRow(value: unknown, where: string): LedgerRow {
  const fail = (why: string): never => {
    throw new Error(`ledger ${where} ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("is not an object");
  const row = value as Record<string, unknown>;
  if (row.schema !== LEDGER_SCHEMA_VERSION) return fail(`declares schema ${JSON.stringify(row.schema)}`);
  for (const field of ["run", "recordedAt", "host", "base", "head", "profile", "unit", "metric"] as const) {
    const text = row[field];
    if (typeof text !== "string" || text.length === 0 || text.length > LONGEST_FIELD) {
      return fail(`has an unusable ${field}`);
    }
  }
  for (const field of ["base", "head"] as const) {
    if (!COMMIT.test(row[field] as string)) return fail(`has a ${field} that is not a commit`);
  }
  if (Number.isNaN(Date.parse(row.recordedAt as string))) return fail("has an unreadable recordedAt");
  for (const field of ["repetitions", "pairs", "attempt"] as const) {
    const count = row[field];
    if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 1_000) {
      return fail(`has an unusable ${field}`);
    }
  }
  if (typeof row.gated !== "boolean") return fail("has no gating disposition");
  if (!SIGNALS.includes(row.signal as string)) return fail(`has an unknown signal ${JSON.stringify(row.signal)}`);
  for (const field of ["medianPercent", "lowPercent", "highPercent"] as const) {
    const percent = row[field];
    if (percent === null) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent) || Math.abs(percent) > 1e6) {
      return fail(`has an unusable ${field}`);
    }
  }
  return row as unknown as LedgerRow;
}

/**
 * Folds one run into the ledger. Rows are keyed by their run, so a re-run
 * replaces its earlier attempt instead of counting twice, and two *different*
 * runs appending in either order produce the same ledger — which is what lets a
 * rejected push be resolved by fetching and folding again rather than by merging
 * text.
 *
 * Two attempts of the *same* run are not interchangeable, and GitHub keeps the
 * run id across a re-run. Later attempts win by attempt number rather than by
 * arrival, so an earlier attempt's appender that finishes late cannot put stale
 * measurements back.
 */
export function mergeLedger(existing: readonly LedgerRow[], incoming: readonly LedgerRow[]): LedgerRow[] {
  const attempts = new Map<string, number>();
  for (const row of incoming) attempts.set(row.run, Math.max(attempts.get(row.run) ?? 0, row.attempt));
  const superseded = (row: LedgerRow): boolean => (attempts.get(row.run) ?? -1) >= row.attempt;
  const stale = new Set(
    existing.flatMap((row) => (attempts.has(row.run) && !superseded(row) ? [row.run] : [])),
  );
  return [
    ...existing.filter((row) => !superseded(row)),
    ...incoming.filter((row) => !stale.has(row.run)),
  ].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt) ||
    left.run.localeCompare(right.run) ||
    left.attempt - right.attempt ||
    left.profile.localeCompare(right.profile) ||
    left.unit.localeCompare(right.unit) ||
    left.metric.localeCompare(right.metric)
  );
}

/**
 * The file a row belongs in. Partitioning by month keeps each append a small
 * blob: git stores a whole file per commit, so one ever-growing ledger would
 * make the data branch cost the square of its own length.
 */
export function ledgerPartition(recordedAt: string): string {
  return recordedAt.slice(0, 7);
}

/** Every row the ledger directory holds, oldest partition first. */
export async function readLedger(directory: string): Promise<LedgerRow[]> {
  const texts = await Promise.all(partitionFiles(directory).map((path) => Bun.file(path).text()));
  return texts.flatMap((text) => parseLedger(text));
}

function partitionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => (entry.isFile() && entry.name.endsWith(".ndjson") ? [entry.name] : []))
    .sort()
    .map((name) => join(directory, name));
}

/** Rewrites the directory so it holds exactly these rows, one file per month. */
export async function writeLedger(directory: string, rows: readonly LedgerRow[]): Promise<number> {
  const partitions = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const partition = ledgerPartition(row.recordedAt);
    const held = partitions.get(partition);
    if (held === undefined) partitions.set(partition, [row]);
    else held.push(row);
  }
  for (const path of partitionFiles(directory)) {
    if (!partitions.has(basename(path, ".ndjson"))) rmSync(path);
  }
  for (const [partition, partitioned] of partitions) {
    await Bun.write(join(directory, `${partition}.ndjson`), formatLedger(partitioned));
  }
  return partitions.size;
}

if (import.meta.main) {
  const [pairPath, directory, run, attempt, head] = process.argv.slice(2);
  if (!pairPath || !directory || !run || !attempt || !head) {
    throw new Error(
      "usage: bun bench/ledger.ts <pair.json> <ledger-directory> <run-id> <run-attempt> <head-sha>",
    );
  }
  if (!/^\d+$/.test(attempt)) throw new Error("the run attempt must be a whole number");
  mkdirSync(directory, { recursive: true });
  const measured = ledgerRows(JSON.parse(await Bun.file(pairPath).text()) as PairedRunRecord, {
    run,
    attempt: Number(attempt),
    head,
    recordedAt: new Date().toISOString(),
  });
  const rows = mergeLedger(await readLedger(directory), measured.rows);
  const partitions = await writeLedger(directory, rows);
  process.stderr.write(
    `ledger: ${measured.rows.length} row(s) from run ${run} attempt ${attempt}; ` +
      `${rows.length} row(s) across ${partitions} partition(s)` +
      (measured.unknownMetrics.length > 0
        ? `; skipped ${measured.unknownMetrics.length} metric(s) this branch has no policy for: ` +
          `${measured.unknownMetrics.join(", ")}`
        : "") +
      "\n",
  );
}
