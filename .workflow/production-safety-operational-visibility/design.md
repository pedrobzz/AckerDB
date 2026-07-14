# Implementation design: production safety and operational visibility

## Acceptance boundary

This milestone replaces the prototype contract. Protocol v1, implicit anonymous
execution, message-only errors, unversioned updates, unbounded promise tails,
`/health`, and hard-coded SQLite `NORMAL` durability are removed rather than
kept behind compatibility branches.

The implementation is accepted as one single-node state machine:

```text
credential -> verified execution -> bounded admission -> selected-policy commit N
    -> ordered dependency publication -> atomic subscription transition
    -> bounded transport delivery -> client application -> mutation resolution
```

Telemetry observes every owning boundary but never participates in commit or
delivery success. Application return types remain inferred from handlers; only
framework envelopes are validated at runtime.

## Public contract

### Identity and authorization

- Every transport constructs an explicit `Principal`: `anonymous`, `user`,
  `workload`, or `system`. A bearer credential is never treated as anonymous
  when verification fails.
- WebSocket clients must start with a protocol-2 `hello` containing an explicit
  anonymous or bearer credential and a stable client session ID. HTTP and SSE
  construct the same principal per request from the Authorization header;
  absence means explicit anonymous. Scheduled work uses the explicit system
  principal. Nested calls keep the exact frozen parent principal and trace.
- Registered functions declare `access`: `public`, `authenticated`, `system`,
  or a policy callback. Missing access is a registration/type error. A policy
  exception fails closed. `unauthenticated` and `unauthorized` have distinct
  stable outcomes without disclosing protected data.
- One `Invocation` owner validates arguments, re-runs the callee's access policy,
  creates child telemetry, and invokes the handler for every top-level and nested
  query, mutation, procedure, SSE, and scheduled call. A direct nested call uses
  the parent's exact snapshot/transaction, principal, deadline, and trace; it
  cannot bypass or replace the callee policy.
- Query policies run in the same recorded read snapshot as the handler, so role
  and ownership reads become subscription dependencies. Shared computation keys
  use only a stable policy-scope fingerprint that proves equivalence; auth epoch
  remains session-local and is always part of resume cursors.
- One per-connection `Session` owner serializes auth attempts, auth epoch, cursor
  state, outbound delivery, resets, and mutation convergence. Refresh increments
  a monotonic attempt ID and pauses new operations. Latest-attempt-wins; stale
  verifier completions are discarded. Success rotates the delivery generation,
  drops queued old-epoch frames, emits revocation/reset before exposing the new
  identity, and resumes admission. Sign-out performs the same transition to
  anonymous. Any failed refresh fails closed and terminates the old authenticated
  session rather than leaving it active.
- Token expiry is a hard server timer. External invalidation is accepted into a
  reserved control slot and closes/revalidates matching sessions within
  `revocationDeadlineMs` (default 5,000 ms). A JWT-only verifier without an
  invalidation/introspection source advertises expiry as its revocation bound;
  it never claims immediate revocation.
- `createOidcVerifier` is a configured JWT access-token verifier, not an OIDC
  login client. It rejects credentials over 16 KiB before unverified issuer
  decoding, exact-selects a configured issuer before any network request, pins
  issuer/audience/algorithms and required token type, requires `exp`, enforces
  `exp`/`nbf`, and reuses a bounded remote-JWKS resolver. JWKS fetches have a
  5 s deadline, 1 MiB response cap, cache/cooldown bounds, and at most 32 keys
  count. Raw tokens and claims never enter telemetry.
- Principal source/policy matrix: WS/HTTP/SSE use verified bearer or explicit
  anonymous; nested calls reuse the parent and re-run the callee policy;
  scheduled mutations resolve a configured workload credential at execution or
  use the explicit local-system principal. Invalid workload credentials leave
  the scheduled row due and record a fail-closed outcome. Scheduled procedures
  are rejected.

### Stable outcomes

All transports use one structured outcome containing a stable code,
retryability, optional bounded retry delay, optional resource class, and a safe
message. Outcome codes are `malformed`, `validation`, `unsupported_protocol`,
`unauthenticated`, `auth_unavailable`, `auth_stale`, `unauthorized`, `not_found`,
`conflict`, `overloaded`, `slow_consumer`, `deadline_exceeded`, `draining`,
`unavailable`, `convergence_unavailable`, `indeterminate`, and `internal`.
Resource values are `connection`, `operation`, `reader`, `writer`,
`subscription`, `revalidation`, `publication`, `outbound`, `sse`, `history`,
`idempotency`, and `telemetry`. Retry delay is an integer from 0 through 30,000
ms. HTTP maps malformed/validation/unsupported to 400, unauthenticated to 401,
unauthorized to 403, not-found to 404, conflict to 409, scoped overload to 429,
service/drain/publication overload to 503, deadline to 504, and unexpected
failure to a generic 500. WS request errors use an `err` frame; connection-level
auth/protocol/backpressure failures emit a best-effort terminal outcome then
close with 1008, 1002, or 1013 respectively. SSE returns a pre-stream HTTP
outcome or a terminal `event: dbzz-error` frame. The client exposes the exact
outcome through `DbzzClientError`.

### Protocol 2 and ordered state

- Framework frames carry `v: 2` and are shape-checked after wire decoding.
- A query subscription cursor binds an opaque stream generation, durable commit
  version, auth epoch, and canonical subscription identity. Transitions carry an
  exact `from` cursor and `to` cursor plus one of `reset`, `update`, `checkpoint`,
  or `revoked`.
- Initial state is an authoritative reset. Changed evaluations carry a full
  replacement value; unchanged affected evaluations carry a checkpoint so
  read-your-writes can advance without a duplicate payload.
- A client applies only a matching predecessor. An already-applied duplicate is
  ignored; any other mismatch requests an authoritative reset and exposes no
  speculative state.
- The server retains dormant query entries and bounded transition history by
  count, encoded bytes, and age. Reconnect resumes only when the full cursor
  chain remains provable; otherwise it resets. Restart, schema/auth change,
  pruning, overflow, or unknown generation necessarily reset.
- Event subscriptions are explicitly live-only. Frames carry commit/event
  sequence and a gap/reset marker; reconnect never claims durable event replay.
- Protocol frame unions in `@dbzz/core` are the executable public schema:
  `hello/auth/sub/unsub/reset/q/m/ping` client frames and
  `welcome/auth/transition/event/ok/err/pong` server frames. Mutation `ok`
  contains its receipt; query/procedure `ok` contains a value. Every frame has a
  protocol version, request/subscription IDs have finite integer ranges, and
  unknown fields/types do not select a compatibility interpretation.

### Mutation receipt and exactly-once effects

- Every mutation carries `(clientSessionId, mutationRequestId, function,
  issuedAt, canonicalArgsFingerprint, principalFingerprint)`. Request IDs are
  UUIDv7 so an unknown request older than the retry window can be rejected
  without retaining a tombstone forever.
- The application writes, durable monotonic commit version, exact stored result,
  request identity/fingerprints, change descriptors, events, and scheduled work
  state commit atomically. Reusing an ID with different semantics is a stable
  conflict. Encoded results are capped at 1 MiB. The default replay window is
  24 hours; mutation records are finite by 1,000,000 records and 4 GiB encoded
  results. Capacity rejects new mutations before execution. Records may be
  pruned only after the replay window; an unknown expired UUIDv7 is rejected as
  unverifiable and is never silently re-executed.
- A mutation receipt includes commit version, configured durability, replay
  status, and an obligation set. For a live first execution, relevance is the
  caller session's query subscriptions whose recorded dependency or access-policy
  read set intersects the transaction write set; event subscriptions never
  participate. On replay after reconnect/restart, all currently active query
  subscriptions are conservatively obligations. Ordered transition frames are
  emitted before the receipt on the WebSocket. The client resolves only when
  every obligation has applied a valid transition/reset at or beyond the receipt
  version. Unsubscribe discharges that local obligation because no subscribed
  state remains; explicit revocation/reset at or beyond the version also counts.
  Evaluation failure produces non-retryable `convergence_unavailable` with
  `committed: true`; it never invites retry of the mutation effect. Disconnect
  keeps the request pending for bounded reconnect; client close terminates it.
  With no relevant subscription, selected-policy commit is sufficient.
- Lost receipts and process restart replay the persisted result/receipt without
  re-executing. Procedures are never automatically retried and transport loss is
  reported as indeterminate when completion is unknowable.

## Owning implementation boundaries

### Storage and commit coordinator

- `Engine` defaults explicitly to `production` (`FULL`) and also offers the
  observable `balanced` (`NORMAL`)
  durability profiles, WAL setup, busy timeout, startup quick/integrity and
  foreign-key checks, DBZZ internal-schema validation, clean-shutdown state,
  checkpoint status, database/WAL sizes, atomic online backup, and fresh-copy
  restore verification.
- Startup recovery has a 5 s busy deadline, performs `quick_check`,
  `foreign_key_check`, and DBZZ internal ledger/schema/terminal-commit checks;
  full `integrity_check` is a public scheduled/manual operation. Checkpoints run
  only on the serialized writer owner with a configured mode/deadline and expose
  busy, total, checkpointed, residual frames and oldest-reader availability.
  DBZZ rejects multi-process writers and never concurrently checkpoints from a
  second connection, avoiding the SQLite 3.51.0 WAL-reset race; a future design
  that permits that concurrency must require SQLite 3.51.3+ or a fixed backport.
- `_dbz_state` stores the monotonic commit version and lifecycle metadata.
  `_dbz_mutations` stores scoped request identity, fingerprints, encoded result,
  commit version, issued/completed timestamps and result bytes. In-memory
  subscription history is never mistaken for durable replay history; no general
  durable commit journal is added unless a recovery consumer requires it.
- A bounded FIFO writer scheduler serializes `BEGIN IMMEDIATE` transactions.
  Successful transactions increment and persist the commit version before
  COMMIT. Admission reserves a bounded publication slot before `BEGIN`; rollback
  releases it and successful COMMIT fills it without allocation/failure. The
  writer turn synchronously hands off that slot before the next commit can
  append. Mutations are cancelable only while queued; after `BEGIN` they finish
  and persist a receipt even if the caller disconnects or its deadline expires.
- Subscription evaluation happens outside the writer transaction. Each read
  snapshot reads `_dbz_state` inside the same transaction as the query. Stale
  generations cannot overwrite newer state; coalescing may advance directly to
  a newer authoritative version.
- Subscription registration uses optimistic evaluation at N, then a short
  compare-and-install gate against the publication high-water mark. If a commit
  was handed off after N, registration retries; otherwise it installs the
  dependency/policy record and reset frame atomically. Query evaluation never
  holds the global publication gate.
- Scheduled mutations execute handler plus due-row deletion in one transaction;
  a crash before COMMIT leaves the row due. Scheduled procedures are rejected.

### Bounded admission and delivery

- A small bounded-queue primitive is reused, while FIFO writer admission,
  bounded reader admission, and coalesced revalidation remain separate owners.
  Reader/revalidation work is round-robin by fairness key with one item per turn;
  a cold active key starts within at most the number of active keys already in
  the round. Items carry encoded-byte cost, enqueue time, maximum queue age,
  deadline, cancellation, and operation kind. A handler is not preemptible, so
  the service bound is turns rather than wall time. Finite queues reject with a
  typed outcome and retry hint.
- Service limits cover global/per-connection connections, operations,
  subscriptions, shared entries, revalidations, scheduled batches, WebSocket
  buffered bytes, SSE bytes, request/frame bytes, resume history, and telemetry.
  Defaults support the existing 1,000-connection and 25,000-subscription
  benchmark profiles while remaining finite; tests use deliberately tiny limits.
- Publication/revalidation work carries immutable originating trace/link context;
  deferred fanout does not rely on AsyncLocalStorage surviving a queue boundary.
  Optional `RuntimeHooks.wait(stage, context)` gates use the same stable telemetry
  stages and let fault tests pause the owning state machine without a duplicate
  test path.
- Per-connection WebSocket message processing is serialized and finite. Bun
  `getBufferedAmount()` plus the next encoded frame are preflighted; Bun is
  configured with `backpressureLimit`, `closeOnBackpressureLimit`,
  `maxPayloadLength`, and idle timeout. `send() === -1` means the frame was
  already queued and scheduling pauses until `drain`; `0` is failure. A slow
  peer receives a best-effort outcome and authoritative 1013 close when its byte
  or stall-age limit is reached. Healthy peers do not await it.
- SSE encodes into a byte-length-bounded stream, observes pull/cancel pressure,
  and terminates with an explicit slow-consumer outcome. The client parser also
  has a finite frame/buffer bound.
- Client reconnect uses injectable clock/random, exponential full jitter,
  server retry guidance, a stable-open reset threshold, and finite pending
  request/subscription state.
- Reconnect defaults are 100 ms base, 3 s cap, full jitter, 10 s stable-open
  reset, and server retry guidance clamped to 30 s. Pending client state is
  capped by 4,096 items, 16 MiB encoded bytes, and the 24-hour mutation replay
  window; ordinary queries expire after 30 s.

### Lifecycle, recovery, backup, and restore

- `DbzzServer` owns `starting -> ready -> draining -> stopped|failed`.
  `/live` reports process/event-loop liveness. `/ready` succeeds only after DB
  open/recovery/checks, reconciliation, runtime startup, and while admissions
  are enabled. Versioned `/status` exposes bounded operational gauges and
  durability only to a verified system/workload principal with the configured
  status scope; health endpoints reveal no protected details.
- Drain atomically disables admissions and readiness, stops accepting sockets,
  and rejects/cancels queued-not-started work. Already-started mutations finish;
  admitted finite queries/procedures finish only inside their deadline. Sessions
  remain open long enough to receive committed transitions/receipts; subscriptions
  and SSE are not counted as drainable work and are then explicitly terminated.
  Telemetry flushes within the remaining deadline, runtime/engine close, and the
  server force-closes at the deadline. CLI `start` installs SIGINT/SIGTERM handling and
  emits structured lifecycle events.
- Startup never deletes WAL/SHM sidecars. Under `production`, an acknowledged
  commit promises process, OS, and power-loss survival subject to SQLite/storage
  sync guarantees; `balanced` promises process-crash consistency but explicitly
  permits recent loss after OS/power failure. Corruption or internal-ledger
  mismatch fails before readiness.
- Public CLI `backup` runs `VACUUM INTO` on the serialized writer owner, requires
  successful completion, fsyncs and atomically promotes the artifact, computes a
  SHA-256 digest, then a fresh child process restores and verifies integrity,
  foreign keys, DBZZ invariants, schema fingerprint, and terminal commit. It
  returns a manifest with digest, bytes, schema fingerprint, commit version,
  durability, and verification time. CLI `restore` accepts only a fresh target,
  verifies the manifest/artifact in a fresh process, atomically promotes it, and
  proves the next commit can succeed before reporting success.

### Telemetry

- A backend-neutral `TelemetryExporter` receives bounded batches of safe span,
  metric, and event records. Default telemetry is enabled. Disabled mode has one
  early branch and allocates no record/queue work.
- Runtime AsyncLocalStorage carries immediate trace/request/connection/transaction/commit
  context through nested queries, mutations, transactions, procedures, fetches,
  and SSE. Deferred scheduler, publication, subscription evaluation, encoding,
  fanout, and delivery work carries explicit immutable trace links.
- Span stage timings distinguish admission wait, handler, statement/storage,
  transaction/commit/rollback, dependency match, evaluation, changed/unchanged,
  encoding, fanout queue, socket delivery, and end-to-end commit lag.
- Metrics use bounded operation/function/outcome/resource dimensions. Request,
  mutation, connection, commit, subscription, principal, and argument identities
  appear only in traces/diagnostic events. Cardinality overflow folds into one
  explicit series.
- Sanitization occurs before retention or buffering. Tokens, cookies, headers,
  raw claims, args, results, payloads, and literal SQL are absent by construction.
  Unexpected error events contain class/stable code, never arbitrary messages.
- Export is asynchronous, finite by records and bytes, timeout-bounded, and
  fail-open. Queue drops, overflow, exporter attempts/failures/duration/last
  success are locally observable. Slow and failed traces are retained by
  default only within a 2,048-record/4-MiB/5-minute ring. Export batches are at
  most 512 records, scheduled every 1 s with a 5 s timeout, and failed batches
  are dropped visibly rather than retried indefinitely. Shutdown never waits
  beyond the service drain deadline.
- The default local sink emits one-line safe JSON for lifecycle, overload,
  exporter degradation, slow operations (default 100 ms), and failures. A 1 s
  sampler records CPU, RSS, event-loop delay, active connections/subscriptions,
  operation/queue counts and bytes/oldest age, database/WAL/checkpoint state, and
  exporter health. `/status` remains locally readable under exporter outage.
- Telemetry schema version 1 uses operation names `query`, `mutation`,
  `procedure`, `sse`, `transaction`, `scheduled`, `subscription`, `backup`,
  `restore`, and `lifecycle`; stages `admission`, `auth`, `policy`, `handler`,
  `statement`, `storage`, `commit`, `rollback`, `publication`, `match`,
  `evaluation`, `changed`, `unchanged`, `encoding`, `fanout`, `queue`,
  `delivery`, and `export`; durations are milliseconds and sizes are bytes.
  Records carry schema version, timestamps, trace/span/link IDs, low-cardinality
  operation/function/outcome/resource fields, optional high-cardinality request/
  connection/mutation/commit/subscription IDs outside metric labels, row/result
  counts when knowable without extra scans, replay/dependency/post-commit facts,
  and no raw payload fields. Payload capture is unsupported in this milestone.
- With `enabled: false`, no span/event/metric records, timers, sampler, exporter,
  retention ring, or queue are constructed; `/status` reports only the disabled
  mode and essential lifecycle/capacity counters maintained by their owners.

## Configuration defaults

Defaults are production-safe and finite. The comparative benchmark explicitly
selects the observable `balanced` durability profile so results remain comparable
to its historical NORMAL baseline; it must never label that profile power-loss
durable.

| Resource | Default |
| --- | ---: |
| connections | 4,096 |
| global in-flight operations | 4,096 |
| in-flight operations per connection | 128 |
| queued reads / writes | 4,096 / 4,096 items; 32 / 32 MiB; 30 s age |
| subscriptions per connection / global | 1,024 / 100,000 |
| shared subscription entries / cached result bytes | 100,000 / 128 MiB global |
| pending revalidations | 100,000 items; 32 MiB; 30 s age |
| WebSocket bytes | 4 MiB per connection; 64 MiB global; 5 s stall |
| SSE bytes | 1 MiB per stream; 32 MiB global; 5 s stall |
| request / frame bytes | 1 MiB |
| resume transitions / bytes / age | 64 / 2 MiB per stream / 30 s; 128 MiB global |
| scheduler batch / turn | 100 / one fairness-key item |
| publication slots | 4,096 items; 32 MiB reserved before transaction |
| client pending state | 4,096 items; 16 MiB; query age 30 s |
| mutation replay | 24 h; 1 MiB result; 1,000,000 rows; 4 GiB results |
| auth token / JWKS response / revocation | 16 KiB / 1 MiB / 5 s |
| telemetry records / bytes / metric series | 2,048 / 4 MiB / 2,000 per service |
| telemetry batch / interval / timeout / retention | 512 / 1 s / 5 s / 5 min |
| recovery busy / checkpoint / integrity | 5 s / serialized writer / quick at startup |
| graceful shutdown deadline | 10 s |

## Verification slices

1. Protocol/outcome/auth compile-time and runtime envelope tests; explicit
   access and return inference checks.
2. Engine restart, version, scoped idempotency mismatch, durability reporting,
   corruption refusal, checkpoint, backup/fresh restore, and scheduled atomicity.
3. Deterministic subscription setup/commit race, stale evaluation, resume chain,
   history loss reset, auth refresh/revocation, duplicate/out-of-order client
   frames, and read-your-writes receipt convergence.
4. Tiny-limit saturation for every queue/resource, fair cold-peer progress,
   unread WebSocket/SSE, cancellation, retry hints, finite counters, and cleanup.
5. Process-level live/ready/startup failure/drain/deadline/SIGKILL/restart/lost
   receipt tests with no sleeps standing in for semantic readiness.
6. Telemetry complete-path correlation, stage schema, privacy canaries,
   cardinality overflow, stalled/failed exporter, disabled fast path, and bounded
   shutdown.
7. DBZZ telemetry-on and disabled benchmark profiles plus full Convex and
   SpacetimeDB comparison, correctness/mode gates, process cleanup, and repeated
   runs before accepting any regression. B0 freezes the exact prior DBZZ wins,
   the Convex margin floors, and server-confirmed telemetry/durability mode in a
   separate baseline artifact before structural edits.

## Explicit remaining limitations

Single process/node and one SQLite writer per database; no automatic failover,
replication, consensus, multi-region, sharding, hosted control plane, persistent
offline client cache, conflict resolution, or durable event replay. OIDC verifies
externally issued credentials; DBZZ is not a credential-issuance product. Live
revocation latency depends on the configured expiry/introspection/invalidation
source. `balanced` durability may lose recently acknowledged commits on OS/power
failure and is never described as production power-loss durability. Native
browser SSE uses fetch streaming or an explicitly secured cookie deployment;
bearer tokens are never placed in URLs. Completing this milestone removes the
listed blockers but is not a blanket claim that DBZZ is fully production-ready.
