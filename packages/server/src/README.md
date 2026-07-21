# Server source map

`index.ts` is the package entrypoint. Implementation lives in ownership-based
modules; do not add new implementation files to this root.

| Module | Owns |
| --- | --- |
| `app/` | Application definitions, function builders, invocation, and registration |
| `auth/` | Credentials, invalidation, and verifier leases |
| `database/` | SQLite access, engine, durability artifacts, ownership, restore, and reset |
| `mcp/` | MCP declarations, scopes, tokens, HTTP handling, content, and wire behavior |
| `plugins/` | Plugin definitions, dependency assembly, runtime calls, and private storage |
| `realtime/` | Publications, reactive subscriptions, delivery, and sessions |
| `runtime/` | Admission, execution, mutation coordination, request outcomes, and orchestration |
| `schema/` | Schema definitions, snapshots, planning, reconciliation, and migrations |
| `shared/` | Small dependency-free primitives used across multiple modules |
| `telemetry/` | Telemetry records, trace journals, and external trace capture |
| `transport/` | HTTP/WebSocket server ownership and public routes |
| `validation/` | Validators, Standard Schema/JSON, constraints, and validation errors |

Place a file with the module that owns its invariants. Cross-module imports
should name that owner directly; internal barrel files are intentionally
absent.
