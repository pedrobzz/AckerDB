# Server source map

`index.ts` is the package entrypoint. `boot.ts` is the one implementation file
at this root: the boot composes every module below into a running application
(listener → schema → runtime → activation) and belongs to none of
them. Every other implementation file lives in the ownership-based module that
owns its invariants; do not add new files to this root.

| Module | Owns |
| --- | --- |
| `app/` | Application definitions, function builders, invocation, and registration |
| `auth/` | Principals, external accounts and Identities, invalidation, and verifier leases |
| `channels/` | Typed application-channel declarations, optional rooms, membership, and fan-out |
| `credentials/` | Identity credentials: the table, the policy module, and the invocation capability |
| `database/` | SQLite access, engine, durability artifacts, ownership, restore, and reset |
| `files/` | File identity, durable store binding, lifecycle, transfer, and physical-store adapters |
| `mcp/` | MCP declarations, scopes, tokens, HTTP handling, content, and wire behavior |
| `subscriptions/` | Publications, reactive subscriptions, delivery, and sessions |
| `runtime/` | Admission, execution, mutation coordination, request outcomes, and orchestration |
| `schema/` | Schema definitions, snapshots, planning, reconciliation, and migrations |
| `shared/` | Small dependency-free primitives used across multiple modules |
| `transport/` | HTTP/WebSocket server ownership, the public route surface, and its OpenAPI document |
| `validation/` | Validators, JSON Schema emission, Standard Schema/JSON, constraints, and validation errors |

Place a file with the module that owns its invariants. Cross-module imports
should name that owner directly; internal barrel files are intentionally
absent.
