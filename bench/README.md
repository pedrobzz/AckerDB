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
bun bench/run.ts                              # default: all systems, saves JSON
BENCH_PROFILE=quick bun bench/run.ts          # smoke profile, saves JSON
BENCH_PROFILE=stress bun bench/run.ts         # adds 5,000 and 10,000 connections
bun bench/run.ts dbzz convex                  # any subset; does not save JSON
```

The runner checks that ports 3311, 3210/3211, and 5321 are free before starting
anything. Every system gets fresh state, a warmup before measured operations,
and the same deterministic seed. All-three-system runs rotate system order and
write `bench/results/<timestamp>-<gitsha>.json`; partial runs are diagnostic and
are not saved.

Prerequisites:

- Bun dependencies installed in the repository and both benchmark apps.
- Convex 1.42.1, pinned exactly in `bench/convex-app`.
- SpacetimeDB CLI, client SDK, and module SDK all at 2.6.1. The runner hard-fails
  on a mismatch and regenerates TypeScript bindings before every publish.
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
model of every account, not merely total balance. A run is rejected instead of
saved if any request fails, request accounting does not balance, a connection
target is missed, configs/case shapes differ, or any subscription delivery is
missing, duplicated, unexpected, or corrupt.

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

Each operation/profile has a 1-second warmup and three independent 3-second
steady trials. The displayed throughput and percentiles are medians of those
trials.

The connection ladder grows one cohort through 1, 100, 500, and 1,000 active
clients. “Ready” includes the native connection plus one validated indexed
probe, then every active connection keeps exactly one indexed query in flight
for two seconds. The stress profile adds 5,000 and 10,000. This is end-to-end
SDK + client event loop + server capacity; load-generator CPU is reported
separately so a client-side ceiling is visible.

The default subscription cases both use 500 independent client connections and
50 query arguments per user (25,000 logical subscriptions):

- `shared`: all users have the same 50 arguments. It applies 20 updates/s;
  every update must reach all 500 users (50,000 checked deliveries total).
- `partitioned`: every user has 50 unique arguments. It applies 100 updates/s;
  every update has one intended recipient (500 checked deliveries total).

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
and checksum. Each level runs for 10 seconds. This reports sustainable
updates/s, deliveries/s, and latency without allowing an unbounded offered-load
queue to make throughput look higher than the system can deliver.

## CPU and memory

The server and load generator are sampled separately from one shared macOS
process-table scan every 250 ms. For each process tree:

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

## What these numbers mean

This is a good local single-node microbenchmark for SDK/protocol overhead,
indexed reads, small transactions, CPU-bound server calls, connection scaling,
and subscription fanout/cardinality. It exercises production-shaped paths and
checks actual results instead of timing no-op calls.

It is not a hosted-service, WAN-latency, multi-region, authentication,
multi-node, large-on-disk-dataset, or complex-business-workload benchmark.
Local Convex avoids hosted network latency; dbzz and SpacetimeDB are local too.
Durability remains each implementation's native default: dbzz uses SQLite WAL
with `synchronous=NORMAL` and acknowledges after commit, Convex uses its current
local backend default, and SpacetimeDB uses confirmed reads and its standalone
durable commit log.

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

The earlier schema-v2 results remain in `bench/results/`, but they predate the
subscription-capacity sweep and are intentionally not delta-comparable with
this schema-v3 run. Treat small latency/RSS differences as ranges and rerun;
the large dbzz-vs-Convex gaps and the SpacetimeDB saturated-write advantage have
repeated across the retained runs.
