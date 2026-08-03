# AckerDB audit integration report

Branch: `audit/integration`

Base: `origin/main` at `57c64cd`

Result: every confirmed change from T1–T8 was landed in the required order. No T8 split was skipped. Per-track `REPORT.md`/`BLOCKED.md`, `.t5scratch/`, and refuted T2 sampling code are absent from the final tree. No performance benchmark was run.

## Landing record

| Step | Source | Integration commit | Outcome |
| --- | --- | --- | --- |
| 1 | `audit/t1-hotpath` | `034c7bb` | Merged confirmed hot-path changes; excluded `REPORT.md`; retained `bench/t1-hotpath-prototype.ts`. |
| 2 | `audit/t7-hygiene` | `030de2c` | Merged independently; excluded `REPORT.md`. |
| 3 | `audit/t6-test-infra` | `06fabb6` | Merged shared test infrastructure; excluded `REPORT.md`. Its harness structure was kept in later conflicts. |
| 4 | `audit/t5-dbschema-debt` | `ed2868a` | Merged confirmed schema/database changes; excluded `REPORT.md` and the committed `.t5scratch/` tree. |
| 5 | `audit/t4-client-api` | `fb8c559` | Merged the breaking atomic-startup/client retry API and server SSE encoder migration; excluded `REPORT.md`. |
| 6a | `audit/t2-telemetry` | `92577df` | Merged the branch tip and excluded `REPORT.md`. |
| 6b | T2 refuted machinery | `3874c12` | Removed both sampling experiments while retaining accepted telemetry decomposition and constant-cost projection work. |
| 7 | `audit/t3-runtime-split` | `2014510` | Merged T3/T3b structure, reconciled T1/T2/T5 behavior, and excluded `REPORT.md`. |
| 8.1 | T8 delivery recipe | `26093b9` | Re-derived `subscriptions/delivery/` on the integrated tree. |
| 8.2 | T8 reactive recipe | `81033a9` | Re-derived `subscriptions/reactive/` on the integrated tree. |
| 8.3 | T8 session recipe | `86904f6` | Re-derived `subscriptions/session/` on the integrated tree. |
| 8.4 | T8 plugin recipe | `c623e1f` | Re-derived plugin contract/capability/builder/definition/assembly ownership. |
| 8.5 | T8 validation recipe | `557f3eb` | Re-derived validator/bounds/primitives/composites/`v` ownership. |

### Step-specific reconciliation

T1, T7, T6, and T5 landed without source conflicts. Audit artifacts were removed before each merge commit. T5's scratch directory was explicitly removed rather than treated as product code.

T4 conflicted in six client/client-react tests because T6 had already introduced shared harnesses. The resolution retained T6's `createHarness()` ownership and applied T4's constructor-owned connection demand, injected-clock retry ownership, removal of explicit `client.connect()`, and updated socket-count expectations. T1's delivery work and T4's SSE encoder work were disjoint and both remain: the server now uses the core `encodeSseChunk`/`encodeSseControl` path.

T2 had one merge conflict in `subscriptions/reactive.ts`. The resolution kept T2's constant-cost `dormantEntries`/`evaluatingEntries` counters and omitted the old `eventTail`, because T1 intentionally replaced global event serialization with independent per-listener sequencing.

T3 conflicted in `runtime/runtime.ts` and `schema/definition.ts`. T3's extracted-owner placement won. The extracted owners were then reconciled with:

- T1's exact `scheduledTables` write journal and touched-table-only scheduler refresh;
- T2's explicit invocation phase observer contract and sampler path using `reactive.metricsSnapshot()`;
- T3's single subscription-admission owner and runtime/module-cycle fixes; and
- T5's eager rejection of validators without a physical storage representation.

The scheduler test was re-pointed from deleted monolith internals to the extracted scheduler/candidate owners without changing its assertion.

T8 was not merged or cherry-picked. Its five commits and final tree were used as structural recipes, and each split was rebuilt on the already-integrated sources, tested, and committed separately. Integrated behavior was placed in the new owners:

- delivery: T4's core SSE encoders;
- reactive: T1's canonical argument envelope and parallel event delivery, T2's constant-cost counters, and T3's single admission owner;
- session: T3's shared authentication-attempt observation contract;
- plugins: T3's declaration-validation import boundary; and
- validation: T5/T3 consumers routed to the new acyclic validator layers.

No split was skipped. The public `packages/server/src/index.ts` export-name set is identical before and after T8: 537 names before, 537 after, zero added and zero removed.

## Exact T2 unpick

The follow-up commit `3874c12` removes both refuted sampling designs: retrospective tail-sampling from `8c895c6` and prospective selection from `a376292`.

Removed:

- `TelemetryOptions.operationTraceSampleInterval`;
- the prospective interval/sequence selection state and slow/failed promotion latches;
- the sampled flag and prospectively synthesized boundary spans;
- sampling-specific options and tests;
- the `IDENTIFY_OPERATION_TRACE` external-trace reuse path introduced by the refuted experiment; and
- the runtime path that reused that experiment's externally identified operation trace.

Restored:

- every operation creates the full origin/main trace lifecycle when tracing is enabled;
- fast phases are staged/aggregated and the original retention policy makes the tail decision;
- there is no prospective sampling-selection state;
- external HTTP tracing again uses the prepared context plus its normal begin/finish lifecycle; and
- Runtime opens the inherited operation trace from the claimed context through the origin/main boundary.

Retained:

- constant-cost idle reactive telemetry (`metricsSnapshot()` and exact counters);
- the transport-neutral authentication-attempt observation contract;
- telemetry ownership decomposition, including `composition/telemetry.ts`, `records/codec.ts`, and `tracing/retention.ts`;
- macOS benchmark portability and profile support;
- the independent phase-context allocation removal from `30d8973`; and
- all origin/main operation-trace retention and failure-promotion behavior.

Focused telemetry tests and the full server suite passed after the unpick. A source/test search found no operation-trace sampling option or selection state remaining.

## Verification

Every landing step passed root `bunx tsc --noEmit` and the suites for the packages it touched before the next step. Each T8 split additionally passed the full server suite before its commit.

Final matrix (package suites were invoked with absolute test paths):

| Check | Result |
| --- | --- |
| `bun run typecheck` | pass — root, client-react, and fixture configs |
| server | 983 pass, 0 fail |
| client | 191 pass, 0 fail |
| client-react | 164 pass, 0 fail |
| CLI | 211 pass, 0 fail |
| core | 78 pass, 0 fail |
| realtime | 79 pass, 0 fail |
| cache | 24 pass, 0 fail |
| `bun run test:mcp:conformance` | 11 checks across 10 scenarios, 0 warnings |
| server public export set | 537 before / 537 after T8; no changes |

The React suite prints expected error stacks from negative missing-provider tests; all 164 tests pass.

### Demo smoke

The smoke test was not runnable from this worktree. Before considering a server start, the existing environment was checked: local Verdaccio was already listening at `127.0.0.1:4874`, the demo had no installed `node_modules`, and no demo development server was started. `bun install --frozen-lockfile` in `demo/` returned HTTP 404 for the committed `@ackerdb/*@0.14.2-canary.4` pins because that canary is absent from the demo's local-only Verdaccio registry. This is T7's documented unresolved pin/registry caveat, not an integration regression. No alternate registry or release path was used.

## Diff versus `origin/main`

`git diff --stat origin/main` covers 246 files. Categorization counts a path once: `bench/`; test directories and `*.test.*`/`*.check.*`; Markdown/docs; `src/`; then other integration/config/demo/script files.

| Scope | Files | Insertions | Deletions |
| --- | ---: | ---: | ---: |
| source (`src/`) | 134 | +16,027 | -13,259 |
| tests | 67 | +1,956 | -3,438 |
| bench | 5 | +813 | -45 |
| docs/Markdown | 13 | +225 | -78 |
| other | 27 | +574 | -404 |
| **total** | **246** | **+19,595** | **-17,224** |

## Final notes

- No performance benchmark was run, as required by the handoff.
- No development server was started.
- No branch was pushed and no pull request was opened.
- The worktree contains no per-track audit report, blocker file, or scratch directory.
