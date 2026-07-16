import { Icon, component, cz, staticAsset } from "canvazz";
import { theme } from "@theme";

export const MenuItemCard = component({
  id: "MenuItemCard",
  schema: {
    name: cz.string(),
    description: cz.string(),
    price: cz.string(),
    image: cz.string(),
    compact: cz.boolean(),
  },
  defaultProps: {
    name: "Grilled Sea Bass",
    description: "Spring peas, asparagus, lemon beurre blanc",
    price: "$34",
    image: "menu/grilled-sea-bass.png",
    compact: false,
  },
  render: function MenuItemCard({ name, description, price, image, compact }) {
    return (
      <article
        style={{
          minWidth: 0,
          border: `1px solid ${theme.colors.line}`,
          borderRadius: compact ? 14 : 18,
          overflow: "hidden",
          background: theme.colors.warmWhite,
          display: compact ? "flex" : "block",
        }}
        data-cz-id="cz_e627"
      >
        <img
          src={staticAsset(image)}
          alt={name}
          style={{
            width: compact ? 94 : "100%",
            height: compact ? 94 : 128,
            flexShrink: 0,
            objectFit: "cover",
            display: "block",
            background: theme.colors.cream100,
          }}
          data-cz-id="cz_3aa5"
        />
        <div
          style={{
            padding: compact ? "13px 13px" : "14px 15px 15px",
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
          data-cz-id="cz_ea91"
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 10,
            }}
            data-cz-id="cz_b1ca"
          >
            <strong
              style={{ color: theme.colors.ink900, fontSize: compact ? 12 : 13, lineHeight: 1.25 }}
              data-cz-id="cz_b8b2"
            >
              {name}
            </strong>
            <span
              style={{ color: theme.colors.forest900, fontSize: 12, fontWeight: 800 }}
              data-cz-id="cz_00a5"
            >
              {price}
            </span>
          </div>
          <p
            style={{
              margin: "6px 0 0",
              color: theme.colors.ink500,
              fontSize: compact ? 9 : 10,
              lineHeight: 1.45,
            }}
            data-cz-id="cz_a0dc"
          >
            {description}
          </p>
          {!compact && (
            <button
              style={{
                marginTop: 12,
                width: 31,
                height: 31,
                borderRadius: 10,
                border: "none",
                background: theme.colors.forest900,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                alignSelf: "flex-end",
              }}
              data-cz-id="cz_6c63"
            >
              <Icon name="plus" size={13} color="#FFFFFF" czId="cz_54e9" />
            </button>
          )}
        </div>
      </article>
    );
  },
});
