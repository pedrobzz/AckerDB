// Blocks updates to main that contain feat/fix (or breaking `!`) commits
// without a version bump. Three callers:
//   .githooks/pre-merge-commit  — clean merges (reads GITHEAD_* env; git only
//                                 writes MERGE_HEAD before this hook on the
//                                 conflict path)
//   .githooks/pre-commit        — conflict-resolution merge commits (MERGE_HEAD)
//   .githooks/reference-transaction --range <old> <new>
//                               — backstop for every other way main can move:
//                                 ff merges (--ff/--ff-only override the no-ff
//                                 config), cherry-pick, rebase, --no-verify
//                                 merges (commit hooks are skipped, this isn't)
import { PACKAGES, fail, git, semverGt, syncedVersion, tryGit } from "./lib";

// Commit types that force a version bump; everything else (chore, docs, test,
// refactor, ...) merges freely. A breaking `!` on any type also forces a bump.
// Conventional-commit types are case-insensitive per the spec.
const BUMP_TYPES = ["feat", "fix"];
const bumpType = new RegExp(`^(${BUMP_TYPES.join("|")})(\\(.+\\))?!?:`, "i");
const breaking = /^[a-z]+(\(.+\))?!:/i;

function versionAt(ref: string, requireCompleteSet: boolean): string {
  const present = PACKAGES.filter(
    (pkg) => tryGit("show", `${ref}:packages/${pkg}/package.json`) !== null,
  );
  if (requireCompleteSet && present.length !== PACKAGES.length) {
    const missing = PACKAGES.filter((pkg) => !present.includes(pkg));
    fail(`${ref} is missing release package(s): ${missing.map((pkg) => `@dbzz/${pkg}`).join(", ")}`);
  }
  return syncedVersion(
    (pkg) => git("show", `${ref}:packages/${pkg}/package.json`),
    present,
  );
}

function check(subjects: string[], mainVersion: string, newVersion: string): void {
  const bumpCommits = subjects.filter((s) => bumpType.test(s) || breaking.test(s));

  if (newVersion === mainVersion) {
    if (bumpCommits.length === 0) return;
    fail(
      `these commits landing on main require a version bump, but the version is still ${mainVersion}:\n` +
        bumpCommits.map((s) => `    ${s}`).join("\n") +
        `\n\n  Bump on the branch, then merge again:\n` +
        `    git merge --abort\n` +
        `    git checkout <branch> && bun run bump <patch|minor|major>\n` +
        `    git checkout main && git merge <branch>`,
    );
  }

  if (!semverGt(newVersion, mainVersion)) {
    fail(`new version ${newVersion} must be greater than main's ${mainVersion}`);
  }
  if (tryGit("rev-parse", "-q", "--verify", `refs/tags/v${newVersion}`)) {
    fail(`v${newVersion} is already tagged (published) — bump to a fresh version on the branch`);
  }
}

const args = process.argv.slice(2);

if (args[0] === "--range") {
  // reference-transaction backstop: refs/heads/main is moving old -> new.
  const [oldRef, newRef] = [args[1], args[2]];
  if (!oldRef || !newRef) fail("usage: merge-guard.ts --range <old-sha> <new-sha>");
  const subjects = git("log", "--no-merges", "--format=%s", `${oldRef}..${newRef}`)
    .split("\n")
    .filter(Boolean);
  if (subjects.length === 0) process.exit(0); // pure rewind (reset to an ancestor)
  // The old ref may predate a package added by this release. The new ref must
  // contain the complete release set and keep every package in lockstep.
  check(subjects, versionAt(oldRef, false), versionAt(newRef, true));
  process.exit(0);
}

const branch = tryGit("symbolic-ref", "--short", "HEAD");
if (branch !== "main") process.exit(0);

const heads: string[] = [];
const mergeHead = tryGit("rev-parse", "-q", "--verify", "MERGE_HEAD");
if (mergeHead) heads.push(mergeHead);
else {
  for (const key of Object.keys(process.env)) {
    const m = /^GITHEAD_([0-9a-f]{40,64})$/.exec(key);
    if (m) heads.push(m[1]!);
  }
}
if (heads.length === 0) process.exit(0);

const subjects = heads
  .flatMap((head) => git("log", "--no-merges", "--format=%s", `HEAD..${head}`).split("\n"))
  .filter(Boolean);

// HEAD = main before the merge; ":" = the index, i.e. the merged result.
const mergedVersion = syncedVersion((pkg) => git("show", `:packages/${pkg}/package.json`));
check(subjects, versionAt("HEAD", false), mergedVersion);
