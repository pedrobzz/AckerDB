# Internal functions are erased visibility, not a separate function kind

Every registered query, mutation, and procedure is today a wire endpoint.
Visibility and admission are conflated in one declaration: `access: "system"`
guards *who may call* but cannot express *this has no client address*, so a
system-only function still appears in generated client types, and — more
importantly — there is no way to write a registered function that composes
server-side on behalf of a real principal without also becoming a public
endpoint. The only alternative is a plain TypeScript helper, which forfeits
argument validation, the typed result contract, and the nested mutation
scope. Durable job steps sharpened the need: `step.run` wants reusable named
targets that are deliberately not part of the application's client surface.

Convex answers this with a constructor split — `query` versus
`internalQuery` — and two generated namespaces. We reject the split: it
duplicates every builder, and it buys compile-time invisibility at the cost
of conflating the two axes the other way (internal functions there have no
admission model at all; any server-side caller is trusted). AckerDB's
composition contract re-validates the callee's access policy against the
caller's immutable principal, and that is worth keeping.

The decision: visibility becomes one optional literal field, `internal:
true`, on query, mutation, and procedure declarations. It is a fourth type
parameter on the registered-function type, so generated client surfaces erase
internal functions structurally — the same key-erasure mechanism
`RegisteredServerOnly` already uses — and a sibling `internal.*` tree exposes
exactly the erased references to server-side callers (jobs, steps,
composition). Access is untouched and orthogonal: an internal function still
declares `access`, composition still validates it, and `"system"` still
means what it means. `internal: true, access: "authenticated"` is a newly
expressible point — a composable non-endpoint acting for a real user.

Making `access` itself type-visible was rejected because a policy callback
cannot be evaluated by a mapped type; a boolean literal has no such problem.
The field accepts only the literal `true` (absence means `false`), so a
computed boolean cannot widen the type and silently leak a function into the
client surface.

Boundary consequences. The transport treats a remote call to an internal
function exactly as it treats a name that never existed — internal functions
have no wire address, rather than a guarded one. HTTP exposure on the same
declaration as `internal: true` is a self-contradiction and refuses at
startup; the config always shows the decision. An MCP endpoint's `tools`
record may name an internal function: the endpoint is its own declaration
with its own authentication, and naming the function there is the explicit
re-exposure, not an override. SSE procedures, channels, and realtime
declarations cannot be internal — they exist only at the transport boundary,
so an internal one would be a function nobody could call; the field is
absent from their types and refused at startup for untyped callers.
