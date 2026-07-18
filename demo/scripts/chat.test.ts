import { expect, test } from "bun:test";
import { api } from "@demo/dbzz-codegen/api";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { expectCode, withBackend } from "./mcp-harness.ts";

// The chat endpoint's model factory is the one seam: "mock" swaps the gateway
// model for a scripted one that drives the tool loop once (a get_tables call,
// then a short final answer). These tests prove only that mechanical loop —
// text streams, a tool call executes in-stream, and the stream ends cleanly.
// Nothing about answer quality is asserted; that is human-tested.
const MOCK_MODEL = { DBZZ_DEMO_CHAT_MODEL: "mock" };

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

test("staff chat streams text and a get_tables tool round-trip", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const chunks = await drain(
      staff.sse(api.chat.stream, chatArgs("How many tables are available?")),
    );

    // Text arrived as streamed deltas.
    const textDeltas = chunks.filter((chunk) => chunk.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    // The get_tables tool was invoked in-stream and produced an output.
    const invocation = chunks.find(
      (chunk) =>
        (chunk.type === "tool-input-available" || chunk.type === "tool-input-start") &&
        chunk.toolName === "get_tables",
    ) as (ChatChunk & { toolCallId: string }) | undefined;
    expect(invocation).toBeDefined();
    const output = chunks.find(
      (chunk) =>
        chunk.type === "tool-output-available" &&
        chunk.toolCallId === invocation!.toolCallId,
    ) as (ChatChunk & { output: unknown }) | undefined;
    expect(output).toBeDefined();
    expect(output!.output).toBeDefined();

    // The stream finished cleanly.
    expect(chunks.map((chunk) => chunk.type)).toContain("finish");
  }, MOCK_MODEL);
});

test("chat rejects an anonymous caller", async () => {
  await withBackend(async (backend) => {
    const anonymous = backend.client();
    await expectCode(
      drain(anonymous.sse(api.chat.stream, chatArgs("Who is on the floor?"))),
      "unauthenticated",
    );
  }, MOCK_MODEL);
});
