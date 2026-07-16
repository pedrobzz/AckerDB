import { Icon, artboard } from "canvazz";
import { ActionButton } from "@/components/ActionButton";
import { Brand } from "@/components/Brand";
import { MenuItemCard } from "@/components/MenuItemCard";
import { MobileFrame } from "@/components/MobileFrame";
import { StatusPill } from "@/components/StatusPill";
import { activeOrder, categories, menuItems, pastOrders, tables } from "@/data/restaurant";
import { theme } from "@theme";

export const CustomerLogin = artboard({
  id: "CustomerLogin",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerLogin() {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: theme.colors.forest950,
          color: theme.colors.warmWhite,
          fontFamily: theme.fonts.primary,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
        }}
        data-cz-id="cz_b978"
      >
        <div
          style={{
            position: "absolute",
            width: 320,
            height: 320,
            borderRadius: 999,
            top: -150,
            right: -120,
            border: "1px solid rgba(255,255,255,0.10)",
          }}
          data-cz-id="cz_a05e"
        />
        <div
          style={{
            position: "absolute",
            width: 210,
            height: 210,
            borderRadius: 999,
            top: -96,
            right: -58,
            background: "rgba(134,167,137,0.10)",
          }}
          data-cz-id="cz_b10d"
        />
        <div
          style={{
            height: 29,
            padding: "11px 20px 0",
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            fontWeight: 750,
          }}
          data-cz-id="cz_2bda"
        >
          <span data-cz-id="cz_565c">9:41</span>
          <span style={{ letterSpacing: 2 }} data-cz-id="cz_5af7">
            •••
          </span>
        </div>
        <header style={{ padding: "29px 24px 0", position: "relative" }} data-cz-id="cz_3f80">
          <Brand compact={false} inverted={true} czId="cz_5937" />
          <div style={{ marginTop: 70 }} data-cz-id="cz_f0f6">
            <span
              style={{
                color: "#AFC6BC",
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_fa14"
            >
              Welcome to your table
            </span>
            <h1
              style={{
                margin: "12px 0 0",
                maxWidth: 310,
                fontFamily: theme.fonts.display,
                fontSize: 43,
                lineHeight: 1.02,
                fontWeight: 600,
                letterSpacing: "-0.045em",
              }}
              data-cz-id="cz_ded7"
            >
              A memorable evening starts here.
            </h1>
            <p
              style={{
                margin: "16px 0 0",
                maxWidth: 305,
                color: "#AFC6BC",
                fontSize: 12,
                lineHeight: 1.55,
              }}
              data-cz-id="cz_cb7c"
            >
              Sign in with your name and email to choose a table, order, and follow every plate to
              your seat.
            </p>
          </div>
        </header>

        <section
          style={{
            marginTop: "auto",
            padding: "25px 22px 28px",
            borderRadius: "28px 28px 0 0",
            background: theme.colors.cream50,
            color: theme.colors.ink900,
          }}
          data-cz-id="cz_77b6"
        >
          <h2
            style={{ margin: 0, fontFamily: theme.fonts.display, fontSize: 25, fontWeight: 600 }}
            data-cz-id="cz_f6db"
          >
            Let’s get you seated
          </h2>
          <p
            style={{ margin: "6px 0 18px", color: theme.colors.ink500, fontSize: 10 }}
            data-cz-id="cz_840b"
          >
            No password needed. We’ll remember your order history.
          </p>
          <label
            style={{
              display: "block",
              marginBottom: 7,
              color: theme.colors.ink700,
              fontSize: 9,
              fontWeight: 750,
            }}
            data-cz-id="cz_eb77"
          >
            Your name
          </label>
          <div
            style={{
              height: 47,
              padding: "0 13px",
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 13,
              background: theme.colors.warmWhite,
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: theme.colors.ink500,
              fontSize: 11,
            }}
            data-cz-id="cz_bfdf"
          >
            <Icon name="person" size={14} color={theme.colors.ink500} czId="cz_671d" />
            Clara Mendes
          </div>
          <label
            style={{
              display: "block",
              margin: "13px 0 7px",
              color: theme.colors.ink700,
              fontSize: 9,
              fontWeight: 750,
            }}
            data-cz-id="cz_c81d"
          >
            Email address
          </label>
          <div
            style={{
              height: 47,
              padding: "0 13px",
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 13,
              background: theme.colors.warmWhite,
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: theme.colors.ink500,
              fontSize: 11,
            }}
            data-cz-id="cz_0dc9"
          >
            <Icon name="envelope" size={14} color={theme.colors.ink500} czId="cz_f6fc" />
            clara@example.com
          </div>
          <div style={{ marginTop: 18 }} data-cz-id="cz_7354">
            <ActionButton
              label="Find a table"
              icon="arrow.right"
              variant="primary"
              fullWidth={true}
              czId="cz_c8dd"
            />
          </div>
          <p
            style={{
              margin: "13px 0 0",
              color: theme.colors.ink500,
              fontSize: 8,
              lineHeight: 1.45,
              textAlign: "center",
            }}
            data-cz-id="cz_4bb5"
          >
            By continuing, you agree to receive live updates about your order.
          </p>
        </section>
      </div>
    );
  },
});

export const CustomerTables = artboard({
  id: "CustomerTables",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerTables() {
    return (
      <MobileFrame
        title="Choose your table"
        eyebrow="Good evening, Clara"
        active="tables"
        showBack={false}
        showNav={true}
        body={
          <div
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            data-cz-id="cz_767c"
          >
            <div
              style={{
                padding: 13,
                borderRadius: 14,
                background: theme.colors.sage100,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
              data-cz-id="cz_8fe9"
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  background: theme.colors.forest900,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_b7fb"
              >
                <Icon name="sparkles" size={13} color="#FFFFFF" czId="cz_4720" />
              </span>
              <div style={{ flex: 1 }} data-cz-id="cz_2f77">
                <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_0f61">
                  6 tables are ready
                </strong>
                <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_5fda">
                  Tap an available table to open your order.
                </span>
              </div>
            </div>
            <div
              style={{
                marginTop: 14,
                display: "flex",
                gap: 13,
                color: theme.colors.ink500,
                fontSize: 8,
              }}
              data-cz-id="cz_2a5f"
            >
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                data-cz-id="cz_4c00"
              >
                <i
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: theme.colors.sage500,
                  }}
                  data-cz-id="cz_e19d"
                />
                Available
              </span>
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                data-cz-id="cz_e69f"
              >
                <i
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: theme.colors.clay500,
                  }}
                  data-cz-id="cz_e346"
                />
                In use
              </span>
            </div>
            <div
              style={{
                marginTop: 11,
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 9,
              }}
              data-cz-id="cz_0454"
            >
              {tables.map((table) => {
                const occupied = table.status === "IN USE";
                return (
                  <button
                    key={table.id}
                    style={{
                      minHeight: 94,
                      padding: 10,
                      borderRadius: 14,
                      border: occupied
                        ? `1px solid ${theme.colors.line}`
                        : `1px solid ${theme.colors.sage500}`,
                      background: occupied ? theme.colors.cream100 : theme.colors.warmWhite,
                      color: occupied ? theme.colors.ink500 : theme.colors.forest900,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                    }}
                    data-cz-id="cz_9031"
                  >
                    <div
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                      data-cz-id="cz_cc0a"
                    >
                      <strong
                        style={{ fontFamily: theme.fonts.display, fontSize: 20 }}
                        data-cz-id="cz_b3bf"
                      >
                        T{String(table.id).padStart(2, "0")}
                      </strong>
                      {occupied && (
                        <Icon
                          name="lock.fill"
                          size={10}
                          color={theme.colors.ink500}
                          czId="cz_0ae0"
                        />
                      )}
                    </div>
                    <div style={{ textAlign: "left" }} data-cz-id="cz_3de3">
                      <span style={{ display: "block", fontSize: 8 }} data-cz-id="cz_0813">
                        {table.seats} seats
                      </span>
                      <strong
                        style={{
                          display: "block",
                          marginTop: 3,
                          color: occupied ? theme.colors.ink500 : theme.colors.forest800,
                          fontSize: 8,
                        }}
                        data-cz-id="cz_7154"
                      >
                        {occupied ? "In use" : "Select"}
                      </strong>
                    </div>
                  </button>
                );
              })}
            </div>
            <div
              style={{
                marginTop: "auto",
                padding: "12px 13px",
                borderRadius: 13,
                background: theme.colors.cream100,
                display: "flex",
                alignItems: "center",
                gap: 9,
                color: theme.colors.ink500,
                fontSize: 8,
                lineHeight: 1.4,
              }}
              data-cz-id="cz_4915"
            >
              <Icon name="info.circle" size={13} color={theme.colors.ink500} czId="cz_a5dc" />A
              table locks as soon as its order opens and becomes available again after payment or
              cancellation.
            </div>
          </div>
        }
        czId="cz_abc7"
      />
    );
  },
});

export const CustomerActiveOrder = artboard({
  id: "CustomerActiveOrder",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerActiveOrder() {
    return (
      <MobileFrame
        title="Table 07"
        eyebrow={`${activeOrder.id} · Open`}
        active="order"
        showBack={false}
        showNav={true}
        body={
          <div
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            data-cz-id="cz_7d9d"
          >
            <section
              style={{
                padding: 15,
                borderRadius: 16,
                background: theme.colors.forest950,
                color: "white",
              }}
              data-cz-id="cz_2c87"
            >
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                data-cz-id="cz_80cd"
              >
                <div data-cz-id="cz_680b">
                  <span
                    style={{
                      color: "#9FB8AE",
                      fontSize: 8,
                      fontWeight: 750,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                    data-cz-id="cz_1e92"
                  >
                    Order progress
                  </span>
                  <strong
                    style={{
                      display: "block",
                      marginTop: 5,
                      fontFamily: theme.fonts.display,
                      fontSize: 20,
                    }}
                    data-cz-id="cz_5872"
                  >
                    Dinner is underway
                  </strong>
                </div>
                <span
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: "rgba(255,255,255,0.10)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_c6f6"
                >
                  <Icon name="fork.knife" size={16} color="#FFFFFF" czId="cz_74fa" />
                </span>
              </div>
              <div
                style={{
                  marginTop: 15,
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 5,
                }}
                data-cz-id="cz_1bdd"
              >
                {["Ordered", "Preparing", "Prepared", "Served"].map((step, index) => (
                  <div key={step} style={{ minWidth: 0 }} data-cz-id="cz_2229">
                    <div
                      style={{
                        height: 4,
                        borderRadius: 999,
                        background: index < 3 ? theme.colors.clay500 : "#35564E",
                      }}
                      data-cz-id="cz_c1c6"
                    />
                    <span
                      style={{
                        display: "block",
                        marginTop: 5,
                        color: index < 3 ? "#FFFFFF" : "#78958B",
                        fontSize: 7,
                      }}
                      data-cz-id="cz_f022"
                    >
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <div
              style={{
                marginTop: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
              data-cz-id="cz_bb3b"
            >
              <h2 style={{ margin: 0, fontSize: 13 }} data-cz-id="cz_180b">
                Your items
              </h2>
              <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_be12">
                4 total
              </span>
            </div>
            <div
              style={{ marginTop: 7, borderTop: `1px solid ${theme.colors.line}` }}
              data-cz-id="cz_0cda"
            >
              {activeOrder.items.map((relation) => {
                const preparing = relation.status === "PREPARING";
                const prepared = relation.status === "PREPARED";
                return (
                  <div
                    key={relation.id}
                    style={{
                      padding: "12px 0",
                      borderBottom: `1px solid ${theme.colors.line}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                    data-cz-id="cz_bdee"
                  >
                    <span
                      style={{
                        width: 31,
                        height: 31,
                        borderRadius: 10,
                        background: theme.colors.cream100,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: theme.colors.forest900,
                        fontSize: 9,
                        fontWeight: 800,
                      }}
                      data-cz-id="cz_54e9"
                    >
                      {relation.quantity}×
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_9a92">
                      <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_7d00">
                        {relation.item.name}
                      </strong>
                      <span
                        style={{ color: theme.colors.ink500, fontSize: 8 }}
                        data-cz-id="cz_40ab"
                      >
                        ${relation.item.price * relation.quantity}
                      </span>
                    </div>
                    <StatusPill
                      label={relation.status}
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
                      czId="cz_87e4"
                    />
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: "auto" }} data-cz-id="cz_c308">
              <div
                style={{
                  padding: "14px 0",
                  borderTop: `1px solid ${theme.colors.line}`,
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                }}
                data-cz-id="cz_f1d1"
              >
                <div data-cz-id="cz_57f1">
                  <span
                    style={{ display: "block", color: theme.colors.ink500, fontSize: 8 }}
                    data-cz-id="cz_6be7"
                  >
                    Running total
                  </span>
                  <strong
                    style={{
                      display: "block",
                      marginTop: 2,
                      fontFamily: theme.fonts.display,
                      fontSize: 25,
                    }}
                    data-cz-id="cz_a08e"
                  >
                    ${activeOrder.total}
                  </strong>
                </div>
                <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_a8d0">
                  Taxes included
                </span>
              </div>
              <ActionButton
                label="Order more items"
                icon="plus"
                variant="dark"
                fullWidth={true}
                czId="cz_0e77"
              />
              <button
                style={{
                  marginTop: 8,
                  width: "100%",
                  height: 40,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 12,
                  background: theme.colors.cream100,
                  color: theme.colors.ink300,
                  fontSize: 9,
                  fontWeight: 750,
                }}
                data-cz-id="cz_ec66"
              >
                Pay when every item is served
              </button>
            </div>
          </div>
        }
        czId="cz_fe35"
      />
    );
  },
});

export const CustomerCancelledOrder = artboard({
  id: "CustomerCancelledOrder",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerCancelledOrder() {
    return (
      <MobileFrame
        title="Table 03"
        eyebrow="#1043 · Open"
        active="order"
        showBack={false}
        showNav={true}
        body={
          <div
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            data-cz-id="cz_9ee3"
          >
            <div
              style={{
                padding: 16,
                borderRadius: 16,
                background: theme.colors.rose100,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
              data-cz-id="cz_3d58"
            >
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: theme.colors.rose500,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_26c0"
              >
                <Icon name="xmark" size={16} color="#FFFFFF" czId="cz_606b" />
              </span>
              <div data-cz-id="cz_32f5">
                <strong
                  style={{ display: "block", color: theme.colors.rose500, fontSize: 11 }}
                  data-cz-id="cz_5922"
                >
                  Every item was cancelled
                </strong>
                <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_880a">
                  You can close this order without payment.
                </span>
              </div>
            </div>
            <div style={{ marginTop: 18 }} data-cz-id="cz_8d1b">
              {["Charred Tomatoes", "Blood Orange Spritz"].map((item) => (
                <div
                  key={item}
                  style={{
                    padding: "14px 0",
                    borderBottom: `1px solid ${theme.colors.line}`,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                  data-cz-id="cz_e2ee"
                >
                  <span
                    style={{
                      width: 31,
                      height: 31,
                      borderRadius: 10,
                      background: theme.colors.cream100,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: theme.colors.ink500,
                      fontSize: 9,
                    }}
                    data-cz-id="cz_a522"
                  >
                    1×
                  </span>
                  <span
                    style={{
                      flex: 1,
                      color: theme.colors.ink500,
                      fontSize: 10,
                      textDecoration: "line-through",
                    }}
                    data-cz-id="cz_50bf"
                  >
                    {item}
                  </span>
                  <StatusPill
                    label="Cancelled"
                    color={theme.colors.rose500}
                    background={theme.colors.rose100}
                    dot={true}
                    czId="cz_3d00"
                  />
                </div>
              ))}
            </div>
            <div style={{ marginTop: "auto" }} data-cz-id="cz_879c">
              <div
                style={{
                  marginBottom: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
                data-cz-id="cz_c648"
              >
                <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_0432">
                  Order total
                </span>
                <strong
                  style={{ fontFamily: theme.fonts.display, fontSize: 25 }}
                  data-cz-id="cz_2c01"
                >
                  $0
                </strong>
              </div>
              <ActionButton
                label="Close cancelled order"
                icon="xmark.circle"
                variant="danger"
                fullWidth={true}
                czId="cz_fd1a"
              />
              <button
                style={{
                  marginTop: 8,
                  width: "100%",
                  height: 40,
                  border: "none",
                  background: "transparent",
                  color: theme.colors.forest800,
                  fontSize: 9,
                  fontWeight: 750,
                }}
                data-cz-id="cz_fdb5"
              >
                Exit to profile
              </button>
            </div>
          </div>
        }
        czId="cz_9b51"
      />
    );
  },
});

export const CustomerMenu = artboard({
  id: "CustomerMenu",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerMenu() {
    return (
      <MobileFrame
        title="Order something delicious"
        eyebrow="Table 07 · Menu"
        active="order"
        showBack={true}
        showNav={false}
        body={
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              position: "relative",
            }}
            data-cz-id="cz_cb0a"
          >
            <div
              style={{ display: "flex", gap: 7, overflow: "hidden", paddingBottom: 11 }}
              data-cz-id="cz_433a"
            >
              {categories.map((category, index) => (
                <button
                  key={category}
                  style={{
                    height: 30,
                    padding: "0 11px",
                    border: index === 0 ? "none" : `1px solid ${theme.colors.line}`,
                    borderRadius: 999,
                    background: index === 0 ? theme.colors.forest900 : theme.colors.warmWhite,
                    color: index === 0 ? "white" : theme.colors.ink500,
                    fontSize: 8,
                    fontWeight: index === 0 ? 750 : 600,
                    whiteSpace: "nowrap",
                  }}
                  data-cz-id="cz_de9e"
                >
                  {category}
                </button>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 9,
                overflow: "hidden",
                paddingBottom: 75,
              }}
              data-cz-id="cz_cbd3"
            >
              {menuItems.slice(0, 5).map((item) => (
                <div key={item.id} style={{ position: "relative" }} data-cz-id="cz_d5e9">
                  <MenuItemCard
                    name={item.name}
                    description={item.description}
                    price={`$${item.price}`}
                    image={item.image}
                    compact={true}
                    czId="cz_64b7"
                  />
                  <button
                    style={{
                      position: "absolute",
                      right: 11,
                      bottom: 10,
                      width: 28,
                      height: 28,
                      border: "none",
                      borderRadius: 9,
                      background: theme.colors.forest900,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_f14a"
                  >
                    <Icon name="plus" size={12} color="#FFFFFF" czId="cz_a908" />
                  </button>
                </div>
              ))}
            </div>
            <button
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 4,
                height: 55,
                padding: "0 14px",
                border: "none",
                borderRadius: 15,
                background: theme.colors.clay500,
                color: "white",
                boxShadow: "0 12px 32px rgba(216,111,74,0.26)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
              data-cz-id="cz_d9db"
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.18)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_3e95"
              >
                <Icon name="bag" size={14} color="#FFFFFF" czId="cz_4967" />
              </span>
              <div style={{ flex: 1, textAlign: "left" }} data-cz-id="cz_f0fa">
                <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_cce2">
                  View your cart
                </strong>
                <span
                  style={{
                    display: "block",
                    marginTop: 2,
                    color: "rgba(255,255,255,0.92)",
                    fontSize: 8,
                  }}
                  data-cz-id="cz_47b3"
                >
                  3 items
                </span>
              </div>
              <strong
                style={{ fontFamily: theme.fonts.display, fontSize: 18 }}
                data-cz-id="cz_1776"
              >
                $56
              </strong>
              <Icon name="chevron.right" size={12} color="#FFFFFF" czId="cz_7193" />
            </button>
          </div>
        }
        czId="cz_fe05"
      />
    );
  },
});

export const CustomerCart = artboard({
  id: "CustomerCart",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerCart() {
    return (
      <MobileFrame
        title="Review your cart"
        eyebrow="Table 07"
        active="order"
        showBack={true}
        showNav={false}
        body={
          <div
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            data-cz-id="cz_bb76"
          >
            <div
              style={{
                padding: "11px 13px",
                borderRadius: 13,
                background: theme.colors.sage100,
                color: theme.colors.forest800,
                fontSize: 9,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              data-cz-id="cz_3878"
            >
              <Icon name="clock" size={12} color={theme.colors.forest800} czId="cz_c205" />
              Estimated kitchen time · 18–24 minutes
            </div>
            <div
              style={{ marginTop: 9, borderTop: `1px solid ${theme.colors.line}` }}
              data-cz-id="cz_5d0f"
            >
              {[
                {
                  name: "Charred Tomatoes",
                  note: "Whipped feta, basil oil",
                  quantity: 1,
                  price: 16,
                },
                { name: "Grilled Sea Bass", note: "No substitutions", quantity: 1, price: 34 },
                { name: "Blood Orange Spritz", note: "Less ice", quantity: 1, price: 12 },
              ].map((item) => (
                <div
                  key={item.name}
                  style={{
                    padding: "14px 0",
                    borderBottom: `1px solid ${theme.colors.line}`,
                    display: "flex",
                    gap: 11,
                  }}
                  data-cz-id="cz_b868"
                >
                  <div style={{ flex: 1 }} data-cz-id="cz_4794">
                    <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_6d14">
                      {item.name}
                    </strong>
                    <span
                      style={{
                        display: "block",
                        marginTop: 4,
                        color: theme.colors.ink500,
                        fontSize: 8,
                      }}
                      data-cz-id="cz_bf9f"
                    >
                      {item.note}
                    </span>
                    <button
                      style={{
                        marginTop: 7,
                        border: "none",
                        background: "transparent",
                        color: theme.colors.rose500,
                        padding: 0,
                        fontSize: 8,
                        fontWeight: 700,
                      }}
                      data-cz-id="cz_c18e"
                    >
                      Remove
                    </button>
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 7 }}
                    data-cz-id="cz_a527"
                  >
                    <button
                      style={{
                        width: 25,
                        height: 25,
                        border: `1px solid ${theme.colors.line}`,
                        borderRadius: 8,
                        background: theme.colors.warmWhite,
                      }}
                      data-cz-id="cz_94c7"
                    >
                      −
                    </button>
                    <strong style={{ fontSize: 10 }} data-cz-id="cz_d5fb">
                      {item.quantity}
                    </strong>
                    <button
                      style={{
                        width: 25,
                        height: 25,
                        border: "none",
                        borderRadius: 8,
                        background: theme.colors.forest900,
                        color: "white",
                      }}
                      data-cz-id="cz_8efd"
                    >
                      +
                    </button>
                  </div>
                  <strong
                    style={{ width: 31, textAlign: "right", fontSize: 10 }}
                    data-cz-id="cz_b25a"
                  >
                    ${item.price}
                  </strong>
                </div>
              ))}
            </div>
            <div style={{ marginTop: "auto" }} data-cz-id="cz_6f22">
              <div
                style={{ padding: "13px 0", borderTop: `1px solid ${theme.colors.line}` }}
                data-cz-id="cz_3667"
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_17d6"
                >
                  <span data-cz-id="cz_e6de">Subtotal</span>
                  <span data-cz-id="cz_10b2">$62</span>
                </div>
                <div
                  style={{
                    marginTop: 7,
                    display: "flex",
                    justifyContent: "space-between",
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_ec59"
                >
                  <span data-cz-id="cz_652c">Service</span>
                  <span data-cz-id="cz_10d8">Included</span>
                </div>
                <div
                  style={{
                    marginTop: 11,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                  }}
                  data-cz-id="cz_4acb"
                >
                  <strong style={{ fontSize: 10 }} data-cz-id="cz_9d22">
                    New order total
                  </strong>
                  <strong
                    style={{ fontFamily: theme.fonts.display, fontSize: 24 }}
                    data-cz-id="cz_71b7"
                  >
                    $62
                  </strong>
                </div>
              </div>
              <button
                style={{
                  width: "100%",
                  height: 48,
                  border: "none",
                  borderRadius: 14,
                  background: theme.colors.clay500,
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  fontSize: 10,
                  fontWeight: 800,
                }}
                data-cz-id="cz_2e36"
              >
                <Icon name="checkmark.circle" size={14} color="#FFFFFF" czId="cz_e926" />
                Confirm 3 items
              </button>
              <p
                style={{
                  margin: "9px 0 0",
                  color: theme.colors.ink500,
                  fontSize: 8,
                  textAlign: "center",
                }}
                data-cz-id="cz_dc55"
              >
                Items begin as ORDERED and can be cancelled before preparation starts.
              </p>
            </div>
          </div>
        }
        czId="cz_2d4d"
      />
    );
  },
});

export const CustomerRealtimeUpdate = artboard({
  id: "CustomerRealtimeUpdate",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerRealtimeUpdate() {
    return (
      <MobileFrame
        title="Table 07"
        eyebrow="#1048 · Live order"
        active="order"
        showBack={false}
        showNav={true}
        body={
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              position: "relative",
            }}
            data-cz-id="cz_5649"
          >
            <div
              style={{
                position: "absolute",
                zIndex: 3,
                top: 5,
                left: 0,
                right: 0,
                padding: 13,
                borderRadius: 15,
                background: theme.colors.forest950,
                color: "white",
                boxShadow: "0 18px 45px rgba(16,42,36,0.25)",
                display: "flex",
                alignItems: "center",
                gap: 11,
              }}
              data-cz-id="cz_82fe"
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: theme.colors.amber500,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_1069"
              >
                <Icon name="flame.fill" size={15} color="#FFFFFF" czId="cz_c3eb" />
              </span>
              <div style={{ flex: 1 }} data-cz-id="cz_9000">
                <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_6e1c">
                  Your sea bass is now being prepared!
                </strong>
                <span
                  style={{ display: "block", marginTop: 3, color: "#AFC6BC", fontSize: 8 }}
                  data-cz-id="cz_753f"
                >
                  We’ll let you know when it’s ready for service.
                </span>
              </div>
              <Icon name="xmark" size={11} color="#AFC6BC" czId="cz_b594" />
            </div>
            <section
              style={{
                marginTop: 92,
                padding: 15,
                borderRadius: 16,
                background: theme.colors.warmWhite,
                border: `1px solid ${theme.colors.line}`,
              }}
              data-cz-id="cz_aad9"
            >
              <span
                style={{
                  color: theme.colors.ink500,
                  fontSize: 8,
                  fontWeight: 750,
                  letterSpacing: "0.09em",
                  textTransform: "uppercase",
                }}
                data-cz-id="cz_32ce"
              >
                Live progress
              </span>
              <h2
                style={{ margin: "7px 0 0", fontFamily: theme.fonts.display, fontSize: 21 }}
                data-cz-id="cz_8087"
              >
                Two plates are moving
              </h2>
              <div
                style={{
                  marginTop: 13,
                  height: 6,
                  borderRadius: 999,
                  background: theme.colors.cream100,
                  overflow: "hidden",
                }}
                data-cz-id="cz_2776"
              >
                <div
                  style={{
                    width: "68%",
                    height: "100%",
                    borderRadius: 999,
                    background: theme.colors.clay500,
                  }}
                  data-cz-id="cz_dfbe"
                />
              </div>
              <div
                style={{
                  marginTop: 7,
                  display: "flex",
                  justifyContent: "space-between",
                  color: theme.colors.ink500,
                  fontSize: 7,
                }}
                data-cz-id="cz_2e10"
              >
                <span data-cz-id="cz_2218">Ordered</span>
                <span data-cz-id="cz_7fc7">Preparing</span>
                <span data-cz-id="cz_f056">Prepared</span>
                <span data-cz-id="cz_3112">Served</span>
              </div>
            </section>
            <div style={{ marginTop: 15 }} data-cz-id="cz_bf3e">
              {[
                {
                  name: "Charred Tomatoes",
                  status: "SERVED",
                  color: theme.colors.forest800,
                  background: theme.colors.sage100,
                },
                {
                  name: "Grilled Sea Bass",
                  status: "PREPARING",
                  color: theme.colors.amber500,
                  background: theme.colors.amber100,
                },
                {
                  name: "Blood Orange Spritz ×2",
                  status: "PREPARED",
                  color: theme.colors.sky500,
                  background: theme.colors.sky100,
                },
              ].map((item) => (
                <div
                  key={item.name}
                  style={{
                    padding: "14px 0",
                    borderBottom: `1px solid ${theme.colors.line}`,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                  data-cz-id="cz_3ac3"
                >
                  <span
                    style={{
                      width: 31,
                      height: 31,
                      borderRadius: 10,
                      background: theme.colors.cream100,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_a0fd"
                  >
                    <Icon
                      name="fork.knife"
                      size={12}
                      color={theme.colors.forest800}
                      czId="cz_6d11"
                    />
                  </span>
                  <strong style={{ flex: 1, fontSize: 10 }} data-cz-id="cz_d5b0">
                    {item.name}
                  </strong>
                  <StatusPill
                    label={item.status}
                    color={item.color}
                    background={item.background}
                    dot={true}
                    czId="cz_6749"
                  />
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: "auto",
                padding: 13,
                borderRadius: 13,
                background: theme.colors.sage100,
                display: "flex",
                alignItems: "center",
                gap: 9,
                color: theme.colors.forest800,
                fontSize: 8,
              }}
              data-cz-id="cz_f166"
            >
              <Icon
                name="bolt.horizontal.circle"
                size={14}
                color={theme.colors.forest800}
                czId="cz_e6e3"
              />
              Status updates arrive in real time while this order is open.
            </div>
          </div>
        }
        czId="cz_2c67"
      />
    );
  },
});

export const CustomerPaymentReview = artboard({
  id: "CustomerPaymentReview",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerPaymentReview() {
    return (
      <MobileFrame
        title="Your bill is ready"
        eyebrow={`${activeOrder.id} · Table 07`}
        active="order"
        showBack={true}
        showNav={false}
        body={
          <div
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            data-cz-id="cz_374a"
          >
            <div
              style={{
                padding: 14,
                borderRadius: 15,
                background: theme.colors.sage100,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
              data-cz-id="cz_e1be"
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 12,
                  background: theme.colors.forest900,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_e84b"
              >
                <Icon name="checkmark" size={14} color="#FFFFFF" czId="cz_caf4" />
              </span>
              <div data-cz-id="cz_790e">
                <strong style={{ display: "block", fontSize: 10 }} data-cz-id="cz_4545">
                  Everything is in a final state
                </strong>
                <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_f49e">
                  3 served · 1 cancelled · ready to pay
                </span>
              </div>
            </div>
            <section
              style={{
                marginTop: 14,
                padding: 16,
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 17,
                background: theme.colors.warmWhite,
              }}
              data-cz-id="cz_d545"
            >
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                data-cz-id="cz_1e14"
              >
                <h2
                  style={{ margin: 0, fontFamily: theme.fonts.display, fontSize: 21 }}
                  data-cz-id="cz_0a36"
                >
                  Bill summary
                </h2>
                <StatusPill
                  label="Ready"
                  color={theme.colors.forest800}
                  background={theme.colors.sage100}
                  dot={true}
                  czId="cz_0a5e"
                />
              </div>
              <div style={{ marginTop: 14 }} data-cz-id="cz_bb83">
                {[
                  { name: "Charred Tomatoes", quantity: "1×", price: 16 },
                  { name: "Grilled Sea Bass", quantity: "1×", price: 34 },
                  { name: "Blood Orange Spritz", quantity: "2×", price: 24 },
                ].map((item) => (
                  <div
                    key={item.name}
                    style={{
                      padding: "11px 0",
                      borderBottom: `1px solid ${theme.colors.line}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                    }}
                    data-cz-id="cz_81e7"
                  >
                    <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_b869">
                      {item.quantity}
                    </span>
                    <span style={{ flex: 1, fontSize: 9 }} data-cz-id="cz_fe3a">
                      {item.name}
                    </span>
                    <strong style={{ fontSize: 9 }} data-cz-id="cz_0b74">
                      ${item.price}
                    </strong>
                  </div>
                ))}
                <div
                  style={{
                    padding: "11px 0",
                    borderBottom: `1px solid ${theme.colors.line}`,
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    color: theme.colors.ink500,
                  }}
                  data-cz-id="cz_76d9"
                >
                  <span style={{ fontSize: 9 }} data-cz-id="cz_994e">
                    1×
                  </span>
                  <span
                    style={{ flex: 1, fontSize: 9, textDecoration: "line-through" }}
                    data-cz-id="cz_1b8c"
                  >
                    Pistachio Citrus
                  </span>
                  <StatusPill
                    label="Cancelled"
                    color={theme.colors.rose500}
                    background={theme.colors.rose100}
                    dot={false}
                    czId="cz_bca1"
                  />
                  <strong style={{ fontSize: 9 }} data-cz-id="cz_bba6">
                    $0
                  </strong>
                </div>
              </div>
              <div
                style={{
                  marginTop: 15,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-end",
                }}
                data-cz-id="cz_69f9"
              >
                <div data-cz-id="cz_25ec">
                  <span
                    style={{ display: "block", color: theme.colors.ink500, fontSize: 8 }}
                    data-cz-id="cz_f9af"
                  >
                    Total · taxes included
                  </span>
                  <strong
                    style={{
                      display: "block",
                      marginTop: 3,
                      fontFamily: theme.fonts.display,
                      fontSize: 29,
                    }}
                    data-cz-id="cz_8a38"
                  >
                    $74
                  </strong>
                </div>
                <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_f211">
                  4 item relations
                </span>
              </div>
            </section>
            <div
              style={{
                marginTop: 14,
                padding: 14,
                borderRadius: 14,
                background: theme.colors.cream100,
              }}
              data-cz-id="cz_a5b7"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }} data-cz-id="cz_bca6">
                <span
                  style={{
                    width: 35,
                    height: 35,
                    borderRadius: 11,
                    background: theme.colors.warmWhite,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_6c97"
                >
                  <Icon name="creditcard" size={15} color={theme.colors.forest800} czId="cz_2d49" />
                </span>
                <div style={{ flex: 1 }} data-cz-id="cz_384e">
                  <strong style={{ display: "block", fontSize: 9 }} data-cz-id="cz_6596">
                    Demo payment
                  </strong>
                  <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_f8c6">
                    Instant confirmation · no card required
                  </span>
                </div>
                <Icon name="chevron.right" size={11} color={theme.colors.ink300} czId="cz_0853" />
              </div>
            </div>
            <div style={{ marginTop: "auto" }} data-cz-id="cz_3e55">
              <ActionButton
                label="Pay $74"
                icon="lock.fill"
                variant="primary"
                fullWidth={true}
                czId="cz_cad4"
              />
              <p
                style={{
                  margin: "10px 0 0",
                  color: theme.colors.ink500,
                  fontSize: 8,
                  textAlign: "center",
                }}
                data-cz-id="cz_b754"
              >
                Your order will be marked PAID and Table 07 will be released.
              </p>
            </div>
          </div>
        }
        czId="cz_0c74"
      />
    );
  },
});

export const CustomerPaymentSuccess = artboard({
  id: "CustomerPaymentSuccess",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerPaymentSuccess() {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: "30px 22px 26px",
          background: theme.colors.cream50,
          color: theme.colors.ink900,
          fontFamily: theme.fonts.primary,
          display: "flex",
          flexDirection: "column",
        }}
        data-cz-id="cz_1e95"
      >
        <div
          style={{
            height: 20,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            fontWeight: 750,
          }}
          data-cz-id="cz_0c02"
        >
          <span data-cz-id="cz_1413">9:41</span>
          <span style={{ letterSpacing: 2 }} data-cz-id="cz_3e3c">
            •••
          </span>
        </div>
        <div style={{ marginTop: 21 }} data-cz-id="cz_02ba">
          <Brand compact={true} inverted={false} czId="cz_982d" />
        </div>
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
          }}
          data-cz-id="cz_f210"
        >
          <div
            style={{
              width: 94,
              height: 94,
              borderRadius: 999,
              background: theme.colors.sage100,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
            data-cz-id="cz_987d"
          >
            <span
              style={{
                width: 63,
                height: 63,
                borderRadius: 999,
                background: theme.colors.forest900,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              data-cz-id="cz_3a78"
            >
              <Icon name="checkmark" size={26} color="#FFFFFF" czId="cz_827e" />
            </span>
            <span
              style={{
                position: "absolute",
                top: 1,
                right: 5,
                color: theme.colors.clay500,
                fontSize: 18,
              }}
              data-cz-id="cz_de48"
            >
              ✦
            </span>
          </div>
          <span
            style={{
              marginTop: 27,
              color: theme.colors.clay500,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
            data-cz-id="cz_c26a"
          >
            Payment successful
          </span>
          <h1
            style={{
              margin: "10px 0 0",
              fontFamily: theme.fonts.display,
              fontSize: 37,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: "-0.04em",
            }}
            data-cz-id="cz_e9d2"
          >
            Thank you for dining with us.
          </h1>
          <p
            style={{
              margin: "14px 0 0",
              maxWidth: 300,
              color: theme.colors.ink500,
              fontSize: 11,
              lineHeight: 1.55,
            }}
            data-cz-id="cz_e7ae"
          >
            Order #1048 is paid. Table 07 is available again, and this visit is saved in your
            history.
          </p>
          <div
            style={{
              marginTop: 23,
              width: "100%",
              padding: 15,
              borderRadius: 15,
              border: `1px solid ${theme.colors.line}`,
              background: theme.colors.warmWhite,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
            data-cz-id="cz_bdfb"
          >
            <div style={{ textAlign: "left" }} data-cz-id="cz_5367">
              <span
                style={{ display: "block", color: theme.colors.ink500, fontSize: 8 }}
                data-cz-id="cz_9674"
              >
                Amount paid
              </span>
              <strong
                style={{
                  display: "block",
                  marginTop: 3,
                  fontFamily: theme.fonts.display,
                  fontSize: 22,
                }}
                data-cz-id="cz_0873"
              >
                $74
              </strong>
            </div>
            <StatusPill
              label="Paid"
              color={theme.colors.sky500}
              background={theme.colors.sky100}
              dot={true}
              czId="cz_1817"
            />
          </div>
        </main>
        <ActionButton
          label="View all orders"
          icon="clock.arrow.circlepath"
          variant="dark"
          fullWidth={true}
          czId="cz_9fbc"
        />
        <button
          style={{
            marginTop: 8,
            height: 40,
            border: "none",
            background: "transparent",
            color: theme.colors.ink500,
            fontSize: 9,
            fontWeight: 700,
          }}
          data-cz-id="cz_3ad0"
        >
          Exit app
        </button>
      </div>
    );
  },
});

export const CustomerHistory = artboard({
  id: "CustomerHistory",
  width: { mode: "fixed", value: 390 },
  height: { mode: "fixed", value: 844 },
  render: function CustomerHistory() {
    return (
      <MobileFrame
        title="Your visits"
        eyebrow="Clara Mendes"
        active="history"
        showBack={false}
        showNav={true}
        body={
          <div
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            data-cz-id="cz_aa34"
          >
            <span
              style={{
                color: theme.colors.ink500,
                fontSize: 8,
                fontWeight: 800,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_3300"
            >
              Active now
            </span>
            <article
              style={{
                marginTop: 8,
                padding: 15,
                borderRadius: 16,
                background: theme.colors.forest950,
                color: "white",
              }}
              data-cz-id="cz_c374"
            >
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                data-cz-id="cz_7d23"
              >
                <div data-cz-id="cz_4039">
                  <span style={{ color: "#9FB8AE", fontSize: 8 }} data-cz-id="cz_1fe2">
                    Table {activeOrder.table}
                  </span>
                  <h2
                    style={{ margin: "4px 0 0", fontFamily: theme.fonts.display, fontSize: 21 }}
                    data-cz-id="cz_3c76"
                  >
                    {activeOrder.id}
                  </h2>
                </div>
                <StatusPill
                  label="Open"
                  color="#FFFFFF"
                  background="#2A5147"
                  dot={true}
                  czId="cz_4395"
                />
              </div>
              <div
                style={{
                  marginTop: 15,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
                data-cz-id="cz_18fa"
              >
                <span style={{ color: "#9FB8AE", fontSize: 8 }} data-cz-id="cz_a51f">
                  3 items · opened {activeOrder.openedAt}
                </span>
                <strong
                  style={{ fontFamily: theme.fonts.display, fontSize: 20 }}
                  data-cz-id="cz_9940"
                >
                  ${activeOrder.total}
                </strong>
              </div>
              <button
                style={{
                  marginTop: 13,
                  width: "100%",
                  height: 36,
                  border: "none",
                  borderRadius: 10,
                  background: theme.colors.clay500,
                  color: "white",
                  fontSize: 8,
                  fontWeight: 800,
                }}
                data-cz-id="cz_1db9"
              >
                Return to active order →
              </button>
            </article>
            <div
              style={{
                marginTop: 19,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
              data-cz-id="cz_fb92"
            >
              <span
                style={{
                  color: theme.colors.ink500,
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
                data-cz-id="cz_78ff"
              >
                Past orders
              </span>
              <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_6c47">
                8 total
              </span>
            </div>
            <div
              style={{ marginTop: 7, borderTop: `1px solid ${theme.colors.line}` }}
              data-cz-id="cz_f604"
            >
              {pastOrders.map((order) => {
                const cancelled = order.status === "CANCELLED";
                return (
                  <div
                    key={order.id}
                    style={{
                      padding: "14px 0",
                      borderBottom: `1px solid ${theme.colors.line}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                    data-cz-id="cz_4e1c"
                  >
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 11,
                        background: cancelled ? theme.colors.rose100 : theme.colors.sky100,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      data-cz-id="cz_a04c"
                    >
                      <Icon
                        name={cancelled ? "xmark" : "checkmark"}
                        size={13}
                        color={cancelled ? theme.colors.rose500 : theme.colors.sky500}
                        czId="cz_cf13"
                      />
                    </span>
                    <div style={{ flex: 1 }} data-cz-id="cz_20ba">
                      <strong style={{ display: "block", fontSize: 9 }} data-cz-id="cz_f6ae">
                        {order.id} · Table {order.table}
                      </strong>
                      <span
                        style={{
                          display: "block",
                          marginTop: 3,
                          color: theme.colors.ink500,
                          fontSize: 8,
                        }}
                        data-cz-id="cz_3db0"
                      >
                        {order.date}
                      </span>
                    </div>
                    <div style={{ textAlign: "right" }} data-cz-id="cz_c42f">
                      <StatusPill
                        label={order.status}
                        color={cancelled ? theme.colors.rose500 : theme.colors.sky500}
                        background={cancelled ? theme.colors.rose100 : theme.colors.sky100}
                        dot={false}
                        czId="cz_efca"
                      />
                      <strong
                        style={{
                          display: "block",
                          marginTop: 4,
                          color: cancelled ? theme.colors.ink500 : theme.colors.ink900,
                          fontSize: 9,
                        }}
                        data-cz-id="cz_800c"
                      >
                        ${order.total}
                      </strong>
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                marginTop: "auto",
                padding: 13,
                borderRadius: 13,
                background: theme.colors.cream100,
                display: "flex",
                alignItems: "center",
                gap: 9,
              }}
              data-cz-id="cz_5551"
            >
              <Icon name="heart" size={14} color={theme.colors.clay500} czId="cz_9bf2" />
              <div data-cz-id="cz_144f">
                <strong style={{ display: "block", fontSize: 9 }} data-cz-id="cz_22f1">
                  Your Savoria story
                </strong>
                <span style={{ color: theme.colors.ink500, fontSize: 8 }} data-cz-id="cz_d002">
                  8 visits · favorite: Grilled Sea Bass
                </span>
              </div>
            </div>
          </div>
        }
        czId="cz_1cdb"
      />
    );
  },
});
