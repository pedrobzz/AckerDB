# DBZZ release benchmark

This benchmark measures DBZZ, Convex, and SpacetimeDB with one fixed logical
workload. It is release evidence, not a development-loop tool and not a vendor
benchmark claim.

## Release-only policy

Run the full comparison only for a major, minor, or patch version change. Do
not run a pre-change benchmark: the final benchmark of the preceding version
is the baseline. The comparison always runs the complete DBZZ, Convex, and
SpacetimeDB workload on the dedicated Hetzner host (`htz`) and nowhere else.

After `bun run bump <patch|minor|major>`, dispatch this in a background
subagent or worker:

```sh
bun run bench:hetzner
```

The command makes a clean Git-bundle checkout on Hetzner, installs the pinned
dependencies, runs the suite, and copies the retained result back. It never
benchmarks the developer machine. The merge guard requires the final result,
so a version cannot reach `main` without approved evidence.

### Version-bound retention

- Final approved evidence is `bench/results/v<version>.json`.
- A failing correctness check or material regression is
  `bench/results/v<version>.iteration-<n>.json`.
- A final passing run deletes every iteration for that version. No timestamp
  records, logs, or other non-final benchmark artifacts are retained.
- Existing releases need one honest transition baseline. Run
  `bun run bench:hetzner --bootstrap <released-version>` against the latest
  release tag on Hetzner once; it uses the current version-bound harness with
  that tag's package sources. Do not relabel an old timestamp record.

### Regression and recovery

The runner compares DBZZ's full metric set with the preceding final version.
Convex and SpacetimeDB run in the same host/workload as comparability context,
but their vendor movement is not treated as a DBZZ regression. A directional
move beyond the 15% run-to-run noise envelope (or 0.025 CPU cores at idle)
enters performance recovery.

1. Rerun once to exclude measurement error. `bench:hetzner` assigns the next
   iteration number automatically and never overwrites a retained iteration.
2. If it repeats, inspect the changed implementation and decisions as intended
   behavior with a wrong design. Find the hot path, why it is hot, and replace
   the design so the work disappears rather than patching around it.
3. A release is approved only after no material regression remains. If keeping
   the feature makes that impossible, state that explicitly in the release
   handoff rather than hiding the cost.

Benchmark correctness failures always fail the release. Small movements inside
the envelope are normal measurement variation; meaningful impact is not.

## What the runner measures

Each release uses fresh equivalent state, a deterministic seed, warmup before
measurement, and server resource windows. DBZZ is run three times from fresh
equivalent state: its literal runtime telemetry default, the same default with
an explicit in-process exporter, and telemetry disabled. The record verifies
result correctness, request accounting, delivery completeness, process cleanup,
and telemetry mode/accounting before performance is evaluated.

Prerequisites on Hetzner are Bun, Node 24 for Convex, and SpacetimeDB CLI
2.6.1 with its matching client/module SDK pins. The runner regenerates DBZZ
bindings in the clean checkout.

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
workload. A final release record stores all three raw profiles,
default-versus-disabled throughput/p50/p95/p99/CPU/RSS deltas, and
exporter-versus-default deltas over the same metric set. Those tables include
server CPU and peak RSS for each highest-concurrency operation case plus
connection and subscription resource plateaus. The telemetry report separately
stores bounded local-output record/byte counters, before/after queue and
trace-retention snapshots, export/drop accounting, exporter health and
delivered-record counts, and the strict operation/stage aggregate matrix. The
exporter delta is explicitly the minimum DBZZ handoff cost; transport,
collector, and vendor-backend costs remain outside the product and benchmark
contract.

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


## Results

The repository retains only final version-bound JSON records. Read the latest
`bench/results/v*.json` record for the current comparison; historical
timestamp-based results were deliberately removed because they cannot act as
release baselines under this policy.
