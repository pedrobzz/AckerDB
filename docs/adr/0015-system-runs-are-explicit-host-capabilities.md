# System runs are explicit host capabilities

Trusted code in the same Bun process needs to compose AckerDB functions and
transactions without pretending to be a remote caller. The existing local
procedure path is protocol-shaped: it requires an address, serialized
arguments, request identity, principal, response encoding, and a separately
registered outer function. Direct Engine access avoids transport but also
bypasses application contexts, policy, admission, telemetry, publication, and
drain ownership.

We therefore expose one explicit capability on the programmatically running
application: `system.run(name, callback, { signal? })`. Possession of that
handle is the authority check. AckerDB creates no process-global current app,
ambient service locator, remote endpoint, shorter alias, or Plugin requirement.

Every call starts under Runtime's pristine execution snapshot with the frozen
system principal. Ambient request, session, transaction, MCP, realtime, and
user authority never cross into it. The callback receives the same underlying
procedure-context implementation used by HTTP procedures, including mounted
procedure capabilities, one invocation timestamp, an abort signal, and
`ctx.tx`. Identity-linking methods retain their ordinary user-principal checks;
system work never receives a fabricated user and those calls are denied.
When a run is started from transaction-owned async work, the callback still
starts pristine and may perform non-writer work, but writer operations in that
run reject. Writer work must begin in a run created after the caller's
transaction ends. This prevents the inner operation from waiting behind the
single writer slot held by the caller that is awaiting it.

The outer callback is not transactional. It may perform external I/O and call
registered procedures directly. `ctx.tx` opens the ordinary short transaction
and supplies the exact system-principal mutation context, including mounted
transaction capabilities and registered query or mutation composition.
Function Results keep their existing nested scope behavior: `Err` rolls back
its scope, while an escaping throw poisons the invocation root. Commits use the
normal writer, durability, publication, reactive invalidation, event, and
scheduled-wakeup paths.

Each run has one bounded, stable operation name. Qualified name segments begin
with a letter and obvious UUID or numeric identifier segments are refused so
per-call identifiers do not become telemetry dimensions. Runs share a bounded
system fairness identity, enter normal Runtime admission, and are never
retried, replayed, or deduplicated by the framework. Telemetry records one
system root plus nested application observations and distinguishes admission
rejection, application error, unhandled failure, indeterminate cancellation,
and success.

Caller cancellation is combined with Runtime shutdown. Cancellation before
entry is determinate; after application code begins, an external effect or
durable commit may already exist, so completion is reported as indeterminate
and the callback remains owned until it settles. Drain closes admission,
signals accepted system runs, waits for their ownership, and only then permits
Engine close. Programmatic startup owns no process signal listeners; the CLI
adapter retains SIGINT and SIGTERM ownership and invokes the same drain path.

## Considered options

- **Require a registered outer procedure**: rejected because trusted local
  orchestration is not an incoming endpoint.
- **Use a loopback HTTP or protocol call**: rejected because it invents
  transport, serialization, authentication, and response machinery.
- **Expose Runtime or Engine internals**: rejected because callers would bypass
  the application context and its correctness boundaries.
- **Install ambient system authority**: rejected because async scheduling would
  create a confused-deputy path and make delegation invisible.

This decision implements [issue #108](https://github.com/pedrobzz/ackerdb/issues/108).
