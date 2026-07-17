# React, Expo, and AI SDK client

`@dbzz/client-react` is the declarative React binding for the generated DBZZ
API. One `DbzzProvider` owns the underlying client; components consume typed
queries, mutations, procedures, event streams, authentication, and connection
state through hooks. The same imports work in a browser and in an Expo React
Native application.

## Supported versions and installation

The package manifest supports these peers:

| Runtime or integration | Supported peer range | Required when |
| --- | --- | --- |
| React | `^19.2.3` | Always |
| React Native | `^0.86.0` | Expo native bundles |
| Expo | `^57.0.0` | Expo native bundles |
| Expo Crypto | `^57.0.0` | Expo native bundles |
| AI SDK (`ai`) | `^7.0.0` | Importing `@dbzz/client-react/ai` |

`react-native`, `expo`, `expo-crypto`, and `ai` are optional peers because a
browser-only application does not need them. They are not optional in the
runtime that uses them. The repository's current compatibility gates use
React 19.2.7, React Native 0.86.0, Expo 57.0.6, Expo Crypto 57.0.1, AI SDK
7.0.29, and `@ai-sdk/react` 4.0.32.

Install the React package at the same exact version as every other DBZZ
package. For example, when the application pins DBZZ 0.2.3:

```sh
bun add --exact @dbzz/client-react@0.2.3
```

An Expo 57 application also needs its native peers:

```sh
bunx expo install react react-native expo-crypto
```

For the optional chat transport, install AI SDK v7 and its React binding:

```sh
bun add ai@^7 @ai-sdk/react@^4
```

Normal hooks and their public types come from `@dbzz/client-react`.
`useChatTransport` and its types come only from `@dbzz/client-react/ai`, so a
consumer that never imports that subpath does not resolve AI SDK code.

## Provider and configuration lifetime

Mount one provider above every component that uses DBZZ:

```tsx
import { DbzzProvider, type DbzzProviderConfig } from "@dbzz/client-react";
import { App } from "./App";

const config: DbzzProviderConfig = {
  url: "https://api.example.com",
  credential: { kind: "anonymous" },
};

export function Root() {
  return (
    <DbzzProvider config={config}>
      <App />
    </DbzzProvider>
  );
}
```

`url` and an explicit `credential` are required. A bearer configuration is
`{ kind: "bearer", token }`. Optional configuration includes
`clientSessionId`, partial `limits`, partial `reconnect` settings, and injected
`clock`, `random`, `createWebSocket`, `fetch`, or `lifecycle` capabilities.

The provider constructs and connects one client after React commits, then
closes it on teardown. Equal configuration values keep the same lifetime even
when the object is recreated. Changing the URL, credential, session ID,
limits, or reconnect values closes the old client and starts a new lifetime.
Injected capability functions are captured when the lifetime starts and do
not themselves restart it. Use `useAuthentication().refresh(...)` to rotate a
credential in place instead of replacing the whole provider configuration.

There is deliberately no public `useClient`, `close`, or imperative client
escape hatch. During server rendering the provider performs no I/O: connection
state is `connecting`, authentication is `authenticating`, and an enabled
query is `pending` until a committed client exists.

Examples below assume generated references:

```ts
import { api } from "./_generated/api";
```

Generated references carry argument, result, row, and stream-chunk types from
the server without importing server runtime code.

## Connection state

`useConnectionState()` returns an exhaustive discriminated union:

```tsx
import { useConnectionState } from "@dbzz/client-react";

function ConnectionBadge() {
  const connection = useConnectionState();

  if (connection.phase === "ready") {
    return <span>ready as {connection.authentication.principal}</span>;
  }
  if (connection.phase === "authentication-blocked") {
    return <button>refresh credentials ({connection.error.code})</button>;
  }
  return <span>{connection.phase}</span>;
}
```

| Phase | Meaning and payload |
| --- | --- |
| `connecting` | Initial transport and authentication are in progress. |
| `ready` | The session is usable; `authentication` is the server-confirmed, secret-free principal plus `authEpoch`. |
| `reconnecting` | Ordinary reconnect backoff is in progress. |
| `authentication-blocked` | Authentication must be refreshed; carries `error`. |
| `terminal-error` | This client lifetime failed permanently; carries `error`. |
| `closed` | The provider closed the client. |
| `suspended` | The native application is backgrounded and the physical transport is retired. |
| `resuming` | Native activation started a fresh handshake for retained demand. |

## Live queries and `skip`

`useQuery(ref, args)` shares one live subscription between committed consumers
of the same generated reference and canonically equal argument values.

```tsx
import { skip, useQuery } from "@dbzz/client-react";
import { api } from "./_generated/api";

function Order({ orderId }: { orderId: string | null }) {
  const order = useQuery(api.orders.get, orderId === null ? skip : { orderId });

  switch (order.status) {
    case "disabled":
      return <p>Select an order.</p>;
    case "pending":
      return <p>Loading…</p>;
    case "success":
      return <p>{order.data.name}{order.stale ? " (reconnecting)" : ""}</p>;
    case "error":
      return <p>{order.error.message}</p>;
  }
}
```

| Status | Meaning and payload |
| --- | --- |
| `disabled` | The exact `skip` sentinel was passed; no subscription starts. |
| `pending` | Enabled, but no authoritative value has arrived yet. |
| `success` | Carries frozen container `data` and `stale`. Binary `Uint8Array` leaves remain usable mutable views. `stale: true` retains the last value while the connection is not authoritative for this query. |
| `error` | Carries the exact `DbzzClientError` and `staleData` when a value had previously arrived. |

Returning to connection phase `ready` does not by itself clear `stale`.
Freshness returns only when this query receives or confirms its own
authoritative resume, checkpoint, reset, or update. `skip` is a symbol, not an
empty argument object; switching between `skip` and real arguments cleanly
disables or starts demand.

## Mutations

`useMutation(ref)` returns a stable typed async function:

```tsx
import { useMutation } from "@dbzz/client-react";
import { api } from "./_generated/api";

function AddOrderButton() {
  const createOrder = useMutation(api.orders.create);
  return <button onClick={() => void createOrder({ table: 12 })}>Add order</button>;
}
```

The promise uses DBZZ's mutation identity and convergence contract. A pending
mutation retains its original request identity across reconnect and
process-alive native suspension, and the server deduplicates that identity to
at most one effect within the configured retained idempotency boundary.
Mutations have no caller abort option; inspect a rejected
`DbzzClientError`, including its `committed` field when convergence failed
after the mutation committed.

## Procedures

`useProcedure(ref)` returns a stable one-shot request function. Procedures are
not replayed after failure and accept an optional abort signal:

```tsx
import { useProcedure } from "@dbzz/client-react";
import { api } from "./_generated/api";

function ExportButton() {
  const exportOrders = useProcedure(api.orders.export);

  async function run() {
    const abort = new AbortController();
    const file = await exportOrders({ format: "csv" }, { signal: abort.signal });
    return file;
  }

  return <button onClick={() => void run()}>Export</button>;
}
```

## SSE procedures

`useSseProcedure(ref)` returns a typed `ReadableStream` factory:

```tsx
import { useSseProcedure } from "@dbzz/client-react";
import { api } from "./_generated/api";

function GenerateButton() {
  const generate = useSseProcedure(api.ai.generate);

  async function run() {
    const reader = generate({ prompt: "Summarize this order" }).getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      console.log(part.value);
    }
  }

  return <button onClick={() => void run()}>Generate</button>;
}
```

The HTTP request starts on the first stream read, each pull credits the
previous chunk, and `stream.cancel()` or a supplied abort signal releases the
request. SSE procedures do not reconnect or restart; validation, disconnect,
and terminal outcomes error the stream with the exact `DbzzClientError`.

## Live events

`useEvent(ref, args, onEvent, onError?)` subscribes for the component's
committed lifetime. Callback identity changes do not restart the subscription.

```tsx
import { useEvent } from "@dbzz/client-react";
import { api } from "./_generated/api";

function OrderNotifications() {
  useEvent(
    api.orderEvents.byRestaurant,
    { restaurantId: "rest_1" },
    (event) => {
      if (event.kind === "row") console.log(event.row);
      else if (event.kind === "gap") console.warn("events were lost");
      else console.log("new event-stream boundary"); // reset
    },
    (error) => console.error(error),
  );
  return null;
}
```

Event tables are transient append-only streams. `row` is a newly published
row, `gap` means at least one matching event was lost, and `reset` marks an
initial attach, reconnect, authentication rotation, or native recovery.
Missed events are never replayed or fabricated. Pair events with `useQuery`
when the UI also needs current durable state.

## Authentication and durable Identity

`useAuthentication()` exposes state plus explicit refresh and sign-out
operations. The application obtains a bearer token from its authentication
provider, then presents it to DBZZ:

```tsx
import { useAuthentication } from "@dbzz/client-react";

function SessionButton({ token }: { token: string }) {
  const { state, refresh, signOut } = useAuthentication();

  if (state.phase === "authenticated" && state.authentication.principal === "user") {
    return (
      <button onClick={() => void signOut()}>
        Sign out Identity {state.authentication.identity.toString()}
      </button>
    );
  }
  return <button onClick={() => void refresh({ kind: "bearer", token })}>Sign in</button>;
}
```

| Phase | Meaning and payload |
| --- | --- |
| `authenticating` | Initial presentation or refresh is in flight; carries the `credential` kind. |
| `unauthenticated` | The server confirmed an anonymous `authentication`. |
| `authenticated` | The server confirmed a user or workload `authentication`. |
| `refresh-required` | The credential was rejected or timed out; carries `error` and blocks reconnect until `refresh(...)`. |
| `failed` | The client failed permanently; carries `error`. |
| `closed` | The provider closed the client. |

The client descriptor never exposes the bearer token, selected claims, or
token ID. A user descriptor contains a durable, branded DBZZ `Identity` plus
the exact current credential `provenance` (`issuer` and `subject`). A workload
descriptor has provenance but no application Identity. Anonymous users have
neither.

DBZZ, not Clerk, Better Auth, Auth0, or another provider, assigns the durable
application Identity. After external verification, the server transactionally
resolves the exact `(issuer, subject)` account to that Identity. First login
creates the mapping; changing mutable claims such as email never links or
merges users. Store `ctx.auth.identity` in application ownership columns, not
the provider subject.

Cross-provider continuity is explicit application behavior. A server
procedure or SSE procedure may call `ctx.linkAccount(rawBearerToken)` to
verify and attach a second exact external account to the current user's Identity, or
`ctx.unlinkAccount({ issuer, subject })` to detach an owned account. DBZZ does
not expose a client-side account-link shortcut, auto-link by email, merge two
existing Identities, rewrite application rows, or allow removal of the final
account. Unlinking leaves the Identity and its application data intact. See
[Authentication and authorization](authentication.md#explicit-account-linking)
for the server contract.

## AI SDK v7 chat transport

The optional subpath adapts a generated SSE procedure yielding AI SDK
`UIMessageChunk` values into the `ChatTransport` consumed by `useChat`:

```tsx
import { useChat } from "@ai-sdk/react";
import { useChatTransport } from "@dbzz/client-react/ai";
import { api } from "./_generated/api";

function Chat() {
  const transport = useChatTransport(api.ai.chat);
  const { messages, sendMessage, stop } = useChat({ transport });

  return (
    <>
      <button onClick={() => void sendMessage({ text: "Hello" })}>Send</button>
      <button onClick={stop}>Stop</button>
      <pre>{JSON.stringify(messages, null, 2)}</pre>
    </>
  );
}
```

Without options, the SSE procedure must accept exactly the standard
`DbzzChatArgs` fields: `trigger`, `chatId`, nullable `messageId`, and
`messages`. A custom argument shape requires a typed mapper:

```tsx
const transport = useChatTransport(api.ai.chatForOrder, {
  prepareArgs: (request) => ({
    orderId: "order_1",
    messages: request.messages,
  }),
});
```

Per-request headers, body, and metadata are available to `prepareArgs` but are
not sent by the default mapping. Stopping generation, unmounting the transport
hook, or native suspension aborts the DBZZ stream. AI stream reconnection is
explicitly unsupported: `reconnectToStream` returns `null` and never starts a
hidden replacement generation.

## Expo entry and process-alive recovery

Use the same root import in Expo. Metro's `react-native` package condition
selects the native entry; browsers, Bun, and ordinary TypeScript select the
default entry. The native provider supplies these capabilities unless the
application explicitly injected replacements:

- named `expo/fetch`, whose byte `ReadableStream` response bodies support DBZZ
  procedures and acknowledged SSE;
- Expo Crypto randomness for session and mutation UUIDs;
- React Native's native global `WebSocket`; and
- one `AppState` observer per provider client lifetime.

The Expo and Expo Crypto peers are therefore mandatory for native bundling;
missing modules fail at bundle resolution rather than during a request.
Shared hooks never import native modules, and the browser entry contains no
Expo or React Native code.

While the OS keeps the JavaScript process alive, entering `background`
publishes `suspended`, retires the physical socket and connection timers, and
keeps logical query, mutation, and event demand. `inactive` alone does not
suspend. Returning to `active` starts one fresh authenticated connection when
demand exists; failed attempts enter ordinary reconnect behavior.

Recovery guarantees are operation-specific:

- queries retain their last value as stale and become fresh only after their
  own authoritative resume, confirmation, reset, or update;
- pending mutations retain their original request identity and converge to
  one settlement without intentionally duplicating effects;
- event subscriptions restart behind a `reset`, with no historical replay;
- procedures, SSE streams, and AI generations terminate with their typed
  cancellation or indeterminate outcome and never restart silently.

## Explicit limitations

- Native support is the Expo 57 conditional entry. Bare React Native and Expo
  Go are not supported targets; use custom Expo development or release builds.
- The full physical iOS/Android duration, network-transition, Doze/App
  Standby, and release-build acceptance matrix remains deferred in
  [Issue #17](https://github.com/pedrobzz/dbzz/issues/17). Current automated
  coverage proves package resolution and process-alive state-machine behavior,
  not that deferred device matrix.
- OS process termination starts a fresh application. DBZZ does not persist a
  client-side mutation queue, keep a background socket/service alive, or
  recover in-memory query/event/stream state after process death.
- Procedures, SSE, and AI generations are non-resumable. Live events have no
  history replay. Durable current state belongs in queries.
- The package does not implement provider login UI, OAuth redirects, bearer
  issuance/renewal, or secure token storage. Those remain the authentication
  provider and application's responsibility.
- DBZZ packages are currently released to the repository's configured local
  Verdaccio registry, not the public npm registry.
