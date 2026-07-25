import { expect, test } from "bun:test";
import { api } from "@demo/dbzz-codegen/api";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { withBackend } from "./mcp-harness.ts";
import { expectRejectedCode } from "./result.ts";

// Offline verification of the full chat streaming flow through the sseProcedure,
// with zero gateway usage: the "mock" model factory swaps the DeepSeek gateway
// for a scripted model that drives the tool loop once (a get_tables call carrying
// real typed input, then a short final answer). These tests assert only the
// mechanical stream — the ordered sequence of chunks the sseProcedure yields —
// never answer quality, which is human-tested.
const MOCK_MODEL = { DBZZ_DEMO_CHAT_MODEL: "mock" };

// The scripted mock's final answer, streamed as text deltas.
const FINAL_ANSWER = "The floor is loaded — ask me anything about it.";

type ChatChunk = InferUIMessageChunk<UIMessage>;

function chatArgs(text: string) {
  const message: UIMessage = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text }],
  };
  return {
    trigger: "submit-message" as const,
    chatId: "chat-1",
    messageId: null,
    messages: [message],
  };
}

async function drain(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("staff chat streams a get_tables call, its result, then the final text in order", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const chunks = await drain(
      staff.sse(api.chat.stream, chatArgs("How many tables are available?")),
    );

    // The get_tables call is streamed with real typed input — booleans and
    // numbers, not stringified scalars — and passes dbzz's strict validation.
    const inputAvailable = chunks.find(
      (chunk) => chunk.type === "tool-input-available" && chunk.toolName === "get_tables",
    ) as (ChatChunk & { toolCallId: string; input: unknown }) | undefined;
    expect(inputAvailable).toBeDefined();
    expect(inputAvailable!.input).toEqual({ activeOnly: true, limit: 50 });

    // The tool ran in-stream and its result is streamed back under the same id.
    const output = chunks.find(
      (chunk) =>
        chunk.type === "tool-output-available" &&
        chunk.toolCallId === inputAvailable!.toolCallId,
    ) as (ChatChunk & { output: unknown }) | undefined;
    expect(output).toBeDefined();
    expect(output!.output).toBeDefined();

    // The final answer arrives as streamed text deltas that reconstruct it whole.
    const streamedText = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => (chunk as ChatChunk & { delta: string }).delta)
      .join("");
    expect(streamedText).toBe(FINAL_ANSWER);

    // Strict order: tool call → tool result → final text → clean finish.
    const types = chunks.map((chunk) => chunk.type);
    const callAt = types.indexOf("tool-input-available");
    const resultAt = types.indexOf("tool-output-available");
    const textAt = types.indexOf("text-delta");
    const finishAt = types.lastIndexOf("finish");
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(callAt);
    expect(textAt).toBeGreaterThan(resultAt);
    expect(finishAt).toBeGreaterThan(textAt);
  }, MOCK_MODEL);
});

test("chat rejects an anonymous caller", async () => {
  await withBackend(async (backend) => {
    const anonymous = backend.client();
    await expectRejectedCode(
      drain(anonymous.sse(api.chat.stream, chatArgs("Who is on the floor?"))),
      "unauthenticated",
    );
  }, MOCK_MODEL);
});
