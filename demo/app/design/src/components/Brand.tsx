import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const Brand = component({
  id: "Brand",
  schema: {
    compact: cz.boolean(),
    inverted: cz.boolean(),
  },
  defaultProps: {
    compact: false,
    inverted: false,
  },
  render: function Brand({ compact, inverted }) {
    const foreground = inverted ? theme.colors.warmWhite : theme.colors.forest950;
    return (
      <div
        style={{ display: "flex", alignItems: "center", gap: 11, color: foreground }}
        data-cz-id="cz_18fa"
      >
        <span
          style={{
            width: compact ? 34 : 40,
            height: compact ? 34 : 40,
            borderRadius: 999,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: inverted ? theme.colors.warmWhite : theme.colors.forest900,
          }}
          data-cz-id="cz_cb9b"
        >
          <Icon
            name="fork.knife"
            size={compact ? 16 : 19}
            color={inverted ? theme.colors.forest900 : theme.colors.warmWhite}
            czId="cz_6819"
          />
        </span>
        <span
          style={{
            fontFamily: theme.fonts.display,
            fontWeight: 600,
            fontSize: compact ? 22 : 27,
            letterSpacing: "-0.035em",
          }}
          data-cz-id="cz_dc47"
        >
          Savoria
        </span>
      </div>
    );
  },
});
