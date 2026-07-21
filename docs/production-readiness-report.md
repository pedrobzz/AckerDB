# Production Safety Milestone and Production-Readiness Report

> Historical report (2026-07-14). Its frozen-baseline and local/current-host
> benchmark procedure is superseded. Current release evidence is version-bound,
> runs on Hetzner only, compares with the preceding final version, and retains
> no timestamp records. Imperative benchmark instructions or blockers below
> describe the old state and must not be followed; see [the benchmark contract](../bench/README.md).

- Date: 2026-07-14
- PRD: [GitHub issue #1 — Production safety and full operational visibility](https://github.com/pedrobzz/dbzz/issues/1)
- Whole-branch comparison: `4aa2b1e` through audited snapshot `17a2524`
- Issue #1 starting HEAD: `74d8554`
- Branch: `codex/benchmark-capacity`
- Product scope: single-node, self-hosted Bun + SQLite alpha
- Benchmark scope: DBZZ versus the Convex local development backend and
  SpacetimeDB 2.6.1 on the same machine

## Executive assessment

This milestone changed DBZZ from a fast prototype with several implicit
behaviors into a credible **single-node production-safety foundation**. It now
has strict authentication boundaries, ordered realtime convergence,
crash-safe mutation replay, finite resource ownership, explicit lifecycle and
durability states, verified backup/restore, and privacy-safe correlated
telemetry. Those guarantees are enforced at public boundaries and exercised by
fault tests rather than being documentation-only claims.

It did **not** turn DBZZ into a managed database platform. DBZZ remains behind
Convex Cloud and SpacetimeDB Maincloud in the operational product around the
engine: hosted deployment, replication and failover, automated backup
retention, deployment environments, secrets and access administration,
dashboards, bundled integrations, support, SLA, and ecosystem maturity. It is
also behind SpacetimeDB in the saturated mutation, server-compute, and
multi-writer partitioned-subscription shapes measured on Hetzner.

The current honest product statement is:

> DBZZ is a bounded, observable, crash-tested single-node backend alpha with a
> strong local performance profile. It is not yet a managed, highly available,
> horizontally scalable database service.

The Hetzner diagnostic supports the performance half of that statement. On one
idle 3-vCPU/3.7-GiB host, the successful 4m12s same reduced-workload run put DBZZ at
5.11×–20.60× the throughput of the Convex local backend across 16 operation
cells, with a 13.42× median, while using much less memory at 500 connections.
This is not a hosted Convex comparison. SpacetimeDB retained clear wins in the
workloads where its architecture is strongest. The SpacetimeDB leg was local
Standalone 2.6.1; it does not establish Maincloud latency, capacity,
replication, backup, or SLA behavior.

One newly identified release blocker prevents claiming a clean-clone-complete
benchmark gate: `bench/results/2026-07-13T15-34-33Z-74d8554.json` is untracked,
but committed benchmark code and tests load it as the immutable baseline. Local
tests see the file; a clean checkout does not. The baseline must be committed
atomically or the gate must be redesigned before CI/release readiness can be
claimed.

## Scope and scale of the work

At the audited `17a2524` snapshot, the whole branch comprised 127 atomic commits
from `4aa2b1e`, including Pedro's pre-existing `74d8554` benchmark-capacity
commit. Issue #1 implementation after that starting HEAD comprised 126 commits,
119 files, 50,392 additions, and 1,722 deletions.

The whole-branch commit-type breakdown was:

| Commit type | Count |
| --- | ---: |
| `feat` | 52 |
| `fix` | 40 |
| `test` | 18 |
| `perf` | 12 |
| `docs` | 3 |
| `refactor` | 2 |

The audited whole-branch Git diff covers 140 files. The apparent 90,079 added
lines include 36,073 lines of committed benchmark result JSON and 2,135 lines
of workflow evidence.
The more useful breakdown is:

| Area | Files | Added | Deleted | Net |
| --- | ---: | ---: | ---: | ---: |
| Product source | 38 | 17,194 | 932 | +16,262 |
| Tests | 47 | 27,084 | 541 | +26,543 |
| Benchmark harness | 27 | 6,101 | 271 | +5,830 |
| Product documentation | 5 | 1,481 | 73 | +1,408 |
| Workflow/audit evidence | 13 | 2,135 | 0 | +2,135 |
| Benchmark result records | 6 | 36,073 | 0 | +36,073 |

The test-to-product addition ratio is intentionally high. Authentication,
crash recovery, transport interruption, slow consumers, telemetry failure,
corruption, and reconnect ordering are difficult to trust through ordinary unit
tests; most were proved with process, socket, or fault-injection boundaries.

## Starting point

Before this milestone, DBZZ already had four useful foundations:

1. mutation results and idempotency keys were stored in the same SQLite
   transaction as application writes;
2. reads used a coherent WAL snapshot while writes serialized through one
   writer turn;
3. precise dependency keys targeted shared-query recomputation; and
4. the client reconnected, reused mutation IDs, and resubscribed.

Those were local mechanisms, not a complete production state model. The main
gaps were:

- every invocation was effectively anonymous;
- transport frames were loosely trusted and failures were message strings;
- commits, subscriptions, delivery, and client acknowledgement shared no
  durable ordering identifier;
- mutation replay was weakly scoped and pruned without a strong ambiguity
  contract;
- operation, revalidation, ingress, and outbound queues were not comprehensively
  bounded by item count, bytes, and age;
- WebSocket and SSE buffering did not expose one application-owned resource
  contract;
- startup, readiness, draining, clean/unclean shutdown, corruption refusal, and
  backup verification were incomplete;
- there was no safe default telemetry model covering the complete operation;
  and
- the benchmark did not measure the cost of those guarantees.

The core design conclusion was that adding isolated guards would preserve the
wrong ownership model. The implementation therefore introduced explicit owners
for identity, admission, commit publication, subscription transitions,
delivery, lifecycle/storage health, and telemetry.

## Decision ledger

The table below records the material decisions made during implementation and
benchmarking, why they were made, and what DBZZ gained.

| Decision | Why | Gain | Cost or limitation |
| --- | --- | --- | --- |
| Scope the milestone to one process and one SQLite database. | The PRD explicitly asked for a production-safety foundation, not a clone of hosted Convex or distributed SpacetimeDB. | A tractable, testable contract with fewer dishonest claims. | No replication, failover, sharding, or multi-region availability. |
| Replace the old wire contract with strict Protocol 2 instead of preserving compatibility. | The repository forbids unrequested backwards compatibility, and the old frames could not express auth, outcomes, ordering, reset, or receipts safely. | One versioned, strictly parsed protocol with bounded identifiers and stable typed outcomes. | Existing pre-Protocol-2 clients must upgrade; there is no compatibility bridge. |
| Require an explicit anonymous or bearer credential. | “No token” is ambiguous and makes identity semantics transport-dependent. | Every request has a deliberate security posture across WebSocket, HTTP, SSE, nested calls, and scheduled work. | Client setup is slightly more explicit. |
| Keep authentication and authorization separate. | Verifying identity does not prove access to one resource. | OIDC/JWKS verifies immutable principals; every function declares public/authenticated/system/custom access and fails closed. | Applications still own domain authorization policy. |
| Pin OIDC providers before examining untrusted issuer input. | An unverified JWT issuer must not choose an arbitrary network destination. | No issuer-driven SSRF/discovery; JWKS, algorithms, audience, expiry, and claim bounds are explicit. | No built-in identity issuance or account-management UI. |
| Model long-lived identity as immutable authentication epochs. | Credential refresh and sign-out can race queued work and live subscriptions. | Old-principal work cannot be relabeled; subscriptions revoke/recompute at the epoch boundary. | Immediate provider revocation still depends on a correctly implemented external invalidation feed. |
| Allocate a durable monotonic commit version and publish in order. | SQLite commit, subscription evaluation, and transport delivery previously had no common ordering fact. | Snapshot/update/checkpoint/resume transitions form one verifiable chain. | One ordered publication coordinator is a single-node serialization boundary. |
| Resume only when a retained contiguous chain proves safety; otherwise reset. | Guessing after reconnect can silently preserve stale state. | Reconnect converges without applying gaps or cross-stream cursors. | Resume history is finite and in-memory; restart causes an authoritative reset. |
| Resolve mutation promises after durability and caller-relevant convergence. | A successful SQL commit alone does not prove that the caller has observed its subscribed state. | Read-your-writes has an explicit receipt and client obligation. | A slow relevant subscription can delay resolution until its bounded outcome. |
| Scope exactly-once replay by stable session/request semantics and UUIDv7 age. | Reusing only a mutation ID can collide across callers or allow forged age metadata. | Crash and lost-ack retries return the original result/durability without re-executing. | Deduplication remains finite; there is no permanent offline mutation journal. |
| Never automatically retry procedures or arbitrary external side effects. | Replaying Stripe/email/fetch work is unsafe even when database retry is safe. | Indeterminate procedure completion is explicit; the application chooses idempotency. | Developers must design external effects deliberately, typically with an outbox/idempotency key. |
| Bound every framework-owned queue by items, encoded bytes, and age. | Item-only limits can be defeated by one huge value; count-only bounds can remain wedged forever. | Memory and waiting are finite for admission, execution, session ingress, publication, revalidation, telemetry, and delivery. | Limits require tuning for real workloads; current defaults are alpha defaults, not universal sizing. |
| Separate node capacity, caller fairness, and connection containment. | One user can open many sockets or switch transports to multiply a naive per-connection share. | Stable principal/source ownership preserves cold-caller progress while per-connection limits contain local abuse. | Callers behind one reverse proxy share its anonymous fairness key because forwarded headers are deliberately untrusted. |
| Use round-robin/yielding work turns instead of draining hot groups. | A permanently dirty query or hot writer can starve unrelated work. | Measurable progress across writers, principals, and subscription groups. | No weighted tenant plans or distributed scheduler. |
| Treat WebSocket transport pressure as a mechanism, not the product contract. | A successful `send` or socket ordering does not prove application delivery or reconnect correctness. | Application frames retain exact budget ownership through buffered delivery and terminate explicitly on overload. | Depends on the pinned Bun transport behavior and requires runtime-specific tests. |
| Add receiver-confirmed cumulative credit to SSE. | Bun may pull response chunks into hidden HTTP buffering; stream `desiredSize` alone is not a peer-pressure proof. | Exact DBZZ-owned bytes, bounded unacknowledged windows, terminal `slow_consumer`, and deterministic release. | This is a fetch-based DBZZ protocol, not native EventSource semantics; it confirms capability-holder receipt and Protocol-2 parsing, not durable application processing. |
| Remove whole-process RSS from the narrow SSE proof. | After exact DBZZ counters and descriptors recovered, Bun/macOS allocator phases still moved by MiB—far above the 96-KiB ownership under test. | A direct, stable ownership proof with 195 fewer lines and no allocator model. | Coarse RSS remains only in the broader combined-pressure and comparative suites. |
| Make lifecycle a monotonic state machine with one absolute drain deadline. | “Stop accepting” without bounded ownership can hang deploys and write a false clean marker. | Separate liveness/readiness, startup phases, admission stop, finite drain, forced unclean close, and exact listener release. | Synchronously blocking JavaScript still requires an outer supervisor hard-kill deadline. |
| Default to SQLite `FULL` durability and make `NORMAL` an explicit balanced profile. | Benchmark settings must not silently become production guarantees. | Acknowledgement has an observable power-loss policy; benchmark trade-offs are explicit. | SQLite still has one writer and local-disk failure-domain limits. |
| Preserve suspicious main/WAL/journal files instead of repairing startup evidence. | Deleting or normalizing corruption can destroy the only incident evidence and serve untrusted state. | Startup refuses malformed internal schemas, inconsistent ledgers, unsupported WALs, and structural damage without clobbering artifacts. | Operators need a documented recovery path and disk capacity for preserved evidence. |
| Record clean versus unclean shutdown explicitly. | Process exit alone does not prove that admitted work, publication, delivery, and storage completed. | Restart knows when crash recovery is required; marker-write failure cannot strand ownership or overwrite the first error. | The marker is local evidence, not a distributed lease. |
| Serialize checkpoints through the owning writer and report progress. | Concurrent WAL-reset/checkpoint ownership is unsafe on affected SQLite 3.51.0–3.51.2 builds, and “checkpoint returned” is not the same as “WAL fully checkpointed.” | One checkpoint owner plus busy, total/checkpointed/residual frames, duration, age, and outcome makes incomplete progress visible without racing the writer. | Long readers can still pin WAL progress; operators must monitor and respond rather than spin. |
| Verify backups by restoring in a fresh process. | Successfully creating a file does not prove it can replace a failed primary. | Digest, schema/runtime metadata, terminal commit, SQLite/DBZZ invariants, and representative reads are checked before acceptance. | Backups are manual/local; retention, scheduling, offsite copy, encryption, and RPO/RTO automation remain external. |
| Execute scheduled mutations atomically with durable row handling. | Deleting a job before invoking it can lose work on crash. | Handler writes and schedule-row removal commit or roll back together; failures back off instead of hot-looping. | There is no managed scheduler dashboard or cross-node lease. |
| Enable telemetry by default but make it bounded, asynchronous, and fail-open. | Visibility is a production requirement, but an exporter outage must never block commits or delivery. | Complete operation/stage coverage with finite memory, exporter health, deadlines, and a truly disabled mode. | The callback is backend-neutral but not a bundled OTLP exporter or hosted observability product. |
| Keep high-cardinality identifiers in traces/events and aggregates low-cardinality. | Putting request/user/subscription IDs in metrics creates unbounded series cost and privacy risk. | Stable dashboards plus incident correlation without raw credentials, arguments, results, or literal SQL. | Payload debugging remains deliberately limited. |
| Retain slow/failed whole-operation traces; aggregate fast success paths. | Serializing every successful span erased much of the performance advantage. | Default diagnostic value with bounded overhead; deferred materialization, prepared frames, and cached contexts preserve the hot path. | Tail retention is an in-process bounded policy, not durable trace storage. |
| Preserve TypeScript return inference and validate wire representability, not speculative runtime output schemas. | The PRD required evidence before paying runtime and authoring cost for redundant output declarations. | Query/mutation/procedure return types flow from handlers through codegen with no duplicate schema. | Runtime cannot prove a handler result matches a declared output type; it only proves safe encoding and bounds. |
| Compare equivalent logical work on the same machine. | Cross-machine or unequal durability/concurrency claims would be marketing rather than measurement. | DBZZ, Convex, and SpacetimeDB share dataset, operation shape, offered load, correctness checks, and resource accounting. | Microbenchmarks still do not model hosted WAN, multi-node, auth-heavy, or application-specific workloads. |
| Separate benchmark workload identity from measurement effort. | Requiring the historical warmup/duration/trial count made a full run needlessly slow without changing what was exercised. | The full 351-path acceptance keeps all dimensions while fixed windows fall from ~23m23s to ~6m13s. | Short runs increase statistical noise; apparent regressions still need reruns. |
| Add `BENCH_COMPARISON=current` instead of pretending Hetzner could satisfy the frozen M2 gate. | Historical wins are machine-bound and invalid across macOS/ARM and Linux/x64. | A current three-system same-host diagnostic can answer “are we still decisively ahead of Convex?” without saving a false acceptance result. | It does not close historical story 47. |
| Exclude exporter/disabled DBZZ legs from the current margin diagnostic. | Those legs measure telemetry cost, not the requested DBZZ/Convex/SpacetimeDB margin, and an exporter diagnostic dropped records under the tiny host's pressure. | The relevant diagnostic completes in minutes without changing product code for a non-user-facing benchmark artifact. | The default acceptance still needs all telemetry-cost legs. |
| Reduce the Hetzner offered shape equally after swap/correctness failure. | At 500 users × 50 queries, Convex pushed the 3.7-GiB host into swap and produced duplicate/unexpected shared deliveries. | A valid zero-swap comparison at 500 connections and 2,000 subscriptions, with identical overrides for every system. | The successful run is a small-host capacity sample, not the full default subscription population. |
| Generate DBZZ bindings inside the benchmark runner. | A clean remote checkout lacked ignored generated bindings. | Fresh-clone runs no longer depend on local generated state. | The frozen baseline artifact remains a separate clean-clone problem. |
| Keep changes atomic and preserve unrelated dirty work. | The worktree contained user-owned package/release changes and staged state is authoritative. | 126 traceable issue-work commits after the pre-existing benchmark baseline and no accidental release/publishing changes. | The branch still contains unrelated dirty/untracked user work outside this milestone. |

## What was implemented

### Protocol and public failure semantics

Protocol 2 now makes the transport contract explicit instead of relying on
TypeScript casts and ad-hoc strings. It provides:

- a mandatory versioned hello/welcome exchange;
- strict frame parsing that rejects unknown fields and unsupported versions;
- bounded credentials, IDs, obligations, frames, and retry hints;
- separate query, mutation, procedure, subscription, event, reset, auth, and
  SSE acknowledgment envelopes;
- stable outcome codes and resource classes;
- explicit unauthenticated, unauthorized, overloaded, deadline, draining,
  slow-consumer, reset-required, and indeterminate outcomes; and
- consistent HTTP and WebSocket mappings that hide internal exceptions.

The gain is not merely cleaner types. Client behavior can now distinguish
“retry safely,” “refresh credentials,” “reset state,” “application must decide,”
and “do not retry” without parsing private error messages.

### Authentication, authorization, and revocation

The server gained immutable `anonymous`, `user`, `workload`, and local-only
`system` principals. Function registration requires an access policy at
runtime. Argument validation occurs before policy execution, custom policy
failure is fail-closed, and nested calls preserve the exact parent authority
while re-running the callee's policy.

The built-in external identity path supports configured OIDC issuers, pinned
algorithms and audiences, bounded JWKS documents/caches, expiry, selected
claims, and a finite revocation contract. An untrusted token cannot choose an
unregistered issuer or network target. WebSocket refresh pauses new operations,
creates a new immutable epoch, and revokes/recomputes live subscriptions.
Sign-out cannot leak old-epoch updates. HTTP and SSE use the same verifier and
retain a credential lease until the actual operation/body ownership ends.

What this does not provide is a hosted user system. DBZZ does not create users,
issue credentials, host login UI, rotate provider secrets, or operate the
upstream revocation service.

### Ordered realtime convergence

Every committed state change now has a monotonic version. Initial snapshots,
updates, checkpoints, resumes, and resets carry stream/version information. A
client applies an update only when its predecessor matches current state,
ignores a proven duplicate, resumes a contiguous retained chain, and requests
or accepts an authoritative reset when proof is unavailable.

The publication path reserves bounded capacity before commit, publishes
versions in order, and hands work off so the single writer can progress without
waiting for unrelated network delivery. Reactive ownership includes caller
authorization scope; auth rotation detaches and re-evaluates saved
subscriptions under the new epoch. Live events are deliberately weaker: they
carry a sequence and expose gaps but are not durable query state.

The client now holds a mutation result until the receipt's relevant convergence
obligations are applied or explicitly discharged. Fault-proxy tests cut the
real TCP stream before and after every reset/update/checkpoint/resume/revocation
transition and prove recovery from both sides of the semantic boundary.

### Transaction, replay, and scheduler safety

Writes run through a fair coordinator that owns writer admission, transaction
execution, idempotency replay, commit/version allocation, and ordered
publication handoff. The implementation validates and bounds the response
before allowing the transaction to commit; an unpublishable result cannot
create an acknowledged-but-unrepresentable write.

Mutation replay stores the scoped request semantics, encoded result, commit
version, and durability in the same transaction as application rows. A
duplicate returns that exact result rather than re-running. UUIDv7 timestamp,
not a caller-provided issue time, determines age. Crash tests kill fresh
processes before COMMIT, after durable COMMIT but before publication, and after
acknowledgement; they prove rollback or exactly-once replay at each boundary.

Scheduled mutations no longer delete their durable row before handler success.
Handler writes and schedule completion share one transaction; failure rolls
back and backs off instead of losing work or retrying in a hot loop.

### Admission, overload, and fairness

Finite production defaults now cover:

- connections and pre-hello sockets;
- HTTP bodies and concurrent pre-body admission;
- per-connection and global operation queues;
- queue bytes, entries, wait age, deadlines, and cancellation;
- writer turns and bounded execution slots;
- per-connection and global subscriptions;
- revalidation queue items/bytes/age and concurrent evaluations;
- publication slots and bytes;
- auth-transition capture leases;
- WebSocket application/control lanes;
- global outbound bytes;
- SSE application credit, terminal reserve, and sequence space; and
- telemetry records, trace state, aggregate series, local output, exporter
  batches, timeouts, and drain deadlines.

Admission returns typed overload before execution. Stable fairness keys stop a
principal from multiplying capacity by opening more sockets or switching
between HTTP and WebSocket. Round-robin queues and yielding revalidation turns
prove that hot callers/groups cannot indefinitely starve cold work.

### WebSocket and SSE ownership

WebSocket delivery accounts the exact encoded bytes from acceptance until Bun
drain or terminal failure. Control traffic has reserved capacity so overload can
still communicate a bounded terminal outcome. Stale auth-epoch application
frames are dropped without disturbing FIFO ownership; send failure, stall,
shared-budget exhaustion, and close each release exactly once.

SSE gained a capability-bound cumulative acknowledgment protocol. A chunk is
not released when JavaScript merely enqueues it; the fetch-based client confirms
the exact `(stream, sequence, proof)` after iteration resumes. Invalid or stale
proofs are indistinguishable no-op responses. The producer stops before
traversing more application input when credit is exhausted, emits a reserved
terminal `slow_consumer`, and force-closes after a finite grace period.

The final raw-TCP test pauses immediately after headers, never acknowledges,
and repeats eight cycles. It proves the configured DBZZ-owned byte ceiling,
exact terminal framing, zero current ownership after closure, continued
liveness, and descriptor recovery. The earlier attempt to correlate this small
application-owned contract with whole-process RSS was abandoned because the
allocator signal was orders of magnitude coarser and unrelated to DBZZ-owned
counters.

### Storage, startup, health, shutdown, backup, and restore

The engine now has explicit `production` (`synchronous=FULL`) and `balanced`
(`synchronous=NORMAL`) durability profiles. Status reports the effective
profile so an operator cannot confuse benchmark speed with the stronger
power-loss promise.

Startup owns the port through monotonic preparation phases and activates exactly
one ready runtime. Liveness reveals only that the process responds. Readiness
requires safe storage, schema reconciliation, and a non-draining runtime.
Protected status uses a workload credential and exact scope rather than making
internal capacity or storage details public.

Storage opening validates the DBZZ internal schema, singleton invariants,
application schema/index shape, mutation ledger, tags, WAL/recovery state, and
prior clean marker. It refuses legacy/partial/foreign/corrupt layouts and
preserves main/WAL/journal evidence. Single-process ownership is explicit.

Shutdown stops admission, terminates transports, drains accepted runtime work,
flushes telemetry, closes the engine, and finishes inside one absolute deadline.
An incomplete drain records unclean state while still releasing every native
handle and listener. Clean-marker failure preserves the first error and cannot
strand the writer lock.

The CLI gained `status`, `backup`, and `restore`. Backup uses SQLite's owned
snapshot operation, writes a manifest and digest, then launches a fresh verifier
process. Restore refuses existing/locked destinations and corrupt,
non-canonical, lossy, or metadata-mismatched artifacts. This is a strong local
mechanism but not an offsite backup service.

### Telemetry and operational visibility

Telemetry is enabled by default and can be fully disabled. It records bounded,
correlated spans, events, cumulative aggregates, and runtime/storage snapshots
for:

- query, mutation, procedure, SSE, scheduler, nested invocation, and backup/
  restore operations;
- admission queue wait, writer queue, handler execution, database statement,
  storage, encoding, commit/rollback/replay, publication, revalidation, fanout,
  outbound queue, physical delivery, and response handoff;
- credential verification, refresh, invalidation, expiry, revocation, and auth
  capture;
- connections, subscriptions, in-flight work, queue depths/bytes/ages, outbound
  pressure, process CPU/RSS, event-loop delay, database/WAL/checkpoint state,
  and exporter health; and
- lifecycle transitions and structured failures.

Raw credentials, cookies, claims outside the selected allowlist, arguments,
results, literal SQL, and other protected payloads are excluded by default.
Metric series are bounded and low-cardinality. Request/trace/commit/session
identifiers remain in retained diagnostic records, not aggregate labels.

The final performance-oriented design retains slow, failed, and lifecycle
traces, while fast successful operations update cumulative aggregates without
immediately materializing every span. Delivery leases keep a whole-operation
tail alive until physical response ownership finishes. Exporters run outside
application work with finite batches, timeouts, failure accounting, and one
absolute drain deadline. Synchronous throws, stalled promises, scheduler
failures, and local-sink failures stay fail-open.

### Type flow and developer experience

Generated APIs preserve handler-inferred return types across query, mutation,
procedure, SSE, and event references. Codegen remains local and deterministic,
and the benchmark runner now invokes it in fresh checkouts. The implementation
deliberately did not add redundant runtime result schemas because no measured
runtime or compiler benefit justified the authoring and hot-path cost.

### Documentation and workflow evidence

The public README and dedicated authentication, realtime, operations, and
telemetry documents now state supported behavior and unsupported topology.
Architecture research, acceptance mapping, benchmark evidence, and the final
decision record live under `.workflow/production-safety-operational-visibility`.
The project wiki compiles source-level research on Convex, SpacetimeDB, SQLite,
Bun, authentication, delivery, telemetry, and benchmark methodology.

## Verification performed

The broad canonical suite contains 488 tests across 38 files. Its previously
recorded full pass was 488/488. After the benchmark-only changes, the latest
broad rerun produced 487 passes and one timeout in the
macOS whole-process RSS stabilization test. That test showed stable descriptors
but missed its 60-second allocator plateau. Its immediate isolated rerun passed
with 7,227 assertions. No product code was changed to predict allocator phases.

Other verification completed during the milestone includes:

- root TypeScript typecheck;
- benchmark TypeScript typecheck;
- 41 focused benchmark contract tests with 183 assertions;
- public protocol strictness and wire round trips;
- fail-closed auth, JWKS bounds, token expiry, auth rotation, and invalidation;
- mutation crash/replay at pre-commit, post-commit/pre-publication, and
  post-acknowledgement boundaries;
- corruption refusal for main/WAL/journal/internal-schema cases without evidence
  destruction;
- backup creation plus fresh-process restore verification;
- 12 authoritative semantic reconnect cuts plus before/after cases for reset,
  update, checkpoint, resume, and revocation;
- operation, subscription, connection, revalidation, publication, auth-capture,
  and delivery saturation/recovery;
- stalled/throwing telemetry exporter and local-sink failure containment;
- raw-TCP paused SSE resource ownership over eight consecutive cycles;
- graceful and forced shutdown, startup interruption, port ownership, and handle
  release; and
- wiki index/link lint plus dynamic-workflow verification.

### Verification caveat: missing frozen baseline in Git

The benchmark test result above was obtained in this worktree, which contains
the untracked file:

`bench/results/2026-07-13T15-34-33Z-74d8554.json`

Committed code identifies that path as `FROZEN_BASELINE_PATH`; both the
performance-gate tests and the default benchmark runner read it. Because the
file is not tracked, a clean clone lacks an input required by committed code.
This is not a theoretical edge case: CI and every new contributor start from a
clean checkout. Before release, do one of the following:

1. commit that exact immutable baseline as a dedicated atomic benchmark-evidence
   commit, after verifying its provenance and intended inclusion; or
2. redesign the gate so the immutable acceptance data is a tracked fixture with
   a clearly documented generation/update process.

Do not weaken the gate or silently fall back to a newer result when the baseline
is absent.

## Benchmark work and results

### Why the benchmark was slow

The original default performed five full legs:

1. DBZZ with default telemetry/local sink;
2. DBZZ with an explicit in-process exporter;
3. DBZZ with telemetry disabled;
4. Convex; and
5. SpacetimeDB.

Each leg exercised four operations across four profiles, multiple connections,
fixed-rate shared and partitioned subscriptions, and capacity sweeps. Three
three-second trials, one-second warmups, five-second subscription windows, and
ten-second capacity plateaus created a fixed floor of roughly 23m23s before
startup, seeding, publication, code generation, validation, cooldown, and
teardown. Failed attempts and resource stabilization made the practical session
far longer. A two-hour investigation was not the intrinsic cost of one
microbenchmark; it was repeated full runs plus environment/setup failures.

### What was shortened

The permanent default kept all workload dimensions and all 351 metric paths.
It changed measurement effort:

- warmup: 1,000 ms → 500 ms;
- operation trials: 3 × 3,000 ms → 1 × 2,000 ms;
- connection work: 2,000 ms → 1,000 ms;
- fixed subscription window: 5,000 ms → 2,000 ms; and
- capacity window: 10,000 ms → 2,000 ms.

The calculated fixed-window minimum fell to about 6m13s. A 10–15 minute full
wall-clock run is an unvalidated target: setup, stabilization, reruns, or
failure can extend it. Timing effort is recorded but is no longer confused with
workload identity. Current systems still require
exact configuration parity; the historical selector still requires the same
dataset, seed, operation/profile shapes, connection levels, subscription
population/patterns/rates/slots, durability, and setup semantics.

The new `BENCH_COMPARISON=current` mode asks a different question: how do DBZZ,
Convex, and SpacetimeDB compare on the same host now? It runs only those three
legs, preserves correctness/telemetry/workload checks, prints the comparison,
and explicitly skips historical-machine acceptance and result persistence.

### Remote execution problems and decisions

The isolated Hetzner workflow used a Git bundle so no local dirty or untracked
user state reached the server. The host was Linux x64, 3 AMD EPYC-Rome vCPUs,
3.7 GiB RAM, and initially idle. Bun 1.3.14 and SpacetimeDB 2.6.1 were installed
at exact versions. Node 24 LTS was installed for Convex 1.42.1 because Ubuntu's
Node 18 could not parse a dependency using the RegExp `v` flag.

The failures were handled as evidence, not papered over:

| Failure | Root cause | Decision | Gain |
| --- | --- | --- | --- |
| DBZZ did not start in a fresh checkout. | Ignored generated bindings existed locally but not remotely. | Run DBZZ codegen from the benchmark runner before DBZZ legs. | Fresh-checkout reproducibility. |
| Convex CLI failed before workload. | Ubuntu Node 18 lacked syntax required by a Convex dependency. | Install verified Node 24 LTS on the isolated host. | Correct vendor runtime without changing benchmark logic. |
| Five-leg current diagnostic rejected the exporter leg. | The tiny host caused a benchmark-exporter dropped-record diagnostic. | Keep strict exporter validation in default acceptance; omit telemetry-cost legs from current performance-margin mode. | Answer the user's actual comparison question without product changes for a diagnostic-only artifact. |
| Full 500 × 50 subscription run became invalid. | Convex consumed the 3.7-GiB host into ~384 MiB swap and later produced duplicate/unexpected shared-capacity deliveries. | Do not retry or weaken correctness; reduce connection/subscription/capacity overrides equally for every system. | A valid zero-swap same-host comparison. |
| Historical acceptance could not run on Hetzner. | Frozen acceptance is tied to an Apple M2 Pro/macOS machine. | Explicitly skip it in current mode rather than pretending cross-machine deltas are valid. | Honest current numbers without false regression claims. |

### Successful Hetzner shape

The final command used the same overrides for all three systems:

- all four operations: query, uncontended mutation, contended mutation,
  procedure;
- all four profiles: latency, pipeline, concurrent, saturation;
- connection targets 1, 100, and 500;
- 100 users × 20 query arguments = 2,000 logical subscriptions;
- shared and partitioned subscription patterns; and
- capacity slots 1, 8, and 32, capped by available shared channels where
  necessary.

The run completed in 252 seconds, exited 0, passed workload correctness and
default DBZZ telemetry validation, used zero swap, and left no benchmark process
or listener. The remote log SHA-256 is
`737d7bd21300546a94d208b2d3af28bd59115f41b6dc57a9845eb37d348ccd45`.

All DBZZ benchmark legs explicitly use the `balanced` durability profile
(`SQLite WAL + synchronous=NORMAL`). This is process-crash consistent but is not
the default `production` power-loss durability claim. Convex uses its local
backend default; SpacetimeDB uses its own default. The suite documents this
trade-off rather than implying identical storage engines.

SpacetimeDB's query leg uses a read-only procedure with an explicit transaction
because the 2.6 TypeScript SDK has no public one-off query API. The logical work
is equivalent, but the transport is not identical. Process-tree RSS is summed
sampled RSS and can double-count shared pages, so it is a comparative process
accounting signal rather than exact unique physical memory.

### DBZZ versus Convex local backend

| Area | Result |
| --- | --- |
| Operation throughput, 16 cells | DBZZ 5.11×–20.60× higher; 13.42× median |
| Operation p95 latency, 16 cells | Convex 3.88×–95.82× higher; 9.75× median |
| 1/100/500 connection throughput | DBZZ 13.46× / 13.72× / 15.90× higher |
| 1/100/500 connection p95 | DBZZ 8.51× / 11.95× / 15.18× lower |
| 500-connection server RSS | DBZZ 111.3 MiB; Convex 1,829.9 MiB (16.44×) |
| Saturated-operation server RSS | Convex 3.73×–8.81× DBZZ |
| Shared capacity throughput | DBZZ 5.40× / 4.22× / 3.21× at 1/8/20 writers |
| Partitioned capacity throughput | DBZZ 14.17× / 8.92× / 9.17× at 1/8/32 writers |
| Fixed shared delivery p95 | DBZZ 17.04 ms; Convex 40.44 ms |
| Fixed partitioned delivery p95 | DBZZ 2.61 ms; Convex 20.65 ms |

The valid conclusion is narrow but valuable: DBZZ is decisively faster and more
memory-efficient than the Convex **local development backend** on this tested
single-host workload. Convex explicitly describes local deployments as beta and
development-oriented, so these numbers say nothing about Convex Cloud latency,
capacity, availability, durability, security, or SLA.

### DBZZ versus local Standalone SpacetimeDB 2.6.1

SpacetimeDB remained the stronger reference for saturated mutations, server
compute/procedures, and multi-writer partitioned subscriptions. DBZZ remained
competitive on indexed queries and used materially less RSS at connection and
subscription plateaus. That is consistent with the project benchmark policy:
SpacetimeDB is the “excellent performance” reference, not the product that DBZZ
must beat on every new metric.

The result suggests where architectural headroom exists—write execution,
compute isolation, and incremental/parallel subscription delivery—but zero-user
alpha priorities should remain operational usability and evidence from real
applications, not speculative pursuit of every SpacetimeDB win.

As with Convex, this local result does not substantiate the managed product's
latency, capacity, replication, backup, or SLA behavior.

## Production-readiness comparison

### The correct comparison boundary

Convex Cloud and SpacetimeDB Maincloud are managed products. DBZZ is currently
an engine, client, CLI, and operating contract. Comparing only database code
understates the competitors' most important production advantage: they operate
infrastructure and a control plane on behalf of the customer.

Conversely, comparing DBZZ's same-host numbers to hosted WAN endpoints would
mix network, hardware, service, durability, and tenancy differences. The table
therefore separates local engine guarantees from managed-platform readiness.

| Area | DBZZ today | Convex Cloud | SpacetimeDB / Maincloud | Assessment |
| --- | --- | --- | --- | --- |
| Deployment model | Self-hosted one Bun process + one SQLite file | Managed deployments with dev/prod/custom/preview environments | Managed Maincloud plus documented self-hosting | DBZZ is far behind in operational product, though simpler to inspect locally. |
| High availability | No replica, consensus, or automatic failover | Official docs state durable replication across multiple physical availability zones | Paid Maincloud advertises automatic replication; public sources reviewed do not specify topology or failover behavior. Standalone uses one replica and no replication. | Independent-failure-domain gap versus managed services; like-for-like standalone remains single-replica. |
| Availability commitment | No SLA | Noncontractual 99.99% target; Business/Enterprise deployment-class SLA 99.9%–99.95% | Maincloud Pro has a 99.5% monthly uptime commitment with credit-only remedies; Team/Enterprise advertise additional/custom SLAs | DBZZ must state “no SLA,” not invent one. |
| Durability | SQLite `FULL` by default; crash/corruption evidence and acknowledged-write tests on one failure domain | Encrypted at rest, multi-AZ durability, periodic/incremental backups | Committed transactions persist to an append-only commit log and restart recovery replays it; the format supports replication but does not make Standalone highly available | DBZZ's local semantics are strong, but one machine/disk remains the decisive risk. |
| Backups and recovery | Verified local artifact and fresh-process restore; operator owns schedule/retention/offsite/encryption | Manual and periodic managed backups; dedicated physical backups; dashboard restore | Paid Maincloud advertises automatic backups and point-in-time retention; public restore workflow/RPO/RTO details remain limited | DBZZ has a strong primitive but lacks the routine automation that makes it operationally useful. |
| Point-in-time recovery | No packaged PITR | Public backup UI is snapshot-oriented; official pages reviewed do not promise customer-selectable PITR | Maincloud pricing advertises PITR retention of 7 days on Pro, 30 days on Team, and custom Enterprise retention | SpacetimeDB has the published feature lead; exact restore workflow, RPO, and RTO still need confirmation. |
| Deploy/rollback | Reconcile at startup, health/readiness, bounded drain; no controller, previews, rolling rollout, or automated rollback | CI deploy, generated code, schema/index push, scoped keys, previews/staging/custom deployments | Publish/hot-swap, automatic compatible migrations, incremental migration pattern | DBZZ needs one reproducible deployment recipe before it needs sophisticated rollout infrastructure. |
| Schema evolution | Safe reconciliation/refusal for supported local changes; no compatibility layer by design | Managed validation/index lifecycle and deployment tooling | Automatic compatible migrations; complex changes use incremental migration pattern | DBZZ is adequate for alpha but lacks staged/backfilled zero-downtime operations and client-version orchestration. |
| TLS/network edge | Plaintext listener intended for loopback/private hop; operator terminates TLS | Hosted TLS and managed endpoint/network settings | Maincloud hosted endpoint; self-host guide covers Nginx/Let's Encrypt/firewall | Immediate invited-alpha gap: ship and test a reference edge configuration. |
| Authentication | Strict OIDC/JWKS verification, mandatory function policy, epochs, leases, revocation hooks | Hosted identity verification; application still performs authorization checks | OIDC and beta SpacetimeAuth; application authorization; private tables and filtered views. RLS is experimental/unstable and official guidance prefers views. | DBZZ data-plane contract is credible; identity provisioning and platform administration are absent. |
| Control-plane security | No team/project RBAC, scoped deploy keys, SSO, or control-plane audit | Team/project roles, scoped deployment keys, settings and audit capabilities; enterprise durable audit path | Maincloud account/dashboard and database ownership; exact enterprise control matrix needs confirmation | Large platform gap, not a local transaction bug. |
| Overload/backpressure | Explicit finite item/byte/age limits, typed outcomes, principal fairness, receiver-confirmed SSE | Managed limits/classes; internal platform handles service capacity | Managed/server runtime capacity and transaction model | DBZZ has unusually explicit local contracts, but no fleet-level autoscaling or admission control. |
| Horizontal scaling | None | Serverless/dedicated classes up to documented 100,000 concurrent sessions; applications can shard across deployments | Maincloud manages placement/scaling and applications can distribute work across databases, but each database is bounded by its scheduled machine; Standalone is single-replica | Do not build this for zero users; measure the single node first. |
| Realtime correctness | Ordered resume/reset query streams, exact predecessor checks, mutation convergence; finite history resets after restart | Mature reactive queries, consistent snapshots, managed client ecosystem | Incremental subscription deltas and typed client cache | DBZZ now has a defensible correctness contract; durability/efficiency of history and ecosystem maturity still lag. |
| External side effects | Procedures are explicit and never automatically retried | Actions separate external I/O from deterministic mutations | Procedures separate external I/O from transactional reducers | Similar conceptual boundary; competitors have broader mature tooling. |
| Observability data | Detailed bounded stages, queue/resource metrics, protected status, exporter callback | Hosted dashboard/logs/health plus paid streams and exception integrations; built-in metrics still described as basic | Maincloud dashboard has logs, CCU, rows, transactions, and energy/resource usage | DBZZ may expose richer engine-stage semantics, but has no turnkey backend, durable spool, dashboard, or alerts. |
| Audit/compliance | Privacy-safe telemetry but no compliance program or durable administrative audit product | Enterprise durable audit logging, hosted access controls, contractual/compliance options | Managed identity/dashboard; exact compliance/SLA controls require plan-specific confirmation | DBZZ is not ready for regulated or procurement-heavy workloads. |
| Files/search/vector | Not part of current product | Managed file storage, full-text and vector search, components/integrations | SQL, typed subscriptions, multi-language SDKs; feature set oriented to realtime state | Significant ecosystem/product breadth gap, not required for the current safety milestone. |
| SDK ecosystem | TypeScript/Bun server, web-platform client, raw TS packages | React, Next.js, React Native, JS, Vue, Svelte, Python, Swift, Kotlin, Rust, OpenAPI and integrations | TypeScript, C#, Rust, C++, engines/game ecosystem | Adoption and integration gap. |
| Operations/support | User operates and debugs everything; no formal support channel | Paid plans, dashboard support, documented SLAs | Managed tiers/community/team support | DBZZ needs a named alpha support/incident path and explicit expectations. |

### Where DBZZ is already strong

DBZZ should not describe itself only as “behind.” It has several good
foundations that are appropriate for its scope:

- Production durability is a named, observable default rather than a hidden
  benchmark setting.
- Startup rejects suspect state and preserves recovery evidence instead of
  silently repairing it.
- Backup artifacts are not called valid until a fresh process restores and
  verifies them.
- Every framework-owned queue has explicit ownership and finite capacity.
- Authentication semantics are shared across transports and nested work.
- Realtime clients never apply an unproven gap; they reset safely.
- Mutation replay and caller convergence are tested through process/network
  interruption.
- Telemetry failure cannot block application work, and default records exclude
  protected payloads.
- The local architecture is small enough to deploy without a separate database,
  cache, queue, or function-runtime cluster.

These strengths make DBZZ a plausible invited self-hosted alpha once the small
operational wrapper below exists. They do not compensate for a missing
independent failure domain.

## Rough edges and technical debt

### Branch/release blockers

1. **The frozen benchmark baseline is untracked.** This is the immediate
   clean-clone/CI blocker described above.
2. **A version bump is required before merge.** The branch contains `feat:` and
   `fix:` commits, so the repository merge guard will reject it until all four
   packages are bumped in lockstep. Merge, publish, and tag remain unperformed.

### Acceptance gaps and evidence debt

1. **No accepted schema-v6 result exists.** Story 45's telemetry-on/off cost is
   not measured post-change; story 46 has a strong current-host diagnostic but
   not the frozen default acceptance workload; story 47's 273 historical
   SpacetimeDB wins remain explicitly deferred to the Apple M2 host. This keeps
   literal PRD acceptance incomplete but is not a zero-user alpha usability or
   liability blocker.
2. **The Hetzner raw log is not in repository evidence.** The workflow stores
   its summary and SHA-256, but the cited raw file remains only at
   `/root/dbzz-current-007a44a-scaled.log`. Preserving it is optional evidence
   hardening, not an alpha blocker.
3. **The broad process-RSS test is flaky.** Its direct ownership proofs pass,
   but allocator stabilization can exceed the wall-time cap. Keep it broad and
   coarse; do not grow another allocator model.

### Product and operations gaps

- There is no Docker/systemd/reference deployment artifact that pins Bun,
  supervises the process, terminates TLS, mounts durable storage, probes health,
  and demonstrates upgrade/restore.
- Backup scheduling, retention generations, offsite copy, encryption/key
  handling, restore drills, and failure alerts are not automated.
- There is no bundled OTLP, Prometheus, or supported structured-log shipping
  path, and no starter dashboard/alert set.
- There is no hosted control plane for deploys, secrets, environments, users,
  permissions, logs, data inspection, usage, or incident operations.
- Query resume history is finite/in-memory and disappears on restart. This is
  correct because clients reset, but it creates more post-restart load.
- Live events and SSE procedures are non-persistent and non-resumable.
- Mutation replay is finite; there is no durable offline client mutation queue
  or general conflict-resolution model.
- Reactive queries can fully recompute after dependency changes. There is no
  compiled incremental delta engine for complex joins/aggregates.
- External OIDC is a verifier boundary, not a built-in account/role/session
  product.
- Runtime outputs are inferred at compile time but lack declared runtime result
  schemas. This is intentional until evidence justifies the cost.
- The server requires Bun and ships raw TypeScript. Node/Deno compatibility,
  compiled artifacts, broad platform testing, and normal public package
  distribution are absent.
- There is no file/blob service, search, vector index, email/job integration,
  component marketplace, or broad SDK surface.
- There has been no independent security review, fuzzing campaign, dependency
  supply-chain review, or external penetration test.
- There has been no multi-day soak under real traffic, disk pressure, clock
  anomalies, kernel restarts, filesystem exhaustion, or repeated backup/restore
  operations on production-sized data.

### Maintainability risks

The implementation is heavily tested but concentrated in large central files:

- `packages/server/src/runtime/runtime.ts`: roughly 2,727 lines;
- `packages/server/src/telemetry/telemetry.ts`: roughly 2,395 lines;
- `packages/client/src/client.ts`: roughly 1,837 lines; and
- `packages/server/src/realtime/delivery.ts`: roughly 1,722 lines.

These files contain real state machines and ownership contracts, so splitting
them purely to reduce file length could make the system harder to reason about.
Nevertheless, they raise onboarding and review cost. Refactor only along proven
ownership boundaries—such as client transport versus convergence, runtime
invocation versus lifecycle, or telemetry retention versus export—when actual
change friction or defect clusters identify the seam. Do not create wrapper-only
functions or parallel abstractions.

### Benchmark limitations

- Convex was its local development backend, not Convex Cloud.
- DBZZ used balanced/NORMAL durability, not its production/FULL default.
- The successful Hetzner shape was reduced to fit a 3.7-GiB host.
- The workload is a microbenchmark: small dataset, known operations, local
  network, no bearer auth, no multi-region, no hosted tenancy, and no long-term
  cache/disk behavior.
- Shorter windows improve iteration speed but increase noise. A single path
  should not trigger optimization without consistent reruns.
- The frozen “preserve all 273 wins” rule implements story 47 literally but is
  unusually strict for an alpha. Changing it requires a PRD decision; gaming it
  path by path would be worse.

## Recommended next work

The priority order follows the alpha rule used during this milestone: address
likely routine liabilities first; do not build distributed/platform machinery
for zero users.

### P0 — finish the branch honestly

1. **Commit the frozen baseline alone.** Verify its recorded digest and
   provenance, then add only
   `bench/results/2026-07-13T15-34-33Z-74d8554.json` in an atomic benchmark
   evidence commit. Rerun benchmark tests from a clean checkout.
2. **Run one clean-clone verification.** Install from the tracked lockfile, run
   root tests/typecheck and benchmark contract tests, and prove no ignored local
   generated/result file is required.
3. **Bump the four packages in lockstep before merge.** Follow the existing
   release workflow; do not merge/publish/tag until the branch is clean.

Keep schema-v6/Apple M2 acceptance and raw-log preservation explicitly deferred
unless Pedro chooses literal PRD closure; neither is required to make the
zero-user alpha usable without becoming a liability.

### P1 — minimum justified work before an invited self-hosted alpha

1. **Provide one supported deployment recipe.** Pin Bun, run under systemd or an
   equivalent supervisor, terminate TLS, mount persistent storage, expose
   liveness/readiness correctly, enforce a hard-kill deadline, and demonstrate
   upgrade plus rollback/restore.
2. **Automate the existing verified backup primitive.** Schedule it, keep several
   generations, copy them off-host, encrypt as needed, rehearse restore, and
   alert on backup/restore age or failure.
3. **Ship one remote observability path.** Choose OTLP, Prometheus, or structured
   log shipping. Include only a small starter alert set: readiness loss,
   crash/unclean recovery, disk/WAL pressure, sustained queue saturation,
   dropped/expired work, exporter failure, and stale backups.
4. **Publish the alpha operating contract.** State single-node topology,
   maintenance downtime, no SLA, backup-defined RPO, restore-defined RTO,
   supported Bun/OS versions, and one support/incident channel.
5. **Give testers a reproducible install and starter application.** The current
   local Verdaccio workflow is useful for the author but is not a normal invited
   alpha distribution path.
6. **Document and exercise host security.** TLS/proxy config, filesystem
   permissions, secret storage, disk encryption, firewall, dependency updates,
   and log/backup access need one reference baseline.
7. **Run a bounded lifecycle smoke/soak, not a giant synthetic campaign.** Cover
   ordinary restart, backup/restore, disk/WAL observation, one slow client, and
   exporter failure. Extend duration only if the bounded run exposes growth or
   instability.

### P2 — respond to real alpha evidence

Only prioritize these after users or soak tests reveal pressure:

- persist more resume history if restart resets create measurable load;
- add incremental query deltas if recomputation dominates real CPU;
- optimize saturated write/procedure paths if they constrain actual workloads;
- add a blob/file primitive if applications repeatedly build unsafe ad-hoc
  storage;
- split large state-machine files where defect/change history proves a boundary;
- add more SDK/framework adapters based on actual adoption; and
- tune default limits from observed distributions rather than intuition.

### Explicitly defer

Do not build consensus, active-active regions, automatic failover, sharding,
cross-shard transactions, a hosted dashboard, a billing/control plane, every
SDK, or elaborate zero-downtime deployment machinery before demand exists. Also
do not add further SSE allocator/RSS heuristics without evidence of retained
DBZZ ownership in production.

## Completion status against issue #1

| Stories | Status | Evidence/remaining work |
| --- | --- | --- |
| 1–44 | Implementation and behavioral proof complete | Public/fault tests cover identity, ordering, overload, lifecycle, durability, recovery, telemetry, and privacy boundaries. |
| 45 | Benchmark machinery complete; empirical acceptance pending | Default/exporter/disabled DBZZ legs and exact cost reporting exist, but no accepted post-change schema-v6 result has been saved. |
| 46 | Strong current-host diagnostic; frozen acceptance pending | Hetzner proves a decisive local-Convex margin on the reduced valid shape; it is not the default frozen acceptance workload. |
| 47 | Explicitly deferred | Requires the shortened full run on the frozen Apple M2 host to preserve all 273 prior DBZZ-over-SpacetimeDB wins. |
| 48–50 | Complete | Return inference is proved, speculative runtime output schemas were excluded, and remaining production limitations are documented. |

Therefore:

- **Implementation:** broadly complete.
- **Internal single-node alpha:** credible after the missing tracked baseline is
  fixed and a clean checkout passes.
- **Invited self-hosted alpha:** needs the small operational wrapper in P1.
- **Literal PRD benchmark acceptance:** incomplete/deferred for stories 45–47.
- **General Convex Cloud or Maincloud replacement:** not ready.

## Traceability

The audited whole-branch atomic history can be reproduced with:

```sh
git log --reverse --format='%h %s' 4aa2b1e..17a2524
```

Issue #1 implementation after its starting HEAD is:

```sh
git log --reverse --format='%h %s' 74d8554..17a2524
```

Major commit groups:

- Protocol and core contract: `a126b69`, `ba0178c`.
- Authentication/session/leases: `dbdfe1d`, `9942b2a`, `18bf1cd`, `923d2e2`,
  `5e4fad6`, `b41fc19`.
- Realtime/client convergence: `a8a117b`, `cca8598`, `1735b67`, `22a668e`.
- Replay/transactions/publication: `881a9f6`, `551bcb9`, `0fd9b3a`, `970e434`,
  `5cab5e0`, `f68711a`.
- Admission/fairness/bounds: `fc5da36`, `184c6bf`, `095f1ef`, `7ec584b`,
  `906ab90`, `7602913`.
- Delivery/SSE: `095f1ef`, `be20f34`, `af41ae8`, `1215f74`, `cba5849`.
- Storage/lifecycle/backup: `919afd9`, `ccacc17`, `e46efad`, `41af8c5`,
  `9c87f76`, `fd03740`, `264284f`.
- Telemetry and hot-path work: `7123af2`, `4c19108`, `925f6cc`, `e14b47d`,
  `7047c20`, `bebb670` through `390f515`.
- Benchmark gates and acceleration: `3db17a0`, `79606f2`, `c269aa0`, `f71d27b`,
  `90e63b2`, `80f5b73`, `007a44a`.
- Workflow evidence: `17a2524`.

Detailed local evidence:

- [Authentication contract](authentication.md)
- [Realtime contract](realtime.md)
- [Operations and recovery](operations.md)
- [Telemetry contract](telemetry.md)
- [Benchmark methodology](../bench/README.md)
- [Workflow final report](../.workflow/production-safety-operational-visibility/final-report.md)
- [Hetzner comparison evidence](../.workflow/production-safety-operational-visibility/results/P1-hetzner-current-comparison.md)

## Official comparison sources

Convex:

- [Overview and managed architecture](https://docs.convex.dev/understanding/overview)
- [Status, durability, and availability guarantees](https://docs.convex.dev/production/state)
- [Deployment classes, capacity, and SLA limits](https://docs.convex.dev/production/state/limits)
- [Backup and restore](https://docs.convex.dev/database/backup-restore)
- [Production deploy command](https://docs.convex.dev/cli/reference/deploy)
- [Multiple and preview deployments](https://docs.convex.dev/production/multiple-deployments)
- [Regions](https://docs.convex.dev/production/regions)
- [Logs and integrations](https://docs.convex.dev/dashboard/deployments/logs)
- [Role actions](https://docs.convex.dev/team-management/role-actions)
- [Durable audit logging](https://docs.convex.dev/production/integrations/audit-logging)
- [OCC and atomicity](https://docs.convex.dev/database/advanced/occ)
- [Realtime queries](https://docs.convex.dev/realtime)
- [Local deployment limitations](https://docs.convex.dev/cli/local-deployments)

SpacetimeDB:

- [Maincloud managed deployment](https://spacetimedb.com/docs/how-to/deploy/maincloud/)
- [Self-hosting guide](https://spacetimedb.com/docs/how-to/deploy/self-hosting/)
- [Authentication and OIDC](https://spacetimedb.com/docs/core-concepts/authentication/)
- [Transactions and atomicity](https://spacetimedb.com/docs/databases/transactions-atomicity/)
- [Commit-log durability and replication format](https://spacetimedb.com/docs/reference/internals/commitlog/)
- [Automatic migrations](https://spacetimedb.com/docs/databases/automatic-migrations/)
- [Product FAQ and production guidance](https://spacetimedb.com/docs/intro/faq/)
- [Maincloud pricing, replication, backups, PITR, and support](https://spacetimedb.com/pricing)
- [Maincloud Pro SLA policy](https://spacetimedb.com/sla)
- [Standalone single-replica source](https://github.com/clockworklabs/SpacetimeDB/blob/9e81c0b98f4699f13f42b9eca360a099b4f89ee4/crates/standalone/src/lib.rs#L281-L282)
- [SpacetimeAuth beta project notice](https://spacetimedb.com/docs/core-concepts/authentication/spacetimeauth/creating-a-project/)
- [Experimental RLS guidance](https://spacetimedb.com/docs/1.12.0/how-to/rls/)
- [Logging](https://spacetimedb.com/docs/how-to/logging/)
- [Client SDKs](https://spacetimedb.com/docs/clients/)

## Final conclusion

The milestone achieved its most important architectural objective: DBZZ no
longer relies on performance as a substitute for explicit behavior. The
single-node engine now has a coherent answer for identity, ordering, retry,
overload, shutdown, corruption, backup, and diagnosis. The performance margin
against local Convex remains large in the valid same-host diagnostic, and the
SpacetimeDB comparison shows both competitive query/resource behavior and clear
areas where DBZZ is behind.

The next valuable step is not another broad engine rewrite. It is to close the
clean-clone benchmark artifact problem, record the performance acceptance status
honestly, and wrap the engine in the smallest operational package needed for an
invited alpha. Real applications should then determine whether resume history,
incremental subscriptions, write throughput, file storage, or distributed
availability deserves the next investment.
