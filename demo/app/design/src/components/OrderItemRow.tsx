import { component, cz } from "canvazz";
import { StatusPill } from "@/components/StatusPill";
import { theme } from "@theme";

export const OrderItemRow = component({
  id: "OrderItemRow",
  schema: {
    quantity: cz.string(),
    name: cz.string(),
    detail: cz.string(),
    price: cz.string(),
    status: cz.string(),
    statusColor: cz.color(),
    statusBackground: cz.color(),
  },
  defaultProps: {
    quantity: "1×",
    name: "Grilled Sea Bass",
    detail: "No substitutions",
    price: "$34",
    status: "Preparing",
    statusColor: "#8C5A0D",
    statusBackground: "#F9ECD6",
  },
  render: function OrderItemRow({
    quantity,
    name,
    detail,
    price,
    status,
    statusColor,
    statusBackground,
  }) {
    return (
      <div
        style={{
          padding: "13px 0",
          borderBottom: `1px solid ${theme.colors.line}`,
          display: "flex",
          alignItems: "center",
          gap: 11,
        }}
        data-cz-id="cz_b896"
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 10,
            background: theme.colors.cream100,
            color: theme.colors.forest900,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            fontWeight: 800,
          }}
          data-cz-id="cz_8593"
        >
          {quantity}
        </span>
        <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_7162">
          <strong
            style={{ display: "block", color: theme.colors.ink900, fontSize: 11 }}
            data-cz-id="cz_d14b"
          >
            {name}
          </strong>
          <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_b85d">
            {detail}
          </span>
        </div>
        <StatusPill
          label={status}
          color={statusColor}
          background={statusBackground}
          dot={true}
          czId="cz_f32c"
        />
        <strong
          style={{ width: 38, color: theme.colors.ink900, fontSize: 11, textAlign: "right" }}
          data-cz-id="cz_b499"
        >
          {price}
        </strong>
      </div>
    );
  },
});
