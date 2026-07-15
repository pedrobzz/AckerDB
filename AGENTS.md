When researching any topic, Do not forget to use the [LLM Wiki Skill](.agents/skills/karpathy-llm-wiki/SKILL.md) to build a wiki of the topic.


# Benchmarks
**important**: Always run benchmarks before and after any structural changes to the codebase to ensure performance is not degraded.

We always benchmark agains convex and spacetimeDB on the same machine, same workload, to see if our changes keep the same level of performance or increases it.

We never try to beat SpacetimeDB, we use SpacetimeDB as a reference of "excellent performance". Every metric that we beat SpacetimeDB is a win, but it's not required. (If we used to beat SpacetimeDB, we should still beat it on every change. We shouldn't regress.)

Convex is always the thing to beat, and not by little.

## How to benchmark

```sh
bun bench/run.ts                # full run: dbzz + convex + spacetimedb
bun bench/run.ts dbzz convex    # any subset, for debugging (result not saved)
```

A full run benchmarks all three systems with fresh state, prints a 3-way
comparison table, saves a record to `bench/results/<timestamp>-<gitsha>.json`
(git-tracked — machine info, tool versions, per-system metrics), and prints a
per-metric delta vs the most recent previous record with ⚠ on regressions.
Details, prerequisites, and fairness notes: `bench/README.md`.

Instructions for next runs:

1. Before a structural change, run `bun bench/run.ts` on a clean tree to get a
   fresh baseline record (skip if there is already a recent record for HEAD).
2. After the change, run it again and read the "vs previous run" delta.
3. Latency percentiles are noisy (±15% run-to-run is normal). Rerun before
   believing a regression; a real one shows a consistent direction across
   metrics and runs. dbzz mutations/sec, sub p50, and CPU time are the
   headline metrics.
4. If dbzz regressed on any metric it used to win, fix it before landing.
5. Commit the new `bench/results/*.json` together with the change, and update
   the results table in `bench/README.md` when the numbers move meaningfully.
6. Requirements for the SpacetimeDB leg: `spacetime` CLI on PATH, and the npm
   `spacetimedb` pin in `bench/spacetime-app/` matching the CLI version
   (currently 2.6.1). Client bindings regenerate automatically each run.

# Local Publishing

We do not publish to npm. Releases go to a local Verdaccio registry at `http://localhost:4873`, so real projects on this machine can install `@dbzz/*` like normal npm packages — pinned, with every old version still installable.

The four packages (`@dbzz/core`, `@dbzz/server`, `@dbzz/client`, `@dbzz/cli`) share **one version, always in lockstep**. Bumping one bumps all four (`bun run bump` writes all of them; the merge guard rejects drift). Each published version is also a git tag (`v0.2.0`), so old published code is always recoverable with `git checkout v0.2.0`.

## One-time setup (per clone / machine)

```bash
bun install                                  # "prepare" installs the git hooks + no-ff merges on main
bun run registry                             # starts Verdaccio (keep it running in its own terminal)
bunx npm adduser --registry http://localhost:4873   # any username/password; token lands in ~/.npmrc
```

The committed repo-root `.npmrc` routes the `@dbzz` scope to the local registry — that line is what `bun publish` uses to pick the target registry (and to find the adduser token in `~/.npmrc`). The release scripts read the same line, so `.npmrc` is the single place the registry URL lives.

## Workflow: every change goes through a branch

Main is protected by git hooks (`.githooks/`): direct commits to main are rejected, and merges into main are guarded.

1. **Branch**: `git checkout -b feat/<name>` (or `fix/`, `chore/`, ...).
2. **Commit with conventional commit messages** — the guard reads them. `feat:` and `fix:` (and any breaking `type!:`) require a version bump; `chore:`, `docs:`, `test:`, `refactor:` etc. merge freely.
3. **Bump on the branch** before merging (pick the semver level yourself):
   ```bash
   bun run bump patch   # or: minor | major
   ```
   This rewrites the version in all 4 packages **and** their inter-deps (pinned as `workspace:X.Y.Z` — never hand-edit these back to `workspace:*`; bun packs `workspace:*` from a bun.lock snapshot that goes stale on version-only edits), then commits everything as `chore(release): vX.Y.Z`.
4. **Merge into main** (a merge commit by default — no-ff is configured):
   ```bash
   git checkout main && git merge feat/<name>
   ```
   The `pre-merge-commit` hook (`scripts/merge-guard.ts`) blocks the merge if:
   - the branch has `feat`/`fix`/breaking commits but the version didn't change;
   - the 4 package versions are not identical;
   - the new version is not greater than main's, or is already tagged.

   If it blocks you: `git merge --abort`, bump on the branch, merge again.
5. **Publish** (manual, from main, clean tree):
   ```bash
   bun run publish:local
   ```
   Publishes all 4 packages at the pinned version to Verdaccio (in dependency order: core, server, client, cli) and tags the commit `vX.Y.Z`. `bun publish` rewrites the `workspace:X.Y.Z` inter-deps to the literal `X.Y.Z` at pack time, so tarballs depend on exact versions.

## Using dbzz in a real project

In the consumer project, scope `@dbzz` to the local registry — `.npmrc` in the project root:

```ini
@dbzz:registry=http://localhost:4873
```

Then install exact (pinned) versions:

```bash
bun add --exact @dbzz/server@0.2.0 @dbzz/client@0.2.0 @dbzz/cli@0.2.0
```

**Going back to an old version works**: Verdaccio keeps every published version in `registry/storage/` (gitignored, survives restarts), so `bun add --exact @dbzz/server@0.1.0` keeps working after 0.2.0+ exist. To see the matching source, `git checkout v0.1.0`.

Consumers must run Bun — packages ship raw TypeScript from `src/`.

## Escape hatches & caveats

- The guard runs at two layers: the merge hooks (nice errors, right timing), plus a `reference-transaction` backstop that checks **every** update to `refs/heads/main` — so fast-forward merges (`--ff`/`--ff-only` override the no-ff config), cherry-picks onto main, rebases, and even `--no-verify` merges (which skip commit hooks but not this) are blocked mechanically if they'd land feat/fix commits without a bump. When the backstop aborts one of these, git may leave staged changes behind — `git reset --hard` restores main.
- `DBZZ_ALLOW_MAIN=1` is the deliberate escape: it bypasses both the direct-commit block and the backstop (use sparingly; this is how repo-meta changes like this tooling land).
- Prefer plain `git merge` (merge commits) — the merge hooks give clearer errors than the backstop, and history stays legible.
- Never `npm publish` here (it does not rewrite `workspace:*`) and never pass `--registry` to `bun publish` (it bypasses `.npmrc` and loses the auth token). Always `bun run publish:local`.
- If a publish is interrupted midway, just re-run `bun run publish:local` — it skips packages already in the registry at the current version and finishes the rest (then tags).
- To unpublish a broken version: `bunx npm unpublish --force @dbzz/<pkg>@X.Y.Z --registry http://localhost:4873` (do it for all 4, then delete the tag).

Release plumbing lives in `scripts/` (`bump.ts`, `merge-guard.ts`, `publish-local.ts`, shared `lib.ts`), hooks in `.githooks/`, registry config in `registry/config.yaml`, scope routing in the repo-root `.npmrc`.
