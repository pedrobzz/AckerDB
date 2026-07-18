import type { ChatStatus, UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { MarkdownText, isStreamingStatus, type ChatToolPart } from "./chat-format.tsx";
import { ToolStepCard } from "./tool-step-card.tsx";

/** Distance (px) from the bottom within which we keep the view pinned. */
const PIN_THRESHOLD = 48;

function Avatar() {
  return (
    <span className="inline-flex size-[26px] flex-none items-center justify-center rounded-[9px] bg-forest-950">
      <Sparkles className="size-[13px] text-warm-white" aria-hidden="true" />
    </span>
  );
}

function UserBubble({ text }: Readonly<{ text: string }>) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[300px] whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] bg-forest-900 px-[13px] py-2.5 text-[11px] leading-[1.45] text-warm-white">
        {text}
      </div>
    </div>
  );
}

function AssistantText({ text, cursor }: Readonly<{ text: string; cursor: boolean }>) {
  return (
    <div className="flex gap-2.5">
      <Avatar />
      <p className="m-0 flex-1 pt-1 text-[11px] leading-[1.55] text-ink-900">
        <MarkdownText text={text} />
        {cursor && (
          <span
            className="ml-0.5 inline-block h-[13px] w-0.5 translate-y-0.5 animate-pulse bg-forest-900 align-text-bottom"
            aria-hidden="true"
          />
        )}
      </p>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="flex gap-2.5">
      <Avatar />
      <p className="m-0 flex-1 pt-1.5 text-[11px] leading-[1.55] text-ink-500">
        <span className="inline-flex gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-ink-300 [animation-delay:-0.2s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-ink-300 [animation-delay:-0.1s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-ink-300" />
        </span>
      </p>
    </div>
  );
}

const userText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

const isRenderable = (part: UIMessage["parts"][number]): boolean =>
  (part.type === "text" && part.text.length > 0) || isToolUIPart(part);

function AssistantMessage({
  message,
  streaming,
}: Readonly<{ message: UIMessage; streaming: boolean }>) {
  // The caret only trails the assistant's current text — never a tool card that
  // is streaming after it (that card carries its own spinner).
  const lastRenderable = message.parts.reduce(
    (last, part, index) => (isRenderable(part) ? index : last),
    -1,
  );
  return (
    <>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          if (part.text.length === 0) return null;
          return (
            <AssistantText
              key={index}
              text={part.text}
              cursor={streaming && index === lastRenderable}
            />
          );
        }
        if (isToolUIPart(part)) {
          return <ToolStepCard key={index} part={part as ChatToolPart} />;
        }
        return null;
      })}
    </>
  );
}

function ErrorCard({
  message,
  onRetry,
}: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <div className="rounded-[13px] border border-rose-500/50 bg-rose-100 p-3" role="alert">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="size-[15px] flex-none text-rose-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block text-[11px] text-rose-500">Something went wrong</strong>
          <p className="mt-1 break-words text-[10px] leading-[1.5] text-ink-700">{message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line bg-warm-white px-3 text-[10px] font-[750] text-forest-800 transition-colors hover:bg-cream-50"
          >
            <RotateCcw className="size-3" aria-hidden="true" /> Try again
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatTranscript({
  messages,
  status,
  error,
  onRetry,
}: Readonly<{
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  onRetry: () => void;
}>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Keep the view pinned to the newest content while the user hasn't scrolled
  // up. Runs on every streamed update (useChat yields a fresh messages array).
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, status, error]);

  function handleScroll() {
    const element = scrollRef.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedRef.current = distance <= PIN_THRESHOLD;
  }

  const waiting = status === "submitted" && messages.at(-1)?.role === "user";
  const streaming = isStreamingStatus(status);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-[15px] py-4"
      style={{ minHeight: 0 }}
    >
      <div className="flex flex-col gap-3">
        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} text={userText(message)} />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              streaming={streaming && message === messages.at(-1)}
            />
          ),
        )}
        {waiting && <ThinkingRow />}
        {error !== undefined && <ErrorCard message={error.message} onRetry={onRetry} />}
      </div>
    </div>
  );
}
