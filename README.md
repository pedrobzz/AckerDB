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
| `@dbzz/cache` | Disposable server-side Cache Plugin with built-in SQLite, Redis, Upstash, and custom-store backends. |
| `@dbzz/client` | Web-platform client for queries, mutations, procedures, SSE, subscriptions, reconnect, and credential refresh. |
| `@dbzz/client-react` | React and Expo provider/hooks for live queries, mutations, procedures, events, SSE, authentication, and optional AI SDK chat transport. |
| `@dbzz/cli` | `dbzz dev`, `start`, `codegen`, `reset`, `status`, `backup`, and `restore`. |

## Application shape

```text
your-app/
├── apps/
│   ├── server/                 # app.ts, functions/, .dbzz.config.json
│   └── client/                 # any runtime with WebSocket, fetch, and Web Crypto
└── packages/
    └── server-codegen/
        └── _generated/{server,api,types}.ts
```

- `app.ts` default-exports `defineApp({ schema, plugins })`, the executable
  assembly point for the root `defineSchema(...)` and explicitly mounted
  server-side Plugins. Persistent tables use `defineTable`; `defineEventTable`
  declares non-persistent live events.
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

- [Validators](docs/validators.md) is the canonical guide to `v`, numeric
  types, constraints, presence semantics, stored-data enforcement, and the
  deliberate pre-1.0 upgrade break.
- [Plugins](docs/plugins.md) documents private schemas, contracts, flat
  dependency injection, direct context mounts, execution boundaries,
  lifecycle, and alpha storage reset/drop behavior.
- [Cache](docs/cache.md) documents disposable Cache semantics, namespaces,
  limits, TTL and conditions, and built-in, Redis, Upstash, or custom stores.
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
- [React, Expo, and AI SDK client](docs/client-react.md) is the canonical guide
  to `@dbzz/client-react`: supported versions, provider lifetime, every hook,
  durable Identity, native recovery, and current platform limitations.
- [MCP release gates](docs/mcp-conformance.md) documents the pinned official
  conformance scenarios, retained raw protocol/security cases, clean packed
  consumer, real Codex and Claude Code host acceptance, unsupported optional
  capabilities, and benchmark contract.
- [MCP and AI integration](docs/ai-integration.md) documents endpoint-owned
  tool blueprints, exact generated tool types, and the in-process AI SDK
  adapter.
- [Production-readiness report](docs/production-readiness-report.md) records the
  full issue #1 implementation and decision history, verification and benchmark
  evidence, remaining release blockers, and the operational gap versus Convex
  Cloud and SpacetimeDB/Maincloud.

The remaining single-node and product limitations are listed explicitly in
[Operations: remaining limitations](docs/operations.md#remaining-limitations).

## Configuration and CLI

All `.dbzz.config.json` fields are optional. The path defaults are
`./app.ts`, `./functions`, `./_generated`, and `./.dbzz`; the default port is
`3211`. Authentication can select either built-in `oidc` providers or one
application `credentialVerifier` module path (resolved from the app directory),
never both. The protected status scope is configured there too. Durability and
telemetry profiles are exact environment switches:

```sh
DBZZ_DURABILITY=production DBZZ_TELEMETRY=enabled dbzz start ./apps/server
```

`production` and `enabled` are the defaults. See the linked contract documents
before selecting `balanced` durability or disabling telemetry.

The CLI listener is plaintext HTTP/WebSocket on `127.0.0.1`; it does not
terminate TLS. Keep it on loopback or a private encrypted hop behind TLS
termination as described in the
[authentication trust boundary](docs/authentication.md#trust-boundary).

```sh
dbzz dev [app-dir]
dbzz start [app-dir]
dbzz codegen [app-dir]
dbzz plugin reset <mount> [app-dir]
dbzz plugin drop <mount> [app-dir]
dbzz reset [app-dir]
dbzz status [app-dir]
dbzz backup <artifact> [app-dir]
dbzz restore <artifact> [app-dir]
```

## Development and performance

```sh
bun install
bun run test
bun run test:mcp:conformance
bun run test:packages
# Requires locally installed and authenticated Codex and Claude Code hosts:
bun run test:mcp:hosts
bun run typecheck
bun run typecheck:bench
```

The comparative benchmark is release evidence: every major, minor, or patch
version is measured once on Hetzner against the preceding version's final
record. It runs DBZZ, Convex, and SpacetimeDB with the same workload and
separately measures DBZZ's exact default telemetry, minimum in-process exporter
handoff cost, and fully disabled telemetry. Its recovery process, naming, and
interpretation limits are documented in [bench/README.md](bench/README.md).

```sh
bun run bench:hetzner # dispatch from a background worker after bun run bump
```
