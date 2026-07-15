# D3 acceptance-test map

- Issue: [pedrobzz/dbzz#1](https://github.com/pedrobzz/dbzz/issues/1), read through `gh issue view` on 2026-07-13 because the public web URL returned 404 without repository credentials.
- Planned against: `74d8554` (`codex/benchmark-capacity`), with Pedro's pre-existing dirty tree preserved.
- Scope: public behavior tests, deterministic failure fixtures, benchmark gates, and test-file ownership only. No product source or existing test was edited by this packet.

## Outcome

Issue #1 needs a new acceptance layer, not more assertions against `Runtime` internals. The tests should drive installed `@dbzz/*` APIs over real WebSocket/HTTP/SSE sockets, real temporary SQLite files, and real child processes. Faults may be injected through stable dependency seams or a network/process proxy, but pass/fail assertions must use public frames, responses, telemetry, files produced by public backup/restore commands, process exits, and documented health endpoints.

The highest-leverage tracer bullet is:

> verified WebSocket identity -> authorized mutation -> durable monotonic commit -> caller subscription applies the matching transition -> mutation acknowledgement resolves -> one correlated telemetry graph describes the same operation.

That slice forces the shared protocol, server state machine, client state machine, storage acknowledgement, authorization dependency, and telemetry vocabulary to agree before the broader matrix is filled in.

## Current evidence and reusable patterns

| Boundary inspected | Reuse | Gap the acceptance suite must expose |
| --- | --- | --- |
| `packages/core/src/protocol.ts:8-37` | One discriminated wire union and explicit HTTP call body. | No authentication, protocol negotiation, commit/query-set/auth versions, resume/reset, structured outcomes, durability, convergence, or overload fields. |
| `packages/client/src/client.ts:62-100` | One reconnect sender, stable pending mutation frame, exponential backoff with jitter. | Random time and real timers are not injectable; overload hints are ignored; reconnect has no resume state; subscriptions are blindly replayed. |
| `packages/client/src/client.ts:102-133` | Central frame dispatch is the right client transition boundary. | Every update/event is applied without validating predecessor state; duplicate or out-of-order frames are silently accepted. |
| `packages/server/src/runtime.ts:57-79,109-125,168-195` | One runtime boundary feeds query, mutation, procedure, nested transaction, SSE, and scheduled work. | Every path receives the same hard-coded anonymous object; no verifier, authorization outcome, refresh, revocation, or auth dependency exists. |
| `packages/server/src/runtime.ts:75-77,139-165,317-329` | Idempotency result is written in the application transaction, then post-commit work runs before `runMutation` returns. | Dedupe is keyed only by `mid`, old rows are deleted at startup after one hour, and no function/args/session fingerprint or public retry window is checked. There is no persisted commit version/durability receipt. The writer mutex is released before `afterCommit`, so post-commit paths from successive commits can overlap. `send` means queued to a socket, not applied by the caller. |
| `packages/server/src/runtime.ts:270-315` | Shared `(query,args)` entries, tracked reads, result comparison, and fanout are valuable foundations. | A listener is attached while its entry has no read set, then initial recompute runs. A commit during that window may not match the empty dependency set; overlapping recomputes have no version guard and can publish stale state. |
| `packages/server/src/runtime.ts:47-55` | A single writer admission point already exists. | The promise-tail mutex is unbounded and has no queue limit, age, fairness, cancellation, retry hint, or observable depth. |
| `packages/server/src/reactive.ts:31-65` | Central subscription maps make exact resource accounting possible. | Entries, listeners, event listeners, and revalidation work have no limits or identity/auth partition. |
| `packages/server/src/serve.ts:18-28,132-176` | A single WebSocket subscriber owns all outbound frames; raw WS tests can exercise it. | `ws.send` results/backpressure are ignored, there is no queued-byte budget, admission/drain state, connection limit, close reason, auth state, or structured error code. |
| `packages/server/src/runtime.ts:199-265` | SSE already uses an abort signal and a real `ReadableStream`. | `controller.desiredSize` is ignored; a producer can outrun an unread response; errors are console strings and can include application data. |
| `packages/server/src/serve.ts:76-130` | HTTP, SSE, WebSocket, and health share one real `Bun.serve`. | `/health` always returns `{ok:true}` (`:85`) and cannot distinguish liveness, readiness, startup reconciliation, database failure, or drain. |
| `packages/server/src/runtime.ts:81-85` | One public `stop()` call is the natural runtime shutdown owner. | It only marks stopped and clears the scheduler timer; it does not stop admissions, drain work, close subscriptions/streams, flush telemetry, or report a deadline outcome. |
| `packages/server/src/engine.ts:106-125,361-364` | Real WAL file, separate reader/writer, internal metadata, and explicit close. | Durability is fixed to `WAL` + `synchronous=NORMAL`; no observable mode, integrity gate, checkpoint policy, backup, restore, commit journal, or resume history. |
| `packages/cli/src/app.ts:73-95` and `packages/cli/src/main.ts:107-130` | `startApp` centralizes schema import, reconciliation, runtime, transport, and the ready log; the dev supervisor already listens for signals. | `startApp` serves only after reconciliation, so startup liveness cannot be observed; production `start` has no drain signal path, while dev signal handling only kills its child and exits. |
| `packages/server/test/db.test.ts:318-325` | Proves readers see only committed WAL state. | It does not prove crash survival, configured durability, monotonic commits, corruption rejection, or acknowledged restart behavior. |
| `packages/server/test/reconcile.test.ts:49-315` | Temporary-file reopen tests and all-or-nothing unsafe reconciliation are strong storage-fixture patterns. | Reconciliation is not represented in readiness and has no subprocess startup-failure coverage. |
| `packages/client/test/client.test.ts:74-90,93-180` | Real ephemeral server/client, temporary DB cleanup, end-to-end public APIs, hard socket drop/restart on the same port. | Reconnect uses fixed sleeps (`:90,101,178`), reuses the same `Runtime` and `Engine`, and proves neither process restart nor resume/reset/lost-ack ordering. |
| `packages/server/test/serve.test.ts:124-175` | The raw frame queue is a good wire-contract starting point. | It accepts whichever order three frames arrive and asserts `runtime.subs.size` (`:154-174`), so it does not prove ordered public transitions and is not black-box. |
| `packages/server/test/runtime.test.ts:23-36,176-327` | Characterizes direct transaction, shared subscription, event, procedure, SSE, and scheduler behavior. | `TestSub` and direct `Runtime` calls are white-box; exactly-once is same-process only (`:189-195`); scheduler and SSE tests use wall-clock sleeps. |
| `packages/cli/test/cli.test.ts:10-51,72-135` | Reusable child-process registry, stdout drain, deadline wait, free-port probe, real CLI restart, and temp app fixture. | Cleanup only sends a normal kill; there are no SIGTERM drain, SIGKILL crash, readiness, corruption, durability, listener-leak, or backup/restore assertions. |
| `bench/load-engine.ts:49-95` | Exact closed-loop accounting and bounded drain timeout. | It does not carry telemetry mode or reject a run whose server started in the wrong mode. |
| `bench/workload.ts:91-127,168-240,386-649` | Strong state/checksum validation and exact subscription delivery accounting. | Current mutation acknowledgement and subscription delivery are measured separately; benchmark correctness does not prove DBZZ's new ack-convergence contract or telemetry aggregate accounting. |
| `bench/run.ts:70-89,149-274,744-805` | Port preflight, real process trees, `finally` cleanup, resource windows, and centralized result rejection. | No post-cleanup port/process assertion, no DBZZ telemetry-on/off pair, no exporter cost/mode evidence, and the pure validator is trapped in a top-level runner file. |
| `packages/server/test/functions.check.ts:31-70` and `packages/cli/test/codegen.test.ts:64-89` | Compile-time inference and generated type checks already avoid runtime output schemas. | Production-contract type assertions should live in a new file so protocol work cannot accidentally add required output declarations. |

Existing schema, validator, database CRUD, engine codec, wire codec, and reference tests remain useful characterization coverage, but are not substitutes for the new cross-boundary guarantees.

## Acceptance-test rules

1. **Observe public effects.** Tests may configure a verifier, clock, scheduler, durability provider, or exporter through a real constructor/configuration seam. They may not pass by reading `Runtime.subs`, private maps, private queue arrays, or private method calls. Operational counts are asserted through the documented telemetry/health surface.
2. **Use semantic barriers, never timing luck.** A test waits until a named acceptance stage is entered, performs the competing action/fault, and explicitly releases it. `Bun.sleep` is allowed only when the duration itself is the subject (deadline, retention, backoff spread, event-loop delay), never as a substitute for readiness or delivery.
3. **Drive real transports and files.** At least one case for every guarantee crosses TCP and uses a file-backed temporary SQLite database. Pure protocol/client tests supplement this; they do not replace it.
4. **Fresh process means fresh process.** Crash/recovery, idempotency replay, startup, corruption, backup, and restore tests must replace `Runtime`, `Engine`, and Bun process. Restarting `serve()` around the same objects is insufficient.
5. **Bound proofs use exact counters plus RSS.** Public gauges prove queue/item/byte limits exactly. Process RSS/FD sampling proves that a long flood plateaus and cleans up; RSS alone is too noisy to establish a bound.
6. **Errors are data.** Assert exact stable outcome code, retryability, optional retry delay, transport status/close code, and absence of protected details. Matching a free-form error substring is not acceptance coverage.
7. **No compatibility branch.** Protocol tests assert only the issue #1 contract and explicit unsupported-version rejection. They must not require v1 frames to remain accepted.
8. **No payload output schema.** Runtime return values remain inferred. Tests may validate protocol envelopes and telemetry schema, not require application result validators.
9. **Every child and socket is accounted for.** Each test owns an `AbortController`, deadline, child registry, socket registry, temp directory, and port probe. Teardown waits for exit/close and asserts no listener remains.

## Deterministic shared fixtures

These fixtures are test infrastructure, not alternate product paths. Their APIs should freeze before suite authors fan out.

| Fixture | Required capability | Why deterministic |
| --- | --- | --- |
| `ProductionApp` | A temporary app with protected/public query, mutation, procedure, SSE, scheduled handler, nested query/mutation/transaction, changed/unchanged subscription, event stream, deliberate failure, and secret-canary paths. It starts through public CLI/config and returns URLs plus temp paths. | One app exercises every transport against the same schema and identity policy; no suite invents a subtly different contract. |
| `ProcessHarness` | Spawn CLI with fully drained stdout/stderr, wait for structured ready/lifecycle events, signal `SIGTERM` or `SIGKILL`, wait for exit, restart same data directory/port, count FDs/handles, and assert ports free afterward. | Every state transition is acknowledged by process output/endpoint state, not a sleep. Extend the proven pattern at `packages/cli/test/cli.test.ts:10-51`. |
| `SemanticGate` | `arm(stage)`, `waitEntered(stage)`, `release(stage)`, and `releaseAll()`, with abort/deadline. Stable stages are contract vocabulary: auth verification; subscription snapshot capture/publication; SQL commit durable; commit publication; revalidation queued/evaluated; transition queued; socket write; ack write; drain; backup snapshot. | Races are forced at the exact semantic boundary. Stage names must match documented telemetry stages, not source function names. Product code gets the gate through the owning scheduler/storage/transport dependency, never a second behavior branch. |
| `FrameProxy` | Real TCP WebSocket/HTTP proxy that can pause either direction, record decoded envelopes, drop connection, drop one matching frame, duplicate, reorder, corrupt versions, and release frames in chosen order. It must preserve bytes when no fault is armed. | Lost acknowledgements and malformed/out-of-order delivery are controlled without reaching into client/server internals. |
| `UnreadPeer` | Raw WebSocket handshake and raw HTTP/SSE request whose receive side can stop consuming while the server continues producing. | Browser/Node WebSocket implementations may drain the kernel automatically; an actual unread TCP peer makes backpressure real. |
| `ManualClock` + `SeededRandom` | Public client/runtime dependency for token expiry, reconnect, retry-after, retention, and shutdown deadlines; exposes scheduled tasks without running them until advanced. | Refresh/retry tests assert exact schedules and jitter distribution without waiting seconds or depending on `Math.random`. |
| `TestOidcIssuer` | In-process HTTP issuer/JWKS with fixed generated test keys; issue tokens with chosen issuer, audience, subject, claims, `exp`, `nbf`, `kid`, and algorithm; rotate/revoke keys; count discovery/JWKS requests; stall/fail endpoints. Never record token contents. | Auth failures and rotation are local, repeatable, and prove unknown issuers cannot trigger arbitrary discovery. |
| `OtlpReceiver` | Local backend-neutral receiver that stores raw request bytes and decoded traces/metrics/logs; can acknowledge, return errors, close, or hold requests behind a barrier; exposes received batches to tests only. | Telemetry correlation/privacy/export failures are observed at the export boundary and can be stalled indefinitely without stalling application work. |
| `ResourceProbe` | Reuse `ProcessTreeMonitor` and add listener/FD snapshots plus public metric scraping. Capture baseline, saturated epochs, drain, and post-close state. | Exact public gauges are paired with external process evidence and the same sampling method as the benchmark. |
| `Eventually` | Poll a public predicate/event until deadline with the last observed state in the error. | Replaces fixed sleeps while preserving actionable failures. It must never silently extend the test timeout. |

The semantic gate is the only fixture that can pause inside a product state machine. If an implementation cannot expose that pause through the real owning abstraction, stop and fix the boundary; do not add a test-only duplicate commit/revalidation path.

## Prioritized tracer-bullet slices

| Priority | Slice | Minimal acceptance proof | Dependencies |
| --- | --- | --- | --- |
| P0-A | Secure convergent mutation | Valid WS identity subscribes to its protected row, mutation commits at `N`, client applies `N-1 -> N`, mutation resolves only afterward, query reads the row, and OTLP data correlates request/transaction/commit/revalidation/delivery without canaries. | C1 protocol + smallest S1/C2/T1 vertical path. |
| P0-B | Lost ack + process crash | Proxy drops the mutation ack after an observer proves commit `N`; process is `SIGKILL`ed; same client/request ID reconnects to a new process; effect exists once, stored outcome replays, and client safely resumes or resets before resolving. | P0-A plus durable idempotency/commit history. |
| P0-C | Live revocation | Two identities subscribe to protected projections; authorization data changes at commit `N`; affected identity gets an ordered redaction/reset while unaffected identity progresses; old token and failed refresh cannot retain access. | P0-A plus auth dependency/revalidation. |
| P0-D | Bounded slow consumer under exporter outage | Tiny outbound/revalidation/telemetry limits; one unread peer and one stalled OTLP receiver are flooded while a healthy connection continues. Exact queue gauges never exceed limits, the slow peer gets the documented close/reset, exporter drops are visible, and healthy commit/delivery succeeds. | Shared limits + async telemetry. |
| P1-A | Drain and durable restart | Under admitted query/mutation/subscription load, `SIGTERM` flips readiness, refuses new work, completes or explicitly terminates admitted work, closes streams with documented outcome, exits by deadline, and acknowledged FULL-mode data survives restart. | Lifecycle + P0-A. |
| P1-B | Backup/restore | Public online backup captures rows plus live metadata; restore to an empty directory starts ready, serves the exact state, replays a backed-up mutation ID once, chooses documented resume/reset behavior, and accepts a new commit. | Lifecycle/storage contract. |
| P1-C | Complete telemetry graph | Invoke every public path and every subscription result/outcome, force one timing stage at a time, then assert documented schema, correlation, low cardinality, local output, privacy, slow/failure retention, and fail-open export. | T1 complete instrumentation. |
| P1-D | Paired benchmark | Same DBZZ workload runs once with default telemetry and once disabled, both pass state/delivery/accounting/mode gates, and a full 3-way run records paired overhead plus prior-win comparisons. | P1 benchmark work after behavior suites. |
| P2 | Type/docs limitations | Compile-time inference remains intact, runtime output schemas remain absent, and docs explicitly state durability and single-node/multi-node limitations. | Final contract/docs. |

## Suite A: authentication and authorization

### A1. Credential-validation matrix

Run the same protected identity-echo and protected-data behavior through WebSocket query, WebSocket mutation, WebSocket subscription, HTTP query/mutation/procedure, SSE procedure, scheduled invocation, and nested query/mutation/transaction execution.

| Credential state | Public assertions on every applicable path |
| --- | --- |
| Explicit anonymous | Handler sees the one documented anonymous shape, never an empty verified identity. Public operations may succeed; protected operations return `unauthenticated`. |
| Valid end-user token | Exact normalized issuer/subject and allowed normalized claims reach the top-level handler. Nested calls receive the same immutable principal/auth epoch and cannot replace or broaden it. |
| Valid workload token | Scheduled work and service calls receive the configured workload principal and scope, not the user who originally created a schedule row. A schedule without a valid configured principal fails closed and records an explicit outcome. |
| Malformed/bad signature/unknown `kid`/wrong algorithm | `unauthenticated`; no handler, transaction, subscription, or protected detail is observable. |
| Unknown issuer | `unauthenticated`; the issuer fixture proves no discovery/JWKS request was made to an unconfigured destination. |
| Wrong/missing audience or required claim | `unauthenticated`; omission never turns the call anonymous or authorized. |
| Expired or not-yet-valid | `unauthenticated` using `ManualClock` at the exact boundary; no wall-clock sleep. |
| Revoked token/session/key | Existing and new operations fail closed. An active subscription is revalidated/revoked at a monotonic auth/commit transition. |
| Verifier/JWKS timeout or internal exception | `auth_unavailable` or the documented fail-closed authentication code, retryability exactly asserted; never a successful anonymous fallback. |

For HTTP, assert status and structured body (`401` unauthenticated, `403` unauthorized, subject to C1's final stable mapping). For WebSocket, assert the structured error/close code and that the connection cannot issue protected work before authentication completes. For SSE, assert a pre-stream HTTP error when authentication fails and an explicit terminal outcome if revocation is part of the accepted long-stream contract. Error bodies must not disclose whether a protected row/function exists.

### A2. Authentication refresh and identity change

1. Authenticate WS as principal A and subscribe to A-only and public queries.
2. Advance the clock to the refresh window. A deterministic token getter records `forceRefreshToken`, returns a rotated token for A, and receives server confirmation. The socket stays live and relevant subscriptions do not leak or duplicate.
3. Refresh to principal B/changed organization/changed role. Gate revalidation, commit another update, and prove the client applies an auth-epoch transition in order: A-only data is removed before B-only data is exposed; unchanged public data is not needlessly reset if the contract proves it safe.
4. Sign out to explicit anonymous. Protected subscriptions revoke/reset; subsequent protected calls are unauthenticated.
5. Return invalid/expired token and stall verification. The old identity cannot continue indefinitely; at expiry/revocation the connection fails closed and no protected transition is accepted.
6. Reconnect during refresh and duplicate the authenticate frame. One auth epoch wins deterministically; stale verification completion cannot overwrite a newer identity.

HTTP refresh is a new request with a new bearer token. SSE refresh is a new authenticated stream unless C1 defines a separate control channel; tests must not pretend an SSE response is bidirectional. Scheduled workload identity rotation is tested by scheduling before rotation and executing after rotation/expiry.

### A3. Authorization and revocation

- Distinguish `unauthenticated` from `unauthorized` for every function kind and transport, while returning the same protected-resource opacity for unauthorized IDs.
- Change a role, organization membership, row ownership, or policy version in a committed mutation. Only subscriptions whose authorization dependency changed revalidate; all affected subscriptions stop exposing stale rows.
- Concurrently refresh identity and commit an authorization change behind gates. Regardless of completion order, the client applies only the transition whose `from` auth/commit state matches; otherwise it resets.
- A policy exception/throw is `unauthorized` or `authorization_error` per the public contract and always fails closed. It must not be swallowed into an empty successful result.
- A nested query/mutation or explicit procedure transaction cannot supply a different principal; scheduled handlers cannot inherit an end-user bearer token from persisted arguments.

## Suite R: ordered realtime, resume/reset, and acknowledgement convergence

### R1. Wire/state-model cases

Use both a raw public WebSocket client (exact envelope assertions) and `DbzzClient` through `FrameProxy` (client enforcement assertions).

| Case | Deterministic setup | Required observation |
| --- | --- | --- |
| Initial empty/non-empty snapshot | Subscribe at known commit `N`. | One authoritative transition identifies its predecessor/reset base and `to` commit/query-set/auth versions. No unversioned update is accepted. |
| Commit during setup | Pause after snapshot capture at `N` but before publication/registration is complete; commit `N+1`; release. Repeat with pause immediately before capture. | Client observes authoritative `N` then `N+1`, or one authoritative snapshot at `N+1`; it never ends at stale `N` and never silently misses the commit. |
| Multiple commits in flight | Block delivery after `N`, commit `N+1..N+3`, then release in server order. | Applied transitions form a contiguous chain. Coalescing may skip payload work only if the envelope explicitly transitions from the client's known state to the authoritative newer state. |
| Concurrent changed/unchanged recomputes | Gate older recompute completion, let newer commit/recompute finish, then release the older one. | Older computation cannot overwrite/publish after the newer version. `unchanged` is observable in telemetry but does not invent a client transition unless the protocol requires one for commit convergence. |
| Duplicate frame | Proxy duplicates a valid transition and ack. | Effect/callback/optimistic reconciliation happens once; duplicate is ignored only after validating it is already applied. |
| Out-of-order frames | Proxy delivers `N+1 -> N+2` before `N -> N+1`, then releases the missing frame. | Client never exposes `N+2` best-effort. It requests/accepts reset (or buffers only within an explicitly finite documented bound) and converges. |
| Corrupt predecessor/query-set/auth version | Modify exactly one predecessor component. | Client rejects the transition, emits diagnostic/reset behavior, and receives an authoritative snapshot. |
| Unknown protocol version/frame | Send future/invalid envelope. | Explicit unsupported/malformed outcome and safe close/reset; no compatibility guess. |

### R2. Reconnect transition-point table

For each row, arm a proxy/gate, hard-drop the socket, and keep assertions event-driven:

1. before the subscription request is written;
2. after request write but before server acceptance;
3. after snapshot capture but before snapshot frame;
4. after snapshot frame is queued but before client receives it;
5. before a mutation request is written;
6. after mutation request but before SQL commit;
7. after durable commit but before commit publication;
8. after transition queue/write but before client application;
9. after client application but before mutation acknowledgement;
10. after acknowledgement is written but before received;
11. during resume handshake;
12. during reset snapshot.

At every point, final query/subscription state equals the authoritative database, mutation effect count is correct, applied versions are monotonic, no callback observes a regressing state, and every pending promise resolves/rejects exactly once with the documented outcome.

### R3. Resume and reset

- Disconnect at version `N`, make commits `N+1..N+k` inside the configured retained history, reconnect with the last applied state, and assert a proven resume chain with no full snapshot and no duplicate application.
- Repeat after pruning the needed history, changing schema/query-set/auth epoch, or providing an unknown client/session state. Assert an explicit reset plus authoritative snapshot, never guessed deltas.
- Resume two subscriptions with shared server computation but different client/query-set/auth states; sharing must not cross authorization or version identity.
- Reconnect a slow consumer after its outbound history/byte budget was exceeded. It resets or is disconnected exactly as documented, with finite server state.
- Events and live queries get separate enforced semantics. Query state must resume/reset. Ephemeral event streams must carry a version/gap indicator or explicitly reset/drop according to the documented contract; they must never masquerade as durable query state.

### R4. Read-your-writes acknowledgement

- With a relevant mounted subscription, pause its transition before client dispatch. The SQL commit and another observer query may succeed, but the caller's mutation promise must remain pending. Release/application of the commit-bearing transition, then the promise resolves with its stored result/receipt.
- With no relevant subscription, the promise resolves after the configured durability boundary and explicit server acknowledgement; it must not wait for unrelated subscriptions.
- With relevant changed and unchanged results, define and test convergence: a changed result requires application; an unchanged result needs a version/convergence marker proving the client is at or beyond the commit without shipping a duplicate payload.
- If the caller unsubscribes, loses authorization, is reset, disconnects, or is declared a slow consumer while waiting, assert the exact terminal rule. No promise can remain unbounded; no weaker acknowledgement may be relabeled successful.
- Two mutations with interleaved commits and subscriptions resolve in commit/application order unless their relevant sets are independent and the public receipt proves safe independence.

## Suite E: exactly-once mutation effects and non-retried procedures

| Case | Fault | Assertion |
| --- | --- | --- |
| Lost WS ack | Drop the first ack after an observer sees committed state; reconnect same `DbzzClient`. | Same stable request ID is resent, handler effect count remains one, stored result/commit receipt is identical, promise settles once after convergence. |
| Disconnect before commit | Drop caller socket while mutation is gated before SQL commit, then release. | Retry yields one committed effect whether the first process committed or rolled back; no ambiguous duplicate. |
| Process interruption before commit | `SIGKILL` while gated before commit, restart fresh process, retry. | No partial state/idempotency row; one retry effect. |
| Process interruption after durable commit/before ack | Gate/drop ack after durable stage, `SIGKILL`, restart, retry. | Committed state and idempotency outcome survive the promised restart boundary; one effect and same result/version. |
| Duplicate concurrent request | Send identical `(session,requestId,function,args)` concurrently on two connections. | One execution; both receive the same outcome/commit identity and converge. |
| Request ID reused with different function/args/session semantics | Replay the ID with one field changed. | Stable conflict/invalid-request outcome; never return an unrelated prior result and never execute the altered request. |
| Handler failure/rollback | Fail after writes but before commit, then retry same ID. | No partial application. The contract explicitly defines whether a deterministic failure is durably replayed; tests assert it rather than relying on TTL timing. |
| Retention boundary | Advance manual clock across configured idempotency retention while a client/session is still eligible to retry. | The server either retains the outcome for the documented retry window or rejects an unverifiable retry; it never re-executes silently. |
| HTTP mutation replay | Manually send the same public mutation ID before/after restart. | Same exactly-once semantics as WS, including mismatch rejection. |
| Procedure response loss | Procedure performs a visible external-fixture side effect, proxy drops response. | Client receives failure/indeterminate outcome and does not automatically retry. An explicit application retry performs a second call, proving policy belongs to the application. |

Current same-process checks at `packages/server/test/runtime.test.ts:189-195` and `packages/server/test/serve.test.ts:83-92` remain characterization tests; they do not satisfy the process/lost-ack rows above.

## Suite O: bounded overload, fairness, slow consumers, and retry behavior

All overload tests use deliberately tiny public limits so a few operations reach the boundary. A limit is accepted only when its public gauge never exceeds the configured count/bytes and its external process footprint plateaus.

### O1. Independent and combined saturation matrix

| Bounded resource | How to saturate it deterministically | Exact assertions |
| --- | --- | --- |
| Connections, per server and per identity/IP if configured | Hold the maximum authenticated sockets open, then attempt one more valid upgrade and one malformed/unauthenticated upgrade. | Maximum active gauge equals the limit; excess upgrade gets documented HTTP/WS rejection and retryability; rejected peers allocate no subscription/operation state; an existing healthy peer progresses. |
| In-flight operations by class | Gate query, mutation, procedure, and SSE handlers after admission; fill each limit independently. | Excess work gets the operation-specific overload outcome. Query capacity cannot consume all mutation/drain control capacity unless the documented global limit says so. Cancellation frees one slot exactly once. |
| Writer queue count and age | Hold one admitted writer at the execution gate, fill the finite queue from a hot connection, then issue work from a cold connection. | Queue depth never exceeds limit, queue-age metric rises, exact retryable outcome includes bounded retry guidance, and cancellation/deadline removes queued work without execution. |
| Subscriptions per connection and global | Open unique and shared `(query,args)` subscriptions up to each limit. | Both logical listeners and shared computation entries are bounded/observable; excess subscribe gets exact non-retryable or retryable outcome; disconnect/unsubscribe returns counters to baseline. Shared entries cannot bypass listener limits. |
| Pending invalidations/revalidations | Gate revalidation, commit repeatedly to one hot dependency and unrelated cold dependencies. | Pending count remains finite; same-entry work coalesces safely to an authoritative newest version; unrelated entries receive fair service; overflow produces explicit reset/rejection, not a missed silent update. |
| Outbound frames/bytes per client and global | Use `UnreadPeer`, fan out fixed-size results/events until byte high-water mark. | Queued bytes never exceed configured budget; the slow peer receives the documented disconnect/reset/gap outcome; its state is released; healthy peers get exact transitions. |
| SSE producer/bytes | Start a fixture SSE producer, stop reading its raw TCP response, and continue producing until the limit. | Producer observes cancellation/backpressure outcome, buffer gauge stays bounded, request terminates or is disconnected as documented, and memory plateaus. |
| Telemetry batches/items/bytes | Stall `OtlpReceiver`, generate every operation until the queue limit. | Application work stays correct; telemetry queue never exceeds limits; dropped/coalesced counts and exporter health are visible; no application outcome becomes an exporter error. |
| Combined saturation | Fill writer, revalidation, outbound, and telemetry queues while connection limit is near full. | Each resource retains its own bound and outcome; control/liveness/drain paths still operate; there is no multiplicative hidden queue between stages. |

For every rejection, assert the C1 outcome tuple rather than a message substring: stable code, `retryable`, optional `retryAfterMs`, resource class, and transport mapping. A non-retryable authorization/validation failure must never be retried merely because the server is overloaded.

### O2. Fair progress

- **Across connections:** hot connection A fills its admitted work; cold B submits one operation. Release one execution turn at a time. B must start within the documented maximum number of turns, not merely “eventually”.
- **Across subscription groups:** one shared hot query receives continuous invalidations while a disjoint cold query receives one. Gate evaluation and assert the cold group publishes within the fairness bound.
- **Across operation classes:** saturate queries and prove a health request plus an already-admitted mutation/drain control path progresses. Repeat with mutations while an ordinary query can be admitted according to the configured class budgets.
- **Cancellation:** cancel queued A work before its turn. Capacity is reassigned without executing A or skipping B.
- **Tenant/identity isolation:** where limits are scoped, one identity cannot consume another identity's reserved/global fair share. Do not infer fairness from average latency; assert start-order events from the public telemetry stages.

### O3. Finite-memory/resource proof

1. Record exact queue gauges, RSS, FDs, connection count, and database/WAL size at idle.
2. Run one warm-up saturation/drain epoch so allocator caches stabilize.
3. Run at least five equal flood epochs well beyond each configured logical limit. At every sample assert exact gauges are within limits. Record per-epoch RSS/FD peaks.
4. A bound is accepted when later-epoch RSS/FD peaks form a plateau within a documented allocator/sampling tolerance derived from the configured byte budgets, not when one short run “looks flat”. A strictly growing per-epoch slope fails.
5. Release/cancel/close everything; eventually assert gauges and FDs return to baseline-equivalent state and no listener remains. RSS need not return byte-for-byte, but retained growth may not scale with total attempted work.

`bench/process-tree.ts:148-270` supplies the RSS/CPU method. Add external FD/listener sampling to `ResourceProbe`; do not add a second process-accounting definition.

### O4. Client reconnect/backoff

- With `ManualClock` and `SeededRandom`, disconnect 100 clients simultaneously. Assert no timer fires before the base delay, retries spread across the configured jitter window, exponential growth/cap are exact, and successful open resets the backoff.
- Return retryable overload with `retryAfterMs`; no client retries before the server floor, and jitter still prevents a synchronized edge.
- Return non-retryable unauthenticated/unauthorized/validation/procedure outcomes; assert no automatic retry.
- Toggle network-online control and close/reopen around scheduled timers. There is at most one live reconnect attempt/timer per client and `close()` cancels all work.
- Keep a pending mutation through overload/reconnect with the same request ID; procedures and SSE invocations are never automatically duplicated.

## Suite L: liveness, readiness, drain, shutdown, crash, and durability

### L1. Liveness/readiness state table

| Process state/fault | Liveness | Readiness | Other required observation |
| --- | --- | --- | --- |
| Process started, database not yet opened | 200 once the HTTP control surface is running | non-200 `starting` | Normal application admission rejected. |
| Reconciliation/integrity gate paused | 200 | non-200 with safe stable reason | Release leads to ready; no request observes half-reconciled schema. |
| Ready | 200 | 200 with safe durability/mode/schema identity | Real query and mutation succeed. Response contains no secrets or unbounded labels. |
| Database inaccessible/locked beyond startup policy | 200 if process/control loop is alive | non-200 | Work fails explicitly; no anonymous fallback or auto-reset. |
| Corruption detected | Either process exits nonzero before opening or stays live/non-ready per documented startup mode | never ready | Diagnostic identifies corruption category without leaking row payload; database is not overwritten. |
| Draining | 200 until exit | non-200 `draining` immediately | New application admissions rejected; already admitted work follows drain contract. |
| Stuck handler past deadline | 200 until forced termination | non-200 | Handler is cancelled/terminated with documented outcome; process exits within configured deadline. |
| Stopped/crashed | connection refused | connection refused | Port and child tree are gone. |

Readiness must cover database access, startup reconciliation/integrity, commit/history initialization, and drain. It must not be a renamed constant `/health`; current behavior is unconditional at `packages/server/src/serve.ts:84-86`.

### L2. Graceful drain under load

1. Admit a gated query, mutation before SQL commit, mutation after durable commit/before caller convergence, procedure, SSE stream, query subscription, and queued overload work.
2. Send `SIGTERM` through `ProcessHarness`; wait for readiness `draining` and the lifecycle event.
3. Assert new WS upgrade/HTTP/SSE/operation admissions get the documented shutdown outcome. Liveness remains available.
4. Release admitted work in a controlled order. Assert pre-commit mutation either commits and converges or rolls back with the explicit shutdown outcome; never acknowledge weaker durability. Post-durable mutation retains its outcome and settles according to the convergence/disconnect rule. Query/procedure finish or cancel exactly once. SSE and subscriptions get documented terminal/close reasons.
5. Assert bounded drain queues shrink, telemetry flush uses its own finite budget, SQLite/WAL handles close, and the process exits before the deadline.
6. Repeat without releasing one gate. At deadline the process still exits; restart proves only mutations that received the promised acknowledgement survived.

### L3. Crash/restart and durability profiles

Test every public durability mode separately and record its exact promise. At minimum:

- The production/full mode acknowledges only after the configured SQLite durability boundary. After receiving ack, immediately `SIGKILL`, restart a new process on the same files, run integrity check/startup gate, and assert row plus idempotency outcome and commit version survive.
- Kill after SQL work but before the durability/ack stage. Restart must show either the entire commit plus replay outcome or no commit; never partial rows/metadata.
- Kill after durable commit but before ack and retry as Suite E. This is the critical proof that acknowledged and indeterminate requests differ.
- Repeat a sequence of committed mutations and subscriptions, kill, restart, and assert monotonic commit versions never regress/reuse.
- Production docs/readiness/telemetry must identify the configured durability profile. The benchmark-oriented mode cannot report the production guarantee.

A normal process crash does not emulate physical power loss. The test and docs must state which part is proven by `SIGKILL`, which SQLite guarantee supports power-loss claims, and which weaker modes may lose an acknowledged commit on power failure. Do not create a fake “power failure” test by deleting arbitrary files after a clean close.

### L4. Corruption rejection

Use only disposable fixture data. Cleanly stop a seeded process, preserve the original, then independently corrupt the database header, truncate the DB, corrupt/truncate WAL state relevant to the supported recovery contract, and alter internal schema/commit metadata. Start a fresh process for each case. It must reject or remain non-ready with a stable outcome, never create a fresh empty database over the damaged path. Restore the preserved copy only by public restore flow, not a test-side silent fallback.

### L5. Startup reconciliation

Lift the proven all-or-nothing cases from `packages/server/test/reconcile.test.ts:49-315` to subprocess/public readiness:

- identical schema -> ready without mutation;
- safe schema change -> readiness stays false until atomic apply, then data and IDs remain;
- unsafe change -> process exits/non-ready and original schema/data stay usable by the old app;
- injected process kill during reconciliation -> restart observes old or fully new schema, never a half-applied state.

## Suite B: online backup and restore

### B1. Happy path with live metadata

1. Start a real process in production durability mode; create rows, enum/tag metadata, scheduled work, subscription/commit history, and a mutation idempotency outcome.
2. Keep read/write traffic active and pause the public backup operation at its documented snapshot stage. Commit before and after that stage to define the backup cut.
3. Finish backup. Public verification must run SQLite integrity plus DBZZ metadata/schema/version validation and produce a safe manifest/checksum.
4. Restore through the public command/API into a fresh empty directory; starting over non-empty state without explicit replace authority must fail.
5. Start a new process from the restore. Query exact expected state at the backup cut, retry the backed-up mutation request ID (one effect), exercise documented resume/reset behavior from the restored history, execute due scheduled work exactly once according to the backup contract, and make a new commit with a greater version.

### B2. Failure cases

- Abort/cancel backup, fill destination disk through a faulting storage adapter, make destination unwritable, or crash the backup process. No artifact may be advertised verified; source service remains correct and ready unless the documented policy says otherwise.
- Modify/truncate the backup artifact/manifest. Verification and restore reject it before serving traffic.
- Restore with mismatched application schema or unsupported backup version. Fail closed with a clear outcome; no compatibility shim.
- Stall backup while normal commits continue. Queue/memory/lock duration remain within the documented backup budget, and readiness reflects any intentional write pause.
- Backup/restore lifecycle telemetry correlates outcome, duration, bytes, schema/commit identity, and safe file role without paths containing secrets or row payloads.

## Suite T: telemetry coverage, correlation, stages, privacy, failure, and cardinality

The primary fixture is the backend-neutral `OtlpReceiver`. A subprocess test separately captures the documented local development output. Assertions are against the published telemetry schema and exported signal relationships, not a specific SDK's internal span objects.

### T1. Public operation coverage matrix

Invoke every row once successfully and once with its important non-success outcome. For each row, require at least one root operation signal, the listed stage/relationship signals, aggregate metrics, and trace-correlated structured lifecycle/error events where applicable.

| Public path | Required observable coverage |
| --- | --- |
| WebSocket query and HTTP query | Transport/admission queue, handler, statement/storage work, rows/result bytes when knowable, encoding, network delivery, final outcome. |
| WebSocket and HTTP mutation | Admission, writer queue wait, handler, statements/storage, commit or rollback, durability mode/stage, idempotency `new`/`replayed`/`conflict`, affected dependency count, post-commit work, convergence wait, ack delivery. |
| HTTP procedure | Root procedure plus nested query, mutation, explicit transaction, fetch/external call, success/failure; nested operations share trace and immutable auth context. |
| SSE procedure | Admission/handler, each streamed-work aggregate, queue/backpressure/delivery, cancellation/slow consumer/error/normal terminal outcome. Do not span/log every chunk by default if that creates unbounded signal volume. |
| Scheduled invocation | Scheduler lag/queue, workload identity, handler, nested transaction/calls, success/failure/cancel, deletion/reschedule outcome. |
| Explicit transaction | Writer queue, execution, statement summary/count, storage, commit/durability or rollback, dependency count, post-commit. |
| Initial query subscription | Admission, initial evaluation, dependency count, result size, changed snapshot, encode/fanout/queue/delivery. |
| Invalidation/revalidation | Commit link, invalidation match count, queued age, evaluation, dependency/result comparison, `changed`/`unchanged`/`error`, fanout count. |
| Subscription delivery | Commit/revalidation links, encode bytes/time, fanout, per-destination queue/delivery lag/failure/reset/slow-consumer outcome. Metrics aggregate; high-card destination IDs stay out of labels. |
| Event subscription | Event commit/version or documented ephemeral gap semantics, fanout/queue/delivery/drop/reset. |
| Authentication/authorization | Safe provider class/auth outcome/policy outcome/auth epoch transition; never token, raw claims, subject/user ID in metrics, or protected-resource detail. |
| Overload/lifecycle/recovery | Rejection resource class, queue saturation, readiness transitions, drain, crash-recovery/startup integrity, checkpoint/WAL, backup/restore, exporter health. |

Required outcomes include success, validation failure, unauthenticated, unauthorized, overload retryable/non-retryable, cancelled, deadline, rollback, replayed, idempotency conflict, reset, slow consumer, internal failure, and exporter drop/failure where applicable. Stable operation/function/outcome/resource dimensions must use only documented bounded vocabularies.

### T2. Correlation graph

For the P0-A tracer bullet, reconstruct and assert this graph from exported signals:

```text
inbound request trace/request context
  -> auth verification/policy
  -> function handler
  -> writer queue + transaction + statements + durable commit N
       -> async link: invalidation match
         -> revalidation
           -> encode/fanout
             -> subscriber queue/delivery/application/convergence
  -> mutation acknowledgement
```

- Parent/child relationships represent synchronous nested calls; span links or documented correlation attributes represent asynchronous commit -> revalidation -> delivery causality.
- High-cardinality request, mutation, connection, commit, subscription, and trace IDs are present where needed in traces/diagnostic events. The same values are absent from metric attributes.
- Every structured error/lifecycle event has trace/request context when one exists. A background lifecycle event without a trace has the documented process/service context.
- A nested procedure graph has one root and distinct child query/mutation/transaction/fetch spans; it must not create unrelated roots.
- Two concurrent requests with the same function/outcome never cross-link IDs or stages.

### T3. Stage-timing tests

Arm one `SemanticGate` at a time for a known manual/real duration and assert the corresponding exported stage is at least that duration while unrelated stage durations do not absorb it:

1. request/admission queue;
2. writer queue;
3. handler execution;
4. statement/storage work;
5. commit/durability;
6. post-commit invalidation;
7. revalidation queue and evaluation separately;
8. encoding;
9. outbound queue;
10. network/delivery/convergence;
11. exporter queue/export (telemetry self-observation only, never application duration).

All durations are finite and nonnegative. Stage intervals may overlap where the schema documents concurrency; tests must check documented containment/ordering rather than demand that a lossy sum equals wall time. Force rollback, unchanged revalidation, reset, and delivery failure so each stage records the correct terminal outcome.

### T4. Runtime operational metrics

Scrape or receive aggregate metrics while independently observing the fixture. Assert exact/current values or bounded monotonic deltas for:

- active/authenticating/draining connections;
- active and queued query/mutation/procedure/SSE/scheduled operations, depth and oldest age;
- active logical subscriptions and shared computation groups;
- pending/coalesced/rejected revalidations;
- per-stage outbound queued frames/bytes and slow-consumer disconnect/reset count;
- telemetry queued items/bytes, dropped batches/signals, export attempts/failures/age, and exporter health;
- process RSS, CPU, event-loop delay, open handles/FDs when supported;
- database bytes, WAL bytes/pages, checkpoint state/outcome, writer wait/busy outcomes, and durability mode;
- lifecycle/readiness/drain/deadline, backup, restore, integrity outcomes.

Gauge values must agree with externally controlled fixture counts at quiescent barriers. Histograms/counters must increase by the known operation count. A metric whose “exact” value cannot be sampled atomically should document and test an interval invariant instead of using a flaky instantaneous equality.

### T5. Slow and failed trace retention

Configure a sampling policy that would normally drop most fast successes. Execute a fast success, a handler held past the slow threshold, a validation failure, authorization failure, rollback, overload rejection, reset, and delivery/export failure. After bounded flush:

- every slow and failed operation required by the default policy is present;
- their full parent/link context is present enough to diagnose the stage;
- fast successes may follow the documented sampling rate, while aggregate metrics still count all work;
- retention buffers obey configured count/byte limits under a burst of slow/failing work.

### T6. Privacy canaries

Generate unique canaries for each source independently:

- bearer token and token signature;
- `Authorization` header, cookie, and arbitrary secret header;
- raw issuer claims including email/name/organization/roles and subject;
- query/mutation/procedure/SSE/scheduled arguments;
- returned rows/results and streamed chunks;
- row payload stored in SQLite;
- literal-bearing SQL and bound parameters;
- URL query value and error text deliberately containing a canary.

Collect raw OTLP request bytes, decoded traces, metric labels/values where textual, structured events, local stdout/stderr, exported diagnostics, and backup/lifecycle telemetry. Recursively search for the literal plus common encoded forms (JSON-escaped, URL-encoded, and base64). Every canary must be absent under default settings. Safe parameterized statement/fingerprint, function address, bounded sizes/counts, and outcome may remain.

Also assert that telemetry instrumentation does not mutate the application's returned value/error, and that an application error containing a secret is mapped to a safe public/telemetry message while the original remains available only through the explicitly approved application boundary, if any.

Issue story 42 is conditional: if payload capture remains unimplemented as the PRD's out-of-scope section permits, docs must say it is unsupported and no hidden “capture all” switch may exist. If a capture feature is added anyway, it needs separate explicit enablement, scope, TTL expiry via `ManualClock`, redaction, authorization, audit event, and automatic shutoff tests; default-on capture is a release blocker.

### T7. Cardinality

1. Capture baseline metric descriptors and label sets.
2. Run large deterministic populations of users/subjects, arguments, request IDs, mutation IDs, connections, commit IDs, subscription IDs, trace IDs, and payload values while keeping the finite set of function names, operations, outcomes, transports, durability modes, and resource classes constant.
3. After export, canonicalize `(metric name, sorted labels)` series. Series growth must be bounded by the documented vocabulary cross-product and independent of the high-cardinality population. Assert a concrete maximum computed from that schema, not “less than input count”.
4. Explicitly reject forbidden label keys/values: request/mutation/connection/commit/subscription/trace/user/subject/session IDs, raw arguments/results, URLs with values, literal SQL, exception text, or dynamically generated function/resource names.
5. Confirm traces/diagnostic events still carry the documented high-cardinality correlation IDs so cardinality control did not remove incident debugging.

### T8. Export/local-output failure and shutdown

Run the same mutation + subscribed transition while `OtlpReceiver` is in each mode: normal, HTTP error, immediate disconnect, malformed response, and indefinite stall.

- Application commit, query correctness, subscription transition, and acknowledgement are identical in all modes.
- An exporter promise held forever cannot hold the commit, transition, or acknowledgement promise. Use a short operation deadline plus an un-released exporter gate to prove independence.
- Telemetry buffers remain within item/byte limits; overflow policy/dropped counters are exact; retry uses its own bounded backoff and does not create an unbounded retry queue.
- Exporter failure is visible through safe health metrics/events but never changes application readiness unless the explicitly documented deployment policy chooses that behavior; default is fail-open.
- Graceful shutdown waits only for the configured telemetry flush deadline, records dropped-on-shutdown counts, closes the SQLite/service process by the overall deadline, and does not hang on a stalled backend.
- Local development output is useful and parseable without a backend, remains correlated, and passes the same privacy vocabulary checks. A broken stdout consumer cannot block application work indefinitely.

### T9. Telemetry enabled/disabled/tuned modes

- Omit telemetry configuration: readiness and exported/local signals prove the documented useful default is enabled.
- Disable completely: no exporter requests, local telemetry records, telemetry workers/timers/queues, or instrumentation callbacks occur; application results remain identical. Only configuration confirmation needed by the benchmark may be emitted through its non-telemetry control channel.
- Tune trace retention/export separately while aggregate health metrics remain according to the documented contract. Verify each knob independently and reject invalid/unbounded values at startup.
- Re-enable in a fresh process and verify no disabled-mode state leaks across startup.

## Suite P: telemetry-on/off comparative benchmark and correctness gates

### P1. Result shape and execution

The full run remains DBZZ + Convex local + SpacetimeDB 2.6.1 on the same machine/workload. DBZZ is run twice from fresh equivalent state:

- `default`: exactly the production default telemetry configuration;
- `disabled`: telemetry code path completely disabled.

Store both under one DBZZ system result (or one explicit paired-profile field), not as a fake fourth competing database. Record profile config confirmation, throughput, p50/p95/p99, server/load-generator CPU, RSS p50/peak, writer/request/revalidation queue timing, telemetry queue/drops/export work, and any separately measurable exporter process cost. The primary three-way comparison uses default-on DBZZ; disabled is the paired overhead reference.

The runner must verify the actual server mode through a structured startup/config handshake or safe readiness field. Setting an environment variable is not proof that the product honored it. A default-on run that exports no required aggregate telemetry, or a disabled run that emits/queues telemetry, is invalid.

### P2. Mandatory correctness rejection

Extract the result validator from the top-level runner into a genuinely reusable pure benchmark boundary (not a wrapper that merely calls another function), then unit-test rejection for each corruption:

- system identity/config/case/connection/subscription-capacity shape mismatch;
- telemetry profile missing, duplicated, or server-confirmed mode different from requested;
- request accounting mismatch (`attempted != in-window + after-window + failed`);
- query/procedure nonce, shape, payload, checksum, or returned row corruption;
- mutation account-model balance/version/checksum mismatch before or after a trial;
- duplicate, unexpected, corrupt, or missing subscription delivery;
- acknowledged DBZZ mutation whose relevant subscription did not reach its commit/convergence receipt;
- telemetry default aggregate counts inconsistent with known operations beyond documented sampling/aggregation boundaries;
- telemetry disabled mode with any exporter/local-output activity;
- missing/invalid resource windows or non-finite throughput/latency/CPU/RSS/queue/exporter values;
- load generator/client/server still running or benchmark ports still listening after a leg;
- partial three-system run attempting to save a comparable record.

Existing validation at `bench/run.ts:744-805`, state checks at `bench/workload.ts:91-127,168-240`, and delivery accounting at `bench/workload.ts:409-642` are the base patterns. Preserve them and add the production-mode checks; do not weaken workload equality to accommodate telemetry.

### P3. Performance acceptance

- Compute and publish paired default-on versus disabled deltas for DBZZ throughput, p50/p95/p99, CPU, RSS, queueing, and exporter cost.
- Compare default-on DBZZ against the fresh B0 baseline and the same-run Convex/SpacetimeDB legs. Every metric B0 records as a DBZZ win over SpacetimeDB must remain a win after reruns for noise. Losing one blocks completion.
- The Convex margin must remain above an explicit floor fixed from the B0 acceptance decision, not an improvised “looks large” judgment after results are known. The record must carry the floor and pass/fail evidence.
- Latency noise is rerun before judgment as `AGENTS.md` requires. A consistent regression on headline DBZZ mutations/sec, subscription p50, CPU, or any prior win is investigated/fixed, not averaged away.
- Full records are saved only after all behavior/mode/accounting gates pass. Partial/debug DBZZ runs remain unsaved as current `bench/run.ts:827-880` intends.

### P4. Benchmark test cases/files

- `bench/telemetry-profile.test.ts`: mode parsing/confirmation, paired result shape, overhead calculation, missing/duplicate/mismatched mode rejection.
- Extend `bench/harness.test.ts`: pure correctness validator mutation tests, non-finite metrics, resource window coverage, and post-leg cleanup assertion.
- Keep workload validation shared across systems; DBZZ-only telemetry confirmation is an additional gate, never a change to Convex/SpacetimeDB work.

## Suite Y: TypeScript inference and documented limitations

### Y1. Type inference/no output schema

Create a new compile-check file rather than coupling to implementation tests:

- inferred query/mutation/procedure return values flow through generated `api` and `DbzzClient` without explicit output validators;
- nested calls and auth-aware contexts preserve inferred results;
- protocol/durability/convergence receipts do not replace or erase the application return type;
- no new required `returns`/output-schema field appears on function builders;
- wrong client result assignment still fails with `@ts-expect-error`.

Model it on `packages/server/test/functions.check.ts:31-70` and `packages/cli/test/codegen.test.ts:64-89`. Runtime output validation remains excluded; any later proposal requires the separately measured current benefit specified by story 49.

### Y2. Limitations/docs audit

The production/operations/telemetry/protocol docs must explicitly state:

- single-node scope; no automatic failover, consensus, multi-region active-active, global replication, sharding transaction, hosted control plane, or managed-service guarantee;
- exact durability modes and process-crash versus power-loss promises;
- backup/restore procedure and verification boundary;
- query versus ephemeral-event ordering/resume semantics;
- in-memory client cache/no persistent offline conflict resolution;
- finite limits/overload/slow-consumer outcomes;
- telemetry default, disabled mode, privacy exclusions, exporter failure, and unsupported payload capture if omitted;
- raw TypeScript distribution/Bun runtime constraint;
- completion removes named blockers but is not a claim of complete production readiness.

V1 should statically verify the required headings/terms and manually audit meaning; avoid a brittle exact-prose snapshot.

## User-story and fixed-decision coverage audit

Every issue story maps to at least one executable suite or to the explicit conditional documentation rule for future payload capture.

| Story | Acceptance mapping |
| --- | --- |
| 1 | A1 explicit anonymous versus verified identity matrix. |
| 2 | A1 across WS, HTTP, SSE, scheduled, and nested execution. |
| 3 | A1/A3 stable unauthenticated versus unauthorized transport outcomes and opacity. |
| 4 | P0-C and A3 live sign-out/role/ownership revocation. |
| 5 | A2 deterministic long-lived WS refresh/rotation. |
| 6 | A1 verifier/config/policy failures fail closed. |
| 7 | R1/R3/L3 monotonic commit versions across commit, resume, and restart. |
| 8 | R1 setup-race barriers prove snapshot/update stream continuity. |
| 9 | R1 strict atomic predecessor/successor transition envelope. |
| 10 | R1 mismatch/corruption rejection plus authoritative reset. |
| 11 | R2/R3 reconnect at every transition point, resume when provable, reset otherwise. |
| 12 | R4 and P0-A durability plus relevant caller-state convergence before resolution. |
| 13 | Suite E lost ack/disconnect/process interruption/retry exactly-once effect. |
| 14 | Suite E procedure response-loss/non-auto-retry test. |
| 15 | R3 separate documented/enforced query and event semantics. |
| 16 | O1 exact finite connection, operation, subscription, revalidation, outbound, and telemetry limits. |
| 17 | O1 structured overload tuple and transport mapping. |
| 18 | O2 bounded fair progress across connections/groups/classes/identities. |
| 19 | O1/O3 unread WS/SSE bounded bytes, plateau, disconnect/reset, cleanup. |
| 20 | O4 seeded jitter, retry-after, cap, cancellation, and non-retryable outcomes. |
| 21 | L1 separate liveness/readiness state table. |
| 22 | L1/L5 database, reconciliation/integrity, startup, and drain readiness. |
| 23 | L2 admission stop, bounded drain, subscription close, deadline exit. |
| 24 | L3/L4 acknowledged crash durability and corruption rejection. |
| 25 | L3 plus T4/P1/Y2 durability mode observable in readiness, telemetry, benchmark, docs. |
| 26 | B1/B2 verified public backup/restore to a fresh process. |
| 27 | T1 inbound query/mutation/procedure/SSE/scheduled/subscription path coverage. |
| 28 | T1/T2 subscription initial/invalidation/revalidation/result/fanout/queue/delivery/failure graph. |
| 29 | T1/T3 mutation transaction queue/execution/storage/commit/rollback/replay/dependencies/post-commit stages. |
| 30 | T1/T2 full procedure nested call/transaction/fetch/stream call tree. |
| 31 | T1/T3 query queue/handler/statement/rows/encode/delivery stages. |
| 32 | T4 complete runtime/storage/exporter operational metrics. |
| 33 | T2 trace/request-correlated errors and lifecycle events. |
| 34 | T7 bounded stable metric dimensions. |
| 35 | T2 high-cardinality identifiers in traces/diagnostics but not metrics. |
| 36 | T5 slow and failed operation retention under sampling and buffer limits. |
| 37 | T9 omitted config proves useful default-on behavior. |
| 38 | T1/T8 OTLP backend-neutral path plus safe local output. |
| 39 | P0-D, O1, and T8 bounded asynchronous fail-open exporter. |
| 40 | T9 complete disable and independent retention/export tuning. |
| 41 | T6 canaries across raw/decoded export, local output, SQL, claims, args, results, and headers. |
| 42 | T6 conditional rule: unsupported and documented unless a separately tested explicit scoped/TTL/redacted/audited feature is built. |
| 43 | T1-T4 schema vocabulary, correlation, timings, outcomes, and relationships; golden/versioned public schema checks. |
| 44 | All suites use public behavior plus deterministic failure injection; no internal-state pass condition. |
| 45 | P1/P4 paired default-on/disabled DBZZ profiles in the comparative harness. |
| 46 | P3 explicit same-run Convex margin floor derived from B0. |
| 47 | P3 preserve every B0 DBZZ-over-SpacetimeDB win after noise reruns. |
| 48 | Y1 compile-time inferred return types through generated client API. |
| 49 | Y1 asserts no required runtime output schema; any future change is outside this milestone without evidence/approval. |
| 50 | Y2 explicit single-node and remaining production limitations. |

Fixed decisions are also covered:

- single-node scope: L/B/Y2;
- authentication/realtime/overload/lifecycle/telemetry as one boundary: P0-A through P0-D;
- ordered resume or reset, never guess: R1-R3;
- durability + convergence acknowledgement: R4/E/L3;
- every queue finite/observable/explicit: O1-O3/T4;
- complete default telemetry, safe data, bounded fail-open export: T1-T9;
- backend-neutral conventions: `OtlpReceiver` boundary and schema checks;
- performance as acceptance: P1-P4;
- inferred returns/no runtime output schema: Y1;
- no backwards compatibility: R1 unsupported-version rejection and no legacy-frame assertions.

## Proposed disjoint test-file ownership

Do not have implementation packets edit these new acceptance files. Let C1/S1/C2/T1 land public behavior behind narrow focused tests; then Q1 owns the acceptance layer. Existing tests stay with their current package owners unless a product change legitimately requires updating their intended contract.

| Owner | Exclusive files | Responsibility/dependency |
| --- | --- | --- |
| Q1-F shared fixtures first | `packages/server/test/support/production-app.ts`, `fault-gates.ts`, `frame-proxy.ts`, `process-harness.ts`, `oidc-issuer.ts`, `otlp-receiver.ts`, `resource-probe.ts`, `eventually.ts` | Freeze a small support API using only public product configuration plus independent socket/process tools. Other Q1 owners consume but do not edit these files. |
| Q1-A auth | `packages/server/test/auth.public.test.ts`, `packages/client/test/auth-refresh.public.test.ts` | A1-A3, including cross-transport scheduled/nested matrix and revocation. Depends on Q1-F and C1/S1/C2 auth contract. |
| Q1-R realtime/idempotency | `packages/core/test/production-protocol.test.ts`, `packages/client/test/realtime-state.public.test.ts`, `packages/client/test/exactly-once.public.test.ts` | R1-R4 and E. Owns raw wire/proxy transition cases; no auth-matrix duplication beyond one valid principal. |
| Q1-O overload | `packages/server/test/overload.public.test.ts`, `packages/client/test/retry-overload.public.test.ts` | O1-O4 and resource plateau; uses telemetry only for public gauges, not schema coverage. |
| Q1-L lifecycle/recovery | `packages/cli/test/lifecycle.process.test.ts`, `packages/cli/test/recovery.process.test.ts`, `packages/cli/test/backup-restore.process.test.ts` | L1-L5 and B1-B2 with real CLI processes/files. Owns process signals, corruption, backup artifact, and listener cleanup. |
| Q1-T telemetry | `packages/server/test/telemetry-contract.public.test.ts`, `packages/server/test/telemetry-safety.public.test.ts`, `packages/cli/test/telemetry-local-output.process.test.ts` | T1-T9. Owns schema/correlation/privacy/cardinality/export/local-output assertions; reuses operations from `ProductionApp`. |
| Q1-Y types/docs checks | `packages/server/test/production-types.check.ts`, `packages/cli/test/production-codegen.test.ts`, `packages/server/test/production-docs.test.ts` | Y1/Y2. Keep compile/static contract checks separate from runtime tests. |
| P1 benchmark | `bench/telemetry-profile.test.ts`, `bench/harness.test.ts`, `bench/benchmark.ts`, `bench/workload.ts`, `bench/dbzz-client.ts`, `bench/run.ts`, `bench/README.md`, new benchmark results | P1-P4 only. P1 owns any extraction of the pure benchmark validator and paired result schema, preventing Q1 overlap. |

If concurrency slots are limited, combine Q1-O + Q1-L under one owner because both consume `ProcessHarness`/`ResourceProbe`; keep Q1-R and Q1-T separate because both are large and touch different assertions. Q1-F must finish first. No owner may independently clone support helpers into its suite.

## Suggested test names by file

This is the minimum named inventory; table-driven cases may expand each name.

### `auth.public.test.ts`

- `identity semantics are transport-independent`
- `invalid token classes fail closed without protected detail`
- `unauthenticated and unauthorized are distinct`
- `scheduled work uses a valid workload principal`
- `nested calls preserve the immutable principal and auth epoch`
- `revocation revalidates only affected live subscriptions`

### `auth-refresh.public.test.ts`

- `refresh rotates credentials without reconnecting`
- `identity change orders redaction before newly authorized data`
- `failed or stale refresh cannot restore an expired identity`
- `http and sse refresh use new authenticated requests`

### `production-protocol.test.ts`

- `snapshot and transitions carry monotonic query-set commit and auth versions`
- `resume reset ack and overload outcomes have one stable envelope`
- `unknown protocol versions fail explicitly`

### `realtime-state.public.test.ts`

- `commit during subscription setup cannot be missed`
- `overlapping recomputes cannot publish stale state`
- `duplicate and out-of-order transitions never corrupt client state`
- `reconnect at every transition point converges`
- `resume uses retained history and history loss resets`
- `event and query subscriptions enforce their separate ordering contracts`
- `mutation waits for relevant changed or unchanged convergence`

### `exactly-once.public.test.ts`

- `lost acknowledgement replays one effect across reconnect`
- `crash before commit retries once`
- `crash after durable commit before ack replays stored outcome`
- `concurrent duplicate request executes once`
- `request id reuse with different input is rejected`
- `procedure response loss is never automatically retried`

### `overload.public.test.ts`

- `each bounded resource rejects at its exact configured limit`
- `combined saturation has no hidden multiplicative queue`
- `hot connection and subscription group cannot starve cold work`
- `unread websocket and sse peers remain byte bounded`
- `flood epochs plateau and release all resources`

### `retry-overload.public.test.ts`

- `reconnects use deterministic exponential jitter`
- `retryable overload honors retry-after without a storm`
- `non-retryable outcomes and procedures are not retried`
- `close cancels every reconnect and pending timer`

### Process files

- lifecycle: readiness startup/database/drain table; graceful drain; stuck-work deadline; child/listener cleanup.
- recovery: crash boundaries per durability mode; monotonic version after restart; corruption variants; interrupted reconciliation atomicity.
- backup/restore: online cut; live metadata; verified fresh restore; continued operation; incomplete/corrupt/mismatched artifact rejection.

### Telemetry files

- contract: every public path/outcome; correlation graph; stage gates; runtime gauges; slow/failure retention.
- safety: all privacy canaries; cardinality population; exporter error/disconnect/stall; bounded queue; fail-open application; shutdown flush deadline; enabled/disabled/tuned modes.
- local output: default useful structured output; correlation/privacy; blocked/broken output cannot hang application/drain.

## Resource and race assertion details

- `SemanticGate.waitEntered` and every network/process wait have a hard deadline and include current health/frames/child output on timeout.
- Frame callbacks store `(from,to,kind,valueHash)` and assert a contiguous applied history; do not compare callback count only.
- Mutation fixtures store a durable execution counter and business row in the same transaction. Exactly-once assertions inspect both through a public query after a new process starts.
- A second independent observer connection establishes “commit visible” before dropping ack/killing; it must never share the caller's proxy.
- Fairness assertions release individual scheduler turns and inspect public start-stage telemetry, avoiding host scheduling latency thresholds.
- Queue counters are sampled while the gate is closed, then again after release/cancel. Attempted work must exceed the limit by orders of magnitude in finite-memory tests.
- RSS assertions use repeated epochs and a configured byte-budget-derived tolerance. They never claim a leak from one noisy delta and never pass a logical queue that exceeded its exact bound merely because RSS stayed flat.
- Corruption tests duplicate disposable fixture state before byte faults and never mutate repository/user databases.
- Privacy tests retain raw exporter requests before decoding so a decoder cannot hide a leaked field.
- Cardinality tests compute the maximum allowed series from the public schema's finite enum/function set and compare canonical label sets exactly.

## Verification order and commands

The implementation packets may use narrower commands while developing, but Q1/V1 should finish in this order:

1. Protocol/type checks:
   - `bun test packages/core/test/production-protocol.test.ts`
   - `bun run typecheck`
   - Expected: exit 0; all `@ts-expect-error` assertions remain consumed.
2. Focused public suites:
   - `bun test packages/server/test/auth.public.test.ts packages/client/test/auth-refresh.public.test.ts`
   - `bun test packages/client/test/realtime-state.public.test.ts packages/client/test/exactly-once.public.test.ts`
   - `bun test packages/server/test/overload.public.test.ts packages/client/test/retry-overload.public.test.ts`
   - Expected: no fixed-sleep race waits and no leaked child/listener in teardown.
3. Process/recovery suites, run serially if they share signal/FD pressure:
   - `bun test packages/cli/test/lifecycle.process.test.ts packages/cli/test/recovery.process.test.ts packages/cli/test/backup-restore.process.test.ts`
   - Expected: all pass and every used port is free afterward.
4. Telemetry suites:
   - `bun test packages/server/test/telemetry-contract.public.test.ts packages/server/test/telemetry-safety.public.test.ts packages/cli/test/telemetry-local-output.process.test.ts`
   - Expected: all modes/faults pass; privacy scan reports zero canary matches.
5. Existing regression suite and typechecks:
   - `bun test`
   - `bun run typecheck`
   - `bun run typecheck:bench`
   - Expected: exit 0. Preserve current wire/storage/reconcile/client/CLI/benchmark characterization coverage.
6. Focused benchmark harness:
   - `bun test bench/harness.test.ts bench/telemetry-profile.test.ts`
   - `BENCH_PROFILE=quick bun bench/run.ts dbzz`
   - Expected: paired DBZZ modes pass correctness and mode gates; partial run is not saved; port 3311 is free afterward.
7. Required full post-structural benchmark:
   - `bun bench/run.ts`
   - Expected: all three systems and both DBZZ telemetry modes pass; a record is saved; default-on preserves the accepted Convex margin and every B0 SpacetimeDB win. Rerun if noise could explain a regression.
8. Final cleanup/audit:
   - `lsof -nP -iTCP:3311 -iTCP:3210 -iTCP:3211 -iTCP:5321 -sTCP:LISTEN`
   - Expected: no benchmark/test service listener.
   - Run the project wiki lint workflow and audit production/protocol/telemetry/operations docs against Y2.

Do not run the full benchmark until B0 has preserved the required pre-structural baseline and implementation integration is stable. This D3 packet itself changed only a workflow result and therefore did not start services or run benchmarks.

## STOP conditions for Q1/P1 executors

Stop and report to the root agent instead of weakening a test if any of these occurs:

- C1 does not expose stable structured versions/outcomes needed to distinguish resume, reset, overload, unauthenticated, unauthorized, durability, and convergence.
- A race can only be reproduced with sleeps or private-state mutation because the owning scheduler/storage/transport boundary has no deterministic seam.
- A test needs `runtime.subs.size`, a private queue, or a private method as its pass condition rather than a public gauge/effect.
- The implementation calls a telemetry exporter synchronously from commit/delivery, uses unbounded buffering, or requires catch-and-ignore to keep work alive.
- A durability mode's acknowledgement cannot be tied to a provable SQLite boundary; do not relabel COMMIT or socket write as stronger durability/application convergence.
- Resume history cannot prove the client's predecessor state; require reset instead of adding a heuristic.
- Finite memory can be claimed only from RSS while logical item/byte counters can exceed configuration.
- A benchmark run cannot prove which telemetry mode actually ran or would save results after any correctness/resource/mode failure.
- Achieving a test requires a compatibility shim, duplicate runtime path, automatic procedure retry, raw payload capture, or required runtime output schema.
- A test fault would touch a non-disposable database, publish/deploy, or modify Pedro's staged/dirty work.

## Done criteria for the milestone acceptance layer

- Every story row above has a passing executable test or the explicit story-42 conditional documentation treatment.
- Every race/fault row uses a deterministic barrier/proxy/process boundary and has a cleanup assertion.
- The secure convergent mutation tracer bullet passes over real sockets and a fresh file-backed process.
- Lost-ack crash replay proves one durable effect and caller convergence.
- Every configured resource stays within exact count/byte bounds under independent and combined flood; healthy work progresses fairly.
- Liveness/readiness/drain/crash/corruption/durability/backup/restore pass against real child processes and temporary files.
- Every public operation/stage/outcome is represented by correlated, schema-valid telemetry; default canaries are absent; cardinality and exporter buffers remain bounded; export failure cannot fail or block application work.
- Default-on and disabled DBZZ benchmark profiles both pass correctness/mode gates, the full comparison is valid, and required performance wins remain after reruns.
- Existing `bun test`, `bun run typecheck`, and `bun run typecheck:bench` pass, all child processes/listeners are gone, and remaining single-node limitations are explicit.
