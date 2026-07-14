# Orchestration: Production safety and operational visibility

## Execution Rules

- Keep issue #1's complete acceptance boundary intact; do not declare partial production readiness.
- Preserve Pedro's dirty-tree work and staged shape. Never use Git to undo it.
- Apply the root-cause skill before edits: identify the owning contract/state boundary and replace broken behavior.
- Use the subagent model selection configured in `~/.codex/config.toml`; packets are bounded and independent.
- Research uses official/primary sources and is ingested through the project Karpathy wiki workflow before implementation decisions depend on it.
- Run the required baseline before structural product edits, then verify narrow-to-broad and benchmark after changes.

## Branching Rules

- If discovery shows one coherent state machine can own several guarantees with less code, collapse packets around that boundary.
- If a proposed implementation adds a compatibility shim, retry workaround, wrapper-only function, unbounded queue, or telemetry on the commit/delivery critical path, reject it and redesign.
- If acknowledgement durability cannot be proven by the current storage API, change the storage contract; do not relabel weaker behavior.
- If realtime history cannot prove a resume transition, send reset plus authoritative snapshot.
- If external research disagrees with current behavior, record the conflict in the wiki and implement the explicit PRD contract.
- Keep the alpha benchmark decision-focused: retain representative correctness and comparative margins, remove redundant repetition and extreme capacity points, and rerun only for correctness failures or implausible headline noise.
- Treat the Hetzner run as a current same-host three-system comparison; do not require it to match or prove improvement over the historical M2 baseline.
- If a test exposes unrelated pre-existing dirty-tree behavior, isolate and report it rather than reverting user work.

## Packet Prompts

### D1 architecture-map

Objective: produce a precise map of protocol, runtime, SQLite, registry, reactive subscription, transport, client reconnect/idempotency, lifecycle, and existing test boundaries. Identify the smallest coherent replacement boundaries for issue #1 and a file-ownership proposal. Do not edit product code. Write `.workflow/production-safety-operational-visibility/results/D1-architecture-map.md`. Verify claims with file/line references and existing tests.

### D2 contract-research

Objective: collect primary-source evidence for the gaps not already covered by the project wiki: SQLite WAL durability/checkpoint/backup/integrity, bounded overload/backpressure and slow-consumer behavior, ordered resume/reset stream design, and any missing OpenTelemetry or identity-refresh contract. Apply `.agents/skills/karpathy-llm-wiki/SKILL.md`: preserve new official sources under `raw/`, merge findings into existing relevant `wiki/` articles or create only genuinely new concepts, cascade updates, update `wiki/index.md`, and append `wiki/log.md`. The installed skill lacks its referenced templates, so follow the existing repository files' metadata/link formats. Do not edit product code. Also write `.workflow/production-safety-operational-visibility/results/D2-contract-research.md` with source URLs, dates, findings, and implementation implications.

### D3 acceptance-test-map

Objective: map every PRD required behavior suite to black-box public tests and fault-injection mechanisms using current repo patterns. Identify deterministic race barriers, process-level fixtures, privacy canaries, finite-memory assertions, telemetry schema assertions, and benchmark correctness gates. Do not edit product code. Write `.workflow/production-safety-operational-visibility/results/D3-acceptance-test-map.md` with prioritized test slices and file ownership.

## Completion Audit

- All 50 user stories and fixed implementation/testing decisions map to implemented public behavior, an explicit documented out-of-scope limitation, or separately approved deferral.
- No unbounded application or telemetry queue remains.
- Acknowledged mutations survive the promised restart boundary and converge caller state.
- Identity/security semantics are transport-independent and fail closed.
- Realtime transitions never guess across version mismatch or missing history.
- Operational signals cover every public path without secrets/payloads or unbounded metric labels.
- Tests and benchmarks prove the claims, and after results preserve required wins.
- Wiki/index/log and production/telemetry/operations docs are current.
