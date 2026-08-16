# Application addresses have one fixed root

Every registered application function and channel has one canonical dotted
address. The address is the same value in the Registry, generated references,
in-process composition, durable steps, socket frames, HTTP routes, OpenAPI
operation ids, and MCP tool derivation.

The grammar is fixed:

```text
api.<module directories>.<export name>
```

For example, `functions/admin/users.ts` exporting `list` is
`api.admin.users.list`. If it opts into plain HTTP, it answers at
`/api/admin/users/list`. Code generation exports one `api` tree, and event
table references remain below `api.events.*`.

The decision is: **`api` is the only application address root, and module
ownership supplies every remaining namespace segment.** The manifest declares
the schema and cross-cutting policy such as scopes; it does not configure
address roots. Function and raw-handler declarations likewise contain behavior
and admission policy, not an independent routing namespace.

## Address and admission are separate

An address says where behavior lives. It does not say who may invoke it.
Admission remains entirely in the required `access` policy and the optional
scope requirement, both enforced at the invocation funnel on every surface.

`access: "system"` is the server-only case. Jobs and other local system runs may
invoke that function through its ordinary `api.*` reference, while remote
principals are refused by the same policy check that protects every other
function. No second visibility model is needed to express this.

Plain HTTP remains separately opt-in through `http`. A function without that
field has no path-addressed HTTP route even though it retains its canonical
address for sockets and local composition.

## The module tree is the application namespace

The filesystem already gives every function one owner. Moving a declaration
from `functions/users.ts` to `functions/admin/users.ts` deliberately changes
its address from `api.users.<export>` to `api.admin.users.<export>` everywhere.
This makes navigation, generated references, and transport names agree without
a second declaration for the Registry to reconcile.

A file named `index.ts` takes its directory's name:
`functions/orders/index.ts` publishes `api.orders.*`. That allows a directory
to own behavior beside nested modules. The manifest loader refuses
`functions/orders.ts` beside `functions/orders/index.ts`, and refuses a root
`functions/index.ts`, because either shape would leave two files or no module
owner for one address. The generated tree intersects a module's own exports
with its children so neither disappears.

## One root removes configuration from the boot path

Code generation must run before function modules can load because those modules
import generated constructors. A fixed root lets code generation emit the
complete binding shape after reading only the application manifest and module
file layout. Server boot then imports the functions and registers their
addresses without comparing routing configuration from two sources.

The Registry consequently owns one operation for each kind:

```text
module key + export name
        ↓
api.<module key>.<export name>
        ↓
one Registry entry and, when opted in, one HTTP path
```

Channels, function calls, HTTP handlers, OpenAPI, MCP derivation, and durable
steps all consume that same address. There is no transport-specific metadata
to carry beside it.

## Reserved and operational routes

Application HTTP routes live below `/api/`. Framework routes live at the HTTP
root behind the `_` marker (`/_ws`, `/_sse/ack`, `/_files`, and
`/_openapi.json`). The marker is also refused directly beneath `/api/`, keeping
room for framework protocol routes without taking names from deeper business
modules. `/live`, `/ready`, and `/status` remain the deliberate operational
exceptions because deployment infrastructure already owns those contracts.

Route-collision checks, unknown-field refusal, address-derived HTTP routing,
module collision checks, and immutable declaration snapshots remain general
integrity rules. None depends on configurable address namespaces.

## Consequences

- Generated application code has one `api` export plus the existing event
  convenience exports.
- `defineApp` needs no routing configuration, so executing the manifest during
  code generation yields only information the generator actually consumes.
- Function and raw-handler definitions carry no routing namespace field.
- The Registry constructor needs only the imported function modules.
- Before readiness, only requests below `/api/` receive the application's
  unavailable response; unrelated paths remain ordinary not-found routes.
- Access-sensitive behavior is visible in one auditable place: `access` and
  scopes, rather than in address spelling.
