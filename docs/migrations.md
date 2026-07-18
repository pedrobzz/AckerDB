# Migrations

How dbzz evolves a database when `schema.ts` changes. The model is recorded in
ADR 0003 and the CONTEXT.md glossary; this document is the operator/developer
guide.

## The model

Every schema change is classified by its *shape*, always presuming rows exist —
never by inspecting the data:

- **Shape-safe** changes apply automatically, identically on an empty dev table
  and a full production one, with no migration file: adding a table, adding a
  nullable column, adding or reordering enum/union variants, widening a column
  to nullable, any non-unique index change, dropping any index, and every
  event-table change.
- **Optimistic** (the sole member: adding a unique index) is attempted: clean
  data applies; duplicates refuse cleanly with counts and touch nothing. The
  fix is a migration with a volunteered dedupe transform.
- **Shape-unsafe** changes pose a per-row question and always require a
  migration, even on an empty table: a column type change, narrowing to
  required, adding a required column, removing a variant, changing a union
  payload, dropping a column or table, and any rename (a diff reads it as
  drop-plus-add until declared).

A migration is never a source of structural truth — structure always comes from
`schema.ts`. The file declares only what a diff cannot infer or must not
assume: rename declarations, row transforms, and drop acknowledgments.

## Dev flow

`dbz dev` applies shape-safe changes on every reload, silently. When a change
is refused, the server fails to start and — on a real terminal — the supervisor
asks one question per ambiguous dropped/added pair (rename, or delete+add?
never guessed), then scaffolds the migration. Non-interactive contexts never
prompt; they exit naming the recourse: `dbz generate [name]`.

The scaffold's unanswered per-row questions are *typed holes* — a transform
with a declared return type and no return — so the dev server stays down until
you answer them. Fill the TODOs; the next reload applies the migration. The
hole is a compile-time gate (your editor and `bun run typecheck` refuse it);
at runtime an unfilled transform fails against any real row, so a table that
happens to be empty in dev can let the migration apply vacuously — production
data will still refuse it, and the typecheck catches it long before that. Column
drops scaffold as a destructuring that names every discarded field; table
drops scaffold as `null` (replace with a salvage transform to carry rows into
surviving tables first).

`dbz reset` remains the dev escape hatch: it deletes the local database
directory, and the next start initializes fresh (a fresh database stamps the
whole chain as vacuously applied).

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

## Chain rules

- Sequential 4-digit numbers; duplicate numbers are a load error; renumbering
  an *unapplied* migration is always safe.
- The database records each applied migration's number and target fingerprint
  in an append-only history that must be a prefix of the app's chain.
  **Applied migrations are immutable**: editing one changes its fingerprint
  and the next start refuses loudly. The meta sidecar's fingerprint is also
  recomputed at load, so an edited target snapshot is caught before the
  database is opened.
- Each pending migration applies at startup in its own transaction, history
  row included: a mid-chain failure keeps every earlier migration applied and
  rolls the failing one back byte-identically. Fix the code, restart.
- After the last migration, the remaining diff to the live schema must be
  entirely shape-safe; anything else refuses and names `dbz generate`.
- Safe drift is sound by construction: a migration generated against a dev
  snapshot applies to a production database that lacks later shape-safe
  changes — an absent nullable column reads as `null`, an absent table reads
  as empty.
- There are no down-migrations. Rolling back is a new forward migration, or a
  verified backup restore.

## Deploying a migration-carrying release

Deploy stays "ship code, restart": pending migrations run at startup, before
the runtime exists, and readiness reports a distinct `migrating` phase while
they do. Clients reconnect and resubscribe after the restart as usual.

Take a verified backup first. A failed migration rolls back cleanly, but a
migration that *succeeds and was wrong* is only recoverable from a backup:

1. drain and stop the old release (`SIGINT`/`SIGTERM`, wait for exit);
2. `dbz backup <artifact>` and retain the artifact + manifest
   (see [operations.md](operations.md));
3. start the new release; watch `/ready` through `migrating` to serving;
4. if the migration refuses, the database is untouched — fix and redeploy.
