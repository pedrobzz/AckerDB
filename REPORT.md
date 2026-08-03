# T3 runtime split prototype report

## Verdict

The executed prototype is a net architectural win, but the overall runtime split still **needs iteration**. The high-risk part of the handoff was completed through material, independently green slices of L9 steps 5–8, and three Step 9 ownership moves. `runtime/runtime.ts` fell from 5,227 to 3,677 lines (−1,550, −29.7%), the two confirmed L2 integration defects are fixed, and the schema↔app module cycle is gone.

The tradeoff is real: implementation source grew by 613 lines because the prototype added explicit contracts, state owners, and typed outcomes while preserving the full behavior. Runtime remains a 3,677-line integration file; write/procedure execution, publication, MCP authentication/capabilities, scheduler execution, admission/status/drain, identity, and final composition still need subsequent slices.

## Findings and experiments

| Finding / experiment | Result | Evidence and commits | Verdict |
| --- | --- | --- | --- |
| L9 Step 5: contracts, trace bridge, generic operation runner | Fixed | `3b95ba9`, `7568551`, `857e003`: public lifecycle/options/request/status contracts moved to `runtime/contracts/`; trace/invocation ownership moved to `runtime/telemetry/trace-bridge.ts`; admission/trace/cancel/finalize moved to `runtime/execution/operation-runner.ts`. | Clear win. These are cohesive owners, not pass-through modules. |
| L9 Step 6: read/write/procedure execution | Partially fixed | `1cb0a52`: the bounded reader pool, queue, snapshot transaction, rollback, and read telemetry moved together to `runtime/execution/read.ts`. Write/procedure/commit-publication remain in Runtime. | Clear win for reads; remaining Step 6 needs iteration. |
| L9 Step 7: sessions/publication | Partially fixed | `6b6befe`: `RuntimeSessionStore` owns session identity, connection/subscription capacity, matching, close/drain, and removal. Auth rotation and publication choreography remain in Runtime. | Clear win for state ownership; publication still needs extraction. |
| L9 Step 8: HTTP/MCP/SSE | Partially fixed | `f2776f3`: SSE source validation, backpressure, async-context restoration, and release. `c422126`: HTTP result interpretation, encoding, size fitting, and responder handoff. `4856dd5`: typed MCP authorization capability. MCP authentication/capability binding and most execution remain in Runtime. | Clear win for completed adapters; MCP portion needs iteration. |
| L9 Step 9: sampler, delivery, scheduler candidate | Partially fixed | `fede98f`: process/event-loop sampler and unchanged metric projection. `c5ebf3d`: delivery trace leases and bounded failure coalescing. `359b302`: scheduled-candidate SQL on the read executor. Scheduler execution, admission, status, and drain remain in Runtime. | Clear win for completed owners; Step 9 remains incomplete. |
| L9 Step 10: composition-only Runtime | Not attempted | Moving composition before the remaining write/publication/lifecycle seams would only preserve the current coupling in another file. | Needs iteration after the remaining owners exist. |
| L2: MCP tool authorization ran twice | Fixed | `4856dd5`: the HTTP adapter preflights a valid request/batch once, retains an opaque typed `RuntimeMcpToolAuthorization`, and passes it to execution. `Runtime.runMcpTool` consumes the capability and does not decide again. A transport test spies on `authorizeMcpTool` and proves one successful HTTP tool call invokes it exactly once. | Clear correctness win, with a source cost of +56 lines for the typed capability and batch map. |
| L2: Plugin telemetry callback threading | Fixed | `2b86f7b`: one frozen `PluginInvocationCapabilities` object carries timestamp, logger, and analytics authority. Query/mutation/procedure bindings receive it once, and nested query/mutation/transaction contexts retain the same object instead of reconstructing callbacks. Source delta: −7 lines. | Clear win. Less callback plumbing and one invocation owner. |
| L1 F12: schema↔app cycle | Fixed | `3dade1c`: access policy/context moved to `app/access.ts`; argument-declaration validation moved to `validation/declarations.ts`. `schema/definition.ts` no longer imports `app/functions.ts`, which imports Schema back. | Clear win. Direct lower-level ownership, +15 source lines. |
| L1 F15: broad runtime protocol knowledge | Partially fixed | Contracts, reads, sessions, HTTP responses, SSE sources, delivery telemetry, sampling, scheduled lookup, tracing, and operation execution now expose narrow capabilities. The remaining Runtime imports still span every major subsystem. | Needs iteration. The import surface is smaller but not yet narrow end-to-end. |
| L9 `releaseNothing` dead-code candidate | Refuted | It is the no-allocation `OwnedProcedureContext.release` implementation when no MCP AI context was bound. The ownership contract requires `release()` unconditionally; deleting it would either duplicate an inline no-op or make every consumer branch on optional cleanup. | Keep. It is a small implementation safeguard, not dead code. |

## Interface-by-interface verdict

The rule was to introduce a seam only when it hides real ownership or narrows a consumer. A named interface that merely re-states one concrete class was skipped.

| L9 seam | Prototype verdict | Resulting shape |
| --- | --- | --- |
| Engine/database | Partial, introduced where useful | `RuntimeReadExecutor` receives only `reader`, `createReader`, and `commitVersion`; scheduled lookup receives only `plan`. Runtime still needs concrete Engine for writes, storage lifecycle, identity, and status. |
| Registry | Skipped as a global interface | Local consumers use structural `Pick`s where narrow (`RuntimeTraceBridge`, scheduled lookup). A global Registry interface would currently re-state the concrete registry because dispatch/identity/MCP remain composed in Runtime. |
| Invocation | Partial, no facade | `RuntimeTraceBridge` hides invocation/trace async-local coordination and distinguishes scope restoration from operation-root installation. Function authorization/invocation remain direct functions; wrapping them one-for-one would add indirection. |
| Transactions/coordinator | Partial | Read snapshot ownership moved behind `RuntimeReadExecutor`; generic operation admission moved behind `RuntimeOperationRunner`. CommitCoordinator and write collectors remain explicit until write/publication extraction. |
| Sessions/publication | Partial, real owner added | `RuntimeSessionStore` owns the map, capacity counters, identity matching, and close/removal. Publication remains in Runtime. |
| HTTP | Implemented for response ownership | `RuntimeHttpResponses` accepts only frame capacity and three telemetry operations. Request claiming and query/mutation/procedure execution remain Runtime orchestration. |
| SSE/delivery | Partial, two real owners added | `validatedSseSource` owns source lifecycle/backpressure; `RuntimeDeliveryTelemetry` owns observer capture/leases/coalescing. Producer registry/execution remains Runtime state. |
| MCP | Implemented for authorization; otherwise partial | `RuntimeMcpToolAuthorization` is the typed decision capability. Authentication, token leases, AI/token capability construction, and dispatch remain in Runtime. |
| Scheduler | Partial, real SQL owner added | `RuntimeScheduledCandidates` owns due-time/candidate SQL using narrow read/plan/trace capabilities. Timer/run/retry still share Runtime lifecycle and writer coordination. |
| Telemetry | Partial, three real adapters added | `RuntimeTraceBridge`, `RuntimeSampler`, and `RuntimeDeliveryTelemetry` hide operation tracing, sampling, and delivery policy. Runtime still calls Telemetry directly for lifecycle/status/drain. |
| Realtime | No new interface | The existing `RealtimeRuntime` injection and `createRealtimeRuntimeApplication` adapter already form the useful seam. Adding another interface around them would be a one-to-one wrapper until session/publication extraction advances. |

## Measurements

All figures compare this branch to `origin/main` and exclude this report from the implementation totals.

- `runtime/runtime.ts`: 5,227 → 3,677 lines; −1,550 lines (−29.7%).
- Implementation source: +2,553 / −1,940; net **+613** lines.
- Tests: +145 / −88; net **+57** lines.
- Implementation diff: 42 files, +2,698 / −2,028 overall.
- Plugin invocation fix alone: source net −7 lines.
- No performance benchmark was run because this track makes no latency or throughput claim. The sampler cadence, queue bounds, transaction boundaries, and delivery coalescing thresholds are unchanged. New cost is a fixed number of per-Runtime owner objects/maps, not proportional duplicate per-request machinery.

Net-effect scores against the simplest design that preserves the existing invariants:

| Dimension | Score | Judgment |
| --- | ---: | --- |
| Code quality | 7/10 | Material ownership improvement and a 29.7% smaller integration file, offset by +613 source lines and substantial remaining Runtime coupling. |
| Correctness | 7/10 | MCP authorization now has one authoritative decision; session/read/HTTP/SSE invariants have explicit owners; complete boundary suites pass. The untouched execution paths remain as before. |
| Performance | 5/10 | Neutral by design and unbenchmarked. No new polling, background loop, queue, or per-connection machinery was added; no speedup is claimed. |

## Verification

Final verification from the worktree root:

- `bunx tsc --noEmit`: passed.
- `bun test /Users/pedrooscar/personal/dbzz-worktrees/t3-runtime-split/packages/server/test`: **971 passed, 0 failed**, 10,076 expectations across 79 files.
- `bun test /Users/pedrooscar/personal/dbzz-worktrees/t3-runtime-split/packages/cache/test/plugin/cache.test.ts`: **14 passed, 0 failed**, 103 expectations.
- `bun run test:mcp:conformance`: official MCP conformance 0.1.16, **11 checks passed across 10 supported scenarios, 0 warnings**.

Every extraction was committed only after its focused boundary suites passed. The full server suite was also run after the read owner, after the session owner, and at final verification.

## Gains and tradeoffs

Short-term gains:

- Runtime state has named owners for reads, sessions, HTTP responses, tracing, delivery telemetry, sampling, and scheduled lookup.
- MCP transport and execution cannot silently diverge by making two authorization decisions.
- Plugin log/analytics capabilities are bound once per invocation rather than copied through nested bridges.
- The schema definition module no longer reaches into the schema-dependent function implementation.
- HTTP mutation response bytes remain proven inside the transaction and reused after commit; the extraction preserves this durable-correctness boundary.

Long-term gains:

- The remaining write, publication, MCP, scheduler, and lifecycle extractions now have concrete seams to depend on rather than the entire Runtime.
- Tests can target state owners directly instead of requiring a compatibility alias for removed private topology.
- Composition can move last without creating a facade over unchanged coupling.

Losses/tradeoffs:

- Total source grew. The split improves navigability and ownership, but it did not yet satisfy the least-code objective globally.
- `runtime/runtime.ts` remains very large and still imports protocol internals across the server.
- MCP authentication/AI/token capabilities are still misplaced despite authorization moving.
- Some white-box tests had to retarget intentionally private state (`reader` → `reads`, scheduler candidate method → candidate owner). No backwards-compatibility fields were added.
- The L9 estimated negative LoC for MCP authorization was not achieved; the opaque typed capability is safer but costs code.

## Blockers and routing

- The repository instruction referenced `.agents/skills/llm-wiki/SKILL.md`, but that file and an installed equivalent were absent in this worktree. For the MCP SDK boundary, I used the existing repository MCP conformance/exposure documentation and the installed SDK source. No wiki content was written because ingestion was not requested.
- The first baseline full-server run had one transient failure in `database/query/vector-runtime.test.ts` (expected child exit 0, received 22). No vector/native code was changed. Subsequent full runs passed 971/971 repeatedly, including final verification, so it was not routed as an owner blocker.
- No owner-level question blocked the work; `BLOCKED.md` was not created.

## New discoveries

1. Trace scope restoration and operation installation are different contracts. An initial trace-bridge extraction treated both as one method; nested telemetry then reset invocation IDs and produced a span-parent collision. The final bridge exposes `runScope` (restore only) and `runOperation` (trace plus invocation instrumentation), and the telemetry parentage suite proves the distinction.
2. HTTP mutation encoding is a durability boundary, not ordinary response formatting. Successful bodies are encoded and size-checked inside the transaction so a non-representable result rolls the write back; the extracted response owner therefore exposes `encodeBody` separately and reuses the proven bytes after commit.
3. Session and scheduler tests depended on private Runtime topology. The correct response to a real ownership move was to retarget those failure-injection hooks, not retain compatibility aliases.
4. `releaseNothing` is intentional cleanup-shape normalization, not dead code.

## Recommended continuation order

1. Extract write/transaction/procedure execution and commit-publication together; do not split WriteCollector from the coordinator invariant prematurely.
2. Move session operation ordering, adapters, auth transition, and publication onto the new `RuntimeSessionStore` boundary.
3. Extract MCP authentication, token lease, and AI/token capability construction as one MCP runtime owner.
4. Move scheduler execution only after it can receive one scheduled-mutation callback; then extract admission/status/drain.
5. Reduce `Runtime` to composition and public lifecycle ownership last, and remeasure source LoC rather than accepting the current +613-line cost as the final shape.
