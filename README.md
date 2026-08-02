# AckerDB — The All-in-One Back-End Framework

AckerDB is a single-node, stateful TypeScript backend built on Bun and SQLite. It
provides typed queries, transactional mutations, procedures, scheduled work,
live query subscriptions, application channels, and WebRTC media sessions
through Protocol 5.

The supported production topology is one Bun server process owning one local
SQLite database file. AckerDB is not a horizontally scaled or replicated service,
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
| `@ackerdb/core` | Protocol 5 envelopes, wire encoding, outcomes, cursors, and typed function/channel/realtime references. |
| `@ackerdb/server` | Schema DSL, SQLite engine, function runtime, typed channels, WebRTC session integration, authentication, reactivity, transport, limits, and telemetry. |
| `@ackerdb/cache` | Disposable server-side Cache Plugin with built-in SQLite, Redis, Upstash, and custom-store backends. |
| `@ackerdb/client` | Web-platform client for queries, mutations, procedures, SSE, subscriptions, channels, WebRTC sessions, reconnect, and credential refresh. |
| `@ackerdb/client-react` | React and Expo provider/hooks for data, typed channels, WebRTC sessions, authentication, and optional AI SDK integrations. |
| `@ackerdb/cli` | `acker dev`, `start`, `codegen`, `reset`, `status`, `backup`, and `restore`. |

Install public stable or canary packages from npm with exact versions:

```sh
bun add --exact @ackerdb/server@X.Y.Z @ackerdb/client@X.Y.Z @ackerdb/cli@X.Y.Z
# Realtime applications also install the root optional-native selector:
bun add --exact @ackerdb/realtime@X.Y.Z
```

Do not install a host-specific `@ackerdb/realtime-*` package directly.

## Application shape

```text
your-app/
├── apps/
│   ├── server/                 # app.ts, functions/, .ackerdb.config.json
│   └── client/                 # any runtime with WebSocket, fetch, and Web Crypto
└── packages/
    └── server-codegen/
        └── _generated/{server,api,types}.ts
```

- `app.ts` default-exports `defineApp({ schema, plugins })`, the executable
  assembly point for the root `defineSchema(...)` and explicitly mounted
  server-side Plugins. Persistent tables use `defineTable`; `defineEventTable`
  declares non-persistent live events.
- Functions use the generated `query`, `mutation`, `procedure`,
  `sseProcedure`, `channel`, and `realtime` constructors. Every declaration
  must declare `access` as
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
import { AckerDBClient } from "@ackerdb/client";
import { api } from "./_generated/api";

const client = new AckerDBClient({
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
- [Database queries](docs/database-queries.md) documents typed SQL predicates,
  deterministic ordering and keyset pagination, transparent indexes,
  conservative reactive dependencies, and structural upsert.
- [Full-text search](docs/full-text-search.md) documents explicit FTS5 targets,
  literal implicit-AND queries, predicate composition, deterministic rank
  order, reactivity, lifecycle, and application-owned hybrid rank fusion.
- [Vectors and exact similarity search](docs/vector-search.md) documents
  Float32 vector storage, external embedding generation, filtered cosine/L2/dot
  search, bounded ranking, reactivity, and backfill.
- [Plugins](docs/plugins.md) documents private schemas, contracts, flat
  dependency injection, direct context mounts, execution boundaries,
  lifecycle, and alpha storage reset/drop behavior.
- [Services](docs/services.md) documents application-owned external services —
  broker consumers, job workers, webhook managers — their typed system
  authority, sequential startup, readiness reporting, fatal-failure handling,
  and the shutdown ordering that lets cleanup still write.
- [Cache](docs/cache.md) documents disposable Cache semantics, namespaces,
  limits, TTL and conditions, and built-in, Redis, Upstash, or custom stores.
- [Authentication and authorization](docs/authentication.md) documents strict
  bearer handling, immutable principals, external OIDC/JWKS configuration,
  access policies, WebSocket refresh, and bounded credential validity for
  sessions, HTTP procedures, and SSE.
- [Ordered realtime and mutation semantics](docs/realtime.md) documents
  transition cursors, resume-or-reset behavior, read-your-writes mutation
  receipts, receiver-confirmed Protocol 5 SSE delivery, reconnect behavior, and
  the deliberately weaker live-event contract.
- [Application channels](docs/channels.md) documents typed bidirectional
  events, opt-in rooms, shared memberships, handler deduplication, and
  reconnect behavior over the existing application WebSocket.
- [Realtime media sessions](docs/realtime-media.md) documents AckerDB-relayed
  WebRTC, native tracks, typed events and byte streams, signaling,
  deduplication, React/Expo setup, and the current native-server-engine
  boundary.
- [Operations, limits, and recovery](docs/operations.md) documents finite
  production defaults, typed outcomes, durability profiles, health endpoints,
  startup/readiness phases, evidence-preserving crash recovery, signal-driven
  draining, and verified backup/restore.
- [Telemetry](docs/telemetry.md) documents the default-on privacy boundary,
  tuning and disabling, bounded whole-operation tail retention and fail-open
  export, schema version 1 records, correlated auth/operation/receiver-delivery
  coverage, CLI backup/restore spans, and runtime/storage health metrics.
- [React, Expo, and AI SDK client](docs/client-react.md) is the canonical guide
  to `@ackerdb/client-react`: supported versions, provider lifetime, every hook,
  durable Identity, native recovery, and current platform limitations.
- [MCP release gates](docs/mcp-conformance.md) documents the pinned official
  conformance scenarios, retained raw protocol/security cases, clean packed
  consumer, real Codex and Claude Code host acceptance, unsupported optional
  capabilities, and benchmark contract.
- [MCP and AI integration](docs/ai-integration.md) documents endpoint-owned
  tool blueprints, exact generated tool types, and the in-process AI SDK
  adapter.
- [Releases and protected branches](docs/releases.md) documents the
  `topic → canary → main` topology, fast affected CI, paired AckerDB benchmark,
  staged public npm delivery with 2FA approval, trusted publishing, and local
  Verdaccio betas.
- [Production-readiness report](docs/production-readiness-report.md) records the
  full issue #1 implementation and decision history, verification and benchmark
  evidence, remaining release blockers, and the operational gap versus Convex
  Cloud and SpacetimeDB/Maincloud.

The remaining single-node and product limitations are listed explicitly in
[Operations: remaining limitations](docs/operations.md#remaining-limitations).

## Configuration and CLI

All `.ackerdb.config.json` fields are optional. The path defaults are
`./app.ts`, `./functions`, `./_generated`, and `./.ackerdb`; the default port is
`3211`, and the default listener hostname is `127.0.0.1`. Set `hostname` to
`0.0.0.0` only when clients must connect through a trusted private development
network. Authentication can select either built-in `oidc` providers or one
application `credentialVerifier` module path (resolved from the app directory),
never both. The protected status scope is configured there too. Durability and
telemetry profiles are exact environment switches:

```sh
ACKERDB_DURABILITY=production ACKERDB_TELEMETRY=enabled acker start ./apps/server
```

`production` and `enabled` are the defaults. See the linked contract documents
before selecting `balanced` durability or disabling telemetry.

The CLI listener is plaintext HTTP/WebSocket and does not terminate TLS. Keep
the default loopback listener or place a non-loopback listener behind a private
encrypted hop and TLS termination as described in the
[authentication trust boundary](docs/authentication.md#trust-boundary).

```sh
acker dev [app-dir]
acker start [app-dir]
acker codegen [app-dir]
acker openapi <document> [app-dir]
acker plugin reset <mount> [app-dir]
acker plugin drop <mount> [app-dir]
acker reset [app-dir]
acker status [app-dir]
acker backup <artifact> [app-dir]
acker restore <artifact> [app-dir]
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
bun run typecheck:tooling
```

GitHub's required benchmark status first classifies the pull request. It returns
an immediate successful no-op unless code exercised by the benchmark or the
benchmark contract itself changed. For those performance-relevant changes, it
compares the pull request's AckerDB with its base branch's AckerDB on the
credential-free GitHub-hosted runner. Telemetry stays disabled unless telemetry source
changed. The check records evidence without thresholds or an automated verdict;
Pedro and an agent interpret the complete vector.
Do not run the protected benchmark locally. See [the benchmark
contract](bench/README.md).

Prepare a branch's release intent once it is based on the current target, then
publish as many local Verdaccio betas as real-application testing needs:

```sh
bun run release:prepare patch # or minor | major
bun run publish:beta
```
