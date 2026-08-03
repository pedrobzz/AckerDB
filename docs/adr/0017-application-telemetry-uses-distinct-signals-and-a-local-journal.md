---
status: accepted
---

# Application telemetry uses distinct signals and a local journal

Application logs and analytics events are distinct telemetry signals that share
one recursive value model and one framework-owned local journal. Provider
adapters translate big integers and bytes when their target has no native
representation, and each exporter receives only the signal kinds it can
represent honestly without inventing the other signal's semantics.

`ctx.log.debug|info|warn|error` registers a bounded application log record
synchronously and without exposing logging failures to application code. Its
portable authoring shape is one message plus optional structured metadata rather
than console-style variadic values. Application logs are a diagnostic signal;
registration captures the record's timestamp and process-generation sequence at
the call site; a single bounded background path may persist multiple records
together but never replaces those facts with its later write time or reorders
the process-wide registration sequence. Each method returns `void`, so
application code never awaits persistence. Logging does not participate in
application transactions, so rollback cannot erase an accepted record. A process
crash may lose the queued tail, saturation may drop records observably, and
persistent storage failure makes the runtime unhealthy; these trade-offs keep
ordinary function execution fast without unbounded memory, per-log transactions,
or a false lossless guarantee. Queries log each actual handler execution,
including reactive re-evaluations whose result is unchanged; shared query demand
logs once for the shared execution rather than once per subscriber.

The logging capability is present everywhere application or Plugin code receives
a context: policies, queries, mutations, transactions, procedures, SSE,
realtime, services, system runs, and Plugin functions. Every record receives
call-time timestamp, process-generation sequence, function address and kind,
and available trace/span/request correlation. Logs never receive user Identity,
credentials, claims, arguments, or results automatically, and author metadata
cannot replace reserved context. Registration is total and non-throwing under
explicit finite byte, depth, and collection bounds. Oversized content is
retained with truncation marked; malformed runtime values become safe markers.
Saturation may drop a whole record with an observable counter, but it never
permits unbounded allocation or blocks application execution.

`ctx.analytics.track(event, properties?)` records named product behavior rather
than diagnostic severity. Analytics exists only inside mutation and transaction
contexts; procedures, services, and system runs must open `ctx.tx` to track,
while queries cannot track because reactive and shared query execution would
manufacture product events unrelated to distinct user actions. An event is
staged in its current mutation scope, merges through each successful nested
scope, becomes exportable only after the top-level transaction commits, and is
discarded by `Err`, throw, or rollback. Idempotency replay does not emit the
event again because it does not execute the mutation handler again. User and MCP
principals contribute their durable AckerDB Identity automatically; anonymous,
workload, and system principals contribute none. AckerDB never fabricates an
identity or exports raw issuer, subject, or claims, and an exporter that
requires identity skips an identity-less event with an observable count.

Both signals persist through one dedicated framework-owned SQLite journal
outside the application database and its transactions. The journal has
configurable finite storage, evicts oldest records first, survives application
schema changes, and is excluded from application backup and restore. Failure of
this local persistence boundary makes the runtime unhealthy because it cannot
honestly accept new records. Each telemetry exporter consumes committed journal
batches in order through its own bounded state. A slow or unavailable provider
cannot block application work, local registration, or another exporter; it
produces bounded console warnings or errors plus health telemetry. A prolonged
outage may outlive journal retention and lose unexported records, which remains
visible through provider and eviction drop counts.
