import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const HETZNER_EXECUTION_HOST = "hetzner";

export interface ReleaseBenchmarkContext {
  readonly version: string;
  readonly iteration: number;
  readonly host: typeof HETZNER_EXECUTION_HOST;
}

function assertVersion(value: string, label: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${label} must be a plain x.y.z version`);
  return value;
}

function parseVersion(value: string): readonly [number, number, number] {
  const version = assertVersion(value, "version");
  return version.split(".").map(Number) as [number, number, number];
}

function compareVersion(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = parseVersion(left);
  const [rightMajor, rightMinor, rightPatch] = parseVersion(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

export function releaseBenchmarkContext(currentVersion: string): ReleaseBenchmarkContext {
  if (process.env.BENCH_EXECUTION_HOST !== HETZNER_EXECUTION_HOST) {
    throw new Error(`release benchmarks run on ${HETZNER_EXECUTION_HOST} only; use bun run bench:hetzner`);
  }
  const version = assertVersion(process.env.BENCH_RELEASE_VERSION ?? "", "BENCH_RELEASE_VERSION");
  if (version !== currentVersion) {
    throw new Error(`BENCH_RELEASE_VERSION=${version} does not match package version ${currentVersion}`);
  }
  const iteration = Number(process.env.BENCH_RELEASE_ITERATION ?? "1");
  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error("BENCH_RELEASE_ITERATION must be a positive integer");
  }
  return Object.freeze({ version, iteration, host: HETZNER_EXECUTION_HOST });
}

export function finalBenchmarkFilename(version: string): string {
  return `v${assertVersion(version, "benchmark version")}.json`;
}

export function iterationBenchmarkFilename(version: string, iteration: number): string {
  if (!Number.isSafeInteger(iteration) || iteration < 1) throw new Error("benchmark iteration must be a positive integer");
  return `v${assertVersion(version, "benchmark version")}.iteration-${iteration}.json`;
}

export function previousFinalBenchmark(resultsDir: string, version: string): { version: string; path: string } {
  const current = assertVersion(version, "benchmark version");
  const candidates = existsSync(resultsDir)
    ? readdirSync(resultsDir)
      .map((name) => /^v(\d+\.\d+\.\d+)\.json$/.exec(name))
      .flatMap((match) => match ? [{ version: match[1]!, path: join(resultsDir, match[0]) }] : [])
      .filter((candidate) => compareVersion(candidate.version, current) < 0)
      .sort((left, right) => compareVersion(right.version, left.version))
    : [];
  const previous = candidates[0];
  if (!previous) {
    throw new Error(
      `no final benchmark precedes v${current}; bootstrap the latest released version on Hetzner before releasing this version`,
    );
  }
  return previous;
}

export function readPreviousFinalBenchmark<T>(resultsDir: string, version: string): { version: string; record: T } {
  const previous = previousFinalBenchmark(resultsDir, version);
  return { version: previous.version, record: JSON.parse(readFileSync(previous.path, "utf8")) as T };
}

export function previousIterationBenchmark(
  resultsDir: string,
  version: string,
  currentIteration: number,
): { iteration: number; path: string } | undefined {
  const current = assertVersion(version, "benchmark version");
  if (!Number.isSafeInteger(currentIteration) || currentIteration < 1) {
    throw new Error("current benchmark iteration must be a positive integer");
  }
  if (!existsSync(resultsDir)) return undefined;
  const pattern = new RegExp(`^v${current.replaceAll(".", "\\.")}\\.iteration-(\\d+)\\.json$`);
  return readdirSync(resultsDir)
    .map((name) => {
      const match = pattern.exec(name);
      return match ? { iteration: Number(match[1]), path: join(resultsDir, name) } : undefined;
    })
    .filter((candidate): candidate is { iteration: number; path: string } =>
      candidate !== undefined && Number.isSafeInteger(candidate.iteration) &&
      candidate.iteration >= 1 && candidate.iteration < currentIteration
    )
    .sort((left, right) => right.iteration - left.iteration)[0];
}

export function readPreviousIterationBenchmark<T>(
  resultsDir: string,
  version: string,
  currentIteration: number,
): { iteration: number; record: T } | undefined {
  const previous = previousIterationBenchmark(resultsDir, version, currentIteration);
  return previous && { iteration: previous.iteration, record: JSON.parse(readFileSync(previous.path, "utf8")) as T };
}

export function removeReleaseIterations(resultsDir: string, version: string): void {
  const iterationPrefix = `v${assertVersion(version, "benchmark version")}.iteration-`;
  for (const name of readdirSync(resultsDir)) {
    if (name.startsWith(iterationPrefix) && name.endsWith(".json")) rmSync(join(resultsDir, name));
  }
}

export async function retainReleaseBenchmark(
  resultsDir: string,
  context: ReleaseBenchmarkContext,
  approved: boolean,
  record: unknown,
): Promise<string> {
  const filename = approved
    ? finalBenchmarkFilename(context.version)
    : iterationBenchmarkFilename(context.version, context.iteration);
  const path = join(resultsDir, filename);
  if (existsSync(path)) throw new Error(`release benchmark evidence already exists at ${path}`);
  await Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
  if (approved) removeReleaseIterations(resultsDir, context.version);
  return path;
}
