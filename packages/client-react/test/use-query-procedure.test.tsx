import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type ApplicationError,
  type ClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import type { AckerDBWebSocket, ProcedureRef } from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  AckerDBProvider,
  skip,
  useQueryProcedure,
  type AckerDBProviderConfig,
  type AckerDBQueryProcedureState,
} from "@ackerdb/client-react";

class FakeSocket implements AckerDBWebSocket {
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

  procedures(): Extract<ClientMessage, { t: "p" }>[] {
    return this.frames().filter((frame) => frame.t === "p") as Extract<
      ClientMessage,
      { t: "p" }
    >[];
  }
}

const SESSION = "use-query-procedure-session";

interface Harness {
  readonly config: AckerDBProviderConfig;
  readonly sockets: FakeSocket[];
  live(): FakeSocket;
}

function createHarness(url = "http://use-query-procedure.test"): Harness {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    config: {
      url,
      credential: { kind: "anonymous" },
      clientSessionId: SESSION,
      random: () => 0,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
    live() {
      const socket = sockets.findLast((candidate) => !candidate.closed);
      if (!socket) throw new Error("no live socket");
      return socket;
    },
  };
}

type UppercaseError = ApplicationError<
  "tools.unavailable",
  { readonly source: string },
  503
>;

const uppercase = { $ref: "tools.uppercase" } as ProcedureRef<
  { readonly value: string },
  { readonly value: string },
  UppercaseError
>;
const reverse = { $ref: "tools.reverse" } as typeof uppercase;

const observed = new Map<
  string,
  AckerDBQueryProcedureState<{ readonly value: string }, UppercaseError>
>();

function Report({
  id,
  procedure = uppercase,
  value,
  refreshIntervalMs,
}: {
  readonly id?: string;
  readonly procedure?: typeof uppercase;
  readonly value: string | typeof skip;
  readonly refreshIntervalMs?: number;
}): ReactNode {
  const state = useQueryProcedure(
    procedure,
    value === skip ? skip : { value },
    refreshIntervalMs === undefined ? undefined : { refreshIntervalMs },
  );
  if (id !== undefined) observed.set(id, state);
  return (
    <output>
      {state.status === "success" ? `success:${state.data.value}` : state.status}
    </output>
  );
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

async function untilProcedureCount(
  harness: Harness,
  count: number,
): Promise<Extract<ClientMessage, { t: "p" }>[]> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const procedures = harness.live().procedures();
    if (procedures.length >= count) return procedures;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${count} procedure calls`);
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useQueryProcedure", () => {
  test("canonical arguments continue one observation while changed arguments start fresh demand", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const page = (value: string) => (
      <AckerDBProvider config={harness.config}>
        <Report id="changing" value={value} />
      </AckerDBProvider>
    );

    await render(root, page("one"));
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().procedures()[0]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const firstSnapshot = observed.get("changing")!;
    const firstRefresh = firstSnapshot.refresh;

    // Report constructs a fresh argument object on every render. Canonical
    // equality keeps the existing observation and does not execute again.
    await render(root, page("one"));
    expect(harness.live().procedures()).toHaveLength(1);
    expect(observed.get("changing")).toBe(firstSnapshot);

    await render(root, page("two"));
    expect(harness.live().procedures()).toHaveLength(2);
    expect(observed.get("changing")!.status).toBe("pending");
    expect(observed.get("changing")!.refresh).not.toBe(firstRefresh);

    // Refresh belongs to its observation lifetime and becomes inert after
    // that keyed demand has been released.
    firstRefresh();
    expect(harness.live().procedures()).toHaveLength(2);

    const second = harness.live().procedures()[1]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: second.id,
        kind: "procedure",
        value: { value: "TWO" },
      });
    });
    expect(container.textContent).toBe("success:TWO");
    await act(async () => root.unmount());
  });

  test("different addresses and refresh configurations remain independent", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report value="one" />
        <Report value="one" refreshIntervalMs={10_000} />
        <Report procedure={reverse} value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });

    expect(harness.live().procedures().map(({ ref }) => ref).sort()).toEqual([
      "tools.reverse",
      "tools.uppercase",
      "tools.uppercase",
    ]);
    await act(async () => root.unmount());
  });

  test("a later equal consumer adopts the live snapshot without another execution", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);
    const page = (withSecond: boolean) => (
      <AckerDBProvider config={harness.config}>
        <Report id="first" value="one" />
        {withSecond ? <Report id="second" value="one" /> : null}
      </AckerDBProvider>
    );

    await render(root, page(false));
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const request = harness.live().procedures()[0]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: request.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });

    await render(root, page(true));
    expect(harness.live().procedures()).toHaveLength(1);
    expect(observed.get("second")).toBe(observed.get("first"));
    await act(async () => root.unmount());
  });

  test("provider reconfiguration starts a separate client-scoped observation", async () => {
    observed.clear();
    const firstHarness = createHarness();
    const secondHarness = createHarness("http://use-query-procedure-second.test");
    const container = mountPoint();
    const root = createRoot(container);
    const page = (config: AckerDBProviderConfig) => (
      <AckerDBProvider config={config}>
        <Report id="provider" value="one" />
      </AckerDBProvider>
    );

    await render(root, page(firstHarness.config));
    await act(async () => {
      firstHarness.live().welcome(SESSION);
    });
    const firstRequest = firstHarness.live().procedures()[0]!;
    await act(async () => {
      firstHarness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: firstRequest.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const firstSnapshot = observed.get("provider")!;

    await render(root, page(secondHarness.config));
    await act(async () => {
      secondHarness.live().welcome(SESSION);
    });
    expect(secondHarness.live().procedures()).toHaveLength(1);
    expect(observed.get("provider")).not.toBe(firstSnapshot);
    firstSnapshot.refresh();
    expect(firstHarness.sockets.flatMap((socket) => socket.procedures())).toHaveLength(1);
    await act(async () => root.unmount());
  });

  test("application and framework errors clear prior data while success containers are frozen", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report id="errors" value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().procedures()[0]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const success = observed.get("errors")!;
    if (success.status !== "success") throw new Error("expected success");
    expect(Object.isFrozen(success.data)).toBe(true);

    success.refresh();
    const second = harness.live().procedures()[1]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "app_err",
        id: second.id,
        kind: "procedure",
        error: {
          kind: "application",
          code: "tools.unavailable",
          body: { source: "upstream" },
          status: 503,
        },
      });
    });
    const applicationFailure = observed.get("errors")!;
    if (applicationFailure.status !== "application-error") {
      throw new Error("expected application error");
    }
    expect(applicationFailure.data).toBeUndefined();
    expect(applicationFailure.error.body.source).toBe("upstream");

    applicationFailure.refresh();
    const third = harness.live().procedures()[2]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "err",
        id: third.id,
        outcome: {
          code: "unauthorized",
          retryable: false,
          message: "access denied",
        },
      });
    });
    expect(observed.get("errors")).toMatchObject({
      status: "rejected",
      data: undefined,
      error: { code: "unauthorized", message: "access denied" },
    });
    await act(async () => root.unmount());
  });

  test("Strict Mode leaves one observation and final release cancels work and retires refresh", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config}>
          <Report id="strict" value="one" refreshIntervalMs={10_000} />
        </AckerDBProvider>
      </StrictMode>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const socket = harness.live();
    expect(socket.procedures()).toHaveLength(1);
    const refresh = observed.get("strict")!.refresh;
    refresh();
    expect(socket.procedures()).toHaveLength(1);

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config} />
      </StrictMode>,
    );
    expect(socket.frames().filter(({ t }) => t === "cancel")).toHaveLength(1);
    refresh();
    await Bun.sleep(20);
    expect(socket.procedures()).toHaveLength(1);
    await act(async () => root.unmount());
  });

  test("invalid refresh intervals fail immediately as programmer errors", () => {
    for (const refreshIntervalMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        renderToString(
          <AckerDBProvider config={createHarness().config}>
            <Report value="one" refreshIntervalMs={refreshIntervalMs} />
          </AckerDBProvider>,
        ),
      ).toThrow(RangeError);
    }
  });

  test("a client failure retains stale data without retrying and manual refresh stays immediate", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report id="failure" value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().procedures()[0]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
      observed.get("failure")!.refresh();
    });
    const second = harness.live().procedures()[1]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "err",
        id: second.id,
        outcome: {
          code: "overloaded",
          retryable: true,
          retryAfterMs: 100,
          message: "busy",
        },
      });
    });

    const failed = observed.get("failure")!;
    expect(failed).toMatchObject({
      status: "unavailable",
      stale: true,
      data: { value: "ONE" },
    });
    await Bun.sleep(50);
    expect(harness.live().procedures()).toHaveLength(2);

    failed.refresh();
    expect(harness.live().procedures()).toHaveLength(3);
    await act(async () => root.unmount());
  });

  test("retryAfterMs floors configured automatic polling", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report id="backpressure" value="one" refreshIntervalMs={20} />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().procedures()[0]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const second = (await untilProcedureCount(harness, 2))[1]!;
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "err",
        id: second.id,
        outcome: {
          code: "overloaded",
          retryable: true,
          retryAfterMs: 80,
          message: "busy",
        },
      });
    });

    await Bun.sleep(40);
    expect(harness.live().procedures()).toHaveLength(2);
    expect(await untilProcedureCount(harness, 3)).toHaveLength(3);

    await act(async () => root.unmount());
  });

  test("polling waits for completion and refresh demand coalesces behind in-flight work", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report id="poll" value="one" refreshIntervalMs={20} />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().procedures()[0]!;

    // A fixed-rate timer would overlap this deliberately unfinished call.
    await Bun.sleep(50);
    expect(harness.live().procedures()).toHaveLength(1);

    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "FIRST" },
      });
    });
    const afterInterval = await untilProcedureCount(harness, 2);

    // Repeated demand while the interval execution is active retains one
    // bounded trailing refresh and starts nothing concurrently.
    const state = observed.get("poll")!;
    state.refresh();
    state.refresh();
    state.refresh();
    expect(harness.live().procedures()).toHaveLength(2);

    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: afterInterval[1]!.id,
        kind: "procedure",
        value: { value: "SECOND" },
      });
    });
    const withTrailing = await untilProcedureCount(harness, 3);
    expect(withTrailing).toHaveLength(3);

    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: withTrailing[2]!.id,
        kind: "procedure",
        value: { value: "THIRD" },
      });
      root.unmount();
    });
  });

  test("equal consumers share one execution, snapshot, and manual refresh", async () => {
    observed.clear();
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report id="a" value="one" />
        <Report id="b" value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().procedures()[0]!;
    expect(harness.live().procedures()).toHaveLength(1);

    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const firstA = observed.get("a")!;
    const firstB = observed.get("b")!;
    expect(firstA).toBe(firstB);
    expect(firstA.refresh).toBe(firstB.refresh);

    await act(async () => {
      firstA.refresh();
    });
    expect(container.textContent).toBe("success:ONEsuccess:ONE");
    const procedures = harness.live().procedures();
    expect(procedures).toHaveLength(2);
    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: procedures[1]!.id,
        kind: "procedure",
        value: { value: "TWO" },
      });
    });
    expect(observed.get("a")).toBe(observed.get("b"));
    expect(container.textContent).toBe("success:TWOsuccess:TWO");

    await act(async () => root.unmount());
  });

  test("skip renders disabled and starts no procedure", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report value={skip} />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("disabled");

    await act(async () => {
      harness.live().welcome(SESSION);
    });
    expect(harness.live().procedures()).toHaveLength(0);

    await act(async () => root.unmount());
  });

  test("committed demand executes its procedure and renders query-shaped success", async () => {
    const harness = createHarness();
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config}>
        <Report value="one" />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("pending");

    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const request = harness.live().procedures()[0]!;
    expect(request).toMatchObject({
      ref: "tools.uppercase",
      args: { value: "one" },
    });

    await act(async () => {
      harness.live().receive({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: request.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    expect(container.textContent).toBe("success:ONE");

    await act(async () => root.unmount());
  });
});
