// Compile-time contract for useChannel: generated reference inference, optional
// rooms, both handler forms, handler bundle extraction, and typed sends.
import type { ApplicationError, ChannelRef } from "@ackerdb/core";
import {
  useChannel,
  type ChannelOn,
  type UseChannelOptions,
} from "@ackerdb/client-react";

type ChatRejected = ApplicationError<
  "chat_forbidden",
  { readonly threadId: bigint },
  403
>;

declare const chat: ChannelRef<
  { readonly threadId: bigint },
  string,
  {
    readonly message: { readonly body: string };
    readonly typing: { readonly active: boolean };
  },
  {
    readonly message: { readonly id: bigint; readonly body: string };
    readonly presence: { readonly online: number };
  },
  ChatRejected
>;

declare const announcements: ChannelRef<
  Readonly<Record<never, never>>,
  never,
  { readonly acknowledge: { readonly id: bigint } },
  { readonly published: { readonly id: bigint; readonly title: string } }
>;

const mapped: ChannelOn<typeof chat> = {
  message(message) {
    const id: bigint = message.id;
    const body: string = message.body;
    void [id, body];
  },
  presence(presence) {
    const online: number = presence.online;
    void online;
  },
};

const union: ChannelOn<typeof chat> = (event) => {
  if (event.type === "message") {
    const body: string = event.payload.body;
    void body;
  } else {
    const online: number = event.payload.online;
    void online;
  }
};

interface UseChatRoomInput {
  readonly on?: ChannelOn<typeof chat>;
}

function useChatRoom(input: UseChatRoomInput = {}) {
  return useChannel(chat, { threadId: 1n }, {
    room: "support",
    handlerKey: "useChatRoom",
    on: input.on,
  });
}

function Consumer() {
  const room = useChatRoom({ on: mapped });
  room.send("message", { body: "hello" });
  room.send("typing", { active: true });
  if (room.state.phase === "rejected") {
    const code: "chat_forbidden" = room.state.error.code;
    const threadId: bigint = room.state.error.body.threadId;
    void [code, threadId];
  }

  useChannel(chat, { threadId: 2n }, {
    room: "sales",
    on: union,
  });
  useChannel(announcements, {}, {
    on: {
      published(event) {
        const title: string = event.title;
        void title;
      },
    },
  });
  useChannel(announcements, {});
  return null;
}

const options: UseChannelOptions<typeof chat> = {
  room: "support",
  handlerKey: "useChatRoom",
  on: mapped,
};
void options;

// @ts-expect-error roomed channels require a room
useChannel(chat, { threadId: 1n });
// @ts-expect-error the room type comes from the channel declaration
useChannel(chat, { threadId: 1n }, { room: 1 });
// @ts-expect-error roomless channels do not accept a room
useChannel(announcements, {}, { room: "global" });
// @ts-expect-error arguments come from the channel declaration
useChannel(chat, { threadId: "one" }, { room: "support" });

const result = useChannel(chat, { threadId: 1n }, { room: "support" });
// @ts-expect-error client event names are exact
result.send("presence", { online: 1 });
// @ts-expect-error the message payload is exact
result.send("message", { body: 1 });
// @ts-expect-error server event payloads are inferred in handler maps
const badOn: ChannelOn<typeof chat> = { message: (value: { id: number }) => value };

export { Consumer };
