---
status: accepted
---

# The aggregate sees everything and the store keeps a little

Issue #194 specified that all spans persist durably with no sampling. Measured,
that cost 76% of throughput and grew the sidecar by 512 MB a minute at design
load. The defect was not the write path, the schema or the thread. #194 fused
two requirements that every mature product keeps apart: the aggregate must see
everything, and the trace store must keep everything. Only the first is real.
Datadog computes its trace metrics from 100% of traffic regardless of ingestion
sampling and enforces it by cloning for stats before the sampler runs; its
documented retention ratios are 0.1% to 1%. So the model here is one sentence:
**the aggregate sees everything, and the store keeps a little.**

## The aggregate

Every valid observation contributes once, before any retention decision, to
bounded time-bucketed distributions. Counts, error counts, totals and means are
**exact for covered buckets**; quantiles are **approximate with a declared error
bound**. Seeing 100% of traffic and being numerically exact are different
properties, and conflating them is how a percentile becomes a lie, so both facts
travel with the data rather than living in someone's memory.

The series key is **(operation × function)**. Capping the cardinality of a closed
enum would be theatre, and `function` is this framework's analogue of Datadog's
`resource`; it is also what makes #196's per-cohort rank answerable per function
rather than per operation. `function` is application-supplied and therefore
unbounded, which is exactly the shape that turns an in-process aggregate into a
memory leak, so cardinality is capped and overflow is **disclosed**: past the cap
observations land in one series that says it is the overflow series, rather than
silently inventing a merged series that looks like a real one.

Minute buckets answer the windows an operator watches during an incident; hourly
buckets, merged from the same sketches, answer long horizons at a sixtieth of the
rows. Merging is exact, so the hour's count and total are the minutes' sums and
its quantiles carry the same bound. Coverage is recorded rather than assumed: a
minute is announced when its first observation arrives and marked closed only
once the whole minute has been handed over, so a generation that dies mid-minute
leaves that window visibly incomplete instead of presenting a smaller count as
exact.

A window also discloses which of its exposed quantiles it holds too few
observations to answer. At p99 a hundred-observation window is describing a
single request, and a number printed without its confidence is read as certain.
The bar is ten observations above the quantile, carried on the row beside
coverage rather than left for a screen to infer.

## The exemplars

One row per retained trace, with the span tree as its payload, and nothing at all
for the rest. The aggregate beside it does the counting; an exemplar answers the
other question — not "how slow was this endpoint" but "show me one that was
slow" — and that needs a handful of whole traces rather than all of them.

Selection is tail-based: every error, everything at or above the cohort's own
high quantile, and a deterministic baseline share drawn from the trace id. Every
stored row discloses its `reason`, `policyVersion`, `inclusionProbability`,
`complete`, `observedSpans` and `omittedSpans`. This is the contract and not
bookkeeping: a retained cohort deliberately over-represents errors and slow
traces, so a stored trace that cannot say why it was kept is indistinguishable
from a representative sample. Datadog documents the same hazard about its own
diversity-sampled set. **Nothing may compute a rate, a percentile or a rank from
this table**; those come from the aggregate.

### The threshold is the number on the chart

The retention quantile is read from the same sketch the chart is drawn from. That
makes "the chart shows p99, therefore a p99 exemplar exists" true **by
construction** rather than by luck, at every load and with no constant to tune. A
fixed millisecond threshold drifts away from the chart the moment the
application's latency changes and the operator is the one who discovers it —
OpenTelemetry Collector #30319, filed January 2024 and closed by a bot as stale,
and Datadog's shipped default, whose retention filter covers p75, p90 and p95
while p99 is the number everyone watches.

The exposed quantiles split into **tail** and **body**, and retention follows
`min(TAIL_QUANTILES)` alone. The rule must say *tail* and not merely *lowest*:
the day a screen exposes p50, "retain at the lowest exposed quantile" would mean
retaining half of all traffic and the policy would quietly become "store
everything" again. Leaving the body out is safe because the deterministic
baseline already supplies typical traces — a uniform sample is representative by
construction — while what a uniform sample almost never contains is a tail
outlier at useful density.

Exposing p95 is therefore the **expensive** choice, and it is paid deliberately:
retention follows the lowest tail quantile, so p95 retains roughly 5% of traces
where p99 alone would retain 1%. Showing the lower tail number costs five times
more, not less. It is paid because p95 alone hides any incident affecting under
5% of traffic — the shape of most real ones — and because a page making twenty
backend calls has only a 36% chance of dodging the slow 5% entirely. Do not
"optimise" this by dropping p99; dropping p95 is what would save storage, and it
is the number worth keeping least.

### The rate is the invariant, not the threshold

Four defects in this policy shared one shape: a rule of the form *retain when X*
whose X quietly stopped discriminating, each failing toward **retaining
everything while looking healthy**. The cohort key was built in two places with
two separators, so every lookup missed and the threshold read "cold" forever.
Cold-start required a *published* window, so at three thousand operations a
second with a five-minute window some nine hundred thousand traces retained
before the policy engaged. A `>=` comparison kept every tie at the boundary, and
a constant-latency endpoint would have retained 100%. And the boundary was
compared against a bucket edge reconstructed in floating point, where at OTLP
scale 6 every power of two is an exact edge — `2 ** (1/64)` raised to 64 is
1.9999999999999964 — so a constant 2 ms endpoint tested as *above* its own bucket
and retained entirely.

The structural answer is that **the contract is a rate and the threshold is only
a means of reaching it**. Everything above the boundary bucket retains outright;
the boundary bucket admits at the probability that makes the realized rate match
the target, computed from the same sketch, drawn deterministically from the trace
id under its own salt. And the comparison happens in the sketch's **integer key
space**, never against a reconstructed millisecond edge. Measured against a 5%
target: continuous 5.33%, quantised 5.13%, bimodal 5.11%, constant-latency 4.37%.
A standing guard asserts the realized rate across all three shapes. Keep it and
extend it; never relax it.

## Pressure, and the amplification a flood produces

Tail sampling retains every error as a full exemplar. That is correct at a 1%
error rate and catastrophic at 100% — and a flood, a crash loop, a retry storm or
one misconfigured poller all make it 100%. At 2,099 bytes an exemplar against 316
a log row, unbounded retention fills the store about **seven times faster exactly
when the application is under attack**.

The fix falls out of the model rather than bolting onto it, and it is the shape
journald and Plausible both chose independently: the aggregate is bounded by
**cardinality**, so no amount of traffic makes it grow, and only the specimens
scale with traffic. So under pressure the specimens shed, the aggregate keeps
counting, and the drops are counted by reason rather than emitted one row at a
time — journald drops the messages and emits *a message about the number of
dropped messages*. Nothing about the incident's shape is lost, because the shape
lives in the aggregate; only the individual specimens go.

It is the same rate invariant already built, with the target driven by pressure
instead of held constant. journald multiplies its effective rate by a factor
derived from remaining free space, so the budget drives the limiter and the two
are one mechanism rather than two that can disagree. Signals shed in order of
evidence per byte: exemplars first, then error occurrences, then logs and
analytics; the aggregate never sheds at all. Error *counts* are unaffected,
because they come from the aggregate and never from the retained specimens.

**Admission lives at the telemetry writer, not at the HTTP edge.** PocketBase's
request logger sits outside its rate limiter — priorities −1040 against −1000,
sorted so the logger runs outer — so a rate-limited request returns
`TooManyRequestsError`, that error reaches `logRequest`, and every blocked
request still writes a full error-level row to `auxiliary.db`. Their limiter
protects the application and does nothing for the log store. This framework has
the same shape at its own edge: an operation refused at admission still opens a
trace and records an admission span and an overload event. That is correct for
the aggregate, which should count refusals, and it is exactly why the gate has to
sit at the one door every durable signal passes.

Measured, at two thousand operations a second against a 16 MiB target: the
healthy phase writes 1,202 bytes per operation and sheds nothing; the flood
writes 895 bytes per operation and sheds 5,627 of the 7,998 traces selection
chose. Amplification 0.74×, where the defect would be near seven. The aggregate
saw all 55,986 observations in both phases and the stored error count is 8,076
against 7,998 flooded operations.

## Retention: time is the control, bytes are the guard, the floor is what refuses

Sixteen products were surveyed. **Nobody partitions bytes per signal.** Outside
four single-node stores — VictoriaLogs, Netdata, journald, Prometheus — nobody
has a byte budget at all, and Netdata, the closest structural analog, runs bytes
and time together, deleting on whichever fires first, and documents its byte
limit as a soft target rather than a hard cap. Netdata also shipped size-only
first and had operators demand time back (netdata#13424), because bytes alone
make retention unpredictable exactly when volume varies. What stops one signal
eating another is a limit **at ingest**, not a partition in storage: Loki,
Datadog and Sentry all place it there, and journald rate-limits per service so
that two services which log do not interfere with each other's limits.

So each class of data has a clock, and that is what an operator sets and reads.
The byte ceiling exists so a burst cannot fill a disk, and it is a **target that
eviction chases** rather than a cap. Netdata's own documentation is explicit that
its size cap does not block or reject writes as it is approached and that no
mechanism enforces a true hard one. What the industry actually trusts is a floor
that **refuses**: Elasticsearch's flood-stage read-only block, VictoriaMetrics
and VictoriaLogs going read-only below `minFreeDiskSpaceBytes`, Datadog's daily
index quota stopping indexing. The free-space floor is therefore not a nicety
beneath the ceiling — it is the guard, and the ceiling is what eviction aims at.

Two floors make byte eviction safe. A **free-space floor** keeps the sidecar from
being the thing that fills the volume the application's own database is on, which
is journald's `SystemKeepFree`. And a **minimum-data floor** stops eviction from
taking the most recent window whatever the ceiling says, which is VictoriaLogs
keeping its last two days regardless: the incident that blew the budget is
exactly when those hours matter, so the store goes over and discloses it rather
than erasing the evidence. Eviction is expiry with a shorter clock, and the
minimum window *is* that clock, so the guard needs no second entry point.

The byte guard counts the **write-ahead log**. Pages before a checkpoint appear
in both the database and the log, so this over-reports deliberately: a guard that
over-reports fires early, and one that under-reports lets the volume fill while
its own arithmetic says there is room. That is VictoriaLogs#841 exactly —
ingestion stopped on a full disk while computed partition bytes sat under the
limit, because the accounting covered rows and not the scratch beside them.

Defaults are generous rather than tiny: logs seven days, traces seven days,
analytics a year, aggregate rollups longer. At the 316 bytes a log row measures,
seven days at a hundred operations a second is about nineteen gigabytes, and a
one-gibibyte budget would have promised a week and delivered hours. Disk is the
cheap resource where CPU and memory are not, and a serious application does not
run on a box with a gibibyte free.

**Effective retention is observable, and it is two gauges.** Each signal reports
the oldest and newest timestamp it still holds, from which a caller subtracts the
window it is actually being given and compares it against the one configured.
VictoriaLogs exposes exactly this as `vl_storage_log_min_timestamp_seconds` and
its maximum, and Netdata ships per-tier space and time retention, so the shape is
validated and cheap. What it buys is the thing configuration alone cannot say: an
operator who set seven days and is being given two by eviction has no other way
to learn it, and a green "7 days" that eviction quietly made two hours is the
failure being avoided. Deliberately *not* a bespoke retention-accounting
subsystem — two numbers per signal, and the presentation derives the rest.

Operator-configurable budgets from Studio are deferred. The model makes them
possible, being one time value per signal plus one ceiling, but writing
configuration is an Admin API surface, and lowering retention is lazy in every
product surveyed.

## One thread owns the sidecar, for every signal

The connection is created on a worker because a native binding handle cannot be
transferred, and that constraint is the design rather than an obstacle: exactly
one thread writes the file, so the serving thread never runs a synchronous
commit. Sampling does not remove the need for it. The retained fraction is
`errors + slow + baseline`, so a healthy application already retains about 5–7%
and an incident drives it toward 100% — precisely when the application can least
afford to block. Logs and analytics never sample at all. The thread is **incident
isolation**, not an optimisation for the healthy mean, so every signal crosses
it; leaving any behind would put two writers on one file and split the accounting
that makes the disk guard mean anything.

The export pump follows from the same constraint in the other direction. A
`TelemetrySignalExporter` is a closure the application wrote, and a closure does
not cross a thread, so the exporters stay on the serving thread while the journal
they read stays on the worker. Batches travel up over the sidecar's existing
channel, the closure runs on the serving thread, and the cursor advance travels
back down. Durability is unaffected because a cursor is only ever written by the
thread that owns the file it describes, and delivery remains at-least-once: the
advance follows the export, so a process that dies between them re-delivers that
batch rather than losing it. Two shortcuts were considered and rejected — a
second read-write connection on the serving thread, which splits the accounting,
and disabling exporters for file-backed engines, which is a silent production
regression.

There is no read worker. Reads are small aggregate rows, summary columns and one
bounded payload.

## What we produce is exportable in the language others already speak

A user who prefers BetterStack must be able to leave, so divergence has to earn
its place. Exact p99 is a real win, cheap for a single node and expensive for a
multi-tenant vendor. Divergence that buys nothing is a defect.

OTLP's `ExponentialHistogramDataPoint` carries `repeated Exemplar exemplars`,
each with `trace_id` and `span_id`. That is verbatim the aggregate-plus-exemplar
model above, arrived at independently, so the alignment is real rather than
retrofitted. Two consequences follow and both are binding.

First, **γ is not a free parameter.** OTLP fixes `γ = 2^(2^-scale)` for an
integer scale. Choosing γ from a target relative accuracy instead — α = 0.01
gives γ = 1.020202, which is scale 5.115 — lands the grid between two legal
scales, and then every export is a lossy re-bucket of numbers computed exactly.
So the scale is the parameter and α is derived from it. Scale 6 declares 0.5415%,
a **tighter** guarantee than the 1% it replaces.

Second, **storage resolution and wire resolution are different numbers.** A
consumer's bucket limit — Grafana Mimir's tenant cap, the OTel SDK's default of
160 — is a limit on what it accepts, and OTLP carries `scale` precisely so a
producer can merge adjacent buckets on the way out. Downscaling is the format's
designed mechanism, not data loss. Sizing storage to the smallest consumer would
size the product to the wire: 160 buckets at scale 6 span 5.66×, so a busy series
would be permanently coarse, and once coarse it cannot be made fine again for
anyone. So 2,048 buckets are stored — spanning 2^32 at scale 6, which covers
every latency a request can have — and export coarsens to whatever a consumer
accepts and declares the widened bound it is sending.

Coarsening is exact either way: halving the scale merges adjacent bucket pairs
(`key → ceil(key/2)`), so the shape survives and only the declared bound widens.
The sketch also does it automatically when a single series outgrows its stored
budget, which is why it never **collapses**: folding the lowest buckets together,
the alternative, destroys the body of the distribution to protect the tail and
leaves a p50 wrong by an unstated amount.

Tail-sampling provenance has no standard slot: the OTel specification says
adjusted count "is not defined for spans obtained via non-probabilistic
sampling", so only the deterministic baseline slice can ride in `tracestate`. The
industry emits a plain span attribute, so an OTLP export maps an exemplar's
`reason` to `tailsampling.policy` rather than inventing a field.

## Cost

The synthetic driver measured the serving thread's share of an operation at
roughly 16 µs, about 13% of a 126 µs baseline, and flat from healthy to total
outage. Scenario 1 measured the isolation claim it exists for: serving cost
16.8 → 15.5 µs/op from healthy to total outage, acknowledgement p99.5 rising only
44.6 → 60.4 ms, 674,575 accepted and 674,575 committed, zero dropped, queue slope
0.000.

**The framework's own benchmark is the number that counts, and it is what it
gives, not what the driver predicted.** Against `canary` over eight interleaved
repetitions in all three telemetry profiles: no gated metric regressed. Query
latency throughput −2.4%, query saturation −5.1%, uncontended mutation latency
−0.8%, contended mutation latency +0.9%, procedure latency −3.1% — every one
inside an interval spanning zero, against a run whose own median absolute paired
delta was 3.1% and whose p90 was 8.0%. The honest reading is that this change is
not distinguishable from noise on throughput at this harness's sensitivity, which
detects roughly 60% of twenty-percent regressions and almost nothing below ten.

The one cost that is *not* noise is idle memory: **82 → 95 MB RSS**, consistently
across profiles. That is the sidecar's worker thread and its SQLite connection,
which did not exist on `canary`, and it is the price of the isolation the whole
design rests on.

A first comparison gated `connection:1000 p95` in the exporter profile at +21.8%.
It was re-run once, against a written prediction that it would not reproduce,
because the branch modifies no file in the connection path, because that path
accepts no records, because the same metric moved −15.6% in the `disabled`
profile of the same run, and because the run was contaminated by a review process
started inside it. Quiet re-run: +5.0%, interval −5.9% … +16.2%, no signal.

## Commodity and policy

Almost all of this is commodity with published prior art, and it is worth naming
so that nobody rebuilds it: the sketch is DDSketch; the retention model is
journald, Netdata and VictoriaLogs; the refuse-writes floor is Elasticsearch's
flood stage and VictoriaMetrics' `minFreeDiskSpace`; the actual-retention gauges
are VictoriaLogs' two timestamps; the discard-reason vocabulary is Loki's; the
batching semantics are `BatchSpanProcessor`'s; the worker-owned SQLite writer is
a documented better-sqlite3 pattern; the export format is OTLP; and the
tail-sampling shapes are the OTel Collector's `tailsamplingprocessor`, which
ships `latency`, `status_code` and `probabilistic` policies that we derived
independently before finding them.

**One thing here is policy**, and it is small: the exemplar-link invariant — the
retention threshold read from the same distribution the chart reports — together
with exposing both p95 and p99 and paying the lower one's retention cost, and the
completeness of the disclosure contract. That lives in `telemetry/policy.ts`
behind a two-method seam (`quantile`, `shareAtAndAbove`), so replacing the sketch
or the limiter beneath it never touches the invariant.

### Why the sketch is not `@datadog/sketches-js`

The burden was on keeping ours, and two requirements decided it. Measured against
v2.1.1, Apache-2.0, zero dependencies.

**The mapping passes exactly, and that is worth recording.** Constructing
`LogCollapsingLowestDenseDDSketch` with `relativeAccuracy = 0.005415159415902577`
yields `LogarithmicMapping` with `gamma = 1.0108892860517005` — bit-identical to
`2 ** (2 ** -6)` — and its `key()` agrees with ours on every probe value
including the 2.0 boundary, zero mismatches. So the grid is not in dispute; the
library confirms our mapping is OTLP scale 6.

**The bin cap fails — as a matter of which direction it degrades.** The library's
only bounded stores collapse rather than downscale. Measured on 200,000 samples
with 95% of mass at 2–10 ms and a tail to 8 s, constrained to 160 bins:
`CollapsingLowestDense` reports **p50 = 1,424.8 ms against a true 6.226 ms — a
22,783% error — while still declaring a 0.5415% bound**. `isCollapsed` is set,
but the declared bound is simply wrong for everything below the collapse point.
Ours on the same data: p50 3.37%, p90 3.59%, p99 2.36% error, all inside the
*widened* 4.33% bound it reports after downscaling. Collapsing the LOWEST buckets
is the wrong trade for latency specifically, because that is where the median
lives; the library is correct at its own 2,048-bin default, where the range never
binds. Storage here is now also 2,048, so this failure would not be reached in
ordinary use — but the guarantee under pressure is the one worth having, and the
degradation mode is the reason to keep ours rather than a tuning accident.

**Serialization fails.** `toProto`/`fromProto` import `protobufjs/minimal`, which
the package does not declare — its `dependencies` are empty — so the call throws
at runtime, and adopting it would mean adding protobufjs to production
dependencies. `fromProto` is also documented to lose `min` and `max`, which the
stored row carries.

The honest summary is that the library's *mapping* is proven and ours matches it,
and the library's *store* cannot satisfy a 160-bin budget on a latency shape. The
validation tests stay either way: they test the contract, not the implementation,
so they would catch a future swap regressing it.

## Two standing rules

**Every telemetry decision is checked against prior art before it is made.**
Sentry, Datadog, Mixpanel, PostHog, BetterStack and a dozen open-source
equivalents have solved these problems for a decade. It has already happened
twice on this work that we were doing something nobody does for no advantage. A
closed ADR is not absolute truth; revisiting a decision, including one taken with
less information, is a duty and not a failure.

**What we produce must be exportable in the language others already speak.** The
OTLP alignment above is that rule paying for itself: it found two constants that
were wrong and improved the declared error bound while fixing them.

**And before implementing, classify every responsibility as commodity or
policy.** Default to adopting a mature implementation for the commodity, compose
proven designs where the capability spans several, and keep policy in its own
module behind a narrow seam. Building commodity by hand is a last resort that
needs evidence — the section above is what that evidence looks like when it
comes out in favour of building, and it should be the exception.
