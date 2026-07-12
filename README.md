# dbzz

A full stateful backend in a CLI — reactive queries, transactional mutations, procedures and
scheduled work on top of Bun + SQLite. Inspired by Convex and SpacetimeDB.

This monorepo contains the packages you install to build a dbzz app:

| Package | Purpose |
|---|---|
| `@dbzz/core` | Wire format, protocol and function references shared by server and client |
| `@dbzz/server` | The `dbz` schema DSL, storage engine, reactivity and function runtime |
| `@dbzz/client` | The Node/Bun client: subscribe, query, mutate, call procedures, consume SSE |
| `@dbzz/cli` | The `dbz` CLI: `dev`, `start`, `codegen`, `reset` |

Design docs live in `.wiki/dbzz/v1` (local workspace, not committed).

## Development

```sh
bun install
bun test packages/core/test packages/server/test packages/client/test packages/cli/test
bun run typecheck
```
