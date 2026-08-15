# AckerDB — The All-in-One Back-End Framework

AckerDB is a single-node, stateful TypeScript backend built on Bun and SQLite. It
provides typed queries, transactional mutations, procedures, durable jobs,
live query subscriptions, and application channels over one versioned wire
contract.

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
| `@ackerdb/core` | Wire envelopes, encoding, outcomes, cursors, and typed function/channel references. |
| `@ackerdb/server` | Schema DSL, SQLite engine, function runtime, typed channels, authentication, reactivity, transport, and limits. |
| `@ackerdb/client` | Web-platform client for queries, mutations, procedures, SSE, subscriptions, channels, reconnect, and credential refresh. |
| `@ackerdb/client-react` | React and Expo provider/hooks for data, typed channels, authentication, and optional AI SDK integrations. |
| `@ackerdb/cli` | Application development, code generation, schema operations, backup/restore, status, and FileStore migration commands. |

Install public stable or canary packages from npm with exact versions:

```sh
bun add --exact @ackerdb/server@X.Y.Z @ackerdb/client@X.Y.Z @ackerdb/cli@X.Y.Z
```

## Application shape

```text
your-app/
├── apps/
│   ├── server/                 # app.ts, functions/, jobs/, .ackerdb.config.json
│   └── client/                 # any runtime with WebSocket, fetch, and Web Crypto
└── packages/
    └── server-codegen/
        └── _generated/{server,api,types}.ts
```

- `app.ts` default-exports `defineApp({ schema })`, the executable assembly
  point for the root `defineSchema(...)`. Persistent tables use `defineTable`;
  `defineEventTable` declares non-persistent live events.
- Functions use the generated `query`, `mutation`, `procedure`,
  `sseProcedure`, and `channel` constructors. Every declaration
  must declare `access` as
  `"public"`, `"authenticated"`, `"system"`, or a fail-closed policy callback.
  A declaration may also name its `apiPath`: the group it is published in and
  the first segment of its address, deciding its generated binding and its HTTP
  root together — `"internal"` addresses `internal.orders.list` and serves
  `/internal/orders/list`, and `"api"` is the default. A file named `index.ts`
  takes its directory's name. Namespacing and routing only; `access` alone
  decides who may call (ADR-0023).
- Queries run against a SQLite snapshot and record precise dependency keys.
  Mutations run through one serialized writer transaction. Procedures may do
  external work and open explicit `ctx.tx(...)` transactions. Durable jobs
  declared in `jobs/` execute as the local `system` principal with retries,
  recurrence, dedup, per-key concurrency, and durable steps — `ctx.step`
  journals completed work so a resumed run re-runs only what the journal has
  not recorded (see docs/jobs.md).
- Direct server-side query/mutation composition preserves the caller's
  immutable principal and still validates arguments and the callee's policy.
  Procedures exist at the transport boundary and as job steps —
  `ctx.step.run` is the journaled variant of the same nested invocation; SSE
  procedures exist only at the transport boundary.
- Generated client references carry compile-time inferred argument and return
  types without importing server runtime code into the client. Results are
  checked for wire representability and frame bounds, not against a declared
  runtime output schema.

The client takes exactly one credential authority: an explicit credential
(including explicit anonymous use, shown here) or a `credentialSource`
callback that owns the token lifecycle end to end (see the
[auth provider quickstart](docs/auth-providers.md)):

```ts
import { AckerDBClient } from "@ackerdb/client";
import { api } from "./_generated/api";

const client = new AckerDBClient({
  url: "http://127.0.0.1:3211",
  credential: { kind: "anonymous" },
});

const unsubscribe = client.subscribe(api.todos.list, {}, renderTodos);
await client.mutation(api.todos.create, { text: "ship it" });

unsubscribe();
client.close();
```

## Production contracts

- [Validators](docs/validators.md) is the canonical guide to `v`, numeric
  types, constraints, presence semantics, stored-data enforcement, and the
  deliberate pre-1.0 upgrade break.
- [Database queries](docs/database-queries.md) documents typed SQL predicates,
  serializable filter expressions, deterministic ordering and keyset pagination
  with server-enforced row and byte bounds, transparent indexes, conservative
  reactive dependencies, and structural upsert.
- [Full-text search](docs/full-text-search.md) documents explicit FTS5 targets,
  literal implicit-AND queries, predicate composition, deterministic rank
  order, reactivity, lifecycle, and application-owned hybrid rank fusion.
- [Vectors and exact similarity search](docs/vector-search.md) documents
  Float32 vector storage, external embedding generation, filtered cosine/L2/dot
  search, bounded ranking, reactivity, and backfill.
- [Files](docs/files.md) documents immutable File identity, local and generic
  S3-compatible stores, typed references, uploads, reactive metadata,
  revocable bearer/authenticated/validated URLs, deletion, and byte streaming.
- [Authentication and authorization](docs/authentication.md) documents strict
  bearer handling, immutable principals, external OIDC/JWKS configuration,
  access policies, WebSocket refresh, and bounded credential validity for
  sessions, HTTP procedures, and SSE.
- [Scopes and identity credentials](docs/scopes.md) documents the application
  scope vocabulary, wildcard grants and the reserved `_` framework space,
  `{ anyOf | allOf }` requirements on any function, and the credential vault
  that makes an agent a first-class Identity bounded by its issuer.
- [The Admin API](docs/admin-api.md) documents the built-in administration
  surface: the `admin` group every application publishes, the framework's
  `_admin:<domain>:<verb>` vocabulary, what "inert without a grant" means
  exactly, the reference tree shipped from `@ackerdb/core`, and the one `admin`
  configuration object.
- [Auth providers](docs/auth-providers.md) is the per-provider recipe book —
  Clerk, WorkOS AuthKit, Auth0, and BetterAuth — with each provider's exact
  issuer string, configuration block, and client credential-source wiring.
- [Ordered realtime and mutation semantics](docs/realtime.md) documents
  transition cursors, resume-or-reset behavior, read-your-writes mutation
  receipts, receiver-confirmed SSE delivery, reconnect behavior, and
  the deliberately weaker live-event contract.
- [Application channels](docs/channels.md) documents typed bidirectional
  events, opt-in rooms, shared memberships, handler deduplication, and
  reconnect behavior over the existing application WebSocket.
- [Operations, limits, and recovery](docs/operations.md) documents finite
  production defaults, typed outcomes, durability profiles, health endpoints,
  startup/readiness phases, evidence-preserving crash recovery, signal-driven
  draining, and verified backup/restore.
- [React, Expo, and AI SDK client](docs/client-react.md) is the canonical guide
  to `@ackerdb/client-react`: supported versions, provider lifetime, every hook,
  durable Identity, native recovery, and current platform limitations.
- [MCP release gates](docs/mcp-conformance.md) documents the pinned official
  conformance scenarios, retained raw protocol/security cases, clean packed
  consumer, real Codex and Claude Code host acceptance, unsupported optional
  capabilities, and package boundaries.
- [MCP and AI integration](docs/ai-integration.md) documents endpoint-owned
  tool blueprints, exact generated tool types, and the in-process AI SDK
  adapter.
- [Releases and protected branches](docs/releases.md) documents the
  `topic → canary → main` topology, fast affected CI, reviewer-gated public npm
  delivery, trusted publishing, and local Verdaccio betas.

The remaining single-node and product limitations are listed explicitly in
[Operations: remaining limitations](docs/operations.md#remaining-limitations).

## Configuration and CLI

All `.ackerdb.config.json` fields are optional. The path defaults are
`./app.ts`, `./functions`, `./_generated`, and `./.ackerdb`; the default port is
`3211`, and the default listener hostname is `127.0.0.1`. Set `hostname` to
`0.0.0.0` only when clients must connect through a trusted private development
network. Authentication can select either built-in `oidc` providers or one
application `credentialVerifier` module path (resolved from the app directory),
never both. The protected status scope is set in the same
`.ackerdb.config.json` through `statusScope`.
Durability is an exact environment switch:

```sh
ACKERDB_DURABILITY=production acker start ./apps/server
```

`production` is the default. See the linked contract documents before selecting
`balanced` durability.

The CLI listener is plaintext HTTP/WebSocket and does not terminate TLS. Keep
the default loopback listener or place a non-loopback listener behind a private
encrypted hop and TLS termination as described in the
[authentication trust boundary](docs/authentication.md#trust-boundary).

```sh
acker dev [app-dir]
acker start [app-dir]
acker codegen [app-dir]
acker openapi <document> [app-dir]
acker reset [app-dir]
acker status [app-dir]
acker backup <artifact> [app-dir] [--metadata-only]
acker restore <artifact> [app-dir]
acker files migrate <target.json> [app-dir]
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
bun run typecheck:tooling
```

Prepare a branch's release intent once it is based on the current target, then
publish as many local Verdaccio betas as real-application testing needs:

```sh
bun run release:prepare patch # or minor | major
bun run publish:beta
```

## License

AckerDB's main packages are source-available under the
[Functional Source License 1.1 with an Apache 2.0 future license](LICENSE.md).
Each released version becomes available under Apache-2.0 two years after that
version is first made available.
