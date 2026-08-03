# T6 — Test infrastructure dedup

Branch `audit/t6-test-infra`. Target was net −1,300..2,200 test LoC with zero loss of invariant
coverage. **Delivered −1,755 net LoC, no product source touched, every touched suite green twice
with test counts identical to baseline.**

The total landed inside the target band, but the distribution is nothing like the forecast. Items 1
and 2 (harness extraction) overshot their estimates by roughly 2x and carried the whole track.
Items 3–6 (scenario merging and deletion) were largely refuted: the "duplication" there is mostly
different requirements that look alike from a distance.

## Per-item LoC

| # | Item | Estimate | Suite delta | New shared support | Net | Verdict |
|---|---|---:|---:|---:|---:|---|
| 1 | client-react harness dedup | −450..700 | −1,194 | +265 | **−929** | clear win |
| 2 | client suspension harness dedup | −250..400 | −810 | +107 | **−703** | clear win |
| 3 | CLI process harness consolidation | −250..450 | −214 | +97 | **−117** | partial |
| 4 | Telemetry acceptance overlap | −150..300 | 0 | 0 | **0** | refuted |
| 5 | bench/process-lifecycle.ts | −60..90 | +12 | 0 | **+12** | refuted |
| 6 | Migration generate overlap | −100..180 | −19 | 0 | **−19** | mostly refuted |
| | **Total** | −1,300..2,200 | **−2,225** | **+469** | **−1,755** | |

Item 1's support column includes `fixtures/test-support/src/client-transport.ts` (197 LoC), which
item 2 also builds on — charged once, to item 1. `git diff --stat origin/main`: **29 files changed,
1,327 insertions, 3,082 deletions.** Every changed file is a test or test-support file; the only
match under a `src/` path is the fixture package's own `fixtures/test-support/src/`.

New shared support, all of it replacing more code than it adds:

| File | LoC | Owns |
|---|---:|---|
| `fixtures/test-support/src/client-transport.ts` | 197 | `ManualClock` + `FakeSocket`, the two doubles `AckerDBClient` takes through its config |
| `packages/client/test/support/harness.ts` | 107 | `createHarness`, `cursor`, `mustOk`, `mustErr` |
| `packages/cli/test/support/process.ts` | 97 | `steps()` (`withTimeout`/`eventually`), `runCli`, `CLI_ENV` |
| `packages/client-react/test/support/harness.ts` | 68 | `createHarness` for provider-mounted hook suites |

## Suites green (twice each, absolute paths)

| Package | Baseline | After, run 1 | After, run 2 |
|---|---|---|---|
| `packages/client-react/test` | 164 pass | 164 pass | 164 pass |
| `packages/client/test` | 186 pass | 186 pass | 186 pass |
| `packages/cli/test` | 211 pass | 211 pass | 211 pass |
| `bench` | 39 pass | 39 pass | 39 pass |
| `packages/server/test` | 971 pass | untouched | untouched |

`bunx tsc --noEmit -p tsconfig.json` clean. `bunx tsc -p packages/client-react/tsconfig.json
--noEmit` clean. (`bunx tsc -p bench/tsconfig.json` reports pre-existing errors in
`bench/ackerdb-app/functions/bench.ts` — it needs `codegen` first, which is why the repo script is
`typecheck:bench`, not bare tsc. Unrelated to this branch.)

Zero behavioural assertions were deleted anywhere. The only assertion removed at all is in item 6,
and it is a re-read of two fields that the same test already asserts through the artifact paths.

## What was done

### Item 1 — client-react harness dedup (commits `73eb45b`, `07b6a7e`)

The audit named three files. There were **eight** `ManualClock` copies, **eleven** `FakeSocket`
copies and **nine** `createHarness` copies in this package alone, several byte-identical and the
rest strict subsets of one superset. All of them now come from one place.

`ManualClock` and `FakeSocket` went to `fixtures/test-support` (the established home for
cross-package test helpers, per the `test/shared-test-support-pub` prior art) because the `client`
package needs the same pair. The socket parses every frame the client sends with the real protocol
parser, so no suite can pass on a frame the wire would reject.

Ten suites migrated. Two things deliberately did **not** move:

- **`use-authentication` keeps its exactly-one-live-socket rule** as a named local `onlyLive()`.
  The shared harness's `live()` returns the newest open socket; this suite's version threw unless
  exactly one was open. That is a real assertion — re-authentication must replace the connection,
  never add one — so folding it into a generic accessor would have quietly dropped it.
- **`use-realtime` keeps its own socket.** It is an 8-line no-op stub for a suite about WebRTC data
  channels, not a copy of the transport double. Swapping it in would have added frame parsing the
  suite has no use for.

### Item 2 — client suspension harness dedup (commit `86b280a`)

`harness`, `welcome`, `cursor`, `lastFrame`, `mustOk`, `mustErr` were reimplemented across
`client.test.ts`, `suspension`, `suspension-convergence` and `suspension-settlement`. They now live
in `packages/client/test/support/harness.ts`. `realtime-session` and `channels/client-channel` also
dropped their private clock and socket copies.

The socket double absorbed the two capabilities only these suites had: `deferClose` (the window
between asking to close and being told the socket is gone) and `lastFrame`. Two members were
deleted rather than moved — `drop()` only called `close()`, and `isClosed()` only read `closed`,
both instances of the "function that exists to call another function" antipattern.

`suspension-settlement` keeps a local `harness()` that delegates to the shared one and adds the SSE
route journal it owns. It forwards `port` through an explicit getter rather than a spread, because
spreading would evaluate the lazy port accessor at construction time and throw for any suite that
overrides `lifecycle`.

### Item 3 — CLI process harness consolidation (commit `6c38687`)

`withTimeout` and `eventually` were byte-identical in five process suites, and the timeout bound was
a *third* reimplementation of `within`, which already exists in `ackerdb-test-support/async`. They
now come from `packages/cli/test/support/process.ts`, built on `within`, with each suite binding
only what genuinely differs — its step budget — via `steps(STEP_TIMEOUT_MS)`. That form was chosen
so no call site had to change and no suite's timeout silently moved. The two identical piped
`runCli` copies collapsed into one.

Only a fraction of the estimate was reachable; see "Savings that did not materialise".

### Item 5 — bench/process-lifecycle (commit `e513f6c`)

Refuted as written, but one real improvement landed: `stopSubprocess` accepts any object exposing
`exitCode`/`exited`/`kill`, so only the escalation path needs a real OS process. The cooperative
path now runs against a scripted process, which also let it assert two things the real-process
version could not — that an already-exited child is never signalled again, and that a budget which
cannot bound anything (`-1`, `NaN`, `Infinity`) is rejected. Net +12 LoC for strictly more coverage
and one fewer process spawn.

### Item 6 — migration generate overlap (commit `392226a`)

Deleted the "second change generates 0002" block and the third app-schema constant that existed
only to feed it (numbering is covered directly in `generate.test.ts` at `:248`, `:460-470`, `:616`),
plus a `parsedMeta.number/name` re-read that the same test already proves through the asserted
artifact paths. The rest of the flagged overlap is not overlap; see below.

## Blockers hit and how they were resolved

1. **A TypeScript-private field is still visible at runtime.** The shared `FakeSocket` used
   `private isClosed = false`, which shadowed the old `isClosed()` *method* at exactly the call
   sites being migrated — `sockets[0].isClosed` silently evaluated to a boolean instead of throwing
   "not a function". Fixed by making it a real `#closed` private field, which makes that entire
   class of collision impossible.
2. **Bulk regex rewrites cascaded.** One rule's output matched a later rule's pattern, producing
   `sockets[0].USER_AUTHENTICATION.welcome(client.clientSessionId.clientSessionId)`. Caught by the
   suite immediately. A second over-reach rewrote `FrameProxy.drop()` — an unrelated API that
   happens to share a name — into `.close()`. Both repaired; every rewrite was verified by running
   the suite before moving on.
3. **`tsc` caught a silent behaviour change the tests did not.** `harness.config(credential, url)`
   became a one-argument call; at runtime the extra argument was ignored and the test still passed,
   but against the wrong URL. Only the typecheck surfaced it. For a mechanical refactor of this
   shape, the typecheck is not a formality — it is the safety net.
4. **Provider config identity.** Turning a static `config` field into a `config()` method is only
   safe because `AckerDBProvider` keys lifetimes by config *value* (`lifetimeKey`, JSON), not object
   identity. Verified in `provider.tsx` before committing to the shape.
5. **Env defaults are not neutral.** `backup-restore`'s `runCli` had no `ACKERDB_TELEMETRY` default
   while the others set `disabled` — and that suite asserts on telemetry records. A naive unified
   default would have silently disabled the thing under test while leaving the suite green on
   weaker evidence. The shared `runCli` therefore defaults to an empty env and exports `CLI_ENV`
   for suites that want it.

## Savings that did NOT materialise, and why

**Item 4, telemetry (−150..300 estimated, 0 delivered).** No exact duplicate scenarios exist. Every
candidate pair either spans a layer boundary or injects a materially different failure:

- Journal persistence failure: `telemetry-journal.test.ts:91-104` injects the same duplicate-sequence
  failure as `telemetry-runtime.test.ts:728-749`, but the first asserts the *component* contract
  (observer fired once, `state: "failed"`, `storedRecords: 0`, subsequent `append` returns false)
  and the second asserts the *runtime* contract (`runtime.state !== "ready"`), which appears nowhere
  else.
- Exporter fail-open: `telemetry.test.ts:1237-1282` builds a bare `Telemetry` and asserts snapshot
  counters. `telemetry-runtime.test.ts:2031-2137` proves what the unit test structurally cannot —
  that a real mutation, query and subscription transition all complete under wall-clock while an
  export is stalled indefinitely. That is the actual fail-open invariant.
- "Bounded queues" names three different queues in three different components: the `Telemetry`
  retained-record queue, the local-sink pending queue, and the `TelemetryJournal` write queue.
- Disabled telemetry, coalescing storms: same pattern — unit layer vs live runtime, or exporter vs
  no-exporter output path.

The closest same-layer pair is `telemetry.test.ts:1684-1723` and `:1725-1761`: identical setup,
both awaiting `drain()` on a never-resolving exporter. They differ in which timer wins, and the drop
accounting proves it (`{exporter: 0, drain: 5}` vs `{exporter: 2, drain: 3}`) — two distinct
orderings of the same state machine. Kept, per "when in doubt, keep". Flagged as the first place to
revisit if that instruction ever loosens. Also worth knowing: `telemetry-delivery.test.ts` contains
**zero** coverage of the four themes it was listed under.

**Item 3, CLI process harnesses (−250..450 estimated, −117 delivered).** `spawnServer`, `stopServer`
and `makeClient` look duplicated but are not copies. Readiness detection differs (scan stdout for
`ready on` / poll the port / read a file-backed capture); stream handling differs (pipe vs file,
stdout-only vs both drained); cleanup differs (`Set` vs array, SIGTERM-then-wait vs SIGKILL).
Consolidating them needs one parameter per difference — a config object about as large as the code
it replaces, and harder to read. Only the byte-identical parts were genuinely extractable.

**Item 5, bench (−60..90 estimated, +12 delivered).** The premise — "mostly test Bun subprocess
semantics" — does not survive reading the assertions. They exercise AckerDB's own
`waitForBenchmarkStart` handshake, `stopSubprocess`, `BoundedTextTail` and `benchmarkFailure`; the
subprocess is the vehicle, not the subject. Deleting the phase-holding test at `:24-65` would also
have removed the **only** coverage of `ProcessTreeMonitor.summarize` over a real measured phase —
the property that makes benchmark numbers attributable to the phase they claim.

**Item 6, migration generate (−100..180 estimated, −19 delivered).** The scaffold-text assertions
that read as re-proofs are the string-surgery targets the test then fills — delete the assertion and
the surgery fails obscurely instead of loudly. And `parsedMeta.pre === V1` is the one thing only the
CLI path can prove: that `generate` diffed against the live seeded database rather than a snapshot
handed to it. The direct generator tests are given `pre` explicitly and structurally cannot cover it.

## New findings the audit missed

1. **A test title claims coverage the body does not have.**
   `packages/server/test/telemetry/telemetry-runtime.test.ts:728` is titled *"makes local journal
   failure unhealthy without escaping through `ctx.log`"*, but never calls `ctx.log` — it reaches
   straight for `app.runtime.telemetryJournal.append(...)`. The "unhealthy" half is proven; the
   "without escaping through `ctx.log`" half is not. Either the title should shrink or the test
   should drive a real `ctx.log`. Not changed here (that is adding coverage, not deduplicating it).
2. **Existing shared helpers were being ignored.** `ackerdb-test-support/async` has exported
   `within` and `until` since the shared-test-support commit, yet five CLI suites each carried a
   hand-rolled `withTimeout`, and `eventually` is an assertion-polling variant of `until` that was
   written five times. Prior art existed and was not found. Whatever makes `fixtures/test-support`
   hard to discover is worth fixing — it is not declared as a devDependency by any package, it is
   only reachable via a root `node_modules` symlink.
3. **`stopSubprocess` had two untested guards** — the non-finite/negative budget `RangeError`, and
   the already-exited child that must not be signalled again — because both existing tests reached
   for a real subprocess when the function accepts an injectable one. Now covered.
4. **`use-realtime`'s socket double is a deliberate no-op**, not drift. Worth recording so a future
   dedup pass does not "fix" it into a frame-parsing socket the suite does not want.
5. **The env-default hazard in item 3's blocker list is a general one.** Any future attempt to unify
   `runCli` across the CLI suites has to treat `ACKERDB_TELEMETRY` and `ACKERDB_DURABILITY` as part
   of each suite's subject, not as boilerplate.

## Gains and losses

**Short-term.** 1,755 fewer lines to read and keep consistent. One `FakeSocket` whose framing,
close-code validation and welcome shape are defined once, so a protocol change lands in one file
instead of nineteen. Two fewer real process spawns in the bench suite.

**Long-term.** The per-suite copies had already drifted into subtly different doubles — clocks whose
interval re-queueing differed, sockets that did or did not validate close codes, welcome frames that
did or did not carry an auth epoch. Every copy was a chance for a suite to pass against a socket the
real wire would reject. That drift surface is gone. The shared modules carry doc comments naming the
invariant each helper protects, which is what the per-file copies never did.

**Losses and tradeoffs, honestly.**
- Reading a migrated suite now takes one extra hop to `test/support/` to see what `createHarness`
  injects. Mitigated by keeping the shared surface small and documented, but it is a real cost.
- The shared `FakeSocket` is a superset. Some suites now carry capabilities they do not use
  (`closes`, `deferClose`, `nextDueIn`). The alternative — a double per capability set — is worse,
  but it is not free.
- `createHarness`'s second parameter (the socket factory) exists for exactly one caller,
  `native-lifecycle`. Justified because the alternative was that suite keeping a full private
  harness, but it is a single-use parameter and should be deleted if that suite ever changes.
- Items 3–6 leave the CLI and telemetry suites close to where they started. That is the correct
  outcome, not an incomplete one — but anyone reading only the target number should know the
  remaining test LoC in those areas is not slack.
