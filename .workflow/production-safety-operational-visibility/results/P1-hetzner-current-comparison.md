# P1 — Hetzner current-host comparison

## Outcome

The successful same-host DBZZ/Convex/SpacetimeDB diagnostic completed in 252
seconds (4m12s), exited 0, passed all workload correctness and default DBZZ
telemetry validation, used no swap, and left ports 3311, 3210, 3211, and 5321
free.

- Git: `007a44a94c545e5c0b66cc3135fcee7921285887`
- Host: Linux x86_64, 3 × AMD EPYC-Rome vCPU, 3.7 GiB RAM
- Bun: 1.3.14 (`1.3.14+0d9b296af`)
- Node for Convex CLI: 24.18.0 LTS
- Convex: 1.42.1 local development backend
- SpacetimeDB CLI/client/module: 2.6.1
- Remote log: `/root/dbzz-current-007a44a-scaled.log`
- Log SHA-256: `737d7bd21300546a94d208b2d3af28bd59115f41b6dc57a9845eb37d348ccd45`

The host-specific shape retained all four operation types and all four operation
profiles, then used connection levels 1/100/500, 100 users × 20 query arguments
(2,000 logical subscriptions), and capacity slots 1/8/32. Effective shared
capacity was 1/8/20 because only 20 distinct shared channels exist.

## DBZZ versus Convex margin

- Across the 16 operation/profile cells, DBZZ throughput was 5.11×–20.60×
  higher (13.42× median); Convex p95 latency was 3.88×–95.82× higher (9.75×
  median).
- At 1/100/500 connections, DBZZ query throughput was 13.46×/13.72×/15.90×
  higher and p95 latency was 8.51×/11.95×/15.18× lower.
- Shared subscription capacity throughput was 5.40×/4.22×/3.21× higher at
  1/8/20 writers. Partitioned capacity was 14.17×/8.92×/9.17× higher at
  1/8/32 writers.
- Under saturated operations, Convex used 3.73×–8.81× DBZZ's server RSS. At
  500 connections it used 1,829.9 MiB versus DBZZ's 111.3 MiB (16.44×).
- Fixed-rate shared delivery completed exactly for both systems; DBZZ p95 was
  17.04 ms versus Convex 40.44 ms. Partitioned p95 was 2.61 ms versus 20.65 ms.

These results apply to Convex's local development backend and this small host;
they are not hosted Convex claims.

## SpacetimeDB reference

SpacetimeDB remained the higher-throughput reference for saturated mutations,
server compute, and multi-writer partitioned subscriptions. DBZZ remained
competitive on indexed queries and used materially less RSS at 500 connections
and subscription plateaus. This matches the project's policy: SpacetimeDB is an
excellent-performance reference, not the required target to beat.

## Rejected larger diagnostic

The first 500-user × 50-query current-host attempt finished all three systems
in 381 seconds but was invalid: Convex drove the 3.7 GiB host into 384 MiB swap
and later produced duplicate/unexpected shared-capacity deliveries. No DBZZ or
benchmark correctness workaround was added. The offered shape was reduced
equally for all systems to keep the diagnostic inside the host's real capacity.

## Benchmark implementation

- `90e63b2 perf(bench): shorten full comparison runs`
- `80f5b73 fix(bench): generate DBZZ bindings before runs`
- `007a44a perf(bench): focus current-host comparisons`

The permanent default acceptance keeps all 351 metric paths and all five
telemetry/system legs, but reduces fixed measurement windows from 23m23s to
about 6m13s. `BENCH_COMPARISON=current` intentionally runs only default DBZZ,
Convex, and SpacetimeDB and skips machine-bound historical acceptance/save.
