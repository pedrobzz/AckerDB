# D1 architecture map

## Inspection snapshot

- Repository: `/path/to/ackerdb`.
- Inspected branch/HEAD: `codex/benchmark-capacity` at `74d8554`.
- GitHub contract: issue #1, *Production safety and full operational visibility*, including all 50 user stories and fixed implementation/testing decisions.
- The pre-existing dirty tree is authoritative. Product source was clean at inspection time; publishing, hooks, manifests, `AGENTS.md`, and workflow files were already dirty/untracked.
- This packet changed no product, test, benchmark, wiki, manifest, or documentation file. The only authored artifact is this note.
- Tests and benchmarks were inspected, not executed. D1 makes no structural product change, and the required full baseline is the separate B0 boundary.
- The project wiki query workflow was used to read the existing architecture, authentication, SQLite, telemetry, and benchmark articles. D1 did not ingest or alter wiki material because its explicit ownership is this result note only.

## Executive finding

The prototype has four real strengths worth preserving:

1. mutation results and idempotency keys are written in the same SQLite transaction;
2. read handlers use a WAL snapshot and writes serialize through one writer turn;
3. dependency keys precisely target shared query recomputation; and
4. the client reconnects, reuses mutation IDs, and resubscribes.

Those strengths are local guarantees, not yet one production state model. There is no verified identity, durable commit/version, atomic subscription transition, proven resume/reset, bounded admission or delivery queue, lifecycle state, safe telemetry pipeline, or production recovery API. The central correctness gap is that SQLite commit, subscription evaluation, transport delivery, and client acknowledgement do not share an ordered version.

The smallest coherent change is not a collection of guards around the current methods. It is six explicit state owners:

1. verified execution/auth context;
2. bounded operation admission;
3. durable commit plus ordered post-commit publication;
4. versioned subscription/session transition state;
5. bounded transport delivery plus client convergence; and
6. service lifecycle/storage health plus bounded telemetry.

## Current topology and state owners

```text
DbzzClient
  |-- WebSocket /ws ------> serve/WsSubscriber ----+
  |-- HTTP /api/call -----> serve -----------------+--> Runtime
  `-- HTTP /api/sse ------> serve -> ReadableStream+      |-- Registry
                                                         |-- read/write Mutex tails
                                                         |-- SubscriptionManager
                                                         |-- scheduler/event sequences
                                                         `--> Engine
                                                              |-- writer connection
                                                              |-- reader connection
                                                              `-- SQLite WAL file

CLI startApp: import schema/modules -> Engine -> reconcile -> Registry -> Runtime -> serve
```

| Boundary | Current owner and evidence | Durable state | In-memory state | Production implication |
| --- | --- | --- | --- | --- |
| Shared protocol | `packages/core/src/protocol.ts:8-37` | none | TypeScript unions only | `PROTOCOL_VERSION` is exported but never negotiated or sent; messages have no auth, version, reset/resume, structured outcome, retry, or convergence fields. |
| Wire codec | `packages/core/src/wire.ts:13-98` | encoded values embedded elsewhere | none | Bigint/bytes and stable canonical args are solid, but decoding is only JSON-plus-escapes; decoded frame shapes are trusted casts in `serve.ts:136-170`. |
| Client connection | `packages/client/src/client.ts:42-100` | none | socket/open flag, subscriptions, pending requests, backoff, timers | One socket owns all pending operations and subscriptions. Maps and reconnect replay are unbounded. |
| Client request/subscription | `packages/client/src/client.ts:102-180` | mutation UUID exists only in pending frame until server commit | numeric request IDs, raw callback entries | Updates are applied by ID only; no transition precondition or local version exists. |
| HTTP/SSE client | `packages/client/src/client.ts:183-239` | none | local SSE text buffer | Procedures are deliberately not retried. No credentials, structured outcomes, limits, retry hints, or bounded parser buffer exist. |
| Transport | `packages/server/src/serve.ts:18-39,70-179` | none | one `WsSubscriber` per socket | WebSocket state contains only a sender object; HTTP and WebSocket requests have no shared identity/session context. |
| Function registry | `packages/server/src/registry.ts:10-75` | none | address-to-function and object-to-address maps | Static function resolution is compact. It owns no visibility/policy metadata or nested invocation correlation. |
| Public execution context | `packages/server/src/functions.ts:28-68` | none | handler-local context | The designed auth shape exists, but includes raw claims and is always populated with the anonymous constant from `runtime.ts:57`. |
| Runtime scheduling | `packages/server/src/runtime.ts:47-85` | mutation pruning mutates SQLite on startup | two promise-tail mutexes, subscriptions, scheduler timer, per-process event IDs, stopped flag | Read and writer turns are serialized but not bounded, cancelable, fair, or observable. `stop()` affects only the scheduler. |
| Query execution | `packages/server/src/runtime.ts:109-125` | application reads | read mutex and optional dependency recorder | File-backed reads use `BEGIN DEFERRED`/`COMMIT` on the reader connection, which gives a coherent WAL snapshot. All queries share one unbounded read tail. |
| Transaction/idempotency | `packages/server/src/runtime.ts:130-176` | `_dbz_mutations(mid,result,at)` and application rows | write collector until commit | The result record is committed atomically with writes. The dedupe key is only `mid`, optional at runtime/HTTP, and deleted after one hour on startup (`runtime.ts:75-77`). |
| Post-commit work | `packages/server/src/runtime.ts:164,299-329` | none | write keys/events passed to fanout | Post-commit work runs outside the writer mutex, has no commit sequence, and awaits every affected recomputation before returning a mutation. |
| Reactivity | `packages/server/src/reactive.ts:16-139` | none | shared query entries, inverted dependency index, subscriber/event maps | Shared recomputation and precise invalidation are good. Entries are keyed only by function plus args and have no identity/policy/version/revalidation state or limits. |
| Event subscriptions | `packages/server/src/runtime.ts:101-105,270-279,317-323` | none | per-process table sequence and live listeners | IDs restart with the process; there is no snapshot, history, cursor, reset, or documented loss/order contract. |
| Scheduler | `packages/server/src/runtime.ts:332-399` | scheduled rows until selected/deleted | timer and unbounded due array | Due rows are deleted and committed before handlers run. A crash in between loses work; failures are logged and the row is already gone. |
| SQLite engine | `packages/server/src/engine.ts:99-125,361-364` | schema metadata, tags, mutation dedupe, application tables | writer/reader handles, codecs/plans | WAL, `synchronous=NORMAL`, and 5 s busy timeout are hard-coded. No durability profile, integrity gate, checkpoint control, backup, restore, status, or graceful close protocol exists. |
| Reconciliation | `packages/server/src/reconcile.ts:69-76,309-320` | schema snapshot and DDL | pure plan closures before apply | Reconciliation applies as one transaction and refuses unsafe changes. This is a useful startup gate, but not a complete readiness/corruption/recovery state. |
| App lifecycle | `packages/cli/src/app.ts:73-95`; `packages/cli/src/main.ts:107-130` | database file | returned server/runtime/engine | Startup listens only after reconciliation, but production `start` installs no signal/drain handler. Dev signals kill the child immediately. |
| Benchmark | `bench/run.ts:70-89,251-273,744-880`; `bench/workload.ts:652-699` | full-run JSON records | per-leg processes/monitors/models | The harness has fresh state, port preflight, process cleanup, correctness gates, and resource sampling, but no telemetry-on/off dimension or internal stage/queue/exporter measurements. |

## Current execution flows

### One-shot query

1. The client stores an encoded request in `pending` and sends it on a live socket or the next open (`client.ts:136-170`).
2. The transport dispatches directly to `Runtime.runQuery` and returns an unstructured `ok`/`err` frame (`serve.ts:136-170`).
3. The runtime validates args, enters the global read mutex, opens a reader snapshot for file databases, invokes with `ANONYMOUS`, and commits the read transaction (`runtime.ts:109-125`).

There is coherent database visibility, but no admission deadline, cancellation, request identity, auth context, stage timing, or structured outcome.

### Mutation and current acknowledgement

1. The client generates one UUID and reuses its encoded frame after reconnect (`client.ts:173-180`).
2. Under the writer mutex, the runtime checks `_dbz_mutations`, begins `IMMEDIATE`, runs the handler, records the encoded result, and commits (`runtime.ts:139-163`).
3. After releasing the writer turn, it broadcasts events and sequentially recomputes affected shared entries (`runtime.ts:164,317-329`).
4. Only after that method returns does the WebSocket transport enqueue `ok` (`serve.ts:161-164`).

This produces a useful partial ordering: update/event `send` calls normally happen before the mutation `ok` send on that socket. It is not the PRD guarantee:

- no committed version proves which state was evaluated;
- `ws.send` success/backpressure is ignored;
- the client does not track or apply a version before resolving;
- unrelated subscribers delay the caller because all affected groups are awaited;
- concurrent commits can enter post-commit work while a previous post-commit pass is awaiting reads;
- durability is the hard-coded NORMAL policy; and
- HTTP mutations have no caller WebSocket/session convergence relation.

### Subscription setup and invalidation

1. Entries are shared by `address + NUL + stableEncode(args)` (`reactive.ts:38-45`).
2. A new listener is attached before its first evaluation (`runtime.ts:282-285`).
3. The query records id/index/scan dependency keys; `SubscriptionManager.update` swaps the set/result and dedupes identical bytes (`db.ts:166-173,413-437`; `reactive.ts:102-119`).
4. A commit intersects write keys through the inverted index and recomputes each affected entry (`reactive.ts:122-130`; `runtime.ts:324-327`).

Two races are unowned:

- A commit can publish while the new entry still has an empty read set. If the initial read snapshot is older than that commit and `afterCommit` checks before `update` installs dependencies, the commit is missed and the stale snapshot can become active.
- Initial and post-commit recomputations of the same entry have no per-entry generation/serialization. An older evaluation can overwrite a newer result/read set.

No current test creates either barrier; the happy-path test only subscribes, receives the initial result, then mutates (`runtime.test.ts:215-240`; `serve.test.ts:146-159`).

### Reconnect and retry

The client reconnects with exponential full jitter from 100 ms to 3 s, then resends every live subscription and unanswered request (`client.ts:62-100`). Subscriptions receive a fresh current value, which gives eventual convergence on the happy path. The client cannot distinguish resume, reset, duplicate, stale, or out-of-order data.

The reconnect test hard-stops and restarts only the transport while reusing the same `Runtime` and `Engine` (`client.test.ts:163-180`). It proves queued mutation flush and resubscription, not process restart, lost acknowledgement replay after restart, history loss, transition mismatch, or durability.

### Procedures, SSE, nested calls, and scheduled work

- HTTP procedures have no automatic retry in the client (`client.ts:183-194`), preserving the no-duplicate-side-effect posture.
- Procedure transactions reuse `transact` and anonymous auth (`runtime.ts:181-195`). Direct query/mutation composition carries the same context structurally (`functions.ts:8-22,93-126`), but nested logical operations are invisible to the runtime/telemetry.
- SSE directly enqueues handler and merged-stream chunks and never checks `desiredSize` (`runtime.ts:199-265`). The merge array and downstream buffering are not bounded.
- Scheduled work runs anonymously through the same function methods after deleting due rows (`runtime.ts:359-398`). No original/system principal, retry record, durable outbox state, shutdown coordination, or operation correlation exists.

## Existing evidence and test boundary

| Existing guarantee | Evidence in product | Evidence in tests | What the test does not prove |
| --- | --- | --- | --- |
| Wire values round-trip | `core/src/wire.ts:15-98` | `core/test/wire.test.ts:6-84` | Protocol negotiation, frame-shape validation, limits, outcomes, or versions. |
| Branded identity storage type | `server/src/dbz.ts:11-12,116-121` | `server/test/dbz.test.ts:21-26` | Authentication or authority; any bigint passes runtime validation. |
| WAL snapshot read | `runtime.ts:109-125`; `engine.ts:106-117` | `server/test/db.test.ts:318-326` | Multiple concurrent readers, crash recovery, checkpoint pressure, corruption, or configured durability. |
| Atomic writes/rollback | `runtime.ts:139-163` | `runtime.test.ts:197-210`; `db.test.ts:71-210` | Commit version, power-loss durability, bounded writer wait, deadline, or failover. |
| Same-process mutation replay | `runtime.ts:141-158` | `runtime.test.ts:189-195`; `serve.test.ts:83-92` | Lost ACK, process interruption, identity/function/args collision, or retry after one-hour pruning. |
| Precise dependency keys | `keys.ts:24-46`; `db.ts:166-173` | `db.test.ts:196-210,303-326` | Auth dependencies or ordered transition publication. |
| Shared/deduped revalidation | `reactive.ts:31-130` | `runtime.test.ts:215-240` | Setup races, concurrent commits, bounded revalidation, fairness, or failure recovery. |
| Disconnect cleanup | `reactive.ts:67-100` | `runtime.test.ts:243-250`; `serve.test.ts:168-175` | Slow-consumer queue cleanup or half-open/resource exhaustion. |
| Live event delivery | `runtime.ts:270-279,317-323` | `runtime.test.ts:252-260`; `client.test.ts:142-153` | Restart, loss, duplicate/out-of-order frames, or event-versus-query ordering. |
| Procedure non-retry/composition | `client.ts:183-194`; `functions.ts:8-22` | `runtime.test.ts:263-276`; `functions.check.ts:31-70` | Auth propagation beyond anonymous, request cancellation, nested trace tree, or external-side-effect fault outcomes. |
| SSE happy/error paths | `runtime.ts:199-265` | `runtime.test.ts:279-301`; `serve.test.ts:102-112` | Unread stream memory, abort races, exporter failure, or structured terminal outcomes. |
| Scheduler fires once in-process | `runtime.ts:332-399` | `runtime.test.ts:304-326` | Crash between delete and execution, retry, identity, backlog limits, drain, or restart. |
| Atomic schema reconciliation | `reconcile.ts:69-320` | `reconcile.test.ts:49-314` | File corruption, historical migration ledger integrity, backup/restore, or startup readiness transitions. |
| Process startup/reload persistence | `cli/src/app.ts:73-95` | `cli/test/cli.test.ts:73-135` | Graceful shutdown, crash-after-ack, database reopen verification after kill, corruption rejection, or deadlines. |
| Client transport reconnect | `client.ts:62-100` | `client.test.ts:163-180` | Process restart, auth refresh, resume cursor, mismatch reset, overload hints, or mutation convergence. |
| Return-type inference | `server/src/functions.ts:73-151`; `core/src/refs.ts:63-79`; `cli/src/codegen.ts:88-135` | compile-time composition/DB surface in `functions.check.ts:31-70` and `dbtypes.check.ts:43-118`; generated API shape in `codegen.test.ts:44-89` | There is no reason to add runtime output validation for this milestone. |
| Comparative correctness/capacity | `bench/workload.ts:91-239,386-649`; `bench/run.ts:744-804` | `bench/harness.test.ts:6-90` | Production auth, durability faults, overload outcomes, telemetry coverage, or telemetry enabled/disabled profiles. |

## Exact issue #1 gap matrix

Legend: **present** means the current public behavior substantially satisfies the story; **partial** means there is useful groundwork but no accepted guarantee; **missing** means no owning state/API/test exists.

### Identity and authorization

| Story | Status | Exact current gap |
| ---: | --- | --- |
| 1 | missing | Every invocation receives the constant `ANONYMOUS` (`runtime.ts:57,109-125,168-195`). There is no verifier or explicit wire-level anonymous/authenticated decision. |
| 2 | partial | Semantics are consistently anonymous across query, mutation, procedure, SSE, nested calls, and scheduled handlers. That consistency is not verified identity; scheduled and transport-specific principals cannot be represented. |
| 3 | missing | Protocol errors contain only `message` (`protocol.ts:27-28`); HTTP maps validation to 400 and everything else to 500 (`serve.ts:62-64,108-110`). Unauthenticated and forbidden outcomes do not exist. |
| 4 | missing | Subscription entries have no principal/auth fingerprint or authorization dependency (`reactive.ts:16-44`). Sign-out, role changes, and ownership changes cannot target or revoke live results. |
| 5 | missing | There is no authenticate/refresh frame, token provider, expiry, auth epoch, or reauthentication state in protocol/client/transport. |
| 6 | missing | README explicitly calls auth a stub (`README.md:74-82`). No deny-by-default provider/configuration or typed policy failure exists. |

### Ordered realtime and acknowledgement

| Story | Status | Exact current gap |
| ---: | --- | --- |
| 7 | missing | No transaction allocates/persists a monotonic state version. The only schema `version` is snapshot format 1 (`snapshot.ts:15-41`), unrelated to commits. |
| 8 | missing | Snapshot registration is not serialized with commit publication; attach-before-recompute has the missed-invalidation race described above (`runtime.ts:282-288,317-328`). |
| 9 | missing | `update` and `event` frames carry only subscription ID plus value/row (`protocol.ts:20-24`), not atomic `from -> to` versions. |
| 10 | missing | Client dispatch calls callbacks by ID without a precondition (`client.ts:102-110`). It cannot detect mismatch or request/reset authoritative state. |
| 11 | partial | Reconnect resends subscriptions and gets current values (`client.ts:70-89`), but there is no history/cursor, proven resume, explicit reset, or history-loss outcome. |
| 12 | partial | Server post-commit send calls precede WS `ok`, but NORMAL durability, commit identity, caller-relevant convergence, send acceptance, and client application are unproven (`runtime.ts:149-165,317-329`; `serve.ts:161-164`). |
| 13 | partial | Same `mid` replays a transactionally stored result. The key is global and unscoped, optional for HTTP, and startup deletes entries older than one hour (`runtime.ts:75-77,141-175`; `protocol.ts:31-37`). |
| 14 | present/partial | Client procedures are not automatically retried (`client.ts:183-194`). Failures are still message-only, and process/network interruption cannot be distinguished from a known non-commit. |
| 15 | missing | Event IDs are per-process and non-durable (`runtime.ts:67,101-105`). Neither event nor query stream ordering/resume/loss semantics are documented as a production contract. |

### Bounds, overload, fairness, and retry

| Story | Status | Exact current gap |
| ---: | --- | --- |
| 16 | missing | Connection count, operation maps, mutex tails, subscriptions, revalidations, merge tasks, body/frame size, and outbound bytes have no finite configurable limits. |
| 17 | missing | Only generic `err.message` or HTTP 400/500 exists. No overload code, retryability, reason, or retry-after hint exists. |
| 18 | missing | One global read tail, one writer tail, sequential affected-entry loop, and direct fanout have no connection/group fairness policy (`runtime.ts:47-55,63-65,324-327`). |
| 19 | missing | `WsSubscriber` ignores every `send` result (`serve.ts:18-28`); SSE enqueue ignores desired size (`runtime.ts:202-240`). No byte accounting, reset, or slow-consumer disconnect policy exists. |
| 20 | partial | Exponential jitter exists (`client.ts:84-89`). Backoff resets immediately on open, caps at 3 s, and ignores server overload/retry hints or stable-connection duration. |

### Lifecycle, durability, and recovery

| Story | Status | Exact current gap |
| ---: | --- | --- |
| 21 | missing | `GET /health` always returns `{ok:true}` (`serve.ts:84-86`). There are no distinct liveness/readiness endpoints or states. |
| 22 | partial | The CLI begins listening after Engine construction and reconciliation (`app.ts:73-95`), but no DB probe/startup reconciliation/draining readiness reason is exposed. |
| 23 | missing | `Runtime.stop` only clears the scheduler (`runtime.ts:81-85`); production start has no signal handler, admission stop, drain, subscription closure, deadline, or ordered engine close. |
| 24 | missing | Acknowledgements use hard-coded NORMAL COMMIT. No crash-after-ack process test, integrity gate, corruption rejection contract, or restart reconciliation of commit/subscription metadata exists. |
| 25 | partial | The benchmark accurately labels WAL/NORMAL (`bench/README.md:145-151`; `bench/run.ts:862-866`), but users cannot configure/observe a durability mode at runtime. |
| 26 | missing | No backup or restore API/CLI exists. The only destructive storage command is dev `reset` (`cli/src/main.ts:140-148`). |

### Telemetry, safety, and operations

| Story | Status | Exact current gap |
| ---: | --- | --- |
| 27 | missing | No traces, metrics, structured-event interface, or correlation context exists for inbound paths. |
| 28 | missing | Subscription stages have no signal hooks; only callbacks and maps exist. Initial evaluation, match, changed/unchanged, fanout, queue, delivery, and failure are not measured. |
| 29 | missing | Writer wait/execution/storage/commit/rollback/replay/dependency/post-commit stages are not timed or correlated. |
| 30 | missing | Direct nested function calls bypass a runtime invocation boundary, so procedures cannot produce a logical child call tree. |
| 31 | missing | Query queue, handler, statement, rows, encoding, and network stages are not separated. |
| 32 | partial | The benchmark externally samples process-tree CPU/RSS (`bench/run.ts:149-248`). Production runtime gauges for connections, work, queues, bytes, event loop, database/WAL/checkpoint, and exporter state do not exist. |
| 33 | partial | Startup/reconcile logs and a few `console.error` calls exist (`app.ts:79-94`; `runtime.ts:255-260,353-355,394-395`), but they have no request/trace/commit context or stable event schema. |
| 34 | missing | No metric model or bounded dimensions exist. |
| 35 | missing | Request/mutation/connection/commit/subscription correlation IDs are absent except local request/sub IDs and `mid`, and none are joined into traces/events. |
| 36 | missing | There is no sampling/retention policy for slow or failed work. |
| 37 | missing | No default telemetry pipeline is constructed by `startApp`. |
| 38 | missing | There is neither a useful structured local sink nor backend-neutral exporter interface. |
| 39 | missing | No bounded telemetry buffer/export worker/drop accounting/fail-open test exists. |
| 40 | missing | No telemetry enable/disable, aggregate/trace, sampling, or export configuration exists. |
| 41 | missing | Today most data is not collected, but that is not a privacy contract. Raw error messages cross the wire and enter console logs; no sanitizer/canary test excludes tokens, claims, args, results, or literal SQL. |
| 42 | missing | No payload-capture feature exists, which is safe, but the required explicit/scoped/time-limited/redacted/audited future contract is undocumented and unenforced. |
| 43 | missing | No stable telemetry vocabulary/schema document or code-level semantic constants exist. |

### Verification, performance, typing, and limitations

| Story | Status | Exact current gap |
| ---: | --- | --- |
| 44 | partial | Existing tests cover happy-path public APIs and several transaction/reconnect behaviors, but not accepted auth, ordering races, bounds, process faults, durability, restore, telemetry, privacy, or cardinality guarantees. |
| 45 | missing | Benchmark config/result schema has no DBZZ telemetry mode and runs one DBZZ leg only (`bench/benchmark.ts:22-54`; `bench/run.ts:251-273,807-880`). |
| 46 | unproven for milestone | Current results decisively beat Convex (`bench/README.md:153-220`), but no post-guarantee run exists. Baseline and after runs must retain correctness gates. |
| 47 | unproven for milestone | Current records establish DBZZ wins over SpacetimeDB for selected query, latency, connection, shared-fanout, latency, and resource metrics. Every such metric needs comparable after-run checks; the harness currently compares only to the prior same-system record, not an explicit prior-win gate. |
| 48 | present | Builders infer handler returns through `Awaited<R>` and codegen maps module exports to typed refs (`functions.ts:93-151`; `refs.ts:63-79`; `codegen.ts:123-135`). Preserve this boundary. |
| 49 | present | Runtime validates args, then returns handler output without an output schema (`functions.ts:93-112`; `runtime.ts:109-125,168-195`). No measured evidence in scope justifies changing it. |
| 50 | partial/missing | README lists MVP gaps and benchmark caveats (`README.md:74-93`; `bench/README.md:138-151`), but there is no production operations/limitations contract covering single node, WAL filesystem, failover, event loss, durability modes, auth provider duties, or backup. |

## Smallest coherent replacement boundaries

### 1. Verified execution context

One immutable context must be created at admission and passed through query, mutation, procedure, SSE, nested transaction calls, subscriptions, and scheduled work:

```ts
type ExecutionContext = {
  requestId: string;
  traceContext: TraceContext;
  principal: AnonymousPrincipal | VerifiedPrincipal | WorkloadPrincipal;
  authEpoch: bigint;
  deadline: number;
};
```

Transport owns credential extraction; a configured verifier owns trust; runtime owns propagation. Authentication failures and authorization denials are stable distinct outcomes. Refresh replaces the connection principal only after full verification, increments the auth epoch, and causes affected subscriptions to re-evaluate. Subscription sharing must include a proven policy/auth fingerprint; default to per-principal scope when safety cannot be proved. Scheduled work needs an explicit system/workload principal or persisted originating principal policy, never an accidental anonymous constant.

This replaces `ANONYMOUS` injection and prevents identity logic from being duplicated in WS/HTTP/SSE handlers.

### 2. Bounded admission scheduler

Replace promise-tail `Mutex` as the public workload boundary with one configurable admission owner for:

- connections;
- per-connection and global in-flight operations;
- writer turns and read turns;
- subscriptions;
- dirty/revalidation work;
- scheduled backlog; and
- telemetry buffer occupancy.

Each accepted item carries enqueue time, connection/tenant fairness key, deadline, cancellation, and stable operation kind. Rejection produces the shared overload outcome with retryability/retry-after. SQLite `busy_timeout` remains a last-mile storage guard, not the scheduler. The scheduler may still execute one writer at a time; the change is finite, fair, observable ownership rather than a new database concurrency model.

### 3. Durable commit and ordered publication coordinator

The transaction boundary must atomically persist:

- monotonic `commitVersion`;
- application writes;
- dependency/change descriptors;
- scoped mutation request identity, outcome, args/function fingerprint, and commit version; and
- any durable scheduled/outbox state.

After COMMIT, one ordered coordinator publishes versions. Expensive revalidation stays outside SQLite, but every result is tagged with the version it evaluated and stale generations cannot overwrite newer state. A later commit may coalesce work, but if intermediate history is not provable, the public result is reset plus an authoritative snapshot—not a guessed patch.

This boundary owns acknowledgement durability. It must return the actual configured policy and commit version, not relabel `COMMIT` as an unspecified durable event.

### 4. Versioned subscription/session transition state

Subscription setup must be serialized against ordered commit publication without holding a writer transaction:

1. evaluate an authoritative snapshot at version N;
2. install its dependency/policy record as valid at N before publication advances past it;
3. emit snapshot/reset from an explicit previous state to N; and
4. process only later versions.

Per-entry state needs evaluation generation, dirty/coalesced target version, auth fingerprint/epoch, and bounded listeners. Per-connection state needs current transition version, desired subscriptions, last delivered/applied version, and bounded resume history/cursor. Frames carry atomic `from` and `to` states. Duplicate/out-of-order/mismatched frames are rejected and trigger reset.

Query subscriptions can continue targeted full recomputation; advanced incremental result deltas remain out of scope. Event subscriptions need an explicit enforced choice: durable/bounded history with resume, or live-only delivery with reset/loss semantics. Per-process IDs without a contract are insufficient.

### 5. Bounded delivery and client convergence

Server transport owns a finite byte-accounted queue per session, uses WebSocket/SSE backpressure signals, and disconnects or resets slow consumers with a structured reason. It never lets one subscriber block the commit coordinator or grow memory indefinitely.

The client owns strict transition validation and keeps each pending mutation's required commit version. A mutation Promise resolves only after:

1. the server acknowledgement says the commit satisfied its durability policy; and
2. every caller-relevant local subscription is at or beyond that commit through valid transitions or an authoritative reset.

This avoids a server/client acknowledgement round-trip solely for callbacks: the client can gate resolution on frames it already applied. HTTP mutation behavior must be decided explicitly: either associate it with a live session/convergence token or remove it from the public mutation path; do not claim WebSocket convergence for an unrelated HTTP response.

Reconnect includes auth refresh, bounded desired/pending state, stable mutation IDs, server overload hints, jitter, and a stable-open threshold before resetting backoff. Procedures remain non-retried/indeterminate on transport loss unless the application explicitly supplies its own idempotency contract.

### 6. Lifecycle/storage health and telemetry

One lifecycle state machine should own `starting -> ready -> draining -> stopped` plus failure reason:

- liveness means the process/event loop is alive;
- readiness requires opened/validated DB, successful reconciliation/recovery, armed runtime, and not draining;
- drain stops admissions, bounds existing work, closes/reset streams, waits until deadline, then closes runtime/engine;
- startup performs configured integrity/recovery checks and exposes the durability mode;
- backup creates a verified consistent artifact; restore targets a fresh process/path and verifies integrity/schema/commit metadata before readiness.

Telemetry attaches to these owning transitions. A backend-neutral in-process sink receives low-allocation stage events/counters, exports asynchronously through a bounded buffer, records drops/export health, and never participates in commit or delivery success. Metrics use bounded operation/function/outcome/resource dimensions; high-cardinality IDs stay in traces/diagnostic events. Sanitization happens before buffering.

## Code-quality and complexity assessment

The present prototype is compact and mostly has one reason per file: `Engine` owns physical SQLite mapping, `db.ts` owns DB mechanics, `reactive.ts` owns dependency indexing, and `serve.ts` is a thin transport. The pressure point is `Runtime`: it already owns fetch guarding, two mutexes, identity injection, transactions/idempotency, post-commit work, subscriptions, SSE, events, and scheduling. Adding every new guarantee through flags and conditionals there would make it the milestone's failure nexus.

Keep net complexity down by extracting state owners with real invariants, not forwarding wrappers:

- commit/storage transaction owner;
- subscription publication owner;
- operation admission owner;
- service lifecycle owner; and
- telemetry pipeline owner.

Do not add exported functions that only call another function. Keep `dbz.ts`, `schema.ts`, `dbtypes.ts`, `refs.ts`, and codegen stable unless a production invariant belongs there. Replace protocol v1 and anonymous runtime behavior directly; no compatibility layer is required.

## Proposed later file ownership

| Packet/owner | Exclusive primary files | Contract handoff |
| --- | --- | --- |
| C1 shared contracts | `packages/core/src/protocol.ts`, `packages/core/src/index.ts`, new core outcome/contract types; public auth/outcome context in `packages/server/src/functions.ts` and exports in `server/src/index.ts` | Freeze wire state/outcome/version/auth vocabulary before server/client work. Preserve `refs.ts` inference and `wire.ts` encoding. |
| S1 storage/commit/runtime | `packages/server/src/engine.ts`, `db.ts`, `keys.ts`, `runtime.ts`, `reactive.ts`, `registry.ts`, `reconcile.ts`; new `auth.ts`, `admission.ts`, `commit.ts`, `lifecycle.ts`, backup/recovery modules; `packages/cli/src/app.ts`, `config.ts`, `main.ts` | Expose transport-facing session/admission/subscription interfaces and lifecycle probes; do not edit client or serve. |
| C2 transport/client | `packages/server/src/serve.ts`; `packages/client/src/client.ts` and `client/src/index.ts` | Consume C1 messages and S1 interfaces; own credential transport, bounded WS/SSE delivery, refresh, reconnect/resume/reset, outcomes, and client convergence. |
| T1 telemetry | New telemetry schema/pipeline/export/local-output modules first; after C1/S1/C2, instrument owning files in one sequential pass | Do not create a second application queue or call-through wrapper layer. |
| Q1 behavior/fault tests | New fixtures/process/fault helpers plus focused additions under `packages/{core,server,client,cli}/test` | Bind to public protocol/endpoints and deterministic barriers, not private class names. |
| P1 benchmark | `bench/benchmark.ts`, `workload.ts`, `dbzz-client.ts`, `run.ts`, `bench/README.md`, new records | Add telemetry-on/off DBZZ legs, stage/export accounting, and prior-win gates without weakening common correctness. |
| Root integration/docs | README, production protocol/operations/telemetry/limitations docs, package exports/manifests | Resolve cross-packet semantics and preserve the pre-existing dirty manifest/version shape manually. |

Suggested new test boundaries:

- `core/test/protocol.test.ts`: outcomes, versions, and frame validation;
- `server/test/auth.test.ts`: verifier and fail-closed policy;
- `server/test/commit.test.ts`: durable versions, dedupe scope, ordered publication barriers;
- `server/test/subscription-state.test.ts`: snapshot race, stale generation, auth revalidation, reset/history loss;
- `server/test/admission.test.ts` and `serve-overload.test.ts`: finite queues, fairness, byte limits, slow consumers;
- `server/test/storage-operations.test.ts`: durability, integrity, backup/restore;
- `server/test/telemetry.test.ts`: stages, privacy, cardinality, export failure;
- `client/test/realtime-state.test.ts`: duplicate/out-of-order/mismatch/resume/reset/convergence;
- `cli/test/lifecycle.test.ts` and `process-faults.test.ts`: startup/readiness/drain/crash/restart/lost ACK.

## Main risks and dependencies

1. Version fields alone do not fix the existing subscription setup race; registration ordering and stale-evaluation rejection must land with commit publication.
2. Keep recomputation/fanout outside the SQLite writer while preserving ordered publication; otherwise correctness or benchmark throughput will regress.
3. Never wait indefinitely for a disconnected client to acknowledge delivery. The server produces a bounded ordered stream; the client gates its Promise on applied transition/reset.
4. Function-plus-args sharing becomes a data-leak boundary once auth exists. Default to principal/policy isolation unless equivalence is proved.
5. Application role/ownership changes need explicit auth dependency tokens and invalidation triggers; token refresh alone cannot discover them.
6. Global one-hour idempotency is neither safely scoped nor exact forever. Scope records by session/principal/function/args and make retention an explicit contract.
7. Event subscriptions and scheduled work need explicit crash/loss semantics. Current event IDs reset; current scheduler deletes before execution.
8. D2 must confirm the actual Bun/SQLite durability, checkpoint, integrity, backup, and transport-backpressure APIs before public types freeze.
9. Telemetry must sanitize before buffering, keep metric labels bounded, and export off commit/delivery. Measure allocations as well as latency/CPU/RSS.
10. Lifecycle must sequence CLI, admissions, transport, scheduler, runtime, and engine under one deadline; current `stop()` is not that boundary.
11. Dirty manifests are user work. Any new dependencies/exports require manual merge, never overwrite or revert.
12. Benchmark acceptance needs explicit DBZZ-vs-Convex margins and every retained DBZZ-over-SpacetimeDB win, not only current same-system delta warnings.

## Integration order

1. Preserve B0 full baseline for current HEAD.
2. Freeze C1 protocol/outcome/auth/version semantics.
3. Land S1 commit/admission/subscription/lifecycle/storage owners with deterministic fault barriers.
4. Adapt C2 transport/client state.
5. Land T1 pipeline and instrument existing owners sequentially.
6. Add Q1 public/fault suites.
7. Add P1 telemetry profiles and comparison gates.
8. Run V1 narrow-to-broad tests, typecheck, process cleanup, and repeated full benchmarks.

Issue #1 remains one acceptance boundary; partial state owners must not be described as production readiness.
