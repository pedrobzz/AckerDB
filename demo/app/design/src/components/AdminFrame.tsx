import { Icon, component, cz } from "canvazz";
import { Brand } from "@/components/Brand";
import { theme } from "@theme";

const navigation = [
  { label: "Overview", value: "overview", icon: "square.grid.2x2" },
  { label: "Orders", value: "orders", icon: "receipt" },
  { label: "Kitchen queue", value: "kitchen", icon: "list.bullet.clipboard" },
  { label: "Menu", value: "menu", icon: "fork.knife" },
  { label: "Tables", value: "tables", icon: "table.furniture" },
  { label: "Guests", value: "users", icon: "person.2" },
  { label: "Agents", value: "agents", icon: "sparkles" },
] as const;

export const AdminFrame = component({
  id: "AdminFrame",
  schema: {
    active: cz.enum(["overview", "orders", "kitchen", "menu", "tables", "users", "agents"]),
    title: cz.string(),
    subtitle: cz.string(),
    actionLabel: cz.string(),
    showAction: cz.boolean(),
    body: cz.slot(),
  },
  defaultProps: {
    active: "overview",
    title: "Good evening, Amelia",
    subtitle: "Here’s what’s happening at Savoria tonight.",
    actionLabel: "New order",
    showAction: true,
    body: null,
  },
  render: function AdminFrame({ active, title, subtitle, actionLabel, showAction, body }) {
    return (
      <div
        style={{
          width: "100%",
          minHeight: "100%",
          display: "flex",
          background: theme.colors.cream50,
          color: theme.colors.ink900,
          fontFamily: theme.fonts.primary,
        }}
        data-cz-id="cz_8809"
      >
        <aside
          style={{
            width: 238,
            flexShrink: 0,
            minHeight: 960,
            padding: "27px 18px 22px",
            background: theme.colors.forest950,
            color: theme.colors.warmWhite,
            display: "flex",
            flexDirection: "column",
          }}
          data-cz-id="cz_7ec7"
        >
          <div style={{ padding: "0 10px 30px" }} data-cz-id="cz_b4bc">
            <Brand compact={false} inverted={true} czId="cz_9625" />
            <span
              style={{
                display: "block",
                margin: "8px 0 0 51px",
                color: "#9EB7AD",
                fontSize: 9,
                fontWeight: 750,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_5b70"
            >
              Restaurant OS
            </span>
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 5 }} data-cz-id="cz_0b9e">
            {navigation.map((item) => {
              const selected = item.value === active;
              return (
                <div
                  key={item.value}
                  style={{
                    height: 44,
                    padding: "0 13px",
                    borderRadius: 11,
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    background: selected ? theme.colors.warmWhite : "transparent",
                    color: selected ? theme.colors.forest950 : "#B5C7C0",
                    fontSize: 13,
                    fontWeight: selected ? 750 : 550,
                  }}
                  data-cz-id="cz_e8ea"
                >
                  <Icon
                    name={item.icon}
                    size={16}
                    color={selected ? theme.colors.forest950 : "#91A89F"}
                    czId="cz_01e6"
                  />
                  {item.label}
                  {item.value === "kitchen" && (
                    <span
                      style={{
                        marginLeft: "auto",
                        minWidth: 20,
                        height: 20,
                        borderRadius: 999,
                        background: theme.colors.clay500,
                        color: "white",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 9,
                        fontWeight: 800,
                      }}
                      data-cz-id="cz_666b"
                    >
                      5
                    </span>
                  )}
                </div>
              );
            })}
          </nav>
          <div
            style={{
              marginTop: "auto",
              padding: "16px 11px 4px",
              borderTop: "1px solid #2A4B43",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
            data-cz-id="cz_1e40"
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                background: theme.colors.clay500,
                color: "white",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 800,
              }}
              data-cz-id="cz_7d13"
            >
              AM
            </span>
            <div style={{ minWidth: 0 }} data-cz-id="cz_992c">
              <strong style={{ display: "block", fontSize: 11 }} data-cz-id="cz_6169">
                Amelia Morgan
              </strong>
              <span style={{ color: "#91A89F", fontSize: 9 }} data-cz-id="cz_f1a4">
                General manager
              </span>
            </div>
            <Icon name="ellipsis" size={14} color="#91A89F" czId="cz_e71e" />
          </div>
        </aside>
        <main
          style={{ flex: 1, minWidth: 0, padding: "28px 32px 34px", overflow: "hidden" }}
          data-cz-id="cz_2d24"
        >
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 25,
            }}
            data-cz-id="cz_8ca1"
          >
            <div data-cz-id="cz_08e8">
              <h1
                style={{
                  margin: 0,
                  fontFamily: theme.fonts.display,
                  fontSize: 33,
                  fontWeight: 600,
                  letterSpacing: "-0.035em",
                }}
                data-cz-id="cz_981b"
              >
                {title}
              </h1>
              <p
                style={{ margin: "7px 0 0", color: theme.colors.ink500, fontSize: 12 }}
                data-cz-id="cz_65fc"
              >
                {subtitle}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }} data-cz-id="cz_01ad">
              <button
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  border: `1px solid ${theme.colors.line}`,
                  background: theme.colors.warmWhite,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_afc1"
              >
                <Icon name="bell" size={16} color={theme.colors.ink700} czId="cz_9529" />
              </button>
              {showAction && (
                <button
                  style={{
                    height: 42,
                    padding: "0 16px",
                    border: "none",
                    borderRadius: 12,
                    background: theme.colors.forest900,
                    color: "white",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 750,
                  }}
                  data-cz-id="cz_0629"
                >
                  <Icon name="plus" size={14} color="#FFFFFF" czId="cz_060e" />
                  {actionLabel}
                </button>
              )}
            </div>
          </header>
          {body}
        </main>
      </div>
    );
  },
});
