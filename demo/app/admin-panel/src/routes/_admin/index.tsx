import { useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  Clock3,
  Plus,
  ReceiptText,
  TableProperties,
  Users,
  WalletCards,
} from "lucide-react";
import {
  PageHeader,
  QueryContent,
  StatePanel,
  StatusPill,
} from "../../components/ui.tsx";
import { money, relativeMinutes, shortTime } from "../../lib/domain.ts";

export const Route = createFileRoute("/_admin/")({
  component: OverviewPage,
});

function OverviewPage() {
  const overview = useQuery(api.dashboard.overview, {});
  const tables = useQuery(api.tables.list, {});
  const kitchen = useQuery(api.kitchen.queue, {});

  return (
    <div className="page">
      <PageHeader
        title="Good evening, Amelia"
        subtitle="Here’s what’s happening at Savoria tonight."
        action={
          <Link
            className="button button--primary"
            to="/orders"
            search={{ create: true }}
          >
            <Plus aria-hidden="true" />
            New order
          </Link>
        }
      />

      <QueryContent state={overview} loadingLabel="Loading tonight’s service…">
        {(data) => (
          <>
            <section className="metric-grid" aria-label="Restaurant overview">
              <MetricCard
                label="Open orders"
                value={String(data.openOrderCount)}
                detail={`${data.attention.length} need attention`}
                icon={ReceiptText}
                tone="sage"
              />
              <MetricCard
                label="Occupied tables"
                value={`${data.occupiedTableCount} / ${data.tableCount}`}
                detail={`${data.availableTableCount} available now`}
                icon={TableProperties}
                tone="clay"
              />
              <MetricCard
                label="Today’s sales"
                value={money(data.salesTodayCents)}
                detail="Paid orders since midnight"
                icon={WalletCards}
                tone="sky"
              />
              <MetricCard
                label="Guest profiles"
                value={String(data.guestCount)}
                detail="Connected to order history"
                icon={Users}
                tone="violet"
              />
            </section>

            <div className="overview-grid">
              <section className="surface overview-tables">
                <div className="section-heading">
                  <div>
                    <h2>Dining room</h2>
                    <p>Live table availability and active checks</p>
                  </div>
                  <Link className="text-link" to="/tables">
                    Manage floor <ArrowRight aria-hidden="true" />
                  </Link>
                </div>
                <QueryContent
                  state={tables}
                  loadingLabel="Loading dining room…"
                >
                  {(rows) =>
                    rows.length === 0 ? (
                      <StatePanel
                        title="No tables yet"
                        detail="Add a table to open the dining room."
                      />
                    ) : (
                      <div className="table-mini-grid">
                        {rows.map((table) => {
                          const occupied = table.orderId !== null;
                          return (
                            <article
                              className={`table-mini${occupied ? " table-mini--occupied" : ""}`}
                              key={table.id.toString()}
                            >
                              <div>
                                <strong>
                                  T{String(table.number).padStart(2, "0")}
                                </strong>
                                <StatusPill
                                  status={occupied ? "IN_USE" : "AVAILABLE"}
                                />
                              </div>
                              <p>
                                {table.seats} seats ·{" "}
                                {occupied ? table.guestName : "Ready"}
                              </p>
                              <b>
                                {occupied && table.totalCents !== null
                                  ? money(table.totalCents)
                                  : "Available"}
                              </b>
                            </article>
                          );
                        })}
                      </div>
                    )
                  }
                </QueryContent>
              </section>

              <section className="surface kitchen-pulse">
                <div className="section-heading">
                  <div>
                    <h2>Kitchen pulse</h2>
                    <p>{data.attention.length} items need attention</p>
                  </div>
                  <Link className="text-link" to="/kitchen">
                    View queue <ArrowRight aria-hidden="true" />
                  </Link>
                </div>
                <QueryContent state={kitchen} loadingLabel="Loading kitchen…">
                  {(items) => {
                    const active = items
                      .filter(
                        (item) =>
                          item.status !== "SERVED" &&
                          item.status !== "CANCELLED",
                      )
                      .sort(
                        (left, right) =>
                          left.statusChangedAt - right.statusChangedAt,
                      )
                      .slice(0, 6);
                    return active.length === 0 ? (
                      <StatePanel
                        title="Kitchen is clear"
                        detail="New order items will appear here live."
                      />
                    ) : (
                      <div className="pulse-list">
                        {active.map((item) => (
                          <article key={item.id.toString()}>
                            <span className="table-token">
                              T{item.tableNumber}
                            </span>
                            <div>
                              <strong>
                                {item.quantity > 1
                                  ? `${item.name} ×${item.quantity}`
                                  : item.name}
                              </strong>
                              <small>
                                Order #{item.orderId.toString()} ·{" "}
                                {item.guestName}
                              </small>
                            </div>
                            <div className="pulse-list__status">
                              <StatusPill status={item.status} />
                              <span>
                                <Clock3 aria-hidden="true" />{" "}
                                {relativeMinutes(item.statusChangedAt)}
                              </span>
                            </div>
                          </article>
                        ))}
                      </div>
                    );
                  }}
                </QueryContent>
              </section>
            </div>

            <section className="surface recent-orders">
              <div className="section-heading">
                <div>
                  <h2>Recent orders</h2>
                  <p>The latest checks across the dining room</p>
                </div>
                <Link className="text-link" to="/orders">
                  See all orders <ArrowRight aria-hidden="true" />
                </Link>
              </div>
              {data.recentOrders.length === 0 ? (
                <StatePanel
                  title="No orders yet"
                  detail="Create the first order to begin service."
                />
              ) : (
                <div className="recent-order-row">
                  {data.recentOrders.map((order) => (
                    <Link
                      key={order.id.toString()}
                      to="/orders"
                      search={{ order: order.id.toString() }}
                    >
                      <span className="table-token">T{order.table.number}</span>
                      <div>
                        <strong>#{order.id.toString()}</strong>
                        <small>
                          {order.user.name} · {shortTime(order.openedAt)}
                        </small>
                      </div>
                      <StatusPill status={order.status} />
                      <b>{money(order.totalCents)}</b>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </QueryContent>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: Readonly<{
  label: string;
  value: string;
  detail: string;
  icon: typeof ReceiptText;
  tone: "sage" | "clay" | "sky" | "violet";
}>) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div>
        <span>{label}</span>
        <i>
          <Icon aria-hidden="true" />
        </i>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
