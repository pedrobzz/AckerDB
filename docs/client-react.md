# React, Expo, and AI SDK client

`@ackerdb/client-react` is the declarative React binding for the generated AckerDB
API. One `AckerDBProvider` owns the underlying client; components consume typed
queries, mutations, procedures, event streams, application channels, WebRTC
sessions, authentication, and connection state through hooks. The same root
imports work in browsers and Expo React Native applications.

This page documents the currently implemented client, including typed
application errors and exhaustive query failure states. Their server and
transaction semantics are specified in
[Typed function results](function-results.md).

## Supported versions and installation

The package manifest supports these peers:

| Runtime or integration | Supported peer range | Required when |
| --- | --- | --- |
| React | `^19.2.3` | Always |
| React Native | `^0.86.0` | Expo native bundles |
| Expo | `^57.0.0` | Expo native bundles |
| Expo Crypto | `^57.0.0` | Expo native bundles |
| AI SDK (`ai`) | `^7.0.0` | Importing `@ackerdb/client-react/ai` |

`react-native`, `expo`, `expo-crypto`, and `ai` are optional peers because a
browser-only application does not need them. They are required in the runtime
that uses them. The repository's current compatibility gates use
React 19.2.7, React Native 0.86.0, Expo 57.0.6, Expo Crypto 57.0.1, AI SDK
7.0.29, and `@ai-sdk/react` 4.0.32.

Install the React package at the same exact version as every other AckerDB
package. For example, when the application pins AckerDB 0.9.0:

```sh
bun add --exact @ackerdb/client-react@0.9.0
```

An Expo 57 application also needs its native peers:

```sh
bunx expo install react react-native expo-crypto
```

For the optional chat transport, install AI SDK v7 and its React binding:

```sh
bun add ai@^7 @ai-sdk/react@^4
```

Normal hooks and their public types come from `@ackerdb/client-react`.
`useChatTransport` and its types come only from `@ackerdb/client-react/ai`, so a
consumer that never imports that subpath does not resolve AI SDK code.

Vite dev servers should pre-bundle the client's CommonJS-interop
dependencies, or the first on-demand optimization pass can reload the page
mid-render and surface as a duplicated-React "Invalid hook call":

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { include: ["eventsource-parser", "msgpackr"] },
});
```

## Provider and configuration lifetime

Mount one provider above every component that uses AckerDB:

```tsx
import { AckerDBProvider, type AckerDBProviderConfig } from "@ackerdb/client-react";
import { App } from "./App";

const config: AckerDBProviderConfig = {
  url: "https://api.example.com",
  credential: { kind: "anonymous" },
};

export function Root() {
  return (
    <AckerDBProvider config={config}>
      <App />
    </AckerDBProvider>
  );
}
```

`url` is required, along with exactly one of an explicit `credential` or a
[`credentialSource`](#credential-source) callback. A bearer configuration is
`{ kind: "bearer", token }`. Optional configuration includes
`clientSessionId`, partial `limits`, partial `reconnect` settings, and injected
`clock`, `random`, `createWebSocket`, `createPeerConnection`, `fetch`, or
`lifecycle` capabilities. An Expo realtime application supplies only the peer
constructor from its native WebRTC package; the Expo entry provides the other
native capabilities automatically.

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
import { useConnectionState } from "@ackerdb/client-react";

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
import { skip, useQuery } from "@ackerdb/client-react";
import { api } from "./_generated/api";

function Order({ orderId }: { orderId: string | null }) {
  const order = useQuery(api.orders.get, orderId === null ? skip : { orderId });

  switch (order.status) {
    case "disabled":
      return <p>Select an order.</p>;
    case "pending":
      return <p>Loading…</p>;
    case "success":
      return <p>{order.data.name}</p>;
    case "application-error":
      return <p>{order.error.code}</p>;
    case "rejected":
      return <p>Request rejected: {order.error.code}</p>;
    case "unavailable":
      return order.stale
        ? <p>{order.data.name} (offline)</p>
        : <p>Temporarily unavailable</p>;
  }
}
```

| Status | Meaning and payload |
| --- | --- |
| `disabled` | The exact `skip` sentinel was passed; no subscription starts. |
| `pending` | Enabled, but no authoritative value has arrived yet. |
| `success` | Carries frozen container `data` and `stale: false`. Binary `Uint8Array` leaves remain usable mutable views. |
| `application-error` | Carries the endpoint's exact typed `ApplicationError` union. `data` is always `undefined`. |
| `rejected` | Carries an authoritative framework `AckerDBClientError`. `data` is always `undefined`. |
| `unavailable` | Carries an unhandled or transport `AckerDBClientError`. When `stale: true`, `data` is defined as the last successful value; when `stale: false`, `data` is `undefined`. |

Application and framework errors discard prior data. Transport or unhandled
unavailability may retain the last success as explicitly stale data. Returning
to connection phase `ready` does not by itself clear that stale state.
Freshness returns only when this query receives or confirms its own
authoritative resume, checkpoint, reset, or update. `skip` is a symbol, not an
empty argument object; switching between `skip` and real arguments cleanly
disables or starts demand.

## Reactive cursor pagination

`usePaginatedQuery(ref, args, options?)` turns a cursor-paginated query — one
declaring `{ cursor, pageSize }` arguments and returning `paginate()`'s
`{ items, nextCursor }` page — into a live window. Each loaded page is an
ordinary shared live subscription, so a write that lands inside the window
re-delivers the affected page; `loadMore()` extends the window from the last
page's `nextCursor` until `exhausted`.

```tsx
import { skip, usePaginatedQuery } from "@ackerdb/client-react";
import { api } from "./_generated/api";

function LogList({ level }: { level: string | null }) {
  const logs = usePaginatedQuery(
    api.logs.list,
    level === null ? skip : { level },
    { pageSize: 50 },
  );

  if (logs.status !== "success") return <LogListFallback state={logs} />;
  return (
    <>
      <ul>{logs.items.map((row) => <li key={row.id}>{row.message}</li>)}</ul>
      {logs.exhausted
        ? null
        : <button onClick={logs.loadMore} disabled={logs.loadingMore}>More</button>}
    </>
  );
}
```

The state union mirrors `useQuery` with `items` as the flattened window plus
`loadMore` (always present, a no-op unless the window can grow),
`loadingMore`, and `exhausted`. `pageSize` defaults to 25 rows and the server
independently caps one page's rows (`MAX_PAGE_SIZE`, 256). Pages chain by
cursor: when a delivery moves a page's `nextCursor`, the pages behind it are
resubscribed from the new boundary, and the flattened window briefly
truncates to the proven prefix instead of ever showing overlap or gaps.
Transport unavailability keeps the whole window as explicitly stale `items`,
exactly like `useQuery`'s stale data.

The server function is an ordinary query — pagination needs no special kind:

```ts
export const list = query({
  args: { level: v.string(), cursor: v.string().nullable(), pageSize: v.int() },
  access: "authenticated",
  handler: async (ctx, args) =>
    await ctx.db.logs
      .query()
      .where((row) => row.level.eq(args.level))
      .orderBy((row) => row.id.desc())
      .paginate({ cursor: args.cursor, pageSize: args.pageSize }),
});
```

## Mutations

`useMutation(ref)` returns a stable typed async function:

```tsx
import { useMutation } from "@ackerdb/client-react";
import { api } from "./_generated/api";

function AddOrderButton() {
  const createOrder = useMutation(api.orders.create);

  async function create() {
    const result = await createOrder({ table: 12 });
    if (!result.ok) {
      if (result.error.kind === "application") {
        console.log(result.error.code, result.error.body);
      } else {
        console.log(result.error.code);
      }
      return;
    }
    console.log(result.data);
  }

  return <button onClick={() => void create()}>Add order</button>;
}
```

The promise uses AckerDB's mutation identity and convergence contract. A pending
mutation retains its original request identity across reconnect and
process-alive native suspension, and the server deduplicates that identity to
at most one effect within the configured retained idempotency boundary.
Mutations have no caller abort option. The promise resolves to
`ClientResult<Data, ApplicationError>` rather than rejecting for an expected
application error. Its `error.kind` separates application errors from AckerDB
client failures; client failures include `committed` when convergence failed
after the mutation may have committed.

## Files

`useFileUpload()` returns one stable, provider-owned upload function. Pass it
the application mutation that authorizes and creates an Upload Session, then
save the returned `FileId` with an ordinary mutation:

```tsx
import { useFileUpload, useMutation } from "@ackerdb/client-react";
import { api } from "./_generated/api";

function AvatarForm({ avatarUrl }: { avatarUrl: string | null }) {
  const uploadFile = useFileUpload();
  const saveAvatar = useMutation(api.profiles.saveAvatar);

  async function save(file: File) {
    const uploaded = await uploadFile({
      createSession: api.profiles.createAvatarUpload,
      args: {},
      file,
    });
    if (!uploaded.ok) throw uploaded.error;

    const saved = await saveAvatar({ fileId: uploaded.data });
    if (!saved.ok) throw saved.error;
  }

  return (
    <>
      <input
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void save(file);
        }}
      />
      {avatarUrl === null ? null : <img src={avatarUrl} alt="Profile" />}
    </>
  );
}
```

The upload reuses the same `Blob` or `BufferSource` and the same idempotent
session through ambiguous failures until success, caller cancellation, or
session expiry. It routes the Upload Session path through the provider's
configured AckerDB origin, so an on-device React Native client never sends the
PUT to a server-advertised `127.0.0.1`. Public profile images remain ordinary
bearer URLs rendered directly by `<img>`; there is no private-image/object-URL
hook or public client escape hatch. Imperative base-client code can stream a
server-issued authenticated or validated grant with
`client.files.fetch(url, { method: "GET", headers: { Range: "bytes=0-1023" }, signal })`.
The same operation accepts `HEAD` and conditional request headers. The client
always owns `Authorization`, ignoring a caller-supplied value, and routes the
grant path through its configured AckerDB server even when `files.publicUrl`
uses a different origin.
See [Files](files.md) for server mutations, URL access modes, storage, and
lifecycle rules.

## Procedures

`useProcedure(ref)` returns a stable one-shot request function. Procedures are
not replayed after failure and accept an optional abort signal:

```tsx
import { useProcedure } from "@ackerdb/client-react";
import { api } from "./_generated/api";

function ExportButton() {
  const exportOrders = useProcedure(api.orders.export);

  async function run() {
    const abort = new AbortController();
    const result = await exportOrders(
      { format: "csv" },
      { signal: abort.signal },
    );
    if (!result.ok) {
      if (result.error.kind === "application") {
        console.log(result.error.code, result.error.body);
      }
      return;
    }
    return result.data;
  }

  return <button onClick={() => void run()}>Export</button>;
}
```

## Query procedures

`useQueryProcedure(ref, args, options?)` observes an ordinary procedure through
the same exhaustive state model as `useQuery`, with a shared `refresh()`
operation:

```tsx
import { skip, useQueryProcedure } from "@ackerdb/client-react";
import { api } from "./_generated/api";

function ExchangeRate({ pair }: { pair: string | null }) {
  const rate = useQueryProcedure(
    api.rates.current,
    pair === null ? skip : { pair },
    { refreshIntervalMs: 30_000 },
  );

  if (rate.status === "disabled") return <p>Select a currency pair.</p>;
  if (rate.status === "pending") return <p>Loading…</p>;
  if (rate.status === "application-error") return <p>{rate.error.code}</p>;
  if (rate.status === "rejected") return <p>Rejected: {rate.error.code}</p>;
  if (rate.status === "unavailable" && rate.data === undefined) {
    return <button onClick={rate.refresh}>Try again</button>;
  }
  return (
    <button onClick={rate.refresh}>
      {rate.data.value}{rate.status === "unavailable" ? " (stale)" : ""}
    </button>
  );
}
```

Equal committed consumers within one provider-owned client lifetime share one
observation when the generated procedure address, canonical argument values,
and `refreshIntervalMs` are equal. They receive the exact same snapshot and
`refresh` function, and share one execution and one timer. Different arguments
or configurations are independent. Changing the key, recovering the
connection, calling `refresh()`, or reaching the configured interval demands a
fresh execution.

The interval is optional; omitting it disables polling. When supplied,
`refreshIntervalMs` must be a positive safe integer or rendering throws
`RangeError`. Polling is measured from the previous execution's completion, so
executions never overlap. Repeated refresh demand during an active execution
coalesces into one trailing execution. A server `retryAfterMs` hint floors the
next automatic interval, but an explicit `refresh()` remains immediate.
Failures do not create their own retry loop.

Query procedures are intended for procedures the application knows are safe to
repeat. AckerDB does not enforce idempotence or introduce a separate server
function kind; observing a mutating or externally effectful procedure this way
is application error. Final unmount stops timers and cancels in-flight work.
Procedures remain non-resumable, so cancellation or native suspension can leave
completion indeterminate; surviving demand starts a new execution after
recovery rather than pretending to resume the old one.

## SSE procedures

`useSseProcedure(ref)` returns a typed `ReadableStream` factory:

```tsx
import { useSseProcedure } from "@ackerdb/client-react";
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
and terminal outcomes error the stream with the exact `AckerDBClientError`.

## Live events

`useEvent(ref, args, onEvent, onError?)` subscribes for the component's
committed lifetime. Callback identity changes do not restart the subscription.

```tsx
import { useEvent } from "@ackerdb/client-react";
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

## Application channels

`useChannel(ref, args, options)` opens one typed bidirectional channel
membership over the provider client's existing WebSocket. Canonically equal
references, arguments, and optional rooms share one server membership.
Component handlers remain independent unless an equal non-empty `handlerKey`
deliberately coalesces the complete `on` bundle.

```tsx
const chat = useChannel(api.chat.room, { threadId }, {
  room: roomId,
  handlerKey: "useChatRoom",
  on: {
    message(message) {
      store.add(message);
    },
  },
});

chat.send("compose", { text });
```

`on` may instead be one function receiving the inferred discriminated union.
`send()` reports only local transport acceptance and never queues work for a
future reconnect. See [Application channels](channels.md) for server
declarations, room rules, publishing, state, and deduplication.

## Realtime media sessions

`useRealtime(ref, args, options)` retains one AckerDB-relayed WebRTC session.
Audio and video remain native tracks on the exposed `RTCPeerConnection`; one
reliable internal data channel carries typed events and finite typed byte
streams. Equal client, reference, and canonical arguments always share one
peer; every committed hook observes that peer with its own current handlers.

```tsx
const assistant = useRealtime(api.assistant.live, { assistantId }, {
  on: {
    async peerConnection(peer) {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of media.getTracks()) peer.addTrack(track, media);
      return () => media.getTracks().forEach((track) => track.stop());
    },
    event: {
      transcript(value) {
        store.append(value);
      },
    },
    track(event) {
      play(event.track);
    },
  },
});
```

`RealtimeOn<typeof api.assistant.live>` derives the complete `on` type for a
custom hook. Expo uses the same hook with its native
`RTCPeerConnection` and capture APIs; it does not use browser
`navigator.mediaDevices`. See [Realtime media sessions](realtime-media.md) for
server declarations, native setup, streams, signaling, recovery, and the
current native-server-engine boundary.

## Authentication and durable Identity

`useAuthentication()` exposes state plus explicit refresh and sign-out
operations. The application obtains a bearer token from its authentication
provider, then presents it to AckerDB:

```tsx
import { useAuthentication } from "@ackerdb/client-react";

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
| `authenticating` | Initial presentation or refresh is in flight; carries the `credential` kind (`"source"` before a credential-source client's first pull). |
| `unauthenticated` | The server confirmed an anonymous `authentication`. |
| `authenticated` | The server confirmed a user or workload `authentication`; bearer descriptors carry `credentialTtlMs`, the server's credential TTL disclosure. |
| `refresh-required` | The credential was rejected or timed out; carries `error` and blocks reconnect until `refresh(...)`. |
| `failed` | The client failed permanently; carries `error`. |
| `closed` | The provider closed the client. |

### Credential source

Instead of a fixed `credential`, the provider configuration may carry a
`credentialSource` — the application-owned callback producing the current
explicit credential, including the explicit anonymous credential for
signed-out state. Exactly one of the two is configured, never both. The
client owns the whole lifecycle: it pulls the source for the initial connect,
re-pulls ahead of the server-disclosed credential TTL so the connection never
degrades in the happy path, and re-pulls after a principal rejection with
bounded jittered backoff. Concurrent triggers coalesce into one in-flight
pull.

```tsx
<AckerDBProvider
  config={{
    url: serverUrl,
    credentialSource: async () => {
      const token = await getToken(); // the identity SDK's getter
      return token === null ? { kind: "anonymous" } : { kind: "bearer", token };
    },
  }}
>
```

The proactive schedule is an optimization, not the guarantee: an environment
that stops running timers — a backgrounded browser tab, a suspended host —
can skip past it entirely. The client therefore records when the accepted
credential dies and consults that deadline before every dial, so a wake past
expiry pulls a fresh credential instead of presenting one it can already
prove is dead. Recovery costs one source pull, not a rejected handshake.

In source mode `refresh()` takes no argument and re-invokes the source
immediately — call it right after the identity SDK completes sign-in.
`signOut()` re-invokes the source and resolves only when the server actually
confirmed the anonymous principal; if the source still produces a signed-in
credential it rejects with `conflict` — sign out of the identity SDK first,
then call it. The operation never claims a sign-out it cannot perform. The
source callback is a captured capability, not part of the provider's
configuration identity — credentials change by re-pulling, never by client
replacement.

### Awaiting principal change

A mounted query the server rejects with `unauthenticated` or `unauthorized`
is not dead demand: the entry holds it as awaiting principal change and
re-presents it exactly when the server accepts a different principal —
never on a timer, because a rejection without a principal change would only
repeat. After sign-in, previously rejected queries re-demand and deliver
automatically, so gating them with `skip` until authenticated is an
optimization, not a correctness requirement.

The client descriptor never exposes the bearer token, selected claims, or
token ID. A user descriptor contains a durable, branded AckerDB `Identity` plus
the exact current credential `provenance` (`issuer` and `subject`). A workload
descriptor has provenance but no application Identity. Anonymous users have
neither.

AckerDB, not Clerk, Better Auth, Auth0, or another provider, assigns the durable
application Identity. After external verification, the server transactionally
resolves the exact `(issuer, subject)` account to that Identity. First login
creates the mapping; changing mutable claims such as email never links or
merges users. Store `ctx.auth.identity` in application ownership columns, not
the provider subject.

Cross-provider continuity is explicit application behavior. A server
procedure or SSE procedure may call `ctx.linkAccount(rawBearerToken)` to
verify and attach a second exact external account to the current user's Identity, or
`ctx.unlinkAccount({ issuer, subject })` to detach an owned account. AckerDB does
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
import { useChatTransport } from "@ackerdb/client-react/ai";
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
`AckerDBChatArgs` fields: `trigger`, `chatId`, nullable `messageId`, and
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
hook, or native suspension aborts the AckerDB stream. AI stream reconnection is
explicitly unsupported: `reconnectToStream` returns `null` and never starts a
hidden replacement generation.

## Expo entry and process-alive recovery

Use the same root import in Expo. Metro's `react-native` package condition
selects the native entry; browsers, Bun, and ordinary TypeScript select the
default entry. The native provider supplies these capabilities unless the
application explicitly injected replacements:

- named `expo/fetch`, whose byte `ReadableStream` response bodies support AckerDB
  procedures and acknowledged SSE;
- Expo Crypto randomness for session and mutation UUIDs;
- React Native's native global `WebSocket`; and
- one `AppState` observer per provider client lifetime.

Expo and Expo Crypto are mandatory for native bundling; missing modules fail
at bundle resolution rather than during a request. Shared hooks never import
native modules, and the browser entry contains no Expo or React Native code.

While the OS keeps the JavaScript process alive, entering `background`
publishes `suspended`, retires the physical socket and connection timers, and
keeps logical query, mutation, and event demand. `inactive` alone does not
suspend. Returning to `active` restores the constructor-owned authenticated
connection; failed attempts enter ordinary reconnect behavior.

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
  Go are not supported targets; use a custom Expo development or release
  build. Realtime applications inject the peer constructor from their selected
  Expo-compatible WebRTC native package.
- The full physical iOS/Android duration, network-transition, Doze/App
  Standby, and release-build acceptance matrix remains deferred in
  [Issue #17](https://github.com/pedrobzz/ackerdb/issues/17). Current automated
  coverage proves package resolution and process-alive state-machine behavior,
  not that deferred device matrix.
- OS process termination starts a fresh application. AckerDB does not persist a
  client-side mutation queue, keep a background socket/service alive, or
  recover in-memory query/event/stream state after process death.
- Procedures, SSE, and AI generations are non-resumable. Live events have no
  history replay. Durable current state belongs in queries.
- The package does not implement provider login UI, OAuth redirects, bearer
  issuance/renewal, or secure token storage. Those remain the authentication
  provider and application's responsibility.
- Stable and canary AckerDB packages are published to public npm. Repeatable
  `beta` builds are local-only in Verdaccio; see [the release
  contract](releases.md).
