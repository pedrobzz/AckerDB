import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Informational same-host diagnostic. It is not a CI gate or release benchmark.
const ROUNDS = 7;
const WARMUP_ITERATIONS = 100_000;
const DEFAULT_ITERATIONS = 2_000_000;

interface Validator<T> {
  check(value: unknown, path: string): T;
}

interface Bounded<T, Bound> extends Validator<T> {
  min(bound: Bound): Bounded<T, Bound>;
  max(bound: Bound): Bounded<T, Bound>;
}

interface StringValidator extends Bounded<string, number> {
  regex(pattern: RegExp): StringValidator;
}

interface ValidatorDsl {
  string(): StringValidator;
  int?: () => Bounded<number, number>;
  float?: () => Bounded<number, number>;
  number?: () => Bounded<number, number>;
  bigint(): Bounded<bigint, bigint>;
  boolean(): Validator<boolean>;
  array<T>(element: Validator<T>): Bounded<T[], number>;
  object(shape: Readonly<Record<string, Validator<unknown>>>): Validator<Record<string, unknown>>;
}

type Stats = Readonly<{ median: number; madPercent: number }>;
type Operation = () => number;

const decoder = new TextDecoder();
let sink = 0;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function command(args: string[], cwd: string): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${decoder.decode(result.stderr).trim()}`);
  }
  return decoder.decode(result.stdout).trim();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function stats(samples: readonly number[]): Stats {
  const middle = median(samples);
  return {
    median: middle,
    madPercent: median(samples.map((sample) => Math.abs(sample - middle))) / middle * 100,
  };
}

function batch(operation: Operation, iterations: number): number {
  let checksum = 0;
  const startedAt = Bun.nanoseconds();
  for (let index = 0; index < iterations; index += 1) {
    checksum = (checksum + operation()) | 0;
  }
  sink ^= checksum;
  return (Bun.nanoseconds() - startedAt) / iterations;
}

function compare(left: Operation, right: Operation, iterations: number): readonly [Stats, Stats] {
  batch(left, WARMUP_ITERATIONS);
  batch(right, WARMUP_ITERATIONS);
  const leftSamples: number[] = [];
  const rightSamples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round % 2 === 0) {
      leftSamples.push(batch(left, iterations));
      rightSamples.push(batch(right, iterations));
    } else {
      rightSamples.push(batch(right, iterations));
      leftSamples.push(batch(left, iterations));
    }
  }
  return [stats(leftSamples), stats(rightSamples)];
}

function finiteNumber(dsl: ValidatorDsl): Bounded<number, number> {
  const factory = dsl.float ?? dsl.number;
  if (factory === undefined) throw new Error("validator has neither float() nor number()");
  return factory();
}

function stringCheck(dsl: ValidatorDsl): Operation {
  const validator = dsl.string();
  return () => validator.check("validator-diagnostic", "args.name").length;
}

function objectCheck(dsl: ValidatorDsl): Operation {
  const validator = dsl.object({
    requestId: dsl.bigint(),
    name: dsl.string(),
    score: finiteNumber(dsl),
    active: dsl.boolean(),
    tags: dsl.array(dsl.string()),
  });
  const input = {
    requestId: 42n,
    name: "validator-diagnostic",
    score: 42.25,
    active: true,
    tags: ["validator", "diagnostic", "valid"],
  };
  return () => {
    const value = validator.check(input, "args");
    return (value.name as string).length + (value.tags as unknown[]).length;
  };
}

function checked<T>(validator: Validator<T>, value: T, consume: (value: T) => number): Operation {
  return () => consume(validator.check(value, "value"));
}

function constraintOperations(dsl: ValidatorDsl): readonly [string, Operation, Operation][] {
  if (dsl.int === undefined || dsl.float === undefined) {
    throw new Error("branch validator must expose int() and float()");
  }
  const stringValue = "validator-diagnostic";
  const arrayValue = ["validator", "diagnostic", "valid"];
  return [
    ["string min+max", checked(dsl.string(), stringValue, (v) => v.length), checked(dsl.string().min(1).max(64), stringValue, (v) => v.length)],
    ["string regex", checked(dsl.string(), stringValue, (v) => v.length), checked(dsl.string().regex(/^[a-z-]+$/), stringValue, (v) => v.length)],
    ["int min+max", checked(dsl.int(), 42, (v) => v), checked(dsl.int().min(0).max(100), 42, (v) => v)],
    ["float min+max", checked(dsl.float(), 42.25, Math.trunc), checked(dsl.float().min(0).max(100), 42.25, Math.trunc)],
    ["bigint min+max", checked(dsl.bigint(), 42n, Number), checked(dsl.bigint().min(0n).max(100n), 42n, Number)],
    [
      "array min+max",
      checked(dsl.array(dsl.string()), arrayValue, (value) => value.length),
      checked(
        dsl.array(dsl.string()).min(1).max(8),
        arrayValue,
        (value) => value.length,
      ),
    ],
  ];
}

async function loadDsl(path: string): Promise<ValidatorDsl> {
  const loaded = await import(pathToFileURL(path).href);
  if (loaded.v === undefined) throw new Error(`${path} does not export v`);
  return loaded.v as ValidatorDsl;
}

function printComparison(
  name: string,
  leftLabel: string,
  rightLabel: string,
  left: Stats,
  right: Stats,
): void {
  const delta = (right.median / left.median - 1) * 100;
  console.log(
    `${name}: ${leftLabel} ${left.median.toFixed(2)} ns/op (MAD ${left.madPercent.toFixed(2)}%), ` +
      `${rightLabel} ${right.median.toFixed(2)} ns/op (MAD ${right.madPercent.toFixed(2)}%), ` +
      `delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`,
  );
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const requestedBase = option("--base");
  const iterations = Number(option("--iterations") ?? DEFAULT_ITERATIONS);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error("--iterations must be a positive safe integer");
  }
  const baseCommit = requestedBase === undefined
    ? command(["git", "merge-base", "main", "HEAD"], root)
    : command(["git", "rev-parse", `${requestedBase}^{commit}`], root);
  const temp = mkdtempSync(join(tmpdir(), "dbzz-validator-diagnostic-"));
  const archive = join(temp, "base.tar");
  const baseRoot = join(temp, "base");
  mkdirSync(baseRoot);

  try {
    command([
      "git", "archive", "--format=tar", `--output=${archive}`,
      baseCommit, "packages/core", "packages/server",
    ], root);
    command(["tar", "-xf", archive, "-C", baseRoot], root);
    const scope = join(baseRoot, "node_modules", "@dbzz");
    mkdirSync(scope, { recursive: true });
    symlinkSync(join(baseRoot, "packages", "core"), join(scope, "core"), "dir");

    const baseDsl = await loadDsl(join(baseRoot, "packages", "server", "src", "v.ts"));
    const branchDsl = await loadDsl(join(root, "packages", "server", "src", "v.ts"));

    console.log("DBzz validator diagnostic (informational only; ±2% is the review/noise band)");
    console.log(`host: Bun ${Bun.version}, ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"}`);
    console.log(`base: ${requestedBase ?? "merge-base(main, HEAD)"} → ${baseCommit} (v)`);
    console.log(`branch: ${command(["git", "rev-parse", "HEAD"], root)} (working tree v)`);
    console.log(`load: ${iterations.toLocaleString()} checks/sample × ${ROUNDS} alternating samples; ${WARMUP_ITERATIONS.toLocaleString()} warm-up checks`);
    console.log("operation: prebuilt validators, reused valid inputs, synchronous check + output materialization");

    console.log("\nUnconstrained base → branch");
    const [baseString, branchString] = compare(stringCheck(baseDsl), stringCheck(branchDsl), iterations);
    printComparison("string", "base", "branch", baseString, branchString);
    const [baseObject, branchObject] = compare(objectCheck(baseDsl), objectCheck(branchDsl), iterations);
    printComparison("object(5 fields + 3-item array)", "base", "branch", baseObject, branchObject);

    console.log("\nBranch constraint pricing");
    for (const [name, plain, constrained] of constraintOperations(branchDsl)) {
      const [plainStats, constrainedStats] = compare(plain, constrained, iterations);
      printComparison(name, "plain", "constrained", plainStats, constrainedStats);
    }
    console.log(`checksum: ${sink}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
