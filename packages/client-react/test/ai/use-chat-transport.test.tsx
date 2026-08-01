import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "../support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AckerDBFetch, AckerDBWebSocket, SseRef } from "@ackerdb/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  reconcile,
  serve,
  sseProcedure,
  type SseCtx,
} from "@ackerdb/server";
import {
  createUIMessageStream,
  streamText,
  toUIMessageStream,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { useChat } from "@ai-sdk/react";
import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, useConnectionState, type AckerDBClientError } from "@ackerdb/client-react";
import {
  useChatTransport,
  type AckerDBChatArgs,
  type AckerDBChatRequest,
} from "@ackerdb/client-react/ai";
import { uiMessageChunk } from "./ui-message-chunk.ts";

const schema = defineSchema({});

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

// Server-side journal: every argument object the chat procedures received,
// plus per-procedure release markers proving the runtime returned the
// handler's iterator on cancellation.
let receivedArgs: unknown[] = [];
let holdStarted = deferred<void>();
let holdReleased = deferred<void>();
let midStreamHoldReleased = deferred<void>();

const standardArgs = {
  trigger: v.string(),
  chatId: v.string(),
  messageId: v.string().nullable(),
  messages: v.jsonb<UIMessage[]>(),
};

function registry(): Registry {
  return new Registry({
    ai: {
      // The full chunk-family tour, written through the AI SDK's own
      // UIMessageStream and returned from the handler as-is.
      chat: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: (_ctx: SseCtx, args: { chatId: string }) => {
          receivedArgs.push(args);
          return createUIMessageStream({
            execute: ({ writer }) => {
              writer.write({ type: "start", messageMetadata: { model: "ackerdb-fixture" } });
              writer.write({ type: "start-step" });
              writer.write({ type: "text-start", id: "t1" });
              writer.write({ type: "text-delta", id: "t1", delta: "Hello " });
              writer.write({ type: "text-delta", id: "t1", delta: "world" });
              writer.write({ type: "text-end", id: "t1" });
              writer.write({ type: "reasoning-start", id: "r1" });
              writer.write({ type: "reasoning-delta", id: "r1", delta: "thinking" });
              writer.write({ type: "reasoning-end", id: "r1" });
              writer.write({ type: "tool-input-start", toolCallId: "call1", toolName: "search" });
              writer.write({
                type: "tool-input-delta",
                toolCallId: "call1",
                inputTextDelta: '{"q":"ackerdb"}',
              });
              writer.write({
                type: "tool-input-available",
                toolCallId: "call1",
                toolName: "search",
                input: { q: "ackerdb" },
              });
              writer.write({
                type: "tool-output-available",
                toolCallId: "call1",
                output: { hits: 1 },
              });
              writer.write({ type: "source-url", sourceId: "s1", url: "https://ackerdb.dev" });
              writer.write({
                type: "source-document",
                sourceId: "s2",
                mediaType: "text/markdown",
                title: "README",
              });
              writer.write({ type: "file", url: "https://ackerdb.dev/logo.png", mediaType: "image/png" });
              writer.write({ type: "data-weather", id: "d1", data: { temperature: 21 } });
              writer.write({ type: "message-metadata", messageMetadata: { tokens: 7 } });
              writer.write({ type: "finish-step" });
              writer.write({ type: "finish" });
            },
          });
        },
      }),
      // The primary integration story: a mock model through streamText,
      // returned directly as its UI message stream.
      model: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: () => {
          const result = streamText({
            model: new MockLanguageModelV3({
              doStream: {
                stream: new ReadableStream({
                  start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ type: "text-start", id: "m1" });
                    controller.enqueue({ type: "text-delta", id: "m1", delta: "Hello, " });
                    controller.enqueue({ type: "text-delta", id: "m1", delta: "model!" });
                    controller.enqueue({ type: "text-end", id: "m1" });
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 5, text: 5, reasoning: 0 },
                      },
                    });
                    controller.close();
                  },
                }),
              },
            }),
            prompt: "hi",
          });
          return toUIMessageStream({ stream: result.fullStream });
        },
      }),
      // Custom argument shape: only reachable through the typed mapper.
      custom: sseProcedure({
        access: "public",
        http: true,
        args: {
          sessionId: v.string(),
          prompt: v.string(),
          intent: v.string(),
          auth: v.string(),
        },
        yields: uiMessageChunk(),
        handler: (_ctx: SseCtx, args: { prompt: string }) => {
          receivedArgs.push(args);
          return createUIMessageStream({
            execute: ({ writer }) => {
              writer.write({ type: "text-start", id: "c1" });
              writer.write({ type: "text-delta", id: "c1", delta: `echo:${args.prompt}` });
              writer.write({ type: "text-end", id: "c1" });
            },
          });
        },
      }),
      // Cancellation fixtures use generators so the finally block observes
      // exactly when the runtime releases the handler's iterator.
      holdBeforeFirst: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: async function* (ctx: SseCtx): AsyncGenerator<UIMessageChunk, void, undefined> {
          try {
            holdStarted.resolve(undefined);
            await waitForAbort(ctx.abortSignal);
          } finally {
            holdReleased.resolve(undefined);
          }
        },
      }),
      holdMidStream: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: async function* (ctx: SseCtx): AsyncGenerator<UIMessageChunk, void, undefined> {
          try {
            yield { type: "start" };
            yield { type: "text-start", id: "h1" };
            yield { type: "text-delta", id: "h1", delta: "partial" };
            await waitForAbort(ctx.abortSignal);
          } finally {
            midStreamHoldReleased.resolve(undefined);
          }
        },
      }),
      malformed: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: async function* (): AsyncGenerator<UIMessageChunk, void, undefined> {
          yield { type: "text-start", id: "b1" };
          yield { type: "text-delta", id: "b1", delta: 7 } as unknown as UIMessageChunk;
        },
      }),
      failing: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: (): never => {
          throw new Error("model exploded");
        },
      }),
      failingMidStream: sseProcedure({
        access: "public",
        http: true,
        args: standardArgs,
        yields: uiMessageChunk(),
        handler: async function* (): AsyncGenerator<UIMessageChunk, void, undefined> {
          yield { type: "start" };
          throw new Error("mid-stream boom");
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
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-ai-"));
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

/** The only AckerDB-owned HTTP route the client calls; every other is a stream. */
const SSE_ACK_PATH = "/api/_sse/ack";

// Counts SSE request traffic so reconnect/cancellation tests can prove no
// hidden second stream ever starts. Resolves `fetch` at call time: after
// support/dom.ts registers happy-dom it restores Bun's native fetch.
function recordingFetch(log: string[]): AckerDBFetch {
  return (url, init) => {
    if (new URL(url).pathname !== SSE_ACK_PATH) log.push("sse");
    return fetch(url, init);
  };
}

// Typed references as codegen would emit them for the fixture procedures.
type StandardRef = SseRef<
  { trigger: string; chatId: string; messageId: string | null; messages: UIMessage[] },
  UIMessageChunk
>;
type CustomRef = SseRef<
  { sessionId: string; prompt: string; intent: string; auth: string },
  UIMessageChunk
>;

function standardRef(address: string): StandardRef {
  return { $ref: address } as StandardRef;
}

type Chat = ReturnType<typeof useChat<UIMessage>>;

/** How the AI SDK settled one request, as reported through onFinish. */
interface Settled {
  readonly isAbort: boolean;
  readonly isError: boolean;
  readonly isDisconnect: boolean;
}

interface Mounted {
  readonly chat: Chat;
  readonly transports: ChatTransport<UIMessage>[];
  readonly errors: Error[];
  readonly dataParts: unknown[];
  readonly finishes: Settled[];
  rerender(): void;
  unmount(): void;
}

interface MountOptions {
  readonly id: string;
  readonly log?: string[];
  readonly probe: () => ChatTransport<UIMessage>;
}

async function mountChat(base: string, options: MountOptions): Promise<Mounted> {
  const transports: ChatTransport<UIMessage>[] = [];
  const errors: Error[] = [];
  const dataParts: unknown[] = [];
  const finishes: Settled[] = [];
  let chat: Chat | undefined;
  let phase = "";
  let bump: () => void = () => {};

  function Probe(): ReactNode {
    const state = useConnectionState();
    const transport = options.probe();
    if (transports.at(-1) !== transport) transports.push(transport);
    chat = useChat<UIMessage>({
      id: options.id,
      transport,
      onError: (error) => errors.push(error),
      onData: (part) => dataParts.push(part),
      onFinish: ({ isAbort, isError, isDisconnect }) =>
        finishes.push({ isAbort, isError, isDisconnect }),
    });
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
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
        fetch: recordingFetch(options.log ?? []),
      }}
    >
      <Probe />
    </AckerDBProvider>,
  );
  await until(() => phase === "ready", "the provider to reach ready");
  return {
    get chat() {
      return chat!;
    },
    transports,
    errors,
    dataParts,
    finishes,
    rerender: () => bump(),
    unmount: () => root.unmount(),
  };
}

let app: App;
const roots: Mounted[] = [];

beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());
beforeEach(() => {
  receivedArgs = [];
  holdStarted = deferred<void>();
  holdReleased = deferred<void>();
  midStreamHoldReleased = deferred<void>();
});
afterEach(() => {
  while (roots.length > 0) roots.pop()!.unmount();
});

async function mount(options: MountOptions): Promise<Mounted> {
  const mounted = await mountChat(app.base, options);
  roots.push(mounted);
  return mounted;
}

function assistantOf(mounted: Mounted): UIMessage {
  const message = mounted.chat.messages.at(-1);
  if (message === undefined || message.role !== "assistant") {
    throw new Error("no assistant message yet");
  }
  return message;
}

describe("useChatTransport with AI SDK v7 useChat against a real ackerdb server", () => {
  test("streams every chunk family through useChat and forwards the standard request", async () => {
    const mounted = await mount({
      id: "chat-main",
      probe: () => useChatTransport(standardRef("ai.chat")),
    });
    await mounted.chat.sendMessage({ text: "hi ackerdb" });
    await until(
      () => mounted.chat.status === "ready" && mounted.chat.messages.length === 2,
      "the chat exchange to finish",
    );

    // The standard request reached the procedure as its argument object.
    expect(receivedArgs).toHaveLength(1);
    const args = receivedArgs[0] as AckerDBChatArgs;
    expect(args.trigger).toBe("submit-message");
    expect(args.chatId).toBe("chat-main");
    expect(args.messageId).toBeNull();
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "hi ackerdb" }],
    });

    // Every chunk family arrived as the exact validated object the handler
    // wrote — no second encoding layer between the AI SDK stream and React.
    const assistant = assistantOf(mounted);
    expect(assistant.metadata).toEqual({ model: "ackerdb-fixture", tokens: 7 });
    expect(assistant.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Hello world", state: "done" },
      { type: "reasoning", text: "thinking", state: "done" },
      {
        type: "tool-search",
        toolCallId: "call1",
        state: "output-available",
        input: { q: "ackerdb" },
        output: { hits: 1 },
      },
      { type: "source-url", sourceId: "s1", url: "https://ackerdb.dev" },
      {
        type: "source-document",
        sourceId: "s2",
        mediaType: "text/markdown",
        title: "README",
      },
      { type: "file", url: "https://ackerdb.dev/logo.png", mediaType: "image/png" },
      { type: "data-weather", id: "d1", data: { temperature: 21 } },
    ]);
    expect(mounted.dataParts).toEqual([
      { type: "data-weather", id: "d1", data: { temperature: 21 } },
    ]);
    expect(mounted.errors).toEqual([]);
  });

  test("a mock model stream returned directly from the handler reaches useChat", async () => {
    const mounted = await mount({
      id: "chat-model",
      probe: () => useChatTransport(standardRef("ai.model")),
    });
    await mounted.chat.sendMessage({ text: "hi" });
    await until(
      () => mounted.chat.status === "ready" && mounted.chat.messages.length === 2,
      "the model exchange to finish",
    );
    const assistant = assistantOf(mounted);
    expect(assistant.parts).toContainEqual({
      type: "text",
      text: "Hello, model!",
      state: "done",
    });
    expect(mounted.errors).toEqual([]);
  });

  test("regeneration forwards the regenerate trigger and message id", async () => {
    const mounted = await mount({
      id: "chat-regen",
      probe: () => useChatTransport(standardRef("ai.chat")),
    });
    await mounted.chat.sendMessage({ text: "first" });
    await until(() => mounted.chat.messages.length === 2, "the first exchange");
    const assistantId = assistantOf(mounted).id;

    await mounted.chat.regenerate({ messageId: assistantId });
    await until(
      () => mounted.chat.status === "ready" && receivedArgs.length === 2,
      "the regeneration to finish",
    );
    const args = receivedArgs[1] as AckerDBChatArgs;
    expect(args.trigger).toBe("regenerate-message");
    expect(args.messageId).toBe(assistantId);
    // The regenerated assistant message is not resent to the server.
    expect(args.messages.map((message) => message.role)).toEqual(["user"]);
  });

  test("per-request headers, body, and metadata flow through the typed mapper", async () => {
    const customRef = { $ref: "ai.custom" } as CustomRef;
    const mounted = await mount({
      id: "chat-custom",
      probe: () =>
        useChatTransport(customRef, {
          prepareArgs: (request: AckerDBChatRequest) => {
            const lastMessage = request.messages.at(-1);
            const textPart = lastMessage?.parts.find((part) => part.type === "text");
            return {
              sessionId: (request.body as { sessionId: string }).sessionId,
              prompt: textPart?.type === "text" ? textPart.text : "",
              intent: String(request.metadata),
              auth: (request.headers as Record<string, string>)["x-auth"] ?? "",
            };
          },
        }),
    });
    await mounted.chat.sendMessage(
      { text: "translate me" },
      {
        headers: { "x-auth": "token-1" },
        body: { sessionId: "session-9" },
        metadata: "translate",
      },
    );
    await until(() => mounted.chat.status === "ready", "the custom exchange to finish");
    expect(receivedArgs).toEqual([
      { sessionId: "session-9", prompt: "translate me", intent: "translate", auth: "token-1" },
    ]);
    expect(assistantOf(mounted).parts).toContainEqual({
      type: "text",
      text: "echo:translate me",
      state: "done",
    });
  });

  test("stop before the first chunk aborts the ackerdb request and releases the server iterator", async () => {
    const mounted = await mount({
      id: "chat-hold",
      probe: () => useChatTransport(standardRef("ai.holdBeforeFirst")),
    });
    void mounted.chat.sendMessage({ text: "never answered" });
    await holdStarted.promise;

    await mounted.chat.stop();
    await holdReleased.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
    await until(() => mounted.chat.status === "ready", "the chat to settle after stop");
    // Stopping is not an error: the AI SDK settles the request as aborted.
    expect(mounted.chat.error).toBeUndefined();
    expect(mounted.errors).toEqual([]);
    await until(() => mounted.finishes.length === 1, "the aborted request to report finish");
    expect(mounted.finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
  });

  test("stop mid-stream cancels the ackerdb stream and keeps the streamed tokens", async () => {
    const mounted = await mount({
      id: "chat-hold-mid",
      probe: () => useChatTransport(standardRef("ai.holdMidStream")),
    });
    void mounted.chat.sendMessage({ text: "partial answer" });
    await until(() => {
      const last = mounted.chat.messages.at(-1);
      return (
        last?.role === "assistant" &&
        last.parts.some((part) => part.type === "text" && part.text === "partial")
      );
    }, "the partial text to stream");

    await mounted.chat.stop();
    await midStreamHoldReleased.promise;
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
    await until(() => mounted.chat.status === "ready", "the chat to settle after stop");
    expect(mounted.chat.error).toBeUndefined();
    expect(assistantOf(mounted).parts).toContainEqual({
      type: "text",
      text: "partial",
      state: "streaming",
    });
    await until(() => mounted.finishes.length === 1, "the aborted request to report finish");
    expect(mounted.finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
    expect(mounted.errors).toEqual([]);
  });

  test("a malformed chunk surfaces the exact ackerdb validation error", async () => {
    const mounted = await mount({
      id: "chat-malformed",
      probe: () => useChatTransport(standardRef("ai.malformed")),
    });
    void mounted.chat.sendMessage({ text: "malform" });
    await until(() => mounted.chat.status === "error", "the chat to fail");

    const failure = mounted.chat.error as AckerDBClientError;
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("validation");
    expect(failure.message).toBe("chunk.delta: expected string, got number");
    expect(mounted.errors).toEqual([failure]);
  });

  test("a handler that fails before streaming surfaces a typed ackerdb error", async () => {
    const mounted = await mount({
      id: "chat-failing",
      probe: () => useChatTransport(standardRef("ai.failing")),
    });
    void mounted.chat.sendMessage({ text: "explode" });
    await until(() => mounted.chat.status === "error", "the chat to fail");

    const failure = mounted.chat.error as AckerDBClientError;
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("internal");
  });

  test("a handler that fails mid-stream surfaces a typed ackerdb error", async () => {
    const mounted = await mount({
      id: "chat-failing-mid",
      probe: () => useChatTransport(standardRef("ai.failingMidStream")),
    });
    void mounted.chat.sendMessage({ text: "explode later" });
    await until(() => mounted.chat.status === "error", "the chat to fail");

    const failure = mounted.chat.error as AckerDBClientError;
    expect(failure.name).toBe("AckerDBClientError");
    expect(failure.code).toBe("internal");
    await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
  });

  test("stream reconnection is explicitly unsupported and starts no second stream", async () => {
    const log: string[] = [];
    const mounted = await mount({
      id: "chat-reconnect",
      log,
      probe: () => useChatTransport(standardRef("ai.chat")),
    });
    await mounted.chat.sendMessage({ text: "hello" });
    await until(() => mounted.chat.status === "ready", "the exchange to finish");
    expect(log).toEqual(["sse"]);
    const settledMessages = mounted.chat.messages;

    // The transport reports "no active stream"; the AI SDK then does nothing.
    await expect(
      mounted.transports.at(-1)!.reconnectToStream({ chatId: "chat-reconnect" }),
    ).resolves.toBeNull();
    await mounted.chat.resumeStream();
    await Bun.sleep(20);
    expect(log).toEqual(["sse"]);
    expect(mounted.chat.status).toBe("ready");
    expect(mounted.chat.messages).toEqual(settledMessages);
    expect(mounted.errors).toEqual([]);
  });

  test("unmounting only the chat component cancels its active ackerdb stream", async () => {
    // useChat never aborts an active response on unmount, so the hook owns
    // this boundary. The provider stays mounted: only the hook's own
    // lifetime can release the stream here.
    const config = {
      url: app.base,
      credential: { kind: "anonymous" } as const,
      createWebSocket: (url: string) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
    };
    let phase = "";
    let chat: Chat | undefined;
    const errors: Error[] = [];
    const finishes: Settled[] = [];

    function Phase(): ReactNode {
      phase = useConnectionState().phase;
      return null;
    }
    function ChatProbe(): ReactNode {
      const transport = useChatTransport(standardRef("ai.holdMidStream"));
      chat = useChat<UIMessage>({
        id: "chat-orphan",
        transport,
        onError: (error) => errors.push(error),
        onFinish: ({ isAbort, isError, isDisconnect }) =>
          finishes.push({ isAbort, isError, isDisconnect }),
      });
      return null;
    }
    function Harness({ showChat }: { showChat: boolean }): ReactNode {
      return (
        <AckerDBProvider config={config}>
          <Phase />
          {showChat ? <ChatProbe /> : null}
        </AckerDBProvider>
      );
    }

    const root: Root = createRoot(mountPoint());
    try {
      root.render(<Harness showChat={true} />);
      await until(() => phase === "ready", "the provider to reach ready");
      void chat!.sendMessage({ text: "orphan me" });
      await until(() => {
        const last = chat!.messages.at(-1);
        return (
          last?.role === "assistant" &&
          last.parts.some((part) => part.type === "text" && part.text === "partial")
        );
      }, "the partial text to stream");

      root.render(<Harness showChat={false} />);
      await midStreamHoldReleased.promise;
      await until(() => app.runtime.status().activeSse === 0, "the server stream to settle");
      expect(phase).toBe("ready");
      // The unmount settles as cancellation, not as a failure: no error
      // callback, no false error telemetry from a user navigating away.
      await until(() => finishes.length === 1, "the aborted request to report finish");
      expect(finishes).toEqual([{ isAbort: true, isError: false, isDisconnect: false }]);
      expect(errors).toEqual([]);
    } finally {
      root.unmount();
    }
  });

  test("the transport identity is stable across rerenders", async () => {
    const mounted = await mount({
      id: "chat-stable",
      probe: () => useChatTransport(standardRef("ai.chat")),
    });
    const transport = mounted.transports.at(-1)!;
    mounted.rerender();
    await Bun.sleep(20);
    mounted.rerender();
    await Bun.sleep(20);
    expect(mounted.transports.at(-1)).toBe(transport);
    expect(mounted.transports).toHaveLength(1);
  });
});
