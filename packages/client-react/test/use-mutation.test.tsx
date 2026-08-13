import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { createHarness } from "./support/harness.ts";
import type { FakeSocket } from "ackerdb-test-support/client-transport";
import {
  ACKERDB_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import {
  AckerDBClientError,
  anyApi,
  type ClientResult,
  type MutationRef,
} from "@ackerdb/client";
import {
  Component,
  StrictMode,
  act,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, useConnectionState, useMutation } from "@ackerdb/client-react";
import { createBoundary } from "./support/boundary.tsx";

const SESSION = "react-mutation-session";
const APP = { url: "http://one.test", clientSessionId: SESSION };

type TodoArgs = { readonly text: string };
type SendTodo = (args: TodoArgs) => Promise<ClientResult<bigint>>;

function mustOk<Data>(result: ClientResult<Data>): Data {
  if (!result.ok) throw result.error;
  return result.data;
}

function mustErr<Data>(result: ClientResult<Data>): AckerDBClientError {
  if (result.ok) throw new Error("expected a failed Result");
  return result.error;
}

// A fresh proxy object per call, like generated api property access: the hook
// must key its identity on the reference address, not the object.
const todosAdd = (): MutationRef<TodoArgs, bigint> => anyApi.todos.add as MutationRef<TodoArgs, bigint>;

function mutationFrames(socket: FakeSocket): Extract<ClientMessage, { t: "m" }>[] {
  return socket.frames().flatMap((frame) => (frame.t === "m" ? [frame] : []));
}

function lastMutationFrame(socket: FakeSocket): Extract<ClientMessage, { t: "m" }> {
  const frame = mutationFrames(socket).at(-1);
  if (!frame) throw new Error("No mutation frame");
  return frame;
}

function mutationOk(
  frame: Extract<ClientMessage, { t: "m" }>,
  value: bigint,
  replay: "executed" | "replayed" = "executed",
): ServerMessage {
  return {
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

interface Probe {
  readonly callables: SendTodo[];
  Component(props: { readonly tick?: number; readonly refAddress?: string }): ReactNode;
  latest(): SendTodo;
}

function createProbe(): Probe {
  const callables: SendTodo[] = [];
  function Harnessed({ tick, refAddress }: { readonly tick?: number; readonly refAddress?: string }): ReactNode {
    const ref =
      refAddress === undefined
        ? todosAdd()
        : (anyApi[refAddress] as MutationRef<TodoArgs, bigint>);
    const send = useMutation(ref);
    const state = useConnectionState();
    callables.push(send);
    return (
      <span>
        {state.phase}:{tick ?? 0}
      </span>
    );
  }
  return {
    callables,
    Component: Harnessed,
    latest() {
      const callable = callables.at(-1);
      if (!callable) throw new Error("No captured callable");
      return callable;
    },
  };
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useMutation", () => {
  test("returns one callable per hook instance across renders, client arrival, and reconfiguration", async () => {
    const harness = createHarness(APP);
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    const app = (url: string, tick: number): ReactNode => (
      <AckerDBProvider config={harness.config({ url })}>
        <probe.Component tick={tick} />
      </AckerDBProvider>
    );

    await render(root, app("http://one.test", 0));
    await act(async () => {
      harness.sockets.at(-1)!.welcome(SESSION);
    });
    expect(container.textContent).toBe("ready:0");

    // Re-renders build a fresh reference proxy object for the same address
    // every time; the callable never changes.
    await render(root, app("http://one.test", 1));
    await render(root, app("http://one.test", 2));
    expect(container.textContent).toBe("ready:2");

    // A reconfigured provider replaces the client but not the callable.
    await render(root, app("http://two.test", 3));
    await act(async () => {
      harness.sockets.at(-1)!.welcome(SESSION);
    });
    expect(container.textContent).toBe("ready:3");

    // Every render handed out the identical callable: the first committed
    // render before any client existed, arrival, and the reconfiguration.
    expect(new Set(probe.callables).size).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  test("a changed reference address redirects the same callable to the new target", async () => {
    const harness = createHarness(APP);
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    const app = (refAddress: string): ReactNode => (
      <AckerDBProvider config={harness.config()}>
        <probe.Component refAddress={refAddress} />
      </AckerDBProvider>
    );

    await render(root, app("addTodo"));
    await act(async () => {
      harness.sockets.at(-1)!.welcome(SESSION);
    });
    const send = probe.latest();
    void send({ text: "x" }).catch(() => {});
    expect(lastMutationFrame(harness.sockets.at(-1)!).ref).toBe("api.addTodo");

    // The callable's identity belongs to the hook instance, not the
    // reference; the commit-phase ref sync redirects it to the new address.
    await render(root, app("removeTodo"));
    expect(probe.latest()).toBe(send);
    void send({ text: "x" }).catch(() => {});
    expect(lastMutationFrame(harness.sockets.at(-1)!).ref).toBe("api.removeTodo");

    await act(async () => {
      root.unmount();
    });
  });

  test("resolves determinate success with the exact server value", async () => {
    const harness = createHarness(APP);
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <probe.Component />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const result = probe.latest()({ text: "milk" });
    const frame = lastMutationFrame(socket);
    expect(frame.ref).toBe("api.todos.add");
    expect(frame.args).toEqual({ text: "milk" });
    expect(frame.mutationRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    socket.receive(mutationOk(frame, 41n));
    expect(mustOk(await result)).toBe(41n);

    await act(async () => {
      root.unmount();
    });
  });

  test("passes determinate failures and connection errors through as exact AckerDBClientError values", async () => {
    const harness = createHarness(APP);
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <probe.Component />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    // Determinate failure: the server's exact outcome is the rejection.
    const failed = probe.latest()({ text: "rejected" });
    socket.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: lastMutationFrame(socket).id,
      outcome: {
        code: "validation",
        retryable: false,
        message: "text is not allowed",
        resource: "operation",
      },
    });
    const failure = mustErr(await failed);
    expect(failure).toBeInstanceOf(AckerDBClientError);
    expect(failure).toMatchObject({
      code: "validation",
      retryable: false,
      message: "text is not allowed",
      resource: "operation",
    });
    if (!(failure instanceof AckerDBClientError)) throw new Error("expected AckerDBClientError");
    expect(Object.isFrozen(failure.outcome)).toBe(true);

    // Connection-level authentication failure settles the pending mutation
    // with the same distinguishable error the base client reports.
    const blocked = probe.latest()({ text: "blocked" });
    await act(async () => {
      socket.receive({
        v: ACKERDB_VERSION,
        t: "err",
        id: null,
        outcome: {
          code: "unauthenticated",
          retryable: false,
          message: "credential expired",
          resource: "connection",
        },
      });
    });
    expect(mustErr(await blocked)).toMatchObject({
      code: "unauthenticated",
      message: "credential expired",
    });
    expect(container.textContent).toBe("authentication-blocked:0");

    await act(async () => {
      root.unmount();
    });
  });

  test("an interrupted mutation replays across reconnect with its original identifier", async () => {
    const harness = createHarness(APP);
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <probe.Component />
      </AckerDBProvider>,
    );
    const first = harness.sockets.at(-1)!;
    await act(async () => {
      first.welcome(SESSION);
    });

    let settlements = 0;
    const result = probe.latest()({ text: "lost-ack" }).then((value) => {
      settlements++;
      return value;
    });
    const lost = lastMutationFrame(first);

    // Sever after the request was written: the response never arrives.
    await act(async () => {
      first.close();
    });
    expect(container.textContent).toBe("reconnecting:0");
    await act(async () => {
      harness.clock.advance(100);
    });
    const second = harness.sockets.at(-1)!;
    expect(second).not.toBe(first);
    await act(async () => {
      second.welcome(SESSION);
    });

    const resent = lastMutationFrame(second);
    expect(resent.mutationRequestId).toBe(lost.mutationRequestId);
    expect(resent.issuedAt).toBe(lost.issuedAt);
    // Settling the promise causes no React state change, so no act() boundary.
    second.receive(mutationOk(resent, 43n, "replayed"));
    expect(mustOk(await result)).toBe(43n);
    await Promise.resolve();
    expect(settlements).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  test("preserves the indeterminate outcome when a sent mutation outlives its retention", async () => {
    const harness = createHarness({ ...APP, limits: { maxMutationAgeMs: 10 } });
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <probe.Component />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const unknown = probe.latest()({ text: "unknown" });
    harness.clock.advance(10);
    expect(mustErr(await unknown)).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
      message: "mutation completion is unknown",
    });

    await act(async () => {
      root.unmount();
    });
  });

  test("provider unmount settles sent mutations as indeterminate and unsent ones as unavailable", async () => {
    const harness = createHarness(APP);
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <probe.Component />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    // Sent: the server may have committed, so shutdown cannot claim failure.
    const sent = probe.latest()({ text: "sent" });
    expect(lastMutationFrame(socket).args).toEqual({ text: "sent" });

    // Unsent: created while disconnected, so shutdown is a determinate local error.
    await act(async () => {
      socket.close();
    });
    const unsent = probe.latest()({ text: "unsent" });

    await act(async () => {
      root.unmount();
    });
    expect(mustErr(await sent)).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
      message: "mutation completion is unknown",
    });
    expect(mustErr(await unsent)).toMatchObject({
      code: "unavailable",
      resource: "operation",
      message: "client closed",
    });
  });

  test("a mount-effect call issued before the client exists dispatches exactly once on arrival", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    let result: Promise<ClientResult<bigint>> | null = null;
    function SendOnMount(): ReactNode {
      const send = useMutation(todosAdd());
      useEffect(() => {
        // Runs before the provider's effect constructs the client (child
        // effects precede their ancestors'): the call waits in the hook's
        // queue instead of rejecting.
        result = send({ text: "early" });
      }, [send]);
      return null;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <SendOnMount />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const frames = mutationFrames(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toEqual({ text: "early" });
    socket.receive(mutationOk(frames[0]!, 7n));
    expect(mustOk(await result!)).toBe(7n);

    await act(async () => {
      root.unmount();
    });
  });

  test("a queued call transmits its call-time argument values, not later mutations", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    let result: Promise<ClientResult<bigint>> | null = null;
    function SendOnMount(): ReactNode {
      const send = useMutation(todosAdd());
      useEffect(() => {
        // The base client encodes arguments synchronously at call time; the
        // queue must freeze the same wire value, so mutating the argument
        // object while the call waits changes nothing.
        const args = { text: "call-time" };
        result = send(args);
        args.text = "mutated-while-queued";
      }, [send]);
      return null;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <SendOnMount />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const frames = mutationFrames(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toEqual({ text: "call-time" });
    socket.receive(mutationOk(frames[0]!, 9n));
    expect(mustOk(await result!)).toBe(9n);

    await act(async () => {
      root.unmount();
    });
  });

  test("a queued dispatch that throws synchronously rejects its own calls and spares the rest", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    // A runtime-malformed reference: the client's getRef throws synchronously
    // at dispatch, before any request exists.
    const malformed = { $ref: "" } as unknown as MutationRef<TodoArgs, bigint>;
    let poisonedFirst: Promise<unknown> | null = null;
    let poisonedSecond: Promise<unknown> | null = null;
    let result: Promise<ClientResult<bigint>> | null = null;
    function SendOnMount(): ReactNode {
      const poison = useMutation(malformed);
      const send = useMutation(todosAdd());
      useEffect(() => {
        poisonedFirst = poison({ text: "poison-1" });
        poisonedSecond = poison({ text: "poison-2" });
        result = send({ text: "fine" });
      }, [poison, send]);
      return null;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <SendOnMount />
      </AckerDBProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    // Both malformed dispatches rejected their own calls, both from the same
    // drained queue...
    expect(String(mustErr(await poisonedFirst! as ClientResult<unknown>))).toContain(
      "not a ackerdb function reference",
    );
    expect(String(mustErr(await poisonedSecond! as ClientResult<unknown>))).toContain(
      "not a ackerdb function reference",
    );
    // ...and the healthy queued call still dispatched and resolves.
    const frames = mutationFrames(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toEqual({ text: "fine" });
    socket.receive(mutationOk(frames[0]!, 5n));
    expect(mustOk(await result!)).toBe(5n);

    await act(async () => {
      root.unmount();
    });
  });

  test("unmount before the client arrives settles a queued call with the typed discard", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    let settlement: Promise<unknown> | null = null;
    function SendAndVanish({ vanish }: { readonly vanish: () => void }): ReactNode {
      const send = useMutation(todosAdd());
      useLayoutEffect(() => {
        // Queue a call and unmount within the same commit: the layout-phase
        // state update below deletes this component before the provider's
        // passive effect can construct a client, so the hook's lifetime end
        // is the only owner left to settle the call.
        settlement = send({ text: "never" });
        vanish();
      }, [send, vanish]);
      return null;
    }
    function Gate(): ReactNode {
      const [mounted, setMounted] = useState(true);
      const vanish = useCallback(() => setMounted(false), []);
      return mounted ? <SendAndVanish vanish={vanish} /> : null;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Gate />
      </AckerDBProvider>,
    );
    const failure = mustErr(await settlement! as ClientResult<unknown>);
    expect(failure).toBeInstanceOf(AckerDBClientError);
    expect(failure).toMatchObject({
      code: "unavailable",
      retryable: false,
      resource: "operation",
      message: "client closed",
    });

    // The discarded call never dispatches: even once the provider's client
    // connects, no mutation frame exists.
    await act(async () => {
      harness.sockets.at(-1)!.welcome(SESSION);
    });
    expect(harness.sockets.flatMap((socket) => mutationFrames(socket))).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  test("Strict Mode mount-effect calls each dispatch exactly once through the surviving lifetime", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const results: Array<Promise<ClientResult<bigint>>> = [];
    function SendOnMount(): ReactNode {
      const send = useMutation(todosAdd());
      useEffect(() => {
        // Strict Mode runs this mount effect twice; both calls queue before
        // any client exists, wait through the simulated remount (which closes
        // the first client), and dispatch once each on the surviving one.
        results.push(send({ text: "early" }));
      }, [send]);
      return null;
    }

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <SendOnMount />
        </AckerDBProvider>
      </StrictMode>,
    );
    // Strict Mode's simulated remount constructed and closed a first client.
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[0]!.closed).toBe(true);
    const survivor = harness.sockets.at(-1)!;
    await act(async () => {
      survivor.welcome(SESSION);
    });

    // Exactly two dispatches — one per effect invocation — and every one
    // through the surviving client; the retired one sent nothing.
    expect(results).toHaveLength(2);
    expect(mutationFrames(harness.sockets[0]!)).toHaveLength(0);
    const frames = mutationFrames(survivor);
    expect(frames).toHaveLength(2);
    for (const [index, frame] of frames.entries()) {
      survivor.receive(mutationOk(frame, BigInt(index + 1)));
    }
    expect((await Promise.all(results)).map(mustOk)).toEqual([1n, 2n]);

    await act(async () => {
      root.unmount();
    });
  });

  test("useMutation outside a provider fails loudly", async () => {
    const container = mountPoint();
    const root = createRoot(container);
    const { Boundary, caught } = createBoundary();

    function Naked(): ReactNode {
      useMutation(todosAdd());
      return null;
    }

    await render(
      root,
      <Boundary>
        <Naked />
      </Boundary>,
    );
    expect(container.textContent).toBe("failed");
    expect(String(caught())).toContain("useMutation requires a <AckerDBProvider> ancestor");
    await act(async () => {
      root.unmount();
    });
  });
});
