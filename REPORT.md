# T7 — Hygiene: rotted consumers, docs, CI, dead weight

Branch `audit/t7-hygiene`, based on `origin/main` at `57c64cd`. Five commits.

Headline: every work item is done and verified, **except** the `uuid` override in
item 7, which is **refuted** — it is load-bearing, not unused. Two handoff claims
turned out to be wrong on inspection (that one, and the extent of the dead
`binding.ts` block), and closing the typecheck hole exposed a real API defect in a
script CI already runs.

---

## 1. What was done

| # | Item | Verdict | Commit |
|---|---|---|---|
| 1 | Migrate demo Admin MCP to `mcp({auth,tools})` | **Fixed** | `164b385` |
| 2 | Fix the rotted MCP host gate | **Fixed** | `ac521ec` |
| 3 | Close the scripts typecheck hole | **Fixed** (+1 real defect found) | `ac521ec` |
| 4 | Phantom test reference | **Fixed** | `164b385` |
| 5 | CI duplication | **Fixed**, proven equivalent | `e0ff448` |
| 6 | Docs hygiene | **Fixed** | `3ba99d7` |
| 7 | Dead code | **Partially** — 3 of 4 deleted, `uuid` **refuted** | `74c4b0f` |

### Item 1 — demo Admin MCP (the big one)

The redesign shipped without its consumers. The codegen adapter re-exported
`createMcp`/`mcpTool`, and all nine tool modules plus the endpoint used the
deleted blueprint shape.

A tool is an ordinary registered function now, so each module declares its own
kind rather than inheriting one:

- **Seven read tools -> `query`.** Each wrapped its body in `ctx.tx(async tx => ...)`
  purely because a blueprint had no context of its own. A query already runs in a
  read transaction with a `ctx.db` reader, so the wrapper is gone.
- **Two staff actions -> `mutation`.** A mutation *is* the transaction: throwing
  `AckerDBError` still rolls back with no partial write and still reaches the
  caller as an `isError` tool result (the conformance suite's
  `tools-call-error` scenario pins exactly this behavior).
- **`bash` stays a `procedure`**, because it needs `ctx.abortSignal`. Its
  transaction now covers *materialization only* — see "deliberate divergence"
  below.
- **`mcpAuth` owns scopes and tokens**, so `admin/tokens.ts` issues through
  `adminAuth.tokens` and `v.array(adminAuth.scopes)`.
- **`access` and `annotations` move onto the endpoint's tools record**, which is
  now the single authority on what a credential may reach.

The adapter was **regenerated, not hand-edited** — `acker codegen` reports it
"up to date" against the emitter, which is the check that it is genuinely
generated output.

**The one judgement call worth review.** A tool now also carries a client
address and appears on the generated `api` object, so its function-level
`access` is what a *client* call is judged by. `"authenticated"` would have let
any logged-in demo guest call `cancel_order` from the front end. The tools
therefore declare a new shared policy:

```ts
export const adminToolAccess = (ctx: { auth: Principal }): boolean =>
  ctx.auth.kind === "mcp" || isStaff(ctx.auth);
```

I did not take the `mcp` arm on faith. Tracing the boundary: `claimHttpRequest`
(`runtime.ts:1734`) rejects an `mcp` principal at every HTTP entrypoint,
`runtime.ts:1248` rejects it on the session surface, and
`credentials.ts:319` refuses an MCP-prefixed bearer before any verifier runs —
`VerifiedCredential` has no `mcp` arm to return. An `mcp` principal can only
arrive through `tools/call`, which `authorizeMcpTool` has already checked
against the token's scopes. So the arm grants nothing the endpoint has not
already authorized, and without it every external host would be denied while
the in-app chat (a staff user) kept working.

ADR-0001's surface is unchanged: nine tools, two scopes.

### Item 2 — the rotted host gate

`scripts/fixtures/mcp-host-server.ts` is ported to the same API. Tool functions
declare `access: "public"` deliberately: none is exported as an application
function, so none has an address, and duplicating the endpoint's policy onto
them would create a second copy with no reader.

**Where it belongs in CI.** I recommend *not* adding it to Fast CI, and this is
a recommendation rather than an omission. `mcp-host-acceptance.ts` shells out to
the real `codex` and `claude` binaries and drives live model turns: it needs
both CLIs on PATH plus their credentials, and a run costs real inference time
and money. That is a release-evidence gate, not a per-PR gate. The rot it
suffered was a *typecheck* failure, and item 3 fixes that permanently — the
fixture is now compiled on every `code`-classified PR, which is the cheap
protection that actually prevents this recurrence. Running the hosts stays
manual/pre-release.

### Item 3 — the typecheck hole, and what it was hiding

`scripts/tsconfig.json` covered only `lib.ts`, `ci/`, `release/`. It now covers
`**/*.ts`. One project, no per-tool configs — no runtime settings differ.

**This surfaced 11 errors, all one root cause. Five were pre-existing in
`scripts/mcp-conformance.ts` — a script CI runs on every MCP change.** Full list:

| File | Lines | Pre-existing? |
|---|---|---|
| `scripts/mcp-conformance.ts` | 55, 65, 75, 85, 102 | **Yes — 5 pre-existing** |
| `scripts/fixtures/mcp-host-server.ts` | 64, 75, 103, 134, 145, 156 | No (6, from my item-2 port) |

Every one is `TS2322: Type 'McpContentValidator' is not assignable to ...`.

**The defect:** a handler returning content blocks infers `type: string`, but
`McpToolResult.content` is a discriminated union on `type: "text" | "image" | ...`.
`ReturnDeclarationConstraint` then rejects `returns: mcpContent()` against the
handler's own return type. The fix at every site is an explicit return-type
annotation (`handler: (): McpToolResult => ...`), which contextually types the
literals. That is ordinary TypeScript, not a workaround — but see finding N2:
the ergonomics are a genuine API problem and the fix should arguably be in core.

`packed-consumer.ts`, `validator-diagnostic.ts` and `verify-packages.ts` were
already clean.

### Item 4 — phantom test reference

`demo/app/server/package.json` ran `bun test ../../scripts/backend.test.ts`.
That file was **deleted in `a989481`** ("test: extract shared test-support
workspace, drop demo MCP suite"), so the documented backend gate had not existed
for some time, and `demo/README.md` still described it as starting the app "on
ephemeral ports" through `@ackerdb/cli@0.10.0`.

I removed the script rather than repointing it. The real gate is
`demo/scripts/smoke.ts`, already exposed as `bun run smoke` at the demo root; a
per-package `test` that only shells to it would be the wrapper-only indirection
AGENTS.md rejects, and it would also lie about starting its own server. The
README now describes the actual gate and its actual prerequisite.

### Item 5 — CI duplication, proven identical

`ci.yml` restated the allowed package set and suite path as an inline Node
heredoc. Both now live in `scripts/ci/test-affected.ts`, reading
`PUBLIC_PACKAGES` and `packageDirectory` from `lib.ts`; the YAML step is one
line.

**Acceptance bar met.** A differential harness ran the old inline logic and the
new script over 17 synthetic inputs — every package singly, all seven together,
reordered pairs, and every rejection case (`bench`, a native package, a
non-string, an object, a bare string, malformed JSON):

```
IDENTICAL on all 17 inputs
```

Emitted suite paths are byte-identical to `./packages/${name}/test`. Locked in
by `scripts/ci/test-affected.test.ts` (7 assertions). `actionlint` is clean on
the edited workflow.

### Item 6 — docs hygiene

- `http-exposure.md`: the "separate follow-up feature ... requires bridging the
  MCP principal restriction" paragraph now points at `mcp-exposure.md`; that
  follow-up shipped.
- `ai-integration.md`: the `mcpTool`-conversion migration paragraph is deleted,
  not annotated. There are no blueprints left to convert, and the page documents
  the current API.
- Moved under `docs/history/` with `docs/history/README.md` stating that nothing
  in it is current. Both files the handoff named **already had** historical
  banners; the move was what was missing. `ackerdb-first-class-mcp-issues.md`
  was not in the handoff but is the same kind of document with no banner —
  moving only its two siblings would have left a one-file `issue-breakdowns/`
  beside a `history/` holding the rest, so the whole folder moved and it gained
  a banner.
- All relative links inside the moved files were rebased and each target
  verified to resolve. Two `.workflow/...` links stay broken **exactly as they
  were**: that directory is not in the repository (finding N4).

### Item 7 — dead code

Deleted, each verified unreferenced repo-wide including barrel re-exports and
package `exports` maps:

- `packages/server/src/realtime/definition.ts` — `RealtimeReferenceOf`. Its own
  comment offered it "for targeting a generated realtime reference in
  tests/tools"; nothing ever took it. `RealtimeRef` was imported solely for it
  and went too.
- `packages/server/src/transport/http-surface.ts` — `REALTIME_SESSION_PREFIX`.
- `packages/realtime/src/native/binding.ts` — **10 of the 18** aliases in the
  cited range.

**Handoff correction.** "delete `binding.ts:4-27` unused aliases" is wrong as
written: 8 of those 18 are live in `network.ts`, `peer-connection.ts`, and
`native-track-owner.test.ts` (`NativeRtcConfigurationBinding` alone has 10 call
sites). Deleting the range wholesale would not compile. Only the 10 verified
dead ones were removed.

---

## 2. Evidence

### Diff

```
36 files changed, 679 insertions(+), 488 deletions(-)   (vs origin/main)

source (excl. tests, .md, lockfiles)   +530  -424   net  +106   26 files
tests                                   +39    -0   net   +39    1 file
docs / markdown                         +54   -34   net   +20    8 files
```

Net source growth is real and accounted for: `mcp.ts` gains ~45 lines because
per-tool `access`/`annotations` became explicit records instead of one line
inside each blueprint, and `scripts/ci/test-affected.ts` (+52) is the
extraction from YAML. Against that, seven `ctx.tx` wrappers, 12 dead
declarations, and 13 lines of inline YAML logic are gone. Deletions land in
the places that were carrying risk; additions land in explicit declarations.

### Suites run (all green, on the final committed tree)

| Gate | Result |
|---|---|
| `bun run typecheck` (root + client-react + expo fixture) | clean |
| `bun run typecheck:tooling` (**now covers all of `scripts/`**) | clean |
| `bun run typecheck:bench` | clean, no codegen churn |
| `bun test packages/server/test packages/realtime/test` | **1050 pass**, 0 fail, 89 files |
| `bun test scripts/ci scripts/release` | 21 pass, 0 fail |
| `bun test bench` | 39 pass, 0 fail |
| `bun scripts/mcp-conformance.ts` | 11 checks / 10 scenarios, 0 warnings |
| `bun scripts/verify-packages.ts` | packed gate passed, 7+5 packages at 0.14.2 |
| `bun scripts/mcp-host-acceptance.ts` | **codex 0.144.0 + claude 2.1.170 both pass** |
| `demo: bun run typecheck` (6 projects) | clean, codegen up to date |
| `demo: bun run smoke` | passed |
| `actionlint .github/workflows/ci.yml` | clean |

Host acceptance was run twice — after the fixture port, and again on the final
tree after the package deletions — since it packs the real workspace.

### The demo MCP surface, exercised live

Not just compiled. Against a running demo server with a seeded database, using
two real issued tokens:

```
read-scope tools : bash, get_guests, get_menu_categories, get_menu_items,
                   get_order_items, get_orders, get_tables            (7)
full-scope tools : + advance_kitchen_item, cancel_order               (9)
get_tables rows  : 3
bash menu rows   : 6
cancel_order denied for read-only credential: ok
```

Scope-filtered discovery, a typed entity tool, the bash workspace, and scope
enforcement all confirmed end to end. (Throwaway harness; deleted, not
committed.)

---

## 3. Blockers and how they were routed around

**B1 — the demo could not be installed, and the sanctioned fix is broken.**
The demo pinned `@ackerdb/* 0.10.0` against source `0.14.2` and had no
`node_modules`. `demo/.npmrc` deliberately routes `@ackerdb` to repo-local
Verdaccio, which is configured local-only (no npmjs proxy for that scope), so
the demo can only install from a locally published beta. I started Verdaccio and
ran the sanctioned `bun run publish:beta:demo` — **it tried to publish to public
npm** (finding N1). I stopped there rather than work around a release path.

Routed around by verifying against `0.14.2-canary.4`, the published canary
matching the source version, which carries this exact API. That gave the full
demo typecheck, the smoke run, and the live MCP verification above. **See owner
decision D3 for the pin that should ship.**

**B2 — a demo smoke assertion failed, and it was not mine.** The second-guest
case expected error code `unauthorized`; it got `order.not-owned`. Traced to
`demo/app/server/lib/domain/orders.ts:38`, which I never touched — the demo's own
`ownedOpenOrder` returns that declared application error. The stale expectation
predates typed application results and survived only because the demo ran four
minor versions behind. Corrected to the specific code (strictly tighter, not
weaker) with a comment; smoke then passed.

---

## 4. Gains and losses

**Short term.** Two consumers that could not compile now compile and are
exercised by real gates. `scripts/` is fully typechecked, which is the specific
mechanism that let item 2 rot — and it immediately caught five live errors in a
CI script. The affected-package contract has one owner. `docs/` no longer mixes
2,900 lines of superseded procedure with current contracts.

**Long term.** The demo is a worked example of the current API rather than a
museum piece, so the next MCP change has a consumer that fails loudly. The
typecheck expansion is the durable part of this track: it converts a whole class
of silent rot into a compile error.

**Losses and tradeoffs, honestly.**

- **Net +106 source lines.** Explicit per-tool `access` records cost lines
  versus a field inside a blueprint. I think the trade is right — the endpoint is
  now the one place you read to learn what a credential reaches — but it is a
  cost, not a win.
- **`scripts/` is now wholly a compile dependency of `typecheck:tooling`.** A
  throwaway script dropped into `scripts/` must typecheck. That is the intent,
  but it is friction someone will hit.
- **The demo pin is unresolved** (D3). I verified against a canary; the pin that
  should ship depends on a blocked release step.
- **I deliberately diverged once** (below).
- **The `bash` tool's transaction scope changed.** Behavior-preserving for
  results, but it is a change; called out explicitly.

### Deliberate divergence — `bash` transaction scope

The old handler ran the sandboxed shell *inside* `ctx.tx`. Files are already
materialized eagerly from one snapshot before the shell starts (the existing
`buildFiles` comment explains why), so the script never touches the database —
yet the read connection stayed open for the whole of an arbitrary,
caller-supplied script. The migration required restructuring this handler anyway
(`ctx.tx` returns a `Result` now), so the transaction now covers materialization
only. Results are identical — same snapshot, same strings — and a caller's
`sleep` no longer owns a shared read connection. Flagging it because "smoke
passes before and after" would otherwise hide a real change.

---

## 5. Verdict per experiment

| Item | Verdict | Why |
|---|---|---|
| 1 demo migration | **Clear win** | Compiles, smoke passes, MCP surface verified live against two real credentials. ADR-0001 surface preserved. |
| 2 host gate | **Clear win** | Both real hosts pass against packed workspace packages. |
| 3 typecheck hole | **Clear win** | Cheapest change here, and it found a live CI-script defect on its first run. |
| 4 phantom test | **Clear win** | Dangling reference and a README paragraph describing a deleted file, both gone. |
| 5 CI dedupe | **Clear win** | Equivalence demonstrated on 17 inputs, then locked by tests. |
| 6 docs hygiene | **Clear win** | Superseded procedure is no longer interleaved with live procedure. |
| 7 dead code | **Partial / one refuted** | 12 declarations deleted; `uuid` refuted with evidence; `isErr` deferred to owner. |

---

## 6. Owner decisions

### D1 — `bench/results/` (recommendation: keep)

13 JSON files, 61,641 lines, 2.0 MB, `v0.4.1` -> `v0.13.1`, last touched
2026-08-01. Runtime-dead: nothing loads them. But **not** unreferenced —
`scripts/ci/changes.ts:124` explicitly excludes `bench/results/` from the
benchmark trigger, and AGENTS.md already states "Historical files in
`bench/results/` are not current release evidence", so the repo has *already*
neutralized the risk of mistaking them for current.

My recommendation is to **keep them**. 2 MB of append-only history that no code
reads costs a one-time clone and nothing else; deleting it destroys the only
in-repo record of how performance moved across ten releases, which is exactly
the evidence AGENTS.md asks for when judging a performance change. If you
disagree, the exact command is:

```sh
git rm -r bench/results
```

Nothing else needs changing: the `changes.ts:124` exclusion stays harmless, and
the AGENTS.md sentence would want a follow-up edit.

### D2 — `isErr` in `packages/core` (recommendation: keep, or delete the family together)

- Defined `packages/core/src/result.ts:250`, re-exported `index.ts:7`, so it is
  **shipped public API** of `@ackerdb/core` — unlike D1 and the item-7
  deletions, removing it is a breaking change for consumers.
- **Zero call sites** anywhere in `packages/*/src`, `packages/*/test`, `bench/`,
  `demo/`, `fixtures/`, `scripts/`, or docs. The two grep hits are its own
  definition and its export.

The relevant context is its siblings: `isResult` has 24 references and
`isApplicationError` 14 — both earn their place — while `isOk` **does not exist**.
So the surface is already asymmetric: `isErr` with no `isOk`. Two coherent
options:

1. **Keep it** (my recommendation). It is 3 lines, it is the obvious companion
   to a `Result` type, and an external consumer writing `if (isErr(r))` is
   exactly who it is for. Absence of internal use is expected for a public
   guard.
2. **Delete `isErr`** on the grounds that a guard nothing calls and whose
   counterpart was never written is an accident rather than a decision. This is
   a public break and should ride a deliberate major/minor step, not a hygiene
   commit.

I did not act, per the handoff.

### D3 — the demo's `@ackerdb/*` pin (needs a decision, blocked on N1)

Currently committed as `0.14.2-canary.4` so that `demo/package.json` and
`demo/bun.lock` agree and reference a real published version carrying this API.
That is a verification pin, not necessarily the right shipping pin. The intended
steady state is a Verdaccio beta via `bun run publish:beta:demo` — blocked by
N1 — after which `repinDemo` rewrites pins matching the source version. Note it
will report a canary pin as a "deliberate demo divergence" and leave it alone,
so this will not silently self-correct.

---

## 7. New findings the audit missed

### N1 — `bun run publish:beta` targets **public npm**, not Verdaccio (high severity)

AGENTS.md: "never publish beta or alpha versions to public npm." The script
intends to comply — `.npmrc` says "Local beta publication passes Verdaccio's URL
explicitly, so it cannot move a public npm dist-tag" — but `npm publish`
resolves a **scoped** registry ahead of the `--registry` flag, and root `.npmrc`
line 3 sets `@ackerdb:registry=https://registry.npmjs.org/`. Demonstrated:

```
$ npm config get @ackerdb:registry --registry=http://127.0.0.1:4874
https://registry.npmjs.org/
```

Running `bun run publish:beta:demo` on this machine printed
`publishing @ackerdb/core@0.14.2-beta.1 with dist-tag beta` and then
`npm error code ENEEDAUTH ... requires you to be logged in to
https://registry.npmjs.org/`. **The only thing that stopped a beta reaching
public npm was the absence of an npmjs auth token on this machine.** On a
machine with one — a maintainer's — it would publish.

Confirmed nothing leaked: `@ackerdb/core` on npm still lists only
`0.13.2-canary.0, 0.13.3-canary.2, 0.13.4-canary.3, 0.14.0-canary.4,
0.14.2-canary.1, 0.14.2-canary.4`. No `0.14.2-beta.1`.

Introduced by `d92b58f` ("chore: replace repository release policy"), which added
the scoped line to root `.npmrc`; `847623f` had previously routed the scope to
Verdaccio. Local beta publishing has been broken since.

Fix (in `scripts/release/publish.ts`, where `--registry=${registry}` is passed):
use the scope-qualified flag, which does win, and assert the resolved target
before publishing:

```diff
-        `--registry=${registry}`,
+        `--@ackerdb:registry=${registry}`,
```

I did not apply it: it is release-path policy, it is outside this track, and a
fix here should ship with a test that fails if a beta ever resolves to a
non-loopback registry. **Recommend prioritizing it** — it is a latent
supply-chain event, not a papercut.

### N2 — `returns: mcpContent()` does not typecheck without a handler annotation

The root cause behind all 11 item-3 errors. A user writing the documented
pattern gets a multi-line `TS2322` about `McpContentValidator` not being
assignable to an intersection type — with no hint that the answer is annotating
the handler. Every content-returning tool in the repo hit it, which is a strong
signal about what an external user will hit.

The call-site fix (`handler: (): McpToolResult => ...`) is applied and correct,
but the ergonomic defect is in core: `returns` and `handler` are sibling
properties inferred together, so `returns` never contextually types the handler.
A proper fix makes the handler's return type flow from `returns` in the builder
overloads. That is real generic surgery on `ProcedureBuilder` and belongs to
whoever owns `app/functions.ts`, not to a hygiene pass.

### N3 — `mcp/ai.ts:329` compares the wrong name (low severity, not a bypass)

`authorizeMcpTool` gates on `principal.mcp === endpoint.auth.name` (the
**provider**), but `ai.ts:329` filters on `context.auth.mcp === mcp.name` (the
**endpoint**). These disagree whenever a provider's name differs from its
endpoint's name. Not exploitable — `capability.execute` still routes through
`dispatchMcpTool` -> `authorizeMcpTool`, which is stricter and authoritative — so
the effect is confined to tool *visibility* in the AI-tools path. Worth
reconciling so the two predicates are the same one.

### N4 — two permanently broken doc links

`docs/history/production-readiness-report.md` links twice into
`.workflow/production-safety-operational-visibility/...`, a directory that does
not exist in the repository. Pre-existing; left intact and rebased with the rest
so the move is a pure relocation. Worth deciding whether that content is
recoverable or the links should go.

### N5 — the demo carried a stale error-code contract for four minor versions

B2 above is worth reading as a finding, not just a blocker. A pinned-behind demo
does not merely fail to exercise new APIs — it silently freezes assertions about
old behavior. The smoke script asserted `unauthorized` for a case the demo's own
domain code had been answering with `order.not-owned`. Whatever pin D3 lands on,
the demo drifting far behind source has now produced two distinct defects (this
and the un-migrated MCP surface); keeping it near-lockstep is the real fix.
