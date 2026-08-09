/**
 * What this gate has already measured, kept so the next question about its own
 * noise is a query rather than a campaign.
 *
 * `report.ts` computes a median paired ratio, an interval, and a verdict for
 * every metric on every run, prints them into a step summary, uploads them as an
 * artifact that expires in thirty days, and then never reads any of it again.
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
 * threshold, floor, or gated-metric set consults it. A row is only ever as
 * trustworthy as the commit that produced it, which is why every row carries
 * that commit's SHA and why the appender refuses a file whose rows disagree with
 * the head the workflow was triggered for.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MetricSignal, PairedComparison } from "./paired-statistics.ts";

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
  /** The workflow run that produced it. Stamped by the appender, not by the run. */
  readonly run: string;
  /** When the appender recorded it, and the ledger's partition key. */
  readonly recordedAt: string;
  readonly host: string;
  readonly base: string;
  readonly head: string;
  readonly repetitions: number;
  readonly profile: string;
  readonly unit: string;
  readonly metric: string;
  /** Whether a regression in this metric failed that run's check, as of that run. */
  readonly gated: boolean;
  /** Repetitions that produced a usable pair; below `repetitions` when either side had none. */
  readonly pairs: number;
  readonly medianPercent: number | null;
  readonly lowPercent: number | null;
  readonly highPercent: number | null;
  readonly signal: MetricSignal;
}

export interface LedgerRunFacts {
  readonly run: string;
  readonly recordedAt: string;
  readonly host: string;
  readonly base: string;
  readonly head: string;
  readonly repetitions: number;
}

const SIGNALS: readonly string[] = ["regression", "improvement", "no signal", "not measured"];
const COMMIT = /^[0-9a-f]{7,40}$/;
const LONGEST_FIELD = 200;

/** A percentage that survives JSON, or `null` where the run could not resolve one. */
function ratio(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

export function ledgerRow(
  facts: LedgerRunFacts,
  entry: {
    readonly profile: string;
    readonly unit: string;
    readonly metric: string;
    readonly gated: boolean;
    readonly comparison: PairedComparison;
  },
): LedgerRow {
  return {
    schema: LEDGER_SCHEMA_VERSION,
    ...facts,
    profile: entry.profile,
    unit: entry.unit,
    metric: entry.metric,
    gated: entry.gated,
    pairs: entry.comparison.pairs,
    medianPercent: ratio(entry.comparison.medianPercent),
    lowPercent: ratio(entry.comparison.lowPercent),
    highPercent: ratio(entry.comparison.highPercent),
    signal: entry.comparison.signal,
  };
}

export function formatLedger(rows: readonly LedgerRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

/**
 * Reads rows written by a commit the ledger does not control. Every field is
 * checked rather than trusted: the appender runs from the default branch with
 * write access to the data branch, and the file it reads was produced by a pull
 * request's own harness.
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
    return [validRow(parsed, index + 1)];
  });
}

function validRow(value: unknown, line: number): LedgerRow {
  const fail = (why: string): never => {
    throw new Error(`ledger line ${line} ${why}`);
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
  for (const field of ["repetitions", "pairs"] as const) {
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
 * Puts a run's rows under the workflow run and clock that the appender trusts,
 * having first checked that the file describes the commit the appender was
 * triggered for. A pull request cannot forge which run or which head its numbers
 * are filed under, and cannot file more rows than the workload can produce.
 */
export function stampLedger(
  rows: readonly LedgerRow[],
  provenance: { readonly run: string; readonly head: string; readonly recordedAt: string },
): LedgerRow[] {
  if (rows.length > MAXIMUM_ROWS_PER_RUN) {
    throw new Error(`a single run may not file ${rows.length} rows, the cap is ${MAXIMUM_ROWS_PER_RUN}`);
  }
  for (const row of rows) {
    if (row.head !== provenance.head) {
      throw new Error(
        `a row claims head ${row.head} where this run measured ${provenance.head}`,
      );
    }
  }
  return rows.map((row) => ({ ...row, run: provenance.run, recordedAt: provenance.recordedAt }));
}

/**
 * Folds one run into the ledger. Rows are keyed by their run, so a re-run
 * replaces its earlier attempt instead of counting twice — and two runs
 * appending in either order produce the same ledger, which is what lets a
 * rejected push be resolved by fetching and folding again rather than by
 * merging text.
 */
export function mergeLedger(existing: readonly LedgerRow[], incoming: readonly LedgerRow[]): LedgerRow[] {
  const replaced = new Set(incoming.map((row) => row.run));
  return [...existing.filter((row) => !replaced.has(row.run)), ...incoming].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt) ||
    left.run.localeCompare(right.run) ||
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
    partitions.set(partition, [...(partitions.get(partition) ?? []), row]);
  }
  for (const path of partitionFiles(directory)) {
    if (!partitions.has(path.slice(directory.length + 1, -".ndjson".length))) rmSync(path);
  }
  for (const [partition, partitioned] of partitions) {
    await Bun.write(join(directory, `${partition}.ndjson`), formatLedger(partitioned));
  }
  return partitions.size;
}

if (import.meta.main) {
  const [incoming, directory, run, head] = process.argv.slice(2);
  if (!incoming || !directory || !run || !head) {
    throw new Error("usage: bun bench/ledger.ts <incoming.ndjson> <ledger-directory> <run-id> <head-sha>");
  }
  mkdirSync(directory, { recursive: true });
  const rows = mergeLedger(
    await readLedger(directory),
    stampLedger(parseLedger(await Bun.file(incoming).text()), {
      run,
      head,
      recordedAt: new Date().toISOString(),
    }),
  );
  const partitions = await writeLedger(directory, rows);
  process.stderr.write(
    `ledger: ${rows.length} row(s) across ${partitions} partition(s) after folding in run ${run}\n`,
  );
}
