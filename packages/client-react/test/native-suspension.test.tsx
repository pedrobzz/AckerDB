// ISSUE-12, React surface: the mutation and event hooks across native
// AppState suspension. The base client owns replay identity and reset
// semantics (packages/client/test/suspension-convergence.test.ts); these
// tests prove the hook contracts hold through a background/active cycle
// driven by the real native entry with a mocked AppState: a `useMutation`
// promise settles exactly once, and `useEvent` observes one reset boundary
// and then only new events.
import { describe, expect, mock, test } from "bun:test";
// Registers happy-dom before any React module loads — every test file in this
// suite must do this first (see ackerdb-test-support/dom).
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { FakeAppState, setAppState } from "./support/app-state.ts";
import { createHarness } from "./support/harness.ts";
import type { FakeSocket } from "ackerdb-test-support/client-transport";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type LiveEventCursor,
  type ServerMessage,
} from "@ackerdb/core";
import type {
  ClientResult,
  AckerDBLiveEvent,
  EventRef,
  MutationRef,
} from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The native entry composes the Expo/React Native platform modules, which
// only exist inside a React Native app; mocks stand in for all three. The
// AppState fake is shared with the other native suites so every file
// registers the same module identity.
mock.module("react-native", () => ({ AppState: FakeAppState }));
mock.module("expo/fetch", () => ({
  fetch: () => Promise.reject(new Error("expo fetch is unused in this suite")),
}));
mock.module("expo-crypto", () => ({
  getRandomValues: (array: Uint32Array) => {
    array[0] = 0;
    return array;
  },
}));

const { AckerDBProvider, useConnectionState, useEvent, useMutation } = await import(
  "../src/index.native.ts"
);

const SESSION = "native-suspension-session";
const APP = { url: "http://native-suspension.test", clientSessionId: SESSION };

type TodoArgs = { readonly text: string };
const todosAdd = { $ref: "api.todos.add" } as MutationRef<TodoArgs, bigint>;
type PingRow = { readonly n: number };
const pings = { $ref: "api.events.pings" } as EventRef<{ readonly min: number }, PingRow>;

function eventCursor(
  sequence: bigint,
  generation = "events-1",
  commitVersion = 1n,
): LiveEventCursor {
  return { generation, commitVersion, sequence };
}

function liveEvent(
  id: number,
  event:
    | { readonly kind: "row"; readonly cursor: LiveEventCursor; readonly row: unknown }
    | { readonly kind: "gap" | "reset"; readonly cursor: LiveEventCursor },
): ServerMessage {
  return { v: PROTOCOL_VERSION, t: "event", id, event };
}

function mutationOk(
  frame: Extract<ClientMessage, { t: "m" }>,
  value: bigint,
  replay: "executed" | "replayed" = "executed",
): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "ok",
    id: frame.id,
    kind: "mutation",
    value,
    receipt: {
      mutationRequestId: frame.mutationRequestId,
      commitVersion: 2n,
      durability: "production",
      replay,
      obligations: [],
    },
  };
}

function mutationSends(sockets: FakeSocket[], mutationRequestId: string): number {
  return sockets
    .flatMap((socket) => socket.framesOf("m"))
    .filter((frame) => frame.mutationRequestId === mutationRequestId).length;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

async function platform(state: Parameters<typeof setAppState>[0]): Promise<void> {
  await act(async () => {
    setAppState(state);
  });
}

interface Settlements {
  readonly values: bigint[];
  readonly errors: unknown[];
}

function track(promise: Promise<ClientResult<bigint>>, into: Settlements): void {
  promise.then((result) => {
    if (result.ok) into.values.push(result.data);
    else into.errors.push(result.error);
  });
}

const captured: {
  send?: (args: TodoArgs) => Promise<ClientResult<bigint>>;
  phase?: string;
} = {};

function MutationProbe(): ReactNode {
  captured.send = useMutation(todosAdd);
  const connection = useConnectionState();
  captured.phase = connection.phase;
  return <span>{connection.phase}</span>;
}

describe("useMutation across native AppState suspension", () => {
  test("a call in flight across a background/active cycle settles exactly once with its original identity", async () => {
    actEnvironment(true);
    setAppState("active");
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <MutationProbe />
        </AckerDBProvider>
      </StrictMode>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    expect(container.textContent).toBe("ready");

    const settlements: Settlements = { values: [], errors: [] };
    const first = harness.live();
    await act(async () => {
      track(captured.send!({ text: "milk" }), settlements);
    });
    const issued = first.framesOf("m")[0]!;

    await platform("background");
    expect(container.textContent).toBe("suspended");
    // A receipt flushed by the retired generation cannot settle the call.
    await act(async () => {
      first.receive(mutationOk(issued, 99n));
    });
    expect(settlements.values).toEqual([]);

    await platform("active");
    await platform("active");
    expect(container.textContent).toBe("resuming");
    const second = harness.live();
    await act(async () => {
      second.welcome(SESSION);
    });
    const replayed = second.framesOf("m")[0]!;
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);
    expect(replayed.issuedAt).toBe(issued.issuedAt);
    expect(mutationSends(harness.sockets, issued.mutationRequestId)).toBe(2);

    await act(async () => {
      second.receive(mutationOk(replayed, 7n, "replayed"));
    });
    expect(settlements.values).toEqual([7n]);
    expect(settlements.errors).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    actEnvironment(false);
  });

  test("a call issued while backgrounded dispatches exactly once on activation", async () => {
    actEnvironment(true);
    setAppState("active");
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <MutationProbe />
        </AckerDBProvider>
      </StrictMode>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });

    await platform("background");
    const socketsBefore = harness.sockets.length;
    const settlements: Settlements = { values: [], errors: [] };
    await act(async () => {
      track(captured.send!({ text: "queued" }), settlements);
    });
    // Suspension refuses to dial; the call is retained demand, not traffic.
    expect(harness.sockets.length).toBe(socketsBefore);
    expect(settlements.values).toEqual([]);

    await platform("active");
    const socket = harness.live();
    await act(async () => {
      socket.welcome(SESSION);
    });
    const issued = socket.framesOf("m")[0]!;
    expect(mutationSends(harness.sockets, issued.mutationRequestId)).toBe(1);
    await act(async () => {
      socket.receive(mutationOk(issued, 11n));
    });
    expect(settlements.values).toEqual([11n]);
    expect(settlements.errors).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    actEnvironment(false);
  });
});

interface EventProbeProps {
  readonly onEvent: (event: AckerDBLiveEvent<PingRow>) => void;
}

function EventProbe({ onEvent }: EventProbeProps): ReactNode {
  useEvent(pings, { min: 1 }, onEvent);
  const connection = useConnectionState();
  return <span>{connection.phase}</span>;
}

describe("useEvent across native AppState suspension", () => {
  test("a subscription live across a background/active cycle sees one reset boundary and then only new events", async () => {
    actEnvironment(true);
    setAppState("active");
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const events: AckerDBLiveEvent<PingRow>[] = [];
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <EventProbe onEvent={(event) => events.push(event)} />
        </AckerDBProvider>
      </StrictMode>,
    );
    const first = harness.live();
    await act(async () => {
      first.welcome(SESSION);
    });
    const subscription = first.framesOf("sub")[0]!;
    expect(subscription.cursor).toBeUndefined();
    await act(async () => {
      first.receive(liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n) }));
      first.receive(
        liveEvent(subscription.id, { kind: "row", cursor: eventCursor(1n), row: { n: 1 } }),
      );
    });
    expect(events.map((event) => event.kind)).toEqual(["reset", "row"]);

    await platform("background");
    expect(container.textContent).toBe("suspended");
    // Whatever the retired generation still flushes reaches nobody.
    await act(async () => {
      first.receive(
        liveEvent(subscription.id, { kind: "row", cursor: eventCursor(2n), row: { n: 2 } }),
      );
      first.receive(
        liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n, "events-2") }),
      );
    });
    expect(events.map((event) => event.kind)).toEqual(["reset", "row"]);

    await platform("active");
    const second = harness.live();
    await act(async () => {
      second.welcome(SESSION);
    });
    // One re-application, cursorless: live events are never resumed.
    expect(second.framesOf("sub")).toHaveLength(1);
    expect(second.framesOf("sub")[0]!.cursor).toBeUndefined();
    await act(async () => {
      second.receive(
        liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n, "events-2") }),
      );
      second.receive(
        liveEvent(subscription.id, {
          kind: "row",
          cursor: eventCursor(1n, "events-2"),
          row: { n: 3 },
        }),
      );
    });
    expect(events.map((event) => event.kind)).toEqual(["reset", "row", "reset", "row"]);
    expect(events.flatMap((event) => (event.kind === "row" ? [event.row.n] : []))).toEqual([1, 3]);

    await act(async () => {
      root.unmount();
    });
    actEnvironment(false);
  });

  test("backgrounding during subscription application yields exactly one reset, delivered by the recovery connection", async () => {
    actEnvironment(true);
    setAppState("active");
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const events: AckerDBLiveEvent<PingRow>[] = [];
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <EventProbe onEvent={(event) => events.push(event)} />
        </AckerDBProvider>
      </StrictMode>,
    );
    const first = harness.live();
    await act(async () => {
      first.welcome(SESSION);
    });
    const subscription = first.framesOf("sub")[0]!;

    // The subscription is on the wire; its reset boundary never arrived.
    await platform("background");
    expect(events).toEqual([]);

    await platform("active");
    const second = harness.live();
    await act(async () => {
      second.welcome(SESSION);
      second.receive(liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n) }));
      second.receive(
        liveEvent(subscription.id, { kind: "row", cursor: eventCursor(1n), row: { n: 1 } }),
      );
    });
    expect(events.map((event) => event.kind)).toEqual(["reset", "row"]);

    await act(async () => {
      root.unmount();
    });
    actEnvironment(false);
  });
});
