/**
 * Reads a paired run and decides. Every metric gets the same treatment: the
 * median of its paired ratios, a distribution-free interval around that median
 * built from the repetitions themselves, and a verdict of regression,
 * improvement, or no signal.
 *
 * "No signal" is a real answer here, not a failure to produce one. A gate that
 * always emits a number teaches everyone to re-run until the number is
 * agreeable; one that can say the run could not tell them apart is worth more
 * than one that guesses.
 *
 * Exits non-zero when a gated metric regressed, or when a side recorded a
 * correctness or accounting failure.
 */
import { median } from "./load-engine.ts";
import { metricPolicy } from "./units.ts";
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

const [directoryArgument] = process.argv.slice(2);
if (!directoryArgument) throw new Error("usage: bun bench/report.ts <benchmark-results-directory>");
const directory = directoryArgument;
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

const firstBase = await readSide(run.profiles[0]?.profile ?? "disabled", "base");
const firstHead = await readSide(run.profiles[0]?.profile ?? "disabled", "head");
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

let gatedRegressions = 0;
let correctnessFailures = 0;
const everyComparison: PairedComparison[] = [];

for (const profile of run.profiles) {
  say();
  say(`## Telemetry: ${profile.profile}`);
  say();
  if (profile.terminalFailures.length > 0) {
    correctnessFailures += profile.terminalFailures.length;
    for (const failure of profile.terminalFailures) say(`- **terminal failure** ${failure}`);
    say();
  }
  say("| Work | Metric | Base | Head | Change | Interval | Verdict |");
  say("| --- | --- | ---: | ---: | ---: | :---: | --- |");
  for (const series of profile.series) {
    const policy = metricPolicy(series.metric);
    const comparison = comparePaired(series.samples, { ...DEFAULT_POLICY, better: policy.better });
    everyComparison.push(comparison);
    const gated = policy.gated && comparison.signal === "regression";
    if (gated) gatedRegressions++;
    const interval = Number.isFinite(comparison.lowPercent)
      ? `${signed(comparison.lowPercent)} … ${signed(comparison.highPercent)}`
      : "—";
    const verdict = comparison.signal === "regression" && !policy.gated
      ? "regression (ungated)"
      : MARK[comparison.signal];
    say(
      `| ${series.unitId} | ${series.metric} | ${fixed(median(series.samples.map((s) => s.base)))} | ` +
        `${fixed(median(series.samples.map((s) => s.head)))} | ${signed(comparison.medianPercent)} | ` +
        `${interval} | ${gated ? `**${verdict}**` : verdict} |`,
    );
  }

  for (const side of ["base", "head"] as const) {
    const sample = await readSide(profile.profile, side);
    if (sample === undefined) continue;
    const failures = sample.observations.failures.length;
    const anomalies = sample.observations.integrityAnomalies.length;
    correctnessFailures += failures + anomalies;
    say();
    say(
      `${side} idle: ${fixed(sample.startupIdle.snapshot.rssMb, 1)} MB RSS, ` +
        `${fixed(sample.startupIdle.window.cpuCores)} CPU cores — context, never gated.`,
    );
    for (const failure of sample.observations.failures) {
      say(`- **${side} correctness** ${failure.case}: ${failure.errors.join("; ")}`);
    }
    for (const anomaly of sample.observations.integrityAnomalies) {
      say(`- **${side} integrity** ${anomaly.message}`);
    }
    for (const observation of sample.harnessObservations) say(`- ${side} harness: ${observation}`);
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
} else if (correctnessFailures > 0) {
  say(`**${correctnessFailures} correctness or accounting failure(s) recorded.**`);
} else {
  say("No gated metric regressed and no correctness failure was recorded.");
}
say();
say(
  "A green check means this comparison found no regression large enough and consistent enough to stop the merge. " +
    "It is not an approval of the whole performance vector: read the table.",
);

console.log(lines.join("\n"));
if (gatedRegressions > 0 || correctnessFailures > 0) process.exitCode = 1;
