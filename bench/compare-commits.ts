/**
 * The paired benchmark driver. It holds a live server and load generator for
 * both commits at once and alternates between them one unit of work at a time,
 * so every head number has a base number measured seconds away from it on the
 * same machine in the same thermal and scheduling conditions.
 *
 * The previous driver ran base's entire pass and then head's. Any drift over
 * those minutes — a slow CPU ramp, a noisy neighbour on the runner, a page
 * cache that filled — was charged in full to whichever side ran second, and the
 * only defence was a coin flip over the execution order that decided *which*
 * side got charged rather than whether anyone did. Interleaving removes the
 * cause instead of rotating the victim.
 *
 * Only one side is ever under load. The other's server sits idle, which the
 * harness separately measures as costing near-nothing, and its load generator
 * holds no connections open between units.
 *
 * This is not a local invention. The method is published as **duet
 * benchmarking** — Bulej, Horký, Tůma, Farquet and Prokopec, ICPE '20,
 * <https://dl.acm.org/doi/10.1145/3358960.3379132> — which measured 2.3x to
 * 12.5x better accuracy than sequential runs on ScalaBench and DaCapo and 23.8x
 * to 82.4x on SPEC CPU 2017; Chromium's Pinpoint bisects by running both
 * revisions on the same device for the same reason. This harness arrived at it
 * independently, from the same evidence, which is a reason to keep it and a
 * reason to say where else it lives: a reader deciding whether to trust the
 * comparison should know it is the standard answer rather than a house rule.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { benchmarkConfigFromEnv, type BenchmarkConfig } from "./benchmark.ts";
import { DEFAULT_REPETITIONS } from "./paired-statistics.ts";
import { benchUnits, leadingSide, type BenchUnit, type UnitMetric } from "./units.ts";
import { BoundedTextTail } from "./process-lifecycle.ts";
import type { AckerDBBenchmarkProfile } from "./ackerdb-profile.ts";

const [baseArgument, headArgument, outputDirectoryArgument] = process.argv.slice(2);
if (!baseArgument || !headArgument || !outputDirectoryArgument) {
  throw new Error(
    "usage: bun bench/compare-commits.ts <base-sha> <head-sha> <output-directory>",
  );
}
const baseCommit: string = baseArgument;
const headCommit: string = headArgument;
/**
 * The host is declared, not assumed. A paired interleaved comparison is
 * meaningful wherever it runs — that is the whole point of pairing — so the
 * harness no longer refuses to execute off the runner. What it will not do is
 * produce a record that does not say which machine produced it.
 */
const executionHost = process.env.BENCH_EXECUTION_HOST;
if (!executionHost) {
  throw new Error("BENCH_EXECUTION_HOST must name the machine this comparison ran on");
}

const REPETITIONS = Number(process.env.BENCH_REPETITIONS ?? DEFAULT_REPETITIONS);
if (!Number.isInteger(REPETITIONS) || REPETITIONS < 2 || REPETITIONS % 2 !== 0) {
  // Odd counts hand one side an extra turn in the leading, colder slot.
  throw new Error("BENCH_REPETITIONS must be an even integer of at least 2");
}
const BASE_PORT = Number(process.env.BENCH_BASE_PORT ?? 3311);
const HEAD_PORT = Number(process.env.BENCH_HEAD_PORT ?? 3312);

const repository = resolve(import.meta.dir, "..");
const outputDirectory = resolve(outputDirectoryArgument);
const temporary = mkdtempSync(join(tmpdir(), "ackerdb-benchmark-pair-"));
const baseWorktree = join(temporary, "base");
mkdirSync(outputDirectory, { recursive: true });

function command(argv: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([...argv], { cwd, stdout: "inherit", stderr: "inherit", env: process.env });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${result.exitCode}`);
  }
}

interface ReadyMessage {
  readonly type: "ready";
  readonly startupIdle: unknown;
  readonly startupMode: unknown;
  readonly machine: unknown;
}
interface UnitMessage {
  readonly type: "unit";
  readonly unitId: string;
  readonly repetition: number;
  readonly metrics: readonly UnitMetric[];
  readonly failures: readonly { readonly terminal: boolean; readonly message: string }[];
}
type SideMessage =
  | ReadyMessage
  | UnitMessage
  | { readonly type: "done"; readonly units: number }
  | { readonly type: "failed"; readonly message: string };

/** One commit's live side, driven over its stdin and read line by line off its stdout. */
class Side {
  private readonly child: Subprocess<"pipe", "pipe", "inherit">;
  private readonly tail = new BoundedTextTail();
  private readonly messages: SideMessage[] = [];
  private readonly waiting: Array<(message: SideMessage) => void> = [];
  private readonly reader: Promise<void>;

  constructor(
    readonly label: "base" | "head",
    root: string,
    commit: string,
    port: number,
    profile: AckerDBBenchmarkProfile,
    outputPath: string,
  ) {
    this.child = Bun.spawn([process.execPath, join(root, "bench", "run.ts")], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        BENCH_SIDE: label,
        BENCH_SOURCE_COMMIT: commit,
        BENCH_HARNESS_COMMIT: headCommit,
        BENCH_TELEMETRY_PROFILE: profile,
        BENCH_PORT: String(port),
        BENCH_OUTPUT: outputPath,
        BENCH_EXECUTION_HOST: executionHost,
      },
    }) as Subprocess<"pipe", "pipe", "inherit">;
    this.reader = this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.child.stdout) {
      this.tail.write(chunk as Uint8Array);
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("@@side ")) continue;
        const message = JSON.parse(line.slice("@@side ".length)) as SideMessage;
        const waiter = this.waiting.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
      }
    }
    this.tail.finish();
    for (const waiter of this.waiting.splice(0)) {
      waiter({ type: "failed", message: `${this.label} side exited without answering` });
    }
  }

  private next(): Promise<SideMessage> {
    const buffered = this.messages.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private async expect<T extends SideMessage["type"]>(type: T): Promise<Extract<SideMessage, { type: T }>> {
    const message = await this.next();
    if (message.type !== type) {
      throw new Error(
        `${this.label} side answered ${message.type} where ${type} was expected: ` +
          `${"message" in message ? message.message : JSON.stringify(message)}`,
      );
    }
    return message as Extract<SideMessage, { type: T }>;
  }

  ready(): Promise<ReadyMessage> {
    return this.expect("ready");
  }

  async runUnit(unit: BenchUnit, repetition: number, measureIdle: boolean): Promise<UnitMessage> {
    this.child.stdin.write(`${JSON.stringify({ type: "unit", unit, repetition, measureIdle })}\n`);
    this.child.stdin.flush();
    return this.expect("unit");
  }

  async stop(): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
    this.child.stdin.flush();
    this.child.stdin.end();
    const done = await this.expect("done");
    const exitCode = await this.child.exited;
    await this.reader;
    if (exitCode !== 0) throw new Error(`${this.label} side exited with code ${exitCode}`);
    if (done.units === 0) throw new Error(`${this.label} side measured no units`);
  }

  async kill(): Promise<void> {
    this.child.kill();
    await this.child.exited.catch(() => undefined);
  }
}

/** Every repetition of one metric on one unit, base beside head. */
export interface PairedSeries {
  readonly unitId: string;
  readonly metric: string;
  readonly samples: readonly { readonly repetition: number; readonly base: number; readonly head: number }[];
}

function pairMetrics(
  base: readonly UnitMessage[],
  head: readonly UnitMessage[],
): PairedSeries[] {
  const series = new Map<string, { unitId: string; metric: string; samples: PairedSeries["samples"][number][] }>();
  for (const baseUnit of base) {
    const headUnit = head.find(
      (candidate) => candidate.unitId === baseUnit.unitId && candidate.repetition === baseUnit.repetition,
    );
    if (headUnit === undefined) continue;
    for (const metric of baseUnit.metrics) {
      const counterpart = headUnit.metrics.find((candidate) => candidate.name === metric.name);
      if (counterpart === undefined) continue;
      const key = `${baseUnit.unitId} ${metric.name}`;
      const entry = series.get(key) ?? { unitId: baseUnit.unitId, metric: metric.name, samples: [] };
      entry.samples.push({ repetition: baseUnit.repetition, base: metric.value, head: counterpart.value });
      series.set(key, entry);
    }
  }
  return [...series.values()].map((entry) => ({
    ...entry,
    samples: [...entry.samples].sort((left, right) => left.repetition - right.repetition),
  }));
}

async function measureProfile(
  profile: AckerDBBenchmarkProfile,
  config: BenchmarkConfig,
  units: readonly BenchUnit[],
): Promise<{
  readonly profile: AckerDBBenchmarkProfile;
  readonly series: PairedSeries[];
  readonly terminalFailures: string[];
}> {
  const base = new Side(
    "base",
    baseWorktree,
    baseCommit,
    BASE_PORT,
    profile,
    join(outputDirectory, `base-${profile}.json`),
  );
  const head = new Side(
    "head",
    repository,
    headCommit,
    HEAD_PORT,
    profile,
    join(outputDirectory, `head-${profile}.json`),
  );
  const baseUnits: UnitMessage[] = [];
  const headUnits: UnitMessage[] = [];
  const terminalFailures: string[] = [];
  try {
    // Both sides seed and settle before either is measured, so neither pays the
    // other's startup out of its own numbers.
    await Promise.all([base.ready(), head.ready()]);
    for (let repetition = 0; repetition < REPETITIONS; repetition++) {
      // Repetition-major, not unit-major: a unit's repetitions are spread across
      // the whole run, so a disturbance confined to one stretch of wall clock
      // cannot land on every repetition of the same unit.
      const order = leadingSide(repetition) === "base" ? [base, head] : [head, base];
      for (const unit of units) {
        for (const side of order) {
          // The idle plateaus are a second of deliberate sleeping each; they
          // measure resident cost rather than work, so one repetition pays for
          // them and they are read as context rather than through the gate.
          const message = await side.runUnit(unit, repetition, repetition === 0);
          (side === base ? baseUnits : headUnits).push(message);
          for (const failure of message.failures) {
            if (!failure.terminal) continue;
            terminalFailures.push(`${side.label} ${unit.id} repetition ${repetition}: ${failure.message}`);
          }
        }
        if (terminalFailures.length > 0) break;
      }
      if (terminalFailures.length > 0) break;
      process.stderr.write(`— repetition ${repetition + 1}/${REPETITIONS} complete (${profile})\n`);
    }
    // An orderly stop is still part of the measurement: a side that cannot shut
    // its server down cleanly did not measure what it claims to have measured.
    await Promise.all([base.stop(), head.stop()]);
  } catch (error) {
    // Whatever failed, neither side may outlive this driver. A server left
    // holding its port would fail every profile after it with a message about
    // the port rather than about the thing that actually broke.
    await Promise.all([base.kill(), head.kill()]);
    throw error;
  }
  return { profile, series: pairMetrics(baseUnits, headUnits), terminalFailures };
}

const config = benchmarkConfigFromEnv();
const units = benchUnits(config);
const profiles = (process.env.BENCH_TELEMETRY_PROFILES ?? "disabled")
  .split(",")
  .map((value) => value.trim()) as AckerDBBenchmarkProfile[];
if (
  profiles.length === 0 ||
  profiles.some((profile) => !["enabled", "exporter", "disabled"].includes(profile)) ||
  new Set(profiles).size !== profiles.length
) {
  throw new Error("BENCH_TELEMETRY_PROFILES must contain unique enabled, exporter, or disabled profiles");
}

const startedAt = Date.now();
try {
  command(["git", "worktree", "add", "--detach", baseWorktree, baseCommit], repository);
  // The head harness defines one workload for both sides, so a change to the
  // harness itself cannot be mistaken for a change in what it measures. Only
  // AckerDB's packages and lockfile come from the base commit.
  rmSync(join(baseWorktree, "bench"), { recursive: true, force: true });
  command(["cp", "-R", join(repository, "bench"), join(baseWorktree, "bench")], repository);
  command(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], baseWorktree);

  const measured = [];
  for (const profile of profiles) {
    measured.push(await measureProfile(profile, config, units));
  }
  await Bun.write(
    join(outputDirectory, "pair.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      base: baseCommit,
      head: headCommit,
      harnessCommit: headCommit,
      executionHost,
      repetitions: REPETITIONS,
      wallSeconds: Math.round((Date.now() - startedAt) / 1_000),
      config,
      units: units.map((unit) => unit.id),
      profiles: measured,
    }, null, 2)}\n`,
  );
  process.stderr.write(
    `paired ${measured.length} telemetry profile(s) over ${REPETITIONS} repetitions in ` +
      `${Math.round((Date.now() - startedAt) / 1_000)}s\n`,
  );
} finally {
  Bun.spawnSync(["git", "worktree", "remove", "--force", baseWorktree], {
    cwd: repository,
    stdout: "ignore",
    stderr: "ignore",
  });
  rmSync(temporary, { recursive: true, force: true });
}
