import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  Status,
  decode,
  encode,
  parseClientMessage,
  type ChannelRef,
  type ClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import {
  AckerDBClient,
  type AckerDBClientClock,
  type AckerDBWebSocket,
} from "@ackerdb/client";

class Clock implements AckerDBClientClock {
  now = (): number => 1;
  setTimeout = (): number => 1;
  clearTimeout = (): void => {};
  setInterval = (): number => 2;
  clearInterval = (): void => {};
}

class Socket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: ClientMessage[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(parseClientMessage(decode(data)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: encode(message) });
  }
}

type Chat = ChannelRef<
  { readonly threadId: bigint },
  string,
  { readonly message: { readonly body: string } },
  { readonly message: { readonly id: bigint; readonly body: string } },
  {
    readonly kind: "application";
    readonly code: "room.closed";
    readonly body: { readonly room: string };
    readonly status: typeof Status.Forbidden;
  }
>;

const chat = { $ref: "chat.room" } as Chat;

function frames<T extends ClientMessage["t"]>(
  socket: Socket,
  type: T,
): Extract<ClientMessage, { readonly t: T }>[] {
  return socket.sent.filter(
    (message): message is Extract<ClientMessage, { readonly t: T }> =>
      message.t === type,
  );
}

describe("AckerDBClient channels", () => {
  test("uses the existing socket, shares one join, dispatches once per observer, and leaves once", () => {
    const socket = new Socket();
    const client = new AckerDBClient({
      url: "http://ackerdb.test",
      credential: { kind: "anonymous" },
      clientSessionId: "channel-client",
      clock: new Clock(),
      random: () => 0,
      createWebSocket: () => socket,
    });
    const received: string[] = [];
    const first = client.channel(chat, { threadId: 1n }, {
      room: "support",
      on: { message: (message) => received.push(`first:${message.body}`) },
    });
    const second = client.channel(chat, { threadId: 1n }, {
      room: "support",
      on: { message: (message) => received.push(`second:${message.body}`) },
    });

    socket.onopen?.();
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId: "channel-client",
      authEpoch: 0,
      principal: "anonymous",
    });
    const joins = frames(socket, "channel_join");
    expect(joins).toHaveLength(1);
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "channel_ready",
      id: joins[0]!.id,
      authEpoch: 0,
    });
    expect(first.currentState.phase).toBe("connected");
    expect(first.send("message", { body: "hello" })).toBe(true);
    expect(frames(socket, "channel_send")).toHaveLength(1);

    socket.receive({
      v: PROTOCOL_VERSION,
      t: "channel_event",
      id: joins[0]!.id,
      event: "message",
      payload: { id: 1n, body: "hello" },
    });
    expect(received).toEqual(["first:hello", "second:hello"]);

    first.close();
    expect(frames(socket, "channel_leave")).toHaveLength(0);
    second.close();
    expect(frames(socket, "channel_leave")).toHaveLength(1);
    client.close();
  });

  test("surfaces typed membership rejection without creating another socket", () => {
    const socket = new Socket();
    const client = new AckerDBClient({
      url: "http://ackerdb.test",
      credential: { kind: "anonymous" },
      clientSessionId: "rejected-client",
      clock: new Clock(),
      random: () => 0,
      createWebSocket: () => socket,
    });
    const handle = client.channel(chat, { threadId: 1n }, { room: "closed" });
    socket.onopen?.();
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId: "rejected-client",
      authEpoch: 0,
      principal: "anonymous",
    });
    const join = frames(socket, "channel_join")[0]!;
    socket.receive({
      v: PROTOCOL_VERSION,
      t: "channel_rejected",
      id: join.id,
      authEpoch: 0,
      error: {
        kind: "application",
        code: "room.closed",
        body: { room: "closed" },
        status: Status.Forbidden,
      },
    });

    expect(handle.currentState).toEqual({
      phase: "rejected",
      error: {
        kind: "application",
        code: "room.closed",
        body: { room: "closed" },
        status: Status.Forbidden,
      },
    });
    expect(handle.send("message", { body: "ignored" })).toBe(false);
    handle.close();
    client.close();
  });
});
