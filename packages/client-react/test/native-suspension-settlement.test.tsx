/**
 * ISSUE-13 at the React layer, driven through the native entry: real ackerdb
 * server, real AI SDK `useChat`, and platform suspension delivered through
 * the mocked React Native AppState. Backgrounding must terminate AI
 * generations as cancellation (never a false error), settle generic SSE
 * `ReadableStream`s with one suspension-marked terminal outcome while the
 * server iterator is released, and leave resumable query recovery entirely
 * independent of those terminal settlements.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
// Registers happy-dom before any React module loads — every test file in this
// suite must do this first (see ./support/dom.ts).
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { FakeAppState, setAppState } from "./support/app-state.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@ackerdb/core";
import {
  AckerDBClient,
  AckerDBClientError,
  type AckerDBFetch,
  type AckerDBWebSocket,
  type QueryRef,
  type SseRef,
} from "@ackerdb/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
  serve,
  sseProcedure,
  type SseCtx,
} from "@ackerdb/server";
import type { UIMessage, UIMessageChunk } from "ai";
import { useChat } from "@ai-sdk/react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AckerDBQueryState, SseProcedureCall } from "@ackerdb/client-react";
import { uiMessageChunk } from "./ai/ui-message-chunk.ts";

// The native entry composes the Expo/React Native platform modules, which
// only exist inside a React Native app; mocks stand in for all three. The
// AppState fake is shared with the other native suites so every file
// registers the same module identity. Expo fetch never engages here — these
// tests inject the real network stack explicitly, as an application could.
mock.module("react-native", () => ({ AppState: FakeAppState }));
mock.module("expo/fetch", () => ({
  fetch: () => Promise.reject(new Error("expo fetch is unused in this suite")),
}));
mock.module("expo-crypto", () => ({
  getRandomValues: (array: Uint32Array) => {
    array[0] = 0;
    return array;
  },
}));

const { AckerDBProvider, useConnectionState, useQuery, useSseProcedure } = await import(
  "../src/index.native.ts"
);
const { useChatTransport } = await import("../src/ai/index.ts");

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// Server-side journals: per-procedure release markers proving the runtime
// returned each handler's iterator when suspension canceled its stream.
let aiHoldStarted = deferred<void>();
let aiHoldReleased = deferred<void>();
let aiMidReleases: Array<Deferred<void>> = [];
let genericReleases: Array<Deferred<void>> = [];

const standardArgs = {
  trigger: v.string(),
  chatId: v.string(),
  messageId: v.string().nullable(),
  messages: v.jsonb<UIMessage[]>(),
};

function registry(): Registry {
  return new Registry({
    messages: {
      list: query({
        access: "public",
        args: {},
        handler: (ctx: Ctx) => ctx.db.messages.query().collect(),
      }),
      add: mutation({
        access: "public",
        args: { body: v.string() },
        handler: (ctx: Ctx, args: Ctx) => ctx.db.messages.insert({ body: args.body }),
      }),
    },
    ai: {
      holdBeforeFirst: sseProcedure({
        access: "public",
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: async function* (ctx: SseCtx): AsyncGenerator<UIMessageChunk, void, undefined> {
          try {
            aiHoldStarted.resolve(undefined);
            await waitForAbort(ctx.abortSignal);
          } finally {
            aiHoldReleased.resolve(undefined);
          }
        },
      }),
      // Holds mid-generation inside a streaming tool invocation, so
      // backgrounding lands in the middle of an AI tool flow — the chunk
      // family the settlement path must be indifferent to.
      holdMidStream: sseProcedure({
        access: "public",
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: async function* (ctx: SseCtx): AsyncGenerator<UIMessageChunk, void, undefined> {
          const released = deferred<void>();
          aiMidReleases.push(released);
          try {
            yield { type: "start" };
            yield { type: "text-start", id: "h1" };
            yield { type: "text-delta", id: "h1", delta: "partial" };
            yield { type: "text-end", id: "h1" };
            yield { type: "tool-input-start", toolCallId: "call1", toolName: "search" };
            yield { type: "tool-input-delta", toolCallId: "call1", inputTextDelta: '{"q":' };
            await waitForAbort(ctx.abortSignal);
          } finally {
            released.resolve(undefined);
          }
        },
      }),
    },
    stream: {
      holdAfterFirst: sseProcedure({
        access: "public",
        args: {},
        yields: v.object({ phase: v.string() }),
        handler: async function* (ctx: SseCtx) {
          const released = deferred<void>();
          genericReleases.push(released);
          try {
            yield { phase: "one" };
            await waitForAbort(ctx.abortSignal);
          } finally {
            released.resolve(undefined);
          }
        },
      }),
    },
  });
}

interface App {
  readonly base: string;
  readonly runtime: Runtime;
  close(): Promise<void>;
}

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-native-settlement-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: registry(),
    limits: PRODUCTION_LIMITS,
    telemetry: false,
  });
  const server = serve({ runtime, port: 0 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    runtime,
    async close() {
      await server.drain().catch(() => {});
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Records SSE request and acknowledgement traffic so the tests can prove no
// hidden replacement stream starts and no acknowledgement leaks after
// settlement. Resolves `fetch` at call time: after support/dom.ts registers
// happy-dom it restores Bun's native fetch.
function recordingFetch(log: string[]): AckerDBFetch {
  return (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/sse") log.push("sse");
    else if (pathname === "/api/sse/ack") {
      const acknowledgment = decode(String(init?.body)) as { seq: number };
      log.push(`ack:${acknowledgment.seq}`);
    }
    return fetch(url, init);
  };
}

type Message = { readonly id: bigint; readonly body: string };
const messagesList = { $ref: "messages.list" } as QueryRef<Record<never, never>, Message[]>;
type StandardRef = SseRef<
  { trigger: string; chatId: string; messageId: string | null; messages: UIMessage[] },
  UIMessageChunk
>;

function describeQuery(state: AckerDBQueryState<Message[]>): string {
  switch (state.status) {
    case "disabled":
    case "pending":
      return state.status;
    case "success":
      return `fresh:${state.data.map((row) => row.body).join(",")}`;
    case "rejected":
      return `error:${state.error.code}`;
    case "unavailable":
      return state.data === undefined
        ? `error:${state.error.code}`
        : `stale:${state.data.map((row) => row.body).join(",")}`;
  }
}

/** How the AI SDK settled one request, as reported through onFinish. */
interface Settled {
  readonly isAbort: boolean;
  readonly isError: boolean;
  readonly isDisconnect: boolean;
}

let app: App;
const roots: Root[] = [];

beforeAll(async () => {
  app = createApp();
  // Real data behind the mounted query, seeded through an ordinary client.
  const writer = new AckerDBClient({ url: app.base, credential: { kind: "anonymous" } });
  await writer.mutation("messages.add", { body: "one" });
  writer.close();
});
afterAll(() => app.close());
beforeEach(() => {
  setAppState("active");
  aiHoldStarted = deferred<void>();
  aiHoldReleased = deferred<void>();
  aiMidReleases = [];
  genericReleases = [];
});
afterEach(() => {
  setAppState("active");
  while (roots.length > 0) roots.pop()!.unmount();
});

function providerConfig(log: string[]): Parameters<typeof AckerDBProvider>[0]["config"] {
  return {
    url: app.base,
    credential: { kind: "anonymous" },
    createWebSocket: (url: string) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
    fetch: recordingFetch(log),
  };
}

describe("suspension settlement through the native entry against a real server", () => {
  test("backgrounding terminates the AI generation as abort while the query recovers stale to fresh", async () => {
    const log: string[] = [];
    let phase = "";
    let queryText = "";
    let chat: ReturnType<typeof useChat<UIMessage>> | undefined;
    const errors: Error[] = [];
    const finishes: Settled[] = [];

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      queryText = describeQuery(useQuery(messagesList, {}));
      const transport = useChatTransport({ $ref: "ai.holdMidStream" } as StandardRef);
      chat = useChat<UIMessage>({
        id: "native-independence",
        transport,
        onError: (error) => errors.push(error),
        onFinish: ({ isAbort, isError, isDisconnect }) =>
          finishes.push({ isAbort, isError, isDisconnect }),
      });
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider config={providerConfig(log)}>
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready" && queryText === "fresh:one", "ready with fresh data");

    // A generation is mid-stream — parked inside a streaming tool
    // invocation — while the query is live.
    void chat!.sendMessage({ text: "go" });
    await until(() => {
      const last = chat!.messages.at(-1);
      return (
        last?.role === "assistant" &&
        last.parts.some((part) => part.type === "text" && part.text === "partial") &&
        last.parts.some((part) => part.type === "tool-search")
      );
    }, "the partial text and tool flow to stream");
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);

    setAppState("background");
    // The non-resumable generation settles as cancellation: no false error.
    await until(() => finishes.length === 1, "the generation to settle");
    expect(finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
    expect(errors).toEqual([]);
    expect(chat!.error).toBeUndefined();
    // Cancellation reached the source iterator and released the server side.
    await aiMidReleases[0]!.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
    // The streamed tokens are kept; the request is over.
    await until(() => chat!.status === "ready", "the chat to settle");
    // The resumable query is independent: retained as stale, not terminated.
    await until(() => queryText === "stale:one", "the query to go stale");
    expect(phase).toBe("suspended");

    setAppState("active");
    // Foreground recovery is the query's exact resume protocol...
    await until(() => queryText === "fresh:one", "the query to confirm fresh");
    expect(phase).toBe("ready");
    // ...and no hidden stream restarts the settled generation.
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);
    await chat!.resumeStream();
    await Bun.sleep(20);
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);
    expect(chat!.status).toBe("ready");
    expect(errors).toEqual([]);

    // New work after activation is ordinary: a fresh generation streams.
    void chat!.sendMessage({ text: "again" });
    await until(() => aiMidReleases.length === 2, "a fresh generation to start");
    await until(() => log.filter((entry) => entry === "sse").length === 2, "its request");
    await chat!.stop();
    await aiMidReleases[1]!.promise;
    await until(() => app.runtime.status().activeSse === 0, "the fresh stream to settle");
  });

  test("backgrounding before the first AI chunk settles as abort and releases the held iterator", async () => {
    const log: string[] = [];
    let phase = "";
    let chat: ReturnType<typeof useChat<UIMessage>> | undefined;
    const errors: Error[] = [];
    const finishes: Settled[] = [];

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      const transport = useChatTransport({ $ref: "ai.holdBeforeFirst" } as StandardRef);
      chat = useChat<UIMessage>({
        id: "native-hold-before",
        transport,
        onError: (error) => errors.push(error),
        onFinish: ({ isAbort, isError, isDisconnect }) =>
          finishes.push({ isAbort, isError, isDisconnect }),
      });
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider config={providerConfig(log)}>
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready", "the provider to reach ready");

    void chat!.sendMessage({ text: "never answered" });
    await aiHoldStarted.promise;

    setAppState("background");
    await until(() => finishes.length === 1, "the generation to settle");
    expect(finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
    expect(errors).toEqual([]);
    await aiHoldReleased.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");

    setAppState("active");
    await until(() => phase === "ready", "foreground recovery");
    await Bun.sleep(20);
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);
  });

  test("a replacement generation sent immediately after activation is owned by itself, not the settled predecessor", async () => {
    const log: string[] = [];
    let phase = "";
    let chat: ReturnType<typeof useChat<UIMessage>> | undefined;
    const errors: Error[] = [];
    const finishes: Settled[] = [];

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      const transport = useChatTransport({ $ref: "ai.holdMidStream" } as StandardRef);
      chat = useChat<UIMessage>({
        id: "native-replacement",
        transport,
        onError: (error) => errors.push(error),
        onFinish: ({ isAbort, isError, isDisconnect }) =>
          finishes.push({ isAbort, isError, isDisconnect }),
      });
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider config={providerConfig(log)}>
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready", "the provider to reach ready");

    void chat!.sendMessage({ text: "first" });
    await until(() => {
      const last = chat!.messages.at(-1);
      return (
        last?.role === "assistant" &&
        last.parts.some((part) => part.type === "text" && part.text === "partial")
      );
    }, "the first generation to stream");

    // The tightest deterministic race: background, activate, and send the
    // replacement in one turn — the predecessor's settlement is still
    // propagating when the replacement dispatches.
    setAppState("background");
    setAppState("active");
    void chat!.sendMessage({ text: "second" });

    // The replacement starts as its own fresh generation on the server...
    await until(() => aiMidReleases.length === 2, "the replacement generation to start");
    // ...while the predecessor settles exactly once, as cancellation.
    await until(() => finishes.length === 1, "the predecessor to settle");
    expect(finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
    await aiMidReleases[0]!.promise;

    // The predecessor's settlement did not settle or corrupt the replacement:
    // it is still streaming and still cancellable on its own terms.
    await until(() => {
      const last = chat!.messages.at(-1);
      return (
        last?.role === "assistant" &&
        last.parts.some((part) => part.type === "text" && part.text === "partial")
      );
    }, "the replacement to stream its own chunks");
    await chat!.stop();
    await aiMidReleases[1]!.promise;
    await until(() => finishes.length === 2, "the replacement to settle by its own stop");
    expect(finishes[1]).toEqual({ isAbort: true, isError: false, isDisconnect: false });
    expect(errors).toEqual([]);
    expect(chat!.error).toBeUndefined();
    await until(() => app.runtime.status().activeSse === 0, "all server streams to settle");
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse", "sse"]);
  });

  test("a chat message sent while suspended settles as abort without dispatching any request", async () => {
    const log: string[] = [];
    let phase = "";
    let chat: ReturnType<typeof useChat<UIMessage>> | undefined;
    const errors: Error[] = [];
    const finishes: Settled[] = [];

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      const transport = useChatTransport({ $ref: "ai.holdBeforeFirst" } as StandardRef);
      chat = useChat<UIMessage>({
        id: "native-send-suspended",
        transport,
        onError: (error) => errors.push(error),
        onFinish: ({ isAbort, isError, isDisconnect }) =>
          finishes.push({ isAbort, isError, isDisconnect }),
      });
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider config={providerConfig(log)}>
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready", "the provider to reach ready");

    setAppState("background");
    await until(() => phase === "suspended", "the suspended phase");

    // The suspended client refuses the non-resumable generation promptly and
    // determinately; the AI SDK settles it as cancellation, never an error.
    void chat!.sendMessage({ text: "sent from the background" });
    await until(() => finishes.length === 1, "the refused generation to settle");
    expect(finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
    expect(errors).toEqual([]);
    expect(chat!.error).toBeUndefined();
    expect(log).toEqual([]);

    // Activation restarts nothing: the send was settled, not queued.
    setAppState("active");
    await until(() => phase === "ready", "foreground recovery");
    await Bun.sleep(20);
    expect(log).toEqual([]);
    expect(chat!.status).toBe("ready");
  });

  test("backgrounding while the server's error body is still streaming settles as abort", async () => {
    // The stream request was rejected (503) but its error body is still
    // arriving when the app backgrounds: the AI SDK must settle the
    // generation as cancellation, never as an error it reports to the user.
    let rejectedBodyDispatched = false;
    const scriptedFetch: AckerDBFetch = (url, init) => {
      if (new URL(url).pathname === "/api/sse") {
        rejectedBodyDispatched = true;
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 503 }),
        );
      }
      return fetch(url, init);
    };
    let phase = "";
    let chat: ReturnType<typeof useChat<UIMessage>> | undefined;
    const errors: Error[] = [];
    const finishes: Settled[] = [];

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      const transport = useChatTransport({ $ref: "ai.holdBeforeFirst" } as StandardRef);
      chat = useChat<UIMessage>({
        id: "native-error-body",
        transport,
        onError: (error) => errors.push(error),
        onFinish: ({ isAbort, isError, isDisconnect }) =>
          finishes.push({ isAbort, isError, isDisconnect }),
      });
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider
        config={{
          url: app.base,
          credential: { kind: "anonymous" },
          createWebSocket: (url: string) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
          fetch: scriptedFetch,
        }}
      >
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready", "the provider to reach ready");

    void chat!.sendMessage({ text: "rejected slowly" });
    await until(() => rejectedBodyDispatched, "the rejected stream request");
    await Bun.sleep(10);

    setAppState("background");
    await until(() => finishes.length === 1, "the generation to settle");
    expect(finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
    expect(errors).toEqual([]);
    expect(chat!.error).toBeUndefined();

    setAppState("active");
    await until(() => phase === "ready", "foreground recovery");
    expect(chat!.status).toBe("ready");
  });

  test("backgrounding during a pending pull settles the generic stream once with the marked outcome", async () => {
    const log: string[] = [];
    let phase = "";
    let call: SseProcedureCall<Record<never, never>, { phase: string }> | undefined;

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      call = useSseProcedure<Record<never, never>, { phase: string }>("stream.holdAfterFirst");
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider config={providerConfig(log)}>
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready", "the provider to reach ready");

    const reader = call!({}).getReader();
    expect(await reader.read()).toEqual({ done: false, value: { phase: "one" } });
    const pending = reader.read();

    setAppState("background");
    // The pending pull settles promptly with the suspension-marked outcome.
    const failure = await pending.then(
      () => {
        throw new Error("suspension must fail the pending read");
      },
      (error: AckerDBClientError) => error,
    );
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("unavailable");
    expect(failure.message).toBe("SSE stream was interrupted by suspension");
    expect(failure.interruption).toBe("suspension");
    // Exactly one terminal outcome: the stream stays failed with that error.
    expect(await reader.read().catch((error: unknown) => error)).toBe(failure);
    // The source iterator was released on the server.
    await genericReleases[0]!.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");

    setAppState("active");
    await until(() => phase === "ready", "foreground recovery");
    await Bun.sleep(20);
    expect(log.filter((entry) => entry === "sse")).toEqual(["sse"]);
  });

  test("backgrounding with an unacknowledged chunk outstanding releases both sides eagerly", async () => {
    const log: string[] = [];
    let phase = "";
    let call: SseProcedureCall<Record<never, never>, { phase: string }> | undefined;

    function Probe(): ReactNode {
      phase = useConnectionState().phase;
      call = useSseProcedure<Record<never, never>, { phase: string }>("stream.holdAfterFirst");
      return null;
    }

    const root = createRoot(mountPoint());
    roots.push(root);
    root.render(
      <AckerDBProvider config={providerConfig(log)}>
        <Probe />
      </AckerDBProvider>,
    );
    await until(() => phase === "ready", "the provider to reach ready");

    // A slow downstream consumer: chunk one is held, its credit not yet sent
    // (each pull credits the previous chunk), and no further pull is pending.
    const reader = call!({}).getReader();
    expect(await reader.read()).toEqual({ done: false, value: { phase: "one" } });
    expect(log).toEqual(["sse"]);

    setAppState("background");
    // Release does not wait for the consumer: the server iterator returns and
    // the stream's acknowledgement state is dropped on both sides eagerly.
    await genericReleases[0]!.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
    expect(log).toEqual(["sse"]);

    // The consumer's next pull observes the marked terminal outcome, and the
    // outstanding acknowledgement is never sent late.
    const failure = await reader.read().then(
      () => {
        throw new Error("suspension must fail the next read");
      },
      (error: AckerDBClientError) => error,
    );
    expect(failure.code).toBe("unavailable");
    expect(failure.interruption).toBe("suspension");
    expect(log).toEqual(["sse"]);

    setAppState("active");
    await until(() => phase === "ready", "foreground recovery");
    // The settled stream never restarts; a new stream from the same callable
    // is ordinary fresh work on the replacement generation.
    const fresh = call!({}).getReader();
    expect(await fresh.read()).toEqual({ done: false, value: { phase: "one" } });
    expect(log).toEqual(["sse", "sse"]);
    await fresh.cancel("done proving");
    await genericReleases[1]!.promise;
    await until(() => app.runtime.status().activeSse === 0, "the fresh stream to settle");
  });
});
