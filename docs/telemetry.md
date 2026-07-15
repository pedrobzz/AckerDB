# Telemetry

DBZZ telemetry is enabled by default, bounded, privacy-filtered before
retention, asynchronous, and fail-open for application work. It produces a
backend-neutral schema rather than depending on one observability vendor.

This document describes the exported `Telemetry` contract and the signals the
runtime actually emits. Schema vocabulary and automatic coverage are listed
separately; a stage name alone is not a claim that every possible boundary is
instrumented.

## Enable, disable, and configure

The CLI accepts an exact `DBZZ_TELEMETRY` value:

```sh
DBZZ_TELEMETRY=enabled dbz start ./apps/server   # default
DBZZ_TELEMETRY=disabled dbz start ./apps/server
```

Programmatic `Runtime` construction accepts `telemetry: false`, an existing
`Telemetry` instance, or `TelemetryOptions`. The options are:

```ts
interface TelemetryOptions {
  enabled?: boolean;
  limits?: Partial<TelemetryLimits>;
  exporter?: TelemetryExporter;
  localSink?: ((safeJsonLine: string) => void) | false;
  now?: () => number;
  scheduler?: TelemetryScheduler;
}
```

`Telemetry`, its schema constants, `TelemetryLimits`, and all record, option,
aggregate, and health snapshot types are public exports of `@dbzz/server`.
`enabled: false` allocates no queue or timer and returns frozen singleton zero
snapshots. Passing an existing `Telemetry` instance makes the caller its owner:
`Runtime.drain()` flushes it but does not stop or fully drain that shared
instance.

When Runtime constructs Telemetry from `TelemetryOptions`, it starts with the
`ServiceLimits.telemetry` values in `RuntimeOptions.limits` and then applies
`TelemetryOptions.limits` as field-level overrides. This precedence includes
`sampleIntervalMs`: Runtime schedules its sampler from the resulting
`Telemetry.sampleIntervalMs`. A caller-supplied `Telemetry` instance instead
keeps its own effective limits. The CLI exposes only the exact enabled/disabled
switch, not numeric telemetry tuning.

The default local sink is `console.log`. Telemetry enqueues every valid event
and every retained diagnostic span as a safe schema-v1 JSON line, subject to
the bounded local queue and its drop accounting. With a positive threshold,
fast successful operation spans update aggregates immediately, but their
individual diagnostic records are printed or exported only if their tracked
trace is later promoted. Changed cumulative aggregates remain externally
visible through protected status and configured exporters. Metrics are
retained/exportable but not printed.
`localSink: false` suppresses local lines. No remote exporter is installed by
the CLI, so production export requires a programmatic `TelemetryExporter`
whose `export(records)` method may target the backend of the operator's choice.
The callback also receives a second optional cumulative aggregate snapshot when
the bounded aggregate state changed: `export(records, aggregates?)`.

## Default bounds

| Setting | Default |
| --- | ---: |
| `maxRecords` for each retained/local/staged pool and active + completed trace state | 2,048 |
| `maxBytes` for each retained/local/staged byte pool | 4 MiB |
| metric/aggregate series | 2,000 |
| records per exporter batch | 512 |
| exporter batch interval | 1,000 ms |
| exporter timeout | 5,000 ms |
| record age and completed-decision window | 5 minutes |
| trace/span diagnostic threshold | 100 ms |
| runtime sample interval | 1,000 ms |

All telemetry limit values are positive integers except `slowOperationMs`,
which may be zero, and `maxBatchRecords <= maxRecords`. The retained export
queue, deferred local-output queue, staged-span pool, and trace-state pool are
independently bounded; `maxRecords` and `maxBytes` do not describe one shared
pool. Ordinary retained/local count or byte pressure evicts the oldest entry
and increments its visible drop counter. Expired and individually oversized
records are also counted. Metric cardinality beyond the configured bound folds
into the explicit
`telemetry.cardinality_overflow{resource="telemetry",overflow=true}` series.

### Whole-operation tail retention

Every valid span updates its bounded aggregate immediately. For a tracked
Runtime operation with `slowOperationMs > 0`, an ordinary fast successful span
is also sanitized and staged as a diagnostic record while the whole-trace
decision remains open. A trace is promoted when any span fails, one span meets
the threshold, the sum of its observed span durations meets the threshold, or
the operation's wall-clock duration meets the threshold when the trace
finishes. A `failure` event, any non-`info` event, a non-`ok` event outcome, or
a failed lifecycle event also promotes its known trace.

Promotion moves every still-staged span into the normal retained/local path and
retains later spans directly while that active/completed trace state remains
known. A lease-eligible outbound frame captured by an active trace claims one
delivery lease. Once the operation has finished and terminal delivery
finalization releases its last known lease, a fast successful trace settles
immediately and discards its staged diagnostics without export or local output.
This cleanup is independent of the deliberately lossy delivery-observation
queue. `retentionMs` is the bounded fallback only when a completed decision's
delivery was abandoned or never claimed; expiry or early eviction then makes a
late span use its own failed/slow decision without recovering discarded
diagnostics. Failed or slow delivery promotes the trace before releasing the
lease.

Setting `slowOperationMs` to `0` retains every valid span immediately and
allocates no active, completed, or staged trace state. A span outside an
admitted trace lifecycle also uses the individual failed/slow rule; failure to
admit bounded trace state therefore never creates an unbounded fallback.
Events and metrics enter ordinary retention independently of the trace
threshold, and metrics additionally use the cardinality bound.

Active and completed trace states together are capped at `maxRecords`; staged
spans are separately capped at `maxRecords` and `maxBytes`. A new trace first
evicts an older completed decision under capacity pressure; `activeOverflow`
is recorded only when no completed slot can be reclaimed. Staging pressure
likewise prefers releasing an older completed trace's staged diagnostics before
dropping the new staged span. Completed decisions also expire after
`retentionMs`.

`Telemetry.snapshot().traceRetention` exposes the effective trace/staging
limits, current active/completed/staged counts and bytes, promotion and discard
totals, and these nested drop categories:

| Drop field | Meaning |
| --- | --- |
| `activeOverflow` | A trace lifecycle was not tracked because every bounded trace slot was active. |
| `stagedOverflow` | A sanitized span could not enter the bounded staged record/byte pool. |
| `decisionOverflow` | A completed decision was evicted early to admit newer trace work. |
| `expiredDecisions` | A completed decision reached its finite classification window. |
| `drain` | An active or completed trace state was released by terminal telemetry drain. |
| `invalid` | A trace lifecycle call was invalid or conflicted with existing state. |

`promotedTraces` counts whole-trace promotions. `discardedTraces` counts
unpromoted trace decisions released without retention, and `discardedRecords`
counts their staged diagnostics. These trace-retention counters are separate
from the top-level retained/export `dropped` counters and
`localSink.dropped`.

Exporter calls receive at most `maxBatchRecords` plus the latest bounded
cumulative aggregate snapshot only when it changed. Calls have a finite timeout
and do not run on the database commit or client-delivery path. Synchronous
throws, rejected promises, timeout scheduling failure, and stalled exporters
are contained and reflected in exporter health/drop counters. Failed retained
record batches are not retried; a failed aggregate snapshot remains pending and
the next export sends the latest cumulative snapshot, so updates cannot be lost
or double-counted by an ambiguous delta. `aggregateSnapshotPending` remains
true while the current cumulative state still needs a confirmed export, while
`exportedAggregateSnapshots` and
`failedAggregateSnapshots` are cumulative attempt outcomes. Local output is also
deferred and bounded by the same record, byte, and retention-age limits.
`Telemetry.drain(deadlineAtMs)` stops periodic and
deferred work, releases every active/completed trace decision without
force-promoting unpromoted staging, and works through the already retained
records in bounded batches and local lines captured at drain start. One
absolute deadline, expressed in the configured `now` clock's millisecond
domain, bounds all that work. It never rejects; deadline/untouched remainder is
counted under `dropped.drain` or `localSink.dropped.drain`, while released trace
states use `traceRetention.dropped.drain` and exporter/local failures retain
their own counters. A telemetry failure cannot extend application shutdown
indefinitely, and drain is not a guarantee that every diagnostic was exported.

## Privacy boundary

Telemetry records are constructed from allowlisted scalar metadata before they
enter the staged trace pool, retained queue, or local sink. Default records
contain no credential/token/cookie/header fields, raw identity claims, raw
arguments, results, event rows, or literal SQL. Passing such extra properties
at runtime does not copy them into a record.

Credential-verification spans and failure events contain only timing, bounded
operation/function/resource/outcome fields, sanitized correlation IDs, and an
error class when applicable. They never contain the Authorization header,
bearer token, verified principal or claims, raw call arguments/results, SSE
chunks, verifier error message, or internal cause.

Correlation IDs must match `[A-Za-z0-9_-]{1,128}`; names are similarly bounded
and sanitized. The runtime hashes a client session identifier before using it
as a connection correlation value. That hash is correlation metadata, not an
authentication credential or a promise of anonymity. Up to 32 trace links are
accepted. Metric labels are restricted to bounded `operation`, sanitized
function name, `outcome`, and `resource`; high-cardinality request, connection,
mutation, commit, and subscription IDs belong only in trace/event context.

There is no payload-capture mode in the current API. Operators should treat
function names and correlation IDs as operational metadata and still apply
normal access control and retention policy to exported telemetry.

## Schema version 1

Every exported record has `schemaVersion: 1`, `timestampMs`, and one of three
`kind` values. Records and nested labels/links are frozen.

Span and event records may flatten these sanitized correlation fields at the
top level: `traceId`, `spanId`, `parentSpanId`, `requestId`, `connectionId`,
`mutationId`, `commitId`, and `subscriptionId`. Their optional `links` field is
a readonly array of `{ traceId, spanId }`. Metric records deliberately have no
correlation-ID fields.

Query invalidation telemetry follows the same dependency index as reactivity.
Each commit with retained shared-query state and a nonempty write set receives
one commit-level match span: `dependencyCount` is the number of written
dependency keys considered and `resultCount` is the number of affected shared
queries. A zero `resultCount` means no retained query matched.
The per-query queue, evaluation, and changed-or-unchanged spans identify the
affected functions without duplicating match timing. Unrelated query state is
never enumerated merely to produce telemetry, so instrumentation work scales
with changed dependencies and actual revalidation rather than every live query.

### Span record

```ts
interface TelemetrySpanRecord {
  schemaVersion: 1;
  kind: "span";
  timestampMs: number;
  operation: TelemetryOperation;
  stage: TelemetryStage;
  outcome: TelemetryOutcome;
  durationMs: number;
  function?: string;
  statement?: string;
  resource?: TelemetryResource;
  sizeBytes?: number;
  rowCount?: number;
  resultCount?: number;
  replayed?: boolean;
  dependencyCount?: number;
  postCommit?: boolean;
  // optional common correlation fields and up to 32 links
}
```

### Event record

```ts
interface TelemetryEventRecord {
  schemaVersion: 1;
  kind: "event";
  timestampMs: number;
  name: "lifecycle" | "overload" | "exporter_degraded" | "failure";
  level: "info" | "warn" | "error";
  operation?: TelemetryOperation;
  stage?: TelemetryStage;
  outcome?: TelemetryOutcome;
  function?: string;
  resource?: TelemetryResource;
  lifecycleState?: "starting" | "ready" | "draining" | "stopped" | "failed";
  errorClass?: string;
  // optional common correlation fields and links
}
```

### Metric record

```ts
interface TelemetryMetricRecord {
  schemaVersion: 1;
  kind: "metric";
  timestampMs: number;
  name: string;
  value: number;
  unit: "count" | "milliseconds" | "bytes" | "ratio" | "gauge";
  labels: {
    operation?: TelemetryOperation;
    function?: string;
    outcome?: TelemetryOutcome;
    resource?: TelemetryResource;
    overflow?: true;
  };
}
```

`TelemetryOperation` is one of `query`, `mutation`, `procedure`, `sse`,
`transaction`, `scheduled`, `subscription`, `backup`, `restore`, or
`lifecycle`. `TELEMETRY_STAGES` is exactly:

```text
admission     auth          policy        handler       execution
fetch         statement     storage       commit        rollback
publication   match         evaluation    changed       unchanged
encoding      fanout        queue         delivery      export
```

`TelemetryOutcome` is `ok` plus the finite Protocol 2 failure codes, and
resources match the Protocol 2 vocabulary documented in
[Operations](operations.md#typed-outcomes). `statement` is a sanitized logical
summary such as `messages.collect`, never literal SQL.

`aggregateSnapshot()` exposes bounded span aggregates keyed by low-cardinality
operation/stage/outcome/function/resource dimensions. Every valid span updates
aggregates before tail retention is applied; a fast successful span below
`slowOperationMs` remains aggregate-only unless its trace is later promoted.
Excess aggregate keys fold into an explicit overflow series rather than growing
without bound. `Runtime.status().telemetryAggregates` exposes this same snapshot
through protected `/status`, so default CLI operators do not need application
code to observe aggregate-only work.

## Automatic runtime signals

When telemetry is enabled, current automatic span coverage is:

| Boundary | Operations and stages |
| --- | --- |
| Runtime operation ownership | A tail-decision lifecycle opens before `admission` for query, mutation, procedure, SSE, scheduled, and subscription work. Ordinary operations finish it after their Runtime finalizer. An SSE handler may settle earlier, but its admission and trace remain owned until the Runtime producer reaches terminal acknowledgement, cancellation, or terminal-grace force close. A fallback outer `handler` span is emitted only when the path performs no registered function invocation. |
| HTTP credential verification | Procedure and SSE calls emit one `auth` span around credential parsing, verification, and lease acquisition. A successfully parsed call keeps the same trace ID and request/function correlation when Runtime claims the operation. |
| WebSocket credential verification | Hello, refresh, and sign-out attempts emit separate `lifecycle`/`auth` traces with `connection` resource, hashed connection correlation, and the hello/attempt identifier. |
| Function invocation | `auth`, `policy`, and `handler` for top-level and directly nested function calls, with parent/child span relationships. Here the Runtime `auth` span is invocation principal/argument validation, distinct from transport credential verification. |
| Outbound fetch | `fetch` around `globalThis.fetch` used inside a traced runtime operation. It records duration/outcome only—never URL, headers, or body; a fetch rejected inside a writer transaction is observed too. |
| Database API | `statement` for `ctx.db` reads/writes and scheduler reads, using logical `table.operation` summaries and optional row counts. |
| SQLite transaction path | Reader `queue`, `storage`, `encoding`, `commit`, and `rollback`; every executed writer mutation, scheduled handler, or `ctx.tx` emits exactly one `execution` span around its application work and transactional finalizer, plus `queue`, full pre-commit `storage`, result `encoding`, `commit`/`rollback`, and pre/post-commit `publication`. Replayed mutations emit idempotency `storage` but no `execution`. |
| Ordered realtime | `match`, `evaluation`, `changed`, `unchanged`, `queue`, `fanout`, and logical subscriber `delivery`, with dependency/result/byte counts when known. |
| WebSocket and SSE transport | `encoding`, `queue`, and `delivery` spans with bytes, duration, outcome, and `outbound`/`sse` resource. WebSocket `delivery` observes release from Bun's buffered-byte ownership (including delayed `onDrain`). SSE retains the frame's captured observer until a valid cumulative receiver acknowledgement releases it, or reports cancellation/terminal timeout as the delivery outcome. Terminal failures also emit a `failure` event. Capabilities, proofs, and chunk values are never recorded. |
| HTTP procedure response | `procedure` `encoding` followed by `delivery`, both with resource `operation`, the original trace/request/function correlation, and exact encoded response bytes. `delivery` ends when the responder returns the constructed Bun `Response`; it is an encoded-response handoff, not proof of socket, kernel, or network completion. |
| CLI backup and restore | Standalone `dbz backup` and `dbz restore` commands emit one `backup`/`restore` `storage` span with duration, sanitized outcome, artifact byte count, and commit correlation when successful; failures also emit one sanitized `failure` event. The command drains this bounded telemetry before printing its final report, and `DBZZ_TELEMETRY=disabled` removes it exactly. |
| Telemetry export | `exporter_degraded` events at the `export` stage; exporter attempts and durations are also metrics/status fields. |

### Credential verification correlation

For `POST /api/call` and `POST /api/sse`, Serve opens one tail-decision trace
before request parsing. Once Protocol 2 parsing succeeds, the function address
and request ID identify it. The credential `auth` span then covers
Authorization parsing, verifier work (including any verifier-owned JWKS work),
and credential-lease acquisition. On success, Runtime claims that same trace,
so authentication and the later admission, invocation, encoding, and delivery
records share request/function correlation.

An authentication failure after a call was parsed ends with an `auth` failure
span and one structured `failure` event; Runtime is never entered. A malformed
body, ingress rejection, or other failure before the call is identified instead
gets an `admission` failure span/event under `http.procedure` or `http.sse`,
without a fabricated request ID. Failure events expose the sanitized outcome,
resource, function/correlation fields, and error class—not the error message or
cause.

WebSocket hello, bearer refresh, and anonymous sign-out verification each own a
separate `lifecycle` trace with function `ws.hello`, `ws.refresh`, or
`ws.sign-out`. `connectionId` is the SHA-256/base64url digest of the client
session ID; `requestId` is `hello` or the string form of the numeric auth
attempt ID. A pending attempt finishes on verification success/failure,
supersession, or session close, and non-`ok` completion emits one correlated
sanitized `failure` event. The digest is operational correlation, not a promise
of anonymity.

Trace ownership remains singular across the HTTP boundary. A procedure trace
finishes after the encoded `Response` handoff. An SSE trace and its receiver
capability remain owned until terminal acknowledgement, cancellation, or
terminal-grace force close, so delayed delivery observations retain the frame's
original trace owner. A valid acknowledgement proves participation by the
capability holder, not durable application processing. HTTP handoff still proves
neither socket, kernel, network, nor peer receipt.

When telemetry is disabled, HTTP trace creation returns before allocating IDs
or trace state and `DbzzServer` does not attach the WebSocket auth observer. The
authentication paths still run, but this instrumentation creates no auth
records, trace decisions, queue entries, or timers.

Lifecycle, overload, scheduler, runtime-operation, reactivity, terminal-stream,
and exporter failures emit structured events. Every valid span updates bounded
aggregates immediately. Runtime-owned operation spans follow the whole-trace
decision above; spans without admitted trace state use their individual
failed/slow result. The default local sink is offered retained events and
diagnostic spans, subject to its bounded queue, and is not offered metrics.

Runtime trace/span IDs are generated internally. A traced session operation
adds the hashed connection ID and, when applicable, request, mutation, commit,
and subscription IDs. Each WebSocket frame captures its delivery owner before
encoding and retains that owner through queueing and a delayed Bun `onDrain`, so
query, mutation, error, and subscription frames preserve their originating
correlation instead of inheriting whichever operation happens to be active
later. Terminal delivery finalization classifies the trace and releases that
frame's lease even when the diagnostic observation is dropped, cannot be
scheduled, or fails. Healthy completed traces therefore settle after their last
known physical delivery; only abandoned or unclaimed completed decisions remain
available for the finite `retentionMs` fallback. Session-owned control frames
emitted outside an application operation receive a distinct `lifecycle` trace
rather than reusing the preceding application trace. Child spans retain the
trace ID and parent span ID. Other signals emitted without a current operation
get a new trace context; operators must not assume every asynchronous record
belongs to one end-to-end trace.

Transport observation itself is bounded and fail-open. Each instrumented
WebSocket sink or SSE producer retains at most 256 pending delivery observations
before its microtask drain. Overflow is summarized by the exact
`delivery.observations_dropped` metric (labeled as `subscription`/`outbound` or
`sse`/`sse`) on the next retained observation. Delivery never awaits the
observer, and observer throws or rejected promises do not affect delivery.

### Periodic runtime metrics

The sampler runs every `sampleIntervalMs` (1 second by default). It emits these
exact metric names:

- work and subscription state: `runtime.connections`, `runtime.operations`,
  `runtime.operation_callers`, `runtime.sse_streams`, `runtime.subscriptions`,
  `runtime.subscription_entries`, `runtime.subscription_result_bytes`,
  `runtime.subscription_history_items`, and
  `runtime.subscription_history_bytes`;
- queues and bounded buffers: `runtime.read_queue_items`,
  `runtime.read_queue_bytes`, `runtime.read_queue_age`,
  `runtime.write_queue_items`, `runtime.write_queue_bytes`,
  `runtime.write_queue_age`, `runtime.revalidation_active`,
  `runtime.revalidation_queue_items`, `runtime.revalidation_queue_bytes`,
  `runtime.revalidation_queue_age`, `runtime.publication_items`,
  `runtime.publication_bytes`, `runtime.publication_age`,
  `runtime.auth_capture_bytes`, and `runtime.sse_outbound_bytes`;
- listener transport state: `runtime.transport_websocket_connections`,
  `runtime.transport_websocket_pre_hello`,
  `runtime.transport_websocket_rejections`,
  `runtime.transport_websocket_outbound_bytes`,
  `runtime.transport_http_ingress`, `runtime.transport_http_fairness_keys`,
  `runtime.transport_http_global_rejections`,
  `runtime.transport_http_fair_share_rejections`,
  `runtime.transport_sse_ack_ingress`, and
  `runtime.transport_sse_ack_noops`;
- storage and recovery: `runtime.database_bytes`, `runtime.wal_bytes`,
  `runtime.checkpoint_completed`, `runtime.checkpoint_busy`,
  `runtime.checkpoint_total_frames`, `runtime.checkpoint_checkpointed_frames`,
  `runtime.checkpoint_residual_frames`, `runtime.checkpoint_duration`,
  `runtime.checkpoint_age`,
  `runtime.recovered_from_crash`, `runtime.mutation_replay_records`, and
  `runtime.mutation_replay_bytes`;
- telemetry self-health: `runtime.telemetry_queue_records`,
  `runtime.telemetry_queue_bytes`, `runtime.telemetry_queue_age`,
  `runtime.telemetry_local_queue_records`,
  `runtime.telemetry_local_queue_bytes`, `runtime.telemetry_export_attempts`,
  `runtime.telemetry_export_failures`, `runtime.telemetry_export_timeouts`,
  `runtime.telemetry_export_duration`, and `runtime.telemetry_drops`; and
- process health: `runtime.rss_bytes`, `runtime.cpu_cores`, and
  `runtime.event_loop_drift`.

`runtime.connections` is also emitted immediately when a runtime session opens
or closes. `runtime.checkpoint_completed` is 0 until the current engine
instance completes a checkpoint invocation, then 1. Its busy, total,
checkpointed, residual, and duration metrics are zero while that report is
absent and then mirror `runtime.storage.lastCheckpoint` in protected `/status`.
The detailed report is intentionally process-local: after restart,
`runtime.checkpoint_completed` returns to 0 while `runtime.checkpoint_age` can
remain nonzero because it derives from the persisted `lastCheckpointAtMs`
historical timestamp. `runtime.recovered_from_crash` is also a 0/1 gauge.
`runtime.recovered_from_crash` records what the current engine open observed and
remains stable for that process. `runtime.telemetry_drops` sums the top-level
record/export drop categories; local-sink and trace-retention drops remain
separately visible in the telemetry snapshot.

Protected `/status` includes `Telemetry.snapshot()` and the sibling
`runtime.telemetryAggregates` cumulative snapshot: enabled state, queued
records/bytes/age, metric-series count, nested trace-retention and local-sink
health, top-level drop totals, and exporter
configuration/in-flight/attempt/failure/timeout/delivery timestamps, including
pending/exported/failed aggregate snapshots. It does not contain queued or
staged record payloads.

## Current telemetry limitations

- HTTP credential verification has one `auth` span, but Authorization parsing,
  JWT/JWS verification, and JWKS network/cache phases are not separate child
  spans. Successful pre-Runtime body parsing/ingress and WebSocket upgrade/frame
  parsing also lack separate spans; malformed pre-Runtime HTTP calls get one
  `admission` failure span/event.
- `fetch` coverage applies to `globalThis.fetch` while a traced runtime scope is
  active; other HTTP clients are not automatically observed.
- There is no bundled OTLP/OpenTelemetry SDK exporter, remote endpoint config,
  dashboard, or durable telemetry spool. The exporter callback is the current
  backend-neutral boundary.
- The default CLI configuration has local safe JSON output but no remote
  exporter. Retained records are in memory and disappear on process loss.
- CLI backup/restore telemetry is local JSON only. It does not yet share a
  remote exporter configuration or a persistent trace with the fresh-process
  verification child.
