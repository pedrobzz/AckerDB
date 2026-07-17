# Issue 15 post-fix paired canonical benchmark

This is honest paired diagnostic evidence, not an idle-host or formally passed
performance-acceptance run. The full unqualified workload completed and was
persisted. DBZZ and SpacetimeDB had no correctness failure; one Convex shared
capacity request timed out, so the canonical runner correctly left
`performanceAcceptance.status` as `not-evaluated`.

## Provenance and environment

- Source: clean commit `edf3af777819c6ecb8089a5353c0cb8efa585955`.
- Host/toolchain: Apple M2 Pro, macOS 25.6.0, Bun
  `1.3.14-canary.1+c18740dd8`, Convex client `1.42.1` and backend
  `precompiled-2026-07-06-44f7aa7`, SpacetimeDB CLI/client/module `2.6.1`.
- Command: exactly `bun bench/run.ts`, with no `BENCH_*` override.
- Execution order: Convex, SpacetimeDB, DBZZ telemetry-disabled,
  runtime-default, and benchmark-exporter.
- All three independently locked benchmark apps were installed with
  `bun install --frozen-lockfile`; benchmark ports 3311, 3210, 3211, and 5321
  and benchmark-like processes were clear immediately before and after.
- Immediate pre-run audit: 56.10% aggregate CPU idle, load average
  8.91/9.61/10.82. This was intentionally non-idle. The dominant external
  processes were `dasd` (91.1%), `appstoreagent` (65.5%), `WindowServer`
  (50.7%), `PerfPowerServices` (47.9%), and the Codex renderer (37.8%). An
  earlier ten-minute idle gate never reached two samples at 80% idle.
- The two pre-fix `e7f2408` runs were on the same machine and Bun toolchain in
  the same materially loaded band. The clean `06-09-09` run also used the same
  execution order. This makes them the useful pair; it does not turn either
  run into clean-room evidence.

Artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| [schema-v6 result](2026-07-17T07-27-48Z-edf3af7.json) | `b4d1a087e82d1d07fc5d38f05030dfa597851277b22e2867f5058774b6dadcad` |
| raw full-run log (kept outside git at `/private/tmp/issue15-postfix-edf3af7-full-canonical.log`) | `f684fcffea999717e4d5153189fd13112aed1212d420979d76ffafc3096bd0be` |

## Correctness outcome

The only recorded failure was Convex
`subscriptions/shared/capacity-32`: channel 25 version 2 delivery timed out
after 30 seconds and one request failed. DBZZ delivered every expected update
in every operation and subscription case, with zero missing, duplicate,
unexpected, or corrupt deliveries. Global performance acceptance therefore
remains correctly unevaluated; this note does not override that result.

## Post-fix DBZZ comparison

The full workload shows the fixed signal recovering:

| Evidence | Shared fixed-rate work CPU | Delivery p95 | Default CPU over disabled |
| --- | ---: | ---: | ---: |
| `c2b665a` correctness-valid baseline | 0.2920 cores | 15.99 ms | +95.0% |
| `e7f2408` clean pre-fix run | 0.3780 cores | 7.81 ms | +139.7% |
| `e7f2408` second pre-fix run | 0.3681 cores | 7.94 ms | +124.8% |
| `edf3af7` post-fix run | 0.2623 cores | 7.81 ms | +65.9% |

Post-fix work CPU is 30.6% and 28.7% below the two pre-fix runs and 10.2%
below `c2b665a`, without trading away delivery latency or completeness.

All eight mutation throughput cells improved against both pre-fix runs:

| Operation | Versus clean pre-fix | Versus second pre-fix |
| --- | ---: | ---: |
| uncontended, four profiles | +3.7% to +13.7% | +5.7% to +34.9% |
| contended, four profiles | +4.7% to +15.1% | +6.4% to +8.1% |

Procedure throughput was mixed but bounded by normal run noise: +6.6%, -1.4%,
-8.6%, and -5.3% versus the clean pre-fix run, and +0.4%, -2.3%, -8.6%, and
+1.6% versus the second. Query throughput was effectively flat versus the
clean pre-fix run (+0.2%, -3.0%, +0.8%, -0.3%). A repeat was not justified:
the repaired CPU signal is large against both paired pre-fix runs, mutations
move uniformly in the right direction, procedure/query changes stay inside
the documented +/-15% noise band, and the run-level failure belongs to Convex.

## Frozen-win subset audit

The saved record remains `not-evaluated`. Separately, a read-only audit used
the canonical exported metric extraction, frozen classifications, and noise
allowances only for the valid DBZZ-versus-SpacetimeDB subset. It did not
evaluate or claim the invalid Convex floors.

| Run | Frozen obligations retained | Frozen obligations lost |
| --- | ---: | ---: |
| `c2b665a` | 187 / 273 | 86 |
| clean pre-fix `e7f2408` | 182 / 273 | 91 |
| second pre-fix `e7f2408` | 179 / 273 | 94 |
| post-fix `edf3af7` | 195 / 273 | 78 |

The post-fix run retains 13 and 16 more frozen wins than the two pre-fix runs,
and eight more than `c2b665a`. Only two losses were newly present against both
pre-fix runs:

- connection-100 query p99 was 13.821 ms versus SpacetimeDB's 13.329 ms; DBZZ
  itself was essentially unchanged from the second pre-fix run's 13.749 ms,
  while the SpacetimeDB side moved materially;
- shared subscribed-idle CPU was 0.0663 cores versus SpacetimeDB's 0.0385 and
  was worse than the two pre-fix DBZZ draws of 0.0241 and 0.0310. It missed
  the frozen 0.025-core noise envelope by only 0.0029 cores in a short idle
  sample on the explicitly loaded host.

The connection p99 does not show a repeated DBZZ slowdown; its absolute value
matches the second pre-fix draw while the SpacetimeDB side moved. The
subscribed-idle CPU draw is worse than both pre-fix draws, but it is isolated:
the related baseline-idle sample does not share the direction, shared work CPU
improves 29-31%, and the miss beyond the absolute noise allowance is tiny. The
total frozen-win set and repaired headline measurements improve materially,
with no consistent family-level regression. This clears Issue 15's
no-consistent-regression criterion; it does not claim that the branch passes
the repository's global frozen gate.
