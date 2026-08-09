import { describe, expect, test } from "bun:test";
import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseClientMessage,
  type ChannelRef,
  type ClientMessage,
} from "@ackerdb/core";
import {
  ChannelManager,
  type ChannelManagerPort,
} from "../../src/channels/channel.ts";

class Port implements ChannelManagerPort {
  readonly sent: ClientMessage[] = [];
  private nextId = 0;
  connected = true;
  currentGeneration = 1;
  currentAuthEpoch = 0;

  allocateId(): number {
    return ++this.nextId;
  }

  encode(frame: ClientMessage): string {
    return encode(parseClientMessage(frame));
  }

  retain(frame: string): number {
    return new TextEncoder().encode(frame).byteLength;
  }

  release(_bytes: number): void {}
  ensureConnected(): void {}
  canSend(): boolean {
    return this.connected;
  }
  send(frame: string): boolean {
    if (!this.connected) return false;
    this.sent.push(parseClientMessage(decode(frame)));
    return true;
  }
  generation(): number {
    return this.currentGeneration;
  }
  authEpoch(): number {
    return this.currentAuthEpoch;
  }
}

type Chat = ChannelRef<
  { readonly threadId: bigint },
  string,
  { readonly message: { readonly body: string } },
  {
    readonly message: { readonly id: bigint; readonly body: string };
    readonly typing: { readonly active: boolean };
  }
>;

const chat = { $ref: "api.chat.room" } as Chat;

function framesOfType<T extends ClientMessage["t"]>(
  frames: readonly ClientMessage[],
  type: T,
): Extract<ClientMessage, { readonly t: T }>[] {
  return frames.filter(
    (frame): frame is Extract<ClientMessage, { readonly t: T }> =>
      frame.t === type,
  );
}

describe("ChannelManager", () => {
  test("shares one logical join while independent observers all receive events", () => {
    const port = new Port();
    const manager = new ChannelManager(port);
    const calls: string[] = [];

    const first = manager.observe(chat, { threadId: 1n }, {
      room: "support",
      on: {
        message: (message) => calls.push(`first:${message.body}`),
      },
    });
    const second = manager.observe(chat, { threadId: 1n }, {
      room: "support",
      on: (event) => calls.push(`second:${event.type}`),
    });
    const joins = framesOfType(port.sent, "channel_join");
    expect(joins).toHaveLength(1);

    const id = joins[0]!.id;
    manager.ready(id, 0);
    manager.event(id, "message", { id: 1n, body: "hello" });
    expect(calls).toEqual(["first:hello", "second:message"]);

    first.close();
    expect(port.sent.filter((frame) => frame.t === "channel_leave")).toHaveLength(0);
    second.close();
    expect(port.sent.filter((frame) => frame.t === "channel_leave")).toEqual([
      { v: ACKERDB_VERSION, t: "channel_leave", id },
    ]);
  });

  test("coalesces only equal handlerKey bundles", () => {
    const port = new Port();
    const manager = new ChannelManager(port);
    const calls: string[] = [];
    const observe = (name: string, handlerKey?: string) =>
      manager.observe(chat, { threadId: 1n }, {
        room: "support",
        ...(handlerKey === undefined ? {} : { handlerKey }),
        on: { typing: () => calls.push(name) },
      });

    const first = observe("first", "useChatRoom");
    const duplicate = observe("duplicate", "useChatRoom");
    const independent = observe("independent");
    const differentlyKeyed = observe("different-key", "composer");
    const join = framesOfType(port.sent, "channel_join")[0]!;
    manager.ready(join.id, 0);
    manager.event(join.id, "typing", { active: true });

    expect(calls).toEqual(["first", "independent", "different-key"]);
    first.close();
    duplicate.close();
    independent.close();
    differentlyKeyed.close();
  });

  test("separates rooms, restores joins, and sends only while connected", () => {
    const port = new Port();
    const manager = new ChannelManager(port);
    const support = manager.observe(chat, { threadId: 1n }, { room: "support" });
    const sales = manager.observe(chat, { threadId: 1n }, { room: "sales" });
    expect(port.sent.filter((frame) => frame.t === "channel_join")).toHaveLength(2);
    expect(support.send("message", { body: "before-ready" })).toBe(false);

    const supportJoin = framesOfType(port.sent, "channel_join").find(
      (frame) => frame.room === "support",
    )!;
    manager.ready(supportJoin.id, 0);
    expect(support.send("message", { body: "ready" })).toBe(true);
    expect(port.sent.at(-1)).toEqual({
      v: ACKERDB_VERSION,
      t: "channel_send",
      id: supportJoin.id,
      event: "message",
      payload: { body: "ready" },
    });

    manager.connectionLost();
    port.currentGeneration = 2;
    port.currentAuthEpoch = 0;
    manager.flush();
    expect(port.sent.filter((frame) => frame.t === "channel_join")).toHaveLength(4);

    support.close();
    sales.close();
  });
});
