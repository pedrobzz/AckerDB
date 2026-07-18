import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const ChatSuggestion = component({
  id: "ChatSuggestion",
  schema: {
    label: cz.string(),
    icon: cz.string(),
    tint: cz.color(),
    tintBackground: cz.color(),
  },
  defaultProps: {
    label: "How full are we right now?",
    icon: "person.2",
    tint: "#1E4A3E",
    tintBackground: "#ECF2EC",
  },
  render: function ChatSuggestion({ label, icon, tint, tintBackground }) {
    return (
      <button
        style={{
          width: "100%",
          padding: "11px 12px",
          border: `1px solid ${theme.colors.line}`,
          borderRadius: 13,
          background: theme.colors.warmWhite,
          display: "flex",
          alignItems: "center",
          gap: 11,
          textAlign: "left",
          cursor: "pointer",
        }}
        data-cz-id="cz_sug1"
      >
        <span
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            borderRadius: 10,
            background: tintBackground,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          data-cz-id="cz_sug2"
        >
          <Icon name={icon} size={14} color={tint} czId="cz_sug3" />
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: theme.colors.ink900,
            fontSize: 11,
            fontWeight: 600,
          }}
          data-cz-id="cz_sug4"
        >
          {label}
        </span>
        <Icon name="arrow.up.right" size={12} color={theme.colors.ink300} czId="cz_sug5" />
      </button>
    );
  },
});
