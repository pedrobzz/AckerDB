# T4 — Client and API ergonomics prototype report

Branch: `audit/t4-client-api`

Base: `origin/main` at `57c64cd`

Outcome: five findings fixed, one partially completed to the required boundary,
one deliberately refuted, and no owner-level blocker.

## Executive result

The public client now starts atomically, retryable subscription demand belongs
to the client, realtime peer retention is independent from handler observation,
SSE framing has one core owner, and React query-procedure timers use the injected
client scheduler. The touched client regions moved into cohesive
`connection/`, `subscriptions/`, `sse/`, and `realtime/` owners.

The proposed deletion of `client-react/lifetime-call.ts` was refuted. Atomic
transport startup does not eliminate React's render-to-commit lifetime gap, and
moving that machinery into the framework-neutral client would preserve the same
state machine while giving the client no honest source of React commit/unmount
facts.

## Finding verdicts

| # | Finding | Status | Verdict | Commits |
| --- | --- | --- | --- | --- |
| 1 | Atomic client startup | Fixed, breaking | Clear win | `d8162e5`, `cd7a8b0` |
| 2 | Collapse React lifetime compensation | Refuted | Refuted | No code change |
| 3 | Retry policy single-owner | Fixed | Clear win | `cd7a8b0` |
| 4 | Remove realtime `handlerKey` | Fixed, breaking | Clear win | `cd7a8b0`, `8148981` |
| 5 | Own SSE framing once | Fixed | Clear win with measured memory cost | `bb92489`, `843aaf0` |
| 6 | Split `client.ts` | Partially fixed to the required touched regions | Needs iteration | `bb92489`, `cd7a8b0` |
| 7 | Inject the clock | Fixed | Clear win | `cd7a8b0` |

## 1. Atomic client startup — fixed

`new AckerDBClient(options)` is now the single public startup operation. The
constructor validates and initializes every owner, registers the lifecycle
source last, and then establishes standing connection demand. A lifecycle
source that synchronously reports suspension sees a fully initialized client
and prevents the physical dial until resume.

The public `connect()` method and the provider's second startup step were
deleted. Tests and consumers now assert one constructor-owned socket rather
than an inert client followed by an imperative start.

Migration:

```ts
// Before
const client = new AckerDBClient(options);
client.connect();

// After
const client = new AckerDBClient(options);
```

Tradeoff: construction now intentionally owns one standing connection even
before subscription demand exists. This removes a partially initialized public
lifetime at the cost of making construction an explicit transport side effect.
Suspended and closed clients still have no transport or background churn.

Net judgment: correctness 7/10, code quality 7/10, performance 5/10.

## 2. React lifetime call machinery — refuted

The hypothesis conflated transport startup with React lifetime ownership.
`AckerDBProvider` still must create the side-effecting client after commit to
avoid connections during render and SSR. A hook call can therefore exist before
that committed client lifetime and can be invalidated by rerender, abort, or
unmount.

`client-react/lifetime-call.ts` owns exactly those React facts:

- queued render-to-commit calls;
- immutable argument snapshots;
- commit-phase dispatch against the current provider lifetime;
- caller abort ownership; and
- unmount/provider-replacement rejection.

The framework-neutral client cannot infer commit or unmount. A proposed
"current lifetime" client primitive would either couple `@ackerdb/client` to
React or move the same cell/queue/token state behind a less honest interface.
The 237-line module therefore remains as an implementation safeguard, not a
deferred-design workaround.

Net judgment: the proposed change is refuted; retaining the current boundary is
neutral (5/10) and avoids a false LoC win.

## 3. Subscription retry ownership — fixed

A retryable subscription error no longer deletes the subscription and asks
React to construct a replacement. The client retains the same logical demand,
subscription ID, cursor, application callbacks, attempt count, and absolute
retry deadline. Successful transition/event delivery settles the retry state.
Suspension pauses only the timer; resume re-arms the remaining absolute
deadline. Authentication blocking may let the deadline expire, but retained
demand flushes after credentials recover.

The extracted owners are:

- `connection/retry-policy.ts`: the shared bounded full-jitter calculation;
- `subscriptions/retry.ts`: per-subscription deadline/timer scheduling; and
- `client.ts`: protocol decisions and transport send eligibility.

React's duplicate constants, timer, deferred-auth branch, and resubscribe path
were deleted (`query-store.ts`: -70 LoC). React now observes subscription
outcomes and connection freshness only.

The additional proportional state is one attempt counter plus optional deadline
and timer handle per subscription. No retry timer exists while a subscription
is healthy. Tests prove cursor preservation, backoff, cancellation, and the
reentrant `onError` release case.

Net judgment: correctness 8/10, code quality 8/10, performance 6/10.

## 4. Realtime canonical sharing and separate observation — fixed

Realtime groups are keyed only by client, reference address, and canonical
arguments. Every `realtime()` call retains that peer unconditionally. Handler
registration is a separate `session.observe(on)` lifetime with its own
generation setup and cleanup.

Events and peer lifecycle callbacks fan out to active observations. Incoming
byte streams are offered to the first matching active observation so AckerDB
does not create hidden `ReadableStream.tee()` buffers. Releasing an observation
cannot remove another consumer's callbacks; releasing the last retained handle
closes the shared peer.

Migration:

```ts
// Before
const session = client.realtime(ref, args, {
  handlerKey: "useAssistant",
  on,
});

// After
const session = client.realtime(ref, args);
const stopObserving = session.observe(on);

// Cleanup
stopObserving();
session.release();
```

For React, `useRealtime(ref, args, { on })` remains, but `handlerKey` is gone.
Equal calls share the peer and each committed hook owns its current observation.
The public native WebRTC fixture, ADR-0014, `CONTEXT.md`, and user documentation
were migrated with the API.

Tradeoffs: callback work grows proportionally with active observations, and
each observation's `peerConnection` setup runs once per generation. That work
is the caller-requested behavior; peer/signaling machinery remains singular.

Net judgment: correctness 7/10, code quality 7/10, performance 5/10.

## 5. SSE framing and syntax mechanics — fixed and measured

Core now owns:

- `encodeSseChunk(sequence, proof, value)`;
- `encodeSseControl(message)`; and
- `decodeSseEvent(data, event)`.

Server delivery uses the core encoders instead of interpolating JSON. The
client uses direct dependency `eventsource-parser@3.1.0` for EventSource syntax.
AckerDB still owns exact UTF-8 retained-byte accounting, maximum buffering,
Protocol-2 decoding, sequence validation, acknowledgements, cancellation, and
terminal policy.

The local dependency source, README, package manifest, license, and exact
installed version were inspected. It is MIT, zero-dependency, and its parser
shape supports the bounded policy when paired with AckerDB's byte budget.

### Prototype measurement

`bench/client-sse-parser.prototype.ts` is marked as throwaway audit evidence.
It parses 50,001 Protocol-2 frames with a 64-byte value, 257-byte transport
chunks, and a 64 KiB buffer. Seven alternating trials ran in isolated Bun
processes after one warmup, on the same machine.

| Parser | Median elapsed | Useful frames/s | Peak JS heap growth | Retained heap growth after GC | Peak RSS growth |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous manual scanner | 505.22 ms | 98,969 | 9,789 B | 6,811 B | 3,358,720 B |
| `eventsource-parser` + AckerDB byte policy | 451.33 ms | 110,787 | 43,179 B | 14,579 B | 4,898,816 B |

The new path was 10.67% faster. Its median peak JS-heap delta was 33,390 B
higher, retained delta was 7,768 B higher, and process RSS delta was 1,540,096
B higher. These are parser-only prototype measurements, not release benchmark
evidence. The allocation increase is explicit and should be revisited under a
many-concurrent-SSE workload; it does not weaken the finite per-event byte
contract.

Net judgment: correctness 8/10, code quality 7/10, performance 6/10.

## 6. `client.ts` decomposition — partially fixed

The required touched regions now have real module owners:

- SSE syntax and byte accounting: `sse/event-decoder.ts`;
- connection backoff calculation: `connection/retry-policy.ts`;
- subscription retry lifetime: `subscriptions/retry.ts`; and
- realtime peer/session ownership: `realtime/session.ts`.

Atomic public startup remains in the facade because it defines the facade's
lifetime. Protocol subscription decisions also remain there while timer state
and policy moved out. `client.ts` fell from 2,810 to 2,804 lines despite the new
startup, scheduler, and subscription behavior.

This meets the handoff's touched-region threshold but is not the full proposed
split into operations and resource-budget owners. Continuing that work requires
narrow ports around pending operations and budget accounting rather than moving
methods mechanically.

Net judgment: code quality 6/10 now; further decomposition needs iteration.

## 7. Clock injection — fixed

The client exposes a stable read-only scheduler backed by its injected clock.
`QueryProcedureEntry` now uses `client.scheduler.now()`, `setTimeout()`, and
`clearTimeout()` instead of global `Date.now` and timer functions. Refresh
deadlines are deterministic under the existing fake client clock, including
large-delay stepping.

Net judgment: correctness 7/10, code quality 7/10, performance 5/10.

## LoC delta against `origin/main`

| Area | Added | Deleted | Net |
| --- | ---: | ---: | ---: |
| `packages/client` source + manifest | 487 | 246 | +241 |
| `packages/client` tests | 182 | 196 | -14 |
| `packages/client-react` source | 19 | 99 | -80 |
| `packages/client-react` tests | 10 | 24 | -14 |
| `packages/core` source | 44 | 0 | +44 |
| `packages/core` tests | 40 | 0 | +40 |
| `packages/server` source | 21 | 29 | -8 |
| Native realtime fixture | 8 | 13 | -5 |
| Docs and domain context | 42 | 44 | -2 |
| Throwaway benchmark | 210 | 0 | +210 |
| Lockfile | 1 | 0 | +1 |
| **Total** | **1,064** | **651** | **+413** |

Product implementation and manifests across core/server/client/client-react are
net +197 LoC. The largest additions are explicit SSE and realtime observation
owners; React source is net -80 LoC. The retained audit benchmark accounts for
+210 of the total repository delta.

## Verification

Passing:

- `bun run typecheck`: root, client-react, and Expo fixture configs pass.
- Isolated strict typecheck of the migrated native WebRTC public fixture passes.
- `packages/core`: 78 pass, 0 fail.
- `packages/client`: 191 pass, 0 fail.
- `packages/client-react`: 164 pass, 0 fail.
- Focused server SSE boundaries (`delivery`, `http-wire`, `serve`): 99 pass,
  0 fail.
- Full server suite: 970 pass; the one remaining failure is documented below.
- SSE benchmark source passes an isolated strict TypeScript check.
- `git diff --check` passes.

Known verification exceptions:

1. The full server suite's native-vector test expects its mocked `numkong`
   import to make Engine startup fail, but the child exits 22 because startup
   succeeds. The isolated test is 3 pass / 1 fail. A clean archive of
   `origin/main` reproduced the exact same exit 22 and 3/1 result, and T4 has no
   diff in the vector runtime or its test. This is not a branch regression.
2. The native public realtime test cannot execute on this machine because the
   `@ackerdb/realtime-darwin-arm64` binding is absent. The migrated fixture
   passes strict typechecking. No native build was started.
3. The broad bench tsconfig initially could not run because its generated
   `_generated/server.ts` is absent. The new benchmark was typechecked in
   isolation and executed directly instead.

## New discoveries

- A subscription `onError` callback can synchronously release its own
  subscription. Scheduling retry after that callback without rechecking object
  identity leaves an orphan timer. The client now verifies that the same
  subscription is still retained before scheduling; a regression test covers
  it.
- Removing realtime collision keys exposed stale domain truth in `CONTEXT.md`
  and a native public-session consumer outside the initially listed client and
  React packages. Both were migrated.
- The repository-mandated `.agents/skills/llm-wiki/SKILL.md` is absent in this
  worktree. No external research was needed; the exact installed
  `eventsource-parser@3.1.0` package source and primary package materials were
  inspected locally.
- The server native-vector mock failure exists unchanged at the base commit,
  which is useful follow-up for the server/test track.

## Commit sequence

1. `bb92489` — centralize bounded SSE framing and parsing
2. `d8162e5` — make client construction own startup
3. `cd7a8b0` — centralize client demand and realtime observation
4. `8148981` — migrate native realtime session consumer
5. `843aaf0` — add SSE parser prototype benchmark

No `BLOCKED.md` was created because no unresolved question requires owner or
coordinator policy.
