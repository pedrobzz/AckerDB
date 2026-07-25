# Function Results own application errors and mutation scopes

Expected function failures need to be statically visible through nested server
calls and generated client references without forcing authors to redeclare the
transitive errors of every callee. At the same time, a nested mutation may write
before failing, and its caller may legitimately handle that failure and commit
other work. A plain error union solves the type problem but cannot provide the
required rollback boundary.

DBzz therefore treats the returned Result as both an application contract and,
for registered mutations, an atomic scope boundary.

## Consequences

Every registered query, mutation, and procedure call returns
`Result<Data, ApplicationError>` to server callers. Handlers may return a raw
success value as implicit `Ok`; expected failures must use
`Err(code, body, Status.*)`. Thrown values are unexpected failures, never
inferred application errors. A throw escaping a registered boundary poisons
the whole invocation tree and any ambient transaction even if an outer handler
catches it.

Every registered application mutation owns a child mutation scope. Success
merges its writes, returned `Err` discards its writes while leaving the parent
healthy, and throw poisons the parent. Top-level mutation application writes
are also scoped so a returned `Err` commits no application state. DBzz may
persist the completed error in framework idempotency metadata without
publishing an application-data commit.

Plugin operations retain their existing capability contracts in this runtime
beta. Bringing them under the same typed Result and child-scope contract is a
separate breaking Plugin-contract change; this ADR must not be read as claiming
that work has shipped.

`ctx.tx` remains the only public API for a procedure-owned transaction. Its
callback is Result-aware: success commits, `Err` rolls back, and throw poisons
and rolls back. A separate `ctx.atomic` API is unnecessary.

`mapErr` is partial and residual-preserving. It translates only named variants;
unmapped errors continue through the inferred union. `returns` constrains only
success, while optional `errors` constrains a deliberately stable public error
vocabulary. Neither is required for transitive inference.

The runtime-first beta uses TypeScript's inferred handler type directly through
the registered builders and current generated module map. The TypeScript 7.1
compiler follow-up will materialize shallow, self-contained client contracts
without implementing a second control-flow analyzer. Neither phase infers
arbitrary runtime validators from TypeScript types.

Successful payloads remain raw on the wire. Procedure application errors use
their named HTTP status; WebSocket results carry equivalent status metadata.
The protocol is versioned as a breaking change instead of supporting dual
result representations.

The complete authoring, transport, compiler, client-state, validation, and
performance contract is specified in
[Typed function results](../function-results.md).
