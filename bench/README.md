# dbzz vs Convex vs SpacetimeDB — apples-to-apples local microbenchmark

This benchmark measures the current implementations on one machine with one
fixed workload contract. It does **not** try to reproduce or approach an
official vendor benchmark. Official SpacetimeDB results use different
operations, transports, builds, and hardware; comparing their numbers directly
to these numbers would be invalid.

The benchmark is deliberately small enough to remain a microbenchmark, but it
does real indexed reads, transactional writes, server-side computation,
connections, and reactive delivery through each product's current client SDK.

## Run it

```sh
bun bench/run.ts                              # default all-system run; saves passed or correctness-failed evidence
BENCH_COMPARISON=current bun bench/run.ts     # same-host comparison; skips historical acceptance and saves evidence
BENCH_PROFILE=quick bun bench/run.ts          # profiled all-system smoke diagnostic; never saves
BENCH_PROFILE=stress bun bench/run.ts         # profiled all-system stress diagnostic; never saves
bun bench/run.ts dbzz convex                  # partial diagnostic; never saves
```

Before each selected system starts, the runner checks only that leg's fixed
ports: 3311 for DBZZ, 3210 and 3211 for Convex, and 5321 for SpacetimeDB. Thus
an unrelated occupied port does not block a partial diagnostic. Every system
gets fresh state, a warmup before measured operations, and the same
deterministic seed. The unqualified all-system command rotates system order;
an explicit system list preserves its order. All-system runs also start DBZZ
three times from fresh equivalent state, including quick and stress
diagnostics: with the literal `Runtime` telemetry default (the constructor
option is omitted), with that same default plus an explicit in-process exporter
callback, and with `telemetry: false`. `systems.dbzz` remains the exact default
profile used in the three-system tables. The exporter and disabled results plus
their deltas are separate schema-v7 evidence, not extra databases. Partial runs
execute only the selected systems and one default-enabled DBZZ profile.

`BENCH_COMPARISON=current` runs the complete default workload and all three DBZZ
telemetry profiles, preserves a schema-v7 record, and compares it with the most
recent schema-v7 current-host record on the same machine and configuration. It
does not evaluate the historical machine-bound gate. Correctness-failed systems
are excluded from delta claims, while their typed case failures and partial
request accounting remain in the saved record; the command exits failing only
after persistence. This is the intended paired mode for comparing current
systems on a different machine.

### Retained MCP paired run

The first-class MCP change was measured on one Hetzner host with an identical
schema-v7 harness applied to pre-MCP source and MCP source. The exact chronology
is retained below; S/E/D/R/C means SpacetimeDB, DBZZ exporter, DBZZ disabled,
DBZZ runtime-default, and Convex.

| UTC result | Source role | Order | DBZZ failures R/E/D | Runtime-default shared delivery p99 |
| --- | --- | --- | ---: | ---: |
| [15:34:17](results/2026-07-17T15-34-17Z-2282dfa.json) | pre-MCP baseline A | S/E/D/R/C | 0/0/0 | 34.433 ms |
| [15:45:59](results/2026-07-17T15-45-59Z-35f4c5b.json) | MCP before fast path | R/E/D/C/S | 0/0/0 | 40.183 ms |
| [15:58:54](results/2026-07-17T15-58-54Z-35f4c5b.json) | MCP before fast path, matched order | S/E/D/R/C | 0/0/0 | 47.061 ms |
| [16:10:15](results/2026-07-17T16-10-15Z-2282dfa.json) | pre-MCP baseline B, matched order | S/E/D/R/C | 0/0/0 | 32.089 ms |
| [16:50:46](results/2026-07-17T16-50-46Z-452e23d.json) | first zero-MCP fast path | S/E/D/R/C | 0/0/0 | 45.133 ms |
| [17:33:26](results/2026-07-17T17-33-26Z-5462d58.json) | structural zero-MCP fast path | S/E/D/R/C | 0/0/0 | 36.063 ms |

The final record is clean-source evidence with exact 20,000/20,000 shared
deliveries and zero DBZZ correctness failures in all three profiles. Its
SHA-256 is
`a91aedef0e529063be9de161f984d27e2ffa8f85f77936fc08cfc2210107a137`.
Convex and SpacetimeDB subscription failures made global performance acceptance
correctly `not-evaluated`; they were persisted rather than hidden. The two
pre-MCP draws, raw distributions, paired deltas, controlled diagnosis, failure
semantics, source/log hashes, and non-regression conclusion are in the
[complete MCP paired evidence](results/2026-07-17T17-33-26Z-5462d58-mcp-paired.md).

All DBZZ legs explicitly select `DBZZ_DURABILITY=balanced`. The
`runtime-default` profile uses the production retention/queue limits, built-in
console local sink, and no exporter. The `benchmark-exporter` profile changes
only the explicit `TelemetryExporter` callback; its immediately resolving
promise-based in-process handoff discards the batch after DBZZ has delivered
it, exercising the production asynchronous export path while measuring the
minimum framework queue/batch/export cost without pretending to represent a
particular network backend. The `disabled` profile configures neither an exporter nor a
local sink. The runner confirms these choices through `DBZZ_TELEMETRY` and the
benchmark-private `DBZZ_BENCH_EXPORTER` selector.

The benchmark server emits exactly one startup marker before readiness. The
marker confirms telemetry/durability mode, profile name, exporter/local-sink
selection, and the exact production telemetry limits. Every DBZZ leg also
requires a terminal telemetry report that proves delivered local span/event
output, collected metric series, fixed-dimension operation/stage aggregates,
configured queue and trace-retention bounds, the exact absent or healthy
exporter state, a positive cumulative aggregate snapshot delivered to the
benchmark exporter, and empty queues, false aggregate-pending state, no
in-flight work, and empty trace state after drain. The
required aggregate cells follow the actual execution paths: `query.queue`,
`mutation.queue`, `procedure.admission`, and `subscription.queue`; their counts
and operation totals must cover the executed workload. The status table publishes
each queue cell's count and mean observed duration. Disabled legs must prove
zero queue, metric-series, drop, trace-retention, local-sink, exporter, and
aggregate activity.

The parent streams DBZZ stdout and stderr while retaining only startup/readiness
control lines, a 64 KiB diagnostic tail, and fixed telemetry counters and byte
totals; telemetry JSON lines are not accumulated in memory. Because the default
runtime has no exporter, records in its main exporter queue are dropped at
terminal drain and that bounded queue may also overflow under load. The report
checks those visible drain/overflow/expiry counters account for the retained
queue instead of pretending default drops are zero. The explicit exporter leg
must instead export every drained batch with zero failures/timeouts and balanced
queue accounting. It must also agree with the terminal Runtime aggregate
snapshot and report zero failed or pending aggregate snapshots. The local sink
must deliver output without failure or timeout in both enabled legs. The three
profile positions rotate between saved runs and are preserved in
`executionOrder`.

## Schema-v7 measured-failure record and integrity gate

Only an all-system run with `BENCH_PROFILE=default` (or no `BENCH_PROFILE`) can
write
`bench/results/<timestamp>-<gitsha>.json`. Quick, stress, and partial runs print
the same diagnostic result tables, then finish with an explicit
acceptance-skipped/result-not-saved message. The result file is written when
the harness produced structurally comparable, correctly accounted output, even
when the measurements fail acceptance.
Cases that never reach a valid measurement are stored as their canonical
operation/profile, connection level, subscription pattern, or capacity slot
plus a typed failure—never invented zero throughput or latency. A closed-loop
deadline preserves its observed completions and accounts every still-in-flight
attempt as failed. When cancellation cannot reclaim the phase, the workload
marks the system terminal, emits all remaining configured identities as failed,
and the parent reclaims the client process before starting the next system.
Measured operation, connection, and subscription correctness failures are an
immutable top-level `validation` section with an overall `passed` or `failed`
status and per-case errors. A failed validation skips performance acceptance,
is saved with `performanceAcceptance.status = "not-evaluated"`, and returns a
failing exit status only after reporting and persistence. Ordinary performance
regressions are likewise saved with `performanceAcceptance.status = "failed"`,
structured per-gate failures, complete evidence, and a failing exit status only
after persistence. Harness-integrity
failures such as config/case-shape mismatches or broken attempted/completed/
failed accounting remain fatal because the resulting metrics are not
meaningful. Telemetry-integrity failures remain fatal for the same reason.

Acceptance is anchored to the immutable schema-v3 baseline
`results/2026-07-13T15-34-33Z-74d8554.json`. Its exact SHA-256 is
`ab78ada0d9d16576b7aca175c1230c456064bcf5b4a80e66b5e1c55a4528a474`, and its
identity must remain schema version 3 at Git commit `74d8554`. A correctness-
passing after-run entering performance acceptance must be schema v6 and must
exactly match the baseline's complete machine object, 250 ms server-sampling
interval, and workload identity for DBZZ,
Convex, and SpacetimeDB. Workload identity includes the dataset seed, operation
and concurrency shapes, connection levels, subscription population/rates/
patterns/capacity points, and setup behavior. Measurement effort—warmup,
steady-window length, trial count, idle plateau length, single-client
readiness sample count, and connection/
subscription window duration—may change, but must remain identical across the
three current systems. The gate records the baseline source hash, machine
fingerprint, and config SHA in its evidence; it does not require the changed
source hash to equal the baseline.

Each system must expose the same 351 unique comparable metric paths with the
same direction and family. From the frozen baseline, all 273 strict
DBZZ-over-SpacetimeDB wins are immutable obligations, split by the baseline's
own win margin against the measurement noise floor — 15% of the SpacetimeDB
value (the repo doctrine's normal run-to-run swing), or 25 milli-cores absolute
for `resource.cpu` only, whose idle plateaus sit at the 10 ms `ps` cputime
resolution and move ~12 milli-cores per system between identical runs:

- The 251 solid wins (baseline margin at or above the floor) must remain
  strict DBZZ wins over SpacetimeDB in the after-run, exactly as before. A
  solid win that slips behind by any amount fails the run.
- The 22 near-tie wins (baseline margin below the floor — a coin flip
  run-to-run, not a resolvable ranking) must stay within the same envelope:
  the run fails only when current DBZZ falls behind current SpacetimeDB by
  more than the floor. Every accepted run prints and records each near-tie
  path's baseline and current margins, so within-floor drift stays visible
  run-over-run. A near-tie path can therefore drift at most one envelope
  behind current SpacetimeDB — a bounded, non-compounding worst case of
  roughly its baseline margin plus the floor — before the gate fails. The
  fixed-rate throughput near-ties are additionally backstopped regardless of
  the envelope: delivery-completeness correctness, the offered-load
  completion gates on both fixed-rate patterns, and the shared Convex
  delivery floor all reject a failure to deliver the offered work.

The near-tie classification is derived from the digest-pinned frozen baseline
only, so it can never grow, and the near-tie count is itself frozen. This is a
current DBZZ-versus-current-SpacetimeDB comparison on the frozen
machine/config, not a tolerance against DBZZ's old absolute value.

The after-run must also pass exactly 126 DBZZ-versus-Convex floors:

- 20 operation and connection-work throughput paths: DBZZ must be at least
  5x Convex.
- 20 operation and connection-work p95 latency paths: DBZZ must be at most
  50% of Convex.
- One shared fixed-rate delivery-throughput path: DBZZ must be at least 1.25x
  Convex.
- 11 fixed-rate or capacity delivery-p95 paths where both systems completed
  the offered work exactly: DBZZ must be at most 50% of Convex.
- 74 loaded server-RSS p50/peak paths: DBZZ must be at most 50% of Convex.
  Startup, seeded-idle, and pre-connection/subscription baseline RSS are not
  part of this Convex floor.

Finally, a correctness-passing DBZZ run must complete each shared and
partitioned fixed-rate offered workload before performance acceptance:
completed updates must equal `duration × configured updates/s`; observed
deliveries must equal expected deliveries with none missing; update throughput must reach the
configured offered rate; and delivery throughput must reach at least 99% of
expected deliveries divided by the offered duration. Missing metric paths or a
changed floor count remain fatal harness-integrity failures. An evaluated
performance failure is recorded, saved, and then returns a failing status.
Delivery correctness failures instead follow the schema-v7 failed-validation
path above and are saved without evaluating these performance claims.

Prerequisites:

- Bun dependencies installed in the repository and both benchmark apps.
- Convex 1.42.1, pinned exactly in `bench/convex-app`.
- SpacetimeDB CLI, client SDK, and module SDK all at 2.6.1. The runner hard-fails
  on a mismatch and regenerates TypeScript bindings before every publish.
- The runner generates ignored DBZZ bindings before the first DBZZ leg; Convex
  and SpacetimeDB bindings are likewise generated by their owning setup steps.
- A high enough file-descriptor limit for the stress profile. The actual limit
  is recorded in every result.

Useful overrides include `BENCH_CONNECTION_LEVELS`, `BENCH_SUB_USERS`,
`BENCH_SUB_QUERIES`, `BENCH_WARMUP_MS`, `BENCH_STEADY_MS`, `BENCH_TRIALS`, and
`BENCH_RESOURCE_SAMPLE_MS`. Subscription capacity can be tuned with
`BENCH_SUB_CAPACITY_DURATION_MS` and `BENCH_SUB_CAPACITY_SLOTS`.

## Fixed operation contract

The dataset contains 8,192 documents in 64 partitions, 2,048 accounts, and one
128-byte row for every subscription argument. Timed setup and timed operations
never use benchmark-side request batching.

| Case | Identical logical work | dbzz API | Convex API | SpacetimeDB 2.6 API |
|---|---|---|---|---|
| query | Composite-index prefix scan; first 20 rows in ascending rank; return rank, score, 128-byte payload, nonce, and checksum | query | query | read-only procedure with explicit transaction |
| mutation | Transactionally read two indexed accounts, transfer one unit, and update both balances and versions | mutation | mutation | reducer |
| procedure | Hash a 1 KiB payload for 8 rounds without database or network I/O from the function | procedure | action | procedure |
| subscription update | Read one indexed channel row, increment version, replace 128-byte payload/checksum, and deliver the exact new row | mutation + query subscription | mutation + query subscription | reducer + table subscription |

Every query and compute response is validated by nonce, shape, payload, and
checksum. Mutations are checked outside the timed window against a client-side
model of every account, not merely total balance. Request failures, missed
connection targets, and missing, duplicated, unexpected, or corrupt
subscription deliveries are recorded as measured correctness failures.
Unbalanced request accounting or mismatched configs/case shapes abort because
the result is malformed or incomparable.

SpacetimeDB 2.6's TypeScript SDK has no public one-off query method. Its query
case therefore uses the native read-only procedure API plus `ctx.withTx`; using
the HTTP SQL debug endpoint would measure a documented non-performance path.
This transport difference is recorded in the JSON and is part of the product
tradeoff, while the database work and returned bytes stay the same.

## Load shapes

Operations use a closed-loop load generator. Reported latency is therefore
closed-loop response latency, not open-loop queueing latency; TPS counts only
requests completed inside the exact steady window. Requests started before the
cutoff may drain afterward for correctness, but their work is excluded from the
steady CPU/RSS window and from TPS.

The default operation profiles are:

| profile | connections | in-flight per connection | total in-flight |
|---|---:|---:|---:|
| latency | 1 | 1 | 1 |
| pipeline | 1 | 8 | 8 |
| concurrent | 8 | 4 | 32 |
| saturation | 32 | 4 | 128 |

Each operation/profile has a 500 ms warmup and one 2-second steady trial. The
window still contains enough completed operations for stable percentiles on
this local workload; an implausible headline result is rerun instead of making
every normal run pay for three repetitions.

The connection ladder grows one cohort through 1, 100, 500, and 1,000 active
clients. “Ready” includes the native connection plus one validated indexed
probe, then every active connection keeps exactly one indexed query in flight
for one second. The stress profile adds 5,000 and 10,000. This is end-to-end
SDK + client event loop + server capacity; load-generator CPU is reported
separately so a client-side ceiling is visible.

A level that adds exactly one connection (the 1-client level) measures
readiness as 20 sequential connect → ready → close samples, each preceded by
the same idle gap the ladder applies before that level, with the last sample
kept as the cohort member. Its readiness percentiles are computed across those
samples and its setup time and connections/s over the aggregate measured
connect time (the deliberate idle gaps are protocol, not setup work), because
one post-idle connect draw has a heavy scheduling tail on macOS and is not a
distribution. Levels that add many connections already aggregate across their
concurrent connects and are unchanged. The sampling protocol lives in the
shared workload code and is identical for all three systems.

The default subscription cases both use 500 independent client connections and
50 query arguments per user (25,000 logical subscriptions):

- `shared`: all users have the same 50 arguments. It applies 20 updates/s;
  every update must reach all 500 users (20,000 checked deliveries total).
- `partitioned`: every user has 50 unique arguments. It applies 100 updates/s;
  every update has one intended recipient (200 checked deliveries total).

The patterns use disjoint seeded channels. Subscription readiness is explicit,
updates use a fixed-rate offered window, and a channel is not reused until its
previous delivery completes. SpacetimeDB groups a user's 50 predicates into one
native subscription handle, while dbzz and Convex register 50 native query
subscriptions; that current-SDK difference is intentionally preserved and
setup time includes it.

After the fixed-rate checkpoint, the same subscribed users enter an end-to-end
closed-loop saturation sweep. Independent writer connections ramp through 1,
8, 32, 128, and 512 slots, capped by the distinct channels available to the
pattern (50 shared channels and 500 partitioned users by default). A write only
completes after every intended client validates the exact new version, payload,
and checksum. Each level runs for two seconds. This reports sustainable
updates/s, deliveries/s, and latency without allowing an unbounded offered-load
queue to make throughput look higher than the system can deliver.

## CPU and memory

The server and load generator are sampled separately from one shared `ps`
process-table scan every 250 ms on macOS or Linux. For each process tree:

- CPU is cumulative user + system CPU divided by exact phase wall time, shown
  as average cores.
- Memory is sampled summed RSS for live processes, shown as p50 and sampled
  peak. Summed RSS is an accounting metric: shared pages can be counted once
  per process, and sub-250 ms spikes can be missed.

Timed idle plateaus cover empty/no-client, seeded/no-client, connection
baseline, each connected cohort, each subscription baseline, and each
subscribed cohort. Working phases report the same CPU/RSS fields. Because the
server stays alive through a leg, allocators may retain or release memory
between phases; per-scenario baseline and delta are both printed, and a negative
delta is possible when a runtime releases memory during the later plateau.
The default, exporter, and disabled DBZZ legs use identical sampling and
workload. Schema v5 stores all three raw profiles, default-versus-disabled
throughput/p50/p95/p99/CPU/RSS deltas, and exporter-versus-default deltas over
the same metric set. Those tables include server CPU and peak RSS for each
highest-concurrency operation case plus connection and subscription resource
plateaus. The telemetry report separately stores bounded local-output
record/byte counters, before/after queue and trace-retention snapshots,
export/drop accounting, exporter health and delivered-record counts, and the
strict operation/stage aggregate matrix. The exporter delta is explicitly the
minimum DBZZ handoff cost; transport, collector, and vendor-backend costs remain
outside the product and benchmark contract.

## What these numbers mean

This is a good local single-node microbenchmark for SDK/protocol overhead,
indexed reads, small transactions, CPU-bound server calls, connection scaling,
and subscription fanout/cardinality. It exercises production-shaped paths and
checks actual results instead of timing no-op calls.

It is not a hosted-service, WAN-latency, multi-region, bearer-authentication,
multi-node, large-on-disk-dataset, or complex-business-workload benchmark.
Local Convex avoids hosted network latency; dbzz and SpacetimeDB are local too.
DBZZ deliberately uses its observable `balanced` durability profile: SQLite
WAL with `synchronous=NORMAL`, acknowledging after commit. This preserves the
historical local comparison and is process-crash consistent, but it is not a
power-loss durability claim. Convex uses its current local backend default, and
SpacetimeDB uses confirmed reads and its standalone durable commit log.

## Current default result

Run: 2026-07-13 local time / `2026-07-13T12:48:31Z`, Apple M2 Pro (12 logical
CPUs, 32 GiB), macOS 25.6.0, Bun `1.3.14-canary.1+c18740dd8`, Convex client
1.42.1/backend `precompiled-2026-07-06-44f7aa7`, SpacetimeDB 2.6.1. System
order: Convex → SpacetimeDB → dbzz. Full machine/config/source identity and all
trials are in `results/2026-07-13T12-48-31Z-4aa2b1e.json`.

Operation cells are `completed TPS / closed-loop p95 ms`:

| operation/profile | dbzz | Convex | SpacetimeDB |
|---|---:|---:|---:|
| query / latency | **10,386 / 0.14** | 410 / 3.23 | 664 / 2.00 |
| query / saturation | **31,457 / 6.53** | 1,482 / 140.72 | 21,224 / 10.96 |
| mutation-uncontended / latency | **9,064 / 0.13** | 300 / 4.44 | 568 / 3.15 |
| mutation-uncontended / saturation | 10,940 / 20.59 | 501 / 402.01 | **33,056 / 6.20** |
| mutation-contended / latency | **7,618 / 0.15** | 187 / 11.59 | 553 / 3.09 |
| mutation-contended / saturation | 8,889 / 28.46 | 113 / 5,113.12 | **30,949 / 6.53** |
| procedure/action / latency | **12,262 / 0.11** | 584 / 4.67 | 734 / 1.81 |
| procedure/action / saturation | 39,122 / 3.91 | 2,407 / 119.36 | **50,926 / 4.43** |

Connection query cells are `completed TPS / closed-loop p95 ms`:

| active clients | dbzz | Convex | SpacetimeDB |
|---:|---:|---:|---:|
| 1 | **11,205 / 0.15** | 332 / 5.68 | 692 / 1.84 |
| 100 | **25,354 / 6.42** | 1,146 / 150.50 | 15,389 / 11.57 |
| 500 | **28,404 / 19.01** | 1,016 / 571.63 | 14,399 / 51.66 |
| 1,000 | **28,228 / 37.62** | 640 / 1,762.36 | 13,971 / 111.95 |

Subscription latency is measured from the writer call start to the validated
client delivery. “All p95” is time until every intended recipient receives an
update.

| pattern/system | setup s | deliveries/s | delivery p95 ms | all p95 ms | exact deliveries |
|---|---:|---:|---:|---:|---:|
| shared / dbzz | **0.18** | **9,998** | **7.06** | **8.23** | 50,000 / 50,000 |
| shared / Convex | 0.72 | 6,710 | 683.82 | 1,424.50 | 50,000 / 50,000 |
| shared / SpacetimeDB | 0.34 | 9,996 | 11.23 | 12.74 | 50,000 / 50,000 |
| partitioned / dbzz | **0.43** | 100 | **1.25** | **1.25** | 500 / 500 |
| partitioned / Convex | 8.05 | 100 | 8.83 | 8.83 | 500 / 500 |
| partitioned / SpacetimeDB | 0.52 | 100 | 4.21 | 4.21 | 500 / 500 |

End-to-end subscription capacity peaks from the concurrency sweep:

| pattern/system | peak writer slots | updates/s | deliveries/s | all-delivered p95 ms |
|---|---:|---:|---:|---:|
| shared / dbzz | 8 | **555.2** | **277,600** | **22.80** |
| shared / Convex | 50 | 12.3 | 6,150 | 6,523.26 |
| shared / SpacetimeDB | 50 | 255.7 | 127,850 | 242.36 |
| partitioned / dbzz | 8 | **7,091.8** | **7,092** | **2.14** |
| partitioned / Convex | 128 | 533.0 | 533 | 379.24 |
| partitioned / SpacetimeDB | 500 | **20,466.1** | **20,466** | 44.10 |

Selected server resource plateaus:

| system | empty RSS MB | seeded RSS MB | 1,000-client idle RSS MB | query saturation peak RSS / CPU cores | procedure saturation peak RSS / CPU cores |
|---|---:|---:|---:|---:|---:|
| dbzz | **45.5** | **88.1** | **105.5** | **114.5 / 0.97** | **107.0 / 1.00** |
| Convex | 78.8 | 155.4 | 1,155.0 | 605.3 / 5.79 | 1,644.3 / 7.69 |
| SpacetimeDB | 89.2 | 115.2 | 351.5 | 266.1 / 2.85 | 158.5 / 4.13 |

The conclusion is workload-specific: dbzz is far ahead of Convex throughout
this local web/mobile-shaped microbenchmark. SpacetimeDB is the stronger
reference at saturated writes and server compute, while dbzz leads these
indexed query cases and uses substantially less memory. That does not conflict
with SpacetimeDB's official benchmarks; it demonstrates that this benchmark is
measuring a different, explicitly defined workload.

The displayed result is the last schema-v3 run and intentionally remains in
place until a post-change full passing schema-v7 run exists. Schema-v2 predates
the subscription-capacity sweep; schema-v3 predates paired telemetry and
server-confirmed durability modes; schema-v6 predates typed case failures and
current-host comparison ownership. Earlier schemas are not delta-comparable
with schema-v7.
Treat small latency/RSS differences as ranges and rerun; the large
dbzz-vs-Convex gaps and the SpacetimeDB saturated-write advantage have repeated
across the retained runs.
