Before researching external knowledge or working with a third-party package, always read the [LLM Wiki Skill](.agents/skills/llm-wiki/SKILL.md) and the relevant existing wiki pages. The LLM Wiki is read for those tasks; write to `raw/` or `wiki/` only when the user explicitly asks to ingest, archive, or lint it. It records external knowledge and third-party packages, not AckerDB decisions or domain modeling.

## Performance, correctness, and code quality

Standing rules for every change. Terms are defined in `CONTEXT.md`
(Engineering philosophy)—use those names; do not redefine them here.

### Organize every touched neighborhood

Whenever you create or modify a file, inspect its sibling directory
before finishing. If the touched file or its siblings mix unrelated ownership
or remain flattened without an obvious module home, organize that neighborhood
into cohesive domain folders in the same change. A change is not complete while
the neighborhood it touched is still disorganized.

Folders must represent real module ownership. Do not create one-file wrapper
folders, barrel-only indirection, or pass-through files merely to make a tree
look nested. Keep package entrypoints explicit and place implementation files
beside the behavior, invariants, and tests they belong to.

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

External systems may inform architecture research, but the repository benchmark
does not run them. Its only comparison is AckerDB at the pull request's base and
head commits under the same workload and on the same machine.

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

Correctness is broader than “the happy-path test passed.” Correct AckerDB code:

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
current OpenSRC snapshots and primary sources. When the user explicitly asks to
capture the research, put external source material and compiled findings in the
LLM Wiki (`raw/` and `wiki/`); put AckerDB terminology and settled domain
boundaries in `CONTEXT.md`; put material AckerDB tradeoffs in the decision ledger.
Revisit all three when later evidence changes a decision.

Verify at the boundary that previously failed; prove the old failure path is
gone rather than masked.

Before accepting a performance/correctness change, answer:

1. What useful work became faster or safer, under which load shape?
2. What RAM, CPU, queue, network, and storage ownership did it add or remove?
3. What happens at saturation, crash, timeout, disconnect, restart, and
   schema change?
4. Does it preserve data and make ambiguity explicit?
5. Does it remove a model problem or create another branch around it?
6. Which OpenSRC/primary-source decision or AckerDB ledger entry supports it?
7. What boundary test and, when relevant, benchmark prove the claim?

# Release branches, benchmarks, and publishing

[Releases and protected branches](docs/releases.md) is the authoritative
procedure. Do not recreate an alternate release path in another document or
script.

GitHub protects both `canary` and `main`. Normal pull requests target
`canary`; only `canary` targets `main`. The sole exception is a
Pedro-authored `hotfix/*` pull request to `main` carrying
`release:urgent`. There are no direct-push, force-push, local-merge, or
administrator-bypass release paths.

A `canary` pull request may keep the current source version — every merge
still publishes a distinct `X.Y.Z-canary.N` — and declares exactly one major,
minor, or patch step with `bun run release:prepare <level>` only when it
releases a new source version. A `hotfix/*` pull request into `main` always
declares exactly one step. All seven public packages and five host-specific
native packages stay on one stable source version with `workspace:X.Y.Z`
interdependencies. A `canary` promotion may contain several accumulated steps
and only needs to be newer than `main`.

The `Benchmark` check gates the release, not the road to it: it runs on the
`canary` → `main` promotion only, where it is required alongside `Release
policy` and `Fast CI`, and only when the release changed code exercised by the
benchmark, its executable harness, the pull-request workflow, or its path
classifier. Every pull request into `canary` skips it; version bumps, docs,
tests, and unrelated packages must not spend benchmark time. Measuring on the
promotion means the comparison is the whole release delta rather than one pull
request's slice — the only measurement that sees what the accumulated merges
did together. It never runs another vendor and never runs on
the developer machine. Telemetry is disabled unless telemetry-related source
changed; only then are enabled, exporter, and disabled profiles measured. The
check has no thresholds, score, or automated performance acceptance. Pedro and
an agent interpret the complete vector and anomalies by reasoning before merge.
Historical files in `bench/results/` are not current release evidence.

Every merge into `canary` prepares `X.Y.Z-canary.N` for npm's `canary` tag.
Every merge into `main` prepares `X.Y.Z` for `latest`. Public delivery is
GitHub-only and uses the protected-branch-only `npm` environment's trusted
publisher. Canary delivery starts automatically after merge; stable delivery
requires Pedro's approval before its publish job. A normal stable promotion
requires the same source version to exist publicly as a canary first.

Verdaccio at `http://127.0.0.1:4874` is exclusively for repeatable local
`X.Y.Z-beta.N` builds. Publish one whenever a prepared branch is testable with
`bun run publish:beta` or `bun run publish:beta:demo`. Never publish stable,
canary, or alpha versions to Verdaccio, and never publish beta or alpha
versions to public npm.

Fast CI runs affected package tests and their dependents in one consolidated
billed job, keeps repository typechecks fast, and builds the five Rust targets
only when actual WebRTC native inputs changed. A `canary` → `main` promotion repeats none of
that work; it runs branch policy before merge and npm delivery after merge.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`pedrobzz/ackerdb`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each mapped to its own label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/domain-modeling`). See `docs/agents/domain.md`.
