# Operations, limits, and recovery

The operational contract is intentionally finite and single-node. The CLI
starts one Bun process, one SQLite WAL database, one serialized writer, bounded
read/revalidation work, and bounded transport delivery.

The backend and CLI are Bun-only: the engine uses `bun:sqlite`, and the packages
ship source TypeScript. One process must exclusively own the configured
database. Running multiple AckerDB servers against one file, putting that file on
shared storage as a scaling mechanism, or starting the server under Node.js is
outside the production contract.

The CLI listener is plaintext HTTP/WebSocket and has no inbound TLS
configuration. It defaults to `127.0.0.1`; `hostname` in
`.ackerdb.config.json` may select another bind address for a trusted private
development network. Keep production traffic on loopback or a private encrypted
hop behind a TLS terminator; do not expose bearer traffic over an unencrypted
network.

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
| Request / Protocol 6 frame | 1 MiB / 1 MiB |
| Resume history, per stream | 64 transitions, 2 MiB, 30 s |
| Resume history, global | 128 MiB |
| Publication handoff | 4,096 items, 32 MiB |
| Job claims per runner wake (`jobs.claimBatchSize`) | 100 |
| Concurrently running job handlers (`jobs.maxRunning`) | 64 |
| Job attempt lease (`jobs.leaseMs`) | 60 s |
| Mutation replay | 24 h, 1 MiB/result, 1,000,000 records, 4 GiB |
| Realtime peers, global / per principal | 1,024 / 16 |
| Realtime handshakes, per principal and 10 s window | 32 |
| Realtime typed streams, buffered input / event-handler concurrency, per generation | 16 / 256 KiB / 128 |
| Realtime auxiliary peers / decoded streams / media sources, per generation | 4 / 8 / 8 |
| Realtime data channels / senders / transceivers, per peer | 16 / 32 / 32 |
| Realtime auxiliary peers / decoded streams / media sources / tracks, process-wide | 2,048 / 32,768 / 32,768 / 131,072 |
| Realtime native queue reservations, per generation / process-wide | 32 MiB / 512 MiB |
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
to the stable caller afterward. AckerDB does not trust `Forwarded` or
`X-Forwarded-For`; clients behind one reverse proxy therefore share that
proxy's anonymous source group. Fairness is among admitted groups, not a
latency SLA.

SSE acknowledgement requests use their stream capability and per-frame proof
rather than repeating bearer verification. They still pass through finite HTTP
admission, and malformed or invalid capabilities cannot release another
stream's bytes.

The stock client has a separate exported `ACKERDB_CLIENT_LIMITS` object, and
`Engine` defaults its SQLite busy timeout to 5 seconds. The CLI does not expose
arbitrary service-limit overrides in `.ackerdb.config.json`; programmatic
`Runtime` construction does.

## Realtime media deployment

Realtime media is one AckerDB-relayed WebRTC generation, not a media
WebSocket. `RuntimeOptions.realtime` owns deployment policy: ICE configuration
or built-in coturn REST credentials, interface and candidate policy, admission
limits, per-generation limits, process-wide native-resource limits, and
independent authorization, configuration, handler, signaling, ICE, DTLS, and
data-channel deadlines. Common application code does not configure those
details.

Production reachability needs UDP plus TURN/TLS on 443 for networks that block
direct ICE. AckerDB validates configuration at startup and provides
`preflightRealtimeTurn` for independent TURN/UDP and TURN/TLS relay-only
allocation and data-path checks. Each path has an absolute deadline and a
stable, secret-safe result. The [coturn deployment guide](deployment/coturn/README.md)
defines the supported topology and hardening. TURN credentials are short-lived
and principal-bound. SDP, candidates, mapped addresses, and credentials never
appear in aggregate status.

Admission happens before native peer allocation. Session and principal
ceilings, handshake windows, peer object limits, typed-stream budgets, handler
concurrency, and the shared auxiliary-peer/decoder/source/track budget all fail
with a bounded typed outcome instead of retaining more native state. Every
generation owns its tracks, sources, decoded streams, auxiliary peers, data
channels, and partial typed streams; close releases them. Recovery never
replays application events, provider state, media, or partial streams.

`Runtime.status().realtime` exposes fixed-cardinality admission, setup-stage,
recovery, close-reason, resource, pressure, and aggregate media-path health.
`Runtime.realtimeDiagnostic(sessionId, principal)` is the authorized,
on-demand, redacted per-peer diagnostic. On-demand diagnostics and each
periodic batch have the deployment's absolute `diagnosticTimeoutMs` deadline
(5 seconds by default), so a stalled or late native statistics request cannot
hold shutdown or mutate a later health snapshot. The periodic health sampler
rotates over at most eight active generations on the existing telemetry tick;
it does not create another timer or scan every peer.

The server native engine runs in the Bun process. A peer/session failure is
generation-contained, but a native process crash requires an ordinary process
supervisor to restart AckerDB; clients with demand create fresh generations.
Run the server under launchd, systemd, Kubernetes, or an equivalent supervisor
with bounded restart policy. In-process worker isolation is not part of the
current contract.

Published `@ackerdb/realtime` releases must have verified optional native
packages for Darwin arm64/x64, Linux GNU arm64/x64, and Windows x64, plus the
aggregate manifest, SHA-256 digests, third-party notices, and Cargo CycloneDX
SBOM. The root package contains no native binary; a consumer installs only its
matching optional target package.

GitHub builds all five targets only when actual WebRTC native inputs change.
The pull-request artifacts are used by the following canary delivery. When the
native source digest is unchanged, canary, stable, and local beta publication
reuse an already verified five-target public or local artifact set instead of
recompiling Rust. Every reused target manifest must match the exact current
native-source digest, binary digest, loader digest, and package version after
retargeting.

Merges into `canary` publish `X.Y.Z-canary.N` to public npm; merges into `main`
publish `X.Y.Z`. Verdaccio receives repeatable `X.Y.Z-beta.N` local test builds
only. CI executes native and exact-packed-package suites on Darwin arm64;
physical-device, provider, network-change, TURN-only, churn, and soak exercises
remain release/operator validation rather than hidden package claims. See
[Releases and protected branches](releases.md).

The complete API and recovery semantics are in
[Realtime media](realtime-media.md); build provenance is in
[`packages/realtime/native/webrtc/PROVENANCE.md`](../packages/realtime/native/webrtc/PROVENANCE.md).

## Typed outcomes

Every Protocol 6 failure is an `Outcome`, and unknown internal exceptions are
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
Protocol 6 error body, which is authoritative.

WebSocket connection failures are sent as an error frame when reserved control
capacity permits. Malformed/unsupported protocol closes with 1002;
overload/slow-consumer/draining/unavailable closes with 1013; other typed
outcomes close with 1008.

`retryable` is explicit per occurrence rather than inferred solely from the
code. Queue item/byte pressure is retryable with a bounded hint; an expired
queue deadline is not. `AckerDBClientError` exposes `outcome`, `code`,
`retryable`, `retryAfterMs`, `resource`, and `committed`.

## Durability profiles

`ACKERDB_DURABILITY` accepts exactly `production` or `balanced`; omitted means
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

At open, the engine first acquires the canonical data path through a persistent
same-directory SQLite coordination database (`data.db.ackerdb-coordination`). The
first process initializes the AckerDB-branded, empty rollback-journal database in
a private same-directory `0600` UUIDv4 staging file, closes and fsyncs it, and
publishes it with a no-clobber hard link. Before any SQLite connection opens
the canonical inode, contenders remove only exact staging aliases of that same
inode, require its hard-link count to be exactly one, and fsync the directory.
A pre-link crash file has a different inode and is deliberately retained; it
cannot be mistaken for an alias of the canonical database.

Only after publication has converged does AckerDB open the canonical coordination
database, validate its immutable `application_id`, empty schema, and DELETE
journal mode, and hold one `BEGIN IMMEDIATE` transaction for the Engine
lifetime. A live contender gets a typed already-open refusal with no wait or
polling. Process death releases SQLite's OS lock immediately; AckerDB never
deletes, renames, reaps, or reads an owner record from the canonical file.
Startup, restore, and full reset all use this one ownership primitive, while a
staged restore Engine borrows the already-held connection.

A fresh database is initialized in a uniquely named file in the target
directory, fsynced, published with a no-clobber hard link, followed by a
parent-directory fsync, and then reopened with implicit creation disabled. This
makes two concurrent initializers converge on one complete database rather than
exposing a partially initialized file. The database directory and each backup
artifact directory must support same-directory hard links, atomic rename, and
truthful file/directory sync. Fresh initialization uses the no-clobber hard
link; backup publication uses atomic artifact rename plus a no-clobber manifest
hard link.
Exact UUIDv4 data-initialization artifacts left by a crashed owner are
scavenged only after ownership is held; unrelated files are never matched. The
coordination database normally costs one 4 KiB file and one idle SQLite handle
per open database, creates no background work, and survives reset so its
identity never depends on pathname deletion races. An exact pre-link
coordination staging residue may remain after `SIGKILL`; AckerDB accepts it as an
internal directory entry but never guesses that a different inode is safe to
delete.

An existing database is never initialized or repaired in place during
preflight. Empty, truncated, non-SQLite, incompatible, or internally corrupt
main files are rejected. A missing main file with a WAL, shared-memory file, or
rollback journal is also rejected. When a nonempty WAL or rollback journal may
require recovery, AckerDB copies the main file and relevant recovery evidence to a
disposable directory and lets SQLite recover and validate that copy before the
original writer is opened. Rejection therefore preserves the original main,
WAL, and rollback-journal bytes for diagnosis. A clean main file with no
nonempty recovery journal is validated read-only in place without a whole-file
copy. Validation includes a quick or full integrity check,
`foreign_key_check`, the exact AckerDB internal schema, application schema, tag
registry, and mutation-ledger counters before WAL mode is enabled and the
previous clean-shutdown marker is read.

SQLite owns valid-prefix WAL recovery. AckerDB rejects a valid WAL header whose
page size is incompatible with the main file, but an incomplete header,
checksum-invalid tail, salt change, or truncated final frame can be ordinary
crash residue. Without a separately durable expected-end watermark, no engine
can prove that an attacker or failed device did not remove an entire otherwise
valid WAL suffix; backups and storage controls remain necessary.

If AckerDB rejects storage, stop automated restart attempts and preserve the main
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

## Plugin storage reconciliation

Each mounted Plugin owns a private SQLite scope identified by its manifest
mount and stable definition ID. Its physical tables and tag records are
isolated from the root application schema and from every other mount, including
another instance of the same Plugin definition. Startup reconciles all desired
Plugin scopes after the root schema and migration chain are ready and before
Plugin lifecycle callbacks run.

Safe private-schema changes use the normal schema planner and are applied
automatically in one Plugin-schema transaction. The v0.6.0 alpha deliberately
has no Plugin migration or rename API. AckerDB instead produces an exact pending
requirement when:

- a schema change is unsafe or conflicts with private rows: reset that mount;
- the definition ID at an existing mount changes: reset that mount; or
- a stored mount is no longer in `defineApp({ plugins })`: drop that stale
  mount.

Changing a mount name therefore creates a fresh Plugin instance and leaves the
old name as a pending drop; AckerDB never guesses that the two names are a rename.
A reset drops only the named mount's private state and creates its target
schema. A drop removes only the named stale scope. Neither action grants
authority over root application tables or another Plugin mount.

Interactive `acker dev` prints the affected mount, reason, safe changes that
would otherwise apply, and data refusals, then asks with a default of no. A
decline keeps the server down until the manifest changes or the requirement is
resolved. `acker start` and non-interactive development never clear Plugin data;
startup refuses and prints the exact recovery command instead:

```sh
acker plugin reset <mount> [app-dir]
acker plugin drop <old-mount> [app-dir]
```

These are not arbitrary deletion commands. Each command re-imports the current
manifest, re-plans storage in a fresh process, and executes only a currently
pending requirement whose current and target fingerprints still match. A
changed manifest or storage state makes old consent stale rather than widening
it. `acker reset [app-dir]` remains the separate development escape hatch that
acquires the same database ownership and removes only `data.db`, its exact
SQLite sidecars, and exact UUIDv4 AckerDB initialization/restore staging files.
It refuses while startup or restore is live, retains the coordination database,
retains exact coordination crash residues, and leaves every unrelated entry in
`.ackerdb` untouched.

Because unsafe Plugin evolution is reset-only in this alpha, a Plugin's design
must make that data disposable or keep its durable source of truth elsewhere.
See [Plugins](plugins.md#private-schema-changes-in-the-alpha) and
[Cache](cache.md), whose private state is disposable by definition.

## Health and protected status

The server exposes three versioned JSON endpoints:

| Endpoint | Authentication | 200 contract | 503 contract |
| --- | --- | --- | --- |
| `GET /live` | none | `{ "version": 1, "live": true }` while the listener is starting, ready, or draining | `live: false` if a request reaches failed/stopped teardown; no HTTP response exists after the listener closes |
| `GET /ready` | none | `{ "version": 1, "ready": true, "state": "ready" }` only when both transport and runtime are `ready` | `{ version: 1, ready: false, state, phase? }` while starting, draining, stopped, or failed |
| `GET /status` | workload bearer plus configured scope | `{ "version": 1, "state": ..., "connections": ..., "httpIngress": ..., "outboundBytes": ..., "runtime": ... }` | transport/runtime availability failures |

`/status` requires the external workload principal and selected scope described
in [Authentication](authentication.md#operational-status-authority). Its body
is the full `AckerDBServer.status()` snapshot with `version: 1` added: transport
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

`acker start` binds one listener before code generation and keeps that port live
through the monotonic startup phases `listening`, `codegen`, `loading`,
`opening-storage`, `migrating` (when a migration chain is present), and
`reconciling`, followed by `loading-runtime` for credential verifiers and
function modules. Runtime-only modules load after durable schema work commits,
so their configuration cannot block a pending migration. `/live` and `/ready`
remain reachable;
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

`acker start` and the supervised server process install one-shot `SIGINT` and
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
acker status [app-dir]
acker backup <artifact> [app-dir] [--metadata-only]
acker restore <artifact> [app-dir]
```

With default telemetry enabled, `backup` and `restore` first emit bounded safe
JSON telemetry records: one `storage` span with duration/outcome and, on
failure, one sanitized event. Successful spans may include artifact byte count
and commit-version correlation, but never paths, contents, schema literals, or
error messages. The final line remains the operation report. Setting
`ACKERDB_TELEMETRY=disabled` removes those records exactly and leaves only the
report.

`status` and `backup` require an existing database and never create a missing
one. The engine's canonical ownership transaction means these CLI operations
are offline with respect to a running AckerDB server. They are maintenance writer
opens, not byte-for-byte read-only inspection: Engine may complete valid SQLite
recovery, sets WAL/durability pragmas, and updates the clean-shutdown marker.
Neither operation changes application rows or the logical commit version.

The operator workflow is therefore:

1. send `SIGINT` or `SIGTERM` and wait for `acker start` to finish its bounded
   drain and exit successfully;
2. run `acker backup`, then retain or copy the artifact, its adjacent
   `.manifest.json` file, and its adjacent `.files` directory;
3. rehearse recovery with `acker restore` into a fresh configured database
   directory; and
4. start the restored application and check `/live`, `/ready`, and authorized
   `/status` before returning it to service.

A failed drain is not a clean backup boundary. Let the next open run recovery
validation, then stop cleanly before taking the offline backup.

Run this workflow before deploying any release that carries pending
migrations: a refused or failed migration leaves the database untouched, but a
migration that succeeds with wrong transform logic is only recoverable from a
verified backup. See [migrations.md](migrations.md) for the deploy sequence.

`acker backup` performs this acceptance sequence:

1. open the source with a full integrity check;
2. create a transactionally consistent SQLite artifact with `VACUUM INTO`;
3. fsync and inspect the artifact, then compute bytes and SHA-256;
4. read every framework File row from that exact SQLite snapshot, stream its
   immutable object from the configured File store into `<artifact>.files`,
   and verify its byte size and SHA-256 against the row metadata;
5. launch a separate Bun process, restore into a throwaway directory, run full
   integrity/schema/terminal-version checks, prove the next commit version,
   commit a durable no-op write without changing that terminal version, and
   independently verify every backed-up File; and
6. only after that rehearsal succeeds, atomically publish
   `<artifact>.manifest.json` and its verification timestamp.

The exact manifest format is version 2 with `sha256`, `bytes`,
`schemaFingerprint`, decimal-string `commitVersion`, `durability`, and
`verifiedAt`, plus a `files` record containing `mode`, File-row `count`, and
included byte count. A failed verification removes the candidate database and
File artifacts instead of publishing an unverified backup.

The SQLite artifact includes AckerDB's commit state,
retained mutation replay ledger, stored Plugin inventory, and all private
tables. Its schema fingerprint covers both the root schema and those Plugin
scopes. Restore therefore preserves still-retained mutation request IDs and
their exact-once replay results; the full engine open also validates the ledger
counters and stored Plugin layouts before the artifact is accepted. By default,
the adjacent `.files` directory contains the corresponding immutable File bytes
under framework File IDs; private physical object keys remain only inside the
verified database. `--metadata-only` records an explicit `metadata-only` mode
and omits that directory for operators who protect their File store separately.

`acker restore` validates the exact manifest shape, digest, size, commit version,
and target App storage layout in a fresh verification process before claiming
the target. The layout comparison includes the root schema plus every Plugin
mount, definition ID, and private schema; restore never reconciles either side.
For an included backup it also verifies every File against the database,
refuses to replace an existing object key, and restores bytes to the target
App's configured active File store while the verified database remains staged.
Only after those bytes are durable does restore publish the canonical database;
an unpublished failure rolls back the attempted File objects.
If the process is killed after an included restore starts copying File objects
but before database publication, the generic FileStore has no cross-provider
transaction and some objects may remain. A retry deliberately refuses those
keys instead of adopting even byte-identical objects: adoption could give two
databases deletion ownership of the same physical object. Retry against a
fresh empty FileStore, or empty the failed target only after proving it is
exclusive and no database was published from that attempt. Metadata-only
restore does not write File objects and is unaffected.
The configured target database directory may be absent or vacant apart from its
persistent coordination database and exact coordination staging crash residues.
Its canonical database and SQLite sidecars must be absent, and unrelated
directory entries are refused rather than removed.
After the fresh-process check, restore claims the same canonical ownership used
by startup, imports and validates the App again while that ownership is held, and
writes the artifact only to an exact same-directory UUID staging path. It fully
opens and probes that staged Engine, closes it cleanly, converts the closed copy
to a self-contained rollback-journal main file, rechecks its manifest identity,
fsyncs it, and requires no meaningful WAL or journal state. Publication is one
no-clobber hard link to `data.db` followed by a directory fsync. Before that link,
failure cleanup removes only the exact staging main and sidecars. After the link,
the canonical database is never unlinked: a sync or staging-cleanup failure is
reported as explicit durability/cleanup ambiguity and leaves staging evidence.
Startup refuses blank initialization when exact interrupted-restore evidence is
present; a restore retry may clear only those exact artifacts, while startup may
scavenge them once a complete canonical database exists. The package exposes
this as one verified restore operation rather than exposing the staging state
machine, so callers cannot publish without the full open and commit probe.

The operator still owns scheduling, retention, encryption, access control,
off-machine copies, and periodic disaster-recovery drills. AckerDB currently
provides verified artifacts, not a backup service or point-in-time recovery.

## FileStore maintenance migration

`acker files migrate` moves immutable File bytes between the filesystem and any
S3-compatible backend while the application is stopped:

```sh
acker files migrate <target.json> [app-dir]
```

The target file contains exactly the object accepted by the `files` field in
`.ackerdb.config.json`; relative filesystem paths resolve from the application
directory. For example:

```json
{
  "backend": "s3",
  "endpoint": "https://account.r2.cloudflarestorage.com",
  "region": "auto",
  "bucket": "documents",
  "forcePathStyle": true,
  "checksum": "disabled",
  "encryption": { "type": "disabled" }
}
```

The target must be a different physical store. A filesystem store carries a
durable `.ackerdb-store-id` marker in its root; moving the complete directory
therefore preserves its identity, while an absent, replaced, or incorrectly
mounted directory fails closed against the database binding. Normalized S3
endpoint, region, and bucket identify an S3-compatible store. Path style,
checksum, encryption, URL, and size settings do not make the same location a
different migration target.

The command takes exclusive maintenance ownership of the existing database and
runs its full integrity check. It streams every `pending` or `active` File to
the target under the unchanged private object key; File IDs, grants, and
application references remain database data and do not change. Files already
in `deleting` state are excluded, and source objects are never removed.

Progress is fsynced to a per-operation journal under
`.ackerdb/file-store-migrations/`. A retry resumes after the last durable
checkpoint, but completion is accepted only after AckerDB streams and hashes
every current live object from the target again. The journal header binds the
complete ordered live-File manifest—ID, object key, size, and SHA-256—alongside
the database commit, schema, and both backend identities.

Only after that final verification succeeds and the database closes cleanly
does AckerDB atomically replace the active `files` object in
`.ackerdb.config.json`. Copy, verification, database-close, or concurrent
configuration-change failure leaves the previous FileStore active. The JSON
success report includes the journal path and copied, already-present, resumed,
and total object and byte counts.

With telemetry enabled, the command first emits one bounded `file_migration`
`storage` span with duration, sanitized outcome, verified target byte count,
and commit correlation on success. Failure also emits one sanitized `failure`
event; paths, object keys, contents, and error messages are never telemetry.
The telemetry is drained before the final report, and
`ACKERDB_TELEMETRY=disabled` removes it exactly.

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
