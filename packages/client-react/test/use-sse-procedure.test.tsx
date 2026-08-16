import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "ackerdb-test-support/dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyApi, decode, type SseRef } from "@ackerdb/core";
import type { AckerDBFetch, AckerDBWebSocket } from "@ackerdb/client";
import {
  type AckerDBServer,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  reconcile,
  sseProcedure,
  type SseCtx,
} from "@ackerdb/server";
import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AckerDBProvider,
  useConnectionState,
  useSseProcedure,
  type AckerDBClientError,
  type SseProcedureCall,
} from "@ackerdb/client-react";
import { deferred, until, waitForAbort } from "ackerdb-test-support/async";
import { listen } from "ackerdb-test-support/listen";

const schema = defineSchema({});

// Server-side journal: which ticks the handler produced, and per-procedure
// release markers proving the runtime returned the handler's iterator.
let producedTicks: number[] = [];
let holdStarted = deferred<void>();
let holdReleased = deferred<void>();
let holdAfterFirstReleased = deferred<void>();
let unmountHoldReleased = deferred<void>();

function registry(): Registry {
  return new Registry({
    stream: {
      grouped: sseProcedure({
        access: "public",
        http: true,
        args: {},
        yields: v.object({ tick: v.int() }),
        handler: async function* () {
          yield { tick: 0 };
        },
      }),
      ticks: sseProcedure({
        access: "public",
        http: true,
        args: { count: v.int() },
        yields: v.object({ tick: v.int() }),
        handler: async function* (_ctx: SseCtx, args: { count: number }) {
          for (let tick = 0; tick < args.count; tick++) {
            producedTicks.push(tick);
            yield { tick };
          }
        },
      }),
      invalid: sseProcedure({
        access: "public",
        http: true,
        args: {},
        yields: v.object({ value: v.string() }),
        handler: async function* () {
          yield { value: "first" };
          yield { value: 2 as unknown as string };
        },
      }),
      hold: sseProcedure({
        access: "public",
        http: true,
        args: {},
        yields: v.object({ phase: v.string() }),
        handler: async function* (ctx: SseCtx) {
          try {
            holdStarted.resolve(undefined);
            await waitForAbort(ctx.abortSignal);
          } finally {
            holdReleased.resolve(undefined);
          }
        },
      }),
      holdAfterFirst: sseProcedure({
        access: "public",
        http: true,
        args: {},
        yields: v.object({ phase: v.string() }),
        handler: async function* (ctx: SseCtx) {
          try {
            yield { phase: "one" };
            await waitForAbort(ctx.abortSignal);
          } finally {
            holdAfterFirstReleased.resolve(undefined);
          }
        },
      }),
      unmountHold: sseProcedure({
        access: "public",
        http: true,
        args: {},
        yields: v.object({ phase: v.string() }),
        handler: async function* (ctx: SseCtx) {
          try {
            yield { phase: "one" };
            await waitForAbort(ctx.abortSignal);
          } finally {
            unmountHoldReleased.resolve(undefined);
          }
        },
      }),
    },
  });
}

interface App {
  readonly base: string;
  readonly runtime: Runtime;
  readonly server: AckerDBServer;
  close(): Promise<void>;
}

async function createApp(): Promise<App> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-sse-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: registry(),
    limits: PRODUCTION_LIMITS,
  });
  await runtime.start();
  const server = listen(runtime);
  return {
    base: `http://127.0.0.1:${server.port}`,
    runtime,
    server,
    async close() {
      await server.drain().catch(() => {});
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The only AckerDB-owned HTTP route the client calls; every other is a stream. */
const SSE_ACK_PATH = "/_sse/ack";

// Records the exact order of SSE request and acknowledgement traffic; the
// stream body itself is untouched. Resolves `fetch` at call time: after
// ackerdb-test-support/dom registers happy-dom it restores Bun's native fetch.
function recordingFetch(log: string[]): AckerDBFetch {
  return (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === SSE_ACK_PATH) {
      const acknowledgment = decode(String(init?.body)) as { seq: number };
      log.push(`ack:${acknowledgment.seq}`);
    } else log.push("sse");
    return fetch(url, init);
  };
}

type AnyCall = SseProcedureCall<Record<string, unknown>, Record<string, unknown>>;

interface Mounted {
  /** The latest callable committed while the provider was ready. */
  call: AnyCall;
  /** Every callable observed across renders, in order. */
  readonly calls: AnyCall[];
  rerender(): void;
  unmount(): void;
}

async function mountSse(
  base: string,
  address: SseRef<Record<string, unknown>, Record<string, unknown>> | string,
  log: string[] = [],
): Promise<Mounted> {
  const calls: AnyCall[] = [];
  let phase = "";
  let bump: () => void = () => {};

  function Probe(): ReactNode {
    const state = useConnectionState();
    const call = useSseProcedure<Record<string, unknown>, Record<string, unknown>>(address);
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    if (calls.at(-1) !== call) calls.push(call);
    phase = state.phase;
    return null;
  }

  const container = mountPoint();
  const root: Root = createRoot(container);
  root.render(
    <AckerDBProvider
      config={{
        url: base,
        credential: { kind: "anonymous" },
        createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
        fetch: recordingFetch(log),
      }}
    >
      <Probe />
    </AckerDBProvider>,
  );
  await until(() => phase === "ready", "the provider to reach ready");
  return {
    get call() {
      return calls.at(-1)!;
    },
    calls,
    rerender: () => bump(),
    unmount: () => root.unmount(),
  };
}

let app: App;
const roots: Mounted[] = [];

beforeAll(async () => {
  app = await createApp();
});
afterAll(() => app.close());
beforeEach(() => {
  producedTicks = [];
  holdStarted = deferred<void>();
  holdReleased = deferred<void>();
  holdAfterFirstReleased = deferred<void>();
  unmountHoldReleased = deferred<void>();
});
afterEach(() => {
  while (roots.length > 0) roots.pop()!.unmount();
});

async function mount(
  address: SseRef<Record<string, unknown>, Record<string, unknown>> | string,
  log: string[] = [],
): Promise<Mounted> {
  const mounted = await mountSse(app.base, address, log);
  roots.push(mounted);
  return mounted;
}

describe("useSseProcedure against a real ackerdb server", () => {
  test("streams from the fixed-root address its reference names", async () => {
    const ref = anyApi.stream.grouped as SseRef<
      Record<string, unknown>,
      { tick: number }
    >;
    const mounted = await mount(ref as never);
    const reader = mounted.call({}).getReader();
    expect(await reader.read()).toEqual({ done: false, value: { tick: 0 } });
    await reader.cancel();

    // The callable's identity survives a rerender, exactly as it does for a
    // plain address.
    const before = mounted.call;
    mounted.rerender();
    await until(() => mounted.calls.length > 0, "a committed render");
    expect(mounted.call).toBe(before);
  });

  test("pull-driven chunks with exact acknowledgement order and no read-ahead", async () => {
    const log: string[] = [];
    const mounted = await mount("api.stream.ticks", log);
    const stream = mounted.call({ count: 3 });
    expect(stream).toBeInstanceOf(ReadableStream);

    // No pull yet: the request has not been sent and no chunk was produced.
    await Bun.sleep(20);
    expect(log).toEqual([]);
    expect(producedTicks).toEqual([]);

    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: { tick: 0 } });
    expect(log).toEqual(["sse"]);
    expect(producedTicks).toEqual([0]);

    // Each downstream pull credits the previous chunk, which is what lets
    // the server generator produce the next one.
    expect(await reader.read()).toEqual({ done: false, value: { tick: 1 } });
    expect(log).toEqual(["sse", "ack:1"]);
    expect(producedTicks).toEqual([0, 1]);

    expect(await reader.read()).toEqual({ done: false, value: { tick: 2 } });
    expect(log).toEqual(["sse", "ack:1", "ack:2"]);
    expect(producedTicks).toEqual([0, 1, 2]);

    // The final pull credits the last chunk and the terminal frame.
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(log).toEqual(["sse", "ack:1", "ack:2", "ack:3", "ack:4"]);
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
  });

  test("cancel before the first pull never contacts the server", async () => {
    const log: string[] = [];
    const mounted = await mount("api.stream.ticks", log);
    const stream = mounted.call({ count: 3 });
    await stream.cancel("never started");
    await Bun.sleep(20);
    expect(log).toEqual([]);
    expect(producedTicks).toEqual([]);
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("cancel before the first chunk aborts the request and releases the server iterator", async () => {
    const log: string[] = [];
    const mounted = await mount("api.stream.hold", log);
    const stream = mounted.call({});
    const reader = stream.getReader();
    const pending = reader.read();
    await holdStarted.promise;
    expect(log).toEqual(["sse"]);

    await reader.cancel("stopped before first chunk");
    // The lone terminal outcome: the pending read resolves closed.
    expect(await pending).toEqual({ done: true, value: undefined });
    await holdReleased.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
    expect(log).toEqual(["sse"]);
  });

  test("cancel between chunks releases the server iterator promptly", async () => {
    const log: string[] = [];
    const mounted = await mount("api.stream.holdAfterFirst", log);
    const stream = mounted.call({});
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: { phase: "one" } });

    await reader.cancel("stopped between chunks");
    await holdAfterFirstReleased.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(log).toEqual(["sse"]);
  });

  test("an invalid chunk fails the stream with the exact validation error", async () => {
    const mounted = await mount("api.stream.invalid");
    const reader = mounted.call({}).getReader();
    expect(await reader.read()).toEqual({ done: false, value: { value: "first" } });

    const failure = await reader.read().then(
      () => {
        throw new Error("the invalid chunk must not be delivered");
      },
      (error: AckerDBClientError) => error,
    );
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("validation");
    expect(failure.message).toBe("chunk.value: expected string, got number");
    // One terminal outcome: the stream stays failed with the same error.
    expect(await reader.read().catch((error: unknown) => error)).toBe(failure);
  });

  test("server disconnect fails the stream once with the typed outcome and never restarts", async () => {
    const local = await createApp();
    const log: string[] = [];
    const mounted = await mountSse(local.base, "api.stream.hold", log);
    try {
      const stream = mounted.call({});
      const reader = stream.getReader();
      const pending = reader.read();
      await holdStarted.promise;

      const drained = local.server.drain();
      const failure = await pending.then(
        () => {
          throw new Error("disconnect must fail the read");
        },
        (error: AckerDBClientError) => error,
      );
      expect(failure.name).toBe("AckerDBClientError");
      expect(failure.code).toBe("draining");
      await holdReleased.promise;

      // Cancel during the disconnect settles against the already-failed
      // stream without producing a second outcome or a new request.
      expect(await reader.cancel("late cancel").catch((error: unknown) => error)).toBe(failure);
      expect(await reader.read().catch((error: unknown) => error)).toBe(failure);
      expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);
      await drained;
    } finally {
      mounted.unmount();
      await local.close();
    }
  });

  test("provider shutdown settles an open stream with a typed error and no restart", async () => {
    const log: string[] = [];
    const mounted = await mount("api.stream.unmountHold", log);
    const stream = mounted.call({});
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: { phase: "one" } });

    mounted.unmount();
    const failure = await reader.read().then(
      () => {
        throw new Error("shutdown must fail the read");
      },
      (error: AckerDBClientError) => error,
    );
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("unavailable");
    await unmountHoldReleased.promise;
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);
  });

  test("the callable is stable across rerenders and errors before the client exists", async () => {
    const mounted = await mount("api.stream.ticks");
    const ready = mounted.call;
    mounted.rerender();
    await Bun.sleep(20);
    mounted.rerender();
    await Bun.sleep(20);
    expect(mounted.call).toBe(ready);

    // The first render happened before the provider committed its client;
    // that callable reports the typed unavailable error through the stream.
    expect(mounted.calls.length).toBeGreaterThan(1);
    const beforeClient = mounted.calls[0]!;
    expect(beforeClient).not.toBe(ready);
    const failure = await beforeClient({})
      .getReader()
      .read()
      .then(
        () => {
          throw new Error("the pre-client callable must fail");
        },
        (error: AckerDBClientError) => error,
      );
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("unavailable");
    expect(failure.message).toBe("the provider has not created its client yet");
  });
});
