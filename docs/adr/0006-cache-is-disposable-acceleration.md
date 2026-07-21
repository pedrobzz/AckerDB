# Cache is disposable acceleration behind one bounded contract

DBzz Cache is disposable key/value acceleration, never a source of truth:
clearing it may make work slower but cannot change a correct application result.
`@dbzz/cache` exposes one small TypeScript-native contract backed either by
Plugin-owned SQLite storage or by an external store such as Redis or Upstash.
It is Redis-inspired rather than Redis-compatible so backend-specific machinery
does not leak into application code.

## Consequences

The v0.6.0 API contains only `get`, `set`, and `delete`. A miss is `undefined`,
`null` is cacheable, and store failures throw `CacheStoreError` with their
original cause rather than masquerading as misses or unmet conditions. Keys are
unambiguously encoded strings, finite numbers, or bigints; values use one DBzz
wire-text encoding that every store treats as opaque. Optional definition-owned
namespaces add validation and a key prefix only: they do not create separate
storage, capacity, eviction, or lifecycle boundaries. Invalid values are misses
and are not synchronously deleted by reads.

Cache is absent from queries because queries already read the source database
and Cache would bypass reactive read tracking. The built-in store is available
transactionally to mutations and procedures and uses the caller's frozen
`ctx.timestamp`. External stores are procedure-only and use their provider's
native clock, capacity, TTL, and eviction semantics; DBzz does not add machinery
to conceal that execution-boundary difference.

Every built-in Cache instance has finite configurable byte, entry-size, and
entry-count limits, defaulting to 64 MiB total, 1 MiB per entry, and 10,000
entries across all namespaces. It performs no polling, timer, sweeper, or
read-triggered writes. Writes reclaim expired entries first and then evict the
oldest writes within bounded maintenance work, keeping idle CPU at zero and
avoiding LRU metadata writes on the read path.

`set` may replace expiration and perform an atomic `"missing"` or `"present"`
condition against live encoded store presence before decoding or validation.
Built-in expiration is derived from the invocation timestamp; external stores
receive the relative duration. `delete` removes one encoded key directly.
These operations preserve semantic outcomes separately from configuration,
capacity, transport, and storage failures.

`defineCacheStore({ keyPrefix, open })` is the only custom-store extension point
in the alpha. The explicit non-empty prefix identifies the application and
environment; Cache appends its encoding version, mount, namespace, key type,
and key. The opened handle implements only opaque `get`, atomic `set`, `delete`,
and optional `close`, while DBzz owns its lifecycle. The package's `/redis` and
`/upstash` exports are first-party adapters to this same contract, not separate
Cache APIs or packages.
