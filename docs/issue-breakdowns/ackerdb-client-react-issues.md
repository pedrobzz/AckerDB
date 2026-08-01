# Provider-neutral Identity and `@ackerdb/client-react` — issue breakdown

> Historical implementation plan. Its local-only publication, merge-guard,
> alpha prerelease, and vendor-comparison benchmark instructions are
> superseded; do not execute them. Current policy is in
> [Releases and protected branches](../releases.md).

- Parent PRD: `PRD: Provider-neutral Identity and @ackerdb/client-react for web, Expo, and AI streaming`
- Source PRDs: `.workflow/react-client-prd/final-report.md` and the approved provider-neutral Identity extension published in parent issue #3
- Parent GitHub issue: [#3](https://github.com/pedrobzz/ackerdb/issues/3)
- Date generated: 2026-07-15
- Identity extension added: 2026-07-16

| ID | GitHub | Title | Type | Blocked by | User stories |
| --- | --- | --- | --- | --- | --- |
| ISSUE-01 | [#4](https://github.com/pedrobzz/ackerdb/issues/4) | Installable browser provider and connection state | AFK | None | 1, 4–9, 37, 45, 66–67 |
| ISSUE-02 | [#5](https://github.com/pedrobzz/ackerdb/issues/5) | Typed live-query state and reconnect semantics | AFK | ISSUE-01 | 10–14, 19–20 |
| ISSUE-03 | [#6](https://github.com/pedrobzz/ackerdb/issues/6) | Shared concurrent query registry | AFK | ISSUE-02 | 15–18 |
| ISSUE-04 | [#7](https://github.com/pedrobzz/ackerdb/issues/7) | Typed mutations with replay identity | AFK | ISSUE-01 | 21–23 |
| ISSUE-05 | [#8](https://github.com/pedrobzz/ackerdb/issues/8) | Typed procedures with cancellation | AFK | ISSUE-01 | 24–25 |
| ISSUE-06 | [#9](https://github.com/pedrobzz/ackerdb/issues/9) | Typed SSE from schema declaration to React stream | AFK | ISSUE-01 | 26–32, 67 |
| ISSUE-07 | [#10](https://github.com/pedrobzz/ackerdb/issues/10) | Typed row-event subscriptions and reset boundaries | AFK | ISSUE-01 | 33–34 |
| ISSUE-08 | [#11](https://github.com/pedrobzz/ackerdb/issues/11) | Authentication state and operations hook | AFK | ISSUE-01 | 35–37 |
| ISSUE-09 | [#12](https://github.com/pedrobzz/ackerdb/issues/12) | AI SDK v7 chat transport over AckerDB SSE | AFK | ISSUE-06 | 38–44 |
| ISSUE-10 | [#13](https://github.com/pedrobzz/ackerdb/issues/13) | Single-package Expo runtime adapter | AFK | ISSUE-01 | 2–4, 45–48, 67, 69–70 |
| ISSUE-11 | [#14](https://github.com/pedrobzz/ackerdb/issues/14) | Query-safe Expo suspension and immediate recovery | AFK | ISSUE-02, ISSUE-03, ISSUE-08, ISSUE-10 | 49–54, 59–62, 65, 70 |
| ISSUE-12 | [#15](https://github.com/pedrobzz/ackerdb/issues/15) | Foreground mutation and event convergence | AFK | ISSUE-04, ISSUE-07, ISSUE-08, ISSUE-11 | 53, 55–56, 58–61 |
| ISSUE-13 | [#16](https://github.com/pedrobzz/ackerdb/issues/16) | Settle procedures, SSE, and AI streams during suspension | AFK | ISSUE-05, ISSUE-06, ISSUE-09, ISSUE-11 | 57, 61 |
| ISSUE-14 | [#17](https://github.com/pedrobzz/ackerdb/issues/17) | Physical-device lifecycle acceptance and hardening | HITL | ISSUE-11, ISSUE-12, ISSUE-13, ISSUE-18 | 49, 51–65, 90 |
| ISSUE-15 | [#18](https://github.com/pedrobzz/ackerdb/issues/18) | Publish-ready cross-runtime package | AFK | ISSUE-03 through ISSUE-14, ISSUE-16 through ISSUE-20 | 1–4, 45–48, 63, 67–90 |
| ISSUE-16 | [#21](https://github.com/pedrobzz/ackerdb/issues/21) | Durable Identity from first login to row ownership | AFK | None | 71–73, 75–80 |
| ISSUE-17 | [#22](https://github.com/pedrobzz/ackerdb/issues/22) | Exact-account convergence across configured providers | AFK | ISSUE-16 | 74–75, 81–82, 86 |
| ISSUE-18 | [#23](https://github.com/pedrobzz/ackerdb/issues/23) | Identity-aware client and React authentication lifecycle | AFK | ISSUE-08, ISSUE-11, ISSUE-16, ISSUE-17 | 71, 73–74, 79, 90 |
| ISSUE-19 | [#24](https://github.com/pedrobzz/ackerdb/issues/24) | Opt-in cross-provider account linking | AFK | ISSUE-16, ISSUE-17 | 83–88 |
| ISSUE-20 | [#25](https://github.com/pedrobzz/ackerdb/issues/25) | Safe external-account unlinking | AFK | ISSUE-19 | 85, 89 |

## ISSUE-01: Installable browser provider and connection state

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Deliver the first installable browser React path: a new lockstep `@ackerdb/client-react` package with `AckerDBProvider` and `useConnectionState`. The provider must construct, own, configure, and close one AckerDB client per immutable configuration lifetime. A real browser React fixture must connect through the provider and render observable connection state without exposing an imperative client.

### Why this slice exists

Every later hook needs a correct React ownership boundary. This slice proves package installation, provider lifetime, concurrent React compatibility, safe server rendering, and public connection diagnostics as one demoable path.

## Acceptance criteria

- [ ] `@ackerdb/client-react` installs with the supported React version and exposes `AckerDBProvider` plus `useConnectionState` from its browser entry.
- [ ] The provider accepts the PRD configuration surface, creates one client for that immutable configuration, and owns shutdown on unmount or explicit lifetime replacement.
- [ ] No imperative client getter or public close hook is exported.
- [ ] Connection state is an exhaustive typed value that includes connecting, ready, reconnecting, authentication-blocked, terminal-error, and closed; native-only states may already exist in the type without requiring native behavior here.
- [ ] Strict Mode setup/cleanup and provider reconfiguration leave no duplicate sockets, timers, or listeners.
- [ ] Server rendering does not access runtime globals or start a connection and returns a deterministic non-ready snapshot.
- [ ] A browser consumer fixture connects to a real AckerDB server and displays ready state.

### Implementation notes

- Likely surfaces include the new package manifest and source entry, `packages/client` construction/lifecycle APIs, root workspace/typecheck configuration, and a browser React consumer fixture.
- Use React's external-store contract for observable connection state; do not mirror mutable client state through ad hoc effects.
- Provider options are immutable for one lifetime. Make replacement explicit rather than partially mutating a live client.
- Target only the current approved React line. Do not add backward-compatibility branches.
- The structural client change enters the required paired AckerDB GitHub
  benchmark when its pull request targets `canary`.

## Blocked by

None — can start immediately.

## User stories addressed

- User stories 1, 4–9, 37, 45, 66–67

### Test plan

- Render a real provider/consumer path, observe connecting then ready, and verify closure after unmount.
- Exercise Strict Mode remount and provider configuration replacement while counting clients, sockets, timers, subscriptions, and callbacks.
- Render on the server with browser globals absent and assert no connection attempt.
- Add compile-pass/fail fixtures for provider configuration, connection-state exhaustiveness, forbidden imperative exports, and supported React types.

### Out of scope

- Query, mutation, procedure, SSE, event, authentication operations, Expo capabilities, and AI SDK integration.

## ISSUE-02: Typed live-query state and reconnect semantics

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add `useQuery` as a complete single-consumer path from a generated query reference to rendered React state. It must infer arguments and rows, support a typed skip sentinel, expose disabled/pending/success/error unions, retain authoritative data as stale across reconnect, and become fresh only after AckerDB resume or reset confirms state.

### Why this slice exists

Live queries are the central React value proposition. This slice delivers the entire observable query contract before adding cross-component sharing, keeping the first query implementation narrow and independently verifiable.

## Acceptance criteria

- [ ] Generated query references infer arguments, rows, and exact `AckerDBClientError` values without manual generics.
- [ ] A typed skip sentinel produces a disabled state and no underlying subscription.
- [ ] Pending, success, and error states form an exhaustive discriminated union.
- [ ] Success identifies fresh versus retained stale data; errors may retain the last authoritative data.
- [ ] Disconnect preserves last data as stale and reconnect uses AckerDB's existing resume/reset protocol.
- [ ] Data becomes fresh only after authoritative resumed or reset delivery.
- [ ] Unmount releases the single-consumer subscription.

### Implementation notes

- Likely surfaces include the React package query hook/store, generated reference types from `packages/core`, and public client subscription events in `packages/client`.
- Preserve existing cursor, reset, limit, and error semantics. Do not introduce a second query cache protocol or one-off query API.
- Keep query snapshots immutable and stable when observable state did not change.
- Structural subscription changes enter the required paired AckerDB GitHub
  benchmark when their pull request targets `canary`.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 10–14 and 19–20

### Test plan

- Render disabled, initial pending, first success, disconnect/stale, resume/fresh, reset/fresh, and error-with-last-data transitions against deterministic client events.
- Verify a skipped query never starts work and begins correctly when valid arguments replace the sentinel.
- Add compile-fail cases for wrong reference kind, arguments, row assumptions, and non-exhaustive state handling.

### Out of scope

- Sharing identical queries across components, mutations, events, native suspension, and optimistic caching.

## ISSUE-03: Shared concurrent query registry

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Make multiple `useQuery` consumers share one underlying live query when the generated reference and validated arguments are identical. Distinct arguments must remain isolated, snapshots must be coherent under concurrent rendering, and the last listener leaving must release the query entry.

### Why this slice exists

The single-consumer query path already delivers user value. This slice adds the cross-component ownership rules needed for real applications without obscuring the base query-state contract.

## Acceptance criteria

- [ ] Identical reference/argument pairs share one subscription and one authoritative snapshot.
- [ ] Different references or arguments never collide, including structurally similar values.
- [ ] Concurrent consumers observe the same version without tearing.
- [ ] Removing one of several listeners keeps the query alive; removing the last releases its subscription and registry entry.
- [ ] Strict Mode subscribe/unsubscribe sequences do not prematurely close or duplicate the underlying query.
- [ ] Re-subscribing after release starts one clean query lifetime.

### Implementation notes

- The registry belongs to the provider/client lifetime, not a process-global singleton.
- Derive deterministic keys from generated references and validated arguments; do not rely on caller object identity.
- Likely surfaces include the query store introduced by `ISSUE-02` and React concurrent-rendering tests.
- Registry ownership changes enter the required paired AckerDB GitHub
  benchmark when their pull request targets `canary`.

## Blocked by

- `ISSUE-02`

## User stories addressed

- User stories 15–18

### Test plan

- Mount two consumers with identical inputs, assert one underlying subscribe, update once, and observe one coherent snapshot in both.
- Change one consumer's arguments, then unmount listeners in both orders and assert exact release counts.
- Stress Strict Mode and interrupted rendering for leaked or prematurely closed entries.

### Out of scope

- Normalized entity caching, optimistic updates, persistence, and native process recovery.

## ISSUE-04: Typed mutations with replay identity

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add `useMutation` as a stable typed callable over generated mutation references. A mutation interrupted by connection loss must retain the identifier assigned by the base client, converge according to existing AckerDB replay behavior, and preserve determinate versus indeterminate results and exact errors.

### Why this slice exists

Mutations are independent of query caching and can ship as a complete write path once provider ownership exists. This slice proves React ergonomics without redefining AckerDB's delivery contract.

## Acceptance criteria

- [ ] Generated mutation references infer arguments and result values.
- [ ] The hook returns a stable callable across renders while using the current provider lifetime.
- [ ] Interrupted mutations retain their original identifier across reconnect and do not duplicate server effects.
- [ ] Determinate success, determinate failure, indeterminate outcome, cancellation, and connection errors remain distinguishable exactly as in `@ackerdb/client`.
- [ ] Provider shutdown settles pending mutation promises according to the base client contract.

### Implementation notes

- Likely surfaces include the React hook and public mutation entry points in `packages/client/src/client.ts`.
- Do not add optimistic cache behavior or a second retry policy.
- Avoid wrapping an existing mutation function with another function whose only job is renaming it; expose the correct callable directly through the hook.
- Structural mutation replay changes enter the required paired AckerDB GitHub
  benchmark when their pull request targets `canary`.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 21–23

### Test plan

- Compile-check inferred arguments/results and invalid reference kinds.
- Run a real mutation, sever the connection at the response boundary, reconnect, and assert one server effect with one mutation identifier.
- Verify exact success, error, indeterminate, and provider-close promise outcomes.

### Out of scope

- Optimistic UI, mutation queues persisted to disk, and mobile lifecycle orchestration.

## ISSUE-05: Typed procedures with cancellation

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add `useProcedure` as the typed one-off operation API. It must infer generated reference arguments and results, accept cancellation, preserve exact client errors, and never silently replay a procedure after a connection failure.

### Why this slice exists

The PRD intentionally excludes one-off queries, making procedures the complete explicit request/response path. This slice is independently useful and establishes non-resumable semantics before streaming procedures build on them.

## Acceptance criteria

- [ ] Generated procedure references infer arguments and result values.
- [ ] The returned callable is stable across renders and accepts an abort signal through the supported call contract.
- [ ] Abort reaches the underlying procedure and settles the caller promptly.
- [ ] Disconnect never silently replays the call and reports the existing AckerDB typed outcome.
- [ ] Wrong reference kinds and argument/result assumptions fail at compile time.

### Implementation notes

- Reuse the provider-owned client lifetime and existing procedure semantics in `packages/client`.
- Do not add a separate one-off query hook.
- Cancellation and provider shutdown must share one explicit ownership path rather than catch-and-ignore cleanup.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 24–25

### Test plan

- Execute successful, server-error, aborted, disconnected, and provider-closed procedures against a real AckerDB server.
- Assert callable stability and TypeScript inference in rendered hook fixtures.

### Out of scope

- Streaming chunks, AI SDK integration, and resuming calls after disconnection.

## ISSUE-06: Typed SSE from schema declaration to React stream

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Correct SSE typing end to end: require a yielded-value validator in the server declaration, validate every server chunk, generate an `SseRef<Arguments, Chunk>`, and expose `useSseProcedure` as a stable callable returning `ReadableStream<Chunk>`. Pull, acknowledgement, cancellation, validation failure, and disconnect must preserve AckerDB semantics.

### Why this slice exists

This is the smallest complete slice that fixes the root type-model defect. Changing only server declarations, generated types, or the React hook would leave an unsafe broken path, so the issue intentionally crosses schema, runtime, codegen, base client, and React.

## Acceptance criteria

- [ ] SSE declarations require a yielded-value validator and reject yielded values that fail it.
- [ ] Code generation emits argument/chunk references without a handler-completion generic.
- [ ] The React hook returns a standard `ReadableStream` whose chunk type is inferred from the generated reference.
- [ ] The adapter performs no eager read-ahead; downstream pull advances the source and acknowledgement.
- [ ] Stream cancellation aborts the request, returns/releases the server iterator, and settles promptly.
- [ ] Invalid chunks fail with the exact validation error and never escape as unknown.
- [ ] Disconnect or provider shutdown never restarts the stream and reports the existing typed non-resumable/indeterminate outcome.

### Implementation notes

- Likely surfaces include `packages/server/src/app/functions.ts`, server invocation/delivery, `packages/core/src/refs.ts`, `packages/cli/src/app/codegen.ts`, `packages/client`, and the new React hook.
- This is an approved breaking correction; do not retain a compatibility overload for the incorrect completion-type model.
- Preserve the current acknowledgement protocol and high-water behavior.
- Server-delivery and client-streaming changes enter the required paired
  AckerDB GitHub benchmark when their pull request targets `canary`.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 26–32 and 67

### Test plan

- Add server declaration and generated-type compile tests for valid/invalid chunk schemas.
- Stream several chunks while controlling downstream pulls and assert exact acknowledgement order.
- Cancel before first chunk, between chunks, and during disconnect; assert iterator release and one terminal outcome.
- Inject a malformed chunk and assert the validator error reaches the React consumer.

### Out of scope

- AI SDK-specific transport and resuming an SSE procedure after disconnection.

## ISSUE-07: Typed row-event subscriptions and reset boundaries

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add `useEvent` for typed insert, update, delete, and reset events. Reconnection must establish a reset boundary rather than implying that transient events were replayed, and lifecycle cleanup must release the underlying listener.

### Why this slice exists

Row events are a separate AckerDB capability from current-state queries. This slice makes their weaker replay guarantee explicit and independently testable instead of hiding events inside query behavior.

## Acceptance criteria

- [ ] Generated event/table references infer row and event payload types.
- [ ] Insert, update, delete, and reset are exhaustively distinguishable.
- [ ] Connection loss followed by reconnect produces a reset boundary before new live events.
- [ ] The hook never claims or synthesizes replay of missed transient events.
- [ ] Unmount and provider shutdown release the event subscription exactly once.

### Implementation notes

- Likely surfaces include the React event hook and the public event subscription/reset signals from `packages/client`.
- Keep reset semantics aligned with the base protocol; consumers needing current state should use `useQuery`.
- Ensure callback identity changes do not churn the underlying server subscription unnecessarily.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 33–34

### Test plan

- Deliver each event variant through a real subscription and compile-check exhaustive handling.
- Disconnect between events, reconnect, and assert one reset boundary followed by new live events only.
- Exercise rerenders and unmount for leaks or duplicate delivery.

### Out of scope

- Historical event replay, durable event logs, query cache updates, and native AppState orchestration.

## ISSUE-08: Authentication state and operations hook

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add `useAuthentication` as the complete React authentication surface. It must expose observable authentication state plus supported refresh and sign-out operations, use provider credentials, surface exact typed failures, and coordinate authentication-blocked connection state without exposing the client.

### Why this slice exists

Authentication affects every reconnect but is independently demoable as a browser sign-in/refresh/sign-out lifecycle. Landing it before native recovery prevents AppState work from inventing a parallel credential model.

## Acceptance criteria

- [ ] The hook exposes exhaustive unauthenticated, authenticating, authenticated, refresh-required/blocked, failed, and closed outcomes matching base-client semantics.
- [ ] Refresh and sign-out are fully typed and use the provider-owned client lifetime.
- [ ] Authentication failures preserve exact AckerDB errors and appear coherently in `useConnectionState`.
- [ ] Reconnect performs the existing credential handshake before restoring authenticated work.
- [ ] Strict Mode, rerender, and unmount do not duplicate refresh operations or leak authentication timers/listeners.

### Implementation notes

- Likely surfaces include authentication observability in `packages/client`, React external stores/hooks, and integration with server auth leases.
- Do not create a second token cache or persistent credential store.
- Credential sourcing stays in provider configuration; native process persistence remains out of scope.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 35–37

### Test plan

- Exercise initial authenticated and unauthenticated connections, refresh success/failure, expiry during reconnect, sign-out, and provider close.
- Render authentication and connection-state consumers together and assert coherent transitions.
- Compile-check hook state and operation types.

### Out of scope

- UI forms, external identity-provider widgets, disk persistence, and native background behavior.

## ISSUE-09: AI SDK v7 chat transport over AckerDB SSE

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add `@ackerdb/client-react/ai` with a hook that implements AI SDK v7's chat transport over a generated AckerDB SSE procedure. Standard chat request data and abort signals must flow directly into AckerDB, validated `UIMessageChunk` objects must flow directly out, custom procedure arguments must use a typed mapper, and reconnect must explicitly report unsupported.

### Why this slice exists

AI SDK is the primary SSE use case, but it should remain an adapter over the generic stream delivered by `ISSUE-06`. This slice proves that no second wire encoding or separately versioned package is needed.

## Acceptance criteria

- [ ] The `/ai` subpath is isolated from the base React entry and implements the AI SDK v7 chat transport contract.
- [ ] Standard chat identifiers, messages, trigger data, headers, credentials, metadata, and abort signals are forwarded.
- [ ] A typed mapper supports custom AckerDB arguments without losing procedure/chunk inference.
- [ ] Text, reasoning, tool, source, file, data, metadata, and error chunks pass through as validated `UIMessageChunk` values without re-encoding SSE.
- [ ] Cancelling generation cancels the AckerDB stream.
- [ ] AI SDK stream reconnection returns unsupported/null rather than starting a hidden replacement procedure.
- [ ] Browser consumers not importing `/ai` do not resolve AI SDK runtime code.

### Implementation notes

- Keep AI SDK dependencies scoped to the conditional subpath and appropriate peer/optional dependency declarations.
- The server handler may return the stream produced by AI SDK directly; AckerDB's yielded validator remains authoritative.
- Do not introduce `@ackerdb/ai-sdk` unless packaging evidence proves the subpath impossible.

## Blocked by

- `ISSUE-06`

## User stories addressed

- User stories 38–44

### Test plan

- Run AI SDK v7 `useChat` against a real AckerDB SSE procedure for text, reasoning, tool, source, file, data, metadata, and error streams.
- Verify standard request forwarding, a custom argument mapper, cancellation at multiple points, malformed chunks, and server failures.
- Assert reconnection is explicitly unsupported and no second stream begins.

### Out of scope

- Other AI SDK major versions, persistent generation resume, and a separate AI package.

## ISSUE-10: Single-package Expo runtime adapter

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Make the same `@ackerdb/client-react` package connect from a current Expo React Native application through the `react-native` export condition. The native entry must compose the shared provider/hooks with named Expo fetch and Expo cryptographic randomness, while the browser entry remains free of Expo modules. Shared wire code must work without Node `Buffer`.

### Why this slice exists

This is the decisive packaging tracer bullet: one package, one public API, two real runtimes, and only a thin native capability layer. It tests the preferred architecture before lifecycle complexity is added.

## Acceptance criteria

- [ ] Metro selects the package's `react-native` entry in a custom Expo application using the approved Expo/React Native/React versions.
- [ ] Native networking uses the named Expo fetch implementation and randomness uses Expo Crypto.
- [ ] Browser bundling never resolves, executes, or includes Expo/React Native modules.
- [ ] Wire encoding is based on portable bytes/base64 and has no Node `Buffer` dependency in either client runtime.
- [ ] Missing native peers fail clearly during installation or resolution rather than during a request.
- [ ] A minimal Expo development build connects through `AckerDBProvider` and reaches ready on a physical device without Expo Go.
- [ ] Real packed browser and Metro fixtures prove exports and type declarations resolve correctly.

### Implementation notes

- Likely surfaces include `packages/core/src/wire.ts`, runtime capabilities in `packages/client`, conditional exports and peers in the React package, and browser/Expo consumer fixtures.
- Shared React hooks must not import native modules. The native entry supplies only capabilities and lifecycle integration points.
- A separate native package is permitted only if a documented Metro failure proves conditional exports impossible; keep it as thin re-exports plus capabilities.
- Portable wire/client changes enter the required paired AckerDB GitHub
  benchmark when their pull request targets `canary`.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 2–4, 45–48, 67, 69–70

### Test plan

- Pack and install the package into clean browser and Expo fixtures; build both and inspect browser output for Expo modules.
- Run protocol encoding tests in an environment without `Buffer`.
- Connect a physical-device custom Expo development build and exercise provider state.
- Remove each mandatory native peer in turn and assert a clear failure.

### Out of scope

- Bare React Native, Expo Go, backward compatibility, AppState recovery, and long-background acceptance.

## ISSUE-11: Query-safe Expo suspension and immediate recovery

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add native `AppState` ownership and connection generations so a mounted Expo query survives process-alive background suspension. Backgrounding must publish suspended, retire the physical socket and timers, and keep logical query demand/cursors. Activation must begin a fresh authenticated connection in the same event turn, ignore stale backoff, resume/reset the query, and prevent retired callbacks from touching the new generation.

### Why this slice exists

A single mounted query is the narrowest complete proof of durable recovery. It exercises lifecycle observation, socket ownership, authentication, subscription demand, cursor recovery, and rendered stale/fresh state without mixing in every operation type.

## Acceptance criteria

- [ ] One native `AppState` listener is registered per client lifetime and removed before close.
- [ ] Entering `background` atomically publishes suspended, invalidates the current generation, stops connection-owned timers, and intentionally closes the socket while retaining query demand/cursor and credentials.
- [ ] iOS `inactive` alone does not retire the connection.
- [ ] Entering `active` coalesces duplicate events and starts one fresh attempt in the same event turn when demand exists, regardless of previous reconnect backoff.
- [ ] Foreground recovery authenticates before restoring the query and uses exact resume/reset semantics.
- [ ] Query data remains stale during suspension/recovery and becomes fresh only after authoritative server delivery.
- [ ] Generation guards prevent stale socket callbacks, timers, auth completions, and subscription work from mutating or closing the replacement connection.
- [ ] No live demand leaves the active client idle rather than opening a socket.

### Implementation notes

- The lifecycle observer belongs below hooks in the native runtime adapter, while connection generation ownership belongs in the base client state machine.
- Retain logical work separately from physical transport state. Do not infer liveness from a remembered WebSocket state.
- No network-reachability dependency or background service is needed; failed immediate attempts enter ordinary reconnect behavior.
- Structural client changes enter the required paired AckerDB GitHub benchmark
  when their pull request targets `canary`.

## Blocked by

- `ISSUE-02`
- `ISSUE-03`
- `ISSUE-08`
- `ISSUE-10`

## User stories addressed

- User stories 49–54, 59–62, 65, and 70

### Test plan

- Drive deterministic fake AppState and socket generations through background/active during connecting, authenticating, ready, reconnect backoff, and subscription application.
- Assert exact state, timer, socket, auth, and query transitions; inject late callbacks from every retired generation.
- In the physical-device fixture, background and foreground a mounted query and verify stale then fresh rendering with one replacement socket.
- Measure that the first attempt begins in the activation event turn and ready occurs within the handshake deadline/ten-second ceiling when reachable.

### Out of scope

- Mutation/event convergence, procedure/SSE/AI settlement, process termination persistence, and the full adversarial physical-device matrix.

## ISSUE-12: Foreground mutation and event convergence

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Extend foreground recovery to pending mutations and active row-event subscriptions. Suspension must retain original mutation identifiers and logical event registrations. A fresh authenticated connection must converge mutations without duplicate effects and restart events behind an explicit reset boundary, including when the server is unavailable on first activation.

### Why this slice exists

Query recovery proves the lifecycle state machine. This slice adds the two resumable/convergent operation families with distinct guarantees, producing a complete offline-gap behavior without mixing in non-resumable streams.

## Acceptance criteria

- [ ] Backgrounding retains pending mutation identifiers and event demand while retiring their physical connection work.
- [ ] Foreground authentication precedes mutation convergence and event reapplication.
- [ ] A pending mutation produces at most one server effect and settles through the existing determinate/indeterminate contract.
- [ ] Event consumers receive one reset boundary before new live events and never receive fabricated replay.
- [ ] If the server is unavailable on activation, ordinary reconnect continues and both operation families recover when it returns.
- [ ] Repeated lifecycle events and stale generations cannot duplicate mutation effects, event listeners, reset boundaries, or delivery.

### Implementation notes

- Reuse the generation and logical-demand model from `ISSUE-11`; do not create operation-specific sockets or AppState observers.
- Preserve base mutation UUIDs and event reset semantics exactly.
- Backgrounding during handshake, authentication, mutation response, or event subscription application must converge deterministically.
- Structural reconnect/replay changes enter the required paired AckerDB GitHub
  benchmark when their pull request targets `canary`.

## Blocked by

- `ISSUE-04`
- `ISSUE-07`
- `ISSUE-08`
- `ISSUE-11`

## User stories addressed

- User stories 53, 55–56, and 58–61

### Test plan

- Background at each mutation delivery/response boundary, then activate and assert original identifier plus one server effect.
- Background during event subscription application and live delivery, then assert one reset boundary and new events only.
- Activate while the server is down, restore it later, and verify automatic recovery without an app restart.
- Repeat cycles while injecting late generation callbacks and assert no duplicates or leaked listeners.

### Out of scope

- Procedure, SSE, and AI cancellation; disk-persisted mutation queues; historical event replay.

## ISSUE-13: Settle procedures, SSE, and AI streams during suspension

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Complete native suspension semantics for non-resumable work. Backgrounding must abort and promptly settle procedures, generic SSE streams, and AI generations with their exact typed interruption/indeterminate outcomes, release server iterators and pending acknowledgements, and prevent activation from silently restarting any of them.

### Why this slice exists

Non-resumable work has the opposite lifecycle contract from queries and mutations. Keeping it separate makes the terminal behavior explicit and ensures durable reconnection cannot accidentally become unsafe procedure replay.

## Acceptance criteria

- [ ] Backgrounding settles every in-flight procedure without silently replaying it on activation.
- [ ] Generic SSE cancellation reaches the source iterator and releases pending acknowledgement state.
- [ ] AI SDK consumers receive a terminal cancellation/interruption and no hidden reconnect stream.
- [ ] Backgrounding during procedure response, first SSE chunk, downstream pull, acknowledgement, or AI tool flow has one deterministic terminal outcome.
- [ ] Stale callbacks from retired generations cannot deliver chunks or settle replacement work.
- [ ] Foreground recovery of queries and other resumable work remains independent of these terminal operations.

### Implementation notes

- Drive settlement through the connection generation's owned pending-operation registry; do not add timers or catch-and-ignore cleanup.
- Preserve base-client error categories and `ReadableStream` cancellation semantics.
- AI transport reconnection remains unsupported after the lifecycle event.

## Blocked by

- `ISSUE-05`
- `ISSUE-06`
- `ISSUE-09`
- `ISSUE-11`

## User stories addressed

- User stories 57 and 61

### Test plan

- Suspend at every procedure/SSE/AI boundary and assert prompt settlement, one iterator return, one terminal notification, and no restart after active.
- Pull slowly from SSE, background with an unacknowledged chunk, and verify exact release behavior.
- Run a simultaneous query and AI generation: the query must recover while the generation terminates.

### Out of scope

- Resumable AI generation, keeping background sockets alive, and operating-system process termination.

## ISSUE-14: Physical-device lifecycle acceptance and hardening

### Type

HITL

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Run and harden the complete process-alive lifecycle contract on physical iOS and Android devices using custom Expo development and release builds. Cover real suspension durations, Doze/App Standby, network transitions, server outages/restarts, authentication expiry, repeated cycles, and suspension at critical protocol boundaries. Fix any root-cause lifecycle defects found and record reproducible evidence.

### Why this slice exists

Simulated lifecycle events cannot prove operating-system timer, socket, and process behavior. This is the release-gating tracer bullet for the exact failure that motivated durable recovery, and it requires human access to physical devices and network/system controls.

## Acceptance criteria

- [ ] Custom Expo development and release builds pass on physical iOS and Android devices; Expo Go and simulators are not counted.
- [ ] Background durations of 30 seconds, two minutes, five minutes, and fifteen minutes recover without restarting while the process remains alive.
- [ ] A reachable server receives the first attempt in the activation event turn and reaches ready within the handshake deadline and ten-second ceiling.
- [ ] Server unavailable/restart, airplane mode, Wi-Fi/cellular transitions, Android forced Doze, and App Standby all recover automatically when connectivity/server returns.
- [ ] Credential expiry, query resume/reset, mutation convergence, event reset, and procedure/SSE/AI settlement match their issue contracts.
- [ ] Foreground reauthentication may refresh credential provenance but preserves the same durable AckerDB Identity before authenticated work resumes.
- [ ] Rapid repeated cycles and suspension during handshake, authentication, subscription application, mutation response, SSE acknowledgement, and AI streaming create no parallel sockets, leaks, duplicate effects, or stale delivery.
- [ ] The test record distinguishes process-alive recovery from expected fresh launch after OS process termination.

### Implementation notes

- Maintain a repeatable physical-device matrix with device/OS/build mode, duration, transition, expected state sequence, timings, and result.
- Use custom Expo builds only; do not start a new development server before checking for and reusing an existing one.
- Fix root causes in lifecycle/generation ownership, not by adding retry delays or masking stale state.
- Capture durable Identity and credential-provenance transitions alongside connection generations during authentication recovery.
- Update the reconnect lifecycle wiki when device evidence changes a decision.

## Blocked by

- `ISSUE-11`
- `ISSUE-12`
- `ISSUE-13`
- `ISSUE-18`

## User stories addressed

- User stories 49, 51–65, and 90

### Test plan

- Execute the full PRD physical-device duration, network, server, authentication, operation-boundary, and repeated-cycle matrix in both build modes and both operating systems.
- Capture connection-state timelines, generation identifiers, server-side mutation counts, event reset boundaries, stream settlement, listener/socket counts, and recovery timing.
- Assert that credential refresh during foreground recovery does not replace the application Identity.
- Repeat any flaky or timing-sensitive failure until its deterministic boundary is understood and fixed.

### Out of scope

- Expo Go, simulator-only claims, background services, push synchronization, and persistence across OS process termination.

## ISSUE-15: Publish-ready cross-runtime package

### Type

AFK

### Parent PRD

`PRD: @ackerdb/client-react for React, Expo, and AI SDK streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Finish the feature as a lockstep AckerDB package. Wire
`@ackerdb/client-react` into release preparation, protected GitHub checks,
public canary/stable delivery, local Verdaccio betas, root typechecks, packed
consumer verification, documentation, and wiki quality checks. Prove the
tarball supports browser React, Expo React Native, and the optional AI subpath
at one exact version.

### Why this slice exists

Individual hooks are not a product until real consumers can install the exact artifact through AckerDB's release workflow. This final slice verifies the assembled vertical paths and makes the package recoverable and repeatable with the complete lockstep package set.

## Acceptance criteria

- [ ] All twelve `@ackerdb` publication units share one exact version, and GitHub release policy rejects drift.
- [ ] Public npm and local beta publication include `@ackerdb/client-react` in dependency order and resume safely after interruption.
- [ ] Packed clean browser and Expo consumers resolve the correct exports, peers, raw TypeScript/types, and optional `/ai` subpath.
- [ ] Browser output contains no Expo/React Native code; the Expo fixture uses Expo fetch/crypto and passes Metro resolution.
- [ ] Root typecheck/test workflows cover all hooks, generated references, runtime conditions, and AI integration.
- [ ] Packed server/client/React consumers agree on the provider-neutral principal, durable Identity, credential-provenance, and account-linking contracts.
- [ ] The required GitHub check produced paired base/head AckerDB observations
      on Hetzner, and Pedro plus an agent interpreted the full vector without an
      automated benchmark verdict.
- [ ] User-facing documentation covers durable Identity, provider-account linking boundaries, supported versions, Expo requirements, hooks, query states, SSE/AI usage, mobile recovery guarantees, and explicit out-of-scope behavior.
- [ ] Wiki index/link/lint checks pass and research decisions remain discoverable.

### Implementation notes

- Likely surfaces include package manifests, `scripts/release/`, `scripts/ci/`,
  `.github/workflows/`, consumer fixtures, and release documentation.
- Exercise public canary delivery and repeatable local Verdaccio betas with exact version pins.
- This issue assembles and verifies earlier behavior; it must not become a bucket for unfinished hook or lifecycle implementation.
- Do not commit a benchmark result; the current-head GitHub artifact and human
  reasoning in the pull request are the merge evidence.

## Blocked by

- `ISSUE-03` through `ISSUE-14`
- `ISSUE-16` through `ISSUE-20`

## User stories addressed

- User stories 1–4, 45–48, 63, and 67–90

### Test plan

- Run the complete unit, integration, compile, React Strict Mode, browser fixture, Expo physical-device, and AI SDK suites from a clean checkout.
- Run the complete first-login, provider-convergence, linking/unlinking, principal, client-authentication, and secret-absence suites.
- Pack and install exact artifacts into clean consumers, then run browser production build and Expo Metro/release builds.
- Exercise release preparation, protected policy, interrupted publish/resume,
  exact install, beta numbering, and version-drift failure paths.
- Review the paired Hetzner artifact for the current pull-request commit and do
  not let benchmark values approve or veto the release automatically.

### Out of scope

- Backward compatibility, new features beyond the parent PRD, and persistence/background services.

## ISSUE-16: Durable Identity from first login to row ownership

### Type

AFK

### Parent PRD

`PRD: Provider-neutral Identity and @ackerdb/client-react for web, Expo, and AI streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Deliver the minimum complete provider-neutral Identity path: after a configured external user credential is cryptographically verified, AckerDB transactionally resolves or provisions an immutable internal Identity, constructs a typed user principal containing that Identity, and lets a normal authenticated mutation store and retrieve application rows keyed by it. Workload, system, and anonymous principals remain distinct.

### Why this slice exists

Every provider-neutral and MCP capability depends on a durable application user rather than an issuer-specific subject. Storage without principal construction would be unusable, while principal typing without durable storage would preserve the original problem; this slice proves both together.

## Acceptance criteria

- [ ] A first verified external-user login atomically creates one internal Identity and one exact issuer/subject account link before the application principal is constructed.
- [ ] The authenticated user principal exposes a typed, non-null AckerDB Identity that can be stored in and compared against application `userId` columns.
- [ ] Identity and link records use reserved internal storage and are absent from application schema declarations, generated table APIs, and raw client subscriptions.
- [ ] Identity values are immutable, monotonically allocated, and never reused.
- [ ] Provider claims remain current credential provenance and are not copied into durable Identity records or treated as application ownership authority.
- [ ] Concurrent first authentication for the same exact issuer/subject converges on one Identity.
- [ ] Workload, system, and anonymous principals cannot accidentally acquire or own a user Identity.

### Implementation notes

- Integrate identity records with the Engine's existing internal-schema ownership and transactional writer instead of creating a side database.
- Resolve Identity inside the shared authentication lifecycle after credential verification, never as a hidden write inside a query handler.
- Refactor the existing principal contract directly; do not retain a compatibility principal keyed by issuer/subject.
- At the release version, run the full Hetzner comparison for the structural authentication and internal-schema change.

## Blocked by

None — can start immediately.

## User stories addressed

- User stories 71–73 and 75–80

### Test plan

- Authenticate a new external user, write a row owned by the resulting Identity, reconnect, and read the same row through the same principal.
- Race concurrent first logins and assert one durable Identity/link pair.
- Restart the server and prove Identity durability and non-reuse.
- Compile-check user versus workload/system/anonymous principal narrowing and confirm internal tables are inaccessible through generated client APIs.

### Out of scope

- Multiple-provider convergence, explicit account linking/unlinking, React authentication state, user profiles, and MCP tokens.

## ISSUE-17: Exact-account convergence across configured providers

### Type

AFK

### Parent PRD

`PRD: Provider-neutral Identity and @ackerdb/client-react for web, Expo, and AI streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Extend the first-login tracer bullet across the complete exact-account matrix. Repeated and concurrent authentication for one issuer/subject must converge after restart; provider-managed Clerk login methods that emit the same issuer/subject must remain one AckerDB Identity; distinct configured OIDC/JWT issuers and subjects must remain separate unless explicitly linked later.

### Why this slice exists

The first slice proves one credential path. This slice proves the provider-neutral invariant without introducing account-management APIs or provider-specific server packages.

## Acceptance criteria

- [ ] Repeated, refreshed, concurrent, and post-restart authentication for one exact issuer/subject always resolves the original Identity.
- [ ] Several Clerk-managed login methods producing the same Clerk issuer/subject resolve one AckerDB account link.
- [ ] Better Auth, Auth0, WorkOS, Keycloak, and custom OIDC/JWT-style fixtures use the same verification-to-Identity contract without provider SDK branches.
- [ ] The same subject under different issuers and different subjects under one issuer remain distinct.
- [ ] Matching email, phone, display name, or another mutable claim never causes automatic linking.
- [ ] Identity allocation remains durable and never reused across all provider fixtures.

### Implementation notes

- Use controlled OIDC/JWKS fixtures to verify issuer, audience, algorithm, token type, expiry, and claims before Identity resolution.
- Provider neutrality lives at the verified credential boundary; do not model a provider's internal email/social/passkey connection records.
- Keep explicit cross-provider linking in ISSUE-19.

## Blocked by

- `ISSUE-16`

## User stories addressed

- User stories 74–75, 81–82, and 86

### Test plan

- Exercise the complete issuer/subject collision matrix, concurrent login, refresh, and restart behavior.
- Verify Clerk-style linked methods and at least one Better Auth/custom JWKS fixture.
- Present identical unverified email claims from distinct issuers and assert separate Identities.

### Out of scope

- User-directed cross-provider linking, unlinking, provider UI, and React authentication state.

## ISSUE-18: Identity-aware client and React authentication lifecycle

### Type

AFK

### Parent PRD

`PRD: Provider-neutral Identity and @ackerdb/client-react for web, Expo, and AI streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Carry the new principal contract through the authentication wire state, base client, and `useAuthentication` so authenticated state exposes durable Identity separately from current credential provenance. Refresh, reconnect, sign-out, and Expo foreground authentication must preserve or clear those fields coherently without changing the existing connection-lifecycle guarantees.

### Why this slice exists

Server Identity is not a complete application feature until clients can use it without reading provider identifiers. This slice is separately demoable through the existing browser and Expo authentication flows and can proceed in parallel with optional account linking.

## Acceptance criteria

- [ ] Authenticated client and React states expose a typed, non-null Identity and discriminated current credential provenance as separate fields.
- [ ] Credential refresh and reconnect may replace provenance while preserving the same Identity.
- [ ] Expo foreground reauthentication preserves Identity before restoring authenticated work.
- [ ] Sign-out clears both Identity and credential provenance coherently in authentication and connection state.
- [ ] No raw provider token, MCP token, or secret appears in client state.
- [ ] Existing Strict Mode, authentication-blocked, reconnect, and foreground-recovery behavior remains intact.
- [ ] Compile-time fixtures distinguish external-user Identity from workload, system, and anonymous states.

### Implementation notes

- Extend the existing authentication observable rather than introducing a second identity store.
- Update only tests and types genuinely invalidated by the approved principal refactor; preserve existing React, SSE, Expo, and AI transport guarantees.
- Existing physical-device ISSUE-14 must depend on this slice.

## Blocked by

- `ISSUE-08`
- `ISSUE-11`
- `ISSUE-16`
- `ISSUE-17`

## User stories addressed

- User stories 71, 73–74, 79, and 90

### Test plan

- Render `useAuthentication` through initial login, credential refresh, reconnect, sign-out, and foreground recovery while asserting Identity/provenance transitions.
- Refresh with a new credential for the same exact account and assert stable Identity.
- Compile-check exhaustive state narrowing and absence of secrets.

### Out of scope

- Account linking/unlinking UI or operations, durable disk sessions, MCP token management, and changes to query ownership semantics beyond the principal type.

## ISSUE-19: Opt-in cross-provider account linking

### Type

AFK

### Parent PRD

`PRD: Provider-neutral Identity and @ackerdb/client-react for web, Expo, and AI streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Provide an opt-in server primitive that lets an already authenticated external user prove a second configured-provider credential and atomically attach its exact issuer/subject account to the current Identity. A sample application mutation must demonstrate that either credential subsequently reaches the same owned data.

### Why this slice exists

Cross-provider continuity is valuable but security-sensitive and optional. Keeping it after exact-account resolution produces a narrow, reviewable capability without blocking ordinary authentication or client Identity work.

## Acceptance criteria

- [ ] Linking requires a current authenticated external user and successful verification of the second configured-provider credential.
- [ ] The new exact issuer/subject is attached atomically to the current Identity.
- [ ] Authenticating with either linked account reaches the same application-owned rows.
- [ ] Email, phone, display name, or another claim cannot substitute for proof of the second credential.
- [ ] Linking fails without mutation/transaction authority or when the account is already owned by another Identity.
- [ ] AckerDB never performs a generic merge or rewrites application-owned rows after a conflict.
- [ ] Applications choose whether and through which mutation to expose linking.

### Implementation notes

- Reuse the configured credential-verifier registry and one transactional identity-directory operation.
- Treat cross-Identity migration as explicit application logic outside this primitive.
- Do not expose a provider-specific client or UI flow.

## Blocked by

- `ISSUE-16`
- `ISSUE-17`

## User stories addressed

- User stories 83–88

### Test plan

- Link accounts from two controlled issuers and authenticate through both to the same row ownership.
- Reject unauthenticated linking, invalid credentials, claim-only matches, and an account already owned by another Identity.
- Roll back a forced transactional failure and assert no partial link.

### Out of scope

- Generic Identity merging, application-row migration, unlinking, provider UI, and automatic linking.

## ISSUE-20: Safe external-account unlinking

### Type

AFK

### Parent PRD

`PRD: Provider-neutral Identity and @ackerdb/client-react for web, Expo, and AI streaming` ([#3](https://github.com/pedrobzz/ackerdb/issues/3))

## What to build

Add the destructive inverse of linking as an opt-in server primitive. An authenticated application mutation can remove a secondary external account link, but cannot remove the final valid account or delete/reassign the durable Identity.

### Why this slice exists

Unlinking has a distinct lockout and revocation risk. Isolating it produces a small, independently reviewable operation instead of complicating the successful linking path.

## Acceptance criteria

- [ ] An authenticated owner can unlink one secondary exact issuer/subject account through an application-exposed mutation.
- [ ] The final remaining external account cannot be unlinked.
- [ ] The removed credential no longer resolves to the previous Identity for new authentication.
- [ ] The durable Identity and application-owned rows remain unchanged.
- [ ] Unlinking another Identity's account and unauthenticated unlinking fail without revealing account existence.
- [ ] Application-specific deletion and erasure policy is not inferred from unlinking.

### Implementation notes

- Perform ownership, last-link, and delete checks in one transaction.
- Publish any authentication invalidation only after commit.
- Keep full Identity deletion and application data erasure out of the framework primitive.

## Blocked by

- `ISSUE-19`

## User stories addressed

- User stories 85 and 89

### Test plan

- Link two accounts, unlink one, and prove the retained account still owns the same data while the removed account no longer resolves to it.
- Reject last-link removal, cross-owner removal, and rollback failures.
- Restart after unlinking and verify durable results.

### Out of scope

- Identity deletion, account recovery, provider-side credential deletion, application-data erasure, and generic merges.
