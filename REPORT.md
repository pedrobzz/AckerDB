# T5 — Database/schema integration debt

Worktree `/Users/pedrooscar/personal/dbzz-worktrees/t5-dbschema-debt`, branch
`audit/t5-dbschema-debt`, based on `origin/main` @ `57c64cd`. Nothing pushed.

| # | Finding (L11) | Verdict | Commit |
|---|---|---|---|
| 1 | Physical codec model duplicated between live and migration planning | **Clear win** | `3e93239` |
| 2 | Startup validates the snapshot, discards it, re-reads it | **Refuted** | `4cbf0a3` (docs only) |
| 3 | Reconciliation identity vs diff disagree | **Clear win** | `437a0c4` |
| 4 | Plugin storage preparation mutates Engine before consent | **Clear win** | `807be2a` |
| 5 | `engine.ts` folder organization (L1 F2/F21) | **Not attempted** — see *Headroom* | — |

---

## 1. What was done

### Finding 1 — one descriptor->physical-column codec (win)

`Engine.planColumn()` (validator-driven, live) and `snapshotColumnPlan()` in
`schema/migrations/apply.ts` (descriptor-driven, historical) each implemented
union tag + payload encode/decode, enum tag encode/decode, scalar codecs, and
physical column DDL. Two encodings of one column, kept in step by hand.

Both now build through a single module-level factory in
`packages/server/src/database/engine.ts`:

```ts
export function columnPlan(jsName, descriptor, tagsOf: TagsOf, path): ColumnPlan
```

The *only* thing that differed between the two sites is how a named type
resolves to its tag map, so that is the one argument passed in — the live Engine
supplies `(t) => this.tags.get(tagIdentity(t))!`, a migration step supplies
`(t) => stepTags.get(t)!`. Resolution stays lazy at both sites because both can
have a map rebuilt underneath a long-lived plan (`reinternTags` after a
migration relabels variants).

`Engine.planTable` lost its last use of instance state and became a module-level
builder, so it is a plain function now rather than a method.

`stored-rows.ts` was deliberately left alone, as the handoff specified: it is
decode-only and must tolerate a column the database does not physically have
(`present: false` -> `decode: () => null`). Folding it in would have forced that
tolerance into the live write path.

**Where the factory lives.** I did *not* create a `schema/physical-column.ts`.
The factory needs `physicalColumnDdl`, which needs `corruptSnapshot` and
`storedRecord`, which are also the vocabulary of `parseStoredSnapshot` — moving
the factory out without the snapshot parser would either duplicate those guards
or introduce an `engine.ts <-> schema/` import cycle, which is precisely the
"circular-ish policy cycle" L1 F13 already flags. Keeping it module-level in
`engine.ts` next to the `physicalColumnDdl` and `compileReadProjection` it
already exports adds no cycle and no new indirection. The right extraction is
the whole stored-schema region at once — see *Headroom*.

### Finding 3 — canonical snapshot identity (win)

`reconcile.ts` compared `JSON.stringify(current) === JSON.stringify(target)`
while `diff.ts` compares columns by name and `engine.ts` states outright that
column order is not physical truth. Confirmed empirically: with the old
comparator, reordering column declarations produced

```
applied = [ "updated schema snapshot" ]
```

— i.e. a `BEGIN IMMEDIATE` ... `COMMIT` at startup, a `persistTags()` pass and a
snapshot rewrite, for a change with zero physical content, plus a log line
claiming an update that did not happen. Both no-op guards now use the module's
own `canonicalSnapshotJson()`.

**Not in the audit:** `migrations/chain.ts:143` had the *same* order-sensitive
comparison on the migration chain's trailing safe hop. L11 flagged only
`reconcile.ts:42`. Fixed in the same commit.

### Finding 4 — consent before mutation (win)

`prepareDesired()` called `engine.createPluginScope()` for every desired mount
while merely *preparing* reconciliation targets. `createPluginScope` loads the
vector runtime, interns tag maps into `Engine.tags`, and opens the full-text
tokenizer connection — all before the stored inventory is compared and before
`PluginStorageRequirementsError` is thrown.

Verified before fixing (`.t5scratch/plugin-leak-probe.ts`): after a refusal, the
Engine retained `5:freshAuditLevel` — a tag identity for a mount that was never
consented to and never persisted. In-memory tags and `_ackerdb_tags` disagreed.

Scope construction now splits in two:

- `planPluginScope(mount, schema)` — reads `_ackerdb_tags`, builds plans into a
  tag store **the scope owns privately**. No Engine mutation, no capabilities.
- `activateScope(scope)` — publishes those tags to the Engine, loads the vector
  runtime, enables full text. Called once every mount is accepted.
- `createPluginScope` is the two composed, for the post-consent reset path.

`StorageScope` grew a `tags` member, and `persistTags` now reads the scope's own
tag plan rather than the Engine's global map — which is what makes a planned
scope a self-contained, refusable thing.

The root scope plans straight into `Engine.tags` (it is the application's own
schema; there is no consent step), which keeps `reinternTags` working exactly as
before: the root's store *is* the Engine's, so a migration relabel still lands
under the root's live plans.

**Not in the audit:** `resetPluginStorage` and `dropPluginStorage` never needed
scopes at all. Reset built one for every desired mount, discarded all of them,
and rebuilt the one it wanted inside its transaction from `target.scope.schema`
(which is just `target.schema`). Drop built them purely to compare a mount
*name*. Both now use `normalizeDesiredMounts`.

### Finding 2 — refuted

L11's hypothesis was that the `loadSnapshot()` inside `validateStorage()` and
the one in `reconcile()` are the same read done twice, redundant under the
ownership contract. I implemented the handoff's design (Engine remembers the
validated snapshot; reconcile consumes it) and it failed a crown-jewel test:

```
packages/server/test/database/storage-operations.test.ts
  "rejects missing and wrong application indexes before ready or reconciliation"

  const live = new Engine(indexed, database);
  reconcile(live);
  live.writer.exec(`DROP INDEX "${physicalIndex}"`);
  expect(() => reconcile(live)).toThrow(CorruptDatabaseError);
```

The second read is not a duplicate acquisition — it is **reconciliation's
physical-drift gate**. It re-verifies the stored snapshot against
`sqlite_master`, the Plugin inventory and the interned tags, and refuses if they
have drifted apart *since the Engine opened*. L11 reasoned about out-of-band
non-AckerDB writers and concluded the contract excludes them; it missed that
drift can arrive through the Engine's own writer handle, which this test locks
in deliberately. In AGENTS.md's taxonomy this is an implementation safeguard,
not an accidental patch.

The experiment was reverted. Both call sites now carry a comment saying why the
read happens twice, so the next reader does not repeat it.

---

## 2. Evidence

### Measurements

All on this machine, medians. Throwaway scripts kept in `.t5scratch/`.

**Startup (finding 2)** — `.t5scratch/startup-bench.ts`, 60 tables x 13 columns
(enums, unions, objects, indexes), existing database, 40 runs after 5 warmups:

| | main (reconcile re-reads) | experiment (reuses open-time value) |
|---|---|---|
| Engine open | 4.732 ms | 4.654 ms |
| reconcile | **1.753 ms** | **0.617 ms** |
| open + reconcile | 6.484 ms | 5.269 ms |

So the handoff's design is worth ~1.14 ms of reconcile (-65 %) — but breaking
`loadSnapshot` into its halves shows where that time goes:

```
parse (JSON + structural validation)   : 0.351 ms/call
verify (sqlite_master + plugins + tags): 0.988 ms/call
```

Only the 0.351 ms parse is genuinely duplicated work; the 0.988 ms verify is the
gate that must run. **0.35 ms of a ~6.5 ms startup, once per process, does not
justify putting a stale-snapshot cache on the durability path.** Refuted on the
merits, not just on the failing test.

**Plugin scope planning (finding 4)** — `.t5scratch/plugin-bench.ts`, 8 mounts x
4 tables, 60 runs: planning every desired scope costs **0.365 ms** (0.046 ms per
mount). That is what `dropPluginStorage` spent to compare a mount name, and what
`resetPluginStorage` spent before rebuilding one scope anyway. Sub-millisecond —
the win here is the invariant, not the clock, and the report should not pretend
otherwise.

**Finding 1** is a duplication fix with no measured hot-path change. The live
plan is built once per scope at startup; `validator.descriptor()` is now called
for enum/union columns that previously skipped it, which is bounded by schema
size at open. No steady-state encode/decode path changed shape.

### LoC delta (`git diff origin/main`)

```
src   code    : +155 / -204   => net  -49
src   comments: +88  / -15    => net  +73
src   total   : +243 / -219   => net  +24
test          : +62  / -0     => net  +62   (3 new tests, none removed or weakened)
```

Per file (src):

```
182  150  packages/server/src/database/engine.ts
 21    7  packages/server/src/plugins/storage.ts
 12    3  packages/server/src/schema/definition.ts
 11   54  packages/server/src/schema/migrations/apply.ts
  4    2  packages/server/src/schema/migrations/chain.ts
 13    3  packages/server/src/schema/reconcile.ts
```

Honest reading: **-49 lines of actual code**, against L11's -50...-90 estimate for
finding 1 alone (findings 3 and 4 are net-positive in code, and finding 2
contributed nothing but comments). The +73 comment lines are mostly the
finding-2 refutation and the new consent/tag-ownership contracts — deliberate,
because the whole reason finding 2 was proposed is that the code did not say why
it looked redundant.

### Suites

Green, all run with absolute paths:

- `bunx tsc --noEmit` (root) — clean
- `bun run typecheck` (root + client-react + expo-app fixture) — clean
- `packages/server/test` — **973 pass**, 1 fail *(pre-existing, see below)*
- `packages/cli/test` — **211 pass**, 0 fail
- `packages/core|realtime|cache|client /test` — **364 pass**, 0 fail

Crown jewels specifically confirmed green and unweakened: `schema/migrate.test.ts`,
`database/storage-operations.test.ts`, `database/storage-ownership.process.test.ts`,
`schema/reconcile.test.ts`, and the CLI crash-replay / corruption / backup-restore
process tests.

**Pre-existing failure, not caused by this work:**
`packages/server/test/database/query/vector-runtime.test.ts` -> "fails Engine
startup when a stored-vector schema cannot load native kernels" (child exits 22,
expected 0). Present on the baseline run before any edit; the native vector
kernels are unavailable in this environment. Flagging rather than touching it.

### New tests

- `test/schema/reconcile.test.ts` — "reordering column declarations is not a
  schema change". Verified it fails against the old comparator (`applied` was
  `["updated schema snapshot"]`).
- `test/plugins/plugin-storage.test.ts` — "a refused reconciliation leaves no
  scope state on the Engine". Verified it fails against pre-fix `src` (leaked
  `4:betaRefusedKind`).
- `test/schema/schema.test.ts` — "rejects column kinds that have no physical
  storage".

---

## 3. Blockers

None requiring the coordinator; no `BLOCKED.md`.

One decision I made rather than escalating: **finding 2 conflicted with a
crown-jewel test.** The handoff told me to verify the ownership assumption and
the test answered it directly, so I refuted the finding rather than weakening
the test — which COMMON.md forbids and which would have removed a real
corruption gate. If the owner would rather keep the ~0.35 ms and drop the gate,
that is a policy call and it is *not* the one I made.

Minor: `bun test` with relative paths breaks child-process spawns; used absolute
paths throughout, as the handoff warned.

---

## 4. Gains and losses

**Short-term gains**

- One encoding of a physical column instead of two. A future column kind is one
  edit, and live/migration encodings cannot silently diverge.
- No startup write transaction for a cosmetic column reorder; no false
  "updated schema snapshot" line.
- Plugin storage cannot mutate the Engine for a mount the operator refuses.
- `v.literal()` as a column is refused at `defineTable` with the column named,
  instead of at Engine construction with a bare `unsupported column kind`.
- Reset and drop stopped doing O(mounts) of work they never needed.

**Long-term gains**

- `descriptor-kinds.ts` said enum/union codecs "stay at their sites by
  necessity". That was true only because the sites differed in tag resolution;
  parameterising that leaves the descriptor seam genuinely complete.
- A `StorageScope` is now a self-contained, refusable plan that owns its tags.
  That is the precondition for any future "dry-run this schema change" surface.
- The finding-2 comments stop the next reader (or agent) from re-deriving a
  wrong conclusion from the same evidence.

**Losses / tradeoffs — honestly**

- Net code is only -49 lines, and total lines are **+24**. Findings 3 and 4 cost
  code; only finding 1 paid it back.
- `columnPlan` now derives DDL through `physicalColumnDdl`, so a live schema with
  an unstorable column kind would report snapshot-corruption wording. I closed
  that by refusing the kind at `defineTable` — correct, but it *is* extra
  validation on a path that was previously reachable only by accident.
- `planTable` calls `validator.descriptor()` for every column including enum and
  union, which the live path previously skipped. Bounded by schema size, paid
  once per scope at open, unmeasurable next to the 4.7 ms open.
- A planned Plugin scope holds tag maps that are only *published* on activation.
  If a future caller persists or queries through a planned-but-not-activated
  scope, it will see tags the Engine does not know about. `persistTags` reads the
  scope's own map so it stays consistent, but this is a new state to respect.
- `engine.ts` is still 2496 lines. Finding 1 took ~130 lines out of it and put
  ~113 back in better shape; it did not make the god-file smaller in any way
  that matters.

---

## 5. Verdict per experiment

| Finding | Verdict | Why |
|---|---|---|
| 1 | **Clear win** | Real duplication removed, -43 lines in `apply.ts` alone, one codec for both sides, full migration suite green. |
| 2 | **Refuted** | The "redundant" read is the drift gate a crown-jewel test enforces. Only 0.35 ms of 6.5 ms startup was actually duplicated; not worth a stale cache on the durability path. |
| 3 | **Clear win** | Reproduced the spurious startup write, fixed it, regression test, and found the same bug in `chain.ts` which the audit missed. |
| 4 | **Clear win** on the invariant, **negligible** on perf | Leak reproduced and closed with a regression test; the wasted work removed is real but sub-millisecond. Rated a win for consent-before-mutation, not for speed. |

---

## 6. New findings the audit missed

1. **`chain.ts:143` shares the finding-3 bug.** The migration chain's trailing
   safe hop used the same order-sensitive `JSON.stringify` comparison. L11
   flagged only `reconcile.ts`. Fixed.
2. **`resetPluginStorage` and `dropPluginStorage` never needed scopes.** L11
   finding 5 described pre-consent mutation inside `reconcilePluginStorage` but
   did not notice these two paths build every desired mount's scope and throw
   all of them away. Drop's was 100 % waste.
3. **`v.literal()` was accepted as a column by `defineTable`** and only rejected
   at Engine construction with `Error: unsupported column kind "literal"` — a
   deferred validation with a poor message. Now refused at definition time.
4. **`persistTags` read the Engine's global tag map, not the scope's.** A scope
   therefore could not describe its own tag plan, which is exactly why planning
   and activation were fused. Fixed as part of finding 4.
5. **L11 finding 2's ownership hypothesis is wrong in a specific way** worth
   recording: the contract does exclude concurrent *external* writers, but the
   drift the second read catches is applied through AckerDB's own writer handle
   after open, which the contract says nothing about.
6. **Pre-existing red test on `main`:** `vector-runtime.test.ts` fails in this
   environment (native vector kernels unavailable). Not caused here, but the
   audit fleet should know `main` is not 100 % green on a stock machine.

---

## Headroom — why finding 5 was not attempted

Findings 1, 3 and 4 landed green and finding 2 is settled, so there was some
headroom. I chose not to spend it on the `engine.ts` split.

The reason is that the *right* split is now visible and is bigger than the time
left: finding 1 exposed that `columnPlan`, `planTable`, `physicalColumnDdl`,
`compileReadProjection`, `ColumnPlan`/`TagMap`/`PhysCol`, and the stored-snapshot
region (`parseStoredSnapshot`, `storedRecord`, `corruptSnapshot`, `storedName`,
`expectedApplicationObjects`, `namedDefinitionsOf`, `readStoredPluginInventory`,
`normalizePluginSnapshot`, `storageLayoutFingerprint`) form **one** cohesive
unit — "what the database says its schema is, and how a column of it is laid out
and encoded" — roughly 400 lines that would move together into e.g.
`database/stored-schema.ts`, and would drop `apply.ts`'s dependency on
`engine.ts` to the `Engine` type alone.

Doing half of that, or doing it as a file move with re-export shims, is the
"wrapper-only folder" outcome AGENTS.md rates as sabotage. It also changes the
`index.ts` public surface, so it wants its own review rather than being tacked
onto three unrelated fixes. Recommend it as a follow-up with the boundary above
as the starting seam.

---

## Throwaway artifacts

`.t5scratch/` (committed so the measurements are reproducible, all marked
throwaway in their headers):

- `startup-bench.ts` — Engine open + reconcile timing, and the parse/verify split
- `plugin-leak-probe.ts` — reproduces and then confirms the fix for the
  pre-consent Engine leak
- `plugin-bench.ts` — cost of planning every desired Plugin scope
- `probe.ts` — unstorable column kind behaviour before/after
