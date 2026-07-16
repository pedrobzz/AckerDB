import { component, cz } from "canvazz";

export const StatusPill = component({
  id: "StatusPill",
  schema: {
    label: cz.string().max(24),
    color: cz.color(),
    background: cz.color(),
    dot: cz.boolean(),
  },
  defaultProps: {
    label: "Open",
    color: "#1E4A3E",
    background: "#DDE8DD",
    dot: true,
  },
  render: function StatusPill({ label, color, background, dot }) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: "fit-content",
          padding: "5px 9px",
          borderRadius: 999,
          background,
          color,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.055em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        }}
        data-cz-id="cz_d101"
      >
        {dot && (
          <span
            style={{ width: 6, height: 6, borderRadius: 999, background: color }}
            data-cz-id="cz_1e8d"
          />
        )}
        {label}
      </span>
    );
  },
});
