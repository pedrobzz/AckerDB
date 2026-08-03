# T2 telemetry audit report

## 1. What was done

### Finding 1 — idle sampler scans retained subscriptions: fixed

Commits: `029d587`, `b19f64d`.

- Added a reproducible 0 / 1k / 10k retained-entry prototype.
- Moved `dormantEntries` and `evaluatingEntries` ownership into `OrderedReactive` mutation points.
- Added a constant-cost `metricsSnapshot()` for periodic telemetry. The full `snapshot()` remains the demand-driven diagnostic projection and still performs pruning when explicitly requested.
- Changed the runtime sampler to consume the cheap projection. No polling or new background work was added.

### Finding 2 — per-operation telemetry cost: implemented, measured, and refuted

Commits: `02324c7`, `87701b2`, `30d8973`, `8c895c6`.

- Extended the existing hot-path benchmark with explicit telemetry-enabled and telemetry-disabled profiles and portable macOS process measurements.
- Removed per-phase `AsyncLocalStorage` context-object allocation from invocation observation.
- Prototyped sampled operation traces: fast successful operations retain exact aggregate counters plus a boundary span; slow, failed, or interval-selected operations promote their buffered phase spans.
- Preserved exact encoded-byte accounting, global and per-operation bounds, drop counters, fail-open behavior, and delayed delivery failure promotion.
- Reused the Runtime operation trace for external HTTP observation instead of opening a duplicate public trace.

The experiment is behaviorally correct under the focused telemetry suite, but it is slower. It should not become the production fast path in this form.

### Finding 3 — telemetry ownership and auth coupling: partially fixed

Commits: `dd2d372`, `e63c0e9`.

- Moved authentication-attempt observation into the neutral `auth/attempt-observation.ts` contract. Telemetry no longer imports subscription-session protocol types.
- Replaced the 3,068-line public `telemetry.ts` with a 70-line explicit entrypoint.
- Established real owners under `telemetry/{contracts,state,tracing,records,aggregation,export,status,composition}`. Aggregation owns its cardinality maps and export transaction; trace context owns identity and retention binding; operation tracing owns its node graph and bounded phase buffer; export owns deadline lifecycle; status owns immutable disabled projections.
- Kept `application-signals/`, `journal.ts`, and `external-trace.ts` separate.

The proposed layout exists and the extracted modules have behavior rather than pass-through wrappers. The composition implementation is still 2,244 lines, so this is a material boundary improvement, not a completed small-module decomposition.

## 2. Evidence

All measurements were taken on `MacBook-Pro.local` in this worktree. CPU figures are process CPU microseconds per sampling operation or completed procedure.

### Idle telemetry projection

| Retained entries | Before CPU µs/sample | After CPU µs/sample | Change |
| ---: | ---: | ---: | ---: |
| 0 | 0.34094 | 0.28759 | -15.6% |
| 1,000 | 17.442 | 0.25160 | -98.6% (69.3× faster) |
| 10,000 | 173.567 | 0.19250 | -99.9% (901.6× faster) |

Before, the one-hertz projection grew linearly with retained entries. After, all three loads remain within 0.19–0.29 µs/sample; the retained-entry scan is gone from the periodic path.

### Enabled procedure hot path

Medians of three trials, 500 ms warmup and 2 s steady state:

| Profile | Metric | Before | Prototype | Change |
| --- | --- | ---: | ---: | ---: |
| 1 connection × 1 in flight | throughput ops/s | 8,054.5 | 7,789 | -3.3% |
| 1 connection × 1 in flight | p50 latency ms | 0.1072 | 0.1143 | +6.6% |
| 32 connections × 4 in flight | throughput ops/s | 13,502 | 12,900 | -4.5% |
| 32 connections × 4 in flight | p50 latency ms | 9.197 | 9.637 | +4.8% |
| 32 connections × 4 in flight | core µs/completion | 75.54 | 79.46 | +5.2% |

The telemetry-disabled control did not show the same regression: median latency-profile throughput changed from 8,394 to 8,319.5 (-0.9%), while saturation throughput changed from 13,988 to 14,074 (+0.6%). The enabled regression is therefore larger than observed run-to-run drift.

### Change size

Relative to `origin/main`:

- Server source: `+3,713 / -3,170`, net `+543` lines.
- Server tests: `+36 / -27`, net `+9` lines.
- Benchmark code: `+152 / -30`, net `+122` lines.
- Overall diff: 26 files, `+3,903 / -3,227`.
- Public `telemetry.ts`: 3,068 implementation lines removed; 70-line entrypoint now.
- Largest remaining telemetry owner: `composition/telemetry.ts`, 2,244 lines.

The net source increase is a real cost. Most of it is explicit contract/state ownership plus the refuted fast-path machinery, not a reduction in total telemetry code.

### Verification

- `bunx tsc --noEmit` at repository root: pass.
- `bunx tsc -p bench/tsconfig.json --noEmit`: pass.
- Benchmark suite: 39 pass, 0 fail.
- Focused telemetry runtime/delivery/auth/core suite: 81 pass, 0 fail.
- Earlier reactive/runtime telemetry boundary suite after the idle change: 51 pass, 0 fail.
- Session-auth and telemetry-auth boundary suite after decoupling: 31 pass, 0 fail.
- Full server suite: 970 pass, 1 fail. The isolated failure is `vector-runtime.test.ts` expecting its child-process `numkong` mock to force `VectorRuntimeUnavailableError`; the engine instead starts and the child exits through test sentinel 22. This track changes no database/vector source or test, and the same isolated failure reproduces independently of the telemetry suite.

## 3. Blockers and resolutions

- The benchmark assumed Linux `/proc` process statistics. The audit machine is macOS, so commit `87701b2` added a `ps`-based process sampler while retaining the same RSS/core measurements.
- Exact byte accounting made retrospective slow/error trace promotion substantially more expensive than the initial design sketch implied. I kept exact accounting and bounded ownership rather than weakening policy; measurement then refuted the design.
- The unrelated native-vector test prevents a literally all-green full server suite. It is recorded rather than patched because this track has no vector-runtime ownership and the failure occurs in an isolated spawned-process mock.

No owner-level policy question remains, so no `BLOCKED.md` was created.

## 4. Gains and losses

### Gains

- Periodic reactive telemetry cost is now constant with retained subscription count.
- Expensive reactive pruning is demand-driven instead of coupled to every telemetry tick.
- External telemetry depends on an auth-domain observation contract, not the subscription protocol.
- Telemetry vocabulary, public contracts, mutable state, trace identity, operation tracing, aggregation, export deadlines, status defaults, and composition now have discoverable owners.
- The benchmark can compare enabled/disabled telemetry on Linux and macOS.
- Duplicate external/runtime trace ownership and delayed delivery promotion requirements are now explicit and tested.

### Losses and tradeoffs

- The fast-operation prototype adds buffering and exact deferred-size computation, increasing source size and making the measured hot path slower.
- Retrospective full phase traces require retaining enough phase input to replay them; this makes “cheap normal path plus full unexpected slow/error trace” structurally expensive.
- The split reduces the public giant file but leaves a 2,244-line composition owner. Further extraction should follow behavioral seams, not create more folders or forwarding functions.
- Incremental reactive counters add two mutation-point invariants. Tests cover them, but future entry lifecycle changes must update those owners.

## 5. Verdicts

| Experiment | Verdict | Reason |
| --- | --- | --- |
| Incremental idle projection | **Clear win** | Eliminates linear scans: 10k entries fell from 173.567 to 0.1925 CPU µs/sample with no loss of diagnostic snapshot behavior. |
| Fast successful-operation trace mode | **Refuted** | Exact, bounded retrospective buffering reduced enabled throughput 3.3–4.5% and worsened median latency 4.8–6.6%; disabled controls were stable. Do not merge this fast-path design as production code. |
| Neutral auth-attempt contract | **Clear win** | Removes the telemetry → subscription-protocol dependency with less session-owned type surface and green boundary tests. |
| Telemetry module split | **Needs iteration** | The public giant file and several major ownership tangles are gone, but total source grew and composition remains 2,244 lines. |

## 6. New findings

1. External HTTP observation opened a second public trace around an already traced Runtime operation. Any sampling design that leaves this duplication in place silently promotes nominally fast operations, defeating tail sampling.
2. Delivery observation can outlive operation completion. Trace selection must therefore remain claimable by a delivery lease until terminal send/failure observation; selecting only at handler return loses delayed transport failures.
3. Retrospective phase detail and a genuinely cheap normal path are in tension under exact byte and resource accounting. A better next experiment is prospective full sampling plus direct aggregate/boundary recording for unsampled operations, accepting that unsampled errors carry focused terminal/error detail rather than replaying every successful phase.
4. The original microbenchmark was Linux-specific, so audit evidence could not be reproduced on the coordinator's macOS machine until process sampling was made portable.
