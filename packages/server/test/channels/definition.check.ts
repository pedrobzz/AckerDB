import { Err, Ok, Status, type ApiFromModules } from "@ackerdb/core";
import {
  channel,
  defineSchema,
  v,
  type ChannelBuilder,
} from "@ackerdb/server";

const schema = defineSchema({});
const typedChannel = channel as ChannelBuilder<typeof schema>;

const roomed = typedChannel({
  args: { threadId: v.bigint() },
  room: v.string(),
  clientEvents: {
    message: v.object({ body: v.string() }),
    typing: v.boolean(),
  },
  serverEvents: {
    message: v.object({ id: v.bigint(), body: v.string() }),
    typing: v.object({ active: v.boolean() }),
  },
  access: "authenticated",
  authorize: (_ctx, args) =>
    args.threadId > 0n
      ? Ok({ memberId: args.threadId })
      : Err("thread.not-found", { threadId: args.threadId }, Status.NotFound),
  on: {
    message: async (ctx, payload) => {
      ctx.room satisfies string;
      ctx.state.memberId satisfies bigint;
      payload.body satisfies string;
      await ctx.send("message", { id: 1n, body: payload.body });
      await ctx.publish("typing", { active: true });
      // @ts-expect-error server event payloads stay exact
      await ctx.send("typing", { active: "yes" });
    },
    typing: (_ctx, payload) => {
      payload satisfies boolean;
    },
  },
});

const roomless = typedChannel({
  args: {},
  clientEvents: { ping: v.string() },
  serverEvents: { pong: v.boolean() },
  access: "public",
  on: {
    ping: async (ctx) => {
      ctx.state satisfies undefined;
      // @ts-expect-error roomless channels do not expose a room
      ctx.room;
      await ctx.send("pong", true);
    },
  },
});

type Api = ApiFromModules<{
  chat: {
    roomed: typeof roomed;
    roomless: typeof roomless;
  };
}>;

declare const api: Api;
api.chat.roomed satisfies {
  readonly $ref: string;
  readonly _args?: { threadId: bigint };
  readonly _room?: string;
};
api.chat.roomless satisfies {
  readonly $ref: string;
  readonly _args?: {};
};
