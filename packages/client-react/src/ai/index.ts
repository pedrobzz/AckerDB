// The `@ackerdb/client-react/ai` subpath: AI SDK v7 integration, isolated from
// the base entry so consumers that never import it never resolve AI SDK
// code (`ai` is a type-only, optional peer of this subpath).
export {
  useChatTransport,
  type AckerDBChatArgs,
  type AckerDBChatRequest,
  type AckerDBChatTransportOptions,
  type AckerDBChatTransportOptionsWithArgs,
} from "./use-chat-transport.ts";
