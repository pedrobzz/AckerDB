import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { createHarness, type ProviderHarness } from "./support/harness.ts";
import {
  ACKERDB_VERSION,
  type ApplicationError,
  type ClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import type { ProcedureRef } from "@ackerdb/client";
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

const SESSION = "use-query-procedure-session";
// No injected clock: this suite proves procedure lifetimes against real timers.
const APP = {
  url: "http://use-query-procedure.test",
  clientSessionId: SESSION,
  clock: undefined,
};

type UppercaseError = ApplicationError<
  "api.tools.unavailable",
  { readonly source: string },
  503
>;

const uppercase = { $ref: "api.tools.uppercase" } as ProcedureRef<
  { readonly value: string },
  { readonly value: string },
  UppercaseError
>;
const reverse = { $ref: "api.tools.reverse" } as typeof uppercase;
const unencodable = { $ref: "api.tools.unencodable" } as ProcedureRef<
  { readonly value: unknown },
  { readonly value: string }
>;

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

const unencodableObserved = new Map<
  string,
  AckerDBQueryProcedureState<{ readonly value: string }>
>();

function UnencodableReport({ id }: { readonly id: string }): ReactNode {
  const state = useQueryProcedure(unencodable, { value: () => id });
  unencodableObserved.set(id, state);
  return <output>{state.status}</output>;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

async function untilProcedureCount(
  harness: ProviderHarness,
  count: number,
): Promise<Extract<ClientMessage, { t: "p" }>[]> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const procedures = harness.live().framesOf("p");
    if (procedures.length >= count) return procedures;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${count} procedure calls`);
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useQueryProcedure", () => {
  test("canonical arguments continue one observation while any changed key starts fresh demand", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const page = (value: string, procedure = uppercase, refreshIntervalMs?: number) => (
      <AckerDBProvider config={harness.config()}>
        <Report
          id="changing"
          procedure={procedure}
          value={value}
          refreshIntervalMs={refreshIntervalMs}
        />
      </AckerDBProvider>
    );

    await render(root, page("one"));
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;
    await act(async () => {
      harness.live().receive({
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const firstSnapshot = observed.get("changing")!;

    // Report constructs a fresh argument object on every render. Canonical
    // equality keeps the existing observation and does not execute again.
    await render(root, page("one"));
    expect(harness.live().framesOf("p")).toHaveLength(1);
    expect(observed.get("changing")).toBe(firstSnapshot);

    // Every key dimension — arguments, address, refresh configuration — starts
    // a fresh observation with its own snapshot and refresh identity; refresh
    // belongs to its observation lifetime and is inert once that keyed demand
    // has been released.
    const changes: Array<[string, typeof uppercase, number | undefined]> = [
      ["two", uppercase, undefined],
      ["two", reverse, undefined],
      ["two", reverse, 10_000],
    ];
    for (const [index, [value, procedure, refreshIntervalMs]] of changes.entries()) {
      const previous = observed.get("changing")!;
      await render(root, page(value, procedure, refreshIntervalMs));
      const requests = harness.live().framesOf("p");
      expect(requests).toHaveLength(index + 2);
      expect(requests.at(-1)!.ref).toBe(procedure.$ref);
      expect(observed.get("changing")!.status).toBe("pending");
      expect(observed.get("changing")).not.toBe(previous);
      expect(observed.get("changing")!.refresh).not.toBe(previous.refresh);
      previous.refresh();
      expect(harness.live().framesOf("p")).toHaveLength(index + 2);
      await act(async () => {
        harness.live().receive({
          t: "ok",
          id: requests.at(-1)!.id,
          kind: "procedure",
          value: { value: "TWO" },
        });
      });
      expect(container.textContent).toBe("success:TWO");
    }
    await act(async () => root.unmount());
  });

  test("different addresses and refresh configurations remain independent", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report value="one" />
        <Report value="one" refreshIntervalMs={10_000} />
        <Report procedure={reverse} value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });

    expect(harness.live().framesOf("p").map(({ ref }) => ref).sort()).toEqual([
      "api.tools.reverse",
      "api.tools.uppercase",
      "api.tools.uppercase",
    ]);
    await act(async () => root.unmount());
  });

  test("unencodable consumers keep separate validation-error lifetimes", async () => {
    unencodableObserved.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <UnencodableReport id="a" />
        <UnencodableReport id="b" />
      </AckerDBProvider>,
    );
    const firstA = unencodableObserved.get("a")!;
    const firstB = unencodableObserved.get("b")!;
    expect(firstA).toMatchObject({
      status: "rejected",
      error: { code: "validation" },
    });
    expect(firstB).toMatchObject({
      status: "rejected",
      error: { code: "validation" },
    });
    expect(firstA).not.toBe(firstB);
    expect(firstA.refresh).not.toBe(firstB.refresh);
    expect(harness.live().framesOf("p")).toHaveLength(0);

    await act(async () => {
      firstA.refresh();
    });
    expect(unencodableObserved.get("a")).not.toBe(firstA);
    expect(unencodableObserved.get("b")).toBe(firstB);
    expect(harness.live().framesOf("p")).toHaveLength(0);
    await act(async () => root.unmount());
  });

  test("a later equal consumer adopts the live snapshot without another execution", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const page = (withSecond: boolean) => (
      <AckerDBProvider config={harness.config()}>
        <Report id="first" value="one" />
        {withSecond ? <Report id="second" value="one" /> : null}
      </AckerDBProvider>
    );

    await render(root, page(false));
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const request = harness.live().framesOf("p")[0]!;
    await act(async () => {
      harness.live().receive({
        t: "ok",
        id: request.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });

    await render(root, page(true));
    expect(harness.live().framesOf("p")).toHaveLength(1);
    expect(observed.get("second")).toBe(observed.get("first"));
    await act(async () => root.unmount());
  });

  test("provider reconfiguration starts a separate client-scoped observation", async () => {
    observed.clear();
    const firstHarness = createHarness(APP);
    const secondHarness = createHarness({ ...APP, url: "http://use-query-procedure-second.test" });
    const container = mountPoint();
    const root = createRoot(container);
    const page = (config: AckerDBProviderConfig) => (
      <AckerDBProvider config={config}>
        <Report id="provider" value="one" />
      </AckerDBProvider>
    );

    await render(root, page(firstHarness.config()));
    await act(async () => {
      firstHarness.live().welcome(SESSION);
    });
    const firstRequest = firstHarness.live().framesOf("p")[0]!;
    await act(async () => {
      firstHarness.live().receive({
        t: "ok",
        id: firstRequest.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const firstSnapshot = observed.get("provider")!;

    await render(root, page(secondHarness.config()));
    await act(async () => {
      secondHarness.live().welcome(SESSION);
    });
    expect(secondHarness.live().framesOf("p")).toHaveLength(1);
    expect(observed.get("provider")).not.toBe(firstSnapshot);
    firstSnapshot.refresh();
    expect(firstHarness.sockets.flatMap((socket) => socket.framesOf("p"))).toHaveLength(1);
    await act(async () => root.unmount());
  });

  test("application and framework errors clear prior data while success containers are frozen", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report id="errors" value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;
    await act(async () => {
      harness.live().receive({
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
    const second = harness.live().framesOf("p")[1]!;
    await act(async () => {
      harness.live().receive({
        t: "app_err",
        id: second.id,
        kind: "procedure",
        error: {
          kind: "application",
          code: "api.tools.unavailable",
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
    const third = harness.live().framesOf("p")[2]!;
    await act(async () => {
      harness.live().receive({
        v: ACKERDB_VERSION,
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()}>
          <Report id="strict" value="one" refreshIntervalMs={10_000} />
        </AckerDBProvider>
      </StrictMode>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const socket = harness.live();
    expect(socket.framesOf("p")).toHaveLength(1);
    const refresh = observed.get("strict")!.refresh;
    refresh();
    expect(socket.framesOf("p")).toHaveLength(1);

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()} />
      </StrictMode>,
    );
    expect(socket.frames().filter(({ t }) => t === "cancel")).toHaveLength(1);
    refresh();
    await Bun.sleep(20);
    expect(socket.framesOf("p")).toHaveLength(1);
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
          <AckerDBProvider config={createHarness(APP).config()}>
            <Report value="one" refreshIntervalMs={refreshIntervalMs} />
          </AckerDBProvider>,
        ),
      ).toThrow(RangeError);
    }
  });

  test("the largest valid interval does not overflow into a hot polling loop", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report value="one" refreshIntervalMs={Number.MAX_SAFE_INTEGER} />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;
    await act(async () => {
      harness.live().receive({
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });

    await Bun.sleep(20);
    expect(harness.live().framesOf("p")).toHaveLength(1);
    await act(async () => root.unmount());
  });

  test("a client failure retains stale data without retrying and manual refresh stays immediate", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report id="failure" value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;
    await act(async () => {
      harness.live().receive({
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
      observed.get("failure")!.refresh();
    });
    const second = harness.live().framesOf("p")[1]!;
    await act(async () => {
      harness.live().receive({
        v: ACKERDB_VERSION,
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
    expect(harness.live().framesOf("p")).toHaveLength(2);

    failed.refresh();
    expect(harness.live().framesOf("p")).toHaveLength(3);
    await act(async () => root.unmount());
  });

  test("retryAfterMs floors configured automatic polling", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report id="backpressure" value="one" refreshIntervalMs={20} />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;
    await act(async () => {
      harness.live().receive({
        t: "ok",
        id: first.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    const second = (await untilProcedureCount(harness, 2))[1]!;
    await act(async () => {
      harness.live().receive({
        v: ACKERDB_VERSION,
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
    expect(harness.live().framesOf("p")).toHaveLength(2);
    expect(await untilProcedureCount(harness, 3)).toHaveLength(3);

    await act(async () => root.unmount());
  });

  test("polling waits for completion and refresh demand coalesces behind in-flight work", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report id="poll" value="one" refreshIntervalMs={20} />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;

    // A fixed-rate timer would overlap this deliberately unfinished call.
    await Bun.sleep(50);
    expect(harness.live().framesOf("p")).toHaveLength(1);

    await act(async () => {
      harness.live().receive({
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
    expect(harness.live().framesOf("p")).toHaveLength(2);

    await act(async () => {
      harness.live().receive({
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
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report id="a" value="one" />
        <Report id="b" value="one" />
      </AckerDBProvider>,
    );
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const first = harness.live().framesOf("p")[0]!;
    expect(harness.live().framesOf("p")).toHaveLength(1);

    await act(async () => {
      harness.live().receive({
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
    const procedures = harness.live().framesOf("p");
    expect(procedures).toHaveLength(2);
    await act(async () => {
      harness.live().receive({
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

  test("one shared consumer can leave in flight; final release cancels and remount starts clean", async () => {
    observed.clear();
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const page = (ids: string[]) => (
      <AckerDBProvider config={harness.config()}>
        {ids.map((id) => <Report key={id} id={id} value="one" />)}
      </AckerDBProvider>
    );

    await render(root, page(["a", "b"]));
    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const socket = harness.live();
    const initial = socket.framesOf("p")[0]!;
    expect(socket.framesOf("p")).toHaveLength(1);

    await render(root, page(["a"]));
    expect(socket.frames().filter(({ t }) => t === "cancel")).toHaveLength(0);
    await act(async () => {
      socket.receive({
        t: "ok",
        id: initial.id,
        kind: "procedure",
        value: { value: "ONE" },
      });
    });
    expect(container.textContent).toBe("success:ONE");
    const liveSnapshot = observed.get("a")!;

    liveSnapshot.refresh();
    const abandoned = socket.framesOf("p")[1]!;
    await render(root, page([]));
    expect(socket.frames().filter(({ t }) => t === "cancel")).toEqual([
      { t: "cancel", id: abandoned.id },
    ]);

    // A late server result for canceled work cannot repopulate the evicted
    // observation. Equal demand starts one clean pending lifetime.
    await act(async () => {
      socket.receive({
        t: "ok",
        id: abandoned.id,
        kind: "procedure",
        value: { value: "LATE" },
      });
    });
    await render(root, page(["c"]));
    expect(container.textContent).toBe("pending");
    expect(socket.framesOf("p")).toHaveLength(3);
    expect(observed.get("c")).not.toBe(liveSnapshot);
    expect(observed.get("c")!.refresh).not.toBe(liveSnapshot.refresh);
    await act(async () => root.unmount());
  });

  test("skip renders disabled and starts no procedure", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report value={skip} />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("disabled");

    await act(async () => {
      harness.live().welcome(SESSION);
    });
    expect(harness.live().framesOf("p")).toHaveLength(0);

    await act(async () => root.unmount());
  });

  test("committed demand executes its procedure and renders query-shaped success", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Report value="one" />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("pending");

    await act(async () => {
      harness.live().welcome(SESSION);
    });
    const request = harness.live().framesOf("p")[0]!;
    expect(request).toMatchObject({
      ref: "api.tools.uppercase",
      args: { value: "one" },
    });

    await act(async () => {
      harness.live().receive({
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
