import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

const tabs = [
  { label: "Tables", value: "tables", icon: "table.furniture" },
  { label: "Order", value: "order", icon: "receipt" },
  { label: "History", value: "history", icon: "clock.arrow.circlepath" },
  { label: "Profile", value: "profile", icon: "person" },
] as const;

export const MobileFrame = component({
  id: "MobileFrame",
  schema: {
    title: cz.string(),
    eyebrow: cz.string(),
    active: cz.enum(["tables", "order", "history", "profile"]),
    showBack: cz.boolean(),
    showNav: cz.boolean(),
    body: cz.slot(),
  },
  defaultProps: {
    title: "Good evening, Clara",
    eyebrow: "Savoria",
    active: "tables",
    showBack: false,
    showNav: true,
    body: null,
  },
  render: function MobileFrame({ title, eyebrow, active, showBack, showNav, body }) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: theme.colors.cream50,
          color: theme.colors.ink900,
          fontFamily: theme.fonts.primary,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        data-cz-id="cz_e590"
      >
        <div
          style={{
            height: 28,
            padding: "10px 20px 0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 10,
            fontWeight: 750,
          }}
          data-cz-id="cz_62d0"
        >
          <span data-cz-id="cz_c8e1">9:41</span>
          <span style={{ letterSpacing: 2 }} data-cz-id="cz_6bc4">
            •••
          </span>
        </div>
        <header
          style={{ padding: "17px 20px 14px", display: "flex", alignItems: "center", gap: 12 }}
          data-cz-id="cz_0985"
        >
          {showBack && (
            <button
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                border: `1px solid ${theme.colors.line}`,
                background: theme.colors.warmWhite,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              data-cz-id="cz_57ae"
            >
              <Icon name="chevron.left" size={15} color={theme.colors.ink900} czId="cz_1e0b" />
            </button>
          )}
          <div style={{ flex: 1 }} data-cz-id="cz_8e86">
            <span
              style={{
                display: "block",
                color: theme.colors.clay500,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.13em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_9f02"
            >
              {eyebrow}
            </span>
            <h1
              style={{
                margin: "4px 0 0",
                fontFamily: theme.fonts.display,
                fontSize: 25,
                lineHeight: 1.05,
                fontWeight: 600,
                letterSpacing: "-0.035em",
              }}
              data-cz-id="cz_add7"
            >
              {title}
            </h1>
          </div>
          {!showBack && (
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 999,
                background: theme.colors.sage200,
                color: theme.colors.forest900,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 800,
              }}
              data-cz-id="cz_af10"
            >
              CM
            </span>
          )}
        </header>
        <div
          style={{ flex: 1, minHeight: 0, padding: "0 20px 18px", overflow: "hidden" }}
          data-cz-id="cz_5b5f"
        >
          {body}
        </div>
        {showNav && (
          <nav
            style={{
              height: 70,
              borderTop: `1px solid ${theme.colors.line}`,
              background: "rgba(255,253,252,0.96)",
              padding: "8px 12px 10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-around",
            }}
            data-cz-id="cz_0e90"
          >
            {tabs.map((tab) => {
              const selected = tab.value === active;
              return (
                <div
                  key={tab.value}
                  style={{
                    minWidth: 58,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    color: selected ? theme.colors.forest900 : theme.colors.ink500,
                    fontSize: 9,
                    fontWeight: selected ? 800 : 600,
                  }}
                  data-cz-id="cz_5808"
                >
                  <span
                    style={{
                      width: 34,
                      height: 27,
                      borderRadius: 999,
                      background: selected ? theme.colors.sage100 : "transparent",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_a458"
                  >
                    <Icon
                      name={tab.icon}
                      size={15}
                      color={selected ? theme.colors.forest900 : theme.colors.ink500}
                      czId="cz_cab4"
                    />
                  </span>
                  {tab.label}
                </div>
              );
            })}
          </nav>
        )}
      </div>
    );
  },
});
