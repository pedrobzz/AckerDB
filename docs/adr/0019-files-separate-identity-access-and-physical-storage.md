---
status: accepted
---

# Files separate identity, access, and physical storage

AckerDB Files are immutable built-in application resources. A File has fixed
framework metadata and an application-facing identity
that is independent of its opaque physical object key; ordinary application
tables own searchable business metadata through File references. Independently
revocable File grants own download authority, so revoking a URL never requires
deleting the File.

Each deployment has one active File store: the local filesystem or one generic
S3-compatible backend. Client uploads stream through AckerDB so both stores
share authorization, hashing, limits, and failure semantics. Changing stores is
a resumable maintenance-mode migration: AckerDB stops application traffic,
copies and verifies every live File while preserving the source, and switches
only after the complete destination is proven. This rejects online dual-store
routing until real availability requirements justify its permanent machinery.

The File API deliberately feels familiar to S3 users without promising S3
feature parity. Its adapter uses conventional endpoint, region, bucket,
credential-provider chain, path-style addressing, checksum, and encryption configuration;
retrieval follows standard object HTTP behavior such as `GET`, `HEAD`, a single
byte range, entity tags, content headers, and conditional reads. AWS-scale
object limits, multipart upload, object keys as application identity, ACLs,
versioning, tags, lifecycle rules, and provider-specific administration are not
implied by that familiarity and remain outside the initial File contract. The
initial implementation therefore has a 5 GiB hard File ceiling compatible with
one streaming S3 object write; deployments default to 1 GiB and may configure a
smaller or larger value only within that ceiling.

Client uploads use File upload sessions that expire after one hour by default
and are bounded by the deployment's configurable byte limit, initially 1 GiB.
Each session may shorten its lifetime or narrow the deployment limit by byte
size, declared content types, and expected SHA-256. One session stores at most
one File: failed attempts may retry before expiry, while concurrent attempts
cannot create several Files and the first successful store consumes the
session. A retry after a successful commit returns the already-created File
identity, so losing the success response cannot create a duplicate or make the
result undiscoverable.

Upload bytes remain internal staging state until both physical storage and File
metadata commit. Disconnects, checksum mismatches, storage failures, and
database commit failures never publish a File. Any physical bytes left by an
ambiguous failure are owned by a durable cleanup record and retried until the
configured store confirms removal; correctness does not depend on a best-effort
request-finally handler.

The session URL accepts an S3-familiar raw `PUT` body and returns the resulting
File identity as JSON. The client SDK provides a typed `files.upload()` helper
over the same public protocol so ordinary callers do not hand-roll the session
and `fetch()` sequence; it is convenience rather than a second upload path. The
helper must receive an application-owned mutation and its typed arguments to
create the session before uploading. It cannot bypass application authorization
by minting unrestricted sessions directly from the client. Once a session
exists, the helper retries an ambiguous transfer with bounded backoff against
that same idempotent session until it succeeds, the caller cancels, or the
session expires; it never hides a still-useful session behind an arbitrary
two-attempt cutoff.

Optional File name and content type are immutable, untrusted declarations
captured with the bytes. The browser helper defaults them from its `File`, raw
`PUT` uploads provide them through headers, backend streams provide them as
method options, and any caller may omit them. Retrieval as an attachment uses
the original name by default; a grant may override the presentation filename.
Both are safely encoded rather than interpolated into `Content-Disposition`.

Backend code uses `ctx.files.store()` to stream bytes into a pending File,
`ctx.files.open()` to receive metadata plus a ranged readable stream, and
`ctx.files.bytes()` for explicitly bounded buffering. `ctx.files.get()` remains
metadata-only, so a harmless-looking read never allocates the entire object.
Backend stores use the same automatic owner capture and pending-claim lifecycle
as client uploads.

An upload session created by a user or MCP principal captures that principal's
durable identity, and its completed File receives it as an immutable owner
automatically. Anonymous, workload, and system creation is unowned unless
trusted server-side code explicitly chooses an owner.
Owner is indexed reactive File state for filtering and relationships; it grants
no retrieval authority by itself, because File grants remain the single access
model. Transferring the bearer upload URL does not transfer ownership: the
session creator remains the resulting File owner because the upload request
itself carries no trustworthy user identity.

Downloads likewise stream through AckerDB for both stores. This preserves one
authorization, revocation, range, and failure contract and deliberately accepts
that aggregate File traffic may eventually saturate the AckerDB host's network.
Direct provider delivery remains a future measured optimization rather than an
initial second access path with delayed revocation semantics.

Retrieval defaults to `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`. A File grant may explicitly request inline
presentation for trusted images, video, audio, or PDF content; untrusted HTML
and SVG never become executable application-origin content merely because the
upload declared that media type.

Upload and grant expiration are evaluated when the HTTP request begins. A
request admitted before its deadline may finish streaming afterward; a new or
resumed request after expiry is denied. This matches familiar S3 behavior and
does not interrupt a healthy large transfer with an expiry timer.

A validated File grant stores a registered read-only authorization function and
its typed arguments. Every retrieval executes that decision under the current
request principal. Unauthorized, expired, revoked, malformed, and nonexistent
grants all return `404 Not Found`, and initial grant responses use
`Cache-Control: no-store`; neither status nor a retained cached response may
reveal or bypass a grant's current authority.

Grants have three orthogonal access modes: bearer possession, a signed-in user
principal, or the validated application decision. Any mode may be
permanent or expiring, and creation must explicitly choose `expiresIn` or
`permanent: true`; there is no lifetime default that can accidentally create a
permanent URL. Public File metadata exposes only identity, lifecycle
state, immutable optional owner, byte size, SHA-256, optional untrusted content
type and name, and creation time; the physical object key is never public.

`ctx.files.createUrl()` defaults to bearer access because public media and
ordinary sharing should require only an explicit lifetime. It optionally
accepts a typed `access` union: `bearer`, `authenticated`, or `validated` with a
registered authorization function and typed arguments. Top-level `inline` and
`filename` options control presentation without reproducing HTTP disposition
objects in the common call. Creating a URL also claims a pending File in the
same transaction, after its options have been validated.

Bearer URLs are intentionally usable directly in `<img>`, `<video>`, and `<a>`
elements without cookies, custom headers, an application proxy, or an object
URL. Possession is authority until revocation, expiry, or File deletion.
Authenticated and validated URLs remain the private, programmatic path; the
client's `files.fetch()` attaches its current credential and returns the
unbuffered `Response`.

File metadata is ordinary reactive AckerDB state exposed through
`ctx.files.get()` and `ctx.files.query()`. The dedicated capability preserves
the File module boundary instead of exposing its private framework table through
`ctx.db`, while reusing the normal query DSL for filtering, ordering,
pagination, aggregates, and reactive invalidation. Initial framework indexes
are creation time, owner plus
creation time, and lifecycle state plus creation time. Business-specific access
paths belong to ordinary application tables rather than an expanding set of
framework indexes. Queries do not silently restrict results to the current
owner; application query code explicitly filters and authorizes results just as
application mutation code authorizes deletion.

Per-user and per-organization storage quotas remain application policy rather
than a second framework authorization system. Applications can maintain their
own indexed accounting alongside File references, while AckerDB exposes
deployment File-usage metrics for operator capacity and cost monitoring.

Grant creation and revocation are transactional mutation operations; revocation
is idempotent. Queries may read and paginate non-secret grant metadata, while
the bearer URL secret is returned only at creation and never recovered by a
listing. AckerDB persists only a cryptographic hash of the bearer secret, so the
framework Grant table cannot reconstruct a working URL after creation.
Applications may deliberately persist the creation-time plaintext result in their
own rows when the URL itself is application state, such as a public avatar.
Deleting a File revokes every grant in the same transaction.

File Grant identities are distinct from File identities. `v.fileGrant()` carries
that brand through function arguments and direct application-table columns for
later revocation without casts; unlike `v.file()`, it has no automatic File
claiming semantics.

Every upload creates an independent File even when another File has the same
SHA-256. The digest proves content; it does not introduce physical
deduplication, cross-owner reference counts, or shared deletion. Application
tables own File references, and initial deletion does not globally discover or
cascade through those ordinary rows; application code updates its references
and deletes the File in one mutation when it needs atomic logical cleanup.

A completed upload begins as a pending File with a fixed 24-hour lifetime.
`v.file()` declares a direct File-reference column; nullable direct references
use the ordinary nullable form, while collections use an application join
table. Writing a pending File into such a column claims it automatically in the
same transaction as the row write, so rollback preserves the pending state and
normal application code never coordinates a separate claim. An explicit claim
remains available for intentionally standalone Files. Replacing or deleting a
reference never deletes the previous File automatically because other rows or
grants may still own its lifecycle.

Byte streams are external File-store I/O. Procedures, HTTP handlers, and system
runs may store and read them; queries and mutations may inspect File
metadata and manage transactional File state but never stream bytes. This keeps
reactive reads deterministic and prevents slow storage or network I/O from
holding AckerDB's single writer.

Backend byte access is streaming-first. Buffering an entire File through
`ctx.files.bytes()` requires an explicit `maxBytes` budget and rejects a larger
File before allocation; streaming remains bounded by backpressure and the
deployment's File-size limit rather than by that convenience budget.

Deletion makes the File unavailable and revokes all of its grants atomically in
the database. Physical object deletion is a durable retrying job because remote
storage cannot participate in the database transaction. AckerDB reports the
File as deleting until the configured store confirms removal; it never presents
logical revocation as proof that the bytes were physically deleted.
`ctx.files.delete()` performs no implicit owner check; the calling application
mutation owns authorization so organization administrators, system work, and
other declared policies do not conflict with a hidden framework rule.
After physical deletion is confirmed, AckerDB removes the File and its grant
rows instead of retaining unbounded tombstones, so `ctx.files.get()` returns
null. Deletion remains idempotently successful when the File is already absent.

Backups include File metadata and bytes by default so restoring application rows
cannot silently restore broken File references. Operators who independently
protect their File store may explicitly request a metadata-only backup; that
exception is never the default.
