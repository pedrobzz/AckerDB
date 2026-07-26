# Plugins are isolated capabilities assembled by the application

AckerDB backend extensions are named Plugin instances that own private state and
functions and expose only a declared server-side capability contract. The
application assembles its root schema and every Plugin instance in one
executable `app.ts` manifest; Plugins never mutate a global registry or gain
implicit access to application state. This takes the useful isolation property
from systems such as Convex while keeping AckerDB's direct context API and explicit
dependency injection.

## Consequences

`definePlugin({ id, schema, create })` defines an ordinary TypeScript Plugin
factory. Its static private schema belongs to the definition, while each unique
manifest mount owns an isolated instance of that schema. A mount becomes a
direct capability such as `ctx.cache`; it is never nested under `ctx.plugins`,
automatically exposed to clients, or allowed to collide with a built-in context
field. Plugin packages require no private code generation: only the host
application generates bindings for the assembled graph.

Dependencies are explicit references to already-mounted instances and are
checked against the capability contract the consumer needs, not the provider's
concrete definition identity. A dependency appears under the consumer's local
slot name, grants no access to private state, and is not automatically
re-exported. The contract owns the consumer-facing call adapter and compatibility
metadata. Compile-time provider compatibility compares only the operation kind,
canonical accepted input, and canonical produced result; provider-normalized
handler input is private. The provider's own operation validator remains the
runtime authority for validation and normalization, while assembly proves exact
descriptor equality. Assembly rejects duplicate mounts, missing providers, and
cycles. There is no global lookup, implicit installation, inheritance, or
service container.

Plugin calls preserve the caller's execution boundary. Transactional reads and
writes use the caller's existing database context; the Plugin boundary itself
does not add a Result wrapper or child savepoint in the current contract. As
recorded by
[ADR 0011](0011-function-results-own-application-errors-and-mutation-scopes.md),
changing Plugin operations to the application Result contract is a separate
breaking Plugin API change. A direct procedure call is independent unless the
caller explicitly opens a transaction. External capabilities are
procedure-only.
Plugins receive no ambient application authentication context, so identity and
claims cross the boundary only as validated arguments.

Application manifests and Plugin construction are pure because AckerDB imports
them during code generation and runtime startup. Runtime resources use an
explicit AckerDB-managed lifecycle: dependencies and private schemas become ready
before startup, cancellation is propagated, startup failures tear down already
started resources, and shutdown runs in reverse dependency order.

The v0.6.0 alpha has no Plugin migration API. AckerDB reconciles safe private-schema
changes; an unsafe change requires explicit consent to reset only the affected
mount. Non-interactive startup refuses until `acker plugin reset <mount>` is run.
Changing a mount name creates a fresh instance, and removing the old mount
requires an explicit `acker plugin drop <old-mount>`; AckerDB never guesses renames
or preserves Plugin data through compatibility machinery.
