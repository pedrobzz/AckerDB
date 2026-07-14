# B0 unchanged-tree benchmark baseline

- Branch/HEAD: `codex/benchmark-capacity` at `74d8554`
- Valid record: `bench/results/2026-07-13T15-34-33Z-74d8554.json`
- Systems/order: Convex local backend, SpacetimeDB 2.6.1, DBZZ workspace
- Machine/runtime: preserved in the result record
- Correctness: every operation, connection, fixed-rate subscription, and
  saturation-capacity gate passed for all three systems
- Cleanup: ports 3311, 3210, 3211, and 5321 were free after completion

The first unchanged-tree attempt was correctly rejected and saved no result:
Convex `subscriptions/shared/capacity-50` reported 2,695 duplicate deliveries.
All ports were free afterward. The second unchanged-tree attempt passed, so the
rejected reference-system run is diagnostic evidence rather than a DBZZ baseline.

## Headline DBZZ baseline

| Metric | Value |
| --- | ---: |
| Query saturation | 33,584 ops/s; 5.30 ms p95 |
| Mutation-uncontended saturation | 10,223 ops/s; 23.18 ms p95 |
| Mutation-contended saturation | 9,779 ops/s; 22.28 ms p95 |
| Procedure saturation | 39,153 ops/s; 4.03 ms p95 |
| 1,000-connection query | 28,476 ops/s; 37.12 ms p95 |
| 1,000-connection idle RSS | 108.6 MiB |
| Shared fixed-rate subscription | 9,998 deliveries/s; 6.64 ms p95 |
| Partitioned fixed-rate subscription | 100 deliveries/s; 2.33 ms p95 |
| Shared capacity best accepted point | 267,150 deliveries/s at 8 writers |
| Partitioned capacity best accepted point | 7,342 deliveries/s at 8 writers |

## Frozen acceptance gates

The saved JSON is the machine-readable source of truth. P1 must derive and store
the complete set of comparable metric paths where DBZZ beats SpacetimeDB in this
record, then reject an after-run that loses any path after the required noise
rerun. This includes operation throughput and p50/p95/p99, connection readiness
and query work, fixed-rate and capacity subscription delivery/latency, and
server resource paths. It must not use a manually curated headline subset.

The known SpacetimeDB win groups are:

- every query profile's throughput and p95 latency;
- mutation latency/pipeline throughput and latency, plus uncontended concurrent
  throughput and procedure saturation p95;
- procedure latency/pipeline/concurrent throughput and latency;
- all connection-level readiness, query throughput, and query p95 results;
- fixed-rate subscription setup and delivery latency for both patterns, plus
  shared delivery throughput and resource wins;
- every shared-capacity delivery/latency point and partitioned capacity at one
  and eight writers;
- the lower DBZZ RSS footprint across startup, loaded operations, connections,
  and subscription profiles where the record reports comparable server RSS.

Noise handling is exact: a first apparent loss is rerun. A metric is blocked only
when the same direction repeats; correctness failure invalidates the run before
performance comparison.

The minimum DBZZ-over-Convex margin floors after correctness are:

- operations and connection-work throughput: at least 5x;
- operation and connection-work p95 latency: at most 50% of Convex;
- shared fixed-rate delivery throughput: at least 1.25x;
- fixed-rate and capacity delivery p95 where both systems complete the offered
  work: at most 50% of Convex;
- comparable server RSS: at most 50% of Convex;
- partitioned fixed-rate throughput is offered-rate limited and must equal the
  workload target rather than claim an artificial multiplicative win.

P1 also requires server-confirmed `telemetry=default|disabled` and
`durability=balanced` fields in each DBZZ profile. The balanced profile remains
process-crash consistent but is not a power-loss durability claim.
