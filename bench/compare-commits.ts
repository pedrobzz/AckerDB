import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [baseCommit, headCommit, outputDirectoryArgument] = process.argv.slice(2);
if (!baseCommit || !headCommit || !outputDirectoryArgument) {
  throw new Error(
    "usage: bun bench/compare-commits.ts <base-sha> <head-sha> <output-directory>",
  );
}
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.BENCH_EXECUTION_HOST !== "hetzner"
) {
  throw new Error("paired benchmarks run only in the GitHub Hetzner job");
}

const repository = resolve(import.meta.dir, "..");
const outputDirectory = resolve(outputDirectoryArgument);
const temporary = mkdtempSync(join(tmpdir(), "ackerdb-benchmark-pair-"));
const baseWorktree = join(temporary, "base");
mkdirSync(outputDirectory, { recursive: true });

function command(command: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([...command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  }
}

function sample(root: string, label: "base" | "head", commit: string): void {
  const output = join(outputDirectory, `${label}.json`);
  const result = Bun.spawnSync([process.execPath, "bench/run.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      BENCH_OUTPUT: output,
      BENCH_SOURCE_LABEL: label,
      BENCH_SOURCE_COMMIT: commit,
      BENCH_HARNESS_COMMIT: headCommit,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} AckerDB sample failed with exit code ${result.exitCode}`);
  }
}

try {
  command(["git", "worktree", "add", "--detach", baseWorktree, baseCommit], repository);
  // The head harness defines one workload for both products. Only AckerDB's
  // packages and lockfile come from the base commit, so the comparison does not
  // accidentally change logical work between samples.
  rmSync(join(baseWorktree, "bench"), { recursive: true, force: true });
  command(["cp", "-R", join(repository, "bench"), join(baseWorktree, "bench")], repository);
  command(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], baseWorktree);

  // Alternate order deterministically so one side is not always charged for a
  // colder host. GitHub reruns preserve the same order.
  const baseFirst = Number.parseInt(headCommit.slice(-2), 16) % 2 === 0;
  if (baseFirst) {
    sample(baseWorktree, "base", baseCommit);
    sample(repository, "head", headCommit);
  } else {
    sample(repository, "head", headCommit);
    sample(baseWorktree, "base", baseCommit);
  }
} finally {
  Bun.spawnSync(["git", "worktree", "remove", "--force", baseWorktree], {
    cwd: repository,
    stdout: "ignore",
    stderr: "ignore",
  });
  rmSync(temporary, { recursive: true, force: true });
}
