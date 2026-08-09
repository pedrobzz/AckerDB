# The AckerDB benchmark ledger

This branch is data, not code. It holds one row per metric per benchmark run:
the median paired ratio that run measured, its interval, and the verdict the
gate reached — never an absolute number.

```text
ledger/YYYY-MM.ndjson   one JSON object per line, one file per month
```

It is an orphan branch. It shares no file with `main` or `canary`, is never
merged into either, and is written only by `.github/workflows/bench-ledger.yml`
running from the default branch. Do not commit to it by hand.

Only the ratio is stored because only the ratio travels. Absolute throughput on
an ephemeral GitHub runner is not comparable from one run to the next — which is
why rustc-perf and Mozilla's Perfherder both need dedicated stable hardware
before their history means anything — but AckerDB's benchmark measures both
commits interleaved on the same machine in the same second, so its paired ratio
is machine-independent by construction and a history that spans runners is worth
keeping.

Nothing reads it yet. No threshold, floor, or gated-metric set consults it. It
exists so that the next question about this gate's own noise — "would this metric
have gated on unchanged code?" — is a query over runs that already happened,
rather than a campaign run on purpose to answer it once.

The row shape, its validation, and how a run is folded in live in
`bench/ledger.ts` on the code branches. The policy lives in `docs/releases.md`.
