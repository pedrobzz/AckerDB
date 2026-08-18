import { parseSentFrame } from "ackerdb-test-support/client-transport";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, testDefinitions } from "ackerdb-test-support/server";
import { NativeWebSocket, mountPoint } from "ackerdb-test-support/dom";
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
  v,
  defineSchema,
  defineTable,
  procedure,
  reconcile,
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
  type AckerDBProcedure,
  type AckerDBProviderConfig,
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
    echo: { $ref: "api.tools.echo" } as ProcedureRef<{ value: string }, string>,
    fail: { $ref: "api.tools.fail" } as ProcedureRef<Record<never, never>, never>,
    block: { $ref: "api.tools.block" } as ProcedureRef<Record<never, never>, string>,
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

async function createApp(): Promise<App> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-procedure-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const calls: RecordedCall[] = [];
  const modules = {
    tools: {
      echo: procedure({
        access: "public",
        args: { value: v.string() },
        handler: (ctx: Ctx, args: Ctx) => {
          calls.push({ signal: ctx.abortSignal });
          return args.value.toUpperCase();
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
  };
  const running = await startTestServer({
    engine,
    definitions: testDefinitions(modules),
    limits: PRODUCTION_LIMITS,
  });
  const base = running.base;
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
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function observingSocket(url: string, onProcedure: () => void): AckerDBWebSocket {
  const native = new NativeWebSocket(url);
  let sent = 0;
  const socket: AckerDBWebSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (parseSentFrame(data, sent++).t === "p") onProcedure();
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
beforeAll(async () => {
  app = await createApp();
});
afterAll(() => app.close());

describe("useProcedure against a real ackerdb server", () => {
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
