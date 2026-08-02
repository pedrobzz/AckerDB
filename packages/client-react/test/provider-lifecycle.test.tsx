import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import type {
  AckerDBClientClock,
  AckerDBConnectionState,
  AckerDBWebSocket,
} from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, useConnectionState, type AckerDBProviderConfig } from "@ackerdb/client-react";
import { createBoundary } from "./support/boundary.tsx";

interface ClockTask {
  at: number;
  callback: () => void;
  intervalMs?: number;
}

class ManualClock implements AckerDBClientClock {
  private nextId = 0;
  private readonly tasks = new Map<number, ClockTask>();
  private time = 0;

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

  get taskCount(): number {
    return this.tasks.size;
  }
}

class FakeSocket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    parseClientMessage(decode(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  welcome(clientSessionId: string): void {
    this.onopen?.();
    const frame: ServerMessage = {
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId,
      authEpoch: 0,
      principal: "anonymous",
    };
    this.onmessage?.({ data: encode(frame) });
  }
}

interface Harness {
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  config(url: string): AckerDBProviderConfig;
  live(): FakeSocket[];
}

function createHarness(): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  return {
    clock,
    sockets,
    config(url) {
      return {
        url,
        credential: { kind: "anonymous" },
        clientSessionId: "react-lifecycle-session",
        clock,
        random: () => 0,
        createWebSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      };
    },
    live() {
      return sockets.filter((socket) => !socket.closed);
    },
  };
}

const phaseLog: string[] = [];

function ConnectionPhase(): ReactNode {
  const state = useConnectionState();
  phaseLog.push(state.phase);
  return <span>{state.phase}</span>;
}

function AuthenticationBadge(): ReactNode {
  const state = useConnectionState();
  return <span>{state.phase === "ready" ? state.authentication.principal : "-"}</span>;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("AckerDBProvider lifecycle", () => {
  test("Strict Mode mount and unmount leave one live client and no timers or sockets", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config("http://one.test")}>
          <ConnectionPhase />
        </AckerDBProvider>
      </StrictMode>,
    );

    // Strict Mode runs effect setup, cleanup, setup: two clients constructed,
    // the first fully closed, exactly one live connection remains.
    expect(harness.sockets).toHaveLength(2);
    expect(harness.live()).toHaveLength(1);
    expect(harness.clock.taskCount).toBe(0);
    expect(container.textContent).toBe("connecting");

    const live = harness.live()[0]!;
    await act(async () => {
      live.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("ready");
    expect(harness.clock.taskCount).toBe(2);

    await act(async () => {
      root.unmount();
    });
    expect(harness.live()).toHaveLength(0);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("equal-valued reconfiguration keeps the lifetime; changed values replace the client", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const app = (url: string): ReactNode => (
      <StrictMode>
        <AckerDBProvider config={harness.config(url)}>
          <ConnectionPhase />
        </AckerDBProvider>
      </StrictMode>
    );

    await render(root, app("http://one.test"));
    expect(harness.sockets).toHaveLength(2);
    const first = harness.live()[0]!;
    await act(async () => {
      first.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("ready");

    // A new config object with equal values continues the current lifetime.
    await render(root, app("http://one.test"));
    expect(harness.sockets).toHaveLength(2);
    expect(harness.live()).toEqual([first]);
    expect(container.textContent).toBe("ready");

    // A changed value closes the old client and starts exactly one new one.
    await render(root, app("http://two.test"));
    expect(harness.sockets).toHaveLength(3);
    expect(first.closed).toBe(true);
    expect(harness.live()).toHaveLength(1);
    expect(harness.clock.taskCount).toBe(0);
    expect(container.textContent).toBe("connecting");

    await act(async () => {
      harness.live()[0]!.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("ready");

    await act(async () => {
      root.unmount();
    });
    expect(harness.live()).toHaveLength(0);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("every reconnect option is part of the provider lifetime identity", async () => {
    const harness = createHarness();
    const root = createRoot(mountPoint());
    const base = {
      baseDelayMs: 10,
      maxDelayMs: 20,
      stableOpenMs: 30,
      disconnectedGraceMs: 40,
      iceRestartTimeoutMs: 50,
      realtimeSetupTimeoutMs: 60,
    };
    const app = (reconnect: typeof base): ReactNode => (
      <AckerDBProvider config={{ ...harness.config("http://one.test"), reconnect }}>
        <ConnectionPhase />
      </AckerDBProvider>
    );
    const changes = [
      { baseDelayMs: 11 },
      { maxDelayMs: 21 },
      { stableOpenMs: 31 },
      { disconnectedGraceMs: 41 },
      { iceRestartTimeoutMs: 51 },
      { realtimeSetupTimeoutMs: 61 },
    ] as const;

    await render(root, app(base));
    for (const change of changes) {
      const previous = harness.live()[0]!;
      await render(root, app({ ...base, ...change }));
      expect(previous.closed).toBe(true);
      expect(harness.live()).toHaveLength(1);
      await render(root, app(base));
    }

    await act(async () => root.unmount());
  });

  test("a committed reconfiguration never exposes the previous lifetime", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const renderLog: string[] = [];

    function LifetimeProbe({ url }: { url: string }): ReactNode {
      const state = useConnectionState();
      renderLog.push(`${url}:${state.phase}`);
      return (
        <span>
          {url}:{state.phase}
        </span>
      );
    }

    const app = (url: string): ReactNode => (
      <AckerDBProvider config={harness.config(url)}>
        <LifetimeProbe url={url} />
      </AckerDBProvider>
    );

    await render(root, app("http://one.test"));
    await act(async () => {
      harness.live()[0]!.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("http://one.test:ready");

    // No render — committed or otherwise — may pair the new configuration
    // with the previous client's ready state.
    renderLog.length = 0;
    await render(root, app("http://two.test"));
    expect(renderLog).not.toContain("http://two.test:ready");
    expect(container.textContent).toBe("http://two.test:connecting");

    await act(async () => {
      harness.live()[0]!.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("http://two.test:ready");
    await act(async () => {
      root.unmount();
    });
  });

  test("consumers observe transitions through the external store without extra renders when idle", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config("http://one.test")}>
        <ConnectionPhase />
        <AuthenticationBadge />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("connecting-");
    const live = harness.live()[0]!;
    await act(async () => {
      live.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("readyanonymous");

    phaseLog.length = 0;
    await act(async () => {
      live.close();
    });
    expect(container.textContent).toBe("reconnecting-");
    // One store transition produces one committed render for the consumer.
    expect(phaseLog).toEqual(["reconnecting"]);

    await act(async () => {
      root.unmount();
    });
  });

  test("useConnectionState outside a provider fails loudly", async () => {
    const container = mountPoint();
    const root = createRoot(container);
    const { Boundary, caught } = createBoundary();

    await render(
      root,
      <Boundary>
        <ConnectionPhase />
      </Boundary>,
    );
    expect(container.textContent).toBe("failed");
    expect(String(caught())).toContain("useConnectionState requires a <AckerDBProvider> ancestor");
    await act(async () => {
      root.unmount();
    });
  });
});
