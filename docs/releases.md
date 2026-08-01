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

The protected checks are `Release policy`, `Fast CI`, and `AckerDB benchmark`.
They are bound to the pull request's current commit, so an old result cannot
authorize a changed branch.

## Fast CI

Pull requests into `canary`, and urgent pull requests into `main`, run:

- the release and branch-policy check;
- package tests for directly affected packages and their AckerDB dependents,
  in parallel;
- the repository TypeScript checks;
- package, MCP, and workflow boundary checks only when their inputs changed;
  and
- the native matrix only when the WebRTC Rust source, native build/evidence
  contract, native tests, or native workflow changed.

Lockstep version-only edits to native `package.json` files do not compile Rust.
Native jobs cache Cargo dependencies, compiled targets, and evidence tools.

A `canary` → `main` pull request runs only the release-policy check. The other
two required check names complete as successful no-ops. The commit was already
tested and benchmarked before it entered `canary`; repeating that work would
measure a different time and waste the release path. A merge into `main` runs
only npm delivery.

## AckerDB benchmark check

The required benchmark compares the pull request's AckerDB with the base
branch's AckerDB. It does not run Convex, SpacetimeDB, or another vendor.

The same harness and workload measure both commits on the dedicated Hetzner
runner. Execution order alternates deterministically to reduce systematic
cold-host bias. The eight-minute job records latency, throughput, connection
scale, subscription capacity, CPU, RAM, startup, and harness correctness or
accounting observations.

Telemetry is disabled for both commits unless telemetry-related source changed.
When it did, both commits run the enabled, in-process-exporter, and disabled
profiles. Unchanged telemetry is never remeasured.

GitHub stores the base sample, head sample, and rendered comparison as a
pull-request artifact and step summary. The check proves only that the paired
measurement completed for the current commit. It contains no regression
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
workflow requests an OpenID Connect token; no long-lived npm token remains
after bootstrap.

## One-time public npm bootstrap

The `@ackerdb` npm organization and the first package versions must exist before
npm can attach trusted-publisher policies. Pedro performs these account-bound
steps once:

1. Sign in to npm, enable two-factor authentication, and create or confirm the
   `ackerdb` organization. The package scope must be `@ackerdb`.
2. Create a short-lived granular npm token that can publish public packages in
   that organization. Store it temporarily as the `NPM_TOKEN` secret in the
   repository's `npm` environment.
3. Merge the first ready pull request into `canary`. Its delivery bootstraps all
   twelve public packages.
4. With npm CLI 11.15 or newer and an authenticated npm session, configure the
   trusted publisher for every package:

   ```sh
   for package in core server realtime-darwin-arm64 realtime-darwin-x64 \
     realtime-linux-arm64-gnu realtime-linux-x64-gnu realtime-win32-x64-msvc \
     realtime cache client client-react cli; do
     npm trust github "@ackerdb/$package" \
       --file release.yml \
       --repo pedrobzz/AckerDB \
       --env npm \
       --allow-publish \
       --yes
   done
   ```

5. Delete the bootstrap secret:

   ```sh
   gh secret delete NPM_TOKEN --env npm --repo pedrobzz/AckerDB
   ```

Subsequent canary and stable releases authenticate only through GitHub OIDC.

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
