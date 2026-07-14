# Production safety and operational visibility

## Goal

Implement GitHub issue #1 as the intended single-node DBZZ production contract: verified identity, revocable authorization, ordered/versioned realtime state, durable read-your-writes acknowledgements, bounded overload behavior, predictable lifecycle and recovery, complete safe telemetry, public fault tests, and measured performance.

## Success Criteria

- Identity is verified or explicitly anonymous and has the same semantics across WebSocket, HTTP, SSE, scheduled, and nested execution.
- Authentication and authorization fail closed, remain distinguishable, refresh on live connections, and revalidate affected subscriptions when identity or authorization changes.
- Every committed state transition has a monotonic version; subscription snapshots and updates form one ordered stream; mismatch, reconnect, and history loss reset or resume without guessing.
- Mutation retries remain exactly once, and acknowledgements mean the configured durability policy plus caller-relevant subscription convergence.
- Connections, operations, subscriptions, revalidations, outbound bytes, slow consumers, and telemetry buffering are finite, configurable, fair, observable, and produce explicit overload outcomes.
- Liveness, readiness, draining, graceful shutdown, crash recovery, corruption rejection, durability modes, backup, and restore have documented public contracts and fault tests.
- Queries, mutations, procedures, transactions, scheduled work, subscriptions, invalidation/revalidation, encoding, fanout, and delivery emit correlated, low-cardinality, payload-safe telemetry by default; export failure never fails application work.
- Existing inferred return types remain; no runtime output schema or backwards-compatibility layer is added.
- Public behavior and failure-injection suites cover every accepted guarantee.
- A 10–15 minute dbzz/Convex/SpacetimeDB comparison preserves correctness and the decisive DBZZ-over-Convex margin; Hetzner is used as a current self-comparison host without requiring compatibility with the historical M2 baseline.
- Remaining single-node limitations are explicit in documentation.

## Current Context

- Current branch is `codex/benchmark-capacity` at `74d8554`; it contains Pedro's completed benchmark-capacity commit.
- The working tree contains pre-existing uncommitted local publishing, hooks, package-manifest, AGENTS, and prior workflow changes. They are authoritative user work and must be preserved.
- The benchmark has recent records for `4aa2b1e` but no saved full record yet for current HEAD.
- Existing strengths include mutation idempotency, WAL snapshot reads, precise dependency keys, shared subscription recomputation, reconnect/resubscribe, and the three-system capacity harness.

## Constraints

- No backwards compatibility unless Pedro explicitly asks.
- Root-cause changes only: replace wrong state/contract boundaries instead of adding shims, retries, duplicated paths, or catch-and-ignore behavior.
- Keep net complexity and LoC as low as the complete contract allows; no wrapper functions that only call another function.
- Preserve all staged and unrelated dirty-tree work; never use Git to revert user changes.
- Keep benchmark runtime proportional to alpha-stage decisions: preserve representative latency, concurrency, connection, subscription, and resource comparisons, but remove redundant trials/profiles/capacity points. Check ports/processes before starting benchmark services.
- Use the Karpathy LLM Wiki ingest workflow for external research, including immutable raw sources, compiled articles, index, and log.
- Use primary/official sources for technical research.
- Do not publish, merge, force, or deploy without separate authorization.

## Risks

- This milestone crosses protocol, storage, runtime, transport, client, tests, telemetry, and benchmark boundaries; partial guarantees can be worse than explicit absence.
- Durable acknowledgement and subscription convergence can deadlock if commit, delivery, disconnect, and shutdown ownership are not one explicit state machine.
- Per-operation observability can corrupt the benchmark if allocation, cardinality, or export work leaks into the critical path.
- Dirty-tree release work overlaps package manifests and must not be overwritten.
- Fault tests may expose SQLite/Bun platform behavior that requires contract changes rather than retries.

## Approval Required

None for requested local research, workflow artifacts, source/test/docs edits, local processes used by tests/benchmarks, configured subagents, and atomic local commits. Push, merge, publish, deployment, destructive database operations on user data, and other external writes remain out of scope.

## Work Packets

1. `D1 architecture-map`: map current protocol/runtime/storage/client/transport state boundaries and all existing tests; identify exact contract gaps and likely file ownership. Read-only except its result note.
2. `D2 contract-research`: research primary specifications for authentication context, OpenTelemetry semantics/privacy/cardinality, SQLite durability/backup/integrity, overload/backpressure, and resumable ordered streams; preserve sources and merge findings through the Karpathy wiki workflow. Ownership is new `raw/` captures, affected `wiki/` articles/index/log, and its result note.
3. `D3 acceptance-test-map`: turn all PRD behavior suites into public black-box tests and fault-injection fixtures, mapping reuse opportunities and benchmark gates. Read-only except its result note.
4. `B0 baseline`: run and preserve a fresh full three-system benchmark before structural product edits; inspect correctness and process cleanup.
5. `C1 shared-contracts`: replace the wire/function contracts for identity, outcomes, commit/update versions, resume/reset, mutation convergence, overload, lifecycle, and stable telemetry vocabulary.
6. `S1 server-foundation`: implement authentication propagation/revocation, ordered commit/subscription transitions, durability semantics, bounded scheduling/delivery, lifecycle/recovery, backup/restore, and instrumentation at the owning runtime/storage boundaries.
7. `C2 client-transports`: implement authentication refresh, transition validation, resume/reset, acknowledgement convergence, overload-aware jittered retry, and bounded WebSocket/HTTP/SSE behavior.
8. `T1 telemetry`: implement the backend-neutral in-process telemetry pipeline, safe defaults, bounded fail-open export, local output, privacy/cardinality enforcement, and operational gauges.
9. `Q1 behavior-fault-tests`: add public contract, race, reconnect, overload, slow-consumer, lifecycle, crash, backup/restore, telemetry coverage/privacy/failure, and cardinality suites.
10. `P1 benchmark`: reduce the default acceptance workload to 10–15 minutes by removing low-value repetition and saturation points, retain telemetry-on/off accounting and common-workload fairness, then run a current three-system comparison on Hetzner without historical-machine gating.
11. `V1 verification`: run focused suites, typechecks, full tests, fault tests, process cleanup checks, repeated full benchmarks, wiki lint, docs audit, and workflow validation.
12. `G1 atomic-commits`: review and stage explicit goal-owned files/hunks only, then create independently coherent conventional commits with their relevant verification evidence; never absorb Pedro's unrelated release changes.

## Integration Policy

The root agent owns shared contracts and integration order. Discovery packets may not edit product code. Later code packets receive disjoint file ownership and must adapt to concurrent work without reverting it. Conflicts are resolved against externally observable PRD behavior, SQLite/Bun/transport reality, and primary specifications—not compatibility with the current prototype.

## Verification

- Narrow unit/type tests after each state boundary changes.
- Existing full `bun test` and `bun run typecheck` suites.
- New external client/server and process-level fault suites.
- SQLite integrity/restart/backup restore checks in fresh temporary directories.
- Telemetry contract, privacy-canary, bounded-exporter, cardinality, and exporter-failure checks.
- Benchmark typecheck and focused DBZZ legs before full three-system runs.
- One current all-system Hetzner run for the DBZZ-vs-Convex-vs-SpacetimeDB margin; rerun only if correctness fails or a headline result is implausibly noisy.
- Confirm no benchmark/test service remains listening after completion.
- Validate workflow artifacts and lint the project wiki.

## Reusable Artifacts

Public protocol docs, production operations guide, telemetry schema, fault-test fixtures, benchmark profiles/results, and compiled wiki articles are permanent. Workflow notes are an implementation audit trail.
