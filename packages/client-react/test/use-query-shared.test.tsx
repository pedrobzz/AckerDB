import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import { createHarness, type ProviderHarness } from "./support/harness.ts";
import {
  PROTOCOL_VERSION,
  stableEncode,
  type ServerMessage,
  type SubscriptionCursor,
} from "@ackerdb/core";
import { AckerDBClient, type QueryRef } from "@ackerdb/client";
import { StrictMode, act, startTransition, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, skip, useQuery, type AckerDBQueryState } from "@ackerdb/client-react";
import { queryRegistryFor } from "../src/query-store.ts";

const SESSION = "use-query-shared-session";
const APP = { url: "http://use-query-shared.test", clientSessionId: SESSION };

type TodoArgs = { readonly list: bigint };
const todos = { $ref: "todos.list" } as QueryRef<TodoArgs, string[]>;

function cursor(commitVersion: bigint): SubscriptionCursor {
  return {
    generation: "generation-1",
    commitVersion,
    authEpoch: 0,
    identity: "todos.list:{list:1}",
  };
}

const observed = new Map<string, AckerDBQueryState<string[]>>();

function describeState(state: AckerDBQueryState<string[]>): string {
  switch (state.status) {
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    case "success":
      return `fresh:${state.data.join(",")}`;
    case "rejected":
      return `error:${state.error.code}:-`;
    case "unavailable":
      return state.data === undefined
        ? `error:${state.error.code}:-`
        : `stale:${state.data.join(",")}`;
  }
}

function Probe({ id, args }: { id: string; args: TodoArgs | typeof skip }): ReactNode {
  const state = useQuery(todos, args);
  observed.set(id, state);
  return (
    <span>
      {id}={describeState(state)};
    </span>
  );
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

interface ProbeSpec {
  readonly id: string;
  readonly args: TodoArgs | typeof skip;
}

function app(harness: ProviderHarness, probes: ProbeSpec[], strict = false): ReactNode {
  const tree = (
    <AckerDBProvider config={harness.config()}>
      {probes.map((probe) => (
        <Probe key={probe.id} id={probe.id} args={probe.args} />
      ))}
    </AckerDBProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

async function receive(harness: ProviderHarness, frame: ServerMessage): Promise<void> {
  await act(async () => {
    harness.live().receive(frame);
  });
}

async function ready(harness: ProviderHarness): Promise<void> {
  await act(async () => {
    harness.live().welcome(SESSION);
  });
}

/** The identical committed snapshot object every listed probe observed. */
function sharedSnapshot(ids: string[]): AckerDBQueryState<string[]> {
  const states = ids.map((id) => {
    const state = observed.get(id);
    if (!state) throw new Error(`probe ${id} never rendered`);
    return state;
  });
  for (const state of states) expect(state).toBe(states[0]!);
  return states[0]!;
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));
beforeEach(() => observed.clear());

describe("shared query registry", () => {
  test("two consumers with identical inputs share one subscription and one snapshot object", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    // Distinct argument object literals; canonical encoding makes them one key.
    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 1n } },
      ]),
    );
    await ready(harness);
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(1);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("a=fresh:one;b=fresh:one;");
    // Both consumers committed the same frozen snapshot, not equal copies.
    const snapshot = sharedSnapshot(["a", "b"]);
    expect(snapshot).toMatchObject({ status: "success", stale: false });

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("a=fresh:one,two;b=fresh:one,two;");
    sharedSnapshot(["a", "b"]);
    await render(root, <></>);
  });

  test("canonical keys ignore property order but structurally similar values never collide", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    type PairArgs = { readonly a: bigint; readonly b: string };
    const pairs = { $ref: "todos.pairs" } as QueryRef<PairArgs, string[]>;
    const similar = { $ref: "todos.similar" } as QueryRef<Record<string, unknown>, string[]>;

    function Pairs({ args }: { args: PairArgs }): ReactNode {
      const state = useQuery(pairs, args);
      return <span>{describeState(state)};</span>;
    }
    function Similar({ args }: { args: Record<string, unknown> }): ReactNode {
      useQuery(similar, args);
      return null;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        {/* Same values, opposite key insertion order: one shared key. */}
        <Pairs args={{ a: 1n, b: "x" }} />
        <Pairs args={{ b: "x", a: 1n }} />
        {/* Structurally similar but distinct values: all separate keys. */}
        <Similar args={{ list: 1n }} />
        <Similar args={{ list: 1 }} />
        <Similar args={{ list: "1" }} />
        <Similar args={{ list: [1] }} />
      </AckerDBProvider>,
    );
    await ready(harness);
    const subs = harness.frames("sub");
    expect(subs.filter((frame) => frame.ref === "todos.pairs")).toHaveLength(1);
    const similarSubs = subs.filter((frame) => frame.ref === "todos.similar");
    expect(similarSubs).toHaveLength(4);
    expect(new Set(similarSubs.map((frame) => stableEncode(frame.args))).size).toBe(4);
    await render(root, <></>);
  });

  test("different addresses with identical arguments never collide", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());
    const first = { $ref: "todos.list" } as QueryRef<TodoArgs, string[]>;
    const second = { $ref: "todos.listArchived" } as QueryRef<TodoArgs, string[]>;

    function Pair(): ReactNode {
      useQuery(first, { list: 1n });
      useQuery(second, { list: 1n });
      return null;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Pair />
      </AckerDBProvider>,
    );
    await ready(harness);
    const subs = harness.frames("sub");
    expect(subs.map((frame) => frame.ref).sort()).toEqual(["todos.list", "todos.listArchived"]);
    await render(root, <></>);
  });

  test("changing one consumer's arguments splits the entry with exact release counts", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 1n } },
      ]),
    );
    await ready(harness);
    const firstId = harness.frames("sub")[0]!.id;

    // b moves to its own arguments: a second subscription starts and the
    // first stays alive for a — nothing is released.
    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 2n } },
      ]),
    );
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args).toEqual({ list: 2n });
    expect(harness.frames("unsub")).toHaveLength(0);
    const secondId = subs[1]!.id;

    // Each entry now has exactly one listener; unmounting releases exactly
    // its own subscription.
    await render(root, app(harness, [{ id: "b", args: { list: 2n } }]));
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([firstId]);
    await render(root, app(harness, []));
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([firstId, secondId]);
    await render(root, <></>);
  });

  test("release counts stay exact when listeners leave in the opposite order", async () => {
    const harness = createHarness(APP);
    const root = createRoot(mountPoint());

    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 1n } },
      ]),
    );
    await ready(harness);
    const firstId = harness.frames("sub")[0]!.id;
    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 2n } },
      ]),
    );
    const secondId = harness.frames("sub")[1]!.id;

    // Opposite order to the sibling test: the changed consumer leaves first.
    await render(root, app(harness, [{ id: "a", args: { list: 1n } }]));
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([secondId]);
    await render(root, app(harness, []));
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([secondId, firstId]);
    await render(root, <></>);
  });

  test("losing one of several listeners keeps the query alive; the last release evicts, and a re-subscribe starts clean", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 1n } },
      ]),
    );
    await ready(harness);
    const firstId = harness.frames("sub")[0]!.id;
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: firstId,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });

    // a skips (one release path), b stays: the subscription survives and
    // updates keep flowing to the remaining listener.
    await render(
      root,
      app(harness, [
        { id: "a", args: skip },
        { id: "b", args: { list: 1n } },
      ]),
    );
    expect(harness.frames("unsub")).toHaveLength(0);
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: firstId,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("a=disabled;b=fresh:one,two;");

    // The last listener leaving releases the subscription and the entry.
    await render(root, app(harness, [{ id: "a", args: skip }]));
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([firstId]);

    // Re-subscribing starts one clean lifetime: a new id, no resume cursor,
    // and pending state rather than adopted rows from the released entry.
    await render(root, app(harness, [{ id: "c", args: { list: 1n } }]));
    expect(container.textContent).toBe("c=pending;");
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.id).not.toBe(firstId);
    expect(subs[1]!.cursor).toBeUndefined();
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(3n), value: ["three"] },
    });
    expect(container.textContent).toBe("c=fresh:three;");
    await render(root, <></>);
  });

  test("Strict Mode mounting of shared consumers leaves one live subscription and one release", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      app(
        harness,
        [
          { id: "a", args: { list: 1n } },
          { id: "b", args: { list: 1n } },
        ],
        true,
      ),
    );
    await ready(harness);
    // Strict Mode ran every consumer's subscribe/cleanup/subscribe cycle
    // before the socket was ready; only the surviving shared entry's
    // subscription was ever sent.
    const live = harness.live();
    expect(live.framesOf("sub")).toHaveLength(1);
    expect(live.framesOf("unsub")).toHaveLength(0);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: live.framesOf("sub")[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("a=fresh:one;b=fresh:one;");
    sharedSnapshot(["a", "b"]);

    await render(root, app(harness, [], true));
    expect(live.framesOf("unsub")).toHaveLength(1);
    await render(root, <></>);
  });

  test("Strict Mode mounting a sole consumer on a ready client never releases the query", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    // The socket is live before the consumer exists, so any zero-listener
    // release would reach the wire immediately.
    await render(root, app(harness, [], true));
    await ready(harness);

    // Strict Mode replays the sole consumer's subscribe/cleanup/subscribe
    // against the ready client; the deferred release bridges the replay, so
    // the wire sees one subscription and no churn.
    await render(root, app(harness, [{ id: "a", args: { list: 1n } }], true));
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(1);
    expect(harness.frames("unsub")).toHaveLength(0);

    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("a=fresh:one;");
    await render(root, <></>);
  });

  test("replacing the sole consumer in one commit hands the live entry over without regression", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, [{ id: "a", args: { list: 1n } }]));
    await ready(harness);
    const id = harness.frames("sub")[0]!.id;
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("a=fresh:one;");
    const before = observed.get("a")!;

    // a unmounts and b mounts in the same commit: b adopts the live entry
    // and its authoritative snapshot with no unsubscribe, no new
    // subscription, and no success-to-pending regression.
    await render(root, app(harness, [{ id: "b", args: { list: 1n } }]));
    expect(container.textContent).toBe("b=fresh:one;");
    expect(observed.get("b")!).toBe(before);
    expect(harness.frames("sub")).toHaveLength(1);
    expect(harness.frames("unsub")).toHaveLength(0);

    // Updates keep flowing to the adopting consumer.
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("b=fresh:one,two;");
    await render(root, <></>);
  });

  test("Strict Mode mounting a consumer into a live shared entry neither closes nor duplicates it", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, [{ id: "a", args: { list: 1n } }], true));
    await ready(harness);
    const id = harness.frames("sub")[0]!.id;
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });

    // The new consumer's Strict Mode subscribe/cleanup/subscribe runs against
    // an entry another listener holds live: no churn reaches the wire and the
    // shared rows render immediately.
    await render(
      root,
      app(
        harness,
        [
          { id: "a", args: { list: 1n } },
          { id: "b", args: { list: 1n } },
        ],
        true,
      ),
    );
    expect(container.textContent).toBe("a=fresh:one;b=fresh:one;");
    sharedSnapshot(["a", "b"]);
    expect(harness.frames("sub")).toHaveLength(1);
    expect(harness.frames("unsub")).toHaveLength(0);
    await render(root, <></>);
  });

  test("transition-driven argument churn tears nothing and settles with exact live entries", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      app(harness, [
        { id: "a", args: { list: 1n } },
        { id: "b", args: { list: 1n } },
      ]),
    );
    await ready(harness);
    const firstId = harness.frames("sub")[0]!.id;
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: firstId,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });

    // b's arguments flip between the shared key and its own inside
    // transitions, with deliveries interleaved between commits.
    for (let round = 0; round < 3; round++) {
      await act(async () => {
        startTransition(() => {
          root.render(
            app(harness, [
              { id: "a", args: { list: 1n } },
              { id: "b", args: { list: 2n } },
            ]),
          );
        });
      });
      await receive(harness, {
        v: PROTOCOL_VERSION,
        t: "transition",
        id: firstId,
        transition: {
          kind: "reset",
          from: null,
          to: cursor(BigInt(10 + round)),
          value: [`round-${round}`],
        },
      });
      await act(async () => {
        startTransition(() => {
          root.render(
            app(harness, [
              { id: "a", args: { list: 1n } },
              { id: "b", args: { list: 1n } },
            ]),
          );
        });
      });
      // Back on the shared key, both consumers observe the identical
      // committed snapshot: no torn or stale-per-consumer copies.
      expect(container.textContent).toBe(`a=fresh:round-${round};b=fresh:round-${round};`);
      sharedSnapshot(["a", "b"]);
    }

    // Every list:2 excursion released its entry on return; the shared entry
    // never dropped below one listener, so it was never released.
    const unsubs = harness.frames("unsub");
    expect(unsubs).toHaveLength(3);
    expect(unsubs.map((frame) => frame.id)).not.toContain(firstId);
    expect(harness.frames("sub")).toHaveLength(4);

    // Unmounting the consumers (provider still up) finally releases the
    // shared entry, exactly once.
    await render(root, app(harness, []));
    expect(harness.frames("unsub")).toHaveLength(4);
    expect(harness.frames("unsub").map((frame) => frame.id)).toContain(firstId);
    await render(root, <></>);
  });

  test("provider reconfiguration gives the new client a fresh registry", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, [{ id: "a", args: { list: 1n } }]));
    await ready(harness);
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: harness.frames("sub")[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("a=fresh:one;");
    const firstSocket = harness.live();

    // A different configuration replaces the client; the consumer re-enters
    // pending against a brand-new registry entry instead of adopting the
    // previous lifetime's rows.
    const reconfigured: ProviderHarness = {
      ...harness,
      config: () => ({ ...harness.config(), url: "http://use-query-shared-b.test" }),
    };
    await render(root, app(reconfigured, [{ id: "a", args: { list: 1n } }]));
    expect(firstSocket.closed).toBe(true);
    expect(container.textContent).toBe("a=pending;");
    await ready(harness);
    const second = harness.live();
    const subs = second.framesOf("sub");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cursor).toBeUndefined();
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["two"] },
    });
    expect(container.textContent).toBe("a=fresh:two;");
    await render(root, <></>);
  });

  // Registry-level contracts that need no rendered tree: render-only reads
  // must be inert, and clients must never share entries.
  test("reading a source snapshot registers nothing; only a committed listener subscribes", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    harness.live().welcome(SESSION);
    const registry = queryRegistryFor(client);
    const argsKey = stableEncode({ list: 1n });
    const source = registry.source<string[]>("todos.list", argsKey, { list: 1n });

    // A discarded React render reads the snapshot and never commits: no
    // subscription may start and no entry may be registered.
    expect(source.snapshot()).toMatchObject({ status: "pending" });
    expect(source.snapshot()).toBe(source.snapshot());
    expect(harness.frames("sub")).toHaveLength(0);

    // Two independently created sources for the same key share one entry.
    const sibling = registry.source<string[]>("todos.list", argsKey, { list: 1n });
    const stopSource = source.listen(() => {});
    const stopSibling = sibling.listen(() => {});
    expect(harness.frames("sub")).toHaveLength(1);
    const id = harness.frames("sub")[0]!.id;
    harness.live().receive({
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(source.snapshot()).toBe(sibling.snapshot());

    stopSource();
    expect(harness.frames("unsub")).toHaveLength(0);
    stopSibling();
    // The last release is deferred one microtask to bridge same-pass
    // listener handoffs; once it runs the subscription and entry are gone.
    await Bun.sleep(0);
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([id]);
    expect(source.snapshot()).toMatchObject({ status: "pending" });
    // A new listener after the release starts a clean subscription.
    const stopAgain = source.listen(() => {});
    expect(harness.frames("sub")).toHaveLength(2);
    expect(harness.frames("sub")[1]!.cursor).toBeUndefined();
    stopAgain();
    client.close();
  });

  test("a listener returning within the release window continues the live subscription", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    harness.live().welcome(SESSION);
    const registry = queryRegistryFor(client);
    const argsKey = stableEncode({ list: 1n });
    const source = registry.source<string[]>("todos.list", argsKey, { list: 1n });

    const stopFirst = source.listen(() => {});
    const id = harness.frames("sub")[0]!.id;
    harness.live().receive({
      v: PROTOCOL_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    const delivered = source.snapshot();

    // Cleanup-then-setup in one synchronous pass, exactly as React replays
    // effects: the entry, its subscription, and its authoritative snapshot
    // survive the zero-listener instant untouched.
    stopFirst();
    const stopSecond = source.listen(() => {});
    await Bun.sleep(0);
    expect(harness.frames("sub")).toHaveLength(1);
    expect(harness.frames("unsub")).toHaveLength(0);
    expect(source.snapshot()).toBe(delivered);

    stopSecond();
    await Bun.sleep(0);
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([id]);
    client.close();
  });

  test("identical keys on different clients stay in different registries", async () => {
    const first = createHarness(APP);
    const second = createHarness(APP);
    const clientA = new AckerDBClient(first.config());
    const clientB = new AckerDBClient(second.config());
    first.live().welcome(SESSION);
    second.live().welcome(SESSION);
    const argsKey = stableEncode({ list: 1n });

    const stopA = queryRegistryFor(clientA)
      .source<string[]>("todos.list", argsKey, { list: 1n })
      .listen(() => {});
    const stopB = queryRegistryFor(clientB)
      .source<string[]>("todos.list", argsKey, { list: 1n })
      .listen(() => {});
    // One subscription per client: sharing never crosses a client lifetime.
    expect(first.frames("sub")).toHaveLength(1);
    expect(second.frames("sub")).toHaveLength(1);

    stopA();
    stopB();
    clientA.close();
    clientB.close();
  });
});
