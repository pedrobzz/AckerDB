# Cache source map

`index.ts` is the package entrypoint. Cache implementation is split by
ownership:

| Module | Owns |
| --- | --- |
| `plugin/` | Cache Plugin definition, options, namespace validation, operations, and private schema |
| `storage/` | Shared storage interface, key/value encoding, built-in SQLite behavior, and external dispatch |
| `adapters/` | Concrete Redis and Upstash adapters exposed as package subpaths |

New cache backends belong in `adapters/`; provider-independent behavior stays
in `storage/` or `plugin/` according to which interface owns it.
