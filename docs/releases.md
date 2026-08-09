# Releases and protected branches

This document is the authoritative AckerDB branch, CI, benchmark, and package
publication policy. GitHub enforces the policy; local hooks are only reminders.

## Branch topology

`main` and `canary` are protected release branches. Direct pushes, force pushes,
branch deletion, and administrator bypass are disabled. GitHub accepts merge
commits only.

The only supported paths are:

```text
topic branch ──pull request──> canary ──pull request──> main
hotfix/*     ──urgent pull request───────────────────> main
```

- Normal pull requests target `canary` only.
- `main` accepts `canary` only.
- An urgent exception must still be a pull request. Its branch must be named
  `hotfix/*`, Pedro must be the pull-request author, and the pull request must
  carry the `release:urgent` label.
- A pull request into `canary` may keep the target's current source version;
  every merge still publishes a distinct `X.Y.Z-canary.N`. Declare a version
  step only when the work releases a new source version: run
  `bun run release:prepare <level>` after the branch is based on the current
  target. The command updates all thirteen package manifests, their exact
  workspace interdependencies, the generated native loader, and `bun.lock`,
  then creates the release-intent commit.
- A `hotfix/*` pull request into `main` always declares exactly one `major`,
  `minor`, or `patch` step.
- `canary` may accumulate several declared releases before promotion. A
  `canary` → `main` pull request therefore requires a newer version, not an
  artificial one-step bump from `main`.

The protected checks are `Release policy`, `Fast CI`, and `Benchmark`. They are bound to the
pull request's current commit, so an old result cannot authorize a changed
branch. `Release policy` runs in its own workflow so that label changes
re-evaluate the policy alone instead of restarting the whole pipeline.

Pedro is the repository's only collaborator. GitHub requires Pedro's approval
before running workflows from every external contributor's fork, including
contributors whose earlier work was merged. Outside users may propose pull
requests, but they cannot spend CI or merge into a protected release branch
without Pedro's approval.

## Fast CI

Pull requests into `canary`, and urgent pull requests into `main`, run:

- the release and branch-policy check;
- package tests for directly affected packages and their AckerDB dependents;
- the repository TypeScript checks, skipped when only documentation changed;
- package, MCP, and workflow boundary checks only when their inputs changed;
- the native matrix only when the WebRTC Rust source, native build/evidence
  contract, native tests, or native workflow changed.

The benchmark is not part of `Fast CI`. It is its own required check on every
pull request — see [Benchmark job](#benchmark-job).

Ordinary work is consolidated into `Select affected work` and one `Fast CI`
job. This avoids paying a full runner minute for each short package or boundary
check. The native multi-platform matrix remains separate because the five host
targets require different operating systems, and it stays path-gated.

Lockstep version-only edits to native `package.json` files do not compile Rust.
Native jobs cache Cargo dependencies, compiled targets, and evidence tools.
Every job carries a hard timeout so a hung process can never hold a runner for
hours.

A `canary` → `main` pull request runs the release-policy check and the
benchmark, where the comparison is the whole release delta; `Fast CI` completes
as a successful no-op, because the commit was already tested before it entered
`canary` and repeating that work would waste the release path. A merge into
`main` runs only npm delivery.

## Benchmark job

**The benchmark gates every pull request that touches a measured input.** It
runs on the way into `canary` and again on the `canary` → `main` promotion,
with the same harness and the same decision rule. A regression is then
attributable to one pull request first and to the release second.

It used to run on the promotion only. That made `Benchmark ✅` on a pull request
into `canary` a two-second no-op, and a branch that cost most of the
framework's query throughput reached a clean review with that green tick beside
it. Measuring the release delta does see what twenty merges did together — and
it sees it at the one moment when bisecting it costs the whole cycle.

`Benchmark` is a required check on `canary` and on `main`, alongside
`Release policy` and `Fast CI`. Like `Fast CI` it reports a conclusion even
when it has nothing to measure, because a required check that stays pending
blocks forever.

A benchmark-exercised input is one of:

- production source under `packages/core/src`, `packages/client/src`, or
  `packages/server/src`;
- the CLI codegen, configuration, or manifest code used to launch the benchmark
  application;
- executable files under `bench/`, excluding Markdown and historical results;
- a third-party dependency of `core`, `client`, `server`, or `cli`, which
  changes the executable product without touching a source path — the lockstep
  `@ackerdb/*` rewrite every release step performs is excluded, because a
  version bump that ships the same code must not spend a runner; or
- the pull-request workflow or its path classifier.

All other changes—including docs, tests, release metadata/version bumps,
`cache`, `client-react`, the WebRTC media package, and native Rust—skip the
benchmark immediately. Those paths either cannot affect the measured workload or
have their own relevant checks. A real run compares the pull request's AckerDB
with the base branch's AckerDB. It does not run Convex, SpacetimeDB, or another
vendor.

### How the comparison is made

Both commits are live at the same time — a server and a load generator each —
and the driver alternates between them one unit of work at a time. A unit is the
smallest slice either side can perform in a few hundred milliseconds: one
operation profile, one connection level, one subscription pattern. Only one side
is ever under load; the other's server sits idle, which the harness separately
measures as costing near-nothing.

Interleaving is the whole point. Running base's entire pass and then head's
charges every minute of drift — a CPU ramp, a noisy neighbour, a page cache that
filled — to whichever side ran second, and an execution-order coin flip only
decides which side gets charged rather than whether anyone does. Which side
*leads* alternates on every repetition, so even that residue cancels within one
run instead of across reruns nobody performs.

This is the published method, not a house rule. It is called **duet
benchmarking** — [Bulej, Horký, Tůma, Farquet and Prokopec, ICPE
'20](https://dl.acm.org/doi/10.1145/3358960.3379132) — and was measured there at
2.3x to 12.5x better accuracy than sequential runs on ScalaBench and DaCapo, and
23.8x to 82.4x on SPEC CPU 2017. Chromium's Pinpoint bisects by running both
revisions on the same device for the same reason. AckerDB's harness arrived at it
independently from its own noise measurements; the citation is here because a
reader deciding whether to trust the comparison should know it is the standard
answer.

Each unit is repeated sixteen times, and the repetitions of a unit are spread
across the whole run rather than clustered, so a disturbance confined to one
stretch of wall clock cannot land on every repetition of the same unit.

### How a verdict is reached

Every metric arrives as sixteen base/head pairs measured seconds apart. The
comparison is the median of the paired ratios, taken in log space so a halving
and a doubling are the same distance from neutral, with a distribution-free
interval around that median built from the sixteen repetitions themselves. That
interval is the noise band, and it is measured from the metric's own scatter in
that very run rather than carried in from a constant. The rule's shape is
`criterion.rs`'s — a nonparametric significance test plus a noise threshold,
reporting "no change" when either fails — and Go's `benchstat` is the same rule
without the threshold.

A metric is reported as a regression only when both hold:

1. the interval keeps the whole median on the worse side of neutral; and
2. the median clears a twelve-percent floor.

The first condition rejects scatter. The second rejects movements too small to
spend a merge on, and is the one number in the gate that is a decision rather
than a measurement — deliberately not its main defence.

Null runs say why. Comparing `canary` against itself, where every true delta is
zero, the median absolute paired delta across ninety-one metrics was one to two
percent and the p90 six to seven; but the widest single metric reached fifteen
percent in one run and twenty-nine in another. A floor alone would have fired on
both. What rejected them was the interval: their repetitions did not agree on a
direction. Across those hundred and eighty-two null verdicts — taken at eight
repetitions, before the count moved — exactly one metric satisfied both
conditions, and it was a `p99`, which is exactly why `p99` is reported and never
gated. No null run has ever failed. The same harness on the telemetry-sidecar
branch reported fifty-five gated regressions, the largest an eighty-seven percent
loss of query throughput whose interval ran from minus ninety-two to minus
eighty-three percent.

**"No signal" is an answer, not a failure to produce one.** A gate that always
emits a number teaches everyone to re-run until the number is agreeable; one
that can say the run could not tell the two commits apart is worth more than one
that guesses.

### Why sixteen repetitions

`benchstat` asks for "at least 10, ideally 20" samples per side. The harness took
eight, and the shortfall had a mechanism rather than a cost: `medianIntervalRank`
returns the deepest pair of order statistics whose two-sided sign test fits
alpha, and at eight pairs that is rank 1 — the extreme pair. Every repetition had
to agree on the direction before any metric could be called. That unanimity was
never chosen; it was simply what eight repetitions could afford. It is also a
condition a **bimodal** metric can satisfy by luck, where a merely noisy one
cannot, so the metrics it lets through are not the ones anybody would pick.

At sixteen the same alpha buys rank 4: up to three repetitions may dissent.
Nothing else moved — alpha is still 0.05, the floor is still twelve percent, and
the same metrics gate.

Measured on one null run's own recorded noise (72 gated series with a complete
set of pairs, `disabled` profile, 18 vCPU), by relabelling which side is base
within each repetition — a valid permutation under the null — over 20 000 draws,
and by injecting a known uniform effect into that same noise over 2 000 draws:

| | 8 repetitions | 16 repetitions |
| --- | ---: | ---: |
| False failure, per run | 1.1% | 1.1% |
| Detects a 10% regression | 15% | 18% |
| Detects a 15% regression | 71% | **96%** |
| Detects a 20% regression | 81% | **99%** |
| Detects a 25% regression | 89% | 100% |
| Detects a 50% regression | 94% | 100% |
| Wall clock, one profile | 131s | 246s |

**The false-failure rate did not move.** A deeper rank on its own would raise it;
it is paid for by a median that sixteen repetitions pin down better than eight,
and the twelve-percent floor rejects what is left. Ten, twelve and fourteen were
measured on the same noise: twelve is the worst of all of them at 2.5% false
failures, because rank 3 on twelve pairs covers only 96.1% where rank 4 on
sixteen covers 97.9%. Fourteen matches sixteen on false failures and loses three
points of detection at 15%. Sixteen is the best number the data offers and it is
also the one the field asks for.

Wall clock is 1.9x, not 2x, because the base worktree, the install, both
servers' startup, the seed, and the one-time idle plateaus are paid once.

### What it can and cannot see

The check is a detector for large regressions, not an acceptance test. It is
blind below roughly ten percent, which is what the reviewer's reading of the full
vector is still for. Loosening the interval further — tolerating dissent beyond
the rank alpha pays for — is the one direction that does move the false-failure
rate, and at eight repetitions it was measured at 18.8% of runs: one run in five
failing on identical code is the fastest way to teach everyone to press rerun.
`BENCH_REPETITIONS` remains the knob, and every ledger row records the count the
run used, so a comparison taken at a different one is visible rather than
implied.

### The ledger

The gate used to have no memory. It computed a median paired ratio, an interval,
and a verdict for every metric on every run, printed them into a step summary,
uploaded them as an artifact that expires in thirty days, and never read any of
it again — so answering any question about its own noise, including "is this
metric fit to gate?", meant running a campaign on purpose to collect a null
distribution that its ordinary work had already thrown away.

Every comparable system consumes its history instead. rustc-perf fences each
benchmark against its own historical distribution of relative changes; Mozilla's
Perfherder runs a t-test over roughly a dozen preceding revisions with per-test
thresholds; Bencher stores each metric and derives an IQR, z-score, or t-test
from what it stored; MongoDB and Otava run change point detection over the
series. Their history *is* a null distribution, collected free, because most
pull requests do not move most benchmarks.

**Every run's paired deltas are now appended to the `bench-ledger` branch**, one
row per metric: the run, the base and head commits, the profile, the unit, the
metric, whether it gated, the median paired ratio, the interval, the signal, the
repetition count, and the host. `bench/report.ts` writes the rows as part of
deciding, so what the ledger remembers is literally what the check decided.

**Ratios only, never absolute numbers.** Absolute throughput on an ephemeral
GitHub runner is not comparable from one run to the next, which is why rustc-perf
and Perfherder both need dedicated stable hardware before their history means
anything. A paired interleaved ratio is machine-independent by construction —
both sides met the same machine in the same second — so a history that spans
runners is worth keeping here where an absolute one would not be.

It is a data branch rather than a committed file because a committed ledger would
make every benchmark run a merge conflict on every open branch. `bench-ledger` is
an orphan: it shares no file with `main` or `canary`, is never merged into
either, and is written only by `.github/workflows/bench-ledger.yml`. Rows are
partitioned one file per month, because git stores a whole file per commit and a
single ever-growing ledger would cost the square of its own length.

That workflow is triggered by `workflow_run`, not by `pull_request`, and the
distinction is the security model. A `pull_request` job holds a read-only token
and runs code the pull request wrote, so it can neither push nor be trusted to;
a `workflow_run` job runs the **default branch's** copy of the workflow with
write access, which puts the appender out of a pull request's reach. It therefore
starts recording only once this workflow has reached `main`. There is
deliberately no concurrency group: GitHub cancels a previously pending run in a
group, and a cancelled append is a lost run. Two runs finishing together race on
the push instead, and the loser re-folds against the winner's state and pushes
again, which is safe because folding a run in is order-independent and keyed by
run id.

**Nothing reads it.** No threshold, floor, or gated-metric set consults it, and
this change moves none of them. Once twenty or thirty runs exist, "would this
metric have gated on unchanged code?" becomes one query over every metric at
once, continuously refreshed by work that was happening anyway. The rustc-perf
upgrade — a learned per-metric fence replacing the global twelve-percent floor —
and change point detection both become available then, and neither is built now.
Change point detection in particular wants a stationary series, which would mean
measuring each `canary` merge against a fixed reference commit rather than a
moving base; that is a separate decision.

### What it cannot defend against

A pull request supplies the harness that judges it — the workload, the metric
policy, the floor, the report, and the classifier that decides whether the
benchmark runs at all. Running the judge from the base commit does not close
this either, because the workflow itself comes from the head. The gate's answer
is branch protection and review: `bench/**`, `scripts/ci/**`, and
`.github/workflows/**` are Pedro's to approve. What the harness does do is print
the rule it applied — interval confidence, floor, and every ungated metric — into
the step summary beside the verdict, so the gate can be weakened but not
quietly.

The ledger inherits that residual and nothing worse. Its rows are produced by the
pull request's own harness, so a commit that lies to the gate lies to the ledger
in the same breath — which is why every row carries the commit that produced it
and the repetition count it used. What the appender does not accept is anything
structural: it runs from the default branch, validates every field of every row,
refuses a file whose rows name a commit other than the one the run measured,
refuses a run that files more rows than the workload can produce, and stamps the
workflow run and the clock itself rather than believing the ones in the file.

Two things are deliberately reported and never gated. `p99` is the noisiest
statistic in the set — one scheduling stall in a few thousand operations moves
it — and connect-readiness `p95` carries a scheduling tail that belongs to the
host. Idle RSS and CPU are sampled once per side, as context beside the table
rather than through it.

Correctness and accounting failures fail the check outright. They are not
converted into a performance verdict; they are reasons the numbers should not be
believed.

A green `Benchmark` proves that this comparison found no regression large enough
and consistent enough to stop the merge. It is not an approval of the whole
performance vector. GitHub stores both sides' samples, the paired series, and
the rendered comparison as a pull-request artifact and step summary for thirty
days, and the paired deltas on the `bench-ledger` branch for good; Pedro and an
agent still read the table and capture that judgment before merge.

Telemetry is disabled for both commits unless telemetry-related source changed.
When it did, both commits additionally run the runtime-default and
in-process-exporter profiles. This is not caution: the sidecar rework that cost
eighty-six percent of query throughput moved nothing measurable with telemetry
off, so those profiles are the only place that class of regression is visible.

The committed files under `bench/results/` are historical records from the
superseded vendor-comparison policy. They are not current merge or release
evidence, and they are not the ledger; the ledger lives on `bench-ledger` and
holds ratios, not absolute numbers.

## Public npm delivery

All thirteen packages move in lockstep:

- eight user-facing packages: `@ackerdb/core`, `server`, `realtime`, `cache`,
  `client`, `client-react`, `cli`, and `studio`;
- five host-filtered `@ackerdb/realtime-*` native packages.

Every merge into `canary` prepares the current source version as
`X.Y.Z-canary.N` for npm's `canary` dist-tag. `N` is the immutable GitHub
workflow run number. Delivery starts automatically from the protected merge
commit; merging the pull request is the release authorization.

Every merge into `main` prepares `X.Y.Z` for npm's `latest` dist-tag. Before a
normal promotion can merge, GitHub verifies that every package already has a
public canary for that source version. An urgent `hotfix/*` pull request is the
only stable-first path. Stable delivery additionally waits in the
`npm-stable-approval` environment for Pedro's approval.

The delivery workflow packs and publishes in dependency order. An existing
public package version is skipped only when its tarball is byte-identical; a
different existing tarball is a hard collision. Public delivery never reads
from Verdaccio. Release tags are optional manual bookkeeping and are not
created by a write-capable CI job.

### The Studio build stage

`@ackerdb/studio` is the only package that publishes a built artifact: its
`dist/` bundle is git-ignored and produced at release time. Every other package
ships TypeScript source, so packing has never needed a build.

It is an explicit, ordered stage in `release.yml` — `bun
scripts/release/studio-dist.ts`, between the frozen install and `publish.ts` —
and never a `prepack` or `prepublishOnly` hook. The pipeline disables lifecycle
scripts in three places on purpose (`bunfig.toml`'s `ignoreScripts`, the
install's `--ignore-scripts`, and `bun pm pack --ignore-scripts`), so a hook
would not fire, and re-enabling one for a single package would trade away the
supply-chain posture those flags exist to hold.

**The stage proves the bundle packs reproducibly, not merely that it builds.**
It builds and packs twice and compares tarball digests, because byte-identity is
what decides whether an existing version is skipped or collides: a bundle that
changed for no reason would make a resumed or re-dispatched publication
unrecoverable. The publisher runs the same check again, after the manifests
carry the version being released, so the compared tarballs are the artifact that
run will actually send rather than a same-shaped stand-in; the workflow stage is
what fails first, before any manifest has moved. The packed-package gate builds
the bundle the same way and then asserts that `dist/index.html` shipped and that
every asset it references shipped beside it.

The workflow's manual dispatch exists only to bootstrap or resume delivery from
the current protected `canary` or `main` commit. It crosses the same environment,
OIDC, clean-merge, branch, and byte-identity checks as a push-triggered delivery;
stable dispatches also require stable approval. It is not a separate release
path and cannot publish a topic branch.

Native Rust builds remain conditional. When native source changed, delivery
downloads the five artifacts produced by that pull request. When native source
did not change, it reuses a previously published five-target artifact set only
when every manifest has the exact current native-source digest. There is no
unverified local or single-host substitute.

Publication uses npm trusted publishing from `.github/workflows/release.yml`,
the `pedrobzz/AckerDB` repository, and the protected-branch-only `npm` GitHub
environment. The workflow requests an OpenID Connect token and receives no npm
credential or secret. It restores no release cache and installs with lifecycle
scripts disabled. The npm account has no access tokens. Canary publication is
automatic after merge; stable publication requires the separate approval above.

Every published package record exists with that same trusted publisher; a
newly added package gains its record on its first protected publication.
`0.13.2-canary.0` is the historical bootstrap release; there is no supported
local public-publishing command. The local bootstrap session was removed, CI
has no npm token or secret, and every future public release comes from the
protected workflow. npm requires each package record to retain a `latest` tag,
so it temporarily points at the bootstrap canary until the first protected
`main` publication moves it to the stable version.

## Local Verdaccio betas

Verdaccio at `http://127.0.0.1:4874` is only for local test builds. It never
receives a stable, alpha, or canary package. A prepared source version may have
as many betas as needed: `X.Y.Z-beta.1`, `X.Y.Z-beta.2`, and so on, all under
the `beta` dist-tag.

One-time local setup:

```sh
bun run registry
bunx npm adduser --registry http://127.0.0.1:4874
```

Keep the registry running in its existing terminal. When a branch becomes
testable:

```sh
bun run publish:beta       # publish the next local beta
bun run publish:beta:demo  # publish it, repin matching demo packages, reinstall
```

The publisher accepts a dirty topic branch, assembles the exact thirteen-package
set, chooses the next registry-backed beta number, and restores every release
manifest and generated native evidence byte-for-byte even after a failed
publication. It can reuse a matching native artifact set from Verdaccio or
public npm; it never compiles five Rust targets locally.

The demo's `.npmrc` intentionally points `@ackerdb` to Verdaccio. Ordinary
consumers use public npm and should install exact versions. Never install a
host-specific `@ackerdb/realtime-*` package directly; package-manager platform
selection owns it through `@ackerdb/realtime` optional dependencies.

Release tooling lives in `scripts/release/`, pull-request policy in
`scripts/ci/`, workflows in `.github/workflows/`, and the local registry in
`registry/`.
