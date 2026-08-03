# T1 server hot-path audit report

## Outcome

Findings 1–5 were prototyped in production-shaped code and all five produced a measurable or deterministic win. Finding 6 was investigated and is not safely indexable under the current public event contract. No owner-level decision blocked the track, so `BLOCKED.md` was not created.

The implementation keeps global commit publication ordering and all durability boundaries intact. It does not partition publication by table: `OrderedPublication` remains the single commit-order owner, while independent subscriber work is handed off to existing per-listener ordering.

## Experiments and commits

### 1. Serialized event fan-out — fixed

Commit: `e09e90d perf(server): parallelize independent event delivery`

- Removed the duplicate global `eventTail` serialization boundary.
- Scheduled matching deliveries for independent listeners concurrently.
- Kept each listener's delivery, cursor, gap state, and match-failure state on that listener's ordered chain.
- Kept the global `OrderedPublication` reservation/version order unchanged; table partitioning was rejected because publication order is a protocol invariant and was unnecessary for the win.
- Added a two-commit gate test proving one stalled listener does not block a peer while each listener still observes rows in commit order.

Verdict: **clear win**. This removes unrelated-listener and unrelated-commit head-of-line blocking without weakening ordering.

### 2. HTTP body work before authentication — fixed

Commits:

- `dab3c32 perf(server): authenticate before reading HTTP bodies`
- `610d29b test(server): assert auth before malformed body handling`

- Authentication now runs immediately after anonymous ingress admission and trace identification; successful authentication transfers admission ownership before argument parsing.
- Invalid credentials no longer pay body read, UTF-8 decode, JSON parse, or argument validation cost.
- The bounded reader still enforces declared and streaming byte limits and its finite read deadline for authenticated/anonymous-admitted requests.
- Request bytes are decoded incrementally. The reader no longer retains every byte chunk, allocates a second contiguous byte buffer, copies into it, and only then decodes.
- Added boundary tests for invalid credentials with a stalled body and a multibyte UTF-8 code point split across chunks.
- Updated telemetry evidence to require the successful auth span and malformed admission span to share one sanitized trace.

Verdict: **clear win**. Rejected authenticated traffic avoids all proportional body parsing work; valid traffic loses one complete byte-buffer copy.

### 3. Scheduler full-table re-arm scans — fixed

Commit: `8cdfbb1 perf(server): refresh only touched scheduler tables`

- Replaced `scheduledTouched: boolean` with an exact journaled set of scheduled table names.
- Nested mutation rollback now removes only the scheduled-table refresh obligations created inside that savepoint.
- Startup and retry/recovery still scan every scheduled table.
- Ordinary commits query `MIN(scheduleAt)` only for touched scheduled tables, update the cached per-table candidates, then choose the earliest cached deadline.
- Scheduled execution collects every scheduled table changed by its handler and atomic deletion before re-arming.
- Added tests for exact touched-table refresh and nested rollback of refresh metadata.

Verdict: **clear win**. Database statement growth changed from scheduled-table count to touched-table count on the commit path.

### 4. Canonical subscription argument churn — fixed

Commit: `a8653e1 perf(server): retain canonical subscription arguments`

- Each shared query now owns one canonical envelope: frozen decoded arguments, stable encoded arguments, and encoded byte size.
- Revalidation reuses the decoded object and byte count instead of decoding and re-encoding on every evaluation.
- Query subscription setup no longer performs the earlier `decode(encode(value))` snapshot before the reactive layer canonicalizes the same value.
- Auth rotation reuses the retained immutable value.
- Added a test proving caller mutation cannot change retained arguments and repeated evaluations receive the same frozen object and exact byte charge.

Verdict: **clear win**, with an explicit idle-memory tradeoff documented below.

### 5. Existing-row upsert double fetch — fixed

Commit: `3d305d9 perf(server): reuse selected row during upsert`

- Extracted the actual update operation behind an internal `{ id, oldRow, partial }` input.
- Public `patch(id, partial)` still performs and owns its lookup.
- Existing-row `upsert` passes its already-decoded row directly to the update operation.
- The outer upsert remains the sole statement-observation owner.
- Added an exact boundary assertion that an existing-row upsert executes one `SELECT`, not two.
- Moved `assertMutationAccess()` to the upsert entry boundary, before its key lookup.

Verdict: **clear but modest latency win**. The deterministic statement-count reduction is material even though SQLite makes the one-row microbenchmark improvement smaller than the other experiments.

### 6. O(listeners-per-table) event predicate matching — investigated only

The current API is not indexable:

- `EventSubscriptionDefinition.matches` is an arbitrary synchronous `(row, args) => boolean` callback.
- It may perform computations that cannot be represented as an equality/range constraint and may close over application state.
- Event tables are ephemeral and explicitly reject `.index(...)`; their storage index declarations cannot provide listener candidate keys.
- The runtime receives no predicate AST, declared key extractor, or constraint metadata. Inspecting JavaScript function source would not be sound.

A future indexed design would require an explicit public contract such as paired canonical key extractors for event rows and subscription arguments, with the arbitrary matcher retained as a fallback. That is a public API change and was prohibited in this track. The remaining matching cost is therefore honestly `O(listeners for the event table)`.

Verdict: **refuted under the current API; needs a separate breaking API design if production evidence justifies it**.

## Measurement evidence

All before/after measurements ran on the same machine with Bun `1.3.14`. The committed harness is `bench/t1-hotpath-prototype.ts`; every profile uses 3 warmups and 20 measured trials. These are focused prototype measurements, not release benchmark evidence.

| Operation and load shape | Base | Head (`610d29b`) | Net result |
| --- | ---: | ---: | ---: |
| Event fan-out: 100 matching listeners, 1 ms async delivery each, one commit | p50 114.537 ms; p99 115.566 ms | p50 1.339 ms; p99 1.713 ms | p50 85.5× faster |
| Unrelated event commit behind one 10 ms slow listener | p50 10.857 ms; p99 11.542 ms | p50 0.0226 ms; p99 0.0743 ms | head-of-line wait removed |
| Query revalidation: one shared query, 1,000 argument items, 500 sequential invalidations | p50 14.035 ms/trial; 35,625/s | p50 1.715 ms/trial; 291,609/s | 8.19× throughput |
| Invalid HTTP auth: real server, 64 KiB body, 100 requests, concurrency 10 | p50 5.240 ms/trial; 19,084/s | p50 2.280 ms/trial; 43,851/s | 2.30× throughput |
| Scheduler re-arm: 100 scheduled tables, one touched table, 100 sequential re-arms | 10,000 `SELECT MIN`; p50 33.698 ms | 100 `SELECT MIN`; p50 3.832 ms | 100× fewer SQL statements; 8.79× faster |
| Existing-row upsert: one durable row, 1,000 sequential upserts | 2,000 `SELECT`; p50 51.639 ms; 19,365/s | 1,000 `SELECT`; p50 45.527 ms; 21,965/s | 50% fewer reads; 13.4% throughput gain |

Load/durability boundaries:

- Event and query profiles exercise the real in-memory reactive/publication coordinator. The event failure shape is one slow listener; publication capacity and subscriber sink queues remain bounded.
- HTTP uses a real local server and invalid verifier result; no application transaction starts.
- Scheduler uses a real SQLite database with 100 scheduled tables and no due row; startup recovery performs the initial complete scan before incremental measurements.
- Upsert uses a real SQLite database and autocommitted updates to one existing row.
- There is no background polling added by any experiment.

## Performance-vector gains and tradeoffs

### Gains

- Useful latency/throughput: every implemented target improved, with the largest gains in fan-out, revalidation, and scheduler re-arm.
- Idle cost: unchanged for event, HTTP, query, and upsert; scheduler adds no timer or polling cycle.
- Scale shape: event delivery no longer grows wall time as the sum of independent listener delays; scheduler SQL work is proportional to touched scheduled tables; subscription serialization work is no longer proportional to argument size on every invalidation.
- Tail behavior: one slow event consumer no longer poisons unrelated listeners or commits. Existing bounded sink/publication outcomes remain the saturation boundary.
- Startup/recovery: the scheduler deliberately retains its complete recovery scan.
- Durable correctness: commit publication, SQLite transactions, mutation savepoints, write-key emission, full-text bookkeeping, and scheduler deletion+handler atomicity are unchanged.

### Losses and limits

- Concurrent event handoff owns more live promises at once than serial fan-out. The count is proportional to matching listeners and bounded publication backlog; this buys the measured latency win and does not create polling or unbounded history.
- Canonical shared queries retain both encoded and decoded arguments for their lifetime. This adds decoded-argument idle RAM per distinct shared query in exchange for removing repeated transient decode/encode allocations. Shared-entry count and result/history bytes remain bounded, but argument bytes are not currently a separately exposed retained-memory gauge.
- Authentication now precedes the body read deadline. A slow verifier plus a slow valid body can hold anonymous ingress admission for the sum of those bounded phases rather than body time followed by auth under the old order. Invalid credentials terminate earlier, and authenticated admission is transferred before body parsing.
- Invalid credentials now win over malformed/oversized application bodies at the application call boundary. Transport-level rejection may still occur before AckerDB for bodies exceeding Bun's configured transport limit. This is the intentional security-first outcome.
- Incremental scheduler state retains one nullable number per scheduled table and scans that small in-memory map to choose the earliest cached deadline. It eliminates the expensive per-table SQL scan but is not a heap.
- Event predicate CPU remains linear because finding 6 is not indexable without a new API.
- The prototype harness adds 424 benchmark lines and is deliberately marked throwaway; it exists on this audit branch as the primary measurement source.

## Verification

Passing commands:

- `bunx tsc --noEmit`
- `bun packages/cli/src/commands/main.ts codegen bench/ackerdb-app`
- `bunx tsc -p bench/tsconfig.json --noEmit`
- `bun test /Users/pedrooscar/personal/dbzz-worktrees/t1-hotpath/packages/server/test` — 978 passed, 0 failed, 10,096 expectations across 79 files

Focused boundaries also passed during development:

- reactive ordering: 32 passed
- HTTP transport: 55 passed
- runtime plus mutation scope: 77 passed
- database access: 27 passed
- telemetry auth: 1 passed

No test was removed, weakened, or skipped.

## LoC and diff evidence

Before this report, `git diff --stat origin/main` covered 11 files with 816 insertions and 141 deletions:

- production source: +200 / -138, net +62
- tests: +192 / -3, net +189
- throwaway benchmark harness: +424 / -0

The production increase is principally explicit per-listener ordering state, exact scheduler-table journaling/cache ownership, and the canonical envelope. The benchmark dominates the total branch LoC and is not production code.

Including this 182-line report, the final branch summary is 12 files with 998 insertions and 141 deletions.

Commits before the report:

1. `7928c94` benchmark harness
2. `e09e90d` event delivery
3. `a8653e1` canonical query arguments
4. `dab3c32` HTTP authentication/body handling
5. `8cdfbb1` scheduler refresh
6. `3d305d9` upsert reuse
7. `610d29b` telemetry boundary assertion

## Blockers

None. No external dependency, secret, owner policy, or unavailable service was required.

## New audit discoveries

1. Simply replacing the serial listener loop with `Promise.all` would have created duplicate/stale event cursors across overlapping commits. Cursor advancement, gap recovery, and match-failure state had to move onto the per-listener sequence; the handoff identified concurrency but not this state race.
2. Upsert previously reached its unique-key `SELECT` before `assertMutationAccess()` ran in the child insert/patch method. Moving the guard to upsert entry closes that nested-mutation boundary before any database access.
3. The scheduler's boolean write metadata could not support incremental refresh and would lose nested rollback ownership if naively replaced with an ordinary set. Exact table names needed the same journal/checkpoint semantics as write keys.
4. The telemetry auth test intentionally exposed the old body-before-auth ordering. It now proves auth-first malformed-body traces rather than merely accepting the changed verifier call.
