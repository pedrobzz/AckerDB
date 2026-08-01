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
- A topic or hotfix branch declares exactly one `major`, `minor`, or `patch`
  step from its target branch. Run `bun run release:prepare <level>` after the
  branch is based on the current target. The command updates all twelve package
  manifests, their exact workspace interdependencies, the generated native
  loader, and `bun.lock`, then creates the release-intent commit.
- `canary` may accumulate several declared releases before promotion. A
  `canary` → `main` pull request therefore requires a newer version, not an
  artificial one-step bump from `main`.

The protected checks are `Release policy` and `Fast CI`. They are bound to the
pull request's current commit, so an old result cannot authorize a changed
branch. `Release policy` runs in its own workflow so that label changes
re-evaluate the policy alone instead of restarting the whole pipeline.

## Fast CI

Pull requests into `canary`, and urgent pull requests into `main`, run:

- the release and branch-policy check;
- package tests for directly affected packages and their AckerDB dependents,
  in parallel;
- the repository TypeScript checks, skipped when only documentation changed;
- package, MCP, and workflow boundary checks only when their inputs changed;
- the native matrix only when the WebRTC Rust source, native build/evidence
  contract, native tests, or native workflow changed; and
- the paired Hetzner benchmark only when a benchmark-exercised input changed.

Lockstep version-only edits to native `package.json` files do not compile Rust.
Native jobs cache Cargo dependencies, compiled targets, and evidence tools.
Every job carries a hard timeout so a hung process can never hold a runner for
hours.

A `canary` → `main` pull request runs only the release-policy check; `Fast CI`
completes as a successful no-op. The commit was already tested before it
entered `canary`, and any performance-relevant change was benchmarked there;
repeating that work would waste the release path. A merge into `main` runs
only npm delivery.

## Benchmark job

`Fast CI` runs its benchmark job only when the pull request changes an input
that the measured AckerDB workload can exercise:

- production source under `packages/core/src`, `packages/client/src`, or
  `packages/server/src`;
- the CLI codegen, configuration, or manifest code used to launch the benchmark
  application;
- executable files under `bench/`, excluding Markdown and historical results;
  or
- the pull-request workflow or its path classifier.

All other changes—including docs, tests, release metadata/version bumps,
`cache`, `client-react`, the WebRTC media package, and native Rust—skip the
benchmark immediately. Those paths either cannot affect the measured
workload or have their own relevant checks. A real run compares the pull
request's AckerDB with the base branch's AckerDB. It does not run Convex,
SpacetimeDB, or another vendor.

The same harness and workload measure both commits on the dedicated Hetzner
runner. Execution order alternates deterministically to reduce systematic
cold-host bias. The eight-minute job records latency, throughput, connection
scale, subscription capacity, CPU, RAM, startup, and harness correctness or
accounting observations.

Telemetry is disabled for both commits unless telemetry-related source changed.
When it did, both commits run the enabled, in-process-exporter, and disabled
profiles. Unchanged telemetry is never remeasured.

When it runs, GitHub stores the base sample, head sample, and rendered comparison
as a pull-request artifact and step summary. A green benchmark job proves only
that the paired measurement completed for the current commit. It contains no regression
threshold, score, acceptance status, or automated performance verdict. Pedro
and an agent review the full vector and recorded anomalies, reason about whether
the result is good enough for the useful work, and capture that judgment in the
pull request before merge.

The committed files under `bench/results/` are historical records from the
superseded vendor-comparison policy. They are not current merge or release
evidence.

## Public npm delivery

All twelve packages move in lockstep:

- seven user-facing packages: `@ackerdb/core`, `server`, `realtime`, `cache`,
  `client`, `client-react`, and `cli`;
- five host-filtered `@ackerdb/realtime-*` native packages.

Every merge into `canary` publishes the current source version as
`X.Y.Z-canary.N` under npm's `canary` dist-tag. `N` is the immutable GitHub
workflow run number, so rerunning an interrupted delivery resumes the exact
same version.

Every merge into `main` publishes `X.Y.Z` under npm's `latest` dist-tag. Before
a normal promotion can merge, GitHub verifies that every package already has a
public canary for that source version. An urgent `hotfix/*` pull request is the
only stable-first path.

The delivery workflow packs and publishes in dependency order. An existing
package version is skipped only when its public tarball is byte-identical; a
different existing tarball is a hard collision. Successful releases receive a
matching git tag (`vX.Y.Z-canary.N` or `vX.Y.Z`). Public delivery never reads
from Verdaccio.

Native Rust builds remain conditional. When native source changed, delivery
downloads the five artifacts produced by that pull request. When native source
did not change, it reuses a previously published five-target artifact set only
when every manifest has the exact current native-source digest. There is no
unverified local or single-host substitute.

Publication uses npm trusted publishing from `.github/workflows/release.yml`,
the `pedrobzz/AckerDB` repository, and the `npm` GitHub environment. The
workflow requests an OpenID Connect token and receives no npm credential or
secret. Public CI publication never falls back to token authentication.

All twelve package records now exist with that same trusted publisher.
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

The publisher accepts a dirty topic branch, assembles the exact twelve-package
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
