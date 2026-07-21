// bun run bench:hetzner [--bootstrap <released-version> | --baseline | --telemetry]
//
// --bootstrap re-establishes an already-released version's final record at its
// tag; --baseline runs HEAD's pending version with no predecessor comparison —
// the run itself becomes the final evidence (the first release under the
// policy, or a deliberate baseline reset); --telemetry runs the optional
// DBZZ-only telemetry-cost comparison (telemetry-v<version>.json, freely
// rerun, never release evidence).
//
// This command is deliberately synchronous: release automation starts it in a
// background worker/subagent, while this process owns the remote worktree and
// copies exactly one retained result back when the run finishes.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalBenchmarkFilename } from "../bench/release.ts";
import { PACKAGES, fail, git, syncedVersion } from "./lib.ts";

const HETZNER = "htz";
const RESULTS = "bench/results";
const USAGE = "usage: bun run bench:hetzner [--bootstrap <released-version> | --baseline | --telemetry]";
const args = process.argv.slice(2);
const mode =
  args[0] === "--bootstrap" ? "bootstrap"
  : args[0] === "--baseline" ? "baseline"
  : args[0] === "--telemetry" ? "telemetry"
  : "release";
const bootstrap = mode === "bootstrap";
if (bootstrap && args.length !== 2) fail(USAGE);
if (!bootstrap && args.length !== (mode === "release" ? 0 : 1)) fail(USAGE);

const sources = new Map<string, string>();
if (!bootstrap) {
  for (const pkg of PACKAGES) {
    sources.set(pkg, await Bun.file(`packages/${pkg}/package.json`).text());
  }
}
const version = bootstrap ? args[1]! : syncedVersion((pkg) => sources.get(pkg)!);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`benchmark version ${version} must be a plain x.y.z version`);
mkdirSync(RESULTS, { recursive: true });
if (mode !== "telemetry" && existsSync(`${RESULTS}/${finalBenchmarkFilename(version)}`)) {
  fail(`v${version} already has final benchmark evidence; benchmark only a version change once`);
}
const harnessCommit = git("rev-parse", "--verify", "HEAD");
const productCommit = git("rev-parse", "--verify", bootstrap ? `v${version}` : "HEAD");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const localBundle = join(tmpdir(), `dbzz-v${version}-benchmark-${stamp}.bundle`);
const remoteRoot = `/root/benchmarks/dbzz-v${version}-${stamp}`;
const remoteRepo = `${remoteRoot}/repo`;
const resultName = mode === "telemetry" ? `telemetry-v${version}.json` : finalBenchmarkFilename(version);

function run(command: string[], inherit = true): number {
  return Bun.spawnSync(command, { stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe" }).exitCode;
}

function remote(command: string): number {
  // Keepalives make a dead TCP session fail loudly (~2 min) instead of the
  // orchestrator hanging forever on a pipe nobody will ever write to again.
  // One argv entry for the command: ssh joins arguments with spaces, so a
  // separate `sh -lc` would swallow everything after the first word.
  return run(["ssh", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8", HETZNER, command]);
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
    `BENCH_EXECUTION_HOST=hetzner BENCH_RELEASE_VERSION=${version} BENCH_RELEASE_SOURCE_COMMIT=${productCommit}${bootstrap || mode === "baseline" ? " BENCH_RELEASE_BOOTSTRAP=1" : ""}${mode === "telemetry" ? " BENCH_RUN_KIND=telemetry" : ""} bun bench/run.ts`,
  ].join("; "));

  const destination = join(RESULTS, resultName);
  if (run(["scp", `${HETZNER}:${remoteRepo}/${RESULTS}/${resultName}`, destination], false) !== 0) {
    fail("Hetzner benchmark did not retain a version-bound result");
  }
  console.log(`copied ${RESULTS}/${resultName}`);
  if (runExit !== 0) process.exitCode = runExit;
} finally {
  rmSync(localBundle, { force: true });
  remote(`rm -rf ${remoteRoot}`);
}
