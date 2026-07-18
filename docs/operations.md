# Operations, limits, and recovery

The operational contract is intentionally finite and single-node. The CLI
starts one Bun process, one SQLite WAL database, one serialized writer, bounded
read/revalidation work, and bounded transport delivery.

The backend and CLI are Bun-only: the engine uses `bun:sqlite`, and the packages
ship source TypeScript. One process must exclusively own the configured
database. Running multiple DBZZ servers against one file, putting that file on
shared storage as a scaling mechanism, or starting the server under Node.js is
outside the production contract.

The CLI listener is plaintext HTTP/WebSocket on `127.0.0.1` and has no inbound
TLS configuration. Keep it on loopback or a private encrypted hop behind a TLS
terminator; do not expose bearer traffic over an unencrypted network.

## Production limit defaults

`Runtime` uses the frozen `PRODUCTION_LIMITS` unless it is given a complete
validated `ServiceLimits` object. `defineServiceLimits` validates the full
shape and its cross-field invariants; it does not accept a partial object.

| Resource | Default |
| --- | ---: |
| Connections | 4,096 |
| Active operations, global / per caller / per connection | 4,096 / 128 / 128 |
| Runtime read queue and each WebSocket ingress queue | 4,096 items, 32 MiB, 30 s age each |
| Write queue | 4,096 items, 32 MiB, 30 s age |
| Query/event subscriptions, global / per connection | 100,000 / 1,024 |
| Shared query entries / encoded shared results | 100,000 / 128 MiB |
| Snapshot-reader / revalidation workers | 4 / 4 |
| Revalidation queue | 100,000 items, 32 MiB, 30 s age |
| WebSocket outbound, per connection / global / stall | 4 MiB / 64 MiB / 5 s |
| Authentication-transition capture, per transition / separate global pool | 2,048 frames and 3 MiB / 64 MiB with 1 MiB reserved control capacity |
| SSE outbound, per stream / global / stall | 1 MiB / 32 MiB / 5 s |
| Request / Protocol 2 frame | 1 MiB / 1 MiB |
| Resume history, per stream | 64 transitions, 2 MiB, 30 s |
| Resume history, global | 128 MiB |
| Publication handoff | 4,096 items, 32 MiB |
| Scheduled handlers per batch | 100 |
| Mutation replay | 24 h, 1 MiB/result, 1,000,000 records, 4 GiB |
| Remote credential invalidation guarantee | Verifier `deadlineMs` must be positive, finite, and no greater than configured `revocationDeadlineMs` (5 s default and maximum); Runtime construction validates its single verifier before activation, matching callbacks initiate immediate fail-closed session/lease abort, and the verifier owns feed propagation within its advertised bound |
| Graceful shutdown deadline | 10 s |
| Telemetry retention/export | See [Telemetry](telemetry.md#default-bounds) |

WebSocket application traffic cannot consume the reserved control-frame
capacity. SSE reserves capacity for one terminal outcome and retains each
application or terminal reservation until a valid cumulative receiver
acknowledgement, cancellation, or finite terminal grace expiry. A merged source
has at most one unacknowledged application frame; direct writes remain bounded
by the same per-stream and global byte limits. Accumulated per-connection or
per-stream owned bytes and receiver stalls become retryable `slow_consumer`.
An oversized frame/envelope or exhausted global outbound budget becomes
retryable `overloaded`. The stream/session closes rather than retaining an
unbounded copy, including when Bun has already accepted bytes into an internal
HTTP buffer.

Authentication refresh, sign-out, and revocation use a separate bounded capture
pool while reset/revocation frames are assembled for the new epoch. One
transition may retain at most 2,048 frames and 3 MiB; all transitions share a
64 MiB pool with 1 MiB reserved control capacity. Exhaustion is retryable
`overloaded` with resource `subscription`. Protected status exposes
`runtime.authCaptureBudget`, and telemetry emits `runtime.auth_capture_bytes`.

Read, write, and revalidation executors use round-robin fairness keys. A user's
active-operation key is its durable Identity, shared across HTTP and WebSocket;
a workload remains keyed by its verified `(kind, issuer, subject)`. Exact
external-account identity resolution has its own fixed-width pre-principal key.
Anonymous HTTP and WebSocket callers are instead grouped by their transport
source/socket address, while WebSocket retains a separate per-connection
ceiling. HTTP source admission is applied before authentication and transferred
to the stable caller afterward. DBZZ does not trust `Forwarded` or
`X-Forwarded-For`; clients behind one reverse proxy therefore share that
proxy's anonymous source group. Fairness is among admitted groups, not a
latency SLA.

SSE acknowledgement requests use their stream capability and per-frame proof
rather than repeating bearer verification. They still pass through finite HTTP
admission, and malformed or invalid capabilities cannot release another
stream's bytes.

The stock client has a separate exported `DBZZ_CLIENT_LIMITS` object, and
`Engine` defaults its SQLite busy timeout to 5 seconds. The CLI does not expose
arbitrary service-limit overrides in `.zdb.config.json`; programmatic
`Runtime` construction does.

## Typed outcomes

Every Protocol 2 failure is an `Outcome`, and unknown internal exceptions are
sanitized to `{ code: "internal", retryable: false, message: "internal server error" }`.
Messages are bounded to 512 JavaScript UTF-16 code units without splitting a
Unicode code point. Optional `resource`, `retryAfterMs`, and `committed: true`
fields explain pressure, backoff, and post-commit convergence failures. Clients
should use the fields, not parse `message`.
`retryAfterMs` is legal only on a retryable outcome and is capped at 30
seconds. `committed: true` is legal only on non-retryable
`convergence_unavailable`.

The finite outcome codes are:

```text
malformed                 validation               unsupported_protocol
unauthenticated           auth_unavailable         auth_stale
unauthorized              not_found                conflict
overloaded                slow_consumer            deadline_exceeded
draining                  unavailable              convergence_unavailable
indeterminate             internal
```

The finite `resource` classes are `connection`, `operation`, `reader`,
`writer`, `subscription`, `revalidation`, `publication`, `outbound`, `sse`,
`history`, `idempotency`, and `telemetry`.

HTTP maps validation/protocol errors to 400; unauthenticated/stale auth to 401;
unauthorized to 403; not found to 404; conflict to 409; ordinary overload and
slow consumers to 429; connection/publication overload, auth service failure,
draining, and unavailability to 503; deadlines to 504; and convergence,
indeterminate, or internal failures to 500. HTTP responses still carry the
Protocol 2 error body, which is authoritative.

WebSocket connection failures are sent as an error frame when reserved control
capacity permits. Malformed/unsupported protocol closes with 1002;
overload/slow-consumer/draining/unavailable closes with 1013; other typed
outcomes close with 1008.

`retryable` is explicit per occurrence rather than inferred solely from the
code. Queue item/byte pressure is retryable with a bounded hint; an expired
queue deadline is not. `DbzzClientError` exposes `outcome`, `code`,
`retryable`, `retryAfterMs`, `resource`, and `committed`.

## Durability profiles

`DBZZ_DURABILITY` accepts exactly `production` or `balanced`; omitted means
`production`. Both profiles use SQLite WAL and acknowledge a mutation only
after SQLite `COMMIT` succeeds. The selected value is included in every
mutation receipt and storage status.

| Profile | SQLite setting | Contract |
| --- | --- | --- |
| `production` | `PRAGMA synchronous=FULL` | Default production acknowledgement profile, including SQLite's FULL WAL sync before commit acknowledgement. |
| `balanced` | `PRAGMA synchronous=NORMAL` | Benchmark-oriented profile. It remains process-crash consistent but may lose recent acknowledged commits after an OS crash, hard reset, or power loss. |

No software setting can compensate for storage hardware or a filesystem that
lies about durable sync. `balanced` must not be presented as the same power-loss
contract as `production`.

At open, the engine first acquires an exclusive DBZZ process lock. A fresh
database is initialized in a uniquely named file in the target directory,
fsynced, published with a no-clobber hard link, followed by a parent-directory
fsync, and then reopened with implicit creation disabled. This makes two
concurrent initializers converge on one complete database rather than exposing
a partially initialized file. The database directory and each backup artifact
directory must support same-directory hard links, atomic rename, and truthful
file/directory sync. Fresh initialization uses the no-clobber hard link; backup
publication uses atomic artifact rename plus a no-clobber manifest hard link.
Exact UUIDv4 initialization artifacts left by a crashed owner are scavenged only
after the process lock is held; unrelated files are never matched.

An existing database is never initialized or repaired in place during
preflight. Empty, truncated, non-SQLite, incompatible, or internally corrupt
main files are rejected. A missing main file with a WAL, shared-memory file, or
rollback journal is also rejected. When a nonempty WAL or rollback journal may
require recovery, DBZZ copies the main file and relevant recovery evidence to a
disposable directory and lets SQLite recover and validate that copy before the
original writer is opened. Rejection therefore preserves the original main,
WAL, and rollback-journal bytes for diagnosis. A clean main file with no
nonempty recovery journal is validated read-only in place without a whole-file
copy. Validation includes a quick or full integrity check,
`foreign_key_check`, the exact DBZZ internal schema, application schema, tag
registry, and mutation-ledger counters before WAL mode is enabled and the
previous clean-shutdown marker is read.

SQLite owns valid-prefix WAL recovery. DBZZ rejects a valid WAL header whose
page size is incompatible with the main file, but an incomplete header,
checksum-invalid tail, salt change, or truncated final frame can be ordinary
crash residue. Without a separately durable expected-end watermark, no engine
can prove that an attacker or failed device did not remove an entire otherwise
valid WAL suffix; backups and storage controls remain necessary.

If DBZZ rejects storage, stop automated restart attempts and preserve the main
file with its `-wal`, `-shm`, and `-journal` sidecars as one evidence set. Do not
delete sidecars or attempt an in-place repair. Retain a copy for diagnosis, then
restore a verified artifact into a fresh configured database directory.

Storage status reports engine/SQLite versions, durability and synchronous
mode, commit version, crash-recovery observation, database/WAL bytes, and
mutation replay records/bytes. `runtime.storage.lastCheckpoint` is `null` until
the current engine instance completes a checkpoint invocation, then exposes its
mode, busy result, total/checkpointed/residual WAL frames, and duration through
protected `/status`. The detailed report is deliberately not persisted because
its WAL-frame state becomes stale across restart. The separate
`lastCheckpointAtMs` is a persisted historical invocation timestamp and can be
non-null while `lastCheckpoint` is null. Busy or residual frames mean the
invocation did not fully checkpoint the WAL; checkpointing is not a substitute
for a commit acknowledgement or verified backup.

## Health and protected status

The server exposes three versioned JSON endpoints:

| Endpoint | Authentication | 200 contract | 503 contract |
| --- | --- | --- | --- |
| `GET /live` | none | `{ "version": 1, "live": true }` while the listener is starting, ready, or draining | `live: false` if a request reaches failed/stopped teardown; no HTTP response exists after the listener closes |
| `GET /ready` | none | `{ "version": 1, "ready": true, "state": "ready" }` only when both transport and runtime are `ready` | `{ version: 1, ready: false, state, phase? }` while starting, draining, stopped, or failed |
| `GET /status` | workload bearer plus configured scope | `{ "version": 1, "state": ..., "connections": ..., "httpIngress": ..., "outboundBytes": ..., "runtime": ... }` | transport/runtime availability failures |

`/status` requires the external workload principal and selected scope described
in [Authentication](authentication.md#operational-status-authority). Its body
is the full `DbzzServer.status()` snapshot with `version: 1` added: transport
connection count, HTTP ingress/fairness and rejection counts, SSE
acknowledgement ingress/no-op counts, global WebSocket outbound bytes, and the
runtime queue, publication, reactivity, SSE, telemetry, and storage snapshots.
`runtime.authCaptureBudget` and `runtime.sseBudget` distinguish current
total/application/control byte ownership from lifetime peaks since Runtime
construction. `peakBytes` is the maximum simultaneous total; the two lane peaks
are independent and need not sum to it. Protected status therefore retains a
short-lived ownership peak after current gauges return to zero. The transport's
top-level `outboundBytes` remains a current scalar.
With the CLI and no configured OIDC provider, no bearer can authenticate, so
operators must configure a workload provider that selects `scope` before
`/status` is usable.

`dbz start` binds one listener before code generation and keeps that port live
through the monotonic startup phases `listening`, `codegen`, `loading`,
`opening-storage`, and `reconciling`. `/live` and `/ready` remain reachable;
`OPTIONS` receives its finite control response, and a syntactically valid SSE
acknowledgement passes bounded admission but is an oracle-free no-op before a
Runtime producer exists. Application, WebSocket, and protected-status traffic
receives typed `unavailable`. After storage validation, schema reconciliation,
registry construction, and Runtime construction all succeed, activation
attaches the Runtime and flips readiness atomically. A startup failure or
signal-triggered interruption drains the listener and closes any acquired
storage ownership; it can never activate later from an abandoned
import/preparation promise.

Readiness does not start a new probe transaction for every request. Its
database guarantee is the successful engine-open and reconciliation activation
gate, plus the Runtime lifecycle state. Operators needing continuous storage
probes should derive them from protected status/telemetry and their own policy.

## Signals and bounded drain

`dbz start` and the supervised server process install one-shot `SIGINT` and
`SIGTERM` handlers. The first signal starts the idempotent `RunningApp.drain()`
path and removes those handlers:

1. set transport state to `draining` synchronously, making readiness false and
   rejecting new application, WebSocket, and protected-status admissions while
   keeping health and the finite SSE acknowledgement control route reachable;
2. close WebSocket sessions with `draining` and fail active SSE producers,
   retaining their acknowledgement capabilities through terminal delivery or
   terminal grace expiry;
3. wait for admitted operations, the writer/publication path, revalidation,
   readers, and the owned telemetry drain (or one flush for caller-owned
   telemetry); and
4. on successful server drain, mark SQLite clean and close the engine.

`gracefulShutdownMs` is one absolute server drain bound (10 seconds by default),
shared rather than restarted between Runtime and transport cleanup. If Runtime
operation work reaches it, Runtime owns and Serve preserves
`deadline_exceeded` with message `runtime graceful shutdown deadline exceeded`
and resource `operation`. If Runtime has drained but a connection, Session, or
listener still consumes the deadline, Serve owns the fallback
`deadline_exceeded` with message `graceful shutdown deadline exceeded` and
resource `connection`.

Owned telemetry releases active/completed tail decisions without promoting
their staged diagnostics, then drains or explicitly accounts for already
retained records and local lines within that same absolute deadline. Trace-state
release and any retained remainder are visible in separate telemetry drop
counters. A caller-supplied shared `Telemetry` instance remains caller-owned:
Runtime performs one flush and does not stop or terminally drain it.

Either expiry makes the server `failed`, terminates remaining sockets,
force-stops the listener, and makes the CLI set a nonzero exit code. It does not
falsely mark storage as a clean shutdown after that failed drain. A later open
follows the crash-recovery validation path.

Because the signal handlers are removed as drain begins, a later signal uses
the process default rather than extending the graceful deadline.

## Verified backup and restore

The CLI operations are deliberately conservative and produce one JSON report
on success:

```sh
dbz status [app-dir]
dbz backup <artifact> [app-dir]
dbz restore <artifact> [app-dir]
```

With default telemetry enabled, `backup` and `restore` first emit bounded safe
JSON telemetry records: one `storage` span with duration/outcome and, on
failure, one sanitized event. Successful spans may include artifact byte count
and commit-version correlation, but never paths, contents, schema literals, or
error messages. The final line remains the operation report. Setting
`DBZZ_TELEMETRY=disabled` removes those records exactly and leaves only the
report.

`status` and `backup` require an existing database and never create a missing
one. The engine's exclusive process lock means these CLI operations are offline
with respect to a running DBZZ server. They are maintenance writer opens, not
byte-for-byte read-only inspection: Engine may complete valid SQLite recovery,
sets WAL/durability pragmas, and updates the clean-shutdown marker. Neither
operation changes application rows or the logical commit version.

The operator workflow is therefore:

1. send `SIGINT` or `SIGTERM` and wait for `dbz start` to finish its bounded
   drain and exit successfully;
2. run `dbz backup`, then retain or copy both the artifact and its adjacent
   `.manifest.json` file;
3. rehearse recovery with `dbz restore` into a fresh configured database
   directory; and
4. start the restored application and check `/live`, `/ready`, and authorized
   `/status` before returning it to service.

A failed drain is not a clean backup boundary. Let the next open run recovery
validation, then stop cleanly before taking the offline backup.

Run this workflow before deploying any release that carries pending
migrations: a refused or failed migration leaves the database untouched, but a
migration that succeeds with wrong transform logic is only recoverable from a
verified backup. See [migrations.md](migrations.md) for the deploy sequence.

`dbz backup` performs this acceptance sequence:

1. open the source with a full integrity check;
2. create a transactionally consistent SQLite artifact with `VACUUM INTO`;
3. fsync and inspect the artifact, then compute bytes and SHA-256;
4. launch a separate Bun process, restore into a throwaway directory, run full
   integrity/schema/terminal-version checks, prove the next commit version,
   and commit a durable no-op write without changing that terminal version; and
5. only after that rehearsal succeeds, atomically publish
   `<artifact>.manifest.json` and its verification timestamp.

The exact manifest format is version 1 with `sha256`, `bytes`,
`schemaFingerprint`, decimal-string `commitVersion`, `durability`, and
`verifiedAt`. A failed verification removes the candidate artifact instead of
publishing an unverified backup.

The artifact is the complete SQLite database, including DBZZ's commit state and
retained mutation replay ledger. Restore therefore preserves still-retained
mutation request IDs and their exact-once replay results; the full engine open
also validates the ledger counters before the artifact is accepted.

`dbz restore` validates the exact manifest shape, digest, size, schema, and
commit version in a fresh verification process before claiming the target. The
configured target database directory must not exist; restore never overwrites
or merges an existing database. Promotion uses a temporary file, fsync, atomic
rename, and a second full open/commit probe in the target. A failed attempt
removes only the fresh directory it created.

The operator still owns scheduling, retention, encryption, access control,
off-machine copies, and periodic disaster-recovery drills. DBZZ currently
provides verified artifacts, not a backup service or point-in-time recovery.

## Remaining limitations

- One process owns one SQLite database and one writer. There is no consensus,
  replication, automatic failover, active-active region, sharding, cross-shard
  transaction, or global consistency claim.
- The server and CLI require Bun and `bun:sqlite`; published packages expose
  source TypeScript rather than Node.js-compatible compiled JavaScript.
- There is no hosted control plane, multi-tenant sandbox, deployment service,
  automatic scaling, managed backup retention, or vendor dashboard.
- Query resume history is finite, in memory, and lost on restart. Correctness
  falls back to an authoritative reset.
- Live events are non-persistent and non-resumable. SSE procedures are also not
  resumable state streams. See [Realtime](realtime.md#live-event-ordering-and-gaps).
- Mutation deduplication is finite and keyed by the stable request/session
  identity. There is no persistent offline client mutation queue or conflict
  resolution.
- Reactive queries may be fully recomputed when a dependency changes; there is
  no advanced incremental result-delta engine.
- Generated return types are TypeScript-only inference. Runtime enforces wire
  representability and frame bounds, but does not validate handler results
  against a declared output schema.
- External OIDC verifies identity but does not provide built-in credential
  issuance, discovery, introspection, or immediate provider revocation.
- Telemetry has a backend-neutral callback, not a bundled OTLP exporter or
  observability backend. Its exact current coverage is listed in
  [Telemetry](telemetry.md#automatic-runtime-signals).
- The graceful timer can abort asynchronous work, but JavaScript cannot fire a
  timer while a handler synchronously blocks the Bun event loop. A process
  supervisor still needs an outer hard-kill deadline for CPU-bound or native
  code that never yields.
- This foundation removes specific production blockers; it does not claim that
  every application, infrastructure, threat-model, or regulatory requirement
  is satisfied.
