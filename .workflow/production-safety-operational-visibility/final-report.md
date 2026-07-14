# Final Report: Production safety and operational visibility

## Outcome

Implementation and behavioral verification for stories 1–44 and 48–50 are
complete at `007a44a`. A lean
same-host DBZZ/Convex/SpacetimeDB comparison completed on Hetzner in 4m12s,
passed correctness, and proved a strong current DBZZ-over-local-Convex margin.
The branch is not clean-clone/acceptance complete: its required frozen baseline
JSON is untracked, and no accepted post-change schema-v5 result proves stories
45–47. Historical Apple M2 acceptance remains explicitly deferred.

## Accepted Results

- Independent audits classify stories 1–44 and 48–50 as proven through public
  behavior, fault injection, documented contracts, or an explicitly absent
  speculative feature.
- Authentication, ordered convergence, exact-once mutation replay, bounded
  overload, lifecycle/recovery, backup/restore, and default safe telemetry are
  integrated on the production paths.
- The paused raw-TCP SSE case proves finite DBZZ-owned bytes, terminal
  `slow_consumer`, zero current ownership, liveness, and exact descriptor
  recovery through eight consecutive cycles.
- The Hetzner diagnostic kept all four operation types and all four profiles.
  Across its 16 operation cells, DBZZ delivered 5.11×–20.60× Convex throughput
  (13.42× median), while Convex p95 was 3.88×–95.82× higher.
- The permanent full acceptance profile retains every workload dimension and
  all 351 metric paths while reducing fixed measurement time from about 23m23s
  to 6m13s. A separate current-host mode runs only the three compared systems
  and never claims historical-machine acceptance.

## Rejected Results

- Rejected whole-process RSS movement within the 96 KiB SSE application budget
  as an ownership oracle. Bun/macOS allocator phases moved by multiple MiB after
  every DBZZ-owned gauge, socket, listener, and descriptor had already returned
  to baseline; extending the allocator model would optimize a test artifact,
  not a demonstrated database liability.

## Conflicts Resolved

- Slow-client containment remains because stalled networks are ordinary and
  can exhaust a server. Allocator-phase prediction was removed because it was
  specific, flaky, and not evidence of retained DBZZ state.
- Process RSS remains in the broad combined-pressure and comparative benchmark
  suites, where its coarse accounting scale is meaningful.

## Verification Evidence

- `bun run test`: 487 passed and the known macOS whole-process RSS stabilization
  proof missed its 60-second allocator deadline; its immediate isolated rerun
  passed. The prior canonical run was 488/488.
- `bun run typecheck`: passed.
- `bunx tsc -p bench/tsconfig.json --noEmit`: passed.
- Benchmark contract suites: 41 passed, 0 failed, 183 assertions.
- Focused SSE proof: 8 cycles, 702 assertions, about 10 seconds.
- Full process-resource suite: 2 passed, 7,158 assertions.
- Hetzner same-host comparison: 252 seconds, exit 0, correctness passed, zero
  swap, and no surviving benchmark processes or listeners.
- Dynamic-workflow verifier and wiki index/link lint: passed.

The benchmark contract tests above ran in the local worktree, where the required
frozen baseline exists. Because that JSON is untracked, the same committed test
code fails from a clean checkout until the baseline is committed or redesigned
as a tracked fixture.

## Remaining Risks

- `bench/results/2026-07-13T15-34-33Z-74d8554.json` is a hard clean-clone
  blocker because committed tests and the runner load it but Git does not track
  it.
- Story 45 still needs an accepted post-change telemetry default/exporter/
  disabled cost result. Story 46 has strong current-host evidence but not the
  frozen default acceptance workload. Story 47 still needs the Apple M2 run to
  preserve all 273 prior DBZZ-over-SpacetimeDB wins; Pedro explicitly deferred
  that historical comparison for the current Hetzner check.
- The documented single-node, local-SQLite, no-automatic-failover limitations
  remain intentional product boundaries rather than hidden guarantees.

## Reusable Follow-up

- Before adding another edge-case mechanism, require either a likely generic
  production failure mode or concrete production evidence. Prefer one bounded
  general safeguard and direct ownership metrics over runtime-specific models.
