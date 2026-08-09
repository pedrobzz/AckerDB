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

Each unit is repeated eight times, and the repetitions of a unit are spread
across the whole run rather than clustered, so a disturbance confined to one
stretch of wall clock cannot land on every repetition of the same unit.

### How a verdict is reached

Every metric arrives as eight base/head pairs measured seconds apart. The
comparison is the median of the paired ratios, taken in log space so a halving
and a doubling are the same distance from neutral, with a distribution-free
interval around that median built from the eight repetitions themselves. That
interval is the noise band, and it is measured from the metric's own scatter in
that very run rather than carried in from a constant.

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
direction. Across those hundred and eighty-two null verdicts exactly one metric
satisfied both conditions, and it was a `p99` — which is exactly why `p99` is
reported and never gated. Neither null run failed. The same harness on the
telemetry-sidecar branch reported fifty-five gated regressions, the largest an
eighty-seven percent loss of query throughput whose interval ran from minus
ninety-two to minus eighty-three percent.

**"No signal" is an answer, not a failure to produce one.** A gate that always
emits a number teaches everyone to re-run until the number is agreeable; one
that can say the run could not tell the two commits apart is worth more than one
that guesses.

### What it can and cannot see

Injecting a known uniform effect into the harness's own recorded noise gives the
gate's power directly. Across two hundred and sixteen gated series:

| Regression | Detected |
| --- | ---: |
| 10% | 6% |
| 15% | 41% |
| 20% | 60% |
| 25% | 73% |
| 35% | 88% |
| 50% | 94% |

Relabelling which side is base within each repetition — a valid permutation
under the null — puts the false-failure rate at 3.6% of runs. Loosening the
interval to tolerate one sign-flipped repetition would raise detection at 20%
from 60% to 90%, and the false-failure rate from 3.6% to 18.8%: one run in five
failing on identical code is the fastest way to teach everyone to press rerun,
so the tighter interval stands. `BENCH_REPETITIONS` buys power at proportional
wall-clock cost and is the knob to turn when the runner budget allows.

The check is therefore a detector for large regressions, not an acceptance test.
It is blind below roughly ten percent and unreliable in the teens, which is what
the reviewer's reading of the full vector is still for.

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
the rendered comparison as a pull-request artifact and step summary; Pedro and
an agent still read the table and capture that judgment before merge.

Telemetry is disabled for both commits unless telemetry-related source changed.
When it did, both commits additionally run the runtime-default and
in-process-exporter profiles. This is not caution: the sidecar rework that cost
eighty-six percent of query throughput moved nothing measurable with telemetry
off, so those profiles are the only place that class of regression is visible.

The committed files under `bench/results/` are historical records from the
superseded vendor-comparison policy. They are not current merge or release
evidence.

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
