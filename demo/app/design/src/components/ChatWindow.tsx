import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const ChatWindow = component({
  id: "ChatWindow",
  schema: {
    title: cz.string(),
    subtitle: cz.string(),
    streaming: cz.boolean(),
    placeholder: cz.string(),
    body: cz.slot(),
  },
  defaultProps: {
    title: "Savoria Assistant",
    subtitle: "MCP · read + operate",
    streaming: false,
    placeholder: "Ask about tonight’s service…",
    body: null,
  },
  render: function ChatWindow({ title, subtitle, streaming, placeholder, body }) {
    return (
      <div
        style={{
          position: "relative",
          width: 420,
          height: "100%",
          minHeight: 0,
          background: theme.colors.warmWhite,
          border: `1px solid ${theme.colors.line}`,
          borderRadius: 20,
          boxShadow: "0 28px 70px rgba(16, 42, 36, 0.28)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          fontFamily: theme.fonts.primary,
        }}
        data-cz-id="cz_win1"
      >
        <header
          style={{
            padding: "13px 15px",
            background: theme.colors.forest950,
            color: theme.colors.warmWhite,
            display: "flex",
            alignItems: "center",
            gap: 11,
            cursor: "grab",
          }}
          data-cz-id="cz_win2"
        >
          <span
            style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}
            data-cz-id="cz_win3"
          >
            <span
              style={{ width: 13, height: 2, borderRadius: 999, background: "#3F6357" }}
              data-cz-id="cz_win4"
            />
            <span
              style={{ width: 13, height: 2, borderRadius: 999, background: "#3F6357" }}
              data-cz-id="cz_win5"
            />
          </span>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 11,
              background: "rgba(255,255,255,0.10)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_win6"
          >
            <Icon name="sparkles" size={16} color={theme.colors.warmWhite} czId="cz_win7" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_win8">
            <strong style={{ display: "block", fontSize: 12 }} data-cz-id="cz_win9">
              {title}
            </strong>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "#9FB8AE",
                fontSize: 9,
              }}
              data-cz-id="cz_wina"
            >
              <i
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: theme.colors.success,
                }}
                data-cz-id="cz_winb"
              />
              {subtitle}
            </span>
          </div>
          <button
            style={{
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 9,
              background: "rgba(255,255,255,0.08)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
            data-cz-id="cz_winc"
          >
            <Icon name="arrow.counterclockwise" size={13} color="#C9D8D0" czId="cz_wind" />
          </button>
          <button
            style={{
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 9,
              background: "rgba(255,255,255,0.08)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
            data-cz-id="cz_wine"
          >
            <Icon name="minus" size={14} color="#C9D8D0" czId="cz_winf" />
          </button>
          <button
            style={{
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 9,
              background: "rgba(255,255,255,0.08)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
            data-cz-id="cz_wing"
          >
            <Icon name="xmark" size={13} color="#C9D8D0" czId="cz_winh" />
          </button>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: "16px 15px",
            background: theme.colors.cream50,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
          data-cz-id="cz_wini"
        >
          {body}
        </div>

        <footer
          style={{
            padding: "12px 15px 14px",
            borderTop: `1px solid ${theme.colors.line}`,
            background: theme.colors.warmWhite,
          }}
          data-cz-id="cz_winj"
        >
          {streaming && (
            <button
              style={{
                width: "100%",
                height: 34,
                marginBottom: 10,
                border: `1px solid ${theme.colors.line}`,
                borderRadius: 11,
                background: theme.colors.cream100,
                color: theme.colors.ink700,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                fontSize: 10,
                fontWeight: 750,
                cursor: "pointer",
              }}
              data-cz-id="cz_wink"
            >
              <Icon name="stop.fill" size={11} color={theme.colors.rose500} czId="cz_winl" />
              Stop generating
            </button>
          )}
          <div
            style={{
              height: 46,
              padding: "0 8px 0 14px",
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 14,
              background: theme.colors.cream50,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            data-cz-id="cz_winm"
          >
            <span
              style={{ flex: 1, color: theme.colors.ink500, fontSize: 11 }}
              data-cz-id="cz_winn"
            >
              {placeholder}
            </span>
            <button
              style={{
                width: 34,
                height: 34,
                border: "none",
                borderRadius: 11,
                background: streaming ? theme.colors.ink300 : theme.colors.forest900,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
              data-cz-id="cz_wino"
            >
              <Icon
                name={streaming ? "stop.fill" : "arrow.up"}
                size={14}
                color={theme.colors.warmWhite}
                czId="cz_winp"
              />
            </button>
          </div>
        </footer>

        <span
          style={{
            position: "absolute",
            right: 4,
            bottom: 4,
            width: 16,
            height: 16,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.colors.ink300,
            cursor: "nwse-resize",
          }}
          data-cz-id="cz_winq"
        >
          <Icon
            name="arrow.down.right.and.arrow.up.left"
            size={12}
            color={theme.colors.ink300}
            czId="cz_winr"
          />
        </span>
      </div>
    );
  },
});
