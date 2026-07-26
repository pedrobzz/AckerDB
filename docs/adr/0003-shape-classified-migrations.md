# Migrations: shape-classified safety, transform-only migration files

AckerDB used to reconcile schema changes automatically and decide safety from
actual row counts — an empty dev table let any change through, so the same
schema could refuse at prod deploy (where rows exist) with no prepared
recourse. Designing first-class migrations, the industry offered two models:
Drizzle/Prisma, where every change becomes a generated SQL file and that file
*is* the structural truth (hand-edited for restructures), and
Convex/SpacetimeDB, where compatible changes apply automatically and the rest
is incremental application-level choreography. We rejected both and locked
three interlocking rules.

**1. Safety is classified by the shape of the change, always presuming rows
exist — never by data.** Shape-safe changes (cannot lose or invalidate data
whatever it is: add table, add nullable column, add/reorder variants, widen to
nullable, non-unique index changes, event-table changes) auto-apply
identically in dev and prod with no file. Shape-unsafe changes (pose a
per-row question: type change, nullable→required, required-column add,
variant removal, union payload change, drops, apparent drops that are really
renames) always require a migration file, even on an empty table. The sole
optimistic change (unique-index addition) poses only a cross-row question and
touches no rows: it is attempted, refuses cleanly with counts if duplicates
exist, and is resolved by a migration with a volunteered dedupe transform.

**2. Migration files contain zero DDL.** Structure has exactly one truth: the
schema declaration; the diff against the stored snapshot fully determines the
structural work. A migration declares only what a diff cannot infer or must
not assume: rename declarations (tables/columns/variants — a variant rename
keeps its interned tag, zero row rewrites), per-table row transforms
(old row → new row, `null` to delete, `ctx.insert` emits into other tables,
`ctx.before` for lookups), and drop acknowledgments (`null` or a salvage
transform). User code *computes*; the engine owns every write — ids,
iteration, rebuild, the transaction, final validation. The transform's types
carry the presume-data rule: nullable→required forces `?? default`, variant
removal forces handling the removed case.

**3. Chain mechanics.** Each migration records a pre-snapshot (types the
before-state) and a target snapshot (the contract). Applied migrations are
immutable — the database verifies a (number, identity) prefix and refuses
loudly on edits, unlike Drizzle's silent ignore. A step's identity is the hash
of everything that changes what it does to data: its number, name, pre snapshot,
target snapshot, and migration file bytes. The file is the immutable unit — drift
in a helper module the migration merely *imports* is outside the identity
boundary. Sequential numbers;
duplicate numbers are a load error, renumbering unapplied files is safe.
Migrations apply at startup (the server *is* the database — no
migrate-then-flip topology exists), one transaction each, rollback on any
error leaves the database untouched. No down-migrations (rollback is a new
forward migration, or backup/restore). No auto pre-migration backup, no
squashing, transform purity documented but not policed.

The hybrid is sound because shape-safe drift only *widens*: an absent
nullable column reads as `null`, an absent table as empty, a new variant has
no holders — so a migration's recorded pre-snapshot types stay valid for
every database it can legally meet. Shape-safety and before-state
type-soundness are the same property.

## Considered options

- **Data-dependent safety (status quo)**: rejected — "safe in dev" ≠ "safe in
  prod"; the refusal fires at deploy time with no file mechanism to answer it.
- **Always-files (pure Drizzle)**: rejected — file spam during dev iteration,
  kills the automatic feel for purely additive changes.
- **Imperative migration files (DDL + data loops, or a `migrate({before,
  after})` escape hatch)**: rejected — a second source of structural truth
  that can drift from the schema; hand-managed ids and iteration make
  forgotten tables silent data loss; enum tags would leak as integers.
  Restructures are instead expressed with emits from the refused table's
  transform.
- **Down-migrations**: rejected — untested-by-construction code pretending
  data loss is reversible.

## Consequences

- Migrations transform data only where the schema changed. Data fixes and
  seeding are application code (ordinary mutations); if versioned one-shot
  data migrations are ever needed, they join the same journal as a *distinct
  kind*, not an extension of schema migrations.
- Renames are undecidable from a diff, so they are asked, never guessed: the
  dev CLI prompts per ambiguous pair and scaffolds the file; non-interactive
  contexts refuse with the generate command.
- A unique-index addition can fail a prod deploy that dev never saw fail —
  accepted deliberately: the refusal is clean, the recourse mechanical
  (generate, dedupe transform, redeploy).
- Applied history is append-only; the dev escape hatch for rewriting it stays
  `acker reset`.
