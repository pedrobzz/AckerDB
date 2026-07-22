# Plugins

Plugins are server-side capabilities assembled explicitly by the application.
Each mounted Plugin instance owns a private schema and an operation tree; the
host sees only that tree as a direct context capability such as `ctx.cache`.
Plugins do not mutate a registry, inherit application state, or expose routes
to clients.

## Define, inject, and mount

`definePlugin` returns a pure factory. A contract describes the smallest
operation tree a dependency consumer needs, including operation kinds and
validator descriptors. Providers are matched structurally, so a consumer does
not depend on a provider's package identity and the provider may export more
than the contract requires. TypeScript compares the operation tree, execution
kind, canonical accepted input, and canonical produced result. It deliberately
ignores the consumer's exposed call adapter and the provider's normalized
handler input; assembly separately proves exact validator-descriptor equality.

```ts
import {
  defineApp,
  definePlugin,
  definePluginContract,
  defineSchema,
  defineTable,
  pluginMutation,
  pluginQuery,
  v,
} from "@dbzz/server";

const storeContract = definePluginContract({
  get: pluginQuery({
    args: { key: v.string() },
    returns: v.int().optional(),
    expose: (call) => (key: string) => call({ key }),
  }),
  put: pluginMutation({
    args: { key: v.string(), value: v.int() },
    returns: v.boolean(),
    expose: (call) => (key: string, value: number) => call({ key, value }),
  }),
});

const storeSchema = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    value: v.int(),
  }).index(["key"], { unique: true }),
});

const storePlugin = definePlugin({
  id: "@acme/store",
  schema: storeSchema,
  create: ({ query, mutation }) => ({
    exports: {
      get: query(storeContract.get, async (ctx, { key }) =>
        (await ctx.db.entries.query().where((entry) => entry.key.eq(key)).unique())?.value
      ),
      put: mutation(storeContract.put, async (ctx, { key, value }) => {
        const row = await ctx.db.entries.query().where((entry) => entry.key.eq(key)).unique();
        if (row === null) await ctx.db.entries.insert({ key, value });
        else await ctx.db.entries.patch(row.id, { value });
        return true;
      }),
    },
  }),
});

const counterPlugin = definePlugin({
  id: "@acme/counter",
  schema: defineSchema({}),
  dependencies: { store: storeContract },
  create: ({ mutation }, config: { prefix: string }) => ({
    exports: {
      increment: mutation({
        args: { name: v.string() },
        returns: v.int(),
        expose: (call) => (name: string) => call({ name }),
        handler: async (ctx, { name }) => {
          const key = `${config.prefix}:${name}`;
          const next = (await ctx.store.get(key) ?? 0) + 1;
          await ctx.store.put(key, next);
          return next;
        },
      }),
    },
  }),
});

const store = storePlugin();
const counters = counterPlugin({ store, prefix: "counter" });

export default defineApp({
  schema: defineSchema({}),
  plugins: { store, counters },
});
```

Dependency injection uses the same flat factory options object as ordinary
configuration: `counterPlugin({ store, prefix })`. The provider instance must
also appear once in `defineApp({ plugins })`. Assembly rejects missing or
incompatible providers, duplicate mounts, dependency cycles, and mount or slot
names that collide with built-in context fields. A dependency is available to
the consumer under its local slot (`ctx.store` above); it is not inherited or
automatically re-exported.

`pluginQuery`, `pluginMutation`, and `pluginProcedure` define reusable contract
operations. A builder can implement one of those specs or define an operation
inline. Without `expose`, a caller passes the validated argument object. An
`expose` adapter may replace that public TypeScript call shape, as the examples
do, while the canonical provider boundary remains the declared object shape.
For an injected call, the dependency contract owns that caller-facing adapter
and proves descriptor compatibility; the provider's own matching validator
performs runtime validation and normalization before its handler runs.

Plugin packages that need a private normalized handler value can compose the
declared validator with `pluginValidator.normalize(...)`. Its input type,
descriptor, and dependency compatibility stay canonical while only the Plugin
handler sees the normalized result. `pluginValidator.opaque(...)` and
`pluginValidator.optional(...)` cover values that are intentionally outside
the application schema DSL; Plugin packages should prefer ordinary `v`
validators whenever no private normalization is needed.

## Direct context capabilities

Code generation reads `app.ts` and adds legal mounts directly to generated
function contexts. There is no `ctx.plugins` wrapper:

```ts
import { mutation } from "./_generated/server";

export const incrementOrders = mutation({
  access: "system",
  args: {},
  handler: (ctx) => ctx.counters.increment("orders"),
});
```

The caller's execution kind determines which operation kinds exist:

| Caller | Plugin operations available |
| --- | --- |
| Query | Query |
| Mutation | Query and mutation, in the caller's transaction |
| Procedure or SSE procedure | Query, mutation, and procedure; direct database operations receive separate read/write boundaries |
| `ctx.tx(...)` inside a procedure | Query and mutation, together in that explicit transaction |

A mount or nested namespace with no legal operation at a boundary is absent
rather than present as an empty object. Several direct calls from a procedure
are not automatically atomic; put the query/mutation work in one `ctx.tx(...)`
when it must commit together. Procedure operations remain unavailable inside a
transaction.

## Private state and lifecycle

Every unique mount owns an isolated instance of the Plugin's static schema.
Private schemas may contain ordinary persistent tables and indexes; Plugin
event tables and scheduled tables are rejected because those runtime surfaces
belong to the host application.

Plugin query and mutation handlers receive `ctx.db` scoped only to that private
schema, plus the invocation's frozen `ctx.timestamp`, the actual `ctx.mount`,
and legal dependency slots. Procedure handlers receive `ctx.abortSignal` and
`ctx.tx(...)` instead of ambient database access. Plugin handlers never receive
the application's `ctx.auth`; identity or claims must cross a Plugin boundary
as declared, validated arguments.

Application manifests are imported by code generation and startup, so factory
construction and `create` must perform no I/O. A Plugin that owns a connection
or another runtime resource returns a `lifecycle` callback alongside
`exports`. DBZZ starts lifecycles after schemas and dependencies are ready,
passes a startup/shutdown `AbortSignal`, tears down already-started resources
after startup failure, and runs returned cleanup callbacks in reverse
dependency order.

## Private-schema changes in the alpha

DBZZ automatically reconciles safe private-schema changes. The v0.6.0 alpha
has no Plugin migrations or rename inference: an unsafe change or a different
definition at the same mount requires an explicit reset of exactly that mount;
removing or renaming a mount leaves a stale scope that requires an explicit
drop. Both actions clear only the named Plugin scope and are guarded by the
exact current and target fingerprints DBZZ just inspected.

```sh
dbzz plugin reset <mount> [app-dir]
dbzz plugin drop <old-mount> [app-dir]
```

The commands execute only when the matching requirement is currently pending;
they are not arbitrary deletion commands. See
[Plugin storage reconciliation](operations.md#plugin-storage-reconciliation)
for interactive and non-interactive startup behavior.
