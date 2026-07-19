// bun run bench:hetzner [--bootstrap <released-version> | --baseline]
//
// --bootstrap re-establishes an already-released version's final record at its
// tag; --baseline runs HEAD's pending version with no predecessor comparison —
// the run itself becomes the final evidence (the first release under the
// policy, or a deliberate baseline reset).
//
// This command is deliberately synchronous: release automation starts it in a
// background worker/subagent, while this process owns the remote worktree and
// copies exactly one retained result back when the run finishes.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalBenchmarkFilename, iterationBenchmarkFilename, removeReleaseIterations } from "../bench/release.ts";
import { fail, git, syncedVersion } from "./lib.ts";

const HETZNER = "htz";
const RESULTS = "bench/results";
const USAGE = "usage: bun run bench:hetzner [--bootstrap <released-version> | --baseline]";
const args = process.argv.slice(2);
const bootstrap = args[0] === "--bootstrap";
const baseline = args[0] === "--baseline";
if (bootstrap && args.length !== 2) fail(USAGE);
if (baseline && args.length !== 1) fail(USAGE);
if (!bootstrap && !baseline && args.length !== 0) fail(USAGE);

const sources = new Map<string, string>();
if (!bootstrap) {
  for (const pkg of ["core", "server", "client", "client-react", "cli"]) {
    sources.set(pkg, await Bun.file(`packages/${pkg}/package.json`).text());
  }
}
const version = bootstrap ? args[1]! : syncedVersion((pkg) => sources.get(pkg)!);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`benchmark version ${version} must be a plain x.y.z version`);
mkdirSync(RESULTS, { recursive: true });
if (existsSync(`${RESULTS}/${finalBenchmarkFilename(version)}`)) {
  fail(`v${version} already has final benchmark evidence; benchmark only a version change once`);
}
const existingIterations = readdirSync(RESULTS)
  .flatMap((name) => {
    const match = new RegExp(`^v${version.replace(/\./g, "\\.")}\\.iteration-(\\d+)\\.json$`).exec(name);
    return match ? [Number(match[1])] : [];
  });
const iteration = Math.max(0, ...existingIterations) + 1;

const harnessCommit = git("rev-parse", "--verify", "HEAD");
const productCommit = git("rev-parse", "--verify", bootstrap ? `v${version}` : "HEAD");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const localBundle = join(tmpdir(), `dbzz-v${version}-benchmark-${stamp}.bundle`);
const remoteRoot = `/root/benchmarks/dbzz-v${version}-${iteration}-${stamp}`;
const remoteRepo = `${remoteRoot}/repo`;
const names = [finalBenchmarkFilename(version), iterationBenchmarkFilename(version, iteration)];

function run(command: string[], inherit = true): number {
  return Bun.spawnSync(command, { stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe" }).exitCode;
}

function remote(command: string): number {
  return run(["ssh", HETZNER, "sh", "-lc", command]);
}

try {
  if (run(["git", "bundle", "create", localBundle, "HEAD"]) !== 0) fail("could not create the release benchmark source bundle");
  if (remote(`set -eu; mkdir -p ${remoteRoot}`) !== 0) fail("could not create the Hetzner benchmark worktree");
  if (run(["scp", localBundle, `${HETZNER}:${remoteRoot}/source.bundle`]) !== 0) {
    fail("could not upload the release benchmark source bundle to Hetzner");
  }

  const runExit = remote([
    "set -eu",
    "export PATH=/root/.local/node24/bin:/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
    `git clone ${remoteRoot}/source.bundle ${remoteRepo}`,
    `cd ${remoteRepo}`,
    `git checkout -q ${harnessCommit}`,
    ...(bootstrap ? [`git checkout -q ${productCommit} -- packages`] : []),
    "bun install --frozen-lockfile",
    "cd bench/convex-app && bun install --frozen-lockfile",
    "cd ../spacetime-app && bun install --frozen-lockfile",
    "cd spacetimedb && bun install --frozen-lockfile",
    `cd ${remoteRepo}`,
    `BENCH_EXECUTION_HOST=hetzner BENCH_RELEASE_VERSION=${version} BENCH_RELEASE_ITERATION=${iteration} BENCH_RELEASE_SOURCE_COMMIT=${productCommit}${bootstrap || baseline ? " BENCH_RELEASE_BOOTSTRAP=1" : ""} bun bench/run.ts`,
  ].join("; "));

  let copied = false;
  let finalCopied = false;
  for (const name of names) {
    const destination = join(RESULTS, name);
    if (run(["scp", `${HETZNER}:${remoteRepo}/${RESULTS}/${name}`, destination], false) === 0) {
      copied = true;
      if (name === finalBenchmarkFilename(version)) finalCopied = true;
      console.log(`copied ${RESULTS}/${name}`);
    }
  }
  if (!copied) fail("Hetzner benchmark did not retain a version-bound result");
  if (finalCopied) removeReleaseIterations(RESULTS, version);
  if (runExit !== 0) process.exitCode = runExit;
} finally {
  rmSync(localBundle, { force: true });
  remote(`rm -rf ${remoteRoot}`);
}
