import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  ArrowUp,
  Clock,
  Flame,
  Lock,
  Minus,
  MoveDiagonal2,
  RotateCcw,
  Sparkles,
  Square,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChatTranscript } from "./chat-transcript.tsx";
import { clamp, MIN_HEIGHT, MIN_WIDTH, type Geometry } from "./chat-geometry.ts";

interface Suggestion {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tint: string;
  readonly tintBackground: string;
}

const SUGGESTIONS: readonly Suggestion[] = [
  { label: "How full are we right now?", icon: Users, tint: "text-forest-800", tintBackground: "bg-sage-100" },
  { label: "What’s stuck in the kitchen?", icon: Flame, tint: "text-amber-500", tintBackground: "bg-amber-100" },
  {
    label: "Are we beating tonight’s revenue?",
    icon: TrendingUp,
    tint: "text-sky-500",
    tintBackground: "bg-sky-100",
  },
  { label: "Which tables have waited longest?", icon: Clock, tint: "text-clay-500", tintBackground: "bg-clay-100" },
];

const isStreamingStatus = (status: UseChatHelpers<UIMessage>["status"]): boolean =>
  status === "submitted" || status === "streaming";

export function ChatWindow({
  chat,
  geometry,
  onGeometryChange,
  onMinimize,
  onClose,
}: Readonly<{
  chat: UseChatHelpers<UIMessage>;
  geometry: Geometry;
  onGeometryChange: (updater: (geometry: Geometry) => Geometry) => void;
  onMinimize: () => void;
  onClose: () => void;
}>) {
  const [input, setInput] = useState("");
  const windowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
  } | null>(null);

  const streaming = isStreamingStatus(chat.status);
  const empty = chat.messages.length === 0 && chat.error === undefined;

  function send(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || streaming) return;
    chat.clearError();
    void chat.sendMessage({ text: trimmed });
  }

  function submitComposer() {
    send(input);
    setInput("");
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitComposer();
    }
  }

  async function clear() {
    if (streaming) await chat.stop();
    chat.setMessages([]);
    chat.clearError();
    setInput("");
  }

  function onHeaderPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: rect.left, origY: rect.top };
  }

  function onHeaderPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    onGeometryChange((current) => ({
      ...current,
      x: clamp(drag.origX + dx, 0, window.innerWidth - current.width),
      y: clamp(drag.origY + dy, 0, window.innerHeight - current.height),
    }));
  }

  function endPointer(event: ReactPointerEvent<HTMLElement>) {
    dragRef.current = null;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onResizePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const rect = windowRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origW: rect.width,
      origH: rect.height,
      origX: rect.left,
      origY: rect.top,
    };
  }

  function onResizePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const resize = resizeRef.current;
    if (resize === null) return;
    const dw = event.clientX - resize.startX;
    const dh = event.clientY - resize.startY;
    onGeometryChange((current) => ({
      ...current,
      width: clamp(resize.origW + dw, MIN_WIDTH, window.innerWidth - resize.origX),
      height: clamp(resize.origH + dh, MIN_HEIGHT, window.innerHeight - resize.origY),
    }));
  }

  return (
    <div
      ref={windowRef}
      role="dialog"
      aria-label="Savoria Assistant"
      className="fixed z-[60] flex flex-col overflow-hidden rounded-[20px] border border-line bg-warm-white font-sans shadow-[0_28px_70px_rgba(16,42,36,0.28)]"
      style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}
    >
      <header
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        className="flex flex-none touch-none cursor-grab items-center gap-2.5 bg-forest-950 px-[15px] py-[13px] text-warm-white active:cursor-grabbing"
      >
        <span className="flex flex-none flex-col gap-[3px]" aria-hidden="true">
          <span className="h-0.5 w-3 rounded-full bg-[#3f6357]" />
          <span className="h-0.5 w-3 rounded-full bg-[#3f6357]" />
        </span>
        <span className="inline-flex size-[34px] flex-none items-center justify-center rounded-[11px] bg-white/10">
          <Sparkles className="size-4 text-warm-white" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-xs">Savoria Assistant</strong>
          <span className="flex items-center gap-1.5 text-[9px] text-[#9fb8ae]">
            <i className="size-1.5 rounded-full bg-sage-500" aria-hidden="true" />
            {streaming ? "Streaming · read + operate" : "MCP · read + operate"}
          </span>
        </div>
        <HeaderButton label="Clear conversation" onClick={() => void clear()}>
          <RotateCcw className="size-3.5" aria-hidden="true" />
        </HeaderButton>
        <HeaderButton label="Minimize" onClick={onMinimize}>
          <Minus className="size-3.5" aria-hidden="true" />
        </HeaderButton>
        <HeaderButton label="Close" onClick={onClose}>
          <X className="size-3.5" aria-hidden="true" />
        </HeaderButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col bg-cream-50">
        {empty ? (
          <EmptyState onPick={(text) => send(text)} />
        ) : (
          <ChatTranscript
            messages={chat.messages}
            status={chat.status}
            error={chat.error}
            onRetry={() => {
              chat.clearError();
              void chat.regenerate();
            }}
          />
        )}
      </div>

      <footer className="flex-none border-t border-line bg-warm-white px-[15px] pb-3.5 pt-3">
        {streaming && (
          <button
            type="button"
            onClick={() => void chat.stop()}
            className="mb-2.5 flex h-[34px] w-full items-center justify-center gap-1.5 rounded-[11px] border border-line bg-cream-100 text-[10px] font-[750] text-ink-700 transition-colors hover:bg-cream-50"
          >
            <Square className="size-2.5 fill-rose-500 text-rose-500" aria-hidden="true" />
            Stop generating
          </button>
        )}
        <div className="flex h-[46px] items-center gap-2 rounded-[14px] border border-line bg-cream-50 pl-3.5 pr-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={empty ? "Ask about tonight’s service…" : "Ask a follow-up…"}
            aria-label="Message the Savoria Assistant"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ink-900 outline-none placeholder:text-ink-500"
          />
          <button
            type="button"
            onClick={() => (streaming ? void chat.stop() : submitComposer())}
            disabled={!streaming && input.trim().length === 0}
            aria-label={streaming ? "Stop generating" : "Send message"}
            className="inline-flex size-[34px] flex-none items-center justify-center rounded-[11px] bg-forest-900 transition-colors hover:bg-forest-800 disabled:bg-ink-300"
          >
            {streaming ? (
              <Square className="size-3.5 fill-warm-white text-warm-white" aria-hidden="true" />
            ) : (
              <ArrowUp className="size-3.5 text-warm-white" aria-hidden="true" />
            )}
          </button>
        </div>
      </footer>

      <span
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        role="separator"
        aria-label="Resize chat window"
        className="absolute bottom-0 right-0 flex size-5 cursor-nwse-resize touch-none items-end justify-end p-1 text-ink-300"
      >
        <MoveDiagonal2 className="size-3" aria-hidden="true" />
      </span>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: Readonly<{ label: string; onClick: () => void; children: React.ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex size-7 flex-none items-center justify-center rounded-[9px] bg-white/[0.08] text-[#c9d8d0] transition-colors hover:bg-white/[0.16]"
    >
      {children}
    </button>
  );
}

function EmptyState({ onPick }: Readonly<{ onPick: (text: string) => void }>) {
  return (
    <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-[15px] py-4">
      <div className="pt-1.5 text-center">
        <span className="inline-flex size-[52px] items-center justify-center rounded-2xl bg-forest-950">
          <Sparkles className="size-6 text-warm-white" aria-hidden="true" />
        </span>
        <h2 className="mt-3.5 font-display text-[22px] font-semibold text-ink-900">
          Good evening, Amelia
        </h2>
        <p className="mx-auto mt-1.5 max-w-[280px] text-[11px] leading-[1.5] text-ink-500">
          Ask anything about tonight’s floor, kitchen, and revenue. I read live data over MCP.
        </p>
      </div>
      <span className="mt-1 text-[9px] font-extrabold uppercase tracking-[0.1em] text-ink-500">
        Suggested questions
      </span>
      <div className="flex flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              key={suggestion.label}
              type="button"
              onClick={() => onPick(suggestion.label)}
              className="flex w-full items-center gap-2.5 rounded-[13px] border border-line bg-warm-white px-3 py-2.5 text-left transition-colors hover:bg-cream-50"
            >
              <span
                className={`inline-flex size-[30px] flex-none items-center justify-center rounded-[10px] ${suggestion.tintBackground}`}
              >
                <Icon className={`size-3.5 ${suggestion.tint}`} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 text-[11px] font-semibold text-ink-900">
                {suggestion.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-auto flex items-center gap-1.5 pt-2 text-[9px] text-ink-500">
        <Lock className="size-3 flex-none" aria-hidden="true" />
        Answers use read-only MCP tools unless you approve an action.
      </div>
    </div>
  );
}
