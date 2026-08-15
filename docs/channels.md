# Application channels

Application channels are typed bidirectional messages multiplexed over the
same WebSocket AckerDB already uses for queries, mutations, and subscriptions.
They add no physical socket per channel or room. They are for ordinary
application messages; continuous audio and video belong on
[realtime media sessions](realtime-media.md).

## Define a channel

Use the generated server builder. `room` is opt-in: omit it completely for a
roomless channel, or provide a validator to require exactly one room on every
membership.

```ts
import { channel, v } from "../_generated/server";

export const room = channel({
  args: {
    threadId: v.bigint(),
  },
  room: v.string(),
  clientEvents: {
    compose: v.object({
      text: v.string(),
    }),
  },
  serverEvents: {
    message: v.object({
      id: v.bigint(),
      text: v.string(),
    }),
  },
  access: "authenticated",
  authorize: async (ctx, args) => {
    await requireThreadMember(ctx, args.threadId);
    return { joinedAt: ctx.timestamp };
  },
  on: {
    async compose(ctx, input) {
      const id = await ctx.tx((tx) =>
        tx.db.messages.insert({
          threadId: ctx.args.threadId,
          text: input.text,
        })
      );
      await ctx.publish("message", {
        id,
        text: input.text,
      });
    },
  },
  onConnect(ctx) {
    recordJoin(ctx.room, ctx.state.joinedAt);
  },
  onDisconnect(_ctx, reason) {
    recordDisconnect(reason);
  },
});
```

`ctx.send` targets only the current member. `ctx.publish` targets every current
member of the same channel arguments and room, including the sender.
`ctx.channels.publish` is the explicit typed server-only operation for another
channel audience. Clients cannot select arbitrary audiences inside an event.

Authorization runs before membership is retained and again after reconnect or
authentication change. It may return typed ephemeral state or a typed
application rejection. Roomless channels reject a supplied room; roomed
channels reject a missing room. There is no all-rooms wildcard.

## React

```tsx
import {
  useChannel,
  type ChannelOn,
} from "@ackerdb/client-react";
import { api } from "./_generated/api";

type ChatOn = ChannelOn<typeof api.chat.room>;

interface UseChatRoomOptions {
  readonly on?: ChatOn;
}

export function useChatRoom(
  threadId: bigint,
  room: string,
  options: UseChatRoomOptions = {},
) {
  return useChannel(api.chat.room, { threadId }, {
    room,
    handlerKey: "useChatRoom",
    on: options.on,
  });
}
```

`on` accepts either a named handler map:

```tsx
useChatRoom(threadId, room, {
  on: {
    message(value) {
      messages.add(value);
    },
  },
});
```

or one inferred discriminated union:

```tsx
useChannel(api.chat.room, { threadId }, {
  room,
  on(event) {
    if (event.type === "message") messages.add(event.payload);
  },
});
```

Equal client, reference, canonical arguments, and room values share exactly
one server membership and one received frame. Without `handlerKey`, every hook
observer runs its own matching handler. Equal non-empty keys run one complete
`on` bundle, which is useful when the same custom hook is mounted in a message
list and a composer. Different keys remain independent handler bundles and do
not create more network memberships.

`send(event, payload)` returns `true` only when the current local socket
accepted the encoded frame. It does not acknowledge server receipt or handler
completion. A disconnected or backpressured send returns `false` and is never
queued or replayed. The returned state is `connecting`, `connected`,
`reconnecting`, `rejected`, or `failed`.

## Framework-neutral client

The same contract is available without React:

```ts
const membership = client.channel(
  api.chat.room,
  { threadId },
  {
    room,
    on: {
      message(value) {
        renderMessage(value);
      },
    },
  },
);

membership.send("compose", { text: "hello" });
membership.close();
```

Calling `close()` releases that local observer. The final observer sends one
best-effort leave and removes the shared membership.
