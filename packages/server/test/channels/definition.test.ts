import { describe, expect, test } from "bun:test";
import { channel, v } from "@ackerdb/server";

describe("channel declarations", () => {
  test("registers a roomed typed event contract", () => {
    const declared = channel({
      args: { threadId: v.bigint() },
      room: v.string(),
      clientEvents: { message: v.string() },
      serverEvents: { delivered: v.boolean() },
      access: "authenticated",
      on: {
        message: () => {},
      },
    });

    expect(declared.isAckerDBChannel).toBe(true);
    expect(declared.kind).toBe("channel");
    expect(declared.room?.kind).toBe("string");
    expect(Object.isFrozen(declared)).toBe(true);
  });

  test("rejects missing, extra, and invalid event handlers", () => {
    expect(() =>
      channel({
        args: {},
        clientEvents: { message: v.string() },
        serverEvents: {},
        access: "public",
        on: {} as never,
      })
    ).toThrow("on.message must be a channel event handler");

    expect(() =>
      channel({
        args: {},
        clientEvents: {},
        serverEvents: {},
        access: "public",
        on: { legacy: () => {} } as never,
      })
    ).toThrow("on.legacy has no matching client event declaration");

    expect(() =>
      channel({
        args: {},
        clientEvents: { message: "string" } as never,
        serverEvents: {},
        access: "public",
        on: { message: () => {} },
      } as never)
    ).toThrow("clientEvents.message must be a v validator");
  });
});
