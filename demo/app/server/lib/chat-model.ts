import { gateway } from "@ai-sdk/gateway";
import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type LanguageModel,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

/**
 * The Admin Chat's model factory — the single seam between the demo backend and
 * a language model, selected by the `DBZZ_DEMO_CHAT_MODEL` environment variable:
 *
 * - unset / `"gateway"` → DeepSeek V4 Flash on the Vercel AI Gateway with
 *   reasoning disabled. The gateway reads `AI_GATEWAY_API_KEY` from the
 *   environment, so a real key drops in without touching code.
 * - `"mock"` → a scripted model that drives the tool loop exactly once (one
 *   `get_tables` call, then a short final answer). It exists only to prove the
 *   mechanical streaming loop under test and says nothing about answer quality.
 */
export function createChatModel(): LanguageModel {
  const selection = process.env.DBZZ_DEMO_CHAT_MODEL ?? "gateway";
  switch (selection) {
    case "gateway":
      return gatewayModel();
    case "mock":
      return mockModel();
    default:
      throw new Error(
        `DBZZ_DEMO_CHAT_MODEL must be "gateway" or "mock", got "${selection}"`,
      );
  }
}

const GATEWAY_MODEL = "deepseek/deepseek-v4-flash";

function gatewayModel(): LanguageModel {
  // DeepSeek V4 Flash is a hybrid thinking/non-thinking model. Reasoning is
  // switched off with the DeepSeek provider option `thinking: { type: "disabled" }`
  // (ai-sdk.dev/providers/ai-sdk-providers/deepseek#reasoning). Through the AI
  // Gateway, provider-specific options ride under the provider-slug namespace
  // (vercel.com/docs/ai-gateway/models-and-providers/provider-options#reasoning).
  // Baked in as a default setting here so the chat handler stays model-agnostic.
  return wrapLanguageModel({
    model: gateway(GATEWAY_MODEL),
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: { deepseek: { thinking: { type: "disabled" } } },
      },
    }),
  });
}

const MOCK_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 0, reasoning: 0 },
} as const;

function mockModel(): LanguageModel {
  return new MockLanguageModelV4({
    modelId: "dbzz-demo-mock-chat",
    doStream: async ({ prompt }) => {
      // streamText appends the executed tool's result as a `tool`-role message
      // before the next step. First step → call get_tables; once its result is
      // back in the conversation → emit a short final answer that ends the run.
      const toolResultSeen = prompt.some((message) => message.role === "tool");
      if (toolResultSeen) {
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "final" },
              {
                type: "text-delta" as const,
                id: "final",
                delta: "The floor is loaded — ask me anything about it.",
              },
              { type: "text-end" as const, id: "final" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage: MOCK_USAGE,
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "call-get-tables",
              toolName: "get_tables",
              // Deliberately stringly, mimicking DeepSeek's function calling:
              // the chat's repairToolCall must coerce these per the schema
              // before dbzz's strict validation accepts them.
              input: '{"activeOnly":"true","limit":"50"}',
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage: MOCK_USAGE,
            },
          ],
        }),
      };
    },
  });
}
