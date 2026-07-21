# Migrations

How dbzz evolves a database when the root schema in `app.ts` changes. The model
is recorded in ADR 0003 and the CONTEXT.md glossary; this document is the
operator/developer guide.

## The model

Every schema change is first classified by its *shape*, always presuming rows
exist. The classification never changes because a table happens to be empty;
only the explicitly optimistic class performs the data probes described below:

- **Shape-safe** changes apply automatically, identically on an empty dev table
  and a full production one, with no migration file: adding a table, adding a
  nullable column, adding or reordering enum/union variants, widening a column
  to nullable, loosening validator constraints, any non-unique index change,
  dropping any index, and every event-table change.
- **Optimistic** changes are attempted against the stored data: adding a unique
  index probes duplicate groups, while tightening a validator constraint scans
  the affected columns in bounded pages. Clean data applies; duplicates or
  invalid rows refuse with exact counts and touch nothing. The fix is a
  migration with a volunteered dedupe or validation transform.
- **Shape-unsafe** changes pose a per-row question and always require a
  migration, even on an empty table: a column type change, narrowing to
  required, adding a required column, removing a variant, changing a union
  payload, dropping a column or table, and any rename (a diff reads it as
  drop-plus-add until declared).

A migration is never a source of structural truth — structure always comes from
the application manifest's root schema. A migration file declares only what a
diff cannot infer or must not assume: rename declarations, row transforms, and
drop acknowledgments.

## Dev flow

`dbzz dev` applies shape-safe changes and clean optimistic changes on every
reload, silently. When a change needs a migration, the server refuses to start
and — on a real terminal — the supervisor prints the **change ledger**: every
change that needs a migration (each with its per-row question, plus exact
duplicate or constraint-violation counts for optimistic changes), the
ambiguous dropped/added pairs that might be renames, and the shape-safe changes
that ride along automatically. Then it asks whether to generate the migration
now. **Nothing is written before you say yes** — a bare Enter declines.
Non-interactive contexts never prompt; they exit naming the recourse:
`dbzz generate [name]`.

Saying yes names the migration (Enter accepts the derived name), answers the
rename questions (rename, or delete+add? never guessed), and scaffolds.
Consent is fingerprinted against the exact ledger shown and verified inside
the write: if the schema moved while the question was open, the stale yes
refuses, the fresh ledger prints, and the question is asked again.

Declining leaves the server down with a banner naming the recourses; nothing
is persisted, and restarting `dbzz dev` asks again. Keep editing freely: a
ledger that goes clean starts the server silently, a ledger that changes asks
again, and an identical ledger only re-prints the banner. Composition falls
out of declining: change several things across saves, then one yes produces
one migration covering everything.

A save while the question is open *retracts* it — the question was about a
state that may be gone. Retraction is not a decline: it remembers nothing,
and the next refusal simply asks again over the fresh ledger.

If a scaffold sits unapplied and the schema moves further — the need
evaporated, or more changes landed — the supervisor detects that the chain no
longer ends at your schema and offers to delete the unapplied migration files
(named explicitly; this discards any transform code you wrote — keep a chain
pulled from git) and re-derive one migration. Deleting an unapplied migration
is always chain-legal; if nothing needs answering afterwards, the server just
starts.

Applying gets the same consent: pending migrations rewrite rows, so an
interactive `dbzz dev` never runs them unasked. Each refused start asks
`apply pending migration NNNN_name now? [y/N]` — yes applies on the spot, no
(the default) keeps the server down. A declined apply is remembered against
the pending chain's identity: unrelated saves only re-print the banner, while
any edit to the migration file (filling a TODO shifts its identity) asks
again — so the natural loop is fill, save, answer yes. Withdraw the migration
by deleting its files, or `dbzz reset`. Production `dbzz start` and
non-interactive dev apply at startup unattended, exactly as the deploy recipe
requires.

The scaffold's unanswered per-row questions are *typed holes* — a transform
with a declared return type and no return — so the dev server stays down until
you answer them. Fill the TODOs, save, and answer yes to apply. The
hole is a compile-time gate (your editor and `bun run typecheck` refuse it);
at runtime an unfilled transform fails against any real row, so a table that
happens to be empty in dev can let the migration apply vacuously — production
data will still refuse it, and the typecheck catches it long before that. Column
drops scaffold as a destructuring that names every discarded field; table
drops scaffold as `null` (replace with a salvage transform to carry rows into
surviving tables first).

`dbzz reset` remains the dev escape hatch: it deletes the local database
directory, and the next start initializes fresh (a fresh database stamps the
whole chain as vacuously applied).

`dbzz generate` never asks for consent — invoking it is the consent — but it
prints the same ledger before writing, so the record of what a migration
answers always appears. On a stale unapplied scaffold it makes the same
delete-or-keep offer (as guidance text without a terminal).

## The migration file

```
migrations/
  0001_count_to_number.ts        the migration (its only import is generated)
  meta/
    0001_count_to_number.json     pre + target snapshots + fingerprint
    0001_count_to_number.types.ts generated types: old rows in, new rows out
```

```ts
import { defineMigration } from "./meta/0001_count_to_number.types.ts";

export default defineMigration({
  renames: { columns: { users: { street: "streetName" } } },
  tables: {
    posts: (row) => ({ ...row, count: Number(row.count) || 0 }),
    oldLogs: null,                                          // drop acknowledgment
    legacy: (row, ctx) => { ctx.insert("archive", { ...row, at: 0 }); }, // salvage
  },
});
```

Transforms are pure computations: old row in (typed from the pre-snapshot),
new row out (pk preserved by the engine), `null` deletes the row. `ctx.before`
is the frozen before-state for cross-table lookups; `ctx.insert` emits rows
into any table of the new schema. Transforms never observe each other's output
or emits, may be async, and should be deterministic — network access is on
you. A variant rename keeps its interned tag with zero row rewrites; a genuine
removal forces you (in the types) to map or delete the rows that hold it.
Constraint-refusal scaffolds use the same table transform: repair the invalid
value, map the row to another valid shape, or return `null` to delete it. The
engine validates every returned and emitted row against the target constraints
before writing it.

## Chain rules

- Sequential 4-digit numbers; duplicate numbers are a load error; renumbering
  an *unapplied* migration is always safe.
- The database records each applied migration's number and identity — a hash
  over its number, name, pre, target, and file bytes — in an append-only history
  that must be a prefix of the app's chain. **Applied migrations are immutable**:
  editing one's pre, target, or transform code shifts its identity and the next
  start refuses loudly. (The migration file is the immutable unit; a helper
  module it merely imports is outside the identity boundary.) The meta sidecar's
  fingerprint is also recomputed at load, so an edited target snapshot is caught
  before the database is opened.
- Each pending migration applies at startup in its own transaction, history
  row included: a mid-chain failure keeps every earlier migration applied and
  rolls the failing one back byte-identically. Fix the code, restart.
- Optimistic constraint probes run under the same writer transaction before
  schema, data, snapshot, or history writes. A violating row therefore cannot
  race a clean probe, and a refusal leaves all four untouched.
- After the last migration, the remaining diff to the live schema must be
  shape-safe or pass its optimistic probes; anything else refuses and names
  `dbzz generate`.
- Safe drift is sound by construction: a migration generated against a dev
  snapshot applies to a production database that lacks later shape-safe
  changes — an absent nullable column reads as `null`, an absent table reads
  as empty.
- There are no down-migrations. Rolling back is a new forward migration, or a
  verified backup restore.

Validator presence rules and the complete constraint surface are documented in
[Validators](validators.md).

## Deploying a migration-carrying release

Deploy stays "ship code, restart": pending migrations run at startup, before
the runtime exists, and readiness reports a distinct `migrating` phase while
they do. Clients reconnect and resubscribe after the restart as usual.

Take a verified backup first. A failed migration rolls back cleanly, but a
migration that *succeeds and was wrong* is only recoverable from a backup:

1. drain and stop the old release (`SIGINT`/`SIGTERM`, wait for exit);
2. `dbzz backup <artifact>` and retain the artifact + manifest
   (see [operations.md](operations.md));
3. start the new release; watch `/ready` through `migrating` to serving;
4. if the migration refuses, the database is untouched — fix and redeploy.
