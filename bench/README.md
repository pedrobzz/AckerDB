# dbzz vs Convex — local benchmark

Same machine, same workload, both systems through their real client SDKs
over WebSocket, fresh state per run.

- **dbzz**: `dbz start bench/dbzz-app` (Bun + bun:sqlite, WAL), driven by
  `@dbzz/client`.
- **Convex**: `convex dev` anonymous local deployment (convex-local-backend,
  state wiped at `bench/convex-app/.convex/local` before each run), driven by
  `ConvexClient` from `convex/browser`. Backend process identified by its
  state path in the command line, never by name alone.

Workload (see `workload.ts`):

1. **Mutations** — 1,500 sequential awaited inserts (round-trip latency).
2. **Subscription latency** — subscribe to a top-20-by-seq reactive query,
   then 100 rounds of insert-with-monotonic-seq → time until the
   subscription observes it (monotonic seq guarantees every round changes
   the result; unchanged results are legitimately never pushed).
3. **RSS / CPU** — `ps` on the server process: RSS at idle (right after
   startup) and after the workload; cumulative CPU time consumed by the
   workload.

Run it: `bun bench/run.ts` from the repo root.

## Results — 2026-07-12, Apple Silicon (macOS), Bun 1.3.14, convex 1.42.1

| metric | dbzz | convex | dbzz advantage |
|---|---|---|---|
| mutations/sec (sequential round-trips) | 7,852 | 521 | **15.1x** |
| mutation mean latency (ms) | 0.13 | 1.92 | **15.1x** |
| subscription update p50 (ms) | 0.29 | 7.62 | **25.9x** |
| subscription update p95 (ms) | 0.70 | 10.43 | **15.0x** |
| idle RSS (MB) | 45.0 | 75.2 | **1.7x** |
| RSS after workload (MB) | 64.6 | 250.5 | **3.9x** |
| server CPU time for workload (s) | 0.23 | 4.45 | **19.3x** |

Notes on fairness:

- Both sides pay their full stack: dbzz mutations include the exactly-once
  idempotency record written inside the same transaction; Convex runs its
  standard local backend (no cloud latency involved).
- Sequential awaited mutations measure round-trip latency, not maximum
  pipelined throughput, for both systems equally.
- The Convex local backend is a dev-oriented build; production Convex is a
  hosted service and would add network latency on top.
