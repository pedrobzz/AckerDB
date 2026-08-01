# Services are application-owned lifecycles

An application that integrates with the outside world owns resources the
request path never creates: an MQTT consumer, a BullMQ worker, a Kafka
subscription, a webhook manager. Each opens a persistent connection, lives for
the whole process, and must execute trusted application work when it fires.
Before this decision AckerDB had no owner for them. A plugin lifecycle receives
only its mount and an abort signal, and starts before the application Runtime
exists, so it has no system authority (ADR-0015) and no authority over the
application's own tables. Opening connections at manifest import scope is
unsafe, because code generation, migration planning, and schema tooling all
import the manifest. Replacing the CLI with a programmatic host works but
creates a second entry point that reimplements startup, signals, drain, and
reload.

We therefore introduce the **Service**: a named, application-owned lifecycle
that the CLI starts, supervises, and releases, and that receives the
application's own `SystemRunner` unchanged.

Services are declared in their own directory, not in the application manifest.
Two facts force this. Typed authority for application code is published by code
generation, and the generated module already imports the manifest to derive the
application's exact schema and mounted Plugin capabilities; a service declared
inside the manifest could never import its own typed authority without a
value-level import cycle and a circular type. Separately, every migration and
code-generation child process imports the manifest, so a manifest-declared
service would drag its broker client into schema tooling and run that client's
module scope there. A separate directory that only the serving path imports
keeps manifest inspection inert by construction. Services are named exactly as
function modules are addressed — module key joined with export name — so one
naming rule covers every application-authored file.

Ordering is the substance of the contract. Services start after storage,
migrations, plugins, and the Runtime are ready for trusted work, and before the
server admits its first request: `system.run` is live for every setup, and
readiness never describes a half-started application. They start sequentially in
one deterministic order. A setup failure releases every service already started,
in reverse, and fails startup with the failing service named; a partially
functional server is never published.

Shutdown reverses that order against one budget. The owner computes a single
absolute deadline, takes the server out of readiness and closes transport
admission, aborts every service signal, awaits every cleanup in reverse start
order, and only then drains. Because drain is what closes system-run admission,
cleanup still holds application authority and can finish or flush in-flight
work — the reason the transport gained a shutdown phase separable from drain.
Cleanup that outruns the shared deadline yields the ordinary deadline-exceeded
outcome and an unclean close rather than a hang, and the server drains even when
a service refuses to release, so the listener never outlives the engine.

Supervision stops there. A service reports a fatal post-setup failure once, and
that failure ends the application through the same path a termination signal
uses. AckerDB owns no restart policy, no backoff, and no dependency graph: the
process supervisor restarts processes, and no evidence yet shows one service
needing another. Per-service deadlines are likewise deferred; a service that
wants a tighter bound writes its own timer.

Plugin isolation is unchanged. A Plugin is an isolated capability with private
storage (ADR-0005) and keeps its own lifecycle; a Service is explicitly
application-owned and therefore may hold root application authority. Nothing
addresses a Service, and no client can call one.

## Considered options

- **Declare services in the application manifest**: rejected because typed
  authority would require an import cycle through the generated module, and
  because manifest imports happen in every schema-tooling child process.
- **Extend the plugin lifecycle with system authority**: rejected because
  plugins start before the Runtime exists and because it would hand isolated
  capabilities root authority over the host's tables.
- **Start listeners as manifest import side effects**: rejected because import
  happens without a live runtime, duplicates listeners across reloads, and
  carries no legitimate authority.
- **Keep a programmatic host beside the CLI**: rejected because a second entry
  point must reimplement startup, signal, drain, and reload ownership.
- **Ship restart policies and a dependency graph now**: rejected as
  orchestration the first primitive does not need; both remain addable behind
  the same declaration.

This decision implements [issue #150](https://github.com/pedrobzz/AckerDB/issues/150).
