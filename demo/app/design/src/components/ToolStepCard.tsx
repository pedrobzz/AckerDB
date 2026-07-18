import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const ToolStepCard = component({
  id: "ToolStepCard",
  schema: {
    tool: cz.string(),
    summary: cz.string(),
    state: cz.enum(["done", "running"]),
    expanded: cz.boolean(),
    input: cz.string(),
    output: cz.string(),
  },
  defaultProps: {
    tool: "get_orders",
    summary: "8 open checks · $612 in flight",
    state: "done",
    expanded: false,
    input: '{ "status": "OPEN" }',
    output: '{ "count": 8, "value": 612 }',
  },
  render: function ToolStepCard({ tool, summary, state, expanded, input, output }) {
    const running = state === "running";
    return (
      <div
        style={{
          border: `1px solid ${running ? theme.colors.sage500 : theme.colors.line}`,
          borderRadius: 13,
          background: theme.colors.warmWhite,
          overflow: "hidden",
        }}
        data-cz-id="cz_stp1"
      >
        <div
          style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}
          data-cz-id="cz_stp2"
        >
          <span
            style={{
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: 9,
              background: theme.colors.sage100,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_stp3"
          >
            {running ? (
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  border: `2px solid ${theme.colors.sage200}`,
                  borderTopColor: theme.colors.forest800,
                }}
                data-cz-id="cz_stp4"
              />
            ) : (
              <Icon name="curlybraces" size={13} color={theme.colors.forest800} czId="cz_stp5" />
            )}
          </span>
          <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_stp6">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }} data-cz-id="cz_stp7">
              <span
                style={{
                  color: theme.colors.ink500,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                }}
                data-cz-id="cz_stp8"
              >
                {running ? "Running" : "Queried"}
              </span>
              <code
                style={{
                  fontFamily: theme.fonts.mono,
                  color: theme.colors.forest900,
                  fontSize: 10,
                  fontWeight: 700,
                }}
                data-cz-id="cz_stp9"
              >
                {tool}
              </code>
            </div>
            <span
              style={{
                display: "block",
                marginTop: 2,
                color: theme.colors.ink700,
                fontSize: 10,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              data-cz-id="cz_stpa"
            >
              {summary}
            </span>
          </div>
          {running ? (
            <span
              style={{
                color: theme.colors.forest800,
                fontSize: 9,
                fontWeight: 750,
                whiteSpace: "nowrap",
              }}
              data-cz-id="cz_stpb"
            >
              Working…
            </span>
          ) : (
            <span
              style={{
                width: 24,
                height: 24,
                flexShrink: 0,
                borderRadius: 8,
                background: theme.colors.cream100,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              data-cz-id="cz_stpc"
            >
              <Icon
                name={expanded ? "chevron.up" : "chevron.down"}
                size={11}
                color={theme.colors.ink500}
                czId="cz_stpd"
              />
            </span>
          )}
        </div>

        {expanded && !running && (
          <div
            style={{
              padding: "0 12px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 9,
            }}
            data-cz-id="cz_stpe"
          >
            <div data-cz-id="cz_stpf">
              <span
                style={{
                  display: "block",
                  marginBottom: 5,
                  color: theme.colors.ink500,
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
                data-cz-id="cz_stpg"
              >
                Input
              </span>
              <pre
                style={{
                  margin: 0,
                  padding: "9px 11px",
                  borderRadius: 10,
                  background: theme.colors.cream100,
                  border: `1px solid ${theme.colors.line}`,
                  color: theme.colors.ink700,
                  fontFamily: theme.fonts.mono,
                  fontSize: 10,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
                data-cz-id="cz_stph"
              >
                {input}
              </pre>
            </div>
            <div data-cz-id="cz_stpi">
              <span
                style={{
                  display: "block",
                  marginBottom: 5,
                  color: theme.colors.ink500,
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
                data-cz-id="cz_stpj"
              >
                Output
              </span>
              <pre
                style={{
                  margin: 0,
                  padding: "9px 11px",
                  borderRadius: 10,
                  background: theme.colors.cream100,
                  border: `1px solid ${theme.colors.line}`,
                  color: theme.colors.ink700,
                  fontFamily: theme.fonts.mono,
                  fontSize: 10,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
                data-cz-id="cz_stpk"
              >
                {output}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  },
});
