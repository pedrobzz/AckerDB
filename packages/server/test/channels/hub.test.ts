import { describe, expect, test } from "bun:test";
import { Err, Ok, Status } from "@ackerdb/core";
import {
  Registry,
  channel,
  v,
  type ProcedureCtx,
} from "@ackerdb/server";
import type { Principal } from "../../src/auth/credentials.ts";
import {
  ChannelHub,
  type ChannelSessionAdapter,
} from "../../src/channels/hub.ts";

interface SentEvent {
  readonly id: number;
  readonly event: string;
  readonly payload: unknown;
}

function session(principal: Principal = { kind: "anonymous" }): {
  readonly adapter: ChannelSessionAdapter;
  readonly sent: SentEvent[];
} {
  const sent: SentEvent[] = [];
  return {
    sent,
    adapter: {
      principal,
      createContext: (signal) => ({
        value: {
          auth: principal,
          abortSignal: signal,
          timestamp: Date.now(),
          tx: async () => Ok(undefined),
          linkAccount: async () => {},
          unlinkAccount: async () => {},
        } as unknown as ProcedureCtx,
        release: () => {},
      }),
      send: async (id, event, payload) => {
        sent.push({ id, event, payload });
        return true;
      },
    },
  };
}

describe("ChannelHub", () => {
  test("partitions room audiences and preserves direct-vs-publish delivery", async () => {
    const chat = channel({
      args: { threadId: v.bigint() },
      room: v.string(),
      clientEvents: {
        direct: v.string(),
        broadcast: v.string(),
      },
      serverEvents: { message: v.string() },
      access: "public",
      on: {
        direct: (ctx, payload) => ctx.send("message", payload),
        broadcast: (ctx, payload) => ctx.publish("message", payload),
      },
    });
    const hub = new ChannelHub({
      registry: new Registry({ chat: { room: chat } }),
      maxMembers: 10,
      maxMembersPerSession: 4,
    });
    const first = session();
    const second = session();
    const otherRoom = session();

    await hub.join({
      session: first.adapter,
      id: 1,
      address: "chat.room",
      args: { threadId: 1n },
      hasRoom: true,
      room: "support",
      requestBytes: 1,
    });
    await hub.join({
      session: second.adapter,
      id: 2,
      address: "chat.room",
      args: { threadId: 1n },
      hasRoom: true,
      room: "support",
      requestBytes: 1,
    });
    await hub.join({
      session: otherRoom.adapter,
      id: 3,
      address: "chat.room",
      args: { threadId: 1n },
      hasRoom: true,
      room: "sales",
      requestBytes: 1,
    });

    await hub.handle(first.adapter, 1, "direct", "private", 1);
    await hub.handle(first.adapter, 1, "broadcast", "shared", 1);

    expect(first.sent).toEqual([
      { id: 1, event: "message", payload: "private" },
      { id: 1, event: "message", payload: "shared" },
    ]);
    expect(second.sent).toEqual([
      { id: 2, event: "message", payload: "shared" },
    ]);
    expect(otherRoom.sent).toEqual([]);
  });

  test("returns typed authorization rejection without retaining membership", async () => {
    const guarded = channel({
      args: {},
      room: v.string(),
      clientEvents: {},
      serverEvents: {},
      access: "public",
      authorize: (ctx) =>
        ctx.room === "closed"
          ? Err("room.closed", { room: ctx.room }, Status.Forbidden)
          : Ok({ joined: true }),
      on: {},
    });
    const hub = new ChannelHub({
      registry: new Registry({ chat: { guarded } }),
      maxMembers: 2,
      maxMembersPerSession: 2,
    });
    const client = session();

    const result = await hub.join({
      session: client.adapter,
      id: 1,
      address: "chat.guarded",
      args: {},
      hasRoom: true,
      room: "closed",
      requestBytes: 1,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "application",
        code: "room.closed",
        body: { room: "closed" },
        status: Status.Forbidden,
      },
    });
    expect(hub.size).toBe(0);
  });

  test("requires exactly the room shape declared by the channel", async () => {
    const roomless = channel({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      on: {},
    });
    const roomed = channel({
      args: {},
      room: v.string(),
      clientEvents: {},
      serverEvents: {},
      access: "public",
      on: {},
    });
    const hub = new ChannelHub({
      registry: new Registry({ chat: { roomless, roomed } }),
      maxMembers: 2,
      maxMembersPerSession: 2,
    });
    const client = session();

    await expect(hub.join({
      session: client.adapter,
      id: 1,
      address: "chat.roomless",
      args: {},
      hasRoom: true,
      room: "unexpected",
      requestBytes: 1,
    })).rejects.toThrow("roomless channel does not accept a room");
    await expect(hub.join({
      session: client.adapter,
      id: 2,
      address: "chat.roomed",
      args: {},
      hasRoom: false,
      requestBytes: 1,
    })).rejects.toThrow("roomed channel requires a room");
  });

  test("serializes one member's handlers and releases it once", async () => {
    const calls: string[] = [];
    const ordered = channel({
      args: {},
      clientEvents: { work: v.string() },
      serverEvents: {},
      access: "public",
      on: {
        work: async (_ctx, payload) => {
          calls.push(`start:${payload}`);
          await Promise.resolve();
          calls.push(`end:${payload}`);
        },
      },
      onDisconnect: (_ctx, reason) => {
        calls.push(`close:${reason}`);
      },
    });
    const hub = new ChannelHub({
      registry: new Registry({ chat: { ordered } }),
      maxMembers: 2,
      maxMembersPerSession: 2,
    });
    const client = session();
    await hub.join({
      session: client.adapter,
      id: 1,
      address: "chat.ordered",
      args: {},
      hasRoom: false,
      requestBytes: 1,
    });

    const first = hub.handle(client.adapter, 1, "work", "a", 1);
    const second = hub.handle(client.adapter, 1, "work", "b", 1);
    await Promise.all([first, second]);
    await hub.leave(client.adapter, 1, "leave", 1);
    await hub.leave(client.adapter, 1, "leave", 1);

    expect(calls).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "close:leave",
    ]);
    expect(hub.size).toBe(0);
  });

  test("bounds disconnect cleanup after cancelling queued member work", async () => {
    let contexts = 0;
    let releases = 0;
    let timeouts = 0;
    let workStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      workStarted = resolve;
    });
    const hanging = channel({
      args: {},
      clientEvents: { hang: v.string() },
      serverEvents: {},
      access: "public",
      on: {
        hang: async () => {
          workStarted();
          await new Promise(() => {});
        },
      },
      onDisconnect: async () => {
        await new Promise(() => {});
      },
    });
    const hub = new ChannelHub({
      registry: new Registry({ chat: { hanging } }),
      maxMembers: 2,
      maxMembersPerSession: 2,
      disconnectTimeoutMs: 10,
      observeDisconnectTimeout: () => {
        timeouts++;
      },
    });
    const principal: Principal = { kind: "anonymous" };
    const adapter: ChannelSessionAdapter = {
      principal,
      createContext: (signal) => {
        contexts++;
        return {
          value: {
            auth: principal,
            abortSignal: signal,
            timestamp: Date.now(),
            tx: async () => Ok(undefined),
            linkAccount: async () => {},
            unlinkAccount: async () => {},
          } as unknown as ProcedureCtx,
          release: () => {
            releases++;
          },
        };
      },
      send: async () => true,
    };
    await hub.join({
      session: adapter,
      id: 1,
      address: "chat.hanging",
      args: {},
      hasRoom: false,
      requestBytes: 1,
    });

    void hub.handle(adapter, 1, "hang", "now", 1).catch(() => {});
    await started;
    await hub.disconnect(adapter, "disconnect");

    expect(hub.size).toBe(0);
    expect(timeouts).toBe(1);
    expect(contexts).toBe(3);
    expect(releases).toBe(3);
  });
});
