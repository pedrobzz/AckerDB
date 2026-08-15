# Releases and protected branches

This document is the authoritative AckerDB branch, CI, and package publication
policy. GitHub enforces the policy; local hooks are only reminders.

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
  target. The command updates all eleven package manifests, their exact
  workspace interdependencies, the generated native loader, and `bun.lock`,
  then creates the release-intent commit.
- A `hotfix/*` pull request into `main` always declares exactly one `major`,
  `minor`, or `patch` step.
- `canary` may accumulate several declared releases before promotion. A
  `canary` → `main` pull request therefore requires a newer version, not an
  artificial one-step bump from `main`.

The protected checks are `Release policy` and `Fast CI`. They are bound to the
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
  contract, distribution/evidence tests, or native workflow changed;
- runtime-only WebRTC test changes reuse verified published binaries in one
  macOS job and do not compile Rust.

Ordinary work is consolidated into `Select affected work` and one `Fast CI`
job. This avoids paying a full runner minute for each short package or boundary
check. The native multi-platform matrix remains separate because the five host
targets require different operating systems, and it stays path-gated.

Lockstep version-only edits to native `package.json` files do not compile Rust.
Native jobs cache Cargo dependencies, compiled targets, and evidence tools.
Every job carries a hard timeout so a hung process can never hold a runner for
hours.

A `canary` → `main` pull request runs the release-policy check; `Fast CI`
completes as a successful no-op because the commit was already tested before it
entered `canary`, and repeating that work would waste the release path. A merge
into `main` runs only npm delivery.

## Public npm delivery

All eleven packages move in lockstep:

- six user-facing packages: `@ackerdb/core`, `server`, `realtime`, `client`,
  `client-react`, and `cli`;
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

## The version is the compatibility contract

**The AckerDB version is the compatibility contract, and there is no separate
number on the wire.** Packages ship lockstep with `workspace:X.Y.Z` precisely
because version X is contracted to speak to version X, so a connection's
handshake declares the build that opened it and the decoder accepts exactly its
own — `ACKERDB_VERSION` in `@ackerdb/core`, read from that package's manifest so
one fact answers on a server and inside a bundled browser client alike. Running
mixed versions is the user's error to make and the framework's job to name; the
refusal says which two versions met and that matching ones must be installed,
never which mixes might be legal.

Changing the wire therefore costs nothing and needs no permission. Do not add a
field to avoid reshaping one, do not preserve an old frame shape, and do not
reintroduce a protocol number to describe a compatibility this contract does
not offer.

**A frame carries the version exactly when it can be decoded on a connection
that has not completed a handshake.** That is `hello`, `welcome`, `err`, and
every frame of the transports that have no handshake at all — SSE and realtime
signaling are HTTP, where the first frame is the greeting. Everything after a
handshake carries none: the peer's build was established once and no connection
changes builds under itself, so repeating it spends the hottest field in the
system for a fact already known.

`err` is a member of that set and not an exception to it. A client admits a
connection-level `err` before its `welcome` on purpose, because that is how a
server delivers a refusal it will not open a session for — and a
version-refusing server's refusal *is* an `err`. Leaving it unversioned would
make the one frame that explains a mixed install the one frame nobody could
check.

The rule is enforced by the parse surfaces, not by this document. Each
direction has a handshake parser that accepts only what is admissible before a
session and reads the version on every one of them, and a session parser for
everything after; a frame's base interface decides whether it even has a `v` to
set. Admitting a new frame before the handshake therefore means adding a case
to a parser that checks the version, and forgetting means the frame is refused
rather than silently trusted.

The exposed HTTP surface is the deliberate exception and not a gap: its request
and response bodies are the application's own arguments and results, published
in its OpenAPI document for callers who are not AckerDB builds at all, so it has
no framework envelope to version and must not grow one. Its compatibility
contract belongs to the application.

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

The publisher accepts a dirty topic branch, assembles the exact eleven-package
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
