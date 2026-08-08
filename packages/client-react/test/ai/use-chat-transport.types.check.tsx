// Compile-time contract for the /ai chat transport. This file is typechecked
// (see the package tsconfig) and never executed.
import type { QueryRef, SseRef } from "@ackerdb/client";
import type {
  ChatTransport,
  InferUIMessageChunk,
  UIMessage,
  UIMessageChunk,
} from "ai";
import type { ReactNode } from "react";
import {
  useChatTransport,
  type AckerDBChatArgs,
  type AckerDBChatRequest,
} from "@ackerdb/client-react/ai";

// Generated references as codegen would emit them for AI chat procedures.
type StandardArgs = {
  trigger: string;
  chatId: string;
  messageId: string | null;
  messages: UIMessage[];
};
declare const standard: SseRef<StandardArgs, UIMessageChunk>;
declare const custom: SseRef<{ sessionId: string; prompt: string }, UIMessageChunk>;
declare const subsetArgs: SseRef<{ chatId: string }, UIMessageChunk>;
declare const supersetArgs: SseRef<StandardArgs & { model: string }, UIMessageChunk>;
declare const notChunks: SseRef<StandardArgs, { tick: number }>;
declare const wrongKind: QueryRef<StandardArgs, UIMessageChunk>;

// --- standard args: the mapper is optional --------------------------------

function StandardShape(): ReactNode {
  const bare: ChatTransport<UIMessage> = useChatTransport(standard);
  const empty: ChatTransport<UIMessage> = useChatTransport(standard, {});
  const mapped: ChatTransport<UIMessage> = useChatTransport(standard, {
    prepareArgs: (request) => {
      // The request is fully typed without annotations.
      const trigger: "submit-message" | "regenerate-message" = request.trigger;
      const chatId: string = request.chatId;
      const messageId: string | undefined = request.messageId;
      const messages: UIMessage[] = request.messages;
      const metadata: unknown = request.metadata;
      void [trigger, chatId, messageId, messages, metadata];
      return { trigger, chatId, messageId: messageId ?? null, messages };
    },
  });
  void [bare, empty, mapped];
  return null;
}

// --- custom args: the mapper is required and fully typed ------------------

function CustomShape(): ReactNode {
  // @ts-expect-error custom argument shapes require a prepareArgs mapper
  useChatTransport(custom);
  // @ts-expect-error the mapper is mandatory, not merely the options object
  useChatTransport(custom, {});
  const mapped: ChatTransport<UIMessage> = useChatTransport(custom, {
    prepareArgs: (request) => ({ sessionId: request.chatId, prompt: "" }),
  });
  useChatTransport(custom, {
    // @ts-expect-error the mapper's return type must be the procedure's args
    prepareArgs: (request: AckerDBChatRequest) => ({ sessionId: request.chatId }),
  });
  void mapped;
  return null;
}

// --- near-standard shapes still require an explicit mapping ----------------

function NearStandardShapes(): ReactNode {
  // @ts-expect-error ackerdb rejects undeclared fields, so fewer declared args
  // than the standard shape cannot accept the standard args object
  useChatTransport(subsetArgs);
  // @ts-expect-error extra declared args are never sent by the standard shape
  useChatTransport(supersetArgs);
  useChatTransport(subsetArgs, { prepareArgs: (request) => ({ chatId: request.chatId }) });
  useChatTransport(supersetArgs, {
    prepareArgs: (request) => ({
      trigger: request.trigger,
      chatId: request.chatId,
      messageId: request.messageId ?? null,
      messages: request.messages,
      model: "gpt",
    }),
  });
  return null;
}

// --- reference enforcement -------------------------------------------------

function WrongReferences(): ReactNode {
  // @ts-expect-error the procedure must yield AI SDK UIMessageChunk values
  useChatTransport(notChunks);
  // @ts-expect-error a query reference is not an SSE procedure
  useChatTransport(wrongKind);
  return null;
}

// --- raw addresses stay available as the untyped escape hatch --------------

function RawAddress(): ReactNode {
  const bare: ChatTransport<UIMessage> = useChatTransport("api.ai.chat");
  const standardArgs: AckerDBChatArgs = {
    trigger: "submit-message",
    chatId: "c",
    messageId: null,
    messages: [],
  };
  void standardArgs;
  void bare;
  return null;
}

// --- custom UI message types keep end-to-end inference ---------------------

type WeatherMessage = UIMessage<{ locale: string }, { weather: { temperature: number } }>;
declare const weather: SseRef<AckerDBChatArgs<WeatherMessage>, InferUIMessageChunk<WeatherMessage>>;
declare const weatherCustom: SseRef<{ prompt: string }, InferUIMessageChunk<WeatherMessage>>;

function CustomMessage(): ReactNode {
  const typed: ChatTransport<WeatherMessage> = useChatTransport<WeatherMessage>(weather);
  const mapped: ChatTransport<WeatherMessage> = useChatTransport<
    WeatherMessage,
    { prompt: string }
  >(weatherCustom, {
    prepareArgs: (request) => {
      // The mapper sees the caller's message type, not the base UIMessage.
      const locale: string | undefined = request.messages.at(-1)?.metadata?.locale;
      return { prompt: locale ?? "" };
    },
  });
  // @ts-expect-error a plain UIMessageChunk procedure does not satisfy a
  // message type with declared data parts
  useChatTransport<WeatherMessage>(standard);
  void [typed, mapped];
  return null;
}
