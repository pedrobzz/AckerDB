# Ordered realtime and mutation semantics

Protocol 2 separates durable state subscriptions from live event delivery.
Query subscriptions are authoritative state streams with resume-or-reset
convergence. Event subscriptions are ordered, bounded, live-only signals and
do not have durable replay.

Protocol envelopes require `v: 2` and exact framework-owned fields. A different
version is `unsupported_protocol`; missing, extra, out-of-range, or malformed
framework fields are `malformed`. There is no Protocol 1 compatibility or
best-effort negotiation layer.

## Query transition model

Every query subscription transition carries a `SubscriptionCursor`:

```ts
interface SubscriptionCursor {
  generation: string;
  commitVersion: bigint;
  authEpoch: number;
  identity: string;
}
```

`commitVersion` is the database-wide monotonic commit version. `identity`
binds the stream to the function, stable encoded arguments, and authorization
scope. `authEpoch` prevents replay under an older credential. `generation`
changes when the server can no longer prove a continuous history. A cursor is
therefore meaningful only as one complete value; clients must not compare only
its version.

| Transition | Contract |
| --- | --- |
| `reset` | An authoritative full value at `to`. `from` is null for a new stream or the cursor being replaced. |
| `update` | The value changed atomically from the exact `from` cursor to `to`. |
| `checkpoint` | The value is unchanged, but the stream advances from `from` to `to`. |
| `resume` | Positive proof that the supplied cursor is exactly the current cursor. No value is resent. |
| `revoked` | The old authorization epoch ended; carries a typed auth outcome and a new cursor boundary. |

Subscription installation evaluates a SQLite snapshot and coordinates it with
the publication high-water mark before attaching the listener. A commit that
races initial evaluation is either included in that evaluation or causes an
ordered later transition; there is no unchecked gap between snapshot and live
registration.

The client applies a transition only when `from` exactly matches its retained
cursor. Duplicate transitions whose `to` is already retained are ignored. An
unexpected predecessor makes the client request a `reset`; while waiting, it
does not apply speculative updates. `reset` replaces local state and restarts
the proven chain.

## Reconnect: resume when proven, reset otherwise

`DbzzClient` retains the latest query cursor in its bounded subscription state
and sends it again after reconnect. The server does one of three things:

- emits `resume` when it is already the exact current cursor;
- replays the exact retained `update`/`checkpoint` chain; or
- emits an authoritative `reset` when the cursor binding or complete chain
  cannot be proven.

Default retained history is finite: 64 transitions and 2 MiB per shared query,
30 seconds of age, and 128 MiB across the runtime. A transition too large to
retain rotates the generation and resets active listeners. Count, age, or byte
eviction makes older cursor chains unprovable, so a later reconnect from one of
those cursors receives a reset. History is in memory, so a server process
restart also converges by reset rather than claiming resume.

Reconnect delay uses exponential backoff with jitter: 100 ms base, 3 seconds
maximum window, reset after a stable 10-second connection, and a 30-second hard
cap that also honors bounded server `retryAfterMs` hints. Authentication
failures with a non-retryable outcome stop automatic reconnect until the
application supplies a new credential; retryable `auth_unavailable` follows
the ordinary bounded reconnect path.

## Mutation effects, replay, and read-your-writes

Each `DbzzClient.mutation(...)` request receives a UUIDv7
`mutationRequestId`, an `issuedAt` timestamp, and the client's stable
`clientSessionId`. The server stores the request identity, result, commit
version, and durability in the same SQLite transaction as the mutation. A
retry with the same complete identity returns the stored result with
`replay: "replayed"`; reuse with different principal, function, arguments, or
timestamp is a `conflict`.

This is exactly-once mutation effect within the retained idempotency boundary,
not exactly-once network delivery. The default ledger retains requests for 24
hours, up to 1,000,000 records, 4 GiB of encoded results, and 1 MiB per result.
An ID outside the retained time window conflicts; full capacity produces an
explicit overload outcome. The stock client preserves pending request identity
across its own reconnects, but does not provide a persistent offline request
store across client-process loss.

A successful mutation response includes:

```ts
interface MutationReceipt {
  mutationRequestId: string;
  commitVersion: bigint;
  durability: "production" | "balanced";
  replay: "executed" | "replayed";
  obligations: readonly number[];
}
```

`obligations` names the caller's active query-subscription IDs that must prove
they reached at least the receipt's `commitVersion`. `DbzzClient` retains the
mutation result but does not resolve its promise until all still-active
obligations have advanced. An unchanged query advances with `checkpoint`; a
changed query advances with `update` or `reset`. Unsubscribing explicitly
removes that local obligation.

If storage committed but ordered publication or required delivery cannot be
proven, the outcome is `convergence_unavailable` with `committed: true`. If a
sent mutation loses its response before any receipt is known, the client can
eventually report `indeterminate`; callers must not turn that into a new logical
mutation with a new request ID. The client retains a pending mutation for 24
hours by default and reports committed convergence expiry distinctly.

Pending one-off queries and mutations are resent over a re-established socket
within their retention deadlines. Procedures and SSE procedures are never
automatically retried: an interrupted procedure is `indeterminate` because it
may have performed an external side effect.

The read-your-writes gate is specifically the caller's active query
subscriptions named by the receipt. It is not persistent offline convergence,
cross-client causal consistency, or a distributed consistency guarantee.

## Live event ordering and gaps

`DbzzClient.subscribeEvent(...)` receives `row`, `gap`, and `reset` events with
a `LiveEventCursor` containing `generation`, `commitVersion`, and `sequence`.
The initial event is always `reset`; it establishes a live boundary and does not
contain historical rows.

Matching event rows emitted by committed transactions are delivered FIFO for
one subscription while its connection remains healthy. Their commit versions
follow ordered publication, and `sequence` increases for that subscription's
matching delivery positions. A matcher/delivery failure marks the listener
gapped; the next deliverable position is reported as `gap`. The client also
synthesizes `gap` instead of applying a row if its observed sequence or
generation is discontinuous. A `gap` is a loss marker, not a replay request:
the row at that position is not backfilled, and later matching rows continue
from the reported cursor.

Event cursors are not sent as resume cursors. Reconnect, auth reattachment, and
server restart begin with another `reset`; rows emitted while disconnected are
not replayed. Event rows are not stored in SQLite and carry no exactly-once
delivery guarantee. Use an event for transient notification and a query
subscription for reconstructible application state.

`sseProcedure` is a bounded procedural response stream, not the resumable query
or event subscription protocol. Its chunks have no subscription cursor or
automatic replay; reconnect means starting a new procedure call.

Each SSE event contains one strict Protocol 2 envelope:

```ts
type SseMessage =
  | { v: 2; t: "sse_chunk"; seq: number; proof: string; value: unknown }
  | { v: 2; t: "sse_done"; seq: number; proof: string }
  | { v: 2; t: "sse_error"; seq: number; proof: string; outcome: Outcome };

interface SseAckRequest {
  v: 2;
  t: "sse_ack";
  stream: string;
  seq: number;
  proof: string;
}
```

The initial response exposes a bounded stream capability in
`x-dbzz-sse-stream` and the server's finite receiver-credit deadline in
`x-dbzz-sse-max-stall-ms`. Sequence numbers start at one and must be exact;
duplicate, missing, future, malformed, or out-of-order frames fail the client
closed. A valid cumulative acknowledgement proves possession of the selected
frame's per-frame proof and releases server byte ownership through that
sequence. Forged, stale, future, and already-released acknowledgements are
oracle-free no-ops.

`DbzzClient.sse(...)` acknowledges an application chunk only when the async
generator resumes after yielding it. It acknowledges `sse_done` before
returning and `sse_error` before throwing its typed outcome. Acknowledgements
use the capability and proof rather than the bearer credential, have a simple
`text/plain;charset=UTF-8` request content type, and retry network or retryable
pressure failures with bounded full jitter and `Retry-After`. The deadline is
the smaller of the advertised server stall window and the client's 5-second
default `maxSseAckAgeMs`, with at most eight attempts. Missing or malformed
credit headers are protocol failures; there is no legacy `[DONE]` mode.

The server retains exact application and terminal frame reservations until a
valid acknowledgement, cancellation, or the terminal grace deadline. A merged
source is pulled only when its preceding frame is acknowledged, so at most one
merged application value is owned at a time. Direct writes may fill only the
finite per-stream and global application budgets. On an application stall, the
server uses separately reserved control capacity to emit a typed
`slow_consumer` terminal, then grants one final bounded acknowledgement window
before force-closing and releasing all ownership. This receiver-credit
contract does not depend on Bun's hidden HTTP socket buffering.

EOF before an acknowledged `sse_done` remains `indeterminate`, and EOF
mid-event is `malformed`. Procedures and SSE procedures are never retried
automatically. The acknowledgement proves that a peer holding the capability
received and parsed the frame according to Protocol 2; it is not proof that
application side effects derived from the chunk were durably committed. A
bearer credential lease remains held until the bounded response body completes,
errors, or is canceled.

## Client-side bounds

`DBZZ_CLIENT_LIMITS` defaults to 4,096 retained items, 16 MiB retained bytes,
30-second query age, 24-hour mutation age, 1 MiB frames, and a 1 MiB SSE input
buffer, plus a 5-second maximum SSE acknowledgement age. Capacity or deadline
failure is surfaced as a typed `DbzzClientError`; it is not an unbounded local
queue. Returning the iterator, aborting its signal, or closing the client
cancels every owned response/read boundary and releases the local reservation
without awaiting a hostile or stuck cancellation promise. Server-side limits
and outcomes are documented in [Operations](operations.md#production-limit-defaults).
