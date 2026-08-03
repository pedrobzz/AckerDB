import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ChannelRef } from "@ackerdb/core";
import {
  AckerDBProvider,
  useChannel,
  type AckerDBProviderConfig,
  type UseChannelResult,
} from "@ackerdb/client-react";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import { createHarness } from "./support/harness.ts";

const SESSION = "react-channel-session";
// No injected clock: channel lifetimes here are driven by renders, not timers.
const APP = { url: "http://react-channel.test", clientSessionId: SESSION, clock: undefined };

type Chat = ChannelRef<
  { readonly threadId: bigint },
  string,
  { readonly message: { readonly body: string } },
  {
    readonly message: { readonly id: bigint; readonly body: string };
    readonly typing: { readonly active: boolean };
  }
>;

const chat = { $ref: "chat.room" } as Chat;
const results = new Map<string, UseChannelResult<Chat>>();

interface ProbeProps {
  readonly id: string;
  readonly handlerKey?: string;
  readonly onMessage: (body: string) => void;
}

function Probe({ id, handlerKey, onMessage }: ProbeProps): ReactNode {
  const result = useChannel(chat, { threadId: 1n }, {
    room: "support",
    ...(handlerKey === undefined ? {} : { handlerKey }),
    on: {
      message: (message) => onMessage(message.body),
    },
  });
  results.set(id, result);
  return <span>{id}:{result.state.phase};</span>;
}

async function render(root: Root, value: ReactNode): Promise<void> {
  await act(async () => {
    root.render(value);
  });
}

function app(
  config: AckerDBProviderConfig,
  probes: readonly ProbeProps[],
): ReactNode {
  return (
    <AckerDBProvider config={config}>
      <StrictMode>
        {probes.map((probe) => <Probe key={probe.id} {...probe} />)}
      </StrictMode>
    </AckerDBProvider>
  );
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useChannel", () => {
  test("shares membership, keeps ordinary handlers independent, and coalesces equal handlerKey bundles", async () => {
    const testHarness = createHarness(APP);
    const root = createRoot(mountPoint());
    const calls: string[] = [];
    const first = (body: string) => calls.push(`first:${body}`);
    const second = (body: string) => calls.push(`second:${body}`);

    await render(root, app(testHarness.config(), [
      { id: "messages", onMessage: first },
      { id: "composer", onMessage: second },
    ]));
    const socket = testHarness.live();
    await act(async () => socket.welcome(SESSION));
    const joins = socket.framesOf("channel_join");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      ref: "chat.room",
      args: { threadId: 1n },
      room: "support",
    });
    const id = joins[0]!.id;

    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "channel_ready",
        id,
        authEpoch: 0,
      });
    });
    expect(results.get("messages")?.state.phase).toBe("connected");
    expect(results.get("composer")?.state.phase).toBe("connected");

    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "channel_event",
        id,
        event: "message",
        payload: { id: 1n, body: "one" },
      });
    });
    expect(calls).toEqual(["first:one", "second:one"]);

    await render(root, app(testHarness.config(), [
      { id: "messages", handlerKey: "useChatRoom", onMessage: first },
      { id: "composer", handlerKey: "useChatRoom", onMessage: second },
    ]));
    await act(async () => {});
    expect(socket.framesOf("channel_join")).toHaveLength(1);
    expect(socket.framesOf("channel_leave")).toHaveLength(0);

    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "channel_event",
        id,
        event: "message",
        payload: { id: 2n, body: "two" },
      });
    });
    expect(calls).toEqual(["first:one", "second:one", "first:two"]);

    expect(results.get("messages")?.send("message", { body: "outbound" })).toBe(
      true,
    );
    expect(socket.framesOf("channel_send").at(-1)).toMatchObject({
      id,
      event: "message",
      payload: { body: "outbound" },
    });

    await render(root, app(testHarness.config(), [
      { id: "composer", handlerKey: "useChatRoom", onMessage: second },
    ]));
    await act(async () => {});
    expect(socket.framesOf("channel_leave")).toHaveLength(0);

    await render(root, app(testHarness.config(), []));
    await act(async () => {});
    expect(socket.framesOf("channel_leave")).toEqual([
      { v: PROTOCOL_VERSION, t: "channel_leave", id },
    ]);
    await act(async () => root.unmount());
  });

  test("uses the latest committed callback without rejoining", async () => {
    const testHarness = createHarness(APP);
    const root = createRoot(mountPoint());
    const calls: string[] = [];

    await render(root, app(testHarness.config(), [{
      id: "chat",
      onMessage: (body) => calls.push(`old:${body}`),
    }]));
    const socket = testHarness.live();
    await act(async () => socket.welcome(SESSION));
    const join = socket.framesOf("channel_join")[0]!;

    await render(root, app(testHarness.config(), [{
      id: "chat",
      onMessage: (body) => calls.push(`new:${body}`),
    }]));
    expect(socket.framesOf("channel_join")).toHaveLength(1);

    await act(async () => {
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "channel_ready",
        id: join.id,
        authEpoch: 0,
      });
      socket.receive({
        v: PROTOCOL_VERSION,
        t: "channel_event",
        id: join.id,
        event: "message",
        payload: { id: 1n, body: "hello" },
      });
    });
    expect(calls).toEqual(["new:hello"]);
    await act(async () => root.unmount());
  });
});
