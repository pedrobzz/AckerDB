import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbzzWebSocket, ProcedureRef } from "@dbzz/client";
import {
  DbzzError,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  dbz,
  defineSchema,
  defineTable,
  procedure,
  reconcile,
  serve,
} from "@dbzz/server";
import {
  Component,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DbzzProvider,
  useProcedure,
  type DbzzProcedure,
  type DbzzProviderConfig,
} from "@dbzz/client-react";

const schema = defineSchema({
  messages: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// Typed references as codegen would emit them for the registry below.
const api = {
  tools: {
    echo: { $ref: "tools.echo" } as ProcedureRef<{ value: string }, string>,
    fail: { $ref: "tools.fail" } as ProcedureRef<Record<never, never>, never>,
    block: { $ref: "tools.block" } as ProcedureRef<Record<never, never>, string>,
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

// Per-call gates for tools.block so tests can hold a real request in flight.
let blockStarted: Deferred<void> | null = null;
let blockRelease: Deferred<void> | null = null;

interface RecordedCall {
  readonly signal: AbortSignal | undefined;
}

interface App {
  readonly base: string;
  /** Every /api/call dispatch the client actually made, in order. */
  readonly calls: RecordedCall[];
  config(overrides?: Partial<DbzzProviderConfig>): DbzzProviderConfig;
  close(): Promise<void>;
}

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "dbzz-react-procedure-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
    tools: {
      echo: procedure({
        access: "public",
        args: { value: dbz.string() },
        handler: (_ctx: Ctx, args: Ctx) => args.value.toUpperCase(),
      }),
      fail: procedure({
        access: "public",
        args: {},
        handler: () => {
          throw new DbzzError("conflict", "flux capacitor offline");
        },
      }),
      block: procedure({
        access: "public",
        args: {},
        handler: async () => {
          blockStarted?.resolve();
          await blockRelease?.promise;
          return "released";
        },
      }),
    },
  });
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS, telemetry: false });
  const server = serve({ runtime, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const calls: RecordedCall[] = [];
  return {
    base,
    calls,
    config(overrides) {
      return {
        url: base,
        credential: { kind: "anonymous" },
        createWebSocket: (url) => new NativeWebSocket(url) as unknown as DbzzWebSocket,
        fetch: (url, init) => {
          if (url.endsWith("/api/call")) calls.push({ signal: init?.signal ?? undefined });
          return fetch(url, init);
        },
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

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
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

describe("useProcedure against a real dbzz server", () => {
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
        echo({ value: "hi" }).then(
          (value) => {
            settlements.push({ kind: "ok", value });
            setText(value);
          },
          (error) => {
            settlements.push({ kind: "error", error });
          },
        );
      }, [echo]);
      return <output>{text}</output>;
    }

    const callsBefore = app.calls.length;
    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <DbzzProvider config={app.config()}>
          <EchoOnMount />
        </DbzzProvider>
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
    let echo: DbzzProcedure<{ value: string }, string> | null = null;
    let fail: DbzzProcedure<Record<never, never>, never> | null = null;
    function Capture(): ReactNode {
      echo = useProcedure(api.tools.echo);
      fail = useProcedure(api.tools.fail);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <DbzzProvider config={app.config()}>
        <Capture />
      </DbzzProvider>,
    );
    await until(() => echo !== null && fail !== null, "the captured callables");

    expect(await echo!({ value: "quiet" })).toBe("QUIET");

    const failure = await fail!({}).catch((error) => error);
    expect(failure).toMatchObject({
      name: "DbzzClientError",
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
    let block: DbzzProcedure<Record<never, never>, string> | null = null;
    function Capture(): ReactNode {
      block = useProcedure(api.tools.block);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <DbzzProvider config={app.config()}>
        <Capture />
      </DbzzProvider>,
    );
    await until(() => block !== null, "the captured callable");

    const callsBefore = app.calls.length;
    const controller = new AbortController();
    const completion = block!({}, { signal: controller.signal }).catch((error) => error);
    await blockStarted.promise; // the real server handler is executing

    controller.abort();
    // The handler is still blocked, so prompt settlement proves the abort
    // traveled through the client's fetch rather than waiting on the server.
    await settlesWithin(completion, 500, "the aborted procedure");
    expect(await completion).toMatchObject({
      name: "DbzzClientError",
      code: "indeterminate",
      resource: "operation",
    });
    expect(app.calls.length - callsBefore).toBe(1);
    expect(app.calls.at(-1)!.signal?.aborted).toBe(true);

    // A signal aborted before the call never dispatches a request at all.
    const preAborted = await block!({}, { signal: controller.signal }).catch((error) => error);
    expect(preAborted).toMatchObject({
      name: "DbzzClientError",
      code: "unavailable",
      message: "procedure request was canceled",
      resource: "operation",
    });
    expect(app.calls.length - callsBefore).toBe(1);

    blockRelease.resolve();
    await unmount(root);
  });

  test("a disconnected procedure reports the typed outcome and is never silently replayed", async () => {
    // A real dbzz server that has come and gone: its port now refuses every
    // connection, so the failure happens at the network rather than through a
    // fake transport. (Draining the shared server instead would leave Bun's
    // keep-alive pool racing the shutdown and make the outcome nondeterministic.)
    const island = createApp();
    await island.close();
    let echo: DbzzProcedure<{ value: string }, string> | null = null;
    function Capture(): ReactNode {
      echo = useProcedure(api.tools.echo);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <DbzzProvider config={island.config({ reconnect: { baseDelayMs: 2_500, maxDelayMs: 10_000 } })}>
        <Capture />
      </DbzzProvider>,
    );
    await until(() => echo !== null, "the captured callable");

    const failure = await echo!({ value: "down" }).catch((error) => error);
    expect(failure).toMatchObject({
      name: "DbzzClientError",
      code: "indeterminate",
      message: "procedure completion is unknown",
      resource: "operation",
    });
    // Exactly one dispatch: dbzz cannot prove a safe replay, so none happens.
    expect(island.calls.length).toBe(1);
    await unmount(root);
  });

  test("provider shutdown settles an in-flight call and stale callables report the closed client", async () => {
    blockStarted = deferred();
    blockRelease = deferred();
    let block: DbzzProcedure<Record<never, never>, string> | null = null;
    let echo: DbzzProcedure<{ value: string }, string> | null = null;
    function Capture(): ReactNode {
      block = useProcedure(api.tools.block);
      echo = useProcedure(api.tools.echo);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <DbzzProvider config={app.config()}>
        <Capture />
      </DbzzProvider>,
    );
    await until(() => block !== null && echo !== null, "the captured callables");

    const completion = block!({}).catch((error) => error);
    await blockStarted.promise;

    await unmount(root);
    // close() aborts the in-flight fetch; the handler is still blocked.
    await settlesWithin(completion, 500, "the provider-closed procedure");
    expect(await completion).toMatchObject({
      name: "DbzzClientError",
      code: "indeterminate",
      resource: "operation",
    });

    // A stale callable after shutdown settles locally in the hook: its
    // ownership ended with the component, so nothing dispatches.
    const callsBefore = app.calls.length;
    const stale = await echo!({ value: "late" }).catch((error) => error);
    expect(stale).toMatchObject({
      name: "DbzzClientError",
      code: "unavailable",
      message: "client closed",
      resource: "operation",
    });
    expect(app.calls.length).toBe(callsBefore);

    blockRelease.resolve();
  });

  test("a callable retained past its consumer's unmount settles locally while the provider lives on", async () => {
    let echo: DbzzProcedure<{ value: string }, string> | null = null;
    function Capture(): ReactNode {
      echo = useProcedure(api.tools.echo);
      return null;
    }
    function Host({ mounted }: { mounted: boolean }): ReactNode {
      return <DbzzProvider config={app.config()}>{mounted ? <Capture /> : null}</DbzzProvider>;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(<Host mounted={true} />);
    await until(() => echo !== null, "the captured callable");
    expect(await echo!({ value: "alive" })).toBe("ALIVE");

    root.render(<Host mounted={false} />);
    await Bun.sleep(20); // the consumer's unmount commit, provider untouched
    const callsBefore = app.calls.length;
    const stale = await echo!({ value: "late" }).catch((error) => error);
    expect(stale).toMatchObject({
      name: "DbzzClientError",
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
      <DbzzProvider config={app.config({ clientSessionId: sessionId })}>
        <Probe />
      </DbzzProvider>
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
    // Tag each lifetime with its own fetch recorder so the dispatching client
    // is observable per request.
    const dispatches: string[] = [];
    const tagged = (tag: string, sessionId: string): DbzzProviderConfig =>
      app.config({
        clientSessionId: sessionId,
        fetch: (url, init) => {
          if (url.endsWith("/api/call")) dispatches.push(tag);
          return fetch(url, init);
        },
      });

    // The owning parent passes the callable down; the child's layout effect
    // runs before every ancestor effect in the reconfiguration commit, which
    // is the earliest a caller can legally observe the new configuration.
    let settled: unknown = null;
    function LayoutCaller({
      fire,
      run,
    }: {
      fire: boolean;
      run: DbzzProcedure<{ value: string }, string>;
    }): ReactNode {
      useLayoutEffect(() => {
        if (!fire) return;
        run({ value: "layout" }).then(
          (value) => {
            settled = value;
          },
          (error) => {
            settled = error;
          },
        );
      }, [fire, run]);
      return null;
    }
    function Owner({ fire }: { fire: boolean }): ReactNode {
      const echo = useProcedure(api.tools.echo);
      return <LayoutCaller fire={fire} run={echo} />;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <DbzzProvider config={tagged("retired", "procedure-layout-1")}>
        <Owner fire={false} />
      </DbzzProvider>,
    );
    await until(() => dispatches.length === 0 && container !== null, "the first commit");

    root.render(
      <DbzzProvider config={tagged("replacement", "procedure-layout-2")}>
        <Owner fire={true} />
      </DbzzProvider>,
    );
    await until(() => settled !== null, "the layout-effect call to settle");

    expect(settled).toBe("LAYOUT");
    expect(dispatches).toEqual(["replacement"]);
    await unmount(root);
  });

  test("useProcedure outside a provider fails loudly", async () => {
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
    expect(String(caught)).toContain("useProcedure requires a <DbzzProvider> ancestor");
    await unmount(root);
  });
});
