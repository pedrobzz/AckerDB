import { ChevronUp, Sparkles, X } from "lucide-react";

const DOCK = "fixed bottom-[28px] right-[30px] z-[60]";

/**
 * The bottom-right launcher. Closed → the round FAB; minimized → the activity
 * pill (both per the AdminChat design). Renders nothing while the window is open.
 */
export function ChatLauncher({
  mode,
  streaming,
  active,
  hasActivity,
  onOpen,
  onClose,
}: Readonly<{
  mode: "closed" | "open" | "minimized";
  streaming: boolean;
  active: { tool: string; step: number } | null;
  hasActivity: boolean;
  onOpen: () => void;
  onClose: () => void;
}>) {
  if (mode === "open") return null;
  if (mode === "minimized") {
    return (
      <MinimizedPill
        streaming={streaming}
        active={active}
        onOpen={onOpen}
        onClose={onClose}
      />
    );
  }
  return <Fab streaming={streaming} hasActivity={hasActivity} onOpen={onOpen} />;
}

function Fab({
  streaming,
  hasActivity,
  onOpen,
}: Readonly<{ streaming: boolean; hasActivity: boolean; onOpen: () => void }>) {
  return (
    <div className={`${DOCK} flex items-center gap-2.5`}>
      <span className="hidden rounded-xl border border-line bg-warm-white px-3 py-2.5 text-[11px] font-bold text-ink-900 shadow-[0_12px_36px_rgba(16,42,36,0.18)] sm:inline">
        Ask the assistant
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open the Savoria Assistant"
        className="relative inline-flex size-[58px] items-center justify-center rounded-full bg-forest-900 shadow-[0_16px_40px_rgba(16,42,36,0.32)] transition-colors hover:bg-forest-800"
      >
        <Sparkles className="size-6 text-warm-white" aria-hidden="true" />
        {(hasActivity || streaming) && (
          <span className="absolute right-1.5 top-1.5 size-3 rounded-full border-2 border-forest-900 bg-clay-500" />
        )}
      </button>
    </div>
  );
}

function MinimizedPill({
  streaming,
  active,
  onOpen,
  onClose,
}: Readonly<{
  streaming: boolean;
  active: { tool: string; step: number } | null;
  onOpen: () => void;
  onClose: () => void;
}>) {
  return (
    <div
      className={`${DOCK} flex w-[344px] max-w-[calc(100vw-40px)] items-center gap-2.5 rounded-2xl bg-forest-950 px-3 py-[11px] shadow-[0_20px_48px_rgba(16,42,36,0.34)]`}
    >
      <span className="inline-flex size-[34px] flex-none items-center justify-center rounded-[11px] bg-white/10">
        <Sparkles className="size-4 text-warm-white" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block text-[11px] text-warm-white">Savoria Assistant</strong>
        <span className="mt-0.5 flex items-center gap-1.5">
          {streaming && (
            <span className="size-[11px] animate-spin rounded-full border-2 border-white/20 border-t-clay-500" />
          )}
          <span className="truncate text-[9px] text-[#9fb8ae]">
            {active !== null ? (
              <>
                Running{" "}
                <code className="font-mono text-[9px] text-[#c9d8d0]">{active.tool}</code> · step{" "}
                {active.step}
              </>
            ) : streaming ? (
              "Responding…"
            ) : (
              "Tap to reopen"
            )}
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Expand the Savoria Assistant"
        className="inline-flex size-7 flex-none items-center justify-center rounded-[9px] bg-white/[0.08] text-[#c9d8d0] transition-colors hover:bg-white/[0.16]"
      >
        <ChevronUp className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the Savoria Assistant"
        className="inline-flex size-7 flex-none items-center justify-center rounded-[9px] bg-white/[0.08] text-[#c9d8d0] transition-colors hover:bg-white/[0.16]"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
