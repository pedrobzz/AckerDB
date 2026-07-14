# D2 Contract Research Result

- Packet: D2 — contract research
- Status: complete
- Research date: 2026-07-13
- Scope: SQLite durability/recovery/backup, WebSocket and SSE pressure/fairness,
  ordered versioned resume-or-reset delivery, configured `jose` JWT/JWKS
  verification, live identity expiry/revocation, and OpenTelemetry SDK bounds
- Evidence policy: primary and official technical sources only
- Product code changed: none

## Contract conclusions

### SQLite durability, checkpoint, restart, and backup

1. A WAL transaction commits by appending its commit record to the WAL. The WAL
   is persistent database state, so the main `.db` file cannot be copied,
   moved, or restored independently while a live WAL may exist.
2. WAL + `synchronous=FULL` is SQLite's per-commit power-loss-durable profile
   when the storage stack honors sync. WAL + `NORMAL` remains consistent and
   survives application-process crashes, but recently acknowledged commits can
   roll back after an OS crash, hard reset, or power loss.
3. Checkpoint progress is independent of commit acknowledgment. Long-lived
   readers can pin an end mark and prevent completion. DBZZ must inspect the
   checkpoint busy flag and frame counts; a call returning normally is not
   proof that all frames were checkpointed.
4. Crash recovery is normally automatic on the next access. The first recovering
   connection uses an exclusive recovery lock, so a bounded initial
   `SQLITE_BUSY` retry belongs in startup/readiness; deleting sidecars does not.
5. SQLite `integrity_check` does not check foreign keys. Qualification needs
   `foreign_key_check` plus DBZZ ledger/schema/commit invariants.
6. Live backup must use the Online Backup API or `VACUUM INTO`, not raw file
   copying. Online Backup success requires observing `SQLITE_DONE` and final
   status; `backup_finish()` alone can report success for an abandoned partial
   backup. An accepted DBZZ backup must be restored and checked in a fresh
   process.
7. SQLite documents a WAL-reset race through 3.51.2 for multi-connection
   write/checkpoint races. The current local Bun 1.3.14 feasibility capture
   reported SQLite 3.51.0; production multi-connection WAL needs 3.51.3+ or a
   documented fixed backport, verified at runtime.

Implementation implication: persist application rows, commit version, change
journal, idempotency outcome, and outbox in one transaction. Acknowledge only
after that transaction satisfies the advertised synchronous profile. Model
startup as recovery → checks → journal recovery → readiness. Model backup as
create → finalize → fresh-process restore verification → promotion.

### Finite queues, fairness, and slow consumers

1. Bun `ServerWebSocket.send()` returning `-1` means the message was enqueued
   under backpressure, not rejected. DBZZ must stop scheduling that socket until
   `drain`; continuing to send merely grows another buffer. `0` is delivery
   failure, and a positive byte count is not application acknowledgment.
2. WebSocket and EventSource supply no application-consumption credit or global
   fairness. Streams pressure is finite only when a finite high-water mark is
   configured and the producer honors `desiredSize`/`ready`.
3. Every queue therefore needs finite limits by entry count, encoded bytes, and
   age/stall duration; per-principal and global limits; an explicit overflow
   outcome; and current/max/rejected/blocked/reset visibility.
4. Fair service needs bounded scheduling turns across principals, connections,
   and subscription groups. Local socket pressure is not a scheduler.
5. Ordered transitions cannot be silently dropped or overwritten. On queue or
   stall breach, DBZZ stops materializing client-specific work, records a
   bounded slow-consumer reason, emits reset/terminal metadata when possible,
   and closes. Reconnect resumes only from proven retained history or resets.
6. Use HTTP `429` for principal/rate quota and `503` for node/global capacity
   before upgrade/SSE headers, with `Retry-After`. Post-upgrade WebSocket and
   midstream SSE overload need typed protocol outcomes. Reconnect uses server
   guidance plus randomized truncated exponential backoff.

Implementation implication: name and own admission, request, execution,
revalidation, per-connection transport, and global delivery queues. Count
encoded bytes. Configure Bun pressure/payload limits explicitly. Use a
round-robin or deficit-round-robin scheduler with bounded bytes/messages/time
per turn and reserved control/mutation-ack progress.

### Ordered, versioned resume or reset

1. RFC 6455 preserves order only inside one connection. SSE `Last-Event-ID`
   carries an opaque cursor on reconnect; it does not prove history retention,
   cursor binding, or that every intervening event exists.
2. Assign a monotonic `commitVersion` transactionally, but also maintain a
   logical subscription/query-set `stateVersion`. Unrelated commits can make
   `commitVersion` skip for one subscription, so continuity is exact matching
   of `transition.from.stateVersion` and stream binding—not `commit + 1`.
3. Bind an opaque integrity-protected cursor to protocol/schema compatibility,
   deployment/shard, stream generation, canonical query set/args, auth epoch,
   and last accepted state/commit position. Do not expose raw args or claims.
4. Resume only when the binding matches and retained or deterministically
   reconstructible history proves the complete logical chain. Retention is
   finite by count, bytes, and age. Otherwise return a typed reason and fresh
   authoritative snapshot.
5. Snapshot evaluation and subscription registration need one ordered
   publication gate: evaluate at committed `N`, install as observing `N`, then
   release and process affecting commits after `N`. Do not hold a SQLite write
   transaction over this work.
6. Delivery is at-least-once. Exact duplicates can be ignored only when their
   complete identity matches already-applied state; conflicting duplicates,
   gaps, backward transitions, or binding changes reset.
7. Mutation exactly-once effects come from durable request IDs. Resolve the
   client promise after durable commit and application of the relevant
   transition or an authoritative reset snapshot that includes it.

Implementation implication: WebSocket and SSE share snapshot, transition,
reset, mutation-outcome, and cursor message types. Crash after commit but before
publication is recovered from the durable journal. Test duplicate/out-of-order
delivery, every disconnect boundary, snapshot registration races, retention
edges, and read-your-writes through reset.

### Configured `jose` verifier path

1. The current official `jose` API is 6.2.3, documents Bun support, and exposes
   the required `createRemoteJWKSet()` + `jwtVerify()` path. The repository does
   not currently declare the package, so implementation still needs a pinned
   dependency and Bun smoke/rotation tests.
2. `jwtVerify()` verifies compact JWS/signature and then standard claims.
   `issuer` and `audience` options require and compare those claims;
   `algorithms` is an explicit allowlist. If omitted, all algorithms compatible
   with the resolved key are permitted (though `none` is never accepted).
3. `exp` and `nbf` are time/type checked when present, with explicit
   `clockTolerance`. The library does not require either by default. DBZZ must
   put `exp` (and `sub`) in `requiredClaims`; `nbf` stays optional unless the
   provider profile requires it. Strict RFC 9068 also requires `client_id`,
   `iat`, and `jti`, plus the access-token media type (`at+jwt` or its
   `application/` form) to prevent ID-token substitution.
4. A dynamic key resolver is invoked before any token component has been
   verified. Therefore an unverified `iss` may only exact-select an existing
   configured provider; it must never form a URL. Discovery starts from the
   deploy-time configured HTTPS issuer, exact-checks metadata `issuer`, then
   accepts that provider's `jwks_uri`. `jwtVerify` checks `iss` again after
   signature verification.
5. `createRemoteJWKSet()` is a key resolver, not OIDC discovery. Version 6.2.3
   defaults to 5 s fetch timeout, 30 s fetch cooldown, and 10 min cache age,
   coalesces an in-progress fetch, uses manual redirects, and requires HTTP 200
   JSON. Construct and reuse one instance per configured provider; recreating
   it per request loses cache/coalescing and enables fetch amplification.
   There is no JWKS response-byte-limit option, so DBZZ needs a
   destination-pinned custom fetch or equivalent bounded acquisition layer;
   bearer-token bytes are capped before unverified issuer decode.
6. Custom claim TypeScript types are not runtime validation. DBZZ must narrow
   them after `jwtVerify`. The primitive also does not implement a complete OIDC
   client/login flow (for example nonce and every ID-token-specific rule), so
   the built-in feature is accurately a configured JWT access-token
   resource-server verifier.
7. JWKS caching/rotation is not revocation. The existing hard expiry,
   introspection/session-epoch/revocation-store, and auth-epoch transition
   requirements remain unchanged.

Implementation implication: compile a trusted provider registry at startup,
prevalidate explicit/discovered JWKS destinations, keep one finite-timeout
resolver per issuer, exact-select it before network work, and call `jwtVerify`
with issuer, audience, algorithm, token-type, required-claim, and clock-skew
options. Map remote-key unavailability separately from invalid credentials in
safe telemetry, but fail authentication closed in both cases.

### Live identity and revocation

1. JWTs must not be accepted at or after `exp`, apart from a small configured
   skew. The server owns a hard connection expiry timer; it cannot rely on the
   client to refresh.
2. A successful refresh is an atomic validated identity replacement: pause
   authorized delivery, increment auth epoch, revalidate subscriptions, then
   transition or reset. A missing/invalid refresh removes the old identity or
   closes; it never leaves the previous principal active.
3. Stateless JWT validation cannot promise immediate revocation. DBZZ must
   choose short token TTL, online introspection/session epoch/revocation store,
   or provider back-channel invalidation. Cache and propagation time are part
   of the promised revocation bound.
4. Native browser WebSocket and EventSource cannot set arbitrary Authorization
   headers; native SSE is one-way. Use secure cookie/origin/CSRF controls,
   versioned in-band WebSocket auth, fetch-based SSE, or connection replacement.
   Never place bearer tokens in URLs.

Implementation implication: auth epoch is part of stream/cursor binding.
Expire and revocation tests must prove no authorized transition crosses epochs
and a prior cursor cannot replay data under a changed identity without fresh
authorization proof.

### OpenTelemetry bounds

1. The standard trace BatchSpanProcessor queue defaults to 2,048; full queues
   drop new spans. Default schedule/export/batch settings are 5,000 ms, 30,000
   ms, and 512. Export must not block indefinitely and failed batches are not
   retried forever by the default processor.
2. The log batch processor likewise defaults to a 2,048-record queue, 1,000 ms
   schedule delay, 30,000 ms export timeout, and 512-record batch. Synchronous
   emission should not block or throw into application work.
3. The metrics SDK default cardinality limit is 2,000 attribute sets per stream;
   excess measurements aggregate into `otel.metric.overflow=true` rather than
   allocating unbounded series.
4. Flush/shutdown has a deadline. DBZZ telemetry shutdown must be subordinate to
   the process drain deadline.

Implementation implication: configure finite queues/timeouts explicitly; expose
queue utilization, drops, overflow, exporter duration/outcome, and last success;
and keep essential aggregate health independent of sampled traces.

## Primary source register

| Topic | Official source | Published / observed |
| --- | --- | --- |
| SQLite WAL, recovery, checkpoints, current WAL-reset advisory | https://www.sqlite.org/wal.html | Updated 2026-04-13; observed 2026-07-13 |
| SQLite synchronous durability | https://www.sqlite.org/pragma.html#pragma_synchronous | SQLite pragma page updated 2026-06-04; observed 2026-07-13 |
| Checkpoint result/modes and integrity scopes | https://www.sqlite.org/pragma.html#pragma_wal_checkpoint and https://www.sqlite.org/pragma.html#pragma_integrity_check | Page updated 2026-06-04; observed 2026-07-13 |
| Online Backup API and completion | https://www.sqlite.org/backup.html and https://www.sqlite.org/c3ref/backup_finish.html | Backup page updated 2025-11-13; observed 2026-07-13 |
| `VACUUM INTO` and corruption-safe copying | https://www.sqlite.org/lang_vacuum.html#vacuuminto and https://www.sqlite.org/howtocorrupt.html | Updated 2025-07-12 / 2026-04-13; observed 2026-07-13 |
| Bun WebSocket pressure API | https://bun.sh/docs/runtime/http/websockets | Continuously updated; observed 2026-07-13 |
| WebSocket protocol order/reconnect | https://www.rfc-editor.org/rfc/rfc6455.html | RFC 6455, 2011-12 |
| WebSocket browser buffers | https://websockets.spec.whatwg.org/ | Living Standard; observed 2026-07-13 |
| SSE order, IDs, reconnect | https://html.spec.whatwg.org/multipage/server-sent-events.html | Living Standard; observed 2026-07-13 |
| Streams backpressure | https://streams.spec.whatwg.org/ | Living Standard; observed 2026-07-13 |
| HTTP rate/capacity overload | https://www.rfc-editor.org/rfc/rfc6585.html#section-4 and https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable | RFC 6585, 2012-04; RFC 9110, 2022-06 |
| JWT expiry | https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.4 | RFC 7519, 2015-05 |
| OAuth revocation and introspection | https://www.rfc-editor.org/rfc/rfc7009.html and https://www.rfc-editor.org/rfc/rfc7662.html | RFC 7009, 2013-08; RFC 7662, 2015-10 |
| OIDC token validation | https://openid.net/specs/openid-connect-core-1_0.html | Final 2014-11, errata incorporated; observed 2026-07-13 |
| OIDC discovery trust chain | https://openid.net/specs/openid-connect-discovery-1_0.html | Errata set 2, 2023-12-15 |
| JWT access-token profile | https://www.rfc-editor.org/rfc/rfc9068.html | RFC 9068, 2021-10 |
| `jose` JWT/JWKS API and tagged source | https://jsr.io/@panva/jose/doc and https://github.com/panva/jose/tree/v6.2.3 | `jose` 6.2.3, 2026-04-27; observed 2026-07-13 |
| OpenTelemetry trace/log/metric SDK bounds | https://opentelemetry.io/docs/specs/otel/trace/sdk/, https://opentelemetry.io/docs/specs/otel/logs/sdk/, and https://opentelemetry.io/docs/specs/otel/metrics/sdk/ | Continuously updated; observed 2026-07-13 |

## Wiki outputs

- `wiki/runtime/sqlite-production-durability-and-recovery.md`
- `wiki/realtime/bounded-realtime-delivery.md`
- `wiki/realtime/ordered-resume-or-reset-streams.md`
- Cascaded into the existing runtime feasibility, telemetry, authentication,
  and merged architecture articles; index and ingest log updated.
