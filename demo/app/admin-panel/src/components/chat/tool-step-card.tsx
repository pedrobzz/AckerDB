import { getToolName } from "ai";
import { Braces, Check, ChevronDown, ChevronUp, Terminal, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  isRunningToolState,
  prettyJson,
  toolSummary,
  type ChatToolPart,
} from "./chat-format.tsx";

/** A small forest-tinted spinner matching the design's tool-card loader. */
function Spinner({ className }: Readonly<{ className: string }>) {
  return <span className={`animate-spin rounded-full ${className}`} aria-hidden="true" />;
}

/** Routes a tool part to the bash workspace card or the entity-tool step card. */
export function ToolStepCard({ part }: Readonly<{ part: ChatToolPart }>) {
  if (getToolName(part) === "bash") return <WorkspaceCard part={part} />;
  return <EntityToolCard part={part} />;
}

function EntityToolCard({ part }: Readonly<{ part: ChatToolPart }>) {
  const [expanded, setExpanded] = useState(false);
  const running = isRunningToolState(part.state);
  const failed = part.state === "output-error";
  const canExpand = !running;
  const summary = toolSummary(part);

  return (
    <div
      className={`overflow-hidden rounded-[13px] border bg-warm-white ${
        failed ? "border-rose-500" : running ? "border-sage-500" : "border-line"
      }`}
    >
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left disabled:cursor-default"
      >
        <span
          className={`inline-flex size-7 flex-none items-center justify-center rounded-[9px] ${
            failed ? "bg-rose-100" : "bg-sage-100"
          }`}
        >
          {running ? (
            <Spinner className="size-3.5 border-2 border-sage-200 border-t-forest-800" />
          ) : failed ? (
            <TriangleAlert className="size-3.5 text-rose-500" aria-hidden="true" />
          ) : (
            <Braces className="size-3.5 text-forest-800" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={`text-[9px] font-bold tracking-[0.02em] ${
                failed ? "text-rose-500" : "text-ink-500"
              }`}
            >
              {running ? "Running" : failed ? "Failed" : "Queried"}
            </span>
            <code className="font-mono text-[10px] font-bold text-forest-900">
              {getToolName(part)}
            </code>
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-ink-700">{summary}</span>
        </span>
        {running ? (
          <span className="flex-none whitespace-nowrap text-[9px] font-[750] text-forest-800">
            Working…
          </span>
        ) : (
          <span className="inline-flex size-6 flex-none items-center justify-center rounded-lg bg-cream-100">
            {expanded ? (
              <ChevronUp className="size-[11px] text-ink-500" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-[11px] text-ink-500" aria-hidden="true" />
            )}
          </span>
        )}
      </button>

      {expanded && !running && (
        <div className="flex flex-col gap-2.5 px-3 pb-3">
          <JsonPanel label="Input" body={prettyJson(part.input)} />
          {failed ? (
            <JsonPanel label="Error" body={part.errorText} tone="danger" />
          ) : (
            <JsonPanel label="Output" body={prettyJson(part.output)} />
          )}
        </div>
      )}
    </div>
  );
}

function JsonPanel({
  label,
  body,
  tone = "default",
}: Readonly<{ label: string; body: string; tone?: "default" | "danger" }>) {
  return (
    <div>
      <span className="mb-[5px] block text-[8px] font-extrabold uppercase tracking-[0.1em] text-ink-500">
        {label}
      </span>
      <pre
        className={`m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] border px-[11px] py-[9px] font-mono text-[10px] leading-[1.5] ${
          tone === "danger"
            ? "border-rose-500/40 bg-rose-100 text-rose-500"
            : "border-line bg-cream-100 text-ink-700"
        }`}
      >
        {body}
      </pre>
    </div>
  );
}

function WorkspaceCard({ part }: Readonly<{ part: ChatToolPart }>) {
  const running = isRunningToolState(part.state);
  const failed = part.state === "output-error";
  const input = typeof part.input === "object" && part.input !== null ? part.input : {};
  const script =
    typeof (input as { script?: unknown }).script === "string"
      ? (input as { script: string }).script
      : "";
  const result =
    part.state === "output-available" && typeof part.output === "object" && part.output !== null
      ? (part.output as { exitCode?: number; stdout?: string; stderr?: string })
      : undefined;
  const exitCode = result?.exitCode ?? 0;
  const stdout = (result?.stdout ?? "").trim();
  const stderr = (result?.stderr ?? "").trim();
  const clean = exitCode === 0 && !failed;
  const outputText = failed
    ? part.errorText
    : clean
      ? stdout || "(no output)"
      : stderr || stdout || "(no output)";

  return (
    <div className="overflow-hidden rounded-[13px] border border-pine-border bg-forest-950">
      <div className="flex items-center gap-2 border-b border-pine-border px-3 py-2">
        <Terminal className="size-3 text-pine-muted" aria-hidden="true" />
        <span className="text-[9px] font-[750] uppercase tracking-[0.06em] text-pine-text">
          Bash
        </span>
        <code className="font-mono text-[9px] text-pine-dim">/data</code>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 text-[8px] font-[750] ${
            running ? "text-amber-300" : clean ? "text-pine-ok" : "text-rose-500"
          }`}
        >
          {running ? (
            <Spinner className="size-[11px] border-2 border-white/20 border-t-amber-300" />
          ) : clean ? (
            <Check className="size-2.5" aria-hidden="true" />
          ) : (
            <TriangleAlert className="size-2.5" aria-hidden="true" />
          )}
          {running ? "running" : failed ? "failed" : `exit ${exitCode}`}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <div className="flex gap-2">
          <span className="font-mono text-[10px] text-sage-500">$</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-[1.55] text-pine-bright">
            {script}
          </code>
        </div>
        <div className="mt-2 flex items-start gap-2">
          <span className="w-2 flex-none" />
          {running ? (
            <span className="h-3.5 w-[7px] animate-pulse bg-pine-bright/70" aria-hidden="true" />
          ) : (
            <code
              className={`min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-[1.55] ${
                clean ? "text-pine-muted" : "text-rose-500"
              }`}
            >
              {outputText}
            </code>
          )}
        </div>
      </div>
    </div>
  );
}
