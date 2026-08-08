import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, parseClientMessage } from "@ackerdb/core";
import {
  AckerDBClientError,
  type ClientResult,
  type AckerDBClientOptionsBase,
  type AckerDBWebSocket,
  type ProcedureRef,
} from "@ackerdb/client";
import {
  AckerDBError,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineTable,
  procedure,
  reconcile,
  serve,
} from "@ackerdb/server";
import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AckerDBProvider,
  useProcedure,
  useQueryProcedure,
  type AckerDBProcedure,
  type AckerDBProviderConfig,
  type AckerDBQueryProcedureState,
} from "@ackerdb/client-react";
import { createBoundary } from "./support/boundary.tsx";
import { deferred, until, type Deferred } from "ackerdb-test-support/async";

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// Typed references as codegen would emit them for the registry below.
const api = {
  tools: {
    echo: { $ref: "tools.echo" } as ProcedureRef<{ value: string }, string>,
    observe: { $ref: "tools.observe" } as ProcedureRef<
      { value: string },
      { readonly run: number; readonly value: string }
    >,
    fail: { $ref: "tools.fail" } as ProcedureRef<Record<never, never>, never>,
    block: { $ref: "tools.block" } as ProcedureRef<Record<never, never>, string>,
  },
};

function mustOk<Data>(result: ClientResult<Data>): Data {
  if (!result.ok) throw result.error;
  return result.data;
}

function mustErr<Data>(result: ClientResult<Data>): AckerDBClientError {
  if (result.ok) throw new Error("expected a failed Result");
  return result.error;
}

// Per-call gates for tools.block so tests can hold a real request in flight.
let blockStarted: Deferred<void> | null = null;
let blockRelease: Deferred<void> | null = null;
let queryProcedureRuns = 0;

interface RecordedCall {
  readonly signal: AbortSignal | undefined;
}

interface App {
  readonly base: string;
  /** Every procedure handler the server actually admitted, in order. */
  readonly calls: RecordedCall[];
  config(overrides?: Partial<AckerDBClientOptionsBase>): AckerDBProviderConfig;
  close(): Promise<void>;
}

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-procedure-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const calls: RecordedCall[] = [];
  const registry = new Registry({
    tools: {
      echo: procedure({
        access: "public",
        args: { value: v.string() },
        handler: (ctx: Ctx, args: Ctx) => {
          calls.push({ signal: ctx.abortSignal });
          return args.value.toUpperCase();
        },
      }),
      observe: procedure({
        access: "public",
        args: { value: v.string() },
        handler: (ctx: Ctx, args: Ctx) => {
          calls.push({ signal: ctx.abortSignal });
          queryProcedureRuns++;
          return { run: queryProcedureRuns, value: args.value.toUpperCase() };
        },
      }),
      fail: procedure({
        access: "public",
        args: {},
        handler: (ctx: Ctx) => {
          calls.push({ signal: ctx.abortSignal });
          throw new AckerDBError("conflict", "flux capacitor offline");
        },
      }),
      block: procedure({
        access: "public",
        args: {},
        handler: async (ctx: Ctx) => {
          calls.push({ signal: ctx.abortSignal });
          blockStarted?.resolve();
          await blockRelease?.promise;
          return "released";
        },
      }),
    },
  });
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS, admin: { telemetry: { enabled: false } } });
  const server = serve({ runtime, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    calls,
    config(overrides) {
      return {
        url: base,
        credential: { kind: "anonymous" },
        createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
        ...overrides,
      };
    },
    async close() {
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function observingSocket(url: string, onProcedure: () => void): AckerDBWebSocket {
  const native = new NativeWebSocket(url);
  const socket: AckerDBWebSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (parseClientMessage(decode(data)).t === "p") onProcedure();
      native.send(data);
    },
    close(code, reason) {
      native.close(code, reason);
    },
  };
  native.onopen = () => socket.onopen?.();
  native.onmessage = (event) => socket.onmessage?.({ data: event.data });
  native.onclose = () => socket.onclose?.();
  native.onerror = () => socket.onerror?.();
  return socket;
}

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
  description: string,
): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    Bun.sleep(ms).then(() => "timeout"),
  ]);
  if (outcome === "timeout") throw new Error(`${description} did not settle within ${ms}ms`);
}

async function unmount(root: Root): Promise<void> {
  root.unmount();
  await Bun.sleep(0);
}

let app: App;
beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());

describe("useProcedure against a real ackerdb server", () => {
  test("query procedures share real executions and support manual and interval refresh", async () => {
    queryProcedureRuns = 0;
    const snapshots = new Map<
      string,
      AckerDBQueryProcedureState<{ readonly run: number; readonly value: string }>
    >();
    function Observed({ id }: { id: string }): ReactNode {
      const state = useQueryProcedure(
        api.tools.observe,
        { value: "hello" },
        { refreshIntervalMs: 500 },
      );
      snapshots.set(id, state);
      return (
        <output>
          {state.status === "success"
            ? `${id}:${state.data.value}:${state.data.run};`
            : `${id}:${state.status};`}
        </output>
      );
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={app.config()}>
        <Observed id="a" />
        <Observed id="b" />
      </AckerDBProvider>,
    );

    await until(
      () => container.textContent === "a:HELLO:1;b:HELLO:1;",
      "the shared initial procedure result",
    );
    expect(queryProcedureRuns).toBe(1);
    expect(snapshots.get("a")).toBe(snapshots.get("b"));

    snapshots.get("a")!.refresh();
    await until(
      () => container.textContent === "a:HELLO:2;b:HELLO:2;",
      "the shared manual refresh",
    );
    expect(queryProcedureRuns).toBe(2);

    await until(
      () => container.textContent === "a:HELLO:3;b:HELLO:3;",
      "the shared interval refresh",
    );
    expect(queryProcedureRuns).toBe(3);
    await unmount(root);
  });

  test("a Strict Mode mount-effect call waits for the client and only the live lifetime dispatches", async () => {
    const settlements: Array<{ kind: "ok"; value: string } | { kind: "error"; error: unknown }> =
      [];
    function EchoOnMount(): ReactNode {
      const echo = useProcedure(api.tools.echo);
      const [text, setText] = useState("pending");
      useEffect(() => {
        // Issued before the provider's effect constructs the client. Strict
        // Mode runs this effect twice; both queued calls wait through the
        // simulated remount (which closes the first client before either
        // could dispatch) and resolve once against the surviving lifetime.
        echo({ value: "hi" }).then((result) => {
          if (result.ok) {
            settlements.push({ kind: "ok", value: result.data });
            setText(result.data);
          } else {
            settlements.push({ kind: "error", error: result.error });
          }
        });
      }, [echo]);
      return <output>{text}</output>;
    }

    const callsBefore = app.calls.length;
    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <AckerDBProvider config={app.config()}>
          <EchoOnMount />
        </AckerDBProvider>
      </StrictMode>,
    );

    await until(() => container.textContent === "HI", "the mount-effect procedure result");
    await until(() => settlements.length === 2, "both Strict Mode call settlements");
    // Each of the two Strict Mode effect invocations settles its own call
    // exactly once, through exactly one dispatch — never the closed first
    // client, never a duplicate.
    expect(settlements).toEqual([
      { kind: "ok", value: "HI" },
      { kind: "ok", value: "HI" },
    ]);
    expect(app.calls.length - callsBefore).toBe(2);
    await unmount(root);
  });

  test("resolves server values and reports the exact typed server error outcome", async () => {
    let echo: AckerDBProcedure<{ value: string }, string> | null = null;
    let fail: AckerDBProcedure<Record<never, never>, never> | null = null;
    function Capture(): ReactNode {
      echo = useProcedure(api.tools.echo);
      fail = useProcedure(api.tools.fail);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={app.config()}>
        <Capture />
      </AckerDBProvider>,
    );
    await until(() => echo !== null && fail !== null, "the captured callables");

    expect(mustOk(await echo!({ value: "quiet" }))).toBe("QUIET");

    const failure = mustErr(await fail!({}));
    expect(failure).toMatchObject({
      name: "AckerDBClientError",
      code: "conflict",
      message: "flux capacitor offline",
      retryable: false,
    });
    expect(failure.outcome).toMatchObject({
      code: "conflict",
      message: "flux capacitor offline",
    });
    await unmount(root);
  });

  test("abort reaches the in-flight request and settles the caller promptly without replay", async () => {
    blockStarted = deferred();
    blockRelease = deferred();
    let block: AckerDBProcedure<Record<never, never>, string> | null = null;
    function Capture(): ReactNode {
      block = useProcedure(api.tools.block);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={app.config()}>
        <Capture />
      </AckerDBProvider>,
    );
    await until(() => block !== null, "the captured callable");

    const callsBefore = app.calls.length;
    const controller = new AbortController();
    const completion = block!({}, { signal: controller.signal });
    await blockStarted.promise; // the real server handler is executing

    controller.abort();
    // The handler is still blocked, so prompt settlement proves the abort
    // traveled through the session rather than waiting on the server.
    await settlesWithin(completion, 500, "the aborted procedure");
    expect(mustErr(await completion)).toMatchObject({
      name: "AckerDBClientError",
      code: "indeterminate",
      resource: "operation",
    });
    expect(app.calls.length - callsBefore).toBe(1);
    await until(() => app.calls.at(-1)!.signal?.aborted === true, "the server procedure cancellation");

    // A signal aborted before the call never dispatches a request at all.
    const preAborted = mustErr(await block!({}, { signal: controller.signal }));
    expect(preAborted).toMatchObject({
      name: "AckerDBClientError",
      code: "unavailable",
      message: "procedure request was canceled",
      resource: "operation",
    });
    expect(app.calls.length - callsBefore).toBe(1);

    blockRelease.resolve();
    await unmount(root);
  });

  test("a procedure that never reaches a session expires determinately without execution", async () => {
    // A real ackerdb server that has come and gone: its port now refuses every
    // connection, so the failure happens at the network rather than through a
    // fake transport. (Draining the shared server instead would leave Bun's
    // keep-alive pool racing the shutdown and make the outcome nondeterministic.)
    const island = createApp();
    await island.close();
    let echo: AckerDBProcedure<{ value: string }, string> | null = null;
    function Capture(): ReactNode {
      echo = useProcedure(api.tools.echo);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={island.config({
        limits: { maxQueryAgeMs: 100 },
        reconnect: { baseDelayMs: 2_500, maxDelayMs: 10_000 },
      })}>
        <Capture />
      </AckerDBProvider>,
    );
    await until(() => echo !== null, "the captured callable");

    const failure = mustErr(await echo!({ value: "down" }));
    expect(failure).toMatchObject({
      name: "AckerDBClientError",
      code: "deadline_exceeded",
      message: "client request deadline exceeded",
      resource: "operation",
    });
    expect(island.calls).toHaveLength(0);
    await unmount(root);
  });

  test("provider shutdown settles an in-flight call and stale callables report the closed client", async () => {
    blockStarted = deferred();
    blockRelease = deferred();
    let block: AckerDBProcedure<Record<never, never>, string> | null = null;
    let echo: AckerDBProcedure<{ value: string }, string> | null = null;
    function Capture(): ReactNode {
      block = useProcedure(api.tools.block);
      echo = useProcedure(api.tools.echo);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={app.config()}>
        <Capture />
      </AckerDBProvider>,
    );
    await until(() => block !== null && echo !== null, "the captured callables");

    const completion = block!({});
    await blockStarted.promise;

    await unmount(root);
    // close() aborts the session epoch; the handler is still blocked.
    await settlesWithin(completion, 500, "the provider-closed procedure");
    expect(mustErr(await completion)).toMatchObject({
      name: "AckerDBClientError",
      code: "indeterminate",
      resource: "operation",
    });

    // A stale callable after shutdown settles locally in the hook: its
    // ownership ended with the component, so nothing dispatches.
    const callsBefore = app.calls.length;
    const stale = mustErr(await echo!({ value: "late" }));
    expect(stale).toMatchObject({
      name: "AckerDBClientError",
      code: "unavailable",
      message: "client closed",
      resource: "operation",
    });
    expect(app.calls.length).toBe(callsBefore);

    blockRelease.resolve();
  });

  test("a callable retained past its consumer's unmount settles locally while the provider lives on", async () => {
    let echo: AckerDBProcedure<{ value: string }, string> | null = null;
    function Capture(): ReactNode {
      echo = useProcedure(api.tools.echo);
      return null;
    }
    function Host({ mounted }: { mounted: boolean }): ReactNode {
      return <AckerDBProvider config={app.config()}>{mounted ? <Capture /> : null}</AckerDBProvider>;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(<Host mounted={true} />);
    await until(() => echo !== null, "the captured callable");
    expect(mustOk(await echo!({ value: "alive" }))).toBe("ALIVE");

    root.render(<Host mounted={false} />);
    await Bun.sleep(20); // the consumer's unmount commit, provider untouched
    const callsBefore = app.calls.length;
    const stale = mustErr(await echo!({ value: "late" }));
    expect(stale).toMatchObject({
      name: "AckerDBClientError",
      code: "unavailable",
      message: "client closed",
      resource: "operation",
    });
    expect(app.calls.length).toBe(callsBefore);
    await unmount(root);
  });

  test("the callable identity survives renders, client arrival, and provider reconfiguration", async () => {
    const identities = new Set<unknown>();
    let renders = 0;
    let bump: (() => void) | null = null;
    function Probe(): ReactNode {
      const echo = useProcedure(api.tools.echo);
      const [, setTick] = useState(0);
      identities.add(echo);
      renders++;
      bump = () => setTick((tick) => tick + 1);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    const app_ = (sessionId: string): ReactNode => (
      <AckerDBProvider config={app.config({ clientSessionId: sessionId })}>
        <Probe />
      </AckerDBProvider>
    );

    root.render(app_("procedure-stability-1"));
    await until(() => renders >= 1, "the first render");
    const rendersAfterMount = renders;
    bump!();
    await until(() => renders > rendersAfterMount, "a state-driven re-render");

    // A changed configuration replaces the client but not the callable.
    const rendersBeforeReconfigure = renders;
    root.render(app_("procedure-stability-2"));
    await until(() => renders > rendersBeforeReconfigure, "the reconfigured render");

    expect(identities.size).toBe(1);
    await unmount(root);
  });

  test("a layout-effect call during reconfiguration never dispatches through the retired client", async () => {
    // Tag each lifetime's session frames so the dispatching client is
    // observable per request.
    const dispatches: string[] = [];
    const tagged = (tag: string, sessionId: string): AckerDBProviderConfig =>
      app.config({
        clientSessionId: sessionId,
        createWebSocket: (url) => observingSocket(url, () => dispatches.push(tag)),
      });

    // The owning parent passes the callable down; the child's layout effect
    // runs before every ancestor effect in the reconfiguration commit, which
    // is the earliest a caller can legally observe the new configuration.
    let settled: unknown = null;
    let echo: AckerDBProcedure<{ value: string }, string> | null = null;
    function LayoutCaller({
      fire,
      run,
    }: {
      fire: boolean;
      run: AckerDBProcedure<{ value: string }, string>;
    }): ReactNode {
      useLayoutEffect(() => {
        if (!fire) return;
        run({ value: "layout" }).then((result) => {
          settled = result.ok ? result.data : result.error;
        });
      }, [fire, run]);
      return null;
    }
    function Owner({ fire }: { fire: boolean }): ReactNode {
      echo = useProcedure(api.tools.echo);
      return <LayoutCaller fire={fire} run={echo} />;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={tagged("retired", "procedure-layout-1")}>
        <Owner fire={false} />
      </AckerDBProvider>,
    );
    // Prove the first lifetime committed and dispatches before retiring it.
    await until(() => echo !== null, "the captured callable");
    expect(mustOk(await echo!({ value: "warm" }))).toBe("WARM");
    expect(dispatches).toEqual(["retired"]);

    root.render(
      <AckerDBProvider config={tagged("replacement", "procedure-layout-2")}>
        <Owner fire={true} />
      </AckerDBProvider>,
    );
    await until(() => settled !== null, "the layout-effect call to settle");

    expect(settled).toBe("LAYOUT");
    expect(dispatches).toEqual(["retired", "replacement"]);
    await unmount(root);
  });

  test("an abort racing the arrival drain settles its call exactly once and never dispatches it", async () => {
    // Two calls queued before the client exists; the first one's dispatch
    // reaches the injected session synchronously inside the arrival drain and
    // aborts the second — after the queue was cleared, before the second
    // dispatch runs. Exactly one owner must settle the aborted call, and its
    // request must never reach the network.
    const controller = new AbortController();
    let dispatches = 0;
    const config = app.config({
      createWebSocket: (url) =>
        observingSocket(url, () => {
          dispatches++;
          controller.abort();
        }),
    });

    const settlements: Array<{ kind: "ok"; value: string } | { kind: "error"; error: unknown }> =
      [];
    function RaceOnMount(): ReactNode {
      const echo = useProcedure(api.tools.echo);
      useEffect(() => {
        echo({ value: "first" }).then((result) => {
          settlements.push(
            result.ok
              ? { kind: "ok", value: result.data }
              : { kind: "error", error: result.error },
          );
        });
        echo({ value: "second" }, { signal: controller.signal }).then((result) => {
          settlements.push(
            result.ok
              ? { kind: "ok", value: result.data }
              : { kind: "error", error: result.error },
          );
        });
      }, [echo]);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={config}>
        <RaceOnMount />
      </AckerDBProvider>,
    );
    await until(() => settlements.length === 2, "both racing settlements");

    expect(dispatches).toBe(1);
    expect(settlements).toContainEqual({ kind: "ok", value: "FIRST" });
    const canceled = settlements.find((entry) => entry.kind === "error");
    expect(canceled && "error" in canceled ? canceled.error : null).toMatchObject({
      name: "AckerDBClientError",
      code: "unavailable",
      message: "procedure request was canceled",
      resource: "operation",
    });
    await unmount(root);
  });

  test("an abort fired while encoding a queued call still settles it with the typed cancellation", async () => {
    // The argument getter aborts the caller's own signal mid-snapshot — after
    // the pre-queue abort check would have passed. The call must settle as
    // canceled rather than as a lifetime discard, even though the component
    // unmounts (via the layout-phase state update) before any client arrives.
    const controller = new AbortController();
    const args = {
      get value(): string {
        controller.abort();
        return "poison";
      },
    };
    let settled: unknown = null;
    function CallAndVanish({ vanish }: { readonly vanish: () => void }): ReactNode {
      const echo = useProcedure(api.tools.echo);
      useLayoutEffect(() => {
        echo(args, { signal: controller.signal }).then((result) => {
          settled = result.ok ? result.data : result.error;
        });
        vanish();
      }, [echo, vanish]);
      return null;
    }
    function Gate(): ReactNode {
      const [mounted, setMounted] = useState(true);
      const vanish = useCallback(() => setMounted(false), []);
      return mounted ? <CallAndVanish vanish={vanish} /> : null;
    }

    const callsBefore = app.calls.length;
    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <AckerDBProvider config={app.config()}>
        <Gate />
      </AckerDBProvider>,
    );
    await until(() => settled !== null, "the canceled call to settle");
    expect(settled).toMatchObject({
      name: "AckerDBClientError",
      code: "unavailable",
      message: "procedure request was canceled",
      resource: "operation",
    });
    expect(app.calls.length).toBe(callsBefore);
    await unmount(root);
  });

  test("useProcedure outside a provider fails loudly", async () => {
    const { Boundary, caught } = createBoundary();
    function Naked(): ReactNode {
      useProcedure(api.tools.echo);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <Boundary>
        <Naked />
      </Boundary>,
    );
    await until(() => container.textContent === "failed", "the error boundary");
    expect(String(caught())).toContain("useProcedure requires a <AckerDBProvider> ancestor");
    await unmount(root);
  });
});
