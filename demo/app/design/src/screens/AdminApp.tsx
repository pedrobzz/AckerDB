import { Icon, artboard } from "canvazz";
import { AdminFrame } from "@/components/AdminFrame";
import { MenuItemCard } from "@/components/MenuItemCard";
import { MetricCard } from "@/components/MetricCard";
import { OrderItemRow } from "@/components/OrderItemRow";
import { StatusPill } from "@/components/StatusPill";
import {
  activeOrder,
  categories,
  kitchenQueue,
  menuItems,
  orders,
  pastOrders,
  tables,
  users,
  type ItemStatus,
} from "@/data/restaurant";
import { theme } from "@theme";

export const AdminOverview = artboard({
  id: "AdminOverview",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminOverview() {
    return (
      <AdminFrame
        active="overview"
        title="Good evening, Amelia"
        subtitle="Here’s what’s happening at Savoria tonight."
        actionLabel="New order"
        showAction={true}
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }} data-cz-id="cz_43b2">
            <div style={{ display: "flex", gap: 13 }} data-cz-id="cz_c98b">
              <MetricCard
                label="Open orders"
                value="8"
                detail="+2 in the last hour"
                icon="receipt"
                color={theme.colors.forest800}
                background={theme.colors.sage100}
                czId="cz_6d47"
              />
              <MetricCard
                label="Occupied tables"
                value="6 / 12"
                detail="50% floor capacity"
                icon="table.furniture"
                color={theme.colors.clay500}
                background={theme.colors.clay100}
                czId="cz_9f8d"
              />
              <MetricCard
                label="Tonight’s sales"
                value="$3,840"
                detail="12% above average"
                icon="chart.line.uptrend.xyaxis"
                color={theme.colors.sky500}
                background={theme.colors.sky100}
                czId="cz_7d0d"
              />
              <MetricCard
                label="Avg. service time"
                value="24 min"
                detail="3 min faster today"
                icon="timer"
                color={theme.colors.violet500}
                background={theme.colors.violet100}
                czId="cz_10cf"
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.55fr 0.8fr",
                gap: 20,
                minHeight: 0,
              }}
              data-cz-id="cz_796c"
            >
              <section
                style={{
                  padding: 20,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 17,
                  background: theme.colors.warmWhite,
                }}
                data-cz-id="cz_e14a"
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 16,
                  }}
                  data-cz-id="cz_d24c"
                >
                  <div data-cz-id="cz_d541">
                    <h2 style={{ margin: 0, fontSize: 16 }} data-cz-id="cz_197d">
                      Dining room
                    </h2>
                    <p
                      style={{ margin: "5px 0 0", color: theme.colors.ink500, fontSize: 10 }}
                      data-cz-id="cz_b339"
                    >
                      Live table availability and active checks
                    </p>
                  </div>
                  <div
                    style={{ display: "flex", gap: 13, color: theme.colors.ink500, fontSize: 9 }}
                    data-cz-id="cz_dd52"
                  >
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      data-cz-id="cz_5b6c"
                    >
                      <i
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: theme.colors.sage500,
                        }}
                        data-cz-id="cz_cba4"
                      />
                      Available
                    </span>
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      data-cz-id="cz_4eb5"
                    >
                      <i
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: theme.colors.clay500,
                        }}
                        data-cz-id="cz_90a4"
                      />
                      In use
                    </span>
                  </div>
                </div>
                <div
                  style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}
                  data-cz-id="cz_ece2"
                >
                  {tables.map((table) => {
                    const occupied = table.status === "IN USE";
                    return (
                      <div
                        key={table.id}
                        style={{
                          minHeight: 106,
                          padding: 13,
                          borderRadius: 14,
                          border: occupied
                            ? `1px solid ${theme.colors.clay500}`
                            : `1px solid ${theme.colors.line}`,
                          background: occupied ? theme.colors.clay100 : theme.colors.cream50,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                        }}
                        data-cz-id="cz_e7e2"
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                          data-cz-id="cz_23ee"
                        >
                          <strong
                            style={{ fontFamily: theme.fonts.display, fontSize: 20 }}
                            data-cz-id="cz_865b"
                          >
                            T{String(table.id).padStart(2, "0")}
                          </strong>
                          {occupied && (
                            <Icon
                              name="lock.fill"
                              size={11}
                              color={theme.colors.clay500}
                              czId="cz_2d35"
                            />
                          )}
                        </div>
                        <div data-cz-id="cz_b10a">
                          <span
                            style={{ display: "block", color: theme.colors.ink500, fontSize: 9 }}
                            data-cz-id="cz_1890"
                          >
                            {table.seats} seats · {occupied ? table.guest : "Ready"}
                          </span>
                          <strong
                            style={{
                              display: "block",
                              marginTop: 3,
                              color: occupied ? theme.colors.clay500 : theme.colors.forest800,
                              fontSize: 10,
                            }}
                            data-cz-id="cz_2990"
                          >
                            {occupied ? `$${table.total}` : "Available"}
                          </strong>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section
                style={{
                  padding: 20,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 17,
                  background: theme.colors.warmWhite,
                }}
                data-cz-id="cz_4f3d"
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 13,
                  }}
                  data-cz-id="cz_b4f2"
                >
                  <div data-cz-id="cz_7945">
                    <h2 style={{ margin: 0, fontSize: 16 }} data-cz-id="cz_ce0a">
                      Kitchen pulse
                    </h2>
                    <p
                      style={{ margin: "5px 0 0", color: theme.colors.ink500, fontSize: 10 }}
                      data-cz-id="cz_4770"
                    >
                      5 items need attention
                    </p>
                  </div>
                  <button
                    style={{
                      border: "none",
                      background: "transparent",
                      color: theme.colors.forest800,
                      fontSize: 10,
                      fontWeight: 750,
                    }}
                    data-cz-id="cz_f5a0"
                  >
                    View queue
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }} data-cz-id="cz_347a">
                  {kitchenQueue.slice(0, 5).map((queueItem) => {
                    const preparing = queueItem.status === "PREPARING";
                    const prepared = queueItem.status === "PREPARED";
                    return (
                      <div
                        key={queueItem.id}
                        style={{
                          padding: "12px 0",
                          borderBottom: `1px solid ${theme.colors.line}`,
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                        data-cz-id="cz_5d34"
                      >
                        <span
                          style={{
                            width: 31,
                            height: 31,
                            borderRadius: 10,
                            background: theme.colors.cream100,
                            color: theme.colors.forest900,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 9,
                            fontWeight: 800,
                          }}
                          data-cz-id="cz_90ec"
                        >
                          T{queueItem.table}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_6ee3">
                          <strong
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: 10,
                            }}
                            data-cz-id="cz_d469"
                          >
                            {queueItem.item}
                          </strong>
                          <span
                            style={{ color: theme.colors.ink500, fontSize: 8 }}
                            data-cz-id="cz_eb59"
                          >
                            {queueItem.order} · {queueItem.elapsed}
                          </span>
                        </div>
                        <StatusPill
                          label={queueItem.status}
                          color={
                            preparing
                              ? theme.colors.amber500
                              : prepared
                                ? theme.colors.sky500
                                : theme.colors.forest800
                          }
                          background={
                            preparing
                              ? theme.colors.amber100
                              : prepared
                                ? theme.colors.sky100
                                : theme.colors.sage100
                          }
                          dot={true}
                          czId="cz_6052"
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        }
        czId="cz_43cd"
      />
    );
  },
});

export const AdminOrders = artboard({
  id: "AdminOrders",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminOrders() {
    return (
      <AdminFrame
        active="orders"
        title="Orders"
        subtitle="Every check, guest, item, and service state in one place."
        actionLabel="Create order"
        showAction={true}
        body={
          <div
            style={{ display: "grid", gridTemplateColumns: "0.95fr 1.2fr", gap: 18, height: 790 }}
            data-cz-id="cz_8212"
          >
            <section
              style={{
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 17,
                background: theme.colors.warmWhite,
                overflow: "hidden",
              }}
              data-cz-id="cz_5c6f"
            >
              <div
                style={{
                  padding: 16,
                  borderBottom: `1px solid ${theme.colors.line}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                }}
                data-cz-id="cz_ccb0"
              >
                <div
                  style={{
                    flex: 1,
                    height: 38,
                    padding: "0 12px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 11,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: theme.colors.ink500,
                    fontSize: 10,
                  }}
                  data-cz-id="cz_b514"
                >
                  <Icon
                    name="magnifyingglass"
                    size={13}
                    color={theme.colors.ink500}
                    czId="cz_b442"
                  />
                  Search orders or guests
                </div>
                <button
                  style={{
                    width: 38,
                    height: 38,
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 11,
                    background: theme.colors.warmWhite,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_09df"
                >
                  <Icon
                    name="line.3.horizontal.decrease"
                    size={14}
                    color={theme.colors.ink700}
                    czId="cz_0fd4"
                  />
                </button>
              </div>
              <div style={{ padding: "8px 10px" }} data-cz-id="cz_56a7">
                {orders.map((order, index) => {
                  const selected = index === 0;
                  const paid = order.status === "PAID";
                  const cancelled = order.status === "CANCELLED";
                  return (
                    <div
                      key={order.id}
                      style={{
                        padding: "14px 13px",
                        borderRadius: 13,
                        background: selected ? theme.colors.sage100 : "transparent",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                      }}
                      data-cz-id="cz_4324"
                    >
                      <span
                        style={{
                          width: 42,
                          height: 42,
                          borderRadius: 13,
                          background: selected ? theme.colors.forest900 : theme.colors.cream100,
                          color: selected ? "white" : theme.colors.forest900,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: theme.fonts.display,
                          fontSize: 14,
                          fontWeight: 700,
                        }}
                        data-cz-id="cz_4b80"
                      >
                        T{order.table}
                      </span>
                      <div style={{ flex: 1 }} data-cz-id="cz_e5a4">
                        <div
                          style={{ display: "flex", alignItems: "center", gap: 7 }}
                          data-cz-id="cz_5206"
                        >
                          <strong style={{ fontSize: 11 }} data-cz-id="cz_20a1">
                            {order.id}
                          </strong>
                          <StatusPill
                            label={order.status}
                            color={
                              cancelled
                                ? theme.colors.rose500
                                : paid
                                  ? theme.colors.sky500
                                  : theme.colors.forest800
                            }
                            background={
                              cancelled
                                ? theme.colors.rose100
                                : paid
                                  ? theme.colors.sky100
                                  : theme.colors.sage200
                            }
                            dot={true}
                            czId="cz_3e91"
                          />
                        </div>
                        <span
                          style={{
                            display: "block",
                            marginTop: 4,
                            color: theme.colors.ink500,
                            fontSize: 9,
                          }}
                          data-cz-id="cz_c401"
                        >
                          {order.user.name} · {order.openedAt}
                        </span>
                      </div>
                      <strong
                        style={{
                          color: cancelled ? theme.colors.ink500 : theme.colors.ink900,
                          fontSize: 11,
                        }}
                        data-cz-id="cz_c2d4"
                      >
                        ${order.total}
                      </strong>
                      <Icon
                        name="chevron.right"
                        size={11}
                        color={theme.colors.ink300}
                        czId="cz_f0bc"
                      />
                    </div>
                  );
                })}
              </div>
            </section>

            <section
              style={{
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 17,
                background: theme.colors.warmWhite,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
              data-cz-id="cz_a014"
            >
              <header
                style={{
                  padding: 20,
                  borderBottom: `1px solid ${theme.colors.line}`,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                }}
                data-cz-id="cz_79fc"
              >
                <div data-cz-id="cz_a345">
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 9 }}
                    data-cz-id="cz_f962"
                  >
                    <h2
                      style={{ margin: 0, fontFamily: theme.fonts.display, fontSize: 24 }}
                      data-cz-id="cz_37f1"
                    >
                      {activeOrder.id}
                    </h2>
                    <StatusPill
                      label="Open"
                      color={theme.colors.forest800}
                      background={theme.colors.sage200}
                      dot={true}
                      czId="cz_4616"
                    />
                  </div>
                  <p
                    style={{ margin: "7px 0 0", color: theme.colors.ink500, fontSize: 10 }}
                    data-cz-id="cz_252b"
                  >
                    Table {activeOrder.table} · opened {activeOrder.openedAt}
                  </p>
                </div>
                <button
                  style={{
                    width: 36,
                    height: 36,
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 11,
                    background: theme.colors.warmWhite,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_ab21"
                >
                  <Icon name="ellipsis" size={14} color={theme.colors.ink700} czId="cz_1d0a" />
                </button>
              </header>

              <div
                style={{
                  padding: "15px 20px",
                  borderBottom: `1px solid ${theme.colors.line}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
                data-cz-id="cz_7ed2"
              >
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 999,
                    background: theme.colors.clay100,
                    color: theme.colors.clay500,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 850,
                  }}
                  data-cz-id="cz_8e8e"
                >
                  CM
                </span>
                <div style={{ flex: 1 }} data-cz-id="cz_c71c">
                  <strong style={{ display: "block", fontSize: 11 }} data-cz-id="cz_3dbe">
                    {activeOrder.user.name}
                  </strong>
                  <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_1231">
                    {activeOrder.user.email}
                  </span>
                </div>
                <button
                  style={{
                    border: "none",
                    background: "transparent",
                    color: theme.colors.forest800,
                    fontSize: 10,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_79e8"
                >
                  View guest
                </button>
              </div>

              <div style={{ padding: "5px 20px 0", flex: 1 }} data-cz-id="cz_cff2">
                <OrderItemRow
                  quantity="1×"
                  name="Charred Tomatoes"
                  detail="Served 7:56 PM"
                  price="$16"
                  status="Served"
                  statusColor={theme.colors.forest800}
                  statusBackground={theme.colors.sage100}
                  czId="cz_7b48"
                />
                <OrderItemRow
                  quantity="1×"
                  name="Grilled Sea Bass"
                  detail="Kitchen · 8 minutes"
                  price="$34"
                  status="Preparing"
                  statusColor={theme.colors.amber500}
                  statusBackground={theme.colors.amber100}
                  czId="cz_0b41"
                />
                <OrderItemRow
                  quantity="2×"
                  name="Blood Orange Spritz"
                  detail="Ready for service"
                  price="$24"
                  status="Prepared"
                  statusColor={theme.colors.sky500}
                  statusBackground={theme.colors.sky100}
                  czId="cz_0e3f"
                />
                <button
                  style={{
                    marginTop: 13,
                    height: 38,
                    border: `1px dashed ${theme.colors.sage500}`,
                    borderRadius: 11,
                    width: "100%",
                    background: theme.colors.sage100,
                    color: theme.colors.forest800,
                    fontSize: 10,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_93ac"
                >
                  + Add items to this order
                </button>
              </div>

              <footer
                style={{
                  padding: 20,
                  borderTop: `1px solid ${theme.colors.line}`,
                  background: theme.colors.cream50,
                }}
                data-cz-id="cz_bdf4"
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  data-cz-id="cz_52fa"
                >
                  <span style={{ color: theme.colors.ink500, fontSize: 10 }} data-cz-id="cz_236a">
                    3 items · taxes included
                  </span>
                  <div style={{ textAlign: "right" }} data-cz-id="cz_17c4">
                    <span
                      style={{ display: "block", color: theme.colors.ink500, fontSize: 9 }}
                      data-cz-id="cz_e2d1"
                    >
                      Order total
                    </span>
                    <strong
                      style={{ fontFamily: theme.fonts.display, fontSize: 25 }}
                      data-cz-id="cz_033f"
                    >
                      ${activeOrder.total}
                    </strong>
                  </div>
                </div>
                <div style={{ marginTop: 13, display: "flex", gap: 9 }} data-cz-id="cz_1e39">
                  <button
                    style={{
                      flex: 1,
                      height: 42,
                      border: `1px solid ${theme.colors.line}`,
                      borderRadius: 12,
                      background: theme.colors.warmWhite,
                      color: theme.colors.rose500,
                      fontSize: 10,
                      fontWeight: 750,
                    }}
                    data-cz-id="cz_2d62"
                  >
                    Cancel order
                  </button>
                  <button
                    style={{
                      flex: 1.7,
                      height: 42,
                      border: "none",
                      borderRadius: 12,
                      background: theme.colors.ink300,
                      color: "white",
                      fontSize: 10,
                      fontWeight: 750,
                    }}
                    data-cz-id="cz_b9e4"
                  >
                    Awaiting 2 items before payment
                  </button>
                </div>
              </footer>
            </section>
          </div>
        }
        czId="cz_e876"
      />
    );
  },
});

const lanes: {
  status: ItemStatus;
  label: string;
  color: string;
  background: string;
  next: string;
}[] = [
  {
    status: "ORDERED",
    label: "Ordered",
    color: "#AC492C",
    background: "#F8E4DC",
    next: "Start preparing",
  },
  {
    status: "PREPARING",
    label: "Preparing",
    color: "#8C5A0D",
    background: "#F9ECD6",
    next: "Mark prepared",
  },
  {
    status: "PREPARED",
    label: "Prepared",
    color: "#376581",
    background: "#DFEBF1",
    next: "Mark served",
  },
  { status: "SERVED", label: "Served", color: "#1E4A3E", background: "#ECF2EC", next: "Complete" },
  {
    status: "CANCELLED",
    label: "Cancelled",
    color: "#AD3F45",
    background: "#F7E2E2",
    next: "Archived",
  },
];

export const AdminKitchenQueue = artboard({
  id: "AdminKitchenQueue",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminKitchenQueue() {
    return (
      <AdminFrame
        active="kitchen"
        title="Kitchen queue"
        subtitle="Move every ordered item through preparation and service."
        actionLabel="Print all"
        showAction={true}
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 15 }} data-cz-id="cz_3ad2">
            <div
              style={{
                height: 48,
                padding: "0 15px",
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 14,
                background: theme.colors.warmWhite,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
              data-cz-id="cz_ae5b"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 18 }} data-cz-id="cz_aa66">
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    color: theme.colors.forest800,
                    fontSize: 10,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_b118"
                >
                  <i
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: theme.colors.sage500,
                    }}
                    data-cz-id="cz_c91c"
                  />
                  Live · 7 items
                </span>
                <span style={{ color: theme.colors.ink500, fontSize: 10 }} data-cz-id="cz_4327">
                  Average preparation 11m
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }} data-cz-id="cz_de2e">
                <button
                  style={{
                    height: 30,
                    padding: "0 10px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 9,
                    background: theme.colors.warmWhite,
                    color: theme.colors.ink700,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_9dea"
                >
                  All stations
                </button>
                <button
                  style={{
                    width: 30,
                    height: 30,
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 9,
                    background: theme.colors.warmWhite,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_b609"
                >
                  <Icon
                    name="arrow.clockwise"
                    size={12}
                    color={theme.colors.ink700}
                    czId="cz_2c80"
                  />
                </button>
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: 11,
                height: 700,
              }}
              data-cz-id="cz_d3dd"
            >
              {lanes.map((lane) => {
                const items = kitchenQueue.filter((item) => item.status === lane.status);
                return (
                  <section
                    key={lane.status}
                    style={{
                      padding: 11,
                      border: `1px solid ${theme.colors.line}`,
                      borderRadius: 15,
                      background: theme.colors.cream100,
                    }}
                    data-cz-id="cz_25e4"
                  >
                    <header
                      style={{
                        padding: "2px 3px 11px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                      data-cz-id="cz_6bda"
                    >
                      <StatusPill
                        label={lane.label}
                        color={lane.color}
                        background={lane.background}
                        dot={true}
                        czId="cz_d2a9"
                      />
                      <span
                        style={{
                          width: 21,
                          height: 21,
                          borderRadius: 999,
                          background: theme.colors.warmWhite,
                          color: theme.colors.ink500,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          fontWeight: 800,
                        }}
                        data-cz-id="cz_b4bc"
                      >
                        {items.length}
                      </span>
                    </header>
                    <div
                      style={{ display: "flex", flexDirection: "column", gap: 9 }}
                      data-cz-id="cz_3d5f"
                    >
                      {items.map((item) => (
                        <article
                          key={item.id}
                          style={{
                            padding: 13,
                            borderRadius: 13,
                            border: `1px solid ${theme.colors.line}`,
                            background: theme.colors.warmWhite,
                          }}
                          data-cz-id="cz_e8fd"
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                            data-cz-id="cz_1a1b"
                          >
                            <span
                              style={{ color: theme.colors.clay500, fontSize: 9, fontWeight: 850 }}
                              data-cz-id="cz_a304"
                            >
                              TABLE {String(item.table).padStart(2, "0")}
                            </span>
                            <span
                              style={{ color: theme.colors.ink500, fontSize: 8 }}
                              data-cz-id="cz_22a4"
                            >
                              {item.elapsed}
                            </span>
                          </div>
                          <h3
                            style={{ margin: "10px 0 4px", fontSize: 12, lineHeight: 1.3 }}
                            data-cz-id="cz_d793"
                          >
                            {item.item}
                          </h3>
                          <span
                            style={{ color: theme.colors.ink500, fontSize: 8 }}
                            data-cz-id="cz_312b"
                          >
                            {item.order} · 1 item
                          </span>
                          <button
                            style={{
                              marginTop: 12,
                              width: "100%",
                              height: 33,
                              border: "none",
                              borderRadius: 9,
                              background:
                                lane.status === "CANCELLED" || lane.status === "SERVED"
                                  ? theme.colors.cream100
                                  : lane.color,
                              color:
                                lane.status === "CANCELLED" || lane.status === "SERVED"
                                  ? theme.colors.ink500
                                  : "white",
                              fontSize: 8,
                              fontWeight: 800,
                            }}
                            data-cz-id="cz_13ba"
                          >
                            {lane.next}
                            {lane.status !== "SERVED" && lane.status !== "CANCELLED" ? "  →" : ""}
                          </button>
                          {lane.status === "ORDERED" && (
                            <button
                              style={{
                                marginTop: 6,
                                width: "100%",
                                border: "none",
                                background: "transparent",
                                color: theme.colors.rose500,
                                fontSize: 8,
                                fontWeight: 700,
                              }}
                              data-cz-id="cz_5896"
                            >
                              Cancel item
                            </button>
                          )}
                        </article>
                      ))}
                      {items.length === 0 && (
                        <div
                          style={{
                            minHeight: 100,
                            border: `1px dashed ${theme.colors.line}`,
                            borderRadius: 12,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: theme.colors.ink300,
                            fontSize: 9,
                          }}
                          data-cz-id="cz_8c20"
                        >
                          No items
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        }
        czId="cz_9c79"
      />
    );
  },
});

export const AdminMenu = artboard({
  id: "AdminMenu",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminMenu() {
    return (
      <AdminFrame
        active="menu"
        title="Menu"
        subtitle="Shape categories, pricing, and every item guests can order."
        actionLabel="Add item"
        showAction={true}
        body={
          <div
            style={{ display: "grid", gridTemplateColumns: "225px 1fr", gap: 18, height: 790 }}
            data-cz-id="cz_0236"
          >
            <aside
              style={{
                padding: 16,
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 17,
                background: theme.colors.warmWhite,
                display: "flex",
                flexDirection: "column",
              }}
              data-cz-id="cz_bba8"
            >
              <span
                style={{
                  color: theme.colors.ink500,
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
                data-cz-id="cz_ed67"
              >
                Categories
              </span>
              <div
                style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 5 }}
                data-cz-id="cz_915e"
              >
                {categories.map((category, index) => (
                  <div
                    key={category}
                    style={{
                      height: 42,
                      padding: "0 11px",
                      borderRadius: 11,
                      background: index === 0 ? theme.colors.sage100 : "transparent",
                      color: index === 0 ? theme.colors.forest900 : theme.colors.ink500,
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      fontSize: 10,
                      fontWeight: index === 0 ? 800 : 600,
                    }}
                    data-cz-id="cz_5b58"
                  >
                    <Icon
                      name={
                        index === 0
                          ? "leaf"
                          : index === 1
                            ? "flame"
                            : index === 2
                              ? "birthday.cake"
                              : "wineglass"
                      }
                      size={14}
                      color={index === 0 ? theme.colors.forest800 : theme.colors.ink300}
                      czId="cz_bbce"
                    />
                    <span style={{ flex: 1 }} data-cz-id="cz_c3b2">
                      {category}
                    </span>
                    <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_4e01">
                      {menuItems.filter((item) => item.category === category).length}
                    </span>
                  </div>
                ))}
              </div>
              <button
                style={{
                  marginTop: 11,
                  height: 38,
                  border: `1px dashed ${theme.colors.sage500}`,
                  borderRadius: 10,
                  background: theme.colors.sage100,
                  color: theme.colors.forest800,
                  fontSize: 9,
                  fontWeight: 750,
                }}
                data-cz-id="cz_8b5d"
              >
                + New category
              </button>
              <div
                style={{
                  marginTop: "auto",
                  padding: 13,
                  borderRadius: 13,
                  background: theme.colors.cream100,
                }}
                data-cz-id="cz_4c32"
              >
                <Icon name="lightbulb" size={16} color={theme.colors.amber500} czId="cz_4495" />
                <strong
                  style={{ display: "block", marginTop: 9, fontSize: 10 }}
                  data-cz-id="cz_8702"
                >
                  Dinner menu is live
                </strong>
                <p
                  style={{
                    margin: "5px 0 0",
                    color: theme.colors.ink500,
                    fontSize: 8,
                    lineHeight: 1.45,
                  }}
                  data-cz-id="cz_80dc"
                >
                  Changes appear instantly in the customer app.
                </p>
              </div>
            </aside>

            <section style={{ minWidth: 0 }} data-cz-id="cz_9cee">
              <div
                style={{
                  height: 48,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 13,
                }}
                data-cz-id="cz_64ab"
              >
                <div data-cz-id="cz_db20">
                  <h2 style={{ margin: 0, fontSize: 16 }} data-cz-id="cz_e775">
                    All items
                  </h2>
                  <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_1f0a">
                    6 active items across 4 categories
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }} data-cz-id="cz_dba0">
                  <div
                    style={{
                      width: 220,
                      height: 38,
                      padding: "0 11px",
                      border: `1px solid ${theme.colors.line}`,
                      borderRadius: 11,
                      background: theme.colors.warmWhite,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      color: theme.colors.ink500,
                      fontSize: 9,
                    }}
                    data-cz-id="cz_7344"
                  >
                    <Icon
                      name="magnifyingglass"
                      size={12}
                      color={theme.colors.ink500}
                      czId="cz_70b3"
                    />
                    Search menu
                  </div>
                  <button
                    style={{
                      width: 38,
                      height: 38,
                      border: `1px solid ${theme.colors.line}`,
                      borderRadius: 11,
                      background: theme.colors.warmWhite,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_f3b7"
                  >
                    <Icon
                      name="line.3.horizontal.decrease"
                      size={13}
                      color={theme.colors.ink700}
                      czId="cz_2a3e"
                    />
                  </button>
                </div>
              </div>
              <div
                style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 13 }}
                data-cz-id="cz_3cca"
              >
                {menuItems.map((item) => (
                  <div key={item.id} style={{ position: "relative" }} data-cz-id="cz_5e65">
                    <MenuItemCard
                      name={item.name}
                      description={item.description}
                      price={`$${item.price}`}
                      image={item.image}
                      compact={false}
                      czId="cz_32f0"
                    />
                    <span
                      style={{
                        position: "absolute",
                        top: 9,
                        left: 9,
                        padding: "5px 8px",
                        borderRadius: 999,
                        background: "rgba(16,42,36,0.84)",
                        color: "white",
                        fontSize: 8,
                        fontWeight: 750,
                      }}
                      data-cz-id="cz_e38c"
                    >
                      {item.category}
                    </span>
                    <button
                      style={{
                        position: "absolute",
                        top: 9,
                        right: 9,
                        width: 27,
                        height: 27,
                        border: "none",
                        borderRadius: 9,
                        background: "rgba(255,255,255,0.92)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      data-cz-id="cz_0df7"
                    >
                      <Icon name="pencil" size={11} color={theme.colors.ink700} czId="cz_ecd1" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        }
        czId="cz_05c6"
      />
    );
  },
});

export const AdminTables = artboard({
  id: "AdminTables",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminTables() {
    return (
      <AdminFrame
        active="tables"
        title="Tables"
        subtitle="Set floor capacity and see which tables are locked by active orders."
        actionLabel="Add table"
        showAction={true}
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 15 }} data-cz-id="cz_bdac">
            <section
              style={{
                padding: "16px 18px",
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 15,
                background: theme.colors.warmWhite,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
              data-cz-id="cz_314f"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }} data-cz-id="cz_97b7">
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: theme.colors.sage100,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_59a2"
                >
                  <Icon
                    name="table.furniture"
                    size={18}
                    color={theme.colors.forest800}
                    czId="cz_6559"
                  />
                </span>
                <div data-cz-id="cz_9ca5">
                  <strong style={{ display: "block", fontSize: 11 }} data-cz-id="cz_9a81">
                    Dining room capacity
                  </strong>
                  <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_ce37">
                    Removing an occupied table is disabled until its order closes.
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }} data-cz-id="cz_e38f">
                <button
                  style={{
                    width: 34,
                    height: 34,
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 10,
                    background: theme.colors.cream50,
                    color: theme.colors.ink700,
                    fontSize: 15,
                  }}
                  data-cz-id="cz_7c12"
                >
                  −
                </button>
                <strong
                  style={{
                    width: 48,
                    textAlign: "center",
                    fontFamily: theme.fonts.display,
                    fontSize: 23,
                  }}
                  data-cz-id="cz_4ec0"
                >
                  12
                </strong>
                <button
                  style={{
                    width: 34,
                    height: 34,
                    border: "none",
                    borderRadius: 10,
                    background: theme.colors.forest900,
                    color: "white",
                    fontSize: 15,
                  }}
                  data-cz-id="cz_e6bf"
                >
                  +
                </button>
                <button
                  style={{
                    height: 34,
                    padding: "0 13px",
                    border: "none",
                    borderRadius: 10,
                    background: theme.colors.clay500,
                    color: "white",
                    fontSize: 9,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_17fc"
                >
                  Save layout
                </button>
              </div>
            </section>

            <div
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
              data-cz-id="cz_f6f4"
            >
              <div style={{ display: "flex", gap: 7 }} data-cz-id="cz_885d">
                <button
                  style={{
                    height: 32,
                    padding: "0 11px",
                    border: "none",
                    borderRadius: 9,
                    background: theme.colors.forest900,
                    color: "white",
                    fontSize: 9,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_20d9"
                >
                  All tables · 12
                </button>
                <button
                  style={{
                    height: 32,
                    padding: "0 11px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 9,
                    background: theme.colors.warmWhite,
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_bff8"
                >
                  Available · 6
                </button>
                <button
                  style={{
                    height: 32,
                    padding: "0 11px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 9,
                    background: theme.colors.warmWhite,
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_67ed"
                >
                  In use · 6
                </button>
              </div>
              <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_8ddc">
                50% occupied
              </span>
            </div>

            <div
              style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}
              data-cz-id="cz_b25b"
            >
              {tables.map((table) => {
                const occupied = table.status === "IN USE";
                return (
                  <article
                    key={table.id}
                    style={{
                      minHeight: 177,
                      padding: 17,
                      borderRadius: 16,
                      border: occupied
                        ? `1px solid ${theme.colors.clay500}`
                        : `1px solid ${theme.colors.line}`,
                      background: occupied ? theme.colors.clay100 : theme.colors.warmWhite,
                      display: "flex",
                      flexDirection: "column",
                    }}
                    data-cz-id="cz_e3de"
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                      }}
                      data-cz-id="cz_bf82"
                    >
                      <div data-cz-id="cz_88cb">
                        <span
                          style={{
                            display: "block",
                            color: theme.colors.ink500,
                            fontSize: 8,
                            fontWeight: 750,
                            letterSpacing: "0.09em",
                            textTransform: "uppercase",
                          }}
                          data-cz-id="cz_7ce4"
                        >
                          Table
                        </span>
                        <strong
                          style={{
                            display: "block",
                            fontFamily: theme.fonts.display,
                            fontSize: 28,
                            lineHeight: 1,
                          }}
                          data-cz-id="cz_3a26"
                        >
                          0{table.id}
                        </strong>
                      </div>
                      <StatusPill
                        label={occupied ? "In use" : "Available"}
                        color={occupied ? theme.colors.clay500 : theme.colors.forest800}
                        background={occupied ? "#FFFFFF" : theme.colors.sage100}
                        dot={true}
                        czId="cz_d328"
                      />
                    </div>
                    <div
                      style={{
                        marginTop: 15,
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        color: theme.colors.ink500,
                        fontSize: 9,
                      }}
                      data-cz-id="cz_b06f"
                    >
                      <Icon name="person.2" size={12} color={theme.colors.ink500} czId="cz_93cd" />
                      {table.seats} seats
                    </div>
                    <div
                      style={{
                        marginTop: "auto",
                        paddingTop: 13,
                        borderTop: `1px solid ${occupied ? "#EEC8B9" : theme.colors.line}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                      data-cz-id="cz_5828"
                    >
                      <div data-cz-id="cz_d399">
                        <span
                          style={{ display: "block", color: theme.colors.ink500, fontSize: 8 }}
                          data-cz-id="cz_f25c"
                        >
                          {occupied ? table.guest : "Ready for a guest"}
                        </span>
                        {occupied && (
                          <strong
                            style={{ color: theme.colors.clay500, fontSize: 10 }}
                            data-cz-id="cz_76f8"
                          >
                            ${table.total} open
                          </strong>
                        )}
                      </div>
                      <button
                        style={{
                          width: 31,
                          height: 31,
                          borderRadius: 9,
                          border: `1px solid ${occupied ? "#EEC8B9" : theme.colors.line}`,
                          background: occupied ? "transparent" : theme.colors.cream50,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                        data-cz-id="cz_266c"
                      >
                        <Icon
                          name={occupied ? "lock.fill" : "pencil"}
                          size={11}
                          color={occupied ? theme.colors.clay500 : theme.colors.ink500}
                          czId="cz_fc2e"
                        />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        }
        czId="cz_03c6"
      />
    );
  },
});

export const AdminUsers = artboard({
  id: "AdminUsers",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminUsers() {
    return (
      <AdminFrame
        active="users"
        title="Guests"
        subtitle="Create guest profiles and understand their active and past orders."
        actionLabel="New guest"
        showAction={true}
        body={
          <div
            style={{ display: "grid", gridTemplateColumns: "0.8fr 1.25fr", gap: 18, height: 790 }}
            data-cz-id="cz_b246"
          >
            <section
              style={{
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 17,
                background: theme.colors.warmWhite,
                overflow: "hidden",
              }}
              data-cz-id="cz_480e"
            >
              <div
                style={{ padding: 15, borderBottom: `1px solid ${theme.colors.line}` }}
                data-cz-id="cz_6fa0"
              >
                <div
                  style={{
                    height: 38,
                    padding: "0 11px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 11,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_6f1f"
                >
                  <Icon
                    name="magnifyingglass"
                    size={12}
                    color={theme.colors.ink500}
                    czId="cz_8edc"
                  />
                  Search name or email
                </div>
              </div>
              <div style={{ padding: 10 }} data-cz-id="cz_4b99">
                {users.map((user, index) => (
                  <div
                    key={user.id}
                    style={{
                      padding: "13px 12px",
                      borderRadius: 13,
                      background: index === 0 ? theme.colors.sage100 : "transparent",
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                    }}
                    data-cz-id="cz_605b"
                  >
                    <span
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 999,
                        background: index === 0 ? theme.colors.forest900 : theme.colors.cream100,
                        color: index === 0 ? "white" : theme.colors.forest900,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 800,
                      }}
                      data-cz-id="cz_ba1d"
                    >
                      {user.name
                        .split(" ")
                        .map((part) => part[0])
                        .join("")}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_9457">
                      <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_1ebe">
                        {user.name}
                      </strong>
                      <span
                        style={{
                          display: "block",
                          marginTop: 3,
                          color: theme.colors.ink500,
                          fontSize: 8,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        data-cz-id="cz_9c06"
                      >
                        {user.email}
                      </span>
                    </div>
                    <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_861e">
                      {user.orders} orders
                    </span>
                    <Icon
                      name="chevron.right"
                      size={10}
                      color={theme.colors.ink300}
                      czId="cz_cbbf"
                    />
                  </div>
                ))}
              </div>
              <div
                style={{
                  margin: "14px 15px",
                  padding: 14,
                  borderRadius: 14,
                  background: theme.colors.cream100,
                }}
                data-cz-id="cz_af22"
              >
                <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_71ac">
                  Quick create
                </strong>
                <div
                  style={{
                    marginTop: 10,
                    height: 36,
                    padding: "0 10px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 10,
                    background: theme.colors.warmWhite,
                    display: "flex",
                    alignItems: "center",
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_9a50"
                >
                  Guest name
                </div>
                <div
                  style={{
                    marginTop: 7,
                    height: 36,
                    padding: "0 10px",
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 10,
                    background: theme.colors.warmWhite,
                    display: "flex",
                    alignItems: "center",
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_144d"
                >
                  Email address
                </div>
                <button
                  style={{
                    marginTop: 9,
                    width: "100%",
                    height: 36,
                    border: "none",
                    borderRadius: 10,
                    background: theme.colors.forest900,
                    color: "white",
                    fontSize: 9,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_99fd"
                >
                  Create guest
                </button>
              </div>
            </section>

            <section
              style={{
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 17,
                background: theme.colors.warmWhite,
                overflow: "hidden",
              }}
              data-cz-id="cz_bee5"
            >
              <header
                style={{
                  padding: 20,
                  borderBottom: `1px solid ${theme.colors.line}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
                data-cz-id="cz_71b6"
              >
                <span
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 999,
                    background: theme.colors.clay100,
                    color: theme.colors.clay500,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: theme.fonts.display,
                    fontSize: 18,
                    fontWeight: 700,
                  }}
                  data-cz-id="cz_0c6e"
                >
                  CM
                </span>
                <div style={{ flex: 1 }} data-cz-id="cz_b069">
                  <h2
                    style={{ margin: 0, fontFamily: theme.fonts.display, fontSize: 23 }}
                    data-cz-id="cz_6682"
                  >
                    {users[0].name}
                  </h2>
                  <p
                    style={{ margin: "5px 0 0", color: theme.colors.ink500, fontSize: 9 }}
                    data-cz-id="cz_eb25"
                  >
                    {users[0].email} · guest since March 2025
                  </p>
                </div>
                <button
                  style={{
                    width: 34,
                    height: 34,
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 10,
                    background: theme.colors.warmWhite,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_8130"
                >
                  <Icon name="pencil" size={12} color={theme.colors.ink700} czId="cz_dfd1" />
                </button>
              </header>

              <div style={{ padding: 20 }} data-cz-id="cz_314b">
                <div
                  style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}
                  data-cz-id="cz_faf0"
                >
                  {[
                    { label: "Lifetime orders", value: "8" },
                    { label: "Total spend", value: "$746" },
                    { label: "Average check", value: "$93" },
                  ].map((metric) => (
                    <div
                      key={metric.label}
                      style={{ padding: 13, borderRadius: 12, background: theme.colors.cream100 }}
                      data-cz-id="cz_65b3"
                    >
                      <span
                        style={{ display: "block", color: theme.colors.ink500, fontSize: 8 }}
                        data-cz-id="cz_817e"
                      >
                        {metric.label}
                      </span>
                      <strong
                        style={{
                          display: "block",
                          marginTop: 5,
                          fontFamily: theme.fonts.display,
                          fontSize: 20,
                        }}
                        data-cz-id="cz_c08b"
                      >
                        {metric.value}
                      </strong>
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    marginTop: 19,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                  data-cz-id="cz_296e"
                >
                  <h3 style={{ margin: 0, fontSize: 12 }} data-cz-id="cz_c40d">
                    Active order
                  </h3>
                  <button
                    style={{
                      border: "none",
                      background: "transparent",
                      color: theme.colors.forest800,
                      fontSize: 9,
                      fontWeight: 750,
                    }}
                    data-cz-id="cz_78a7"
                  >
                    View order →
                  </button>
                </div>
                <div
                  style={{
                    marginTop: 10,
                    padding: 14,
                    borderRadius: 14,
                    border: `1px solid ${theme.colors.sage500}`,
                    background: theme.colors.sage100,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                  data-cz-id="cz_58a8"
                >
                  <span
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 12,
                      background: theme.colors.forest900,
                      color: "white",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: theme.fonts.display,
                      fontSize: 14,
                    }}
                    data-cz-id="cz_1577"
                  >
                    T{activeOrder.table}
                  </span>
                  <div style={{ flex: 1 }} data-cz-id="cz_9bde">
                    <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_0de7">
                      {activeOrder.id}
                    </strong>
                    <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_9d80">
                      3 items · opened {activeOrder.openedAt}
                    </span>
                  </div>
                  <StatusPill
                    label="Open"
                    color={theme.colors.forest800}
                    background={theme.colors.warmWhite}
                    dot={true}
                    czId="cz_9122"
                  />
                  <strong style={{ fontSize: 11 }} data-cz-id="cz_9097">
                    ${activeOrder.total}
                  </strong>
                </div>

                <h3 style={{ margin: "20px 0 10px", fontSize: 12 }} data-cz-id="cz_7c3a">
                  Order history
                </h3>
                <div
                  style={{
                    border: `1px solid ${theme.colors.line}`,
                    borderRadius: 14,
                    overflow: "hidden",
                  }}
                  data-cz-id="cz_45cc"
                >
                  {pastOrders.map((order) => {
                    const cancelled = order.status === "CANCELLED";
                    return (
                      <div
                        key={order.id}
                        style={{
                          padding: "13px 14px",
                          borderBottom: `1px solid ${theme.colors.line}`,
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                        }}
                        data-cz-id="cz_af61"
                      >
                        <Icon name="receipt" size={14} color={theme.colors.ink500} czId="cz_4439" />
                        <div style={{ flex: 1 }} data-cz-id="cz_58e9">
                          <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_b409">
                            {order.id} · Table {order.table}
                          </strong>
                          <span
                            style={{ color: theme.colors.ink500, fontSize: 8 }}
                            data-cz-id="cz_d4a8"
                          >
                            {order.date}
                          </span>
                        </div>
                        <StatusPill
                          label={order.status}
                          color={cancelled ? theme.colors.rose500 : theme.colors.sky500}
                          background={cancelled ? theme.colors.rose100 : theme.colors.sky100}
                          dot={true}
                          czId="cz_36f1"
                        />
                        <strong
                          style={{
                            width: 40,
                            textAlign: "right",
                            color: cancelled ? theme.colors.ink500 : theme.colors.ink900,
                            fontSize: 10,
                          }}
                          data-cz-id="cz_881c"
                        >
                          ${order.total}
                        </strong>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          </div>
        }
        czId="cz_8356"
      />
    );
  },
});
