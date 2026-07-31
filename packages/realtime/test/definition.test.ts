import { describe, expect, test } from "bun:test";
import {
  Err,
  Ok,
  Status,
} from "@ackerdb/core";
import {
  realtime,
  Registry,
  type RealtimePeerConnection,
  v,
} from "@ackerdb/server";

describe("realtime declarations", () => {
  test("registers typed events, finite streams, authorization state, and a handler", () => {
    const assistant = realtime({
      args: { assistantId: v.bigint() },
      clientEvents: {
        prompt: v.object({ text: v.string(), audio: v.bytes() }),
      },
      serverEvents: {
        transcript: v.object({ text: v.string() }),
      },
      clientStreams: {
        photo: {
          metadata: v.object({ contentType: v.literal("image/jpeg") }),
          maxBytes: 2_000_000,
        },
      },
      serverStreams: {},
      access: "authenticated",
      authorize: (_ctx, args) =>
        args.assistantId === 0n
          ? Err("assistant_missing", { id: args.assistantId }, Status.NotFound)
          : Ok({ voice: "alloy" }),
      handler: (ctx, args) => {
        const peer: RealtimePeerConnection = ctx.peerConnection;
        const voice: string = ctx.state.voice;
        ctx.on("prompt", (prompt) => {
          const text: string = prompt.text;
          const audio: Uint8Array = prompt.audio;
          void [text, audio];
        });
        ctx.onStream("photo", ({ metadata, readable }) => {
          const jpeg: "image/jpeg" = metadata.contentType;
          const bytes: ReadableStream<Uint8Array> = readable;
          void [jpeg, bytes];
        });
        ctx.send("transcript", { text: String(args.assistantId) });
        void [peer, voice];
      },
    });

    const registry = new Registry({ assistants: { live: assistant } });
    expect(registry.getRealtime("assistants.live")).toBe(assistant);
    expect(registry.kindOf("assistants.live")).toBe("realtime");
  });

  test("rejects malformed stream declarations", () => {
    expect(() => realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      clientStreams: {
        photo: { metadata: v.string(), maxBytes: 0 },
      },
      access: "public",
      handler: () => {},
    })).toThrow("maxBytes");
  });
});
