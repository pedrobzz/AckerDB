import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const TokenRow = component({
  id: "TokenRow",
  schema: {
    name: cz.string(),
    preview: cz.string(),
    scope: cz.enum(["read", "operate"]),
    created: cz.string(),
    lastUsed: cz.string(),
  },
  defaultProps: {
    name: "Amelia — Claude Code",
    preview: "dbzz_owner_••••4f2a",
    scope: "operate",
    created: "Jul 12, 2026",
    lastUsed: "2 hours ago",
  },
  render: function TokenRow({ name, preview, scope, created, lastUsed }) {
    const operate = scope === "operate";
    return (
      <div
        style={{
          padding: "13px 16px",
          borderBottom: `1px solid ${theme.colors.line}`,
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr 0.9fr 0.9fr 78px",
          alignItems: "center",
          gap: 12,
        }}
        data-cz-id="cz_tok1"
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}
          data-cz-id="cz_tok2"
        >
          <span
            style={{
              width: 34,
              height: 34,
              flexShrink: 0,
              borderRadius: 10,
              background: theme.colors.cream100,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_tok3"
          >
            <Icon name="key.fill" size={14} color={theme.colors.forest800} czId="cz_tok4" />
          </span>
          <div style={{ minWidth: 0 }} data-cz-id="cz_tok5">
            <strong style={{ display: "block", fontSize: 11 }} data-cz-id="cz_tok6">
              {name}
            </strong>
            <code
              style={{ color: theme.colors.ink500, fontFamily: theme.fonts.mono, fontSize: 9 }}
              data-cz-id="cz_tok7"
            >
              {preview}
            </code>
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            width: "fit-content",
            padding: "5px 9px",
            borderRadius: 999,
            background: operate ? theme.colors.clay100 : theme.colors.sky100,
            color: operate ? theme.colors.clay500 : theme.colors.sky500,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
          data-cz-id="cz_tok8"
        >
          <Icon
            name={operate ? "wrench.and.screwdriver.fill" : "eye.fill"}
            size={10}
            color={operate ? theme.colors.clay500 : theme.colors.sky500}
            czId="cz_tok9"
          />
          {operate ? "Read + operate" : "Read only"}
        </span>
        <span style={{ color: theme.colors.ink700, fontSize: 10 }} data-cz-id="cz_toka">
          {created}
        </span>
        <span style={{ color: theme.colors.ink500, fontSize: 10 }} data-cz-id="cz_tokb">
          {lastUsed}
        </span>
        <button
          style={{
            height: 30,
            border: `1px solid ${theme.colors.line}`,
            borderRadius: 9,
            background: theme.colors.warmWhite,
            color: theme.colors.rose500,
            fontSize: 9,
            fontWeight: 800,
            cursor: "pointer",
          }}
          data-cz-id="cz_tokc"
        >
          Revoke
        </button>
      </div>
    );
  },
});
