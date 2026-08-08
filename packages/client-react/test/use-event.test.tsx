import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import { createHarness } from "./support/harness.ts";
import { PROTOCOL_VERSION, type ServerMessage } from "@ackerdb/core";
import type {
  AckerDBClientError,
  AckerDBLiveEvent,
  EventRef,
} from "@ackerdb/client";
import { StrictMode, act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, useEvent, type AckerDBProviderConfig } from "@ackerdb/client-react";
import { createBoundary } from "./support/boundary.tsx";

type PingRow = { readonly id: bigint; readonly n: number };
const pings = { $ref: "api.events.pings" } as EventRef<{ min: bigint }, PingRow>;

interface ProbeProps {
  readonly config: AckerDBProviderConfig;
  readonly min: bigint;
  readonly onEvent: (event: AckerDBLiveEvent<PingRow>) => void;
  readonly onError?: (error: AckerDBClientError) => void;
}

function Probe({ min, onEvent, onError }: Omit<ProbeProps, "config">): ReactNode {
  useEvent(pings, { min }, onEvent, onError);
  return null;
}

function app({ config, ...probe }: ProbeProps): ReactNode {
  return (
    <StrictMode>
      <AckerDBProvider config={config}>
        <Probe {...probe} />
      </AckerDBProvider>
    </StrictMode>
  );
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

// Runs `fire` in the commit's layout phase: after every insertion effect has
// installed the new committed identity, before any passive effect has released
// the superseded subscription. This is the exact window where socket traffic
// races React in production.
function Injector({ fire }: { readonly fire: (() => void) | null }): ReactNode {
  useLayoutEffect(() => {
    fire?.();
  }, [fire]);
  return null;
}

function cursor(sequence: bigint, generation = "g1"): {
  generation: string;
  commitVersion: bigint;
  sequence: bigint;
} {
  return { generation, commitVersion: sequence, sequence };
}

const APP = { url: "http://events.test", clientSessionId: "react-event-session" };

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useEvent lifecycle", () => {
  test("delivers the live union to the latest callback without churning the subscription", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const config = harness.config();
    const first: AckerDBLiveEvent<PingRow>[] = [];
    const second: AckerDBLiveEvent<PingRow>[] = [];

    await render(root, app({ config, min: 1n, onEvent: (event) => first.push(event) }));
    // Strict Mode: two provider clients, one live; its single event
    // subscription is flushed once on welcome.
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    const subs = socket.framesOf("sub");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ ref: "api.events.pings", args: { min: 1n } });
    const id = subs[0]!.id;

    await act(async () => {
      socket.receive({ v: PROTOCOL_VERSION, t: "event", id, event: { kind: "reset", cursor: cursor(0n) } });
    });
    expect(first.map((event) => event.kind)).toEqual(["reset"]);

    // A new callback identity swaps delivery without any new frames.
    await render(root, app({ config, min: 1n, onEvent: (event) => second.push(event) }));
    expect(socket.framesOf("sub")).toHaveLength(1);
    expect(socket.framesOf("unsub")).toHaveLength(0);

    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event: { kind: "row", cursor: cursor(1n), row: { id: 1n, n: 1 } },
      });
      // Skipping sequence 2 surfaces the client's honest gap marker.
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event: { kind: "row", cursor: cursor(3n), row: { id: 3n, n: 3 } },
      });
    });
    expect(first.map((event) => event.kind)).toEqual(["reset"]);
    expect(second.map((event) => event.kind)).toEqual(["row", "gap"]);
    expect(second[0]).toMatchObject({ kind: "row", row: { id: 1n, n: 1 } });

    // Unmount deletes parent-first: the provider closes the client (releasing
    // every subscription) before the hook's cleanup runs, so that cleanup must
    // be a frame-free no-op rather than a second release.
    await act(async () => {
      root.unmount();
    });
    expect(socket.framesOf("unsub")).toHaveLength(0);
    expect(harness.open()).toHaveLength(0);
    expect(harness.clock.taskCount).toBe(0);

    // Late frames after shutdown reach nobody.
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "event",
      id,
      event: { kind: "row", cursor: cursor(4n), row: { id: 4n, n: 4 } },
    });
    expect(second.map((event) => event.kind)).toEqual(["row", "gap"]);
  });

  test("equal-valued arguments keep the subscription; changed values replace it", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const config = harness.config();
    const onEvent = (): void => {};

    await render(root, app({ config, min: 1n, onEvent }));
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    expect(socket.framesOf("sub")).toHaveLength(1);
    const firstId = socket.framesOf("sub")[0]!.id;

    // A rerender rebuilding an equal-valued args object is not a new identity.
    await render(root, app({ config, min: 1n, onEvent }));
    expect(socket.framesOf("sub")).toHaveLength(1);
    expect(socket.framesOf("unsub")).toHaveLength(0);

    await render(root, app({ config, min: 2n, onEvent }));
    expect(socket.framesOf("unsub")).toEqual([{ v: PROTOCOL_VERSION, t: "unsub", id: firstId }]);
    const subs = socket.framesOf("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]).toMatchObject({ ref: "api.events.pings", args: { min: 2n } });
    expect(subs[1]!.id).not.toBe(firstId);

    await act(async () => {
      root.unmount();
    });
    // Shutdown released the second subscription through close(), not a frame.
    expect(socket.framesOf("unsub")).toHaveLength(1);
    expect(harness.open()).toHaveLength(0);
  });

  test("reconnect re-establishes the subscription and delivers one fresh reset boundary", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const events: AckerDBLiveEvent<PingRow>[] = [];

    await render(root, app({ config: harness.config(), min: 1n, onEvent: (event) => events.push(event) }));
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    const id = socket.framesOf("sub")[0]!.id;
    await act(async () => {
      socket.receive({ v: PROTOCOL_VERSION, t: "event", id, event: { kind: "reset", cursor: cursor(0n) } });
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event: { kind: "row", cursor: cursor(1n), row: { id: 1n, n: 1 } },
      });
    });

    // Connection loss delivers nothing by itself: no synthesized events.
    await act(async () => {
      socket.close();
    });
    expect(events.map((event) => event.kind)).toEqual(["reset", "row"]);

    await act(async () => {
      harness.clock.advance(100);
    });
    const next = harness.open()[0]!;
    expect(next).not.toBe(socket);
    await act(async () => {
      next.welcome("react-event-session");
    });
    // The client re-sends the same subscription without any cursor: it never
    // asks the server to replay missed transient events.
    expect(next.framesOf("sub")).toMatchObject([{ id, ref: "api.events.pings" }]);
    expect(next.framesOf("sub")[0]!.cursor).toBeUndefined();

    await act(async () => {
      next.receive({ v: PROTOCOL_VERSION, t: "event", id, event: { kind: "reset", cursor: cursor(0n, "g2") } });
      next.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event: { kind: "row", cursor: cursor(1n, "g2"), row: { id: 9n, n: 9 } },
      });
    });
    expect(events.map((event) => event.kind)).toEqual(["reset", "row", "reset", "row"]);
    expect(events[3]).toMatchObject({ kind: "row", row: { id: 9n, n: 9 } });

    await act(async () => {
      root.unmount();
    });
    expect(harness.clock.taskCount).toBe(0);
  });

  test("provider reconfiguration releases the old subscription exactly once", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const onEvent = (): void => {};

    await render(root, app({ config: harness.config(), min: 1n, onEvent }));
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    expect(socket.framesOf("sub")).toHaveLength(1);

    // Replacing the client lifetime: the old socket sees exactly one unsub
    // before its close, and the new lifetime carries exactly one subscription.
    await render(root, app({ config: harness.config({ url: "http://two.test" }), min: 1n, onEvent }));
    expect(socket.closed).toBe(true);
    expect(socket.framesOf("unsub")).toHaveLength(1);

    const next = harness.open()[0]!;
    await act(async () => {
      next.welcome("react-event-session");
    });
    expect(next.framesOf("sub")).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
    expect(next.framesOf("unsub")).toHaveLength(0);
    expect(harness.open()).toHaveLength(0);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("a client that cannot accept subscriptions reports the exact error as a value", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const events: AckerDBLiveEvent<PingRow>[] = [];
    const errors: AckerDBClientError[] = [];

    await render(
      root,
      app({
        config: harness.config({ limits: { maxPendingBytes: 1 } }),
        min: 1n,
        onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error),
      }),
    );
    expect(events).toHaveLength(0);
    expect(errors.map((error) => error.code)).toEqual(["overloaded"]);

    await act(async () => {
      root.unmount();
    });
    expect(harness.clock.taskCount).toBe(0);
  });

  test("reordered argument keys keep the canonical subscription identity", async () => {
    const scoped = { $ref: "api.events.scoped" } as EventRef<{ a: bigint; b: string }, PingRow>;
    function ScopedProbe({ args }: { readonly args: { a: bigint; b: string } }): ReactNode {
      useEvent(scoped, args, () => {});
      return null;
    }
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const view = (args: { a: bigint; b: string }): ReactNode => (
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <ScopedProbe args={args} />
        </AckerDBProvider>
      </StrictMode>
    );

    await render(root, view({ a: 1n, b: "x" }));
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    expect(socket.framesOf("sub")).toHaveLength(1);

    // Same values, different insertion order: still the same subscription.
    await render(root, view({ b: "x", a: 1n }));
    expect(socket.framesOf("sub")).toHaveLength(1);
    expect(socket.framesOf("unsub")).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  test("an argument change fences in-flight deliveries from the superseded subscription", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const first: AckerDBLiveEvent<PingRow>[] = [];
    const second: AckerDBLiveEvent<PingRow>[] = [];
    const tree = (
      min: bigint,
      sink: AckerDBLiveEvent<PingRow>[],
      fire: (() => void) | null,
    ): ReactNode => (
      <>
        <AckerDBProvider config={harness.config()}>
          <Probe min={min} onEvent={(event) => sink.push(event)} />
        </AckerDBProvider>
        <Injector fire={fire} />
      </>
    );

    await render(root, tree(1n, first, null));
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    const firstId = socket.framesOf("sub")[0]!.id;
    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id: firstId,
        event: { kind: "reset", cursor: cursor(0n) },
      });
    });
    expect(first.map((event) => event.kind)).toEqual(["reset"]);

    // Deliver from the superseded subscription mid-commit: the new arguments
    // are committed but the passive cleanup has not yet unsubscribed, and the
    // row must reach neither the old nor the new callback.
    let unsubsAtFire = -1;
    let secondAtFire = -1;
    await render(
      root,
      tree(2n, second, () => {
        unsubsAtFire = socket.framesOf("unsub").length;
        socket.receive({
          v: PROTOCOL_VERSION,
          t: "event",
          id: firstId,
          event: { kind: "row", cursor: cursor(1n), row: { id: 1n, n: 1 } },
        });
        secondAtFire = second.length;
      }),
    );
    expect(unsubsAtFire).toBe(0);
    expect(secondAtFire).toBe(0);
    expect(first.map((event) => event.kind)).toEqual(["reset"]);
    expect(second).toHaveLength(0);

    // The passive phase then swaps the subscription, which delivers normally.
    expect(socket.framesOf("unsub")).toEqual([{ v: PROTOCOL_VERSION, t: "unsub", id: firstId }]);
    const secondId = socket.framesOf("sub")[1]!.id;
    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id: secondId,
        event: { kind: "reset", cursor: cursor(0n, "g2") },
      });
    });
    expect(second.map((event) => event.kind)).toEqual(["reset"]);

    await act(async () => {
      root.unmount();
    });
  });

  test("deletion fences deliveries that beat the passive cleanup", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const events: AckerDBLiveEvent<PingRow>[] = [];
    const view = (mounted: boolean, fire: (() => void) | null): ReactNode => (
      <>
        {mounted ? (
          <AckerDBProvider config={harness.config()}>
            <Probe min={1n} onEvent={(event) => events.push(event)} />
          </AckerDBProvider>
        ) : null}
        <Injector fire={fire} />
      </>
    );

    await render(root, view(true, null));
    const socket = harness.open()[0]!;
    await act(async () => {
      socket.welcome("react-event-session");
    });
    const id = socket.framesOf("sub")[0]!.id;
    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event: { kind: "reset", cursor: cursor(0n) },
      });
    });
    expect(events.map((event) => event.kind)).toEqual(["reset"]);

    // Deleting the subtree runs the insertion cleanup in the mutation phase,
    // while the client (and its subscription) release later in the passive
    // phase: rows racing that window reach nobody.
    let liveAtFire = -1;
    let eventsAtFire = -1;
    await render(
      root,
      view(false, () => {
        liveAtFire = harness.open().length;
        socket.receive({
          v: PROTOCOL_VERSION,
          t: "event",
          id,
          event: { kind: "row", cursor: cursor(1n), row: { id: 1n, n: 1 } },
        });
        eventsAtFire = events.length;
      }),
    );
    expect(liveAtFire).toBe(1);
    expect(eventsAtFire).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(["reset"]);
    expect(harness.open()).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  test("useEvent outside a provider fails loudly", async () => {
    const root = createRoot(mountPoint());
    const { Boundary, caught } = createBoundary();

    await render(
      root,
      <Boundary>
        <Probe min={1n} onEvent={() => {}} />
      </Boundary>,
    );
    expect(String(caught())).toContain("useEvent requires a <AckerDBProvider> ancestor");
    await act(async () => {
      root.unmount();
    });
  });
});
