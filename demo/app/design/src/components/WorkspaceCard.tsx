import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const WorkspaceCard = component({
  id: "WorkspaceCard",
  schema: {
    cwd: cz.string(),
    command: cz.string(),
    output: cz.string(),
    state: cz.enum(["done", "running"]),
  },
  defaultProps: {
    cwd: "/data",
    command: "jq '[.orders[] | select(.status==\"OPEN\") | .total] | add' orders.json",
    output: "612",
    state: "done",
  },
  render: function WorkspaceCard({ cwd, command, output, state }) {
    const running = state === "running";
    return (
      <div
        style={{
          borderRadius: 13,
          background: theme.colors.forest950,
          border: "1px solid #24463D",
          overflow: "hidden",
        }}
        data-cz-id="cz_wsp1"
      >
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #24463D",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
          data-cz-id="cz_wsp2"
        >
          <Icon name="terminal" size={12} color="#9FB8AE" czId="cz_wsp3" />
          <span
            style={{
              color: "#C9D8D0",
              fontSize: 9,
              fontWeight: 750,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
            data-cz-id="cz_wsp4"
          >
            Bash
          </span>
          <code
            style={{ fontFamily: theme.fonts.mono, color: "#7E9A90", fontSize: 9 }}
            data-cz-id="cz_wsp5"
          >
            {cwd}
          </code>
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: running ? "#E6C77A" : "#8FB6A2",
              fontSize: 8,
              fontWeight: 750,
            }}
            data-cz-id="cz_wsp6"
          >
            {running ? (
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 999,
                  border: "2px solid rgba(255,255,255,0.18)",
                  borderTopColor: "#E6C77A",
                }}
                data-cz-id="cz_wsp7"
              />
            ) : (
              <Icon name="checkmark" size={10} color="#8FB6A2" czId="cz_wsp8" />
            )}
            {running ? "running" : "exit 0"}
          </span>
        </div>
        <div style={{ padding: "10px 12px" }} data-cz-id="cz_wsp9">
          <div style={{ display: "flex", gap: 8 }} data-cz-id="cz_wspa">
            <span
              style={{ color: theme.colors.success, fontFamily: theme.fonts.mono, fontSize: 10 }}
              data-cz-id="cz_wspb"
            >
              $
            </span>
            <code
              style={{
                flex: 1,
                minWidth: 0,
                color: "#EAF1EC",
                fontFamily: theme.fonts.mono,
                fontSize: 10,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
              data-cz-id="cz_wspc"
            >
              {command}
            </code>
          </div>
          <div
            style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}
            data-cz-id="cz_wspd"
          >
            <span style={{ width: 8 }} data-cz-id="cz_wspe" />
            {running ? (
              <span
                style={{
                  width: 7,
                  height: 14,
                  background: "#EAF1EC",
                  opacity: 0.7,
                }}
                data-cz-id="cz_wspf"
              />
            ) : (
              <code
                style={{
                  color: "#9FB8AE",
                  fontFamily: theme.fonts.mono,
                  fontSize: 10,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
                data-cz-id="cz_wspg"
              >
                {output}
              </code>
            )}
          </div>
        </div>
      </div>
    );
  },
});
