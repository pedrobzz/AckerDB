import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@dbzz/core";
import {
  DbzzClientError,
  anyApi,
  type DbzzClientClock,
  type DbzzClientLimits,
  type DbzzWebSocket,
  type MutationRef,
} from "@dbzz/client";
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
import { DbzzProvider, useConnectionState, useMutation, type DbzzProviderConfig } from "@dbzz/client-react";

interface ClockTask {
  at: number;
  callback: () => void;
  intervalMs?: number;
}

class ManualClock implements DbzzClientClock {
  private nextId = 0;
  private readonly tasks = new Map<number, ClockTask>();
  private time = 1_700_000_000_000;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback, intervalMs: delayMs });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, ClockTask] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.intervalMs === undefined) this.tasks.delete(id);
      else task.at += task.intervalMs;
      task.callback();
    }
    this.time = target;
  }
}

class FakeSocket implements DbzzWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    parseClientMessage(decode(data));
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  welcome(clientSessionId: string): void {
    this.onopen?.();
    this.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId,
      authEpoch: 0,
      principal: "anonymous",
    });
  }

  receive(frame: ServerMessage): void {
    this.onmessage?.({ data: encode(frame) });
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => parseClientMessage(decode(text)));
  }
}

const SESSION = "react-mutation-session";

interface Harness {
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  config(url?: string): DbzzProviderConfig;
}

function createHarness(limits?: Partial<DbzzClientLimits>): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  return {
    clock,
    sockets,
    config(url = "http://one.test") {
      return {
        url,
        credential: { kind: "anonymous" },
        clientSessionId: SESSION,
        limits,
        clock,
        random: () => 0,
        createWebSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      };
    },
  };
}

type TodoArgs = { readonly text: string };
type SendTodo = (args: TodoArgs) => Promise<bigint>;

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
    const harness = createHarness();
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    const app = (url: string, tick: number): ReactNode => (
      <DbzzProvider config={harness.config(url)}>
        <probe.Component tick={tick} />
      </DbzzProvider>
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
    const harness = createHarness();
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    const app = (refAddress: string): ReactNode => (
      <DbzzProvider config={harness.config()}>
        <probe.Component refAddress={refAddress} />
      </DbzzProvider>
    );

    await render(root, app("addTodo"));
    await act(async () => {
      harness.sockets.at(-1)!.welcome(SESSION);
    });
    const send = probe.latest();
    void send({ text: "x" }).catch(() => {});
    expect(lastMutationFrame(harness.sockets.at(-1)!).ref).toBe("addTodo");

    // The callable's identity belongs to the hook instance, not the
    // reference; the commit-phase ref sync redirects it to the new address.
    await render(root, app("removeTodo"));
    expect(probe.latest()).toBe(send);
    void send({ text: "x" }).catch(() => {});
    expect(lastMutationFrame(harness.sockets.at(-1)!).ref).toBe("removeTodo");

    await act(async () => {
      root.unmount();
    });
  });

  test("resolves determinate success with the exact server value", async () => {
    const harness = createHarness();
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <DbzzProvider config={harness.config()}>
        <probe.Component />
      </DbzzProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const result = probe.latest()({ text: "milk" });
    const frame = lastMutationFrame(socket);
    expect(frame.ref).toBe("todos.add");
    expect(frame.args).toEqual({ text: "milk" });
    expect(frame.mutationRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    socket.receive(mutationOk(frame, 41n));
    expect(await result).toBe(41n);

    await act(async () => {
      root.unmount();
    });
  });

  test("passes determinate failures and connection errors through as exact DbzzClientError values", async () => {
    const harness = createHarness();
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <DbzzProvider config={harness.config()}>
        <probe.Component />
      </DbzzProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    // Determinate failure: the server's exact outcome is the rejection.
    const failed = probe.latest()({ text: "rejected" }).catch((error) => error);
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: lastMutationFrame(socket).id,
      outcome: {
        code: "validation",
        retryable: false,
        message: "text is not allowed",
        resource: "operation",
      },
    });
    const failure = await failed;
    expect(failure).toBeInstanceOf(DbzzClientError);
    expect(failure).toMatchObject({
      code: "validation",
      retryable: false,
      message: "text is not allowed",
      resource: "operation",
    });
    if (!(failure instanceof DbzzClientError)) throw new Error("expected DbzzClientError");
    expect(Object.isFrozen(failure.outcome)).toBe(true);

    // Connection-level authentication failure settles the pending mutation
    // with the same distinguishable error the base client reports.
    const blocked = probe.latest()({ text: "blocked" }).catch((error) => error);
    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
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
    expect(await blocked).toMatchObject({ code: "unauthenticated", message: "credential expired" });
    expect(container.textContent).toBe("authentication-blocked:0");

    await act(async () => {
      root.unmount();
    });
  });

  test("an interrupted mutation replays across reconnect with its original identifier", async () => {
    const harness = createHarness();
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <DbzzProvider config={harness.config()}>
        <probe.Component />
      </DbzzProvider>,
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
    expect(await result).toBe(43n);
    await Promise.resolve();
    expect(settlements).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  test("preserves the indeterminate outcome when a sent mutation outlives its retention", async () => {
    const harness = createHarness({ maxMutationAgeMs: 10 });
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <DbzzProvider config={harness.config()}>
        <probe.Component />
      </DbzzProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const unknown = probe.latest()({ text: "unknown" }).catch((error) => error);
    harness.clock.advance(10);
    expect(await unknown).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
      message: "mutation completion is unknown",
    });

    await act(async () => {
      root.unmount();
    });
  });

  test("provider unmount settles sent mutations as indeterminate and unsent ones as unavailable", async () => {
    const harness = createHarness();
    const probe = createProbe();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <DbzzProvider config={harness.config()}>
        <probe.Component />
      </DbzzProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    // Sent: the server may have committed, so shutdown cannot claim failure.
    const sent = probe.latest()({ text: "sent" }).catch((error) => error);
    expect(lastMutationFrame(socket).args).toEqual({ text: "sent" });

    // Unsent: created while disconnected, so shutdown is a determinate local error.
    await act(async () => {
      socket.close();
    });
    const unsent = probe.latest()({ text: "unsent" }).catch((error) => error);

    await act(async () => {
      root.unmount();
    });
    expect(await sent).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
      message: "mutation completion is unknown",
    });
    expect(await unsent).toMatchObject({
      code: "unavailable",
      resource: "operation",
      message: "client closed",
    });
  });

  test("a mount-effect call issued before the client exists dispatches exactly once on arrival", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    let result: Promise<bigint> | null = null;
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
      <DbzzProvider config={harness.config()}>
        <SendOnMount />
      </DbzzProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const frames = mutationFrames(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toEqual({ text: "early" });
    socket.receive(mutationOk(frames[0]!, 7n));
    expect(await result!).toBe(7n);

    await act(async () => {
      root.unmount();
    });
  });

  test("a queued call transmits its call-time argument values, not later mutations", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    let result: Promise<bigint> | null = null;
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
      <DbzzProvider config={harness.config()}>
        <SendOnMount />
      </DbzzProvider>,
    );
    const socket = harness.sockets.at(-1)!;
    await act(async () => {
      socket.welcome(SESSION);
    });

    const frames = mutationFrames(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toEqual({ text: "call-time" });
    socket.receive(mutationOk(frames[0]!, 9n));
    expect(await result!).toBe(9n);

    await act(async () => {
      root.unmount();
    });
  });

  test("unmount before the client arrives settles a queued call with the typed discard", async () => {
    const harness = createHarness();
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
        settlement = send({ text: "never" }).catch((error) => error);
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
      <DbzzProvider config={harness.config()}>
        <Gate />
      </DbzzProvider>,
    );
    const failure = await settlement!;
    expect(failure).toBeInstanceOf(DbzzClientError);
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
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const results: Promise<bigint>[] = [];
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
        <DbzzProvider config={harness.config()}>
          <SendOnMount />
        </DbzzProvider>
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
    expect(await Promise.all(results)).toEqual([1n, 2n]);

    await act(async () => {
      root.unmount();
    });
  });

  test("useMutation outside a provider fails loudly", async () => {
    const container = mountPoint();
    const root = createRoot(container);
    let caught: unknown;

    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      override componentDidCatch(error: unknown): void {
        caught = error;
      }
      override render(): ReactNode {
        return this.state.failed ? "failed" : this.props.children;
      }
    }

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
    expect(String(caught)).toContain("useMutation requires a <DbzzProvider> ancestor");
    await act(async () => {
      root.unmount();
    });
  });
});
