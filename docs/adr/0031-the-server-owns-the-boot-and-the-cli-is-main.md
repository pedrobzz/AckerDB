# The server owns the boot; the CLI is main

An AckerDB application boots in a fixed order — bind the listener, run codegen,
load the manifest and the migration chain, open storage, reconcile, mint the
Admin Credential, load the function and job modules, build the Registry and the
Runtime, activate. Until now the only place that knew this order was one
function inside the CLI package. `@ackerdb/server` exported the parts and a
second, incomplete assembly path (`serve`) that only tests used, so every
ordering guarantee — reconcile before modules load, credential before
application code, activate last — was a fact about one function's control flow
rather than about the framework. An embedder could not boot correctly without
copying `acker start`; a change to the Runtime or the Engine could silently
break a copy of the sequence elsewhere.

Two things made the copy actively wrong rather than merely misplaced. The
Runtime was "ready" the moment it was constructed and started working inside
its constructor: repeat Jobs were minted and the runner armed, File-cleanup
recovery began — before the Admin Credential was minted and before the listener
admitted traffic. And the boot-mint of the credential depended on the Runtime's
system capability for one transaction it did not need the Runtime for, which is
what forced "runtime ready before the server is ready".

The decision: **`@ackerdb/server` owns one boot — `boot(parts)` returns a
`RunningApp` — and `acker start` is a `main` around it.** The CLI reads
configuration, builds loaders and values, calls `boot`, and prints what the
reporter reports. Programmatic hosts call the same function. There is no second
composition root: `serve` is deleted, and the tests boot through the path
production uses.

## Loaders, not values, where the order is the point

Boot takes two loaders rather than two values. `load.app()` resolves the
manifest and the migration chain and runs before storage opens; `load.runtime()`
resolves function modules, Job modules, the optional credential verifier and the
optional scope resolver, and runs only after durable schema work and the
credential commit. That order is deliberate — unrelated runtime configuration
must never block a pending migration, and administration must never depend on
application code — and a value cannot carry a "when". Dynamic import of user
code stays with the host, which is the only party that knows the filesystem
layout; a test or an embedder wraps already-built values in a loader. One input
shape, no second "values" path.

## The Runtime has a quiescent state, and `start()` is the only way out of it

`Runtime` states are `created | ready | draining | stopped | failed`. The
constructor wires and performs no side effects; `start()` transitions
`created → ready`, begins File-cleanup recovery, mints the repeat Jobs and arms
the runner. In `created` every operation is refused by the readiness assertion
that already existed — including system runs; there is no special-cased
admission. `start()` twice is misuse and throws; `drain()` is valid from any
state. `server.activate()` is unchanged and therefore refuses a created
Runtime, and it does not call `start()` for you: an embedder without a listener
needs `start()` on its own, and hiding one step inside another obscures the
state machine.

`start()` awaits the Jobs bootstrap and propagates its failure. Before, that
failure was logged and the boot proceeded; a boot that cannot mint its own
repeat Jobs has a storage problem everything else will hit, so it is now
fail-fast, the same class as a failed reconcile.

## The credential is minted through the vault, before the Runtime exists

`ensureAdminCredential` takes the engine, the scope vocabulary, the credential
limits and a clock, and mints directly through the vault: one read on the open
engine so a boot with nothing to do writes nothing, then one immediate writer
transaction that re-checks and creates. At boot no Runtime exists, and the two
live-runtime concerns the shared credential orchestration carries — recording
the reactive read key, marking a token-bearing result one-time — have no
subject yet; break-glass already calls the vault directly for the same reason.
The invariant [ADR-0027](0027-the-admin-credential-has-one-definition-and-three-issuers.md)
states — the master is minted before any application code runs — becomes
structural instead of scheduled: the mint precedes `load.runtime()`, and nothing
arms before `start()`.

The rejected shape was a `created` state that admits system runs so the mint
could keep using `system.run`. That is a special case inside admission, and it
would keep the credential's existence dependent on the Runtime's construction.

## One signal, one drain, one reporter

Startup interruption was tracked four ways — an AbortSignal, a boolean, a
rejecting promise, and the listener's state — and two composition roots
drifted. Boot takes one AbortSignal, checks it at every phase boundary, and
races only work JavaScript cannot cancel (the caller's preparation, the loaders,
the FileStore probe) against it. Reconcile, the mint and `start()` are bounded
local transactions and are never abandoned. On interruption boot drains what it
built and rejects with the signal's reason; there is no dedicated interruption
error class. The CLI maps an aborted signal to exit 0.

`RunningApp.drain()` lives in the boot module and is the owner: begin listener
shutdown, drain the listener (which drains the Runtime when activated) or both
when not activated, then close the engine with the clean/unclean disposition.

Phases, reconcile lines and the credential flow through a small reporter with
three optional callbacks, invoked synchronously at the moment the thing
happens. The CLI prints its `[ackerdb] …` lines from them, including the token
before the shutdown check, so stdout is byte-for-byte what it was. Boot itself
never writes to stdout. The reporter is the natural attachment point for later
boot events; nothing here commits to a plugin API.

## Consequences

- Phase order is `listening → codegen → loading → opening-storage →
  migrating | reconciling → issuing-credential → loading-runtime →
  starting-runtime`, then activation. `issuing-credential` moved before
  `loading-runtime`; `starting-runtime` is new. With the mint before module
  import, a token can be printed for a boot that then fails on import — which is
  today's semantics after any post-mint failure: the next boot prints nothing
  and the printed token is valid.
- The hold gate (`pendingMigrations: "hold"`) peeks the stored migration
  history read-only before opening storage and rejects with
  `MigrationsHeldError` carrying the pending count. The read-only peek moved
  from the CLI into the server; the CLI's plan and write commands use it from
  there.
- The boot-mint spends no logical commit version: it is a framework write
  outside the coordinator's commit path, like the FileStore binding and
  break-glass. A fresh database still spends Identity 1 on the master.
- `serve` and its options type are gone. Suites that build a Runtime by hand
  start it and put it on a listener through a test-support helper; production
  hosts boot.
- The CLI's `startApp` keeps its name and options; its body is config → parts
  → `boot`, and its programmatic startup tests move to the server's boot suite
  while the process-level `acker start`/`acker dev` tests stay as the
  behavioural-equivalence proof. `StartupInterruptedError` is gone. Signal
  handling stays in the CLI, per
  [ADR-0015](0015-system-runs-are-explicit-host-capabilities.md).
- The FileStore instance and its physical identity are values the CLI builds
  before calling `boot`, so the local store's identity marker is written (and
  the S3 adapter imported) before the listener binds rather than at
  `opening-storage`. A held dev boot therefore leaves the marker behind; the
  identity is the same one every later boot reads.
- The CLI's orchestration shrank by roughly a third; the boot module and its
  types are about as long as what they replaced, so production line count is
  roughly flat rather than negative. The point of the change is ownership, not
  size.
