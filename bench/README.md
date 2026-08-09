# AckerDB pull-request benchmark

This harness compares AckerDB with AckerDB: the pull request's head commit
against its base commit, on the same runner and with the same head-defined
workload. It runs on every pull request that changes code this workload
exercises — the executable harness, the benchmark workflow, or its path
classifier — and again on the `canary` → `main` promotion, where the same
comparison spans the whole release. Docs, tests, version bumps, and packages not
exercised here report an immediate successful no-op.

## What the check proves

The driver holds both commits live at once — a server and a load generator each
— and alternates between them one unit of work at a time. A unit is the smallest
slice either side can perform in a few hundred milliseconds: one operation
profile, one connection level, one subscription pattern. Only one side is ever
under load.

That interleaving is the measurement's foundation, not a refinement of it.
Running base's whole pass and then head's charges every minute of drift to
whichever side ran second; a pair measured seconds apart met the same machine.
Which side leads alternates on every repetition, and a unit's sixteen
repetitions are spread across the run rather than clustered, so a disturbance
confined to one stretch of wall clock cannot land on all of them.

The method is published, as **duet benchmarking** ([Bulej et al., ICPE
'20](https://dl.acm.org/doi/10.1145/3358960.3379132), 2.3x–12.5x better accuracy
on ScalaBench and DaCapo, 23.8x–82.4x on SPEC CPU 2017); Chromium's Pinpoint
runs both revisions on one device for the same reason. This harness reached it
independently and keeps it because the field did too.

Each metric therefore arrives as sixteen base/head pairs. The verdict is the
median of their ratios in log space, bounded by a distribution-free interval
built from those same sixteen repetitions — the noise band, measured from this
run's own scatter rather than assumed. A metric regresses only when the interval
keeps the whole median on the worse side of neutral *and* the median clears a
twelve-percent floor. Anything else is reported as **no signal**, which is an
answer: the run could not tell the two commits apart. That rule is `criterion.rs`'s
shape — a nonparametric test plus a noise threshold — and Go's `benchstat` minus
the threshold.

Sixteen rather than eight because `benchstat` asks for "at least 10, ideally 20"
samples per side, and eight has a mechanism behind the shortfall: at eight
repetitions the interval collapses to the extreme pair, so every repetition must
agree on the direction before anything can be called. That is a condition
scatter can meet by luck. See [Releases](../docs/releases.md#how-a-verdict-is-reached)
for what the change cost and bought, measured.

`p99` and connect-readiness `p95` are reported and never gated — the first is
the noisiest statistic in the set, the second carries a scheduling tail that
belongs to the host. Idle RSS and CPU are sampled once per side as context.
Correctness and accounting failures fail the check outright; they are reasons
not to believe the numbers, not performance verdicts.

## Running it

```sh
BENCH_EXECUTION_HOST=<where> bun bench/compare-commits.ts <base-sha> <head-sha> <output-dir>
bun bench/report.ts <output-dir>
```

`report.ts` exits non-zero when a gated metric regressed. The host must be
declared because the record has to say which machine produced it; a paired
interleaved comparison is meaningful wherever it runs, which is the point of
pairing, but a number without a machine beside it is not.

Do not commit a new file under `bench/results/`.

## Files

| File | Role |
| --- | --- |
| `compare-commits.ts` | The pair driver: base worktree, both sides live, the interleaving |
| `run.ts` | One side: its server, its load generator, its resource monitors |
| `ackerdb-client.ts` | The load generator, held open and driven one unit at a time |
| `units.ts` | What a unit is, and which metrics gate |
| `paired-statistics.ts` | The median paired ratio, its interval, and the verdict |
| `report.ts` | Renders the comparison, decides, and writes the ledger rows |
| `ledger.ts` | The append-only history of paired ratios, and its validation |
| `workload.ts` | The measured work itself |

## The ledger

Every run's verdicts are appended to the `bench-ledger` branch as one row per
metric — the median paired ratio, its interval, the signal, the repetition
count, and the host — by `.github/workflows/bench-ledger.yml`. **Ratios only,
never absolute numbers**: absolute throughput on an ephemeral runner is not
comparable run to run, but a paired interleaved ratio is machine-independent by
construction, which is what makes a cross-runner history possible here.

Nothing reads it. It exists so the next question about this gate's own noise is
a query over runs that already happened rather than a campaign run to answer it
once — the same trick rustc-perf, Perfherder, and Bencher all live on, where
history is a free null distribution because most pull requests move most metrics
not at all.

## Telemetry scope

The default comparison runs only the `disabled` telemetry profile. If the pull
request changes telemetry-related source, both commits additionally run the
runtime-default and in-process-exporter profiles. That widening is not caution:
the telemetry sidecar rework cost eighty-six percent of query throughput with
telemetry on and moved nothing measurable with it off, so those profiles are the
only place that class of regression is visible.

## Workload

The default workload uses deterministic data and covers:

- query, uncontended mutation, contended mutation, and procedure profiles;
- connection setup, idle plateaus, and useful work at the connection ladder;
- shared and partitioned subscription delivery; and
- increasing closed-loop subscription writer capacity.

Windows are short because the comparison repeats them. One long window per side
yields a single number whose error is the machine's; sixteen interleaved short
ones yield sixteen paired ratios whose spread is measurable and whose median no
single stalled window can move.

Server and load-generator process trees are sampled separately. The record
includes p50/p95/p99 latency, completed useful throughput, RSS, CPU, process
count, startup/idle cost, delivery accounting, and bounded harness observations.

Historical JSON under `bench/results/` predates this policy and includes vendor
comparisons. It is retained as history only and is not read by the current
workflow, release policy, or npm delivery.

See [Releases and protected branches](../docs/releases.md) for branch,
publication, and reviewer policy.
