# dbzz

A full stateful backend in a CLI — reactive queries, transactional mutations,
procedures, scheduled work and event broadcast on top of Bun + SQLite.
Inspired by Convex and SpacetimeDB; designed in `.wiki/dbzz/v1` (local
workspace, not committed).

This monorepo is the packages you install to build a dbzz app — not an app
itself:

| Package | Purpose |
|---|---|
| `@dbzz/core` | Wire format, protocol and typed function references shared by server and client |
| `@dbzz/server` | The `dbz` schema DSL, bun:sqlite engine, reconciliation, reactivity, function runtime, transport |
| `@dbzz/client` | The Node/Bun client: subscribe, query, mutate, call procedures, consume SSE. No Bun-specific APIs |
| `@dbzz/cli` | The `dbz` CLI: `dev` (watch + debounced codegen + auto-restart), `start`, `codegen`, `reset` |

## The shape of an app

```
your-app/
├── apps/
│   ├── server/                 # schema.ts, functions/, .zdb.config.json
│   └── client/                 # anything with WebSocket+fetch globals
└── packages/
    └── server-codegen/         # `dbz codegen` output — committable, diff-friendly
        └── _generated/{server,api,types}.ts
```

- `schema.ts` default-exports `defineSchema({...})` built from `dbz.*`
  validators (string/number/bigint/boolean/bytes/array/object/enum/union/
  jsonb/nullable/identity/scheduleAt), `defineTable` / `defineEventTable`,
  `.index(...)` (b-tree, multi-column, unique, direct) and `.scheduled(...)`.
- Functions import their typed constructors from the generated `server.ts`:
  `query` (reactive, read-only snapshot), `mutation` (one serializable
  transaction, exactly-once via client idempotency keys, `fetch` banned),
  `procedure` (external calls + explicit `ctx.tx` transactions),
  `sseProcedure` (data-only SSE, AI-SDK-compatible headers and `[DONE]`).
- Server-side composition is **direct function calls**, never references:
  a mutation calls a query with its own ctx (read/write ⊇ read-only, and the
  callee joins its transaction); procedures compose queries and mutations
  inside `ctx.tx` — several calls in one transaction commit atomically. A
  query calling a mutation doesn't compile (its ctx has no writes), and
  procedures aren't callable in-process. The generated `api` object is for
  clients only.
- Clients import only the generated `api.ts`/`types.ts` — runtime imports
  touch `@dbzz/core` alone, so no server code can reach a client bundle.

Reactivity: every query records its read set (id / index-prefix / scan
keys); every mutation emits write keys; subscriptions re-run only on
intersection, deduplicated per `(query, stable-args)` — 1,000 subscribers to
the same result cost one recomputation — and identical results are never
re-shipped.

## Performance

Benchmarked against the Convex local backend (see [bench/README.md](bench/README.md),
`bun bench/run.ts`): **15x** mutation round-trip throughput, **26x** faster
subscription updates (p50), **3.9x** lower RSS after load, **19x** less CPU
for the same workload.

## Development

```sh
bun install
bun test packages/core/test packages/server/test packages/client/test packages/cli/test
bun run typecheck
```

The gitignored `sandbox/` is a full usage monorepo (server app + Bun client
+ Node smoke test) driving every feature end to end: `cd sandbox && bun run
setup && bun run demo`.

## MVP scope (deliberate divergences from the v1 wiki)

- **No TypeScript migration files.** Reconciliation applies every safe
  change automatically and *refuses* anything destructive with row counts
  (`dbz reset` is the dev escape hatch). The typed migration-file layer is
  the post-MVP half of the same design.
- **Auth is stubbed anonymous.** `ctx.auth` exists with the designed shape
  and `dbz.identity()` is implemented (branded bigint); the JWT identity
  layer and `@dbzz/auth` providers are not in the MVP.
- **No React client.** `@dbzz/client` is the Node/Bun client; `useQuery` et
  al. are a later package.
- **Direct indexes execute as SQLite b-trees.** Same API and semantics; the
  array-backed layout lands only if benchmarks show it wins (the wiki's own
  rule for sized numerics).
- **Event tables reject `.index(...)`** — rows never persist, so an index
  could never be observed; allowing it would let the schema lie.
- **Generated `types.ts`/`server.ts` use type-only imports of
  `@dbzz/server`** (erased at compile time — client bundles still contain
  only `@dbzz/core`). Renames are not detected by reconciliation (they read
  as drop+add and refuse when data exists).
