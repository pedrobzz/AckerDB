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

Both signals persist through one dedicated framework-owned SQLite sidecar
outside the application database and its transactions. The sidecar has
configurable finite storage, survives application schema changes, and is
excluded from application backup and restore. Each telemetry exporter consumes
committed journal batches in order through its own bounded state. A slow or
unavailable provider cannot block application work, local registration, or
another exporter; it produces bounded console warnings or errors plus health
telemetry. A prolonged outage may outlive retention and lose unexported records,
which remains visible through provider and eviction drop counts.

## Amendment: the sidecar holds every observable kind, and it owns both bounds

Logs and analytics were the only things in that file when this decision was
written, so its bounds and its health rule were written as the journal's. The
file now also holds every span, every error group and occurrence, the per-trace
summary, and the rollups that outlive raw data. Both statements move up to the
sidecar, because neither was ever really about one kind.

**Storage is bounded once, for the file.** A record cap and a byte cap per kind
are several independent guesses at a share of one disk, and several such guesses
cannot bound that disk: three kinds each under their own cap can still fill it.
The sidecar carries one `maxStoredBytes`, sampled from its own connection, and
bounded write-path maintenance that first expires what the per-kind and
per-level clocks say is old and then, only while over budget, evicts oldest
first from the shortest clock outward. Retention is retroactive: a row never
stamps a deadline, so the configuration that is there is the one that counts,
including for rows written under an older one. Eviction returns bytes rather
than only lengthening a freelist, because a budget measured against a size that
never falls is not a budget.

**Failure is judged for the file, not for a row.** "Failure of this local
persistence boundary makes the runtime unhealthy" was correct when one kind
wrote to the file and any write failure meant the boundary was gone. With five
kinds and orders of magnitude more writes, a rejected row is an ordinary event
and a full disk is not. The sidecar probes its own connection when a kind
reports a failure: a connection that still answers means the loss belongs to
that kind and is an accounted drop, and only a connection that cannot answer
makes the runtime unhealthy. Classification is by that evidence rather than by
matching driver error text, because a constraint violation and a full disk
arrive as the same kind of exception and only one of them means the file is
gone. Every kind's drops stay observable in its own snapshot, and the sidecar's
contained-failure count stays observable in its own.

**Spans are stored unsampled.** Every span the runtime records is queued for
the sidecar, independent of the in-memory retention decision that governs what
an exporter and a local sink see — no rule decides which traces are worth
keeping, so the trace an operator is looking for is there. Persistence is
asynchronous on the same terms this ADR already sets for logs: a bounded queue
that drops observably when it saturates, a crash that may lose the queued tail,
and no operation ever waiting for the write. That is bounded best-effort capture
with no sampling, not a synchronous durability guarantee, and the two must not
be confused. The capture costs measurable work on the recording path for every
operation, whether or not anyone is watching; this ADR records the trade rather
than hiding it, and the decision to keep paying it is revisited on the
measurement stated in the pull request that introduced it.

**The sidecar is disposable, so it is never migrated.** It is stamped with the
shape this version writes; a file stamped with any other is deleted and
recreated. Nothing durable is promised about its contents, so a compatibility
path would buy nothing and cost a permanent second way for the file to exist.
