When researching any topic, Do not forget to use the [LLM Wiki Skill](.agents/skills/karpathy-llm-wiki/SKILL.md) to build a wiki of the topic.

## Performance, correctness, and code quality

Standing rules for every change. Terms are defined in `CONTEXT.md`
(Engineering philosophy)—use those names; do not redefine them here.

### Target and scale

Optimize for the default deployment envelope under the design load: smooth
operation with meaningful headroom, not a single fast metric that saturates
CPU or memory. Normal production at that size must not live near CPU, memory,
queue, file-descriptor, or transport saturation. The more useful work that
fits inside that envelope, the better. It is not a claim that every
concurrency level fits on 4 GiB—for example, ~100k concurrent users are
expected to need a larger host that the operator can afford.

Apply minimal proportional cost: CPU and RAM may grow with connections, users,
subscriptions, and updates, but only in proportion to that work, and that
proportion must stay as small as possible. Super-linear growth, global scans,
and duplicated per-connection machinery violate the rule. Design load is a
design target, not an excuse to pre-allocate for every theoretical maximum.

Development may use more resources than production, but must remain bounded
and must not make the developer machine hostile to use.

### Measure the whole performance vector

State the operation and load shape first: data size, concurrency, subscription
count, latency target, durability point, and failure mode. Evaluate a change
across every dimension of the performance vector:

| Dimension | What good looks like |
| --- | --- |
| Useful latency and throughput | Fast p50/p95/p99 and high completed useful work for the actual operation, not a synthetic partial path. |
| Idle cost | Near-zero CPU when there is no work; no background churn, polling, or retained state without a purpose. |
| Memory | Explicit, finite ownership and budgets. RAM is scarce; copying, caches, queues, history, and telemetry must earn their bytes. |
| Scale shape | Minimal proportional cost. No global scans, duplicated recomputation, or allocation cliffs. Larger loads may use larger machines. |
| Tail behavior | A slow consumer, a hot key, a full queue, or a dependency failure gets a bounded typed outcome instead of poisoning unrelated work. |
| Startup and recovery | Recovery, migration, and shutdown are observable and finite; fast startup does not skip integrity or durability work. |
| Durable correctness | A number is meaningless if the operation loses, corrupts, duplicates, or silently hides data. |

Convex is a useful contrast: measure the CPU/RAM and fan-out cost of equivalent
work rather than inheriting its architecture by default. SpacetimeDB is a
useful performance reference, not a claim that every one of its tradeoffs
belongs in DBzz. Compare the same workload on the same machine; the repository
benchmark is the authoritative comparison method (see Benchmarks).

### Judge by net-effect judgment

Score against the simplest design that still satisfies the required
invariant—not against the decision's stated intention. Apply the same rule to
performance, correctness, and code quality:

| Score | Meaning |
| --- | --- |
| 8–10 | Exceptional net improvement. Use only when evidence shows a material gain and no relevant cost offsets it. |
| 6–7 | Net improvement with explicit costs. |
| 5 | Neutral, mixed, or not directed at that dimension. |
| 1–4 | Net regression, even if it buys another dimension. State the benefit and the cost plainly. |
| 0 | Substantially harmful for the stated target. |

Do not give a high score merely because a mechanism has a good purpose. A
retry model may increase correctness while worsening tail latency; an all-RAM
database may improve raw reads while worsening capacity; a massive workspace
may isolate ownership while making contributors slower; a validation layer may
prevent bad data while adding deployment and write cost. If a system's choices
all score above 5 in every dimension, the review is not judging its tradeoffs.

### Correct code

Correctness is broader than “the happy-path test passed.” Correct DBzz code:

1. **Does not lose data silently.** Persisted state, migrations, retries,
   ordering, recovery, and destructive operations must be explicit. A failure
   must preserve evidence and say what is known, unknown, committed, or not
   committed.
2. **Is organized enough to change safely.** A new contributor should find the
   owner, invariant, data flow, and test boundary without weeks of archaeology.
   Small direct modules and one source of truth beat wrappers, duplicate paths,
   and hidden state.
3. **Solves the design instead of stacking fixes.** A new guard that is part of
   the real contract—an implementation safeguard such as validation, a
   transaction, a bound, a typed outcome, or a migration transform—is
   implementation. A branch added only to compensate for a wrong shape is
   debt, not a solution.
4. **Addresses severe credible edge cases.** Probability and impact are both
   relevant. An ultra-rare theoretical case can remain when its cure would make
   the system worse. A 0.01% event that can lose data, leak memory, or break a
   customer is credible enough to fix deliberately.

### When a design wall appears

A mismatch with a specification, failed assumption, test, or integration is a
design signal. Do not patch around it to make the old statement appear true.
Re-derive the model from first principles until the conflicting case has one
honest home. If that result diverges from the requested specification, explain
the divergence before implementing it.

Never turn an invalid design into a “working” deliverable using an accidental
patch. The patch merely hides the failure and becomes future machinery.

When the only correct design is breaking, make the break explicit: state what
changes, why the replacement is simpler/safer/faster, and how consumers move.
Do not add backwards compatibility unless it was explicitly requested.

### Distinguish safeguards from debt

| Kind | Test | Treatment |
| --- | --- | --- |
| Implementation safeguard | The desired design needs it to enforce an invariant. | Keep it direct, name the invariant, and test it. |
| Deferred-design workaround | It exists only because the correct structure is known but too expensive to implement now. | Avoid. If explicitly approved, constrain it tightly and add a `TODO` naming the protection, missing design, and deletion condition. |
| Accidental patch | It creates a special/parallel path to avoid changing the wrong model. | Reject it; return to the ownership or invariant that made it appear necessary. |

### Prefer less code and proven work

The most performant code is code that never runs. The least buggy code is code
that does not exist. Delete redundant operations and state before optimizing
them. Do not hand-build commodity machinery just to avoid a dependency; use a
small, well-understood solution when it fits the actual contract.

Do not keep a dependency merely because it currently works. If its design adds
material cost, incorrectness, or unused machinery, first study it in OpenSRC
and its primary sources, then refresh deliberately when the studied version
changes. Vendor it only when a focused adaptation has a proven net gain; build
a replacement only after a prototype demonstrates a material performance or
correctness gain that justifies permanent maintenance.

### Evidence and verification

Most mature systems problems already have prior art. Before inventing, inspect
current OpenSRC snapshots and primary sources. Put external source material and
compiled findings in the LLM Wiki (`raw/` and `wiki/`); put DBzz terminology
and settled domain boundaries in `CONTEXT.md`; put material DBzz tradeoffs in
the decision ledger. Revisit all three when later evidence changes a decision.

Verify at the boundary that previously failed; prove the old failure path is
gone rather than masked.

Before accepting a performance/correctness change, answer:

1. What useful work became faster or safer, under which load shape?
2. What RAM, CPU, queue, network, and storage ownership did it add or remove?
3. What happens at saturation, crash, timeout, disconnect, restart, and
   schema change?
4. Does it preserve data and make ambiguity explicit?
5. Does it remove a model problem or create another branch around it?
6. Which OpenSRC/primary-source decision or DBzz ledger entry supports it?
7. What boundary test and, when relevant, benchmark prove the claim?


# Benchmarks

Benchmarks are a release-only last resort. Run them only for a major, minor,
or patch version change—never before or after ordinary implementation work.
The final benchmark from the preceding version is the before-state.

Every release benchmark runs all of DBZZ, Convex, and SpacetimeDB on Hetzner
only, with the same workload. After `bun run bump <patch|minor|major>`,
dispatch `bun run bench:hetzner` in a background subagent or worker. Do not
run `bench/run.ts` on the developer machine. The merge guard rejects a version
change without a final approved Hetzner result.

Records are version-bound:

- final: `bench/results/v<version>.json`;
- recovery iteration: `bench/results/v<version>.iteration-<n>.json`.

A passing final run deletes that version's iterations. Do not retain timestamp
results, ad-hoc benchmark logs, or a separate before-change record. Existing
releases get one Hetzner bootstrap at their release tag, not a renamed legacy
record.

A material DBZZ regression is a directional move beyond the 15% noise envelope
(0.025 CPU cores for idle CPU). Rerun once; the Hetzner wrapper assigns the
next iteration number without overwriting evidence. If it repeats, enter performance
recovery: inspect every changed implementation and decision as intended
behavior with a wrong design; identify the hot path and redesign it so the
cost disappears. Do not patch around the regression. A release passes only
when correctness passes and no material regression remains. If the feature
cannot exist without the impact, say so explicitly in the final handoff.

SpacetimeDB remains an excellent reference, not a product DBZZ must beat on
every metric. Convex remains the main comparative target. Their same-run
measurements make the DBZZ result interpretable; the version-to-version gate
judges DBZZ itself.

# Local Publishing

We do not publish to npm. Releases go to a local Verdaccio registry at `http://127.0.0.1:4873`, so real projects on this machine can install `@dbzz/*` like normal npm packages — pinned, with every old version still installable.

The five packages (`@dbzz/core`, `@dbzz/server`, `@dbzz/client`, `@dbzz/client-react`, `@dbzz/cli`) share **one version, always in lockstep**. Bumping one bumps all five (`bun run bump` writes all of them; the merge guard rejects drift). Each published version is also a git tag (`v0.2.0`), so old published code is always recoverable with `git checkout v0.2.0`.

## One-time setup (per clone / machine)

```bash
bun install                                  # "prepare" installs the git hooks + no-ff merges on main
bun run registry                             # starts Verdaccio (keep it running in its own terminal)
bunx npm adduser --registry http://127.0.0.1:4873   # any username/password; token lands in ~/.npmrc
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
   This rewrites the version in all 5 packages **and** their inter-deps (pinned as `workspace:X.Y.Z` — never hand-edit these back to `workspace:*`; bun packs `workspace:*` from a bun.lock snapshot that goes stale on version-only edits), then commits everything as `chore(release): vX.Y.Z`.
4. **Benchmark the release version**: dispatch this in a background worker or
   subagent; it runs only on Hetzner and compares the pending version with the
   preceding version's final record:
   ```bash
   bun run bench:hetzner
   ```
   Commit only `bench/results/vX.Y.Z.json` when it passes. A material regression
   produces `vX.Y.Z.iteration-N.json`; rerun once, then do performance recovery
   instead of merging a materially slower release. During this policy migration,
   establish the latest already-published predecessor once with
   `bun run bench:hetzner --bootstrap X.Y.Z` at its tag.
5. **Merge into main** (a merge commit by default — no-ff is configured):
   ```bash
   git checkout main && git merge feat/<name>
   ```
   The `pre-merge-commit` hook (`scripts/merge-guard.ts`) blocks the merge if:
   - the branch has `feat`/`fix`/breaking commits but the version didn't change;
   - the 5 package versions are not identical;
   - the new version is not greater than main's, or is already tagged.
   - a version change lacks a final passing Hetzner result against main's
     version.

   If it blocks you: `git merge --abort`, bump on the branch, merge again.
6. **Publish** (manual, from main, clean tree):
   ```bash
   bun run publish:local
   ```
   Publishes all 5 packages at the pinned version to Verdaccio (in dependency order: core, server, client, client-react, cli) and tags the commit `vX.Y.Z`. `bun publish` rewrites the `workspace:X.Y.Z` inter-deps to the literal `X.Y.Z` at pack time, so tarballs depend on exact versions.

## Using dbzz in a real project

In the consumer project, scope `@dbzz` to the local registry — `.npmrc` in the project root:

```ini
@dbzz:registry=http://127.0.0.1:4873
```

Then install exact (pinned) versions:

```bash
bun add --exact @dbzz/server@0.2.0 @dbzz/client@0.2.0 @dbzz/client-react@0.2.0 @dbzz/cli@0.2.0
```

**Going back to an old version works**: Verdaccio keeps every published version in `registry/storage/` (gitignored, survives restarts), so `bun add --exact @dbzz/server@0.1.0` keeps working after 0.2.0+ exist. To see the matching source, `git checkout v0.1.0`.

Consumers must run Bun — packages ship raw TypeScript from `src/`.

## Escape hatches & caveats

- The guard runs at two layers: the merge hooks (nice errors, right timing), plus a `reference-transaction` backstop that checks **every** update to `refs/heads/main` — so fast-forward merges (`--ff`/`--ff-only` override the no-ff config), cherry-picks onto main, rebases, and even `--no-verify` merges (which skip commit hooks but not this) are blocked mechanically if they'd land feat/fix commits without a bump. When the backstop aborts one of these, git may leave staged changes behind — `git reset --hard` restores main.
- `DBZZ_ALLOW_MAIN=1` is the deliberate escape: it bypasses both the direct-commit block and the backstop (use sparingly; this is how repo-meta changes like this tooling land).
- Prefer plain `git merge` (merge commits) — the merge hooks give clearer errors than the backstop, and history stays legible.
- Never `npm publish` here (it does not rewrite `workspace:*`) and never pass `--registry` to `bun publish` (it bypasses `.npmrc` and loses the auth token). Always `bun run publish:local`.
- If a publish is interrupted midway, just re-run `bun run publish:local` — it skips packages already in the registry at the current version and finishes the rest (then tags).
- To unpublish a broken version: `bunx npm unpublish --force @dbzz/<pkg>@X.Y.Z --registry http://127.0.0.1:4873` (do it for all 5, then delete the tag).

Release plumbing lives in `scripts/` (`bump.ts`, `merge-guard.ts`, `publish-local.ts`, shared `lib.ts`), hooks in `.githooks/`, registry config in `registry/config.yaml`, scope routing in the repo-root `.npmrc`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`pedrobzz/dbzz`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each mapped to its own label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/domain-modeling`). See `docs/agents/domain.md`.
