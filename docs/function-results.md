# Typed function results

Status: runtime-first beta implemented; materializing compiler pending.

AckerDB queries, mutations, and procedures expose expected application failures as
typed `Result<Data, Error>` values. The contract is Rust-inspired, but it keeps
ordinary TypeScript authoring: a handler may return its success value directly,
while `Err(...)` is always explicit. Thrown failures remain outside the
application-error contract.

The beta applies to application queries, mutations, and procedures. Ordinary
TypeScript helpers are not registered function boundaries. SSE handler
completion and event streams retain their existing contracts. An SSE
procedure's `ctx.tx` does use the same Result-aware transaction contract.

## Desired authoring model

```ts
import { Err, Status } from "@ackerdb/core";
import { query, v } from "./_generated/server";

export const getOrder = query({
  args: { orderId: v.string() },
  returns: v.object({
    id: v.string(),
    total: v.float(),
  }),
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.orders.get(orderId);
    if (order === null) {
      return Err("order-not-found", { orderId }, Status.NotFound);
    }
    return { id: order.id, total: order.total };
  },
});
```

The raw object is implicit `Ok`. The registered server function and generated
reference carry:

```ts
Result<
  { readonly id: string; readonly total: number },
  ApplicationError<"order-not-found", { readonly orderId: string }, 404>
>
```

An explicit `Ok(value)` remains available when it improves control-flow
inference, but it is never required.

## Semantic contract

Every registered call has exactly three semantic outcomes:

1. A returned raw value or `Ok(value)` is success.
2. A returned `Err(code, body, status)` is an expected, typed application
   error.
3. A thrown value is an unexpected failure outside the application Result.

The Result boundary is on the registered call, not necessarily on the handler
syntax. A handler's accepted output is conceptually:

```ts
type HandlerOutcome<T, E extends ApplicationError> =
  | T
  | OkResult<T>
  | ErrResult<E>;
```

Calling a registered query, mutation, or procedure from server code always
returns `Promise<Result<T, E>>`. Directly callable procedures therefore become
normal nested registered invocations, sharing the caller's principal,
invocation timestamp, deadline, and abort signal without silently opening a
database transaction.

The Result objects use a private runtime brand. A success payload that happens
to contain `ok`, `data`, or `error` properties cannot be mistaken for a Result.

## Core types

The public surface belongs in `@ackerdb/core`. The exact internal representation
may change, but its observable type is equivalent to:

```ts
type ApplicationError<
  Code extends string = string,
  Body = WireData,
  HttpStatus extends ErrorHttpStatus = ErrorHttpStatus,
> = Readonly<{
  kind: "application";
  code: Code;
  body: Body;
  status: HttpStatus;
}>;

type OkResult<T> = Readonly<{
  ok: true;
  data: T;
  error?: never;
}>;

type ErrResult<E> = Readonly<{
  ok: false;
  data?: never;
  error: E;
}>;

type Result<T, E> =
  | OkResult<T>
  | ErrResult<E>;
```

`Ok`, `Err`, `Result`, `ApplicationError`, and `Status` are exported from
`@ackerdb/core`. Result objects are immutable and also expose the typed `mapErr`
operation specified below. `Err` requires a literal code, a wire-representable
body, and a named error status.

The application error itself is the `error` field. Therefore normal handling is
ordinary discriminated-union narrowing:

```ts
const order = await getOrder(ctx, { orderId });
if (!order.ok) {
  if (order.error.code === "order-not-found") {
    return order;
  }
}

order.data.id;
```

## Named HTTP statuses

`Status` is a runtime `as const` object, not a TypeScript `enum`. Each property
has TSDoc that shows its number and standard meaning:

```ts
export const Status = {
  /** 400 Bad Request — the request is invalid for this operation. */
  BadRequest: 400,
  /** 404 Not Found — the requested resource does not exist. */
  NotFound: 404,
  /** 409 Conflict — the request conflicts with current state. */
  Conflict: 409,
  /** 503 Service Unavailable — the service cannot currently complete it. */
  ServiceUnavailable: 503,
  // The complete supported 4xx and 5xx catalog.
} as const;
```

The implementation ships one documented catalog of the supported standard 4xx
and 5xx statuses. `Err` accepts only values from that catalog rather than an
arbitrary number. This preserves literal inference and prevents invalid or
success statuses on failures.

Within one published function contract, one application-error code has one
status. Reusing a code with incompatible statuses is a compiler error. If the
same code is returned with different body shapes, its body becomes their union;
the compiler reports an error when that union cannot be usefully discriminated
and recommends separate codes.

## Partial, residual-preserving `mapErr`

`mapErr` changes selected application errors into the vocabulary of the current
function. It is deliberately partial: every unmapped variant remains in the
result type unchanged.

```ts
const payment = await ctx.payments.charge({ orderId });

if (!payment.ok) {
  return payment.mapErr({
    "stripe.card-declined": () =>
      Err("payment-failed", { reason: "declined" }, Status.PaymentRequired),

    "stripe.3ds-required": (error) =>
      Err(
        "payment-action-required",
        { actionUrl: error.body.actionUrl },
        Status.PaymentRequired,
      ),

    "stripe.timeout": () =>
      Err("payment-unavailable", { retryAfterMs: 500 }, Status.ServiceUnavailable),
  });
}
```

For `Result<T, E>` and mapping keys `K`, the returned error union is:

```ts
Exclude<E, { code: K }> | ErrorsReturnedByTheSelectedMappers
```

The compiler and TypeScript API must provide:

- autocomplete for the exact reachable error codes;
- the exact error variant as each mapper's argument;
- a type error for a mapping key that is not reachable;
- preservation of every unmapped error without requiring boilerplate; and
- the same runtime `Err` value for an unmapped variant.

Exact keys are the first-version API. Prefix wildcards and catch-all mappings
are deferred because they weaken exhaustiveness and make renamed codes easier
to miss.

## Optional `returns` and `errors`

`returns` constrains only the success value. An endpoint does not have to
redeclare every error merely because it uses a strict success schema.

```ts
const getOrder = query({
  args: { orderId: v.string() },
  returns: v.object({
    id: v.string(),
    total: v.float(),
  }),
  handler: async (ctx, args) => {
    // Raw success values must satisfy returns.
    // Every reachable Err is inferred independently.
  },
});
```

`errors` is also optional. It is useful when an application intentionally wants
to freeze or validate a public error vocabulary:

```ts
const getOrder = query({
  args: { orderId: v.string() },
  returns: v.object({
    id: v.string(),
    total: v.float(),
  }),
  errors: {
    "order-not-found": {
      body: v.object({ orderId: v.string() }),
      status: Status.NotFound,
    },
  },
  handler: async (ctx, args) => {
    // ...
  },
});
```

When `errors` is absent, the registered builder publishes the inferred
application-error union. When it is present, it is an exact contract:

- every reachable `Err` must match one declared code, body, and status; and
- every declared variant must remain reachable from the handler return type.

The definition therefore fails to typecheck in both lying directions: returning
an undeclared error and declaring an error the implementation cannot return.
The generated client type uses that exact declared set.

No application is required to list the transitive errors of every callee.
Requiring that list would duplicate information, create drift, and defeat the
main reason for the compiler.

## Returned errors and thrown failures are different

Application code uses `Err` for every expected failure a caller may handle.
Throwing is reserved for defects and framework failures.

A throw escaping a registered handler:

- rejects that server-side call instead of producing `Result.ok === false`;
- is never added to the inferred application-error union;
- marks the registered invocation tree as poisoned before it reaches a caller;
- cannot be made committable by catching it in an outer registered function;
- rolls back the whole ambient transaction; and
- becomes a sanitized client failure at the top-level runtime boundary.

A throw caught locally before it escapes the same handler remains ordinary
JavaScript, but it is not a published or compiler-inferred error path. Once a
throw crosses a registered boundary, an invocation poison marker ensures this
cannot appear to recover:

```ts
try {
  await nestedMutation(ctx, args);
} catch {
  // The ambient transaction is still poisoned.
}

return { claimedSuccess: true }; // The outer boundary still fails.
```

Framework-owned access, input-validation, protocol, overload, and availability
outcomes remain framework failures rather than pretending to be application
`Err` variants. Application code cannot obtain a typed error contract by
throwing a framework error class.

The client receives only a bounded sanitized message for an unexpected server
failure. Raw thrown values, stack traces, SQL, and private causes never cross
the server boundary. Incident identifiers are not part of the beta protocol.

## Mutation rollback semantics

Every registered mutation owns an application mutation scope.

| Boundary outcome | Application writes | Parent transaction |
| --- | --- | --- |
| `Ok` or raw success | Merge into the parent scope | Remains healthy |
| Returned `Err` | Roll back this mutation's scope | Remains healthy |
| Escaped throw | Roll back | Becomes poisoned and must roll back |

This applies equally to:

- top-level application mutations;
- nested application mutations.

It does not apply to registered queries, procedures, ordinary helpers, or
individual database operations.

An implementation will normally use a database savepoint for each nested
registered mutation, but the semantic boundary is the registered mutation, not
a public savepoint API. `ctx.atomic` is unnecessary.

An explicit `ctx.atomic` was initially attractive because Rust's `Result` is
only a value: Rust cannot assume that an arbitrary function returning `Err`
should undo side effects. AckerDB has a stronger boundary. A registered mutation
already promises one application operation, runs without external I/O, and is
visible to the runtime. Making that existing boundary own the child scope is
therefore predictable. It also prevents callers from accidentally forgetting
`ctx.atomic` around precisely the mutation whose error they intend to handle.

`ctx.tx` cannot replace this child scope. It opens a top-level database
transaction from a procedure and is deliberately rejected when a transaction
already exists. A nested mutation is already inside its caller's transaction;
what it needs is a child rollback boundary, not another top-level transaction.

The behavior that motivates the automatic scope is a handled nested error:

```ts
const reservation = await reserveStock(ctx, args);
if (!reservation.ok) {
  // reserveStock's writes have already been discarded.
  return { queued: true };
}
```

Without the automatic child scope, returning success here would commit writes
performed by `reserveStock` before it returned `Err`. Rolling back only when the
top-level function also returns `Err` cannot make handled nested errors safe.

If a caller propagates the nested `Err`, its own registered mutation scope also
rolls back. A top-level returned `Err` therefore commits no application writes.
AckerDB may durably store the error outcome in its idempotency ledger so a retry
receives the same completed Result. That framework metadata is not an
application-data commit and must not publish a data version.

An unhandled failure stores no successful application receipt and makes the
transaction outcome explicit. Existing mutation convergence fields such as
`committed` remain on transport/framework failures where the client may not
know whether a prior success committed.

### `ctx.tx`

`ctx.tx` remains the explicit way for a procedure to open a database
transaction. Its callback uses the same handler sugar and returns a typed
Result:

```ts
const reserved = await ctx.tx(async (tx) => {
  const result = await reserveStock(tx, args);
  if (!result.ok) return result;
  return { reservationId: result.data.id };
});
```

A raw value or `Ok` commits the transaction. `Err` rolls it back. A throw
poisons and rolls it back. Nested registered mutations inside `ctx.tx` still
own their automatic child scopes.

Opening `ctx.tx` inside an existing transaction remains invalid. External I/O
inside `ctx.tx` remains invalid. A procedure's work outside `ctx.tx`, including
external side effects, cannot be undone merely because the procedure later
returns `Err`.

## Transport representation

Result is a semantic and client-API contract, not a mandatory success envelope.

- A successful procedure uses HTTP 2xx and encodes `T` directly as its body.
- A procedure application error uses the `Err` status and encodes its code and
  body in the AckerDB error representation.
- Query and mutation WebSocket frames carry an explicit success,
  application-error, or framework-outcome discriminator. Application-error
  frames include the named status as metadata.
- The local client constructs `Result` objects after decoding. `Ok` wrappers
  are not serialized around successful payloads.

AckerDB therefore preserves meaningful procedure HTTP statuses without making
ordinary `fetch` behavior decide the API semantics. The AckerDB client parses a
valid application-error response into `Result.ok === false`; it does not reject
merely because the HTTP status is 4xx or 5xx.

The protocol change requires a protocol-version bump. Old and new peers fail
the handshake explicitly; no compatibility envelope or dual protocol path is
added.

## Client outcomes

Server-side Results contain only application errors. At a transport boundary,
every generated imperative call also admits the finite AckerDB client-failure
union:

```ts
type ClientResult<T, E extends ApplicationError> = Result<
  T,
  E | FrameworkRejection | UnhandledError | TransportError
>;
```

Those variants have distinct `kind` discriminants:

- `application` is a returned, endpoint-specific `Err`;
- `framework` is an authoritative AckerDB rejection such as access or input
  validation;
- `unhandled` is a sanitized unexpected server failure;
- `transport` is a connection, protocol, timeout, cancellation, overload, or
  convergence outcome and carries commitment information where relevant.

`useMutation(ref)` and `useProcedure(ref)` return
`Promise<ClientResult<Data, Error>>`. Expected failures do not require
`try/catch`.

`unwrap` is not part of the first version. In particular, server-side `unwrap`
would turn a typed application error into a throw, undermine transaction
semantics, and force the compiler to approximate thrown control flow. A later
client-only convenience may throw a `AckerDBClientError` without changing server
inference.

## React query state

`useQuery` returns an exhaustive union rather than a bag of optional fields.
It still supports ergonomic destructuring of `data`, `error`, and `loading`.

```ts
type QueryResult<T, E extends ApplicationError> =
  | {
      status: "disabled";
      data: undefined;
      error: undefined;
      loading: false;
    }
  | {
      status: "pending";
      data: undefined;
      error: undefined;
      loading: true;
    }
  | {
      status: "success";
      data: T;
      error: undefined;
      loading: false;
      stale: false;
    }
  | {
      status: "application-error";
      data: undefined;
      error: E;
      loading: false;
    }
  | {
      status: "rejected";
      data: undefined;
      error: FrameworkRejection;
      loading: false;
    }
  | {
      status: "unavailable";
      data: T;
      error: UnhandledError | TransportError;
      loading: false;
      stale: true;
    }
  | {
      status: "unavailable";
      data: undefined;
      error: UnhandledError | TransportError;
      loading: false;
      stale: false;
    };
```

An application `Err` is an authoritative query value, so previously successful
data is discarded. The same is true for an authoritative access or validation
rejection; retaining permission-sensitive data would be unsafe. An
availability failure does not claim the underlying query is now an error, so
the last successful value may remain as explicitly stale data.

The union supports precise narrowing:

```tsx
const order = useQuery(api.orders.get, { orderId });

switch (order.status) {
  case "success":
    return <OrderView order={order.data} />;
  case "application-error":
    return <NotFound code={order.error.code} />;
  case "unavailable":
    return order.data === undefined
      ? <Offline />
      : <OrderView order={order.data} stale />;
  // disabled, pending, and rejected remain exhaustive.
}
```

A live query that returns `Err` keeps its read set, cursor, and commit version.
It remains subscribed and may transition back to success when relevant data
changes.

## Target compiler model (not in the runtime beta)

The runtime beta infers server and client contracts through the registered
builder types and the existing recursive `ApiFromModules` generated surface.
That proves behavior and inference, but it is not the intended large-project
compiler architecture: generated client types still import backend modules,
there is no long-lived `ContractIR` cache, and TypeScript performs the recursive
surface mapping.

The AckerDB compiler below is required before calling the scaling design complete.
It does not build a second JavaScript control-flow analyzer.

TypeScript already computes the final handler return type:

- returning a nested `Err` includes that variant;
- handling an `Err` and returning success excludes it;
- `mapErr` replaces only mapped variants;
- returning a Result from a helper propagates its union; and
- thrown failures are irrelevant because the generic client failure is added
  independently.

The compiler asks the TypeScript checker for the awaited final handler outcome,
separates privately branded `Err` members from success members, applies
`returns` and optional `errors` constraints, and lowers the result into a
compiler-owned `ContractIR`. It must not traverse every reachable function and
guess which branches execute.

This distinction is essential: TypeScript owns language semantics and
dependency invalidation; AckerDB owns the serializable endpoint contract.

### Incrementality

The development compiler keeps one long-lived incremental TypeScript program
and a content-addressed `ContractIR` cache.

1. File changes invalidate TypeScript's affected source and symbol graph.
2. AckerDB re-extracts only endpoint contracts whose public inferred type may have
   changed.
3. A changed inner function naturally invalidates every outer endpoint whose
   final type depends on it.
4. AckerDB fingerprints each lowered contract.
5. Generated output is rewritten only when that contract fingerprint changes.

A body-only edit whose public contract is unchanged performs no generated-file
write. A shared callee error change regenerates exactly the affected callers,
not every endpoint.

### Target generated types

Generated client declarations are self-contained and materialized. They do not
import backend modules or expose recursive conditional computation such as
`ApiFromModules`.

References become shallow:

```ts
type QueryRef<Args, Data, Error> = { /* opaque reference */ };
type MutationRef<Args, Data, Error> = { /* opaque reference */ };
type ProcedureRef<Args, Data, Error> = { /* opaque reference */ };
```

Large anonymous shapes are emitted once as named aliases. Generated domains
reference those aliases instead of expanding the same union at every call site.
This is the main protection against TypeScript language-server CPU and memory
growth in large clients.

### TypeScript 7.1 boundary

The version that ships this compiler raises the AckerDB project minimum to
TypeScript 7.1 and uses its public compiler-host API. There is no TypeScript 5,
6, or 7.0 compatibility analyzer and no parallel legacy code path.
[Issue #99](https://github.com/pedrobzz/ackerdb/issues/99) tracks this migration.

The compiler boundary is:

```text
TypeScript program and checker -> ContractIR -> generated protocol/type artifacts
```

No TypeScript compiler object may cross into `ContractIR`. This makes later
compiler upgrades replace one adapter rather than infecting the runtime or
generated API.

## Representability and validators

Input validators continue to run on every invocation. The production output
path always performs its existing wire encoding and rejects unsupported values,
including arbitrary class instances.

The first Result implementation does not synthesize full runtime validators
from arbitrary TypeScript output types. Conditional, mapped, recursive, and
generic types make that a separate compiler project, and a validator pass
followed by encoding would walk large outputs twice.

Instead, in the runtime beta:

- `returns` and `errors` provide explicit runtime descriptors where requested;
- TypeScript statically constrains explicit `returns` and exact `errors`;
- explicit descriptors structurally validate every matching result in
  development and production;
- production performs one mandatory wire-encoding/representability walk;
- explicit error code/status membership is checked in constant time; and
- a future production validator must be fused with encoding and justified by
  measured whole-request cost.

Omitting `returns` adds no successful-result validation walk. Declaring
`returns` deliberately opts that function into its structural runtime check;
the final benchmark must report that cost rather than pretending it is free.

Validating only the first query result is forbidden: one value cannot prove
that later data-dependent results satisfy the same shape.

The runtime beta does not add a typed `v.unknown<Type>()` escape hatch. A future
compiler may add one only if a real endpoint needs to close an otherwise
unresolved generic boundary without pretending to validate its structure. Such
an escape hatch would be limited to function success values and error bodies,
would not bypass wire encoding, and would remain invalid in stored schemas.

The compiler handles resolved discriminated unions, mapped types, conditional
types, and intersections by lowering their final resolved structure:

- a mapped object remains an object or record, not automatically an array;
- a resolved conditional contributes only the selected branch, while an
  unresolved distributive conditional may become a union;
- an intersection combines simultaneous requirements and is not a union; and
- a generic that remains unresolved at an endpoint is a compiler error unless
  an explicit `returns` declaration closes the boundary.

Index signatures lower to records when their key and value contracts are
representable. Recursive output contracts remain unsupported until
`ContractIR` has explicit references.

`any`, widened `string` error codes, and silently unresolved `unknown` are
compiler errors. The compiler never invents an unknown validator to make an
unrepresentable contract appear safe.

## Performance requirements

The Result feature must not add a second structural pass to successful
production queries. It adds no query transaction or savepoint. The success
payload remains raw on the wire.

The implementation is accepted only with evidence for these load shapes:

- unchanged single-query payloads at representative small and large object and
  array sizes;
- nested mutation chains at depths 1, 5, and 20, including handled and
  propagated `Err`;
- client declaration checking at 1,000 and 5,000 endpoints with shared error
  unions; and
- cold compiler startup plus isolated and transitive incremental edits at
  1,000 and 5,000 endpoints.

An isolated edit should regenerate in well under one second on the development
fixture. A cold 5,000-endpoint build should complete within a few seconds on the
documented reference machine. CPU and memory must remain bounded and scale with
the affected graph, not the whole application, after startup.

Any reproducible query-path regression under the same useful workload requires
whole-vector judgment across latency, throughput, memory, tails, useful work,
and correctness. No percentage decides acceptance. The paired pull-request
benchmark remains evidence for Pedro and an agent rather than an automatic
performance verdict.

Automatic mutation scopes have real cost, so their measurements are reported
separately from query performance. That cost is paid only at registered nested
mutation boundaries and buys observable rollback semantics; it must not leak
into ordinary database operations.

## Implementation ownership

The work should land by semantic boundary, not as parallel compatibility paths:

1. `@ackerdb/core`: Result values, application/client failure types, `Status`,
   three-parameter function references, and protocol frames.
2. `@ackerdb/server`: handler normalization, callable registered procedures,
   invocation poisoning, mutation scopes, `ctx.tx` Result handling, and
   application-error transport encoding.
3. `@ackerdb/cli` (follow-up, issue #99): TypeScript 7.1 adapter, `ContractIR`,
   incremental extraction, diagnostics, fingerprints, and materialized
   generated declarations.
4. `@ackerdb/client`: protocol decoding and imperative `ClientResult`.
5. `@ackerdb/client-react`: exhaustive query state and typed mutation/procedure
   hooks.
The feature is intentionally breaking. The implementation removes the former
raw imperative client return and rejected-promise application-error behavior
rather than preserving both.

## Acceptance cases

The boundary tests must prove at least:

- raw success and explicit `Ok` infer the same success type;
- returned `Err` is present in nested server and generated client types;
- handled errors disappear and propagated errors remain;
- partial `mapErr` preserves residual variants;
- optional `returns` never requires an exhaustive `errors` declaration;
- strict `errors` rejects undeclared code, body, or status;
- thrown registered calls remain unhandleable and poison transactions;
- nested application mutation `Err` values discard only their own writes when
  handled;
- propagated and top-level mutation `Err` values discard all application writes
  in their owning scopes;
- idempotent retries replay a completed mutation `Err` without rerunning it;
- `ctx.tx` commits success and rolls back `Err` or throw;
- query application errors clear prior data but stay subscribed;
- availability failures may retain explicitly stale data;
- procedure application errors use their named HTTP status;
- success payload bytes have no Result envelope;
- class instances remain rejected by wire representability.

The following remain acceptance cases for issue #99 rather than claims about
the beta:

- generated client declarations import no backend module;
- inner-contract changes invalidate affected outer contracts only;
- 1,000/5,000-endpoint type-check and incremental-cache targets hold; and
- unresolved generics, widened error codes, and unsupported representability
  produce direct compiler diagnostics.
