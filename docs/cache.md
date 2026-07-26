# Cache

`@ackerdb/cache` is a disposable, server-only Plugin. Cache entries may accelerate
work, but they are never application truth: clearing the entire Cache may make
the next operation slower and must not change its correct result. The API is
intentionally limited to `get`, `set`, and `delete`.

A miss is `undefined`. `null` is a valid cached value, while top-level
`undefined` cannot be stored. Keys are strings, finite numbers, or bigints;
their types remain distinct. Store failures throw `CacheStoreError` with the
provider error retained as `cause` rather than pretending to be misses or
failed conditions.

## Built-in Cache

Mount a Cache instance in the application manifest. Namespaces are optional,
but they provide useful input inference and validate values at the Cache
boundary:

```ts
import { cachePlugin } from "@ackerdb/cache";
import { defineApp, defineSchema, v } from "@ackerdb/server";

const cache = cachePlugin({
  namespaces: {
    userProfile: v.object({
      name: v.string(),
      avatarUrl: v.string().nullable(),
    }),
  },
});

export default defineApp({
  schema: defineSchema({}),
  plugins: { cache },
});
```

The mount is available directly in generated mutation and transaction
contexts:

```ts
const hit = await ctx.cache.userProfile.get(userId);
if (hit !== undefined) return hit;

const user = await ctx.db.users.get(userId);
if (user !== null) {
  await ctx.cache.userProfile.set(
    userId,
    { name: user.name, avatarUrl: user.avatarUrl },
    { expiresInMs: 60_000 },
  );
}
return user;
```

Namespaces are only validation and collision-safe key framing. They do not own
separate storage, capacity, eviction, configuration, or lifecycle. A value that
cannot be decoded or no longer passes its namespace validator is a miss and is
not deleted by the read. Without namespaces, the root operations are available
and `get<T>(key)` is an unchecked TypeScript cast:

```ts
const cache = cachePlugin();
const profile = await ctx.cache.get<{ name: string }>("profile:1");
```

There is deliberately no Cache capability in Query handlers. Queries already
read SQLite efficiently and must retain AckerDB's reactive dependency tracking.
The built-in Cache exports mutation-kind operations: a Mutation shares its
existing transaction, a direct call from a Procedure gets an AckerDB-owned writer
transaction, and calls inside one `ctx.tx(...)` share that explicit
transaction. The built-in store uses the invocation's frozen `ctx.timestamp`
for expiration.

### Set and delete outcomes

`set(key, value, options?)` returns `true` when it writes. The optional
`expiresInMs` must be a positive safe integer. The optional condition is
atomic against live encoded store presence:

- `{ if: "missing" }` writes only when no live entry exists;
- `{ if: "present" }` writes only when a live entry exists.

A condition that is not met returns `false`; storage or configuration failures
throw. Presence is checked before decoding or namespace validation, so an
encoded but invalid value still counts as present. `delete(key)` removes the
encoded entry and returns whether it was live; deleting a missing or already
expired entry returns `false`.

### Built-in limits and eviction

The built-in store defaults to:

| Limit | Default |
| --- | ---: |
| Total encoded key and value bytes | 64 MiB |
| One encoded entry | 1 MiB |
| Entries | 10,000 |

Override them with `maxBytes`, `maxEntryBytes`, and `maxEntries` on
`cachePlugin(...)`. Limits are shared across every namespace of one mount.
Writes first reclaim expired entries and then evict the oldest writes in
bounded batches. Reads perform no writes, and there is no timer, polling loop,
sweeper, or read-maintained LRU state, so an idle Cache has no background CPU
cost.

## Redis, Upstash, and custom stores

An external store changes the Cache Plugin's operations to procedure-kind
capabilities. They are available directly to Procedures and SSE procedures,
but not to Queries, Mutations, or `ctx.tx(...)`. The provider owns its clock,
TTL behavior, capacity, eviction, availability, and network cost; built-in
capacity options are therefore forbidden. External Cache mounts have an empty
private schema and create no SQLite Cache tables; only the built-in store owns
the private `entries` and `state` tables.

Changing an existing mount from the built-in store to an external store, or
back again, changes that mount's private-storage definition. Startup therefore
requires `acker plugin reset <mount>` before it can continue. The targeted reset
clears only that AckerDB Plugin scope, which is safe because Cache data is
disposable; it does not delete keys from Redis, Upstash, or a custom provider.

Redis uses Bun's native `RedisClient` and one atomic `SET` command for TTL and
conditions:

```ts
import { cachePlugin } from "@ackerdb/cache";
import { redisCacheStore } from "@ackerdb/cache/redis";

const cache = cachePlugin({
  store: redisCacheStore({
    url: process.env.REDIS_URL!,
    keyPrefix: "my-app:production",
  }),
});
```

Upstash sends one authenticated REST command per operation:

```ts
import { cachePlugin } from "@ackerdb/cache";
import { upstashCacheStore } from "@ackerdb/cache/upstash";

const cache = cachePlugin({
  store: upstashCacheStore({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    keyPrefix: "my-app:production",
  }),
});
```

Factories are declarations and perform no network I/O. AckerDB opens and closes
the store through Plugin lifecycle. Upstash forwards each request's
`AbortSignal`. Bun's Redis client has no per-command signal: an already-aborted
operation is rejected before dispatch, while an operation already dispatched
awaits its real Redis outcome so a write is never reported ambiguously.

For another backend, pass `cachePlugin` a
`defineCacheStore({ keyPrefix, open })` definition:

```ts
import {
  cachePlugin,
  defineCacheStore,
  type CacheStoreHandle,
} from "@ackerdb/cache";

declare function openMyStore(signal: AbortSignal): Promise<CacheStoreHandle>;

const store = defineCacheStore({
  keyPrefix: "my-app:production",
  open: ({ abortSignal }) => openMyStore(abortSignal),
});

const cache = cachePlugin({ store });
```

The opened handle provides `get`, atomic `set`, `delete`, and optional `close`
methods. Every operation receives the fully framed string key and a request
`AbortSignal`; `set` also receives the opaque payload, optional `expiresInMs`,
and optional `if` condition.

`keyPrefix` is required to separate an application and environment. AckerDB adds
the encoding version, Plugin mount, namespace, key type, and framed key. The
store must treat payload strings as opaque, implement TTL and `"missing"` /
`"present"` atomically, observe lifecycle and request cancellation where its
transport permits, and return booleans for `set` and `delete`. Namespace
validation and wire encoding remain owned by `@ackerdb/cache`, so all backends
present the same application API.
