Before designing, implementing, changing, or refactoring any code, always read the `policy-and-commodity` skill and follow it. AckerDB adds to that doctrine in *Prefer less code and proven work* below; nothing here relaxes it.

Treat removed systems as absent. Analyze or reconstruct a former implementation from Git history or memory only when the user explicitly requests historical analysis.

## Standing rules for every change

Terms are defined in `CONTEXT.md` (Engineering philosophy)—use those names; do
not redefine them here.

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

### When a design wall appears

A mismatch with a specification, failed assumption, test, or integration is a
design signal—and so is a chosen dependency that cannot support the contract.
Do not patch around it to make the old statement appear true. Classify the wall
as commodity, policy, or the boundary between them, and follow the wall
protocol in the `policy-and-commodity` skill. Re-derive the model from first
principles until the conflicting case has one honest home. If that result
diverges from the requested specification, explain the divergence before
implementing it.

Never turn an invalid design into a “working” deliverable using an accidental
patch. The patch merely hides the failure and becomes future machinery.

When the only correct design is breaking, make the break explicit: state what
changes, why the replacement is simpler/safer/faster, and how consumers move.
Do not add backwards compatibility unless it was explicitly requested.

### Prefer less code and proven work

The most performant code is code that never runs. The least buggy code is code
that does not exist. Delete redundant operations and state before optimizing
them.

What follows adds to the `policy-and-commodity` skill and does not restate it.

AckerDB is infrastructure, and infrastructure has been studied for decades. Its
generic substrate—storage, transport, signaling, scheduling, retries, auth
protocols, serialization—is commodity, so adopting a proven implementation is
the default here rather than the fallback.

AckerDB's policy merges into one definition what is normally several systems: a
procedure is observed reactively, served over exposed HTTP, offered as an MCP
tool, and memoized as a durable step, under one authorization vocabulary, one
result contract, and one version contract. That convergence is policy and is
where AckerDB may invent. It says nothing about whether an ICE stack, a
full-text index, or a JWKS client should be written here.

Because that policy is unusual, a mature implementation often covers nearly
everything a converged surface needs while the missing part makes it unusable:
a capability that exists internally but is not exported, or a contract that
assumes the surfaces stay separate. A supervised fork or vendored copy is the
expected answer there, between composing proven solutions and building new
commodity. The realtime native packages already carry a pinned libwebrtc fork
on a recorded LiveKit revision — that one is a real fork, and it is owned as one
(`packages/realtime-native/*/PROVENANCE.md`).

A fork is ownership, not a shortcut: pin an immutable revision, record the
upstream revision it came from, verify inputs by digest, publish its provenance
where the artifact ships, and refresh deliberately when the studied version
changes. Do not keep a dependency merely because it currently works—if its
design adds material cost, incorrectness, or unused machinery, study it in
OpenSRC and its primary sources first.

### Evidence and verification

Most mature systems problems already have prior art. Before inventing, inspect
current OpenSRC snapshots and primary sources. Put AckerDB terminology and
settled domain boundaries in `CONTEXT.md`; put material AckerDB tradeoffs in the
decision ledger. Revisit both when later evidence changes a decision.

Verify at the boundary that previously failed; prove the old failure path is
gone rather than masked.

# Release branches and publishing

[Releases and protected branches](docs/releases.md) is the authoritative
procedure for branch topology, version steps, Fast CI, npm delivery, Verdaccio
betas, and the version compatibility contract on the wire. Do not recreate an
alternate release path in another document or script. The short form: topic
branches open pull requests into `canary`, only `canary` promotes to `main`,
`bun run release:prepare <level>` runs only when a pull request releases a new
source version, and Verdaccio (`http://127.0.0.1:4874`) receives only local
`X.Y.Z-beta.N` builds.

## Agent skills

### Policy and commodity

The `policy-and-commodity` skill, read before every implementation without
exception. AckerDB's additions to it are in *Prefer less code and proven work*
above; the vocabulary is in `CONTEXT.md`.

### Issue tracker

Issues live in this repo's GitHub Issues (`pedrobzz/AckerDB`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each mapped to its own label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/domain-modeling`). See `docs/agents/domain.md`.
