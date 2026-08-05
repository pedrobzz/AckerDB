# CONTEXT

Glossary of domain terms. Definitions only — no implementation details.

## Engineering philosophy

**Product performance** — Completing useful work quickly while remaining
predictable, economical, and safe at the intended load—not a narrow throughput
result that saturates a host.

**Default deployment envelope** — The default machine size AckerDB optimizes for:
4 vCPU / 4 GiB RAM.

**Design load** — Near-term sizing for the default deployment envelope: about
5,000 MAU with roughly 10% concurrently active (~500 connections with multiple
subscriptions).

**Minimal proportional cost** — CPU/RAM growth that stays in proportion to
connections, users, subscriptions, and updates, at the smallest practical
per-unit cost.

**Performance vector** — The dimensions used to judge a change: useful
latency/throughput, idle cost, memory ownership, scale shape, tail behavior,
startup/recovery, and durable correctness.

**Correctness** — Preservation of data and explicit uncertainty, a coherent
navigable design, and deliberate handling of severe credible edge cases.

**Design wall** — A case where a specification, assumption, test, or
integration does not fit the current model.

**Implementation safeguard** — Machinery the intended contract needs to
enforce an invariant (transaction, validation, bound, typed outcome, explicit
migration transform). Implementation, not a patch.

**Deferred-design workaround** — Narrow temporary behavior that exists only
because the known correct design is deferred.

**Accidental patch** — A special case, shim, parallel path, alternate channel,
compatibility layer, or test dodge added to avoid changing a wrong model.

**Severe credible edge case** — A low-frequency event whose realistic impact is
data loss, corruption, unbounded resource use, or a material customer failure.

**Net-effect judgment** — Scoring a decision against the simplest design that
still satisfies the required invariant, not against the decision's stated
purpose.

**Simplest sufficient design** — The implementation with the fewest mechanisms
that still enforces the required invariant. AckerDB does not add machinery merely
to imitate another system or erase an acceptable backend difference.

## Function outcomes

**Function result** — The typed outcome of a registered query, mutation, or
procedure call. Success is `Ok<T>` and an expected application failure is
`Err<E>`; handler authors may return a raw success value as `Ok` sugar.
_Avoid_: Transport response, thrown exception

**Query procedure** — A procedure observed as repeatable, query-shaped client
demand. Equal demand shares executions, while idempotence remains an
application-owned promise rather than a distinct enforced function kind.
_Avoid_: Reactive query, idempotent procedure

**Application error** — An expected typed failure that application code
deliberately returns as `Err`. It is part of the function's result contract and
may be handled or mapped by its caller.
_Avoid_: Thrown error, framework failure

**Error mapping** — A function seam's deliberate replacement of selected
application-error variants with errors in its own vocabulary. Unmapped variants
remain part of the inferred result contract unchanged.
_Avoid_: Error swallowing, exhaustive redeclaration

**Unhandled failure** — An unexpected thrown defect or framework failure that
bypasses the application result contract. It poisons any ambient transaction
and is exposed outside the server only as a sanitized generic failure.
_Avoid_: Application error, returned `Err`

**Nested mutation scope** — The atomic child scope owned by every nested
registered application mutation. `Ok` merges its writes into the parent, `Err`
discards them, and an unhandled failure poisons the whole ambient transaction.
Plugin operations retain their separate pre-Result contract until that API is
changed explicitly.
_Avoid_: Independent transaction, ordinary helper call

## Framework runtime

**Plugin** — A reusable backend unit that owns isolated state and functions
and exposes a declared capability contract. A plugin never implicitly
extends its host's schema or gains access to host state.

**Application manifest** — The application's single executable assembly point,
declaring its root schema and named plugin instances. Operational settings
remain outside the manifest.
_Avoid_: Plugin registry, plugins file

**Service** — A long-lived external resource an application owns for one
process generation: a broker consumer, a job worker, a webhook subscription.
Unlike a plugin it is not isolated—it holds root application authority and
executes trusted work through system runs. Unlike a function it has no address
and no client can call it. The framework starts it, supervises it, and releases
it; it never restarts it.
_Avoid_: Background job, daemon, worker plugin

**Service module** — A file in the application's service directory. Its path
and export name give each service its exact name, exactly as function modules
are addressed. Only the serving path imports these modules, so code generation
and schema tooling never open a service's external connection.

**Process generation** — One running application process, from the moment
services start to the moment their cleanups finish. Every declared service
starts exactly once per generation, and a development reload fully ends one
generation before beginning the next.

**Plugin instance** — One configured occurrence of a plugin in an
application. Each instance has its own identity and isolated state, even when
several instances come from the same plugin definition. Every instance must
be named exactly once in the application manifest's `plugins` object;
dependency injection references that mount and never installs an instance.

**Plugin factory** — An ordinary typed TypeScript function that creates a
configured plugin instance. `definePlugin({ id, schema, create })`
returns this callable factory directly; the pure `create` callback receives
schema-bound function builders and returns the exported capabilities and any
lifecycle declaration. Plugin packages ship their source contract, not
plugin-specific generated bindings.

**Plugin definition identity** — The stable package-level name shared by
every instance and version of one plugin definition. It anchors the
definition's one static private schema identity. Factory options cannot select
or mutate a schema variant.

**Plugin mount** — A plugin instance's unique key in the application
manifest's `plugins` object. The mount names its server capability and
persistent private state, and becomes a direct property on every eligible
function context. It cannot collide with a built-in context field. In the alpha,
changing the key creates a fresh mount; removing the old mount requires an
explicit private-data drop.

**Plugin dependency** — An explicit reference to another plugin
instance's declared capabilities. The reference grants no access to the
dependency's private state or implementation, does not create another mount,
and is valid only when the referenced instance is mounted explicitly. A
definition declares each dependency under a local slot name; that slot becomes
a direct field on the plugin function context and is not re-exported.

**Capability contract** — The typed operations and execution kinds a plugin
dependency requires. Dependency injection targets this contract rather than a
specific plugin definition identity. The contract owns the consumer's exposed
call shape and compatibility metadata. Provider wiring compares canonical input
and result semantics, not the provider's normalized handler input; the selected
provider still owns runtime argument validation and normalization before its
handler runs.

**Plugin capability** — A plugin's declared server-only interface for
its host and dependent plugins. A mount named `cache` is used as `ctx.cache`,
not `ctx.plugins.cache`. Mounting a capability never creates a
client-callable endpoint; the application must expose any client operation
through its own function.

**Exported plugin function** — A plugin-owned query, mutation, or
procedure returned under `exports` by its plugin factory. The runtime binds
it under the plugin's mount name while preserving its execution kind and
isolation.

**Plugin call** — Invocation of an exported plugin function through a mounted
or injected capability. Queries and mutations use the caller's database context
without adding a Result boundary or child savepoint. A procedure call starts an
independent operation when no transaction exists.

**Internal plugin function** — A plugin-owned function omitted from its
factory's returned `exports`. Only the plugin itself may invoke it.

**Plugin authority** — Identity or claims explicitly passed to a plugin
function by its caller. A plugin never inherits the application's
authentication context implicitly.

**Invocation timestamp** — Unix time in milliseconds captured once when a
top-level function begins execution. Nested application functions, plugin
functions, and transactions inherit the same value explicitly as
`ctx.timestamp`.

**Application log record** — A developer-authored diagnostic message with
structured metadata, registered at its call site independently of the function
result and any application transaction. Its occurrence time and order describe
application execution, not later persistence.
_Avoid_: Transactional log, telemetry event

**Application log order** — The total call-site registration order of
application log records within one process generation. Persistence batching
preserves this order across concurrent function executions.
_Avoid_: Persistence order, timestamp order

**Analytics event** — A named occurrence of product behavior with structured
properties and the caller's durable Identity when one exists. It describes what
a user or application did rather than the diagnostic severity of application
execution.
_Avoid_: Application log record, log event

**Telemetry value** — A portable value shared by application-log metadata and
analytics-event properties: null, text, numbers, booleans, big integers, bytes,
arrays, and objects composed recursively from the same values.
_Avoid_: Arbitrary JavaScript value, provider-native value

**Telemetry journal** — The bounded local durable record of application logs
and committed analytics events. It is independent of application state and is
the common source consumed by telemetry exporters.
_Avoid_: Application table, exporter queue

**Telemetry exporter** — An isolated adapter that delivers the signal kinds a
provider represents without changing application execution or other exporters.
_Avoid_: Telemetry provider, application integration

**System execution root** — Trusted application work initiated directly by an
in-process host that explicitly holds the running application's system
capability. Each run begins with only the canonical system principal, may use
procedure capabilities and external I/O outside a transaction, and may open
short Result-aware transactions. It never inherits ambient caller authority or
pretends to be a request, session, or registered outer function.
_Avoid_: Local procedure call, background job, ambient system context

**Plugin schema reset** — The v0.6.0 alpha recovery for an unsafe private
schema change. After explicit operator consent, AckerDB deletes only that mounted
plugin's private data and recreates its current schema. Safe changes
reconcile without data loss; plugins have no migration API or history in
this alpha. Development may request consent interactively; non-interactive
startup refuses until `acker plugin reset <mount>` is run explicitly.

**Plugin lifecycle** — The AckerDB-managed startup and shutdown boundary for a
plugin's external resources. Plugin construction is side-effect free;
resources start only after dependencies and private schemas are ready and stop
in reverse dependency order.

**Transactional capability** — A plugin capability whose work participates
in the caller's database transaction. It may be available to queries and
mutations, with each function receiving only the operations its execution kind
permits.

**External capability** — A plugin capability that crosses the AckerDB process
boundary to another service. It is available only to procedures and never from
inside a database transaction.

**Cache** — Disposable key/value acceleration whose contents are never a
source of truth. Clearing every entry may reduce performance but cannot change
an application's correct result or behavior.
_Avoid_: Durable store, key/value database

**Cache expiration** — The point after which an entry is a cache miss,
regardless of whether its stored bytes have been reclaimed. Physical deletion
is bounded cache maintenance, not scheduled application work. `set` replaces
the previous deadline. For the built-in store, a positive safe-integer duration
produces `ctx.timestamp + expiresInMs` and is compared with the frozen
invocation timestamp. External stores receive the duration and use their native
clock. Omitting the duration means no deadline in either case.

**Invalid cache expiration** — An `expiresInMs` that is zero, negative,
fractional, non-finite, unsafe as an integer, or would produce an unsafe
built-in deadline. It throws `InvalidCacheExpirationError` before the Cache
store is called.

**Cache capacity** — The finite logical-byte and entry-count budget owned by a
built-in cache instance. It defaults to 64 MiB total, 1 MiB per normalized key
plus encoded payload, and 10,000 entries. All limits are configurable but never
unlimited. Every entry remains evictable under capacity pressure, including
entries without an expiration deadline. The budget is shared across all
namespaces in that instance.

**Cache entry too large** — A `set` whose normalized key and encoded payload
exceed the instance's per-entry limit. It throws `CacheEntryTooLargeError`;
`set` returns `false` only when its atomic `if` condition is not satisfied.

**Cache eviction** — Capacity reclamation that removes expired entries first
and then entries in oldest-write order. Reads never update eviction metadata.

**Cache maintenance** — Bounded physical reclamation performed by the built-in
store on its write path. Cache reads never delete, update metadata, start a
timer, or perform a background sweep; external stores own their physical TTL
and eviction machinery.

**Cache API** — AckerDB's small TypeScript-native interface for key/value cache
operations, expiration, and conditional writes. Its semantics are familiar to
Redis users, but it is not a Redis command or protocol compatibility surface.
It is not a query capability: AckerDB queries read the source database directly.
_Avoid_: Redis client, Redis-compatible API

**Cache store** — The backend-independent storage contract required by a cache
plugin instance. The built-in store uses plugin-owned AckerDB storage;
external stores cross the procedure-only capability boundary. A custom store is
defined by `defineCacheStore({ keyPrefix, open })`; `open` returns only `get`,
atomic conditional `set`, `delete`, and an optional `close`.

**Cache-store adapter** — A bridge from an external cache service or client to
the Cache store contract. It owns vendor serialization and semantics without
exposing the vendor client through AckerDB. Every external adapter requires an
explicit application-and-environment key prefix; Cache appends its encoding
version, plugin mount, namespace, key type, and key. AckerDB owns the adapter's
resource lifecycle.

**Cache package** — The lockstep `@ackerdb/cache` package. Its root exports the
Cache plugin and store-authoring contract; `@ackerdb/cache/redis` and
`@ackerdb/cache/upstash` expose first-party adapters without creating separate
packages or vendor-specific context APIs.

**Cache namespace** — A named key partition declared by a cache plugin
instance with one value contract. It is only a typed validation and key-prefix
facade: it adds no capacity, eviction, lifecycle, or storage boundary. A stored
value that no longer satisfies the contract is a cache miss and may remain
physically stored until ordinary eviction.

**Cache key** — A string, finite number, or bigint normalized to its textual
representation with an internal type tag within one cache namespace. Strings,
numbers, and bigints with the same visible text remain distinct; numeric `0`
and `-0` intentionally share a key. Compound identity is an explicit string
composed by the caller.

**Cache payload** — A cache value encoded exactly once with the AckerDB wire
format before it reaches a Cache store. Stores treat the encoded string as
opaque and return it unchanged for decoding.

**Cache miss** — The absence of a usable cache entry, represented by
`undefined`. `null` remains a valid cache value, including for negative caching.

**Cache presence** — A non-expired encoded entry exists at the normalized store
key. Atomic `set` conditions test presence before decoding or namespace
validation, so a malformed or namespace-invalid entry may be present while
`get` reports a cache miss. An unconditional `set` replaces it.

**Cache deletion** — One store operation that physically removes the encoded
key without decoding its payload. It returns whether the entry was live at the
invocation timestamp: malformed and namespace-invalid live entries return
`true`, while an expired row is reclaimed but returns `false`.

**Cache store failure** — A storage, transport, timeout, authentication, or
connection failure reported as `CacheStoreError` with its original cause. It is
never converted into a miss or conditional result; callers choose explicitly
whether to catch it and fail open.

## File storage

**File** — Immutable AckerDB-owned stored bytes, their fixed framework metadata,
and their immutable optional owner, identified independently of the application
records that refer to them. Replacing the bytes creates a different File.
_Avoid_: Attachment, blob row

**File owner** — The durable user identity captured from the File upload
session's creator, or explicitly supplied by trusted server-side code. Ownership
is searchable File state but does not itself grant retrieval authority.
_Avoid_: Uploader metadata, File authorization

**Pending File** — A successfully stored File awaiting its first durable
application claim. A pending File expires if no application row claims it and
may be claimed explicitly when it is intentionally standalone.
_Avoid_: Temporary upload, orphaned File

**File upload session** — Short-lived, constrained authority to store at most
one File. Failed attempts may retry until one File is stored successfully or
the session expires.
_Avoid_: Upload URL, presigned upload

**File grant** — Independently revocable authority to retrieve one File under
declared access conditions. Revoking a grant does not delete the File.
_Avoid_: File URL, public file

**Bearer File grant** — A File grant for which possession of its unguessable
URL is the complete retrieval authority; no user principal is required.
_Avoid_: Public File grant

**Authenticated File grant** — A File grant that admits any request carrying a
valid AckerDB user principal without making an application-specific access
decision.
_Avoid_: Private File grant

**Validated File grant** — A File grant whose every retrieval must be admitted
by an application-owned read decision under the request's current principal and
the grant's typed authorization arguments.
_Avoid_: Private File, authenticated URL

**File reference** — An application-owned relation from an ordinary typed row
to a File, declared explicitly by that row's schema. It owns searchable business
metadata and application relationships instead of extending the File's
framework metadata.
_Avoid_: Custom file column, file metadata

**Execution root** — The execution context a runtime subsystem owns and runs
its work under when that work is performed on its own behalf rather than a
caller's — e.g. the reactive system re-evaluating subscriptions for
subscribers. Work a caller triggers never carries the caller's context into
another subsystem's execution root; anything that must cross a scheduling
boundary crosses explicitly.

**Subscriber-facing work** — Runtime work that executes application code on
behalf of a subscriber (re-running a subscribed query, matching an event
listener). Always runs under the reactive system's execution root, under the
subscriber's own principal — never under the identity or context of whoever
triggered it.

## Realtime communication

**Application channel** — A typed bidirectional application communication
contract. A channel may opt into room partitioning; an unroomed channel has no
room membership concept.
_Avoid_: WebSocket, provider session

**Channel event** — A named typed message sent in one direction through an
application channel. React observers may handle channel events through a named
handler map or one discriminated-union handler without changing the event
contract.
_Avoid_: Raw WebSocket message, database event

**Channel send outcome** — The local result of offering one client event to the
current application-channel transport. Success does not claim that the server
received or processed the event; failure leaves no event queued for reconnect.
_Avoid_: Server acknowledgement, handler result

**Channel delivery audience** — The recipients selected by one server-side
channel operation. A handler may send to its current member, publish to every
member of its current channel or room including itself, or use an explicit
server-only operation to publish to another typed channel subscription.
Client events cannot name a delivery audience independently of the subscription
that carried them.
_Avoid_: Client-selected room, implicit sender exclusion

**Room** — An opt-in membership boundary within one application channel. Every
membership in a roomed channel names exactly one room; room identity and
membership never cross into another channel, and clients cannot join all rooms
through a wildcard.
_Avoid_: Channel, provider session

**Channel membership authorization** — The optional application decision made
before one client joins an application channel or room. It runs under the
current authenticated principal and may reject with a typed error or establish
typed ephemeral membership state for subsequent channel handlers. Authorization
is evaluated again after reconnect or authentication change; prior membership
state is never trusted across either boundary.
_Avoid_: Connection authentication, durable session

**Channel subscription** — One shared client-lifetime membership identified by
an application channel, canonical arguments, and its optional canonical room.
One or more local observers may retain it without creating additional server
subscriptions.
_Avoid_: Hook instance, WebSocket connection

**Channel observer** — One local consumer of a channel subscription, with its
own message and lifecycle handlers. Every matching delivery reaches each
observer once, independently of the other observers' behavior.
_Avoid_: Channel subscription, server subscriber

**Handler key** — An optional identity that coalesces one complete local `on`
handler namespace without comparing function identity. It never changes
network identity or ownership. Channel subscriptions may retain independent
keyed handler bundles. A realtime hook call without a key is exclusive; a keyed
realtime session may be retained only by calls carrying the same non-null key.
A missing or conflicting key is programmer misuse rather than another peer.
_Avoid_: Hook ID, idempotency key, subscription key

**Realtime session** — One AckerDB-relayed WebRTC peer session between an
application client and its server handler. Typed application events use WebRTC
data channels while audio and video use native WebRTC media tracks.
_Avoid_: Application channel, provider-direct connection, media WebSocket

**Shared realtime session** — One client-lifetime realtime session identified
by a realtime reference and canonical arguments. Multiple local observers retain
the same peer connection, typed event delivery, and attached media tracks
instead of creating duplicate sessions or transmissions.
_Avoid_: Realtime hook instance, channel subscription

**Realtime session demand** — The committed local ownership that keeps a shared
realtime session alive: retained framework handles and committed React
observers. Tracks, data channels, and typed byte streams belong to that session
generation; they do not independently keep it alive after its final owner
releases. The session closes following only the standard deferred-microtask
grace used to absorb React Strict Mode cleanup and remount.
_Avoid_: Warm-session timeout, render-attempt ownership

**React realtime activation** — Declarative realtime demand created by
committed hooks with real arguments. Passing the shared `skip` sentinel creates
no observer and no session; changing from `skip` to arguments activates demand,
while changing back releases it.
_Avoid_: Render-time connection, hook-owned transport

**Realtime session handle** — A framework-neutral retained owner of a shared
realtime session. `release` removes only that owner's demand, while an explicit
`disconnect` terminates the shared session for every owner and suppresses
automatic recovery until `reconnect` starts a new generation; React hooks
acquire and release the same ownership declaratively.
_Avoid_: Hook instance, exclusive connection

**Realtime recovery classification** — The distinction between failures that
may recover while session demand remains and failures that require a meaningful
application change. Network, ICE/DTLS, temporary signaling, server restart, and
overload failures recover with bounded backoff; authorization, validation,
protocol, capability, and handler failures remain terminal until explicit
reconnect, a relevant authentication change, or different session arguments.
No recovery replays prior events or media.
_Avoid_: Blind reconnect loop, permanent network failure, replay

**Realtime recovery generation** — One replacement attempt after a peer can no
longer recover in place. A transient disconnected state first receives finite
native grace, then one managed ICE restart with refreshed deployment
configuration and a deadline. Continued failure replaces the complete
generation: authorization and handler setup run again, while prior typed
events, media, provider state, and partial byte streams do not cross the
boundary.
_Avoid_: Resumed peer, replay generation, immortal ICE restart

**Realtime session phase** — The exhaustive shared-session lifecycle observed
by React: `disabled`, `connecting`, `connected`, `reconnecting`,
`disconnected`, `rejected`, or `failed`. A rejected phase carries the declared
authorization application error; reconnecting and failed phases carry their
typed client error. The current native peer is exposed when one exists, and is
guaranteed in the connected phase.
_Avoid_: Boolean connected flag, raw peer connection state

**Realtime observer** — One local consumer of a shared realtime session, with
ordinary component-local React state. Multiple consumers retain the canonical
session keyed by client, realtime reference, and arguments while owning their
state listeners and handler observations independently. AckerDB does not merge
or replay transcript history, message aggregation, or other application state;
applications use their own store or context when that state must be shared.
_Avoid_: Provider session, realtime connection

**Realtime handler observation** — One `on` callback bundle registered against
a retained shared session. Each observation runs setup once per peer generation
and owns its matching cleanup; releasing it cannot remove another consumer's
handlers or peer ownership. Future events and peer lifecycle notifications fan
out to every active matching observation, without replay.
_Avoid_: Handler key, handler claim, function-identity deduplication

**Realtime observer callback namespace** — The `on` object for one realtime
handler observation. `on.peerConnection` runs for each native peer generation
before its initial negotiation, may await native media setup, and may return
generation cleanup;
`on.connected` reports that generation's actual connected state;
`on.track` observes the native `RTCTrackEvent` for each remote track without
creating another media subscription; `on.stateChange` receives each future
transition of the exhaustive AckerDB session-phase union without replaying
earlier transitions; `on.event` is either the typed event-handler map or the
discriminated-union event handler; and `on.stream` applies those same two forms
to incoming typed byte streams. Each incoming stream is offered to the first
matching active observation so the transport retains one bounded consumer.
Explicit `ReadableStream.tee()` is the application's opt-in to multiple
consumers. The hook snapshot, rather than a lifecycle callback, is the source
of current state.
`RealtimeOn<typeof realtimeRef>` derives the entire namespace from the
generated reference's existing type metadata without additional handler
code generation.
_Avoid_: Track declaration, conflated setup and connected event

**Realtime signaling** — AckerDB-owned signaling for each WebRTC generation.
Initial offer, answer, and ICE trickle use an established HTTP POST/PATCH shape.
After the reliable internal data channel opens, later descriptions and
candidates travel as internal control frames on that channel. No WebSocket,
second socket, or permanent HTTP polling loop participates. AckerDB services
the native `negotiationneeded` event through serialized perfect negotiation so
ordinary peer mutations do not require application signaling.
_Avoid_: Application signaling, media-signaling WebSocket

**Realtime peer configuration** — The standard `RTCConfiguration` installed by
AckerDB from deployment-level reachability configuration before
`on.peerConnection` runs. Internal signaling supplies standard `RTCIceServer`
entries and short-lived credentials; the React hook has no ICE or TURN option.
An advanced observer may inspect or replace the configuration through the
native peer's `getConfiguration` and `setConfiguration` before initial
negotiation.
_Avoid_: AckerDB-specific ICE options, signaling callback

**Realtime server network policy** — Deployment-owned native candidate policy:
allowed host interfaces, ignored adapter classes, UDP port range, one-to-one
advertised-address mappings, and optional libwebrtc ICE timing overrides. It is
resolved and validated once at Runtime startup and never belongs to an
application realtime definition or client hook.
_Avoid_: Route network option, hook network option, per-session host policy

**Realtime TURN service** — Deployment infrastructure that makes AckerDB
realtime sessions reachable when a direct ICE path is blocked. Production must
support standard external UDP and TURN/TLS services without changing
application code. AckerDB mints principal-bound coturn REST credentials from a
deployment secret; the coturn relay process remains infrastructure rather than
an application API. Credential issuance, rotation, native configuration
updates, and required managed ICE restarts belong to AckerDB rather than
individual realtime definitions or hooks.
_Avoid_: Hook TURN option, application credential callback, parallel media backend

**Realtime native resource budget** — The finite process-wide ownership of
auxiliary peers, decoded frame streams, generated media sources, and native
track wrappers/clones, combined with per-generation peer, stream, handler, and
media limits. Admission claims capacity before retaining the native resource;
explicit close, stop, or generation cleanup releases it exactly once.
_Avoid_: Best-effort native cleanup, unbounded track registry, preallocated capacity

**Realtime health sample** — A bounded rotating observation of a small number
of active peer generations, collected by the existing Runtime telemetry tick.
It reports aggregate selected-path, loss, jitter, RTT, bitrate, buffering,
pressure, media-flow, and native queue information without retaining SDP,
candidates, addresses, credentials, or a per-peer background polling loop.
_Avoid_: Realtime packet log, peer inventory, independent stats timer

**Realtime native packages** — `@ackerdb/realtime` owns the generated NAPI-RS
loader and declarations but no native binary. Five optional, host-filtered
packages each own one verified Darwin arm64/x64, Linux GNU arm64/x64, or
Windows x64 binary. Their binding source is one immutable AckerDB libwebrtc
fork commit based on a recorded LiveKit upstream revision; target-specific
Google libwebrtc archives are separate digest-verified LiveKit build inputs.
Per-target and aggregate manifests, SHA-256 digests, notices, and SBOM define
the published boundary. Every target is built before publication; runtime
execution is a separate platform-support claim.
_Avoid_: Runtime download, host-only publish, local crate patch, LiveKit server dependency

**Realtime peer ownership** — The boundary on the platform
`RTCPeerConnection` exposed to a client and the W3C-shaped peer backed by
bundled native libwebrtc on the server. Applications own supported tracks,
transceivers, senders, raw data channels, event listeners, and pre-negotiation
configuration; AckerDB owns session descriptions, remote ICE candidates,
candidate transport, and negotiation sequencing. A server capability not yet
exported by the native binding fails explicitly instead of being silently
stubbed. Calling either peer's `close` deliberately disconnects the shared
session for every owner just like the session's `disconnect`.
_Avoid_: AckerDB media vocabulary, silent peer stub, application signaling

**Realtime session authorization** — The optional application admission
decision made under the AckerDB client's current authenticated principal before
allocating a server peer. It may reject with a typed connection error or
establish typed ephemeral state for the realtime handler. Every recovered peer
generation authorizes again, and an authentication-epoch change replaces the
old generation rather than changing its identity in place.
_Avoid_: Provider token, client-supplied signaling credential

**Realtime event send outcome** — The local result of offering one typed event
to the realtime session's current data channel. Success does not claim that the
server received or processed the event; failure leaves no event queued for
recovery.
_Avoid_: Server acknowledgement, handler result

**Realtime typed event channel** — The single AckerDB-owned reliable, ordered
WebRTC data channel carrying the realtime protocol's validated client and
server events. Its delivery mode is not configurable.
_Avoid_: Raw data channel, configurable hidden channel

**Realtime binary value** — A first-class `Uint8Array` field in one atomic
typed realtime event, encoded as binary data-channel data without requiring
application-level base64. The complete encoded event frame is limited to 16
KiB and fails explicitly above that limit rather than being fragmented
silently. Browsers use native binary messages. React Native exposes the same
value even when its selected WebRTC adapter must perform an internal bridge
conversion, and AckerDB never adds a duplicate conversion. Large finite binary
values use a realtime typed byte stream; continuous audio and video remain
media tracks.
_Avoid_: Base64 application payload, implicit large transfer, media-frame event

**Realtime typed byte stream** — A named, schema-declared transfer for a large
finite binary value. `clientStreams` and `serverStreams` type its metadata;
standard `WritableStream<Uint8Array>` and `ReadableStream<Uint8Array>` surfaces
provide bounded chunking, backpressure, cancellation, and incremental
processing across web, React Native, and server code. Opening an outgoing
stream returns only `{ id, writable }`: the protocol ID supports explicit
application correlation, while all byte-flow behavior stays on the standard
writable. A sender may declare an optional exact size, while the definition may
narrow the deployment's safe default with `maxBytes`; actual-byte counting
always enforces the effective limit. Concurrent-stream, buffered-byte, and idle
budgets bound unknown-length or stalled transfers without preallocating from a
claimed size. Standard writable closure means only that every chunk and the
ending marker were accepted by the current local transport; application
receipt, processing, or durability requires an explicit typed response event.
Cancellation propagates best-effort in either direction, a generation end
interrupts both sides explicitly, and partial streams are never resumed or
replayed. The stream is not buffered whole, silently created from an oversized
event, or used for continuous media.
_Avoid_: Oversized event, hidden fragmentation, implicit RPC, resumable transfer,
base64 file, audio/video track

**User-owned data channel** — An additional native `RTCDataChannel` created and
managed through the exposed peer connection. Its label, protocol, ordering,
reliability, binary handling, buffering, lifecycle, validation, and typing
belong entirely to the application.
_Avoid_: Realtime typed event channel, AckerDB event

**Realtime protocol** — The application-defined typed client and server events
and typed byte streams carried by the realtime typed event channel together
with the audio and video tracks a realtime session may exchange.
_Avoid_: Universal AI protocol, provider wire protocol

**Realtime media source** — An application-owned, platform-native WebRTC audio
or video track attached to a realtime session. The application owns permission,
capture, device selection, push-to-talk, screen sharing, camera snapshots, and
preprocessing.
_Avoid_: AckerDB-owned capture, encoded media WebSocket

**Realtime media consumer** — Application-owned playback, rendering, recording,
or processing of a remote WebRTC track. AckerDB exposes the native remote track
and never chooses autoplay, routing, volume, interruption behavior, or layout.
_Avoid_: Automatic playback, AckerDB media player

**Server media track** — A native, W3C-shaped `MediaStreamTrack` delivered to a
realtime handler through the familiar track-event shape. The handler may relay
it with ordinary sender operations or explicitly request decoded frames;
merely receiving the track performs no application-level media conversion.
_Avoid_: AckerDB media object, eagerly decoded stream

**Server media frame stream** — An explicitly acquired, bounded stream of
decoded audio samples or video frames from one server media track. It is a
standard `ReadableStream`, exists only while consumed, and owns any decoding,
native resampling, conversion, finite buffering, and copying that the requested
representation requires. Audio frames are interleaved signed PCM16; the default
video representation is I420. A slow consumer drops its oldest queued frame,
keeping memory and latency bounded while preserving the newest live media.
_Avoid_: Default track delivery, implicit transcoding

**Server media source** — An explicitly created `AudioSource` or `VideoSource`
that accepts application-generated PCM16 samples or I420 frames and produces
one ordinary outbound server `MediaStreamTrack`. A finite native audio queue
may pace bursty generated media, while its zero-queue path favors direct 10 ms
delivery; `clearQueue` supports interruption. Sources close explicitly or with
their owning realtime generation. Provider-supplied native tracks bypass this
source and attach directly to the peer.
_Avoid_: Provider adapter, client media capture, encoded WebSocket track

**Auxiliary server peer** — A generic, generation-owned server
`RTCPeerConnection` created through `ctx.createPeerConnection` from the same
native engine as the client-facing peer. Its signaling belongs to application
or provider code; AckerDB supplies no provider adapter and closes it with the
owning generation.
_Avoid_: Provider-specific peer, second WebRTC engine, unowned peer

**Realtime handler** — User-owned server code for one AckerDB-relayed WebRTC
peer generation. It runs before answer negotiation with the native-backed
server peer, authenticated principal, validated arguments, authorized
ephemeral state, and a generation `AbortSignal`. It registers named typed
client-event handlers with `ctx.on`, sends named typed server events with
`ctx.send`, and may bridge tracks to any WebSocket, WebRTC, model provider, or
application pipeline the user chooses. It owns the same procedure capabilities
as `procedure` and `sseProcedure`: ordinary registered procedures are directly
callable with the same context, external I/O runs outside transactions, and
`ctx.tx` opens short atomic database work. Returning from the handler does not
end the generation.
_Avoid_: Provider adapter, direct integration, AckerDB AI protocol

**Realtime event dispatch** — Wire-order invocation of a generation's named
typed server handlers. Listeners for one event start in registration order, but
their promises never block later events and completion order is not guaranteed.
Synchronous throws and rejected promises fail only that generation. A
runtime-wide in-flight budget fails overload explicitly instead of retaining an
unbounded hidden queue.
_Avoid_: Serialized handler queue, process-level rejection, unbounded tasks

## Validation

**Constraint** — A declarative rule that narrows the values admitted by a
validator without changing the value's TypeScript type. A stored constraint is
part of the declared schema and must hold for every stored row; a function-input
constraint applies only when that function is invoked.

**Nullable** — A value may be `null`. A nullable function input is still
required to be present; a nullable stored field is present in every row and
uses `null`, never absence, to represent no value.

**Optional** — A function input may be absent, in which case the handler sees
`undefined`; when present, the value itself may not be `null` unless its inner
validator admits `null`. Stored fields are never optional.

**Nullish** — A function input may be absent or explicitly `null`; absence
remains `undefined` while an explicit `null` remains `null`. Stored fields are
never nullish.

## Query model

**Table query** — The planner-independent ordinary read started by
`.query()`. It composes database predicates and explicit ordering before a
materializer; `get(id)` remains the direct primary-key read.
_Avoid_: Scan, index accessor

**Database predicate** — A typed condition evaluated by the database before
rows are ranked, limited, or materialized. An arbitrary application callback
is post-processing, not a database predicate.
_Avoid_: Filter

**Predicate expression** — The SQL expression produced by `.where((row) =>
...)`. Each field of `row` is a typed column reference with SQL comparison and
null operators; predicate results compose with `and`, `or`, and `not`.
Repeated `.where(...)` calls compose with `and`. The callback constructs an
expression and never receives or executes against a materialized application
row.
_Avoid_: JavaScript predicate, row callback

**Query order** — The lexicographic order declared with `.orderBy(...)` and
`.thenBy(...)`. Without one, rows order by primary key ascending; otherwise the
primary key is an implicit ascending final tie-breaker unless explicitly
ordered by the caller. Nulls precede values ascending and follow them
descending. Enum and union tags are stable storage identities rather than
logical sort positions, so enum and union columns are not query-order fields.
_Avoid_: Index order

**Transparent index** — An exact-result storage optimization selected by the
database planner. Public schema declarations identify indexes by their ordered
columns and configuration rather than a user-chosen name; AckerDB derives the
physical identifier. Composite indexes and multiple indexes per table remain
supported. Application queries never name an index, and adding, changing, or
removing one never changes exact results or the storage structure's
performance characteristics compared with an equivalent named index.
_Avoid_: Index accessor, named query

**Structural upsert key** — The exact field set of one declared non-null unique
index, passed to a writable table's `upsert`. Property order is irrelevant;
missing, additional, nullable, or ambiguous key fields are invalid. A
union-valued key lookup compares both its discriminant and payload; because the
declared SQLite index enforces the stronger discriminant uniqueness, the same
tag with a different payload conflicts instead of updating the wrong row.
_Avoid_: Named unique-index accessor

**Ranked retrieval mode** — The caller-selected basis for matching and ordering
rows. One AckerDB ranked retrieval uses either full-text search or exact similarity
search; it never combines or falls back between them.
_Avoid_: Unified search

**Top-k bound** — A positive maximum number of matches a ranked retrieval may
return. Full-text and exact similarity searches require one and expose no
unbounded collection, iteration, count, or pagination operation; CPU, memory,
decoded rows, and transport cost grow with the caller's chosen bound.

**Rank fusion** — Application-owned combination of independently executed,
bounded ranked retrievals by row identity and result position. AckerDB supplies
the retrievals but never chooses candidate depths, fusion rules, weights, or
fallback behavior.
_Avoid_: AckerDB hybrid search

## Full-text search

**Full-text search** — A ranked retrieval over explicitly indexed text within
the rows admitted by its database predicates. Predicates determine which rows
may be returned; they do not redefine the full-text relevance model or its
target-column-wide corpus statistics.

**Literal full-text query** — Text whose characters always represent searchable
content, never operators or backend query syntax. SQLite's byte-compatible
`fts3tokenize(unicode61)` tokenizer supplies the FTS5 tokens; AckerDB quotes each
token as its own phrase and composes them with implicit `AND`. Input that
produces no tokens produces no matches. Callers do not escape or assemble an
expression.
_Avoid_: Raw FTS query, MATCH expression

**Full-text index** — A table's explicit declaration of the string columns
whose text participates in full-text retrieval. A table without one does not
support full-text search merely because it contains string columns.
_Avoid_: Automatic string indexing

**Full-text target column** — The single column selected explicitly by a
full-text search from its table's full-text index. Other indexed columns do not
participate in that retrieval, and an undeclared string column is never a valid
target.
_Avoid_: Search index name

**Full-text corpus dependency** — The reactive dependency for one selected
full-text target's complete FTS corpus. It complements ordinary predicate
dependencies because an indexed-text change outside the eligible population
can still change that population's ordering through target-wide BM25
statistics. Corpus dependencies are per target column, not per table.

**Full-text result** — A table row returned directly in relevance order, with
the application primary key ascending as the deterministic tie-breaker. The
selected sidecar's `rank` orders matches and its `rowid` restricts them to the
canonical application row, but AckerDB exposes neither private value. Application
row identity and result position are sufficient for application-owned rank
fusion.
_Avoid_: BM25 score, relevance score

**Typo-tolerant query expansion** — An opt-in literal full-text query that
preserves each caller token and may add at most one vocabulary-backed
alternative for a token absent from the selected target column. An alternative
never replaces the caller's text.
_Avoid_: Autocorrect, query replacement

## Vector search

**Vector** — A fixed-dimensional dense numeric value that AckerDB can store,
validate, manipulate, and compare. A vector may represent an embedding, but is
not inherently model-generated.
_Avoid_: Embedding, when the value's model origin is irrelevant

**Vector column** — A schema field declared with `v.vector(dimensions)` and
stored as a dense Float32 vector of exactly that dimensionality. It composes
with the same nullability modifiers and ordinary insert, update, replace, and
read operations as other stored fields.
_Avoid_: Embedding column

**Vector value boundary** — Inserts, updates, and similarity query vectors
accept a `readonly number[]` of exactly the declared dimensionality. AckerDB
rejects non-finite coordinates and values that overflow Float32, rounds every
accepted coordinate to Float32 once at the boundary, canonicalizes negative
zero to zero, and returns stored vectors as ordinary readonly number arrays
containing those Float32 values.

**Embedding** — A vector generated outside AckerDB by an AI SDK or another model
library. AckerDB stores and manipulates embeddings but never generates them.
_Avoid_: AckerDB-generated embedding, derived embedding column

**Embedding backfill** — An application-owned batch workflow that generates
missing embeddings outside database transactions and persists them through
ordinary AckerDB mutations. Existing tables normally add a nullable vector column,
backfill it in bounded batches, and optionally tighten nullability afterward;
migrations never call an embedding model.

**Distance metric** — A rule that assigns a distance to two vectors of equal
dimensionality for ranking. Every AckerDB metric is oriented so a lower distance
means a nearer match: cosine is one minus cosine similarity, L2 is Euclidean
distance, and dot is the negative dot product.
_Avoid_: Similarity score

**Similarity match** — A schema row selected by a similarity search together
with its exact distance from the query vector.

**Similarity-eligible vector** — A stored vector for which the selected metric
is defined. Null vectors are ineligible for every similarity search. A zero
vector remains valid stored data and is eligible for L2 and dot searches, but
is ineligible for cosine search. A cosine search rejects a zero query vector
rather than inventing a distance.

**Similarity dependency** — The reactive read dependency of a similarity
search. It covers the predicate-eligible candidate population and relevant
vector-column state, not only the current top-k rows, because a write to an
unreturned row can change the result. Ordinary predicate indexes narrow the
dependency when possible without weakening invalidation correctness.

**Exact similarity search** — The true nearest rows under a chosen distance
metric among all rows satisfying a database predicate. Predicate filtering
occurs before distance calculation, ranking, and limiting. Ordinary indexes may
narrow the eligible population, but distance work remains linear in the number
of eligible vectors, retained ranking state is bounded by the caller's top-k,
and results remain exact. Results order by distance ascending and then by
primary key ascending, making equal-distance matches deterministic; `.first()`
is equivalent to the first element of `.take(1)` or null.

## Schema migrations

**Reconcile** — The startup pass that compares the application's declared
schema against what the database last stored and applies the difference.
Applies shape-safe changes on its own; refuses shape-unsafe ones until a
migration answers for them.

**Shape-safe change** — A schema change that cannot lose or invalidate
existing data no matter what that data is — judged by the shape of the change
alone, always presuming rows exist. Applies automatically, identically in dev
and prod, with no migration file.

**Shape-unsafe change** — A schema change that poses a per-row question:
existing rows could be lost or would need transformation to satisfy the new
schema. Always requires a migration answering that question, even when the
actual table happens to be empty.

**Optimistic change** — A schema change that transforms no rows but tightens a
cross-row constraint (e.g. a unique index over existing data). It is attempted
as if safe: either it holds, or it is refused cleanly with nothing touched.
A refusal is resolved by a migration with a volunteered transform.

**Migration** — A versioned TypeScript file that declares only what a schema
diff cannot infer or must not assume: which drops-plus-adds are really
renames, how existing rows become valid rows of the new schema, and an
explicit acknowledgment for every drop that destroys data. Never a source of
structural truth — structure always comes from the schema declaration.

**Row transform** — A migration's per-table function answering "what does this
old row become in the new database?" Its answer may be a row in the same
table, nothing (the row is dropped), and/or rows emitted into other tables.
Transforms see only the frozen before-state and never observe each other's
output.

**Emit** — A row a transform produces into a table other than its own, derived
from the old row in hand. The mechanism for restructures that move data
between tables (e.g. a 1-1 foreign key becoming an N-N junction table).

**Volunteered transform** — A row transform supplied for a table the reconcile
did not refuse, used to backfill data an automatic change would have left
empty. Refused tables must have a transform; any table may.

**Drop acknowledgment** — A migration's required, explicit answer for a
dropped table or column holding data: either the data goes nowhere, or a
salvage transform carries it into surviving tables first. Nothing is dropped
silently; the acknowledgment is visible in the migration itself.

**Salvage transform** — A row transform for a dropped table. It produces no
same-table rows (the table is going away); it exists only to emit surviving
data into other tables before the drop.

**Before-state** — The read-only, frozen image of the database as it was
before the migration, visible to every transform for cross-table lookups.

**Rename declaration** — A migration's statement that a dropped and an added
name (table, column, or enum variant) are the same thing renamed, so its data
and identity carry over instead of being dropped and recreated.

**Pre-snapshot** — The recorded image of the schema as it stood when a
migration was generated. It types the migration's before-state, and stays
sound for every database the migration can legally meet, because the only
permitted divergence is safe drift.

**Target snapshot** — The full declared schema at the moment a migration was
generated: the state the migration is contracted to reach. The meta sidecar's
load-time integrity check recomputes a fingerprint from it; the applied
immutability identity covers it alongside the number, name, pre, and file bytes.

**Safe drift** — The accumulation of shape-safe changes applied automatically
between migrations. Safe drift only widens what a database can hold (an
absent nullable column reads as null, an absent table as empty), which is why
a migration's recorded types survive it.

**Migration history** — The database's append-only record of which migrations
have run, each stamped with its identity (a hash over number, name, pre, target,
and file bytes). It must always be a prefix of the application's migration chain;
an applied migration is immutable, and any edit to one — its pre, target, or
transform code — shifts the identity and is refused, never silently ignored.

**Change ledger** — The grouped report of every schema change between what the
database stored and what the application declares: the changes that need a
migration (each with its per-row question) and the shape-safe changes that
ride along automatically. Displayed, never persisted; shown wherever consent
is asked and whenever a migration is generated.

**Consent** — The developer's explicit yes at a dev-loop gate: generating a
migration for the change ledger they were shown, or applying pending
migrations. Consent is always pinned to exactly what was shown — a generation
yes carries the displayed ledger's fingerprint and refuses stale, an apply yes
is asked against the pending chain's identity. No migration file exists and no
migration runs in interactive dev before the matching consent.

**Declined** — The dev-loop state after the developer answers "not yet" to a
migration question: the server stays down, nothing is written or persisted,
and the state releases when the ledger changes — a rescued schema starts the
server silently, a different ledger asks again, and generation stays available
on demand.

## Demo app (Savoria restaurant)

**Admin MCP** — The demo backend's single MCP endpoint. Isolated and staff-only:
it exposes the restaurant's business data and exactly two staff actions. Both
the in-app Admin Chat and external agent hosts (Codex, Claude Code) consume the
*same* Admin MCP with the same capability surface; what a caller may do is
decided by the authority attached to its credential, never by which consumer it
is. A future guest/mobile MCP would be a separate named endpoint, not an
extension of this one.

**Admin Chat** — The staff-facing conversational assistant embedded in the
Admin Panel. Answers open-ended questions about the live business (occupancy,
kitchen queue, revenue, waiting times) and can perform the two staff actions.
All of its data access goes through the Admin MCP's tools — it has no private
side-channel to the database.

**Action tool** — One of exactly two mutating tools on the Admin MCP: advance a
kitchen item's status, and cancel an open order. Every other tool is read-only.

**Entity query tool** — A typed read-only tool exposing one entity collection
through simple query-shaped arguments (filters, limits) — e.g. dishes, tables,
orders. Deliberately basic: it answers direct lookups, never analytics. Exists
so a small model can answer simple questions without composing pipelines.

**Bash workspace** — The Admin MCP's open-ended read tool: a sandboxed shell
whose files are the restaurant's live data rendered as JSONL, materialized
fresh at call time and discarded afterwards (never stored, therefore never
stale). Exists so a capable model can answer arbitrary analytical questions
the entity query tools never anticipated.

**Owner token** — An identity-bound bearer credential a staff member issues to
let an external agent host call the Admin MCP. Its scopes decide read-only vs
read+mutate. The secret is revealed exactly once at issuance.

**`read` / `operate`** — The Admin MCP's only two scopes. `read` grants every
read-only tool (entity query tools and the bash workspace); `operate` grants
the two action tools. The in-app Admin Chat always holds both; an owner token
holds whatever was chosen at issuance.

**Agents page** — The Admin Panel section where staff connect external agents:
it shows the Admin MCP's endpoint and install configuration and manages owner
tokens (issue, scope, revoke).
