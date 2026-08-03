import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import { createHarness } from "./support/harness.ts";
import type { AckerDBConnectionState } from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, useConnectionState } from "@ackerdb/client-react";
import { createBoundary } from "./support/boundary.tsx";

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

const APP = { clientSessionId: "react-lifecycle-session" };

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("AckerDBProvider lifecycle", () => {
  test("Strict Mode mount and unmount leave one live client and no timers or sockets", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config({ url: "http://one.test" })}>
          <ConnectionPhase />
        </AckerDBProvider>
      </StrictMode>,
    );

    // Strict Mode runs effect setup, cleanup, setup: two clients constructed,
    // the first fully closed, exactly one live connection remains.
    expect(harness.sockets).toHaveLength(2);
    expect(harness.open()).toHaveLength(1);
    expect(harness.clock.taskCount).toBe(0);
    expect(container.textContent).toBe("connecting");

    const live = harness.open()[0]!;
    await act(async () => {
      live.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("ready");
    expect(harness.clock.taskCount).toBe(2);

    await act(async () => {
      root.unmount();
    });
    expect(harness.open()).toHaveLength(0);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("equal-valued reconfiguration keeps the lifetime; changed values replace the client", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const app = (url: string): ReactNode => (
      <StrictMode>
        <AckerDBProvider config={harness.config({ url })}>
          <ConnectionPhase />
        </AckerDBProvider>
      </StrictMode>
    );

    await render(root, app("http://one.test"));
    expect(harness.sockets).toHaveLength(2);
    const first = harness.open()[0]!;
    await act(async () => {
      first.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("ready");

    // A new config object with equal values continues the current lifetime.
    await render(root, app("http://one.test"));
    expect(harness.sockets).toHaveLength(2);
    expect(harness.open()).toEqual([first]);
    expect(container.textContent).toBe("ready");

    // A changed value closes the old client and starts exactly one new one.
    await render(root, app("http://two.test"));
    expect(harness.sockets).toHaveLength(3);
    expect(first.closed).toBe(true);
    expect(harness.open()).toHaveLength(1);
    expect(harness.clock.taskCount).toBe(0);
    expect(container.textContent).toBe("connecting");

    await act(async () => {
      harness.open()[0]!.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("ready");

    await act(async () => {
      root.unmount();
    });
    expect(harness.open()).toHaveLength(0);
    expect(harness.clock.taskCount).toBe(0);
  });

  test("every reconnect option is part of the provider lifetime identity", async () => {
    const harness = createHarness(APP);
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
      <AckerDBProvider config={{ ...harness.config({ url: "http://one.test" }), reconnect }}>
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
      const previous = harness.open()[0]!;
      await render(root, app({ ...base, ...change }));
      expect(previous.closed).toBe(true);
      expect(harness.open()).toHaveLength(1);
      await render(root, app(base));
    }

    await act(async () => root.unmount());
  });

  test("a committed reconfiguration never exposes the previous lifetime", async () => {
    const harness = createHarness(APP);
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
      <AckerDBProvider config={harness.config({ url })}>
        <LifetimeProbe url={url} />
      </AckerDBProvider>
    );

    await render(root, app("http://one.test"));
    await act(async () => {
      harness.open()[0]!.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("http://one.test:ready");

    // No render — committed or otherwise — may pair the new configuration
    // with the previous client's ready state.
    renderLog.length = 0;
    await render(root, app("http://two.test"));
    expect(renderLog).not.toContain("http://two.test:ready");
    expect(container.textContent).toBe("http://two.test:connecting");

    await act(async () => {
      harness.open()[0]!.welcome("react-lifecycle-session");
    });
    expect(container.textContent).toBe("http://two.test:ready");
    await act(async () => {
      root.unmount();
    });
  });

  test("consumers observe transitions through the external store without extra renders when idle", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(
      root,
      <AckerDBProvider config={harness.config({ url: "http://one.test" })}>
        <ConnectionPhase />
        <AuthenticationBadge />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("connecting-");
    const live = harness.open()[0]!;
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
