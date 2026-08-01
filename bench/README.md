# AckerDB pull-request benchmark

This harness compares AckerDB with AckerDB: the pull request's head commit
against its base commit, on the same dedicated Hetzner runner and with the same
head-defined workload.

GitHub runs it for normal pull requests into `canary` and urgent pull requests
into `main`. It is a required merge check. A `canary` → `main` promotion reports
a successful no-op because the exact canary commit was already measured before
it entered the release branch.

The protected workflow owns execution. Do not run `bench/run.ts` on the
developer machine and do not commit a new file under `bench/results/`.

## What the check proves

The workflow:

1. checks out the pull-request head and creates a detached worktree for the
   base commit;
2. copies the head harness into the base worktree so both sides perform the
   same logical work;
3. alternates base/head execution order deterministically;
4. records the complete useful-work and resource vector; and
5. uploads `base.json`, `head.json`, and `comparison.md` for the current head
   commit.

The required status proves that this paired observation completed. It does not
contain regression thresholds, a score, or a pass/fail interpretation of the
numbers. Correctness failures and accounting anomalies are retained as data,
not converted into a performance verdict. Pedro and an agent decide whether
the movement is acceptable by reasoning about useful work, latency, throughput,
CPU, RAM, scale shape, tails, startup, and durable correctness together.

## Telemetry scope

The default comparison runs only the `disabled` telemetry profile. If the pull
request changes telemetry-related source, both commits additionally run the
runtime-default and in-process-exporter profiles. This isolates telemetry cost
without charging every unrelated release for it.

## Workload

The default workload uses deterministic data and covers:

- query, uncontended mutation, contended mutation, and procedure profiles;
- connection setup, idle plateaus, and useful work at the connection ladder;
- shared and partitioned subscription delivery; and
- increasing closed-loop subscription writer capacity.

Server and load-generator process trees are sampled separately. The record
includes p50/p95/p99 latency, completed useful throughput, RSS, CPU, process
count, startup/idle cost, delivery accounting, and bounded harness observations.
The job has an eight-minute ceiling.

Historical JSON under `bench/results/` predates this policy and includes vendor
comparisons. It is retained as history only and is not read by the current
workflow, release policy, or npm delivery.

See [Releases and protected branches](../docs/releases.md) for branch,
publication, and reviewer policy.
