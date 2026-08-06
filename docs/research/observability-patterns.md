# Observability platform patterns

How established observability and backend-dashboard platforms solve the
problems AckerDB Studio will face, distilled feature-by-feature from studying
several mature products (deliberately unnamed here; the underlying research
lives on the wayfinder map's research tickets). Each section states the
pattern, then what Studio takes and what it deliberately skips.

Scale context for every judgment below: one AckerDB application on a
4 vCPU / 4 GiB node (~5,000 MAU), SQLite storage, telemetry written in-process
into a durable journal, events and logs already carrying trace/span ids and a
durable Identity at commit time.

## 1. Dashboard architecture: the dashboard is an ordinary client

**The pattern.** The strongest dashboard we studied is not a privileged
sidecar — it is an ordinary React client of the observed deployment,
authenticated with an admin key, calling built-in *system functions* shipped
inside the backend under a reserved namespace. Every system function declares
the permission operation it requires (view-data, write-data, act-as-user,
view-logs, …), enforced server-side against the admin identity; the permission
vocabulary doubles as the future granular-role model. A guarded wrapper masks
private system tables so generic reads can never leak them. Only operations
that genuinely don't fit the function model (schema shapes, table deletion,
ad-hoc test code) fall back to raw authenticated HTTP endpoints.

Because the dashboard rides the product's own sync protocol, it inherits
reactivity, pagination, and caching for free: the data browser streams row
changes live with no refresh button and no bespoke transport.

**What Studio takes.** All of it — this validates Studio's architecture
directly. Studio is a React client on `@ackerdb/client-react`; the server
ships a built-in admin surface of typed system queries/mutations under a
reserved namespace; each function names its required permission even while v1
has only one all-powerful admin credential, so granular roles can arrive later
without re-plumbing. If Studio cannot be built on the public client stack,
that is a framework gap to fix, not a licence for a side-channel.

**Skips.** Nested-component recursion (no equivalent concept), runtime shape
inference (AckerDB schemas are statically declared), and ad-hoc
transpile-and-run of user code from the browser.

## 2. Impersonation: claims emulation in the auth layer, once

**The pattern.** "Act as a user" is implemented once, in authentication — not
per feature. The admin authenticates with an optional impersonated-identity
payload (one extra field on the auth handshake over the socket; one header
variant over HTTP). The server substitutes those attributes as the auth
context for the connection, so every function simply sees the fake identity
through its normal auth accessor, and bumping the identity version makes all
open subscriptions rerun under the new identity automatically. No token is
minted, no real user session is touched — it emulates the claims a credential
would carry. The toggle is gated by its own permission and audit-logged.

**What Studio takes.** Exactly this design for the Functions runner's
run-as-user story: admin credential + declared `actingAs` identity attached at
session authentication, server-side substitution, automatic subscription
rerun, permission-gated and audit-logged. This dissolves the "central
difficulty" of impersonation into one auth-layer feature.

## 3. Data browser

**The pattern.**

- Pagination is the public paginated-subscription hook the platform's own
  users use: ~25 rows per page (persisted per table), infinite scroll, pages
  as live subscriptions, idle unsubscribe after a minute of inactivity, and
  server-enforced caps per page (10k rows / 5 MB read) so filtered scans of
  huge tables stay bounded.
- Filters are a small serializable expression — AND-only clauses
  (`eq/neq/gt/gte/lt/lte/anyOf/noneOf`), optional index and order selection —
  validated on the server, with validation errors returned *as data* so the
  UI renders them inline. The expression is carried in the URL, making every
  filtered view a shareable link, and remembered per table locally.
- Edits write directly to the database via dedicated audit-logged system
  mutations (patch fields, replace document, insert batch, delete batch,
  clear table), with schema validation still applying — deliberately
  bypassing app business logic, and documented as such. Production
  deployments are "protected": editing requires an explicit unlock
  confirmation held only for the session.

**What Studio takes.** The whole shape, simplified: AckerDB columns are typed,
so the entire filter expression compiles to `WHERE`/`ORDER BY` with no
client-side post-filtering, and plain URL-encoded JSON suffices. Reactive
paginated system query + serializable filters + direct-write audit-logged
system mutations + prod unlock gate is the committed read path and the
strongest candidate for the conditional write path.

## 4. Function runner

**The pattern.** A globally accessible panel: the function list comes from the
backend's own registry of analyzed functions with their argument validators;
an argument skeleton is generated from the validator with as-you-type
validation before running. Queries are not "executed once" — the panel
subscribes to them live, with a visible "subscribed to updates" indicator,
re-rendering on every argument or data change; mutations run one-shot. Every
run (args + impersonated identity) lands in a local per-function run history.

**What Studio takes.** All of it, from a better starting position: AckerDB
functions already carry typed validators, so skeleton generation and
validation need no module re-analysis. Combined with §2, this makes the
Functions runner far cheaper than feared.

## 5. Logs and traces: storage shape

**The pattern.** Single-node observability stores keep one wide table per
signal — spans and logs deliberately share the same shape — with:

- Typed columns *promoted* for the ~10 hot fields every filter touches
  (operation, function/service, duration, outcome/status, trace id), and the
  long tail of attributes in one JSON/map column. The columnar engines we
  studied then need a zoo of bloom/minmax skip indexes to make that
  tolerable; SQLite replaces the entire zoo with ordinary B-tree indexes on
  the promoted columns.
- Correlation as schema, not convention: log rows carry `trace_id`/`span_id`
  as first-class columns, which is what makes trace↔log navigation one click
  in both directions.
- Tiny insert-maintained side tables doing the heavy lifting:
  a **trace summary** (trace id → start, end, span count, error flag) that
  makes both the trace list and the detail fetch a bounded range scan instead
  of a full hunt; a **distinct-operations registry** (upserted
  function/operation pairs) powering entry-point lists without scanning
  spans; and per-minute pre-aggregated series where raw-scan percentiles
  would be too slow.

**What Studio takes.** Promoted-columns-plus-JSON, schema-level correlation
(already true in AckerDB's journal), a write-maintained trace summary, and the
distinct-operations registry. At AckerDB span volumes, always fetch traces
whole — the platforms only switch to windowed two-phase fetches above ~10k
spans per trace, a cliff we will not reach. Percentiles can be computed
exactly from raw spans on demand at this scale; per-minute histogram-bucket
rollups are the fallback if that ever measures slow, and AckerDB's existing
aggregation series is the natural home.

**Skips.** Ingestion pipeline topology (collectors, queues, batch/retry — the
durable journal already is the ingestion path), resource fingerprinting for
multi-tenant cardinality (a single-app node has ~one resource), bloom-filter
full-text over log bodies (SQLite has FTS5, a real inverted index), and
duplicated tables per sort order (B-trees again).

## 6. Trace UX: what makes it feel top-tier

**The pattern.** The perceived "premium APM" experience decomposes into
surprisingly cheap features:

- Summary-first navigation: the trace list is summaries sorted by duration
  descending, so the slowest requests are the first thing seen.
- A waterfall (synchronized with a flamegraph at larger scale) where
  selecting a span shows duration, **that span's percentile rank vs its
  peers** ("p52 for this operation" — instant "is this slow *for this
  operation*?"), and % of total trace time.
- An error-highlight toggle that dims non-error spans and adds prev/next
  error navigation.
- A top-operations table: p50/p95/p99 + call count + error count per
  operation, **ordered by p99 descending** — slow-operation surfacing is
  literally one `ORDER BY`.
- An Apdex-style score against a configurable latency threshold on service
  pages.
- One-click trace↔log links in both directions (span → logs filtered by
  trace id and time window; log line → open its trace).

**What Studio takes.** All of the above; with AckerDB's existing
per-operation aggregation series, top-operations is a read-side feature, not
new storage. This section is most of "ultra necessary" Traces at trivial
implementation cost.

## 7. Retention

**The pattern.** Two tricks make retention cheap and safe:

1. Expiry drops whole time partitions (day-keyed), never row-by-row scans —
   an O(1) unlink in the columnar stores; in SQLite, a range delete on an
   indexed day/month bucket, or a segment drop.
2. The retention period is **stamped on the data at write time** (and even
   into the partition key), so changing a retention setting affects only
   newly written data and never rewrites or re-judges history. Retention
   changes are tracked as settings with pending/success status so concurrent
   changes can't race.

Product-analytics stores add a second horizon: raw events expire on a short
clock (month-granular buckets) while small daily rollups keep long-horizon
trends forever.

**What Studio takes.** Per-kind/per-level TTL configuration (e.g. plain log
1 week, error 1 month) stamped at write; day-bucketed deletes on an indexed
prefix; rollups outliving raw rows. AckerDB's per-kind retention machinery
already leans exactly this way — keep it.

## 8. Event analytics: the minimal complete set

**The pattern.** Four views make event analytics feel complete rather than
toy — a **live event stream** ("is my instrumentation working right now?"),
**trends** (time series of counts and unique users), **funnels** ("where do
users drop off?" — the first question raw SQL can't comfortably answer, whose
absence is what makes a tool feel toy), and a **per-identity timeline** ("what
did this user do, in order?"). Retention grids are the one worthwhile second
wave; lifecycle/stickiness/path views and an SQL escape hatch are skippable
derivatives. The completeness feature is cross-cutting, not view count:
**property filters and breakdowns must work uniformly across every view**.

Mechanics worth copying:

- Uniques are defined as count-distinct-identity over filtered events.
- Two covering indexes serve everything: `(event, timestamp)` and
  `(identity, timestamp)`.
- Funnels are computed on demand as per-identity time-sorted scans with a
  conversion window (14 days is the inherited default), sequential ordering
  first, drop-off drill-down to the affected identities; strict/any-order
  and exclusions are options, not foundations.
- Trends read small daily rollup tables — per (day, event, breakdown value)
  buckets with an event count and exact distinct-identity count — so
  dashboards are O(days) not O(events), and rollups double as the
  long-horizon retention story.
- Insight results are cached with a staleness floor (~15 min background,
  ~3 min interactive) instead of precomputing everything.

**What Studio takes.** The four views + uniform filters as the Analytics
definition of done; both covering indexes; on-demand funnels (at our scale a
window-function query or app-side loop over an ordered scan finishes a month
of data well under a second); daily rollups on the existing aggregation
series; cached insights with a TTL.

**Skips.** The event-time identity-aliasing subsystem (merge tables,
overrides, retroactive squashing) that the platforms need because they learn
who a user is *after* events land — AckerDB events carry a durable Identity at
commit time, so the identity column is final. One decision to make
deliberately: whether property filters read values as-at-event-time
(snapshotted onto the event — the platforms' default) or current values via a
join; at our scale both are affordable, so decide once and document it.

## 9. Error grouping

**The pattern.** Error tracking converges on: an event's group key is a hash
built with strict precedence — explicit custom fingerprint → stack trace →
exception type+message → parameterized message → constant fallback bucket.
Per frame, only stable identity is hashed (module/file basename + function
name — never line/column numbers, which churn every deploy); recursive and
junk frames are dropped; only in-app frames (not dependencies or runtime
internals) drive the grouping users see. Messages are parameterized before
hashing (ints, uuids, hexes, quoted strings, dates, emails, urls → typed
placeholders) so "order #1231" and "order #1232" group together. The group
row carries `times_seen` / `first_seen` / `last_seen`, updated on ingest.
Lifecycle: plain resolve means **any** new event auto-reopens the issue as
regressed — that single rule is what answers "did my fix work?". The
`fingerprint: string[]` escape hatch (with a default-salting mode) is the
most-used customization. Grouping configs are versioned and pinned, because
any algorithm change splits every existing group.

**What Studio takes** (the whole v1): hash error name + in-app
`(relative path, function)` frames with recursion collapse and `Error.cause`
walking; two-step fallback (name + parameterized message → constant bucket);
~8 parameterization regexes; one upserted group row with the three counters;
two states (unresolved/resolved) with auto-reopen-as-regressed; optional
fingerprint salt; a stored `algo_version` (accepting that a future algorithm
change splits groups rather than building dual-config transition machinery).
Server-side stacks are already source-mapped by Bun, so the minified-JS
problem that dominates browser error grouping does not apply.

**Skips.** Rule DSLs for frame/fingerprint rewriting, release-aware
resolution and semver-gated regressions, escalation forecasting, ML
similarity grouping, and browser source-map ingestion (client-side capture is
a separate conditional feature).

## 10. Web analytics (client-side)

Pending — a further research pass on privacy-first, cookieless web analytics
is in flight; its findings will be folded in here.
