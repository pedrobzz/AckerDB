import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const ChatFab = component({
  id: "ChatFab",
  schema: {
    label: cz.string(),
    icon: cz.string(),
    showTooltip: cz.boolean(),
    showDot: cz.boolean(),
  },
  defaultProps: {
    label: "Ask the assistant",
    icon: "sparkles",
    showTooltip: true,
    showDot: true,
  },
  render: function ChatFab({ label, icon, showTooltip, showDot }) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 11 }} data-cz-id="cz_fab1">
        {showTooltip && (
          <span
            style={{
              padding: "9px 13px",
              borderRadius: 12,
              background: theme.colors.warmWhite,
              border: `1px solid ${theme.colors.line}`,
              boxShadow: "0 12px 36px rgba(16, 42, 36, 0.18)",
              color: theme.colors.ink900,
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
            data-cz-id="cz_fab2"
          >
            {label}
          </span>
        )}
        <button
          style={{
            position: "relative",
            width: 58,
            height: 58,
            border: "none",
            borderRadius: 999,
            background: theme.colors.forest900,
            boxShadow: "0 16px 40px rgba(16, 42, 36, 0.32)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
          data-cz-id="cz_fab3"
        >
          <Icon name={icon} size={24} color={theme.colors.warmWhite} czId="cz_fab4" />
          {showDot && (
            <span
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                width: 12,
                height: 12,
                borderRadius: 999,
                background: theme.colors.clay500,
                border: `2px solid ${theme.colors.forest900}`,
              }}
              data-cz-id="cz_fab5"
            />
          )}
        </button>
      </div>
    );
  },
});
