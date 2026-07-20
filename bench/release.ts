import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const HETZNER_EXECUTION_HOST = "hetzner";

export interface ReleaseBenchmarkContext {
  readonly version: string;
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
  return Object.freeze({ version, host: HETZNER_EXECUTION_HOST });
}

export function finalBenchmarkFilename(version: string): string {
  return `v${assertVersion(version, "benchmark version")}.json`;
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

export async function retainReleaseBenchmark(
  resultsDir: string,
  context: ReleaseBenchmarkContext,
  record: unknown,
): Promise<string> {
  const path = join(resultsDir, finalBenchmarkFilename(context.version));
  if (existsSync(path)) throw new Error(`release benchmark evidence already exists at ${path}`);
  await Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}
