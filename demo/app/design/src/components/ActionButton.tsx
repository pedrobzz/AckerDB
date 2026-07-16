import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const ActionButton = component({
  id: "ActionButton",
  schema: {
    label: cz.string().max(40),
    icon: cz.string(),
    variant: cz.enum(["primary", "secondary", "danger", "dark"]),
    fullWidth: cz.boolean(),
  },
  defaultProps: {
    label: "Continue",
    icon: "arrow.right",
    variant: "primary",
    fullWidth: false,
  },
  render: function ActionButton({ label, icon, variant, fullWidth }) {
    const background =
      variant === "primary"
        ? theme.colors.clay500
        : variant === "danger"
          ? theme.colors.rose100
          : variant === "dark"
            ? theme.colors.forest900
            : theme.colors.warmWhite;
    const color =
      variant === "danger"
        ? theme.colors.rose500
        : variant === "secondary"
          ? theme.colors.ink700
          : theme.colors.warmWhite;
    return (
      <button
        style={{
          width: fullWidth ? "100%" : "fit-content",
          height: 46,
          border: variant === "secondary" ? `1px solid ${theme.colors.line}` : "none",
          borderRadius: 13,
          background,
          color,
          padding: "0 17px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          fontFamily: theme.fonts.primary,
          fontSize: 13,
          fontWeight: 750,
          cursor: "pointer",
        }}
        data-cz-id="cz_f6b7"
      >
        {label}
        {icon.length > 0 && <Icon name={icon} size={14} color={color} czId="cz_edd6" />}
      </button>
    );
  },
});
