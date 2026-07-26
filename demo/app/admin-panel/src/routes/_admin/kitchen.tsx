import { useMutation, useQuery } from "@ackerdb/client-react";
import { api } from "@demo/ackerdb-codegen/api";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  Ban,
  Clock3,
  Printer,
  Radio,
  UtensilsCrossed,
} from "lucide-react";
import { useState } from "react";
import { useToast } from "../../components/toast.tsx";
import {
  PageHeader,
  QueryContent,
  SearchField,
  StatePanel,
  StatusPill,
} from "../../components/ui.tsx";
import {
  errorMessage,
  ITEM_STATUS_ORDER,
  relativeMinutes,
  type ItemStatus,
  type KitchenItem,
} from "../../lib/domain.ts";

export const Route = createFileRoute("/_admin/kitchen")({
  component: KitchenPage,
});

const laneCopy: Record<ItemStatus, { label: string; action: string | null }> = {
  ORDERED: { label: "Ordered", action: "Start preparing" },
  PREPARING: { label: "Preparing", action: "Mark prepared" },
  PREPARED: { label: "Prepared", action: "Mark served" },
  SERVED: { label: "Served", action: null },
  CANCELLED: { label: "Cancelled", action: null },
};

function KitchenPage() {
  const queue = useQuery(api.kitchen.queue, {});
  const advance = useMutation(api.kitchen.advance);
  const cancel = useMutation(api.kitchen.cancel);
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function advanceItem(item: KitchenItem) {
    setBusyId(item.id.toString());
    try {
      const result = await advance({ orderItemId: item.id });
      if (!result.ok) throw result.error;
      const next = result.data;
      toast.success(
        `${item.name} moved to ${next.toLowerCase()}.`,
        `Table ${item.tableNumber}`,
      );
    } catch (error) {
      toast.error(errorMessage(error, "Could not advance this item"));
    } finally {
      setBusyId(null);
    }
  }

  async function cancelKitchenItem(item: KitchenItem) {
    setBusyId(item.id.toString());
    try {
      const result = await cancel({ orderItemId: item.id });
      if (!result.ok) throw result.error;
      toast.success(`${item.name} was cancelled.`, `Table ${item.tableNumber}`);
    } catch (error) {
      toast.error(errorMessage(error, "Could not cancel this item"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page page--full-height kitchen-page">
      <PageHeader
        title="Kitchen queue"
        subtitle="Move every ordered item through preparation and service."
        action={
          <button
            className="button button--secondary"
            type="button"
            onClick={() => window.print()}
          >
            <Printer aria-hidden="true" /> Print queue
          </button>
        }
      />

      <QueryContent state={queue} loadingLabel="Opening the kitchen queue…">
        {(items) => {
          const normalized = search.trim().toLowerCase();
          const filtered = normalized
            ? items.filter(
                (item) =>
                  item.name.toLowerCase().includes(normalized) ||
                  item.guestName.toLowerCase().includes(normalized) ||
                  item.tableNumber.toString().includes(normalized) ||
                  item.orderId.toString().includes(normalized),
              )
            : items;
          const activeCount = items.filter(
            (item) => item.status !== "SERVED" && item.status !== "CANCELLED",
          ).length;
          return (
            <>
              <section className="kitchen-toolbar surface">
                <div className="live-indicator">
                  <Radio aria-hidden="true" />
                  <strong>Live · {activeCount} active items</strong>
                  <span>Changes reach guests instantly</span>
                </div>
                <SearchField
                  value={search}
                  onChange={setSearch}
                  placeholder="Table, guest, or dish"
                  label="Search kitchen queue"
                />
              </section>

              {items.length === 0 ? (
                <section className="surface grow-state">
                  <StatePanel
                    icon={UtensilsCrossed}
                    title="Kitchen is clear"
                    detail="New order items appear here automatically."
                  />
                </section>
              ) : filtered.length === 0 ? (
                <section className="surface grow-state">
                  <StatePanel
                    title="No matching kitchen items"
                    detail="Clear the search to see the complete live queue."
                  />
                </section>
              ) : (
                <div
                  className="kitchen-board"
                  aria-label="Kitchen status lanes"
                >
                  {ITEM_STATUS_ORDER.map((status) => {
                    const laneItems = filtered.filter(
                      (item) => item.status === status,
                    );
                    return (
                      <section
                        className={`kitchen-lane kitchen-lane--${status.toLowerCase()}`}
                        key={status}
                      >
                        <header>
                          <StatusPill status={status} />
                          <span>{laneItems.length}</span>
                        </header>
                        <div className="kitchen-lane__items">
                          {laneItems.length === 0 ? (
                            <div className="lane-empty">No items</div>
                          ) : (
                            laneItems.map((item) => (
                              <KitchenTicket
                                key={item.id.toString()}
                                item={item}
                                busy={busyId === item.id.toString()}
                                onAdvance={() => void advanceItem(item)}
                                onCancel={() => void cancelKitchenItem(item)}
                              />
                            ))
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          );
        }}
      </QueryContent>
    </div>
  );
}

function KitchenTicket({
  item,
  busy,
  onAdvance,
  onCancel,
}: Readonly<{
  item: KitchenItem;
  busy: boolean;
  onAdvance: () => void;
  onCancel: () => void;
}>) {
  const action = laneCopy[item.status].action;
  return (
    <article className="kitchen-ticket">
      <div className="kitchen-ticket__meta">
        <strong>Table {String(item.tableNumber).padStart(2, "0")}</strong>
        <span>
          <Clock3 aria-hidden="true" /> {relativeMinutes(item.statusChangedAt)}
        </span>
      </div>
      <h2>
        {item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name}
      </h2>
      <p>
        Order #{item.orderId.toString()} · {item.guestName}
      </p>
      {item.note && <blockquote>{item.note}</blockquote>}
      {action && (
        <button
          className="ticket-action"
          type="button"
          onClick={onAdvance}
          disabled={busy}
        >
          {busy ? "Updating…" : action}{" "}
          {!busy && <ArrowRight aria-hidden="true" />}
        </button>
      )}
      {item.status === "ORDERED" && (
        <button
          className="ticket-cancel"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          <Ban aria-hidden="true" /> Cancel item
        </button>
      )}
      {!action && (
        <span className="ticket-final">{laneCopy[item.status].label}</span>
      )}
    </article>
  );
}
