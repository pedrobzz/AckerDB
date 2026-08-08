/**
 * Reads a paired run and decides. Every metric gets the same treatment: the
 * median of its paired ratios, a distribution-free interval around that median
 * built from the repetitions themselves, and a verdict of regression,
 * improvement, or no signal.
 *
 * "No signal" is a real answer here, not a failure to produce one. A gate that
 * always emits a number teaches everyone to re-run until the number is
 * agreeable; one that can say the run could not tell the two commits apart is
 * worth more than one that guesses.
 *
 * Silence is not the same as agreement, though, so the contract is checked
 * before the verdicts are read: every unit, every metric that unit owes, and
 * every repetition of it must be present on both sides. A head that stops
 * producing a number fails here rather than quietly shrinking the comparison
 * until nothing is left to regress.
 *
 * Exits non-zero when a gated metric regressed, when the contract is short, or
 * when either side recorded a correctness, accounting, or harness failure.
 */
import { median } from "./load-engine.ts";
import { contractShortfalls, metricPolicy, METRIC_POLICY } from "./units.ts";
import type { BenchmarkConfig } from "./benchmark.ts";
import {
  comparePaired,
  scatterSummary,
  DEFAULT_POLICY,
  type PairedComparison,
} from "./paired-statistics.ts";
import type { BenchmarkObservations } from "./result-observations.ts";

interface PairedSeries {
  readonly unitId: string;
  readonly metric: string;
  readonly samples: readonly { readonly repetition: number; readonly base: number; readonly head: number }[];
}

interface PairedRun {
  readonly schemaVersion: number;
  readonly base: string;
  readonly head: string;
  readonly executionHost: string;
  readonly repetitions: number;
  readonly wallSeconds: number;
  readonly config: BenchmarkConfig;
  readonly units: readonly string[];
  readonly profiles: readonly {
    readonly profile: string;
    readonly series: readonly PairedSeries[];
    readonly terminalFailures: readonly string[];
  }[];
}

interface SideSample {
  readonly source: { readonly side: string; readonly commit: string; readonly version: string };
  readonly machine: { readonly cpu: string; readonly logicalCpus: number; readonly memGb: number };
  readonly startupIdle: { readonly snapshot: { readonly rssMb: number }; readonly window: { readonly cpuCores: number } };
  readonly observations: BenchmarkObservations;
  readonly harnessObservations: readonly string[];
}

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("usage: bun bench/report.ts <benchmark-results-directory>");
const run = JSON.parse(await Bun.file(`${directory}/pair.json`).text()) as PairedRun;
if (run.schemaVersion !== 2) throw new Error("unsupported AckerDB paired benchmark schema");

async function readSide(profile: string, side: "base" | "head"): Promise<SideSample | undefined> {
  const file = Bun.file(`${directory}/${side}-${profile}.json`);
  return (await file.exists()) ? (JSON.parse(await file.text()) as SideSample) : undefined;
}

function fixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(digits);
}

function signed(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

const MARK: Readonly<Record<PairedComparison["signal"], string>> = Object.freeze({
  regression: "REGRESSION",
  improvement: "improvement",
  "no signal": "no signal",
  "not measured": "not measured",
});

const lines: string[] = [];
const say = (line = "") => lines.push(line);

const firstProfile = run.profiles[0]?.profile ?? "disabled";
const firstBase = await readSide(firstProfile, "base");
const firstHead = await readSide(firstProfile, "head");
say(`# AckerDB paired benchmark: v${firstBase?.source.version ?? "?"} → v${firstHead?.source.version ?? "?"}`);
say();
say(`Base: \`${run.base}\`  `);
say(`Head: \`${run.head}\``);
say();
say(
  `${run.repetitions} interleaved repetitions of ${run.units.length} units on ${run.executionHost}` +
    `${firstBase ? ` (${firstBase.machine.logicalCpus} vCPU, ${firstBase.machine.memGb} GiB)` : ""}, ` +
    `${run.wallSeconds}s wall.`,
);
say();
say(
  "Base and head alternate within every unit and swap which of them leads on each repetition, so drift over the " +
    "run lands on both sides rather than on whichever ran second. Each row is the median of that metric's paired " +
    "ratios with a distribution-free interval around it; the interval is measured from this run's own scatter.",
);

// The rule this run was judged by, printed where the verdict is read. Weakening
// the gate remains possible — a pull request supplies the harness that judges it
// — but it cannot be done quietly.
const ungated = Object.entries(METRIC_POLICY).filter(([, policy]) => !policy.gated).map(([name]) => name);
say();
say(
  `Rule: a gated metric regresses when its ${(100 * (1 - DEFAULT_POLICY.alpha)).toFixed(0)}%+ interval keeps the ` +
    `whole median on the worse side of zero **and** the median clears ${DEFAULT_POLICY.floorPercent}%. ` +
    `Reported but never gated: ${ungated.join(", ")}.`,
);

let gatedRegressions = 0;
let failures = 0;
const everyComparison: PairedComparison[] = [];

for (const profile of run.profiles) {
  say();
  say(`## Telemetry: ${profile.profile}`);
  say();
  for (const failure of profile.terminalFailures) {
    failures++;
    say(`- **terminal failure** ${failure}`);
  }
  for (const shortfall of contractShortfalls(run.config, run.repetitions, profile.series)) {
    failures++;
    say(`- **incomplete measurement** ${shortfall}`);
  }
  if (failures > 0) say();
  say("| Work | Metric | Base | Head | Change | Interval | Verdict |");
  say("| --- | --- | ---: | ---: | ---: | :---: | --- |");
  for (const series of profile.series) {
    const policy = metricPolicy(series.metric);
    const comparison = comparePaired(series.samples, { ...DEFAULT_POLICY, better: policy.better });
    everyComparison.push(comparison);
    // A gated metric the run could not resolve is a missing answer, not a
    // passing one: too few usable pairs means the machine, not the change,
    // decided what this comparison saw.
    const unresolved = policy.gated && comparison.signal === "not measured";
    const gated = policy.gated && comparison.signal === "regression";
    if (gated) gatedRegressions++;
    if (unresolved) failures++;
    const interval = Number.isFinite(comparison.lowPercent)
      ? `${signed(comparison.lowPercent)} … ${signed(comparison.highPercent)}`
      : "—";
    const verdict = comparison.signal === "regression" && !policy.gated
      ? "regression (ungated)"
      : MARK[comparison.signal];
    say(
      `| ${series.unitId} | ${series.metric} | ${fixed(median(series.samples.map((s) => s.base)))} | ` +
        `${fixed(median(series.samples.map((s) => s.head)))} | ${signed(comparison.medianPercent)} | ` +
        `${interval} | ${gated || unresolved ? `**${verdict}**` : verdict} |`,
    );
  }

  for (const side of ["base", "head"] as const) {
    const sample = await readSide(profile.profile, side);
    if (sample === undefined) {
      failures++;
      say();
      say(`- **missing sample** the ${side} side wrote no record for the ${profile.profile} profile`);
      continue;
    }
    say();
    say(
      `${side} idle: ${fixed(sample.startupIdle.snapshot.rssMb, 1)} MB RSS, ` +
        `${fixed(sample.startupIdle.window.cpuCores)} CPU cores — context, never gated.`,
    );
    for (const failure of sample.observations.failures) {
      failures++;
      say(`- **${side} correctness** ${failure.case}: ${failure.errors.join("; ")}`);
    }
    for (const anomaly of sample.observations.integrityAnomalies) {
      failures++;
      say(`- **${side} integrity** ${anomaly.message}`);
    }
    // A startup mode that did not match, or telemetry accounting that does not
    // cover the work the workload says it did, means the numbers above describe
    // something other than what this run claims to have measured.
    for (const observation of sample.harnessObservations) {
      failures++;
      say(`- **${side} harness** ${observation}`);
    }
  }
}

const scatter = scatterSummary(everyComparison);
say();
say("## How noisy this run was");
say();
say(
  `Across ${scatter.metrics} metrics the median absolute paired delta was ` +
    `${scatter.medianAbsolutePercent.toFixed(1)}%, the p90 ${scatter.p90AbsolutePercent.toFixed(1)}%, and the ` +
    `largest ${scatter.maximumAbsolutePercent.toFixed(1)}%. A run whose spread approaches the ` +
    `${DEFAULT_POLICY.floorPercent}% floor was too noisy to have been believed, whatever it concluded.`,
);
say();
if (gatedRegressions > 0) {
  say(`**${gatedRegressions} gated metric(s) regressed.** The interval excludes zero and the median clears the floor.`);
}
if (failures > 0) {
  say(`**${failures} incomplete, incorrect, or unattributable measurement(s) recorded.**`);
}
if (gatedRegressions === 0 && failures === 0) {
  say("No gated metric regressed, and every unit reported the numbers it owes.");
}
say();
say(
  "A green check means this comparison found no regression large enough and consistent enough to stop the merge. " +
    "It is not an approval of the whole performance vector, and it is not blind to nothing: against this harness's " +
    "own measured noise it catches roughly 60% of twenty-percent regressions and 94% of fifty-percent ones, and " +
    "sees almost nothing below ten. Read the table.",
);

console.log(lines.join("\n"));
if (gatedRegressions > 0 || failures > 0) process.exitCode = 1;
