import type { ChatStatus, UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { Fragment, type ReactNode } from "react";
import { money } from "../../lib/domain.ts";

/** A tool part in either its typed (`tool-<name>`) or dynamic flavour. */
export type ChatToolPart = Extract<
  UIMessage["parts"][number],
  { type: `tool-${string}` } | { type: "dynamic-tool" }
>;

/** Whether a response is in flight (from submit until the stream settles). */
export const isStreamingStatus = (status: ChatStatus): boolean =>
  status === "submitted" || status === "streaming";

/** Whether a tool part is still running (no output yet). */
export const isRunningToolState = (state: ChatToolPart["state"]): boolean =>
  state === "input-streaming" || state === "input-available";

/** The states a tool part streams through, in order. */
export type ChatToolState = ChatToolPart["state"];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const plural = (count: number, singular: string, many = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : many}`;

const KITCHEN_ATTENTION = new Set(["ORDERED", "PREPARING"]);

/** Short verb phrase shown while a tool is still running (no output yet). */
const RUNNING_PHRASE: Record<string, string> = {
  get_orders: "Reading open checks…",
  get_order_items: "Scanning the kitchen queue…",
  get_tables: "Checking floor occupancy…",
  get_menu_categories: "Loading menu sections…",
  get_menu_items: "Loading menu items…",
  get_guests: "Looking up guests…",
  advance_kitchen_item: "Advancing the kitchen item…",
  cancel_order: "Cancelling the order…",
};

/** One-line humanized summary of a completed tool call's output. */
function summarizeOutput(tool: string, output: unknown): string {
  const record = asRecord(output);
  switch (tool) {
    case "get_orders": {
      const orders = asArray(record.orders);
      const open = orders.filter((order) => asRecord(order).status === "OPEN");
      const openValue = open.reduce<number>(
        (total, order) => total + asNumber(asRecord(order).totalCents),
        0,
      );
      if (open.length > 0 && open.length !== orders.length) {
        return `${plural(orders.length, "order")} · ${open.length} open · ${money(openValue)} in flight`;
      }
      if (open.length > 0) {
        return `${plural(open.length, "open check")} · ${money(openValue)} in flight`;
      }
      return plural(orders.length, "order");
    }
    case "get_order_items": {
      const items = asArray(record.items);
      const attention = items.filter((item) =>
        KITCHEN_ATTENTION.has(asString(asRecord(item).status)),
      ).length;
      const head = plural(items.length, "kitchen item");
      return attention > 0 ? `${head} · ${attention} need attention` : `${head} · all moving`;
    }
    case "get_tables": {
      const tables = asArray(record.tables);
      const occupied = tables.filter((table) => asRecord(table).occupied === true).length;
      return `${plural(tables.length, "table")} · ${occupied} occupied`;
    }
    case "get_menu_categories":
      return plural(asArray(record.categories).length, "category", "categories");
    case "get_menu_items":
      return plural(asArray(record.items).length, "menu item");
    case "get_guests":
      return plural(asArray(record.guests).length, "guest");
    case "advance_kitchen_item":
      return `Advanced to ${asString(record.status) || "next status"}`;
    case "cancel_order":
      return `Freed table ${asNumber(record.tableNumber)} · ${plural(asNumber(record.itemsCancelled), "item")} voided`;
    default: {
      const keys = Object.keys(record);
      return keys.length > 0 ? `Returned ${keys.join(", ")}` : "Done";
    }
  }
}

/** The line rendered under the tool name, whatever state the call is in. */
export function toolSummary(part: ChatToolPart): string {
  const tool = getToolName(part);
  if (part.state === "output-error") return part.errorText || "The tool call failed.";
  if (part.state === "output-available") return summarizeOutput(tool, part.output);
  return RUNNING_PHRASE[tool] ?? "Working…";
}

/** Pretty-printed JSON for the expandable input/output panels. */
export function prettyJson(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The running tool and its 1-based step, for the minimized pill. `null` when idle. */
export function activeToolStatus(messages: UIMessage[]): { tool: string; step: number } | null {
  const last = messages.at(-1);
  if (last === undefined || last.role !== "assistant") return null;
  const toolParts = last.parts.filter(isToolUIPart);
  for (let index = toolParts.length - 1; index >= 0; index -= 1) {
    const part = toolParts[index];
    if (isRunningToolState(part.state)) {
      return { tool: getToolName(part), step: index + 1 };
    }
  }
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded-[5px] bg-cream-100 px-[5px] py-px font-mono text-[10px] text-ink-900"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={key}>{token}</Fragment>;
  });
}

/**
 * Minimal markdown for assistant text: `**bold**`, `` `inline code` `` and
 * line breaks. Deliberately not a full parser — the design only shows these.
 */
export function MarkdownText({ text }: Readonly<{ text: string }>): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {renderInline(line, String(index))}
    </Fragment>
  ));
}
