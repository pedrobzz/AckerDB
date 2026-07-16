# dbzz

DBZZ is a single-node, stateful TypeScript backend built on Bun and SQLite. It
provides typed queries, transactional mutations, procedures, scheduled work,
live query subscriptions, and live event streams through Protocol 2.

The supported production topology is one Bun server process owning one local
SQLite database file. DBZZ is not a horizontally scaled or replicated service,
and the server/CLI packages execute source TypeScript and `bun:sqlite`; deploy
them with Bun rather than Node.js.

The current milestone is a production-safety foundation, not a hosted or
distributed database. Its contracts are explicit: external identity is
verified or deliberately anonymous, query state moves through ordered
transitions, mutation effects are durably deduplicated, every framework-owned
queue and transport buffer is finite, shutdown has a deadline, and
backups are verified by restoring them before they are accepted.

| Package | Purpose |
| --- | --- |
| `@dbzz/core` | Protocol 2 envelopes, wire encoding, outcomes, cursors, and typed function references. |
| `@dbzz/server` | Schema DSL, SQLite engine, function runtime, authentication, reactivity, transport, limits, and telemetry. |
| `@dbzz/client` | Web-platform client for queries, mutations, procedures, SSE, subscriptions, reconnect, and credential refresh. |
| `@dbzz/client-react` | React and Expo provider/hooks for live queries, mutations, procedures, events, SSE, authentication, and optional AI SDK chat transport. |
| `@dbzz/cli` | `dbz dev`, `start`, `codegen`, `reset`, `status`, `backup`, and `restore`. |

## Application shape

```text
your-app/
├── apps/
│   ├── server/                 # schema.ts, functions/, .zdb.config.json
│   └── client/                 # any runtime with WebSocket, fetch, and Web Crypto
└── packages/
    └── server-codegen/
        └── _generated/{server,api,types}.ts
```

- `schema.ts` default-exports `defineSchema(...)`. Persistent tables use
  `defineTable`; `defineEventTable` declares non-persistent live events.
- Functions use the generated `query`, `mutation`, `procedure`, and
  `sseProcedure` constructors. Every function must declare `access` as
  `"public"`, `"authenticated"`, `"system"`, or a fail-closed policy callback.
- Queries run against a SQLite snapshot and record precise dependency keys.
  Mutations run through one serialized writer transaction. Procedures may do
  external work and open explicit `ctx.tx(...)` transactions. Scheduled
  mutations execute as the local `system` principal.
- Direct server-side query/mutation composition preserves the caller's
  immutable principal and still validates arguments and the callee's policy.
  Procedures and SSE procedures exist only at the transport boundary.
- Generated client references carry compile-time inferred argument and return
  types without importing server runtime code into the client. Results are
  checked for wire representability and frame bounds, not against a declared
  runtime output schema.

The client requires an explicit credential, including for anonymous use:

```ts
import { DbzzClient } from "@dbzz/client";
import { api } from "./_generated/api";

const client = new DbzzClient({
  url: "http://127.0.0.1:3211",
  credential: { kind: "anonymous" },
});

const unsubscribe = client.subscribe(api.todos.list, {}, console.log);
await client.mutation(api.todos.create, { text: "ship it" });

unsubscribe();
client.close();
```

## Production contracts

- [Authentication and authorization](docs/authentication.md) documents strict
  bearer handling, immutable principals, external OIDC/JWKS configuration,
  access policies, WebSocket refresh, and bounded credential validity for
  sessions, HTTP procedures, and SSE.
- [Ordered realtime and mutation semantics](docs/realtime.md) documents
  transition cursors, resume-or-reset behavior, read-your-writes mutation
  receipts, receiver-confirmed Protocol 2 SSE delivery, reconnect behavior, and
  the deliberately weaker live-event contract.
- [Operations, limits, and recovery](docs/operations.md) documents finite
  production defaults, typed outcomes, durability profiles, health endpoints,
  startup/readiness phases, evidence-preserving crash recovery, signal-driven
  draining, and verified backup/restore.
- [Telemetry](docs/telemetry.md) documents the default-on privacy boundary,
  tuning and disabling, bounded whole-operation tail retention and fail-open
  export, schema version 1 records, correlated auth/operation/receiver-delivery
  coverage, CLI backup/restore spans, and runtime/storage health metrics.
- [Production-readiness report](docs/production-readiness-report.md) records the
  full issue #1 implementation and decision history, verification and benchmark
  evidence, remaining release blockers, and the operational gap versus Convex
  Cloud and SpacetimeDB/Maincloud.

The remaining single-node and product limitations are listed explicitly in
[Operations: remaining limitations](docs/operations.md#remaining-limitations).

## Configuration and CLI

All `.zdb.config.json` fields are optional. The path defaults are
`./schema.ts`, `./functions`, `./_generated`, and `./.zdb`; the default port is
`3211`. External identity providers and the protected status scope are also
configured there. Durability and telemetry profiles are exact environment
switches:

```sh
DBZZ_DURABILITY=production DBZZ_TELEMETRY=enabled dbz start ./apps/server
```

`production` and `enabled` are the defaults. See the linked contract documents
before selecting `balanced` durability or disabling telemetry.

The CLI listener is plaintext HTTP/WebSocket on `127.0.0.1`; it does not
terminate TLS. Keep it on loopback or a private encrypted hop behind TLS
termination as described in the
[authentication trust boundary](docs/authentication.md#trust-boundary).

```sh
dbz dev [app-dir]
dbz start [app-dir]
dbz codegen [app-dir]
dbz reset [app-dir]
dbz status [app-dir]
dbz backup <artifact> [app-dir]
dbz restore <artifact> [app-dir]
```

## Development and performance

```sh
bun install
bun run test
bun run typecheck
bun run typecheck:bench
```

The comparative benchmark runs DBZZ, Convex, and SpacetimeDB on the same
machine and separately measures DBZZ's exact default telemetry, minimum
in-process exporter handoff cost, and fully disabled telemetry. Its workload,
durability profile, correctness gates, results, and interpretation limits are
documented in [bench/README.md](bench/README.md).

```sh
bun bench/run.ts
```
