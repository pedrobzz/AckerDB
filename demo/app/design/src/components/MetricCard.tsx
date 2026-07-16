import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const MetricCard = component({
  id: "MetricCard",
  schema: {
    label: cz.string(),
    value: cz.string(),
    detail: cz.string(),
    icon: cz.string(),
    color: cz.color(),
    background: cz.color(),
  },
  defaultProps: {
    label: "Open orders",
    value: "8",
    detail: "+2 in the last hour",
    icon: "receipt",
    color: "#1E4A3E",
    background: "#ECF2EC",
  },
  render: function MetricCard({ label, value, detail, icon, color, background }) {
    return (
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: 20,
          border: `1px solid ${theme.colors.line}`,
          borderRadius: 16,
          background: theme.colors.warmWhite,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        data-cz-id="cz_8fc5"
      >
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
          data-cz-id="cz_8e16"
        >
          <span
            style={{ color: theme.colors.ink500, fontSize: 12, fontWeight: 650 }}
            data-cz-id="cz_1b06"
          >
            {label}
          </span>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 11,
              background,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_fac1"
          >
            <Icon name={icon} size={16} color={color} czId="cz_75a4" />
          </span>
        </div>
        <div data-cz-id="cz_c307">
          <strong
            style={{
              display: "block",
              color: theme.colors.ink900,
              fontSize: 27,
              letterSpacing: "-0.04em",
            }}
            data-cz-id="cz_b8d7"
          >
            {value}
          </strong>
          <span style={{ color, fontSize: 11, fontWeight: 650 }} data-cz-id="cz_49c9">
            {detail}
          </span>
        </div>
      </div>
    );
  },
});
