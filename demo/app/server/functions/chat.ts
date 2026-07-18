import { dbz } from "@dbzz/server";
import { sseProcedure } from "@demo/dbzz-codegen/server";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type InferUIMessageChunk,
  type UIMessage,
} from "ai";
import { staffAccess } from "../lib/access.ts";
import { createChatModel } from "../lib/chat-model.ts";
import { admin } from "./admin/mcp.ts";

/** How many streamText steps (model turn + tool round) one answer may take. */
const MAX_STEPS = 8;

const SYSTEM_PROMPT = [
  "You are the Admin Chat for Savoria, a single sit-down restaurant. You help",
  "the staff running the floor and kitchen answer questions about the live",
  "business and take two concrete actions, all through the Admin MCP tools.",
  "",
  "Your tools:",
  "- Entity query tools (get_tables and its siblings) for direct lookups of the",
  "  floor, kitchen queue, menu, orders and guests.",
  "- A bash workspace over the restaurant's live data rendered as JSONL files",
  "  under /data, for open-ended analytics the entity tools can't answer",
  "  (occupancy, waiting times, revenue per minute, and the like).",
  "- Two staff action tools: advance a kitchen item to its next status, and",
  "  cancel an open order. Use these only when the staff member clearly asks.",
  "",
  "Prefer an entity query tool for simple lookups and the bash workspace for",
  "anything analytical. Answer in plain, concise language a busy staff member",
  "can act on. If a tool returns nothing useful, say so instead of guessing.",
].join("\n");

/**
 * Admin Chat backend: a staff-only SSE procedure that runs the Admin MCP agent
 * and streams AI SDK v7 UI-message chunks. Its arguments are the standard dbzz
 * chat-transport shape, so the front-end wires it with `useChatTransport` and no
 * `prepareArgs` mapper.
 *
 * The tools handed to `streamText` are the Admin MCP's own zero-hop tools,
 * materialized in-process under a local grant of both scopes — the same
 * authority a fully-scoped owner token carries, with no second HTTP hop. Staff
 * resolve to a user principal, so the grant is exactly `read` + `operate`.
 */
export const stream = sseProcedure({
  access: staffAccess,
  args: {
    trigger: dbz.string(),
    chatId: dbz.string(),
    messageId: dbz.nullable(dbz.string()),
    messages: dbz.jsonb<UIMessage[]>(),
  },
  yields: dbz.jsonb<InferUIMessageChunk<UIMessage>>(),
  handler: async (ctx, args) => {
    const tools = admin.aiTools(ctx, { scopes: ["read", "operate"] });
    const result = streamText({
      model: createChatModel(),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(args.messages),
      tools,
      // Bounded agent loop: model turn → tool round, repeated until an answer.
      stopWhen: stepCountIs(MAX_STEPS),
      // A client abort (or the credential lease ending) cancels generation.
      abortSignal: ctx.abortSignal,
    });
    return toUIMessageStream({ stream: result.stream, tools });
  },
});
