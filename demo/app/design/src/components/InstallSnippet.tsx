import { Icon, component, cz } from "canvazz";
import { theme } from "@theme";

export const InstallSnippet = component({
  id: "InstallSnippet",
  schema: {
    client: cz.string(),
    icon: cz.string(),
    filename: cz.string(),
    language: cz.string(),
    code: cz.string(),
  },
  defaultProps: {
    client: "Claude Code",
    icon: "sparkles",
    filename: "~/.claude.json",
    language: "json",
    code: '{\n  "mcpServers": {\n    "savoria": {\n      "type": "http",\n      "url": "http://127.0.0.1:3212/mcp",\n      "headers": { "Authorization": "Bearer ${SAVORIA_MCP_TOKEN}" }\n    }\n  }\n}',
  },
  render: function InstallSnippet({ client, icon, filename, language, code }) {
    return (
      <div
        style={{
          border: `1px solid ${theme.colors.line}`,
          borderRadius: 16,
          background: theme.colors.warmWhite,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        data-cz-id="cz_ins1"
      >
        <div
          style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 11 }}
          data-cz-id="cz_ins2"
        >
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: theme.colors.forest950,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_ins3"
          >
            <Icon name={icon} size={16} color={theme.colors.warmWhite} czId="cz_ins4" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_ins5">
            <strong style={{ display: "block", fontSize: 12 }} data-cz-id="cz_ins6">
              {client}
            </strong>
            <code
              style={{ color: theme.colors.ink500, fontFamily: theme.fonts.mono, fontSize: 9 }}
              data-cz-id="cz_ins7"
            >
              {filename}
            </code>
          </div>
          <button
            style={{
              height: 30,
              padding: "0 11px",
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 9,
              background: theme.colors.warmWhite,
              color: theme.colors.forest800,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 9,
              fontWeight: 800,
              cursor: "pointer",
            }}
            data-cz-id="cz_ins8"
          >
            <Icon name="doc.on.doc" size={11} color={theme.colors.forest800} czId="cz_ins9" />
            Copy
          </button>
        </div>
        <div
          style={{
            margin: "0 14px 14px",
            borderRadius: 12,
            background: theme.colors.forest950,
            border: "1px solid #24463D",
            overflow: "hidden",
          }}
          data-cz-id="cz_insa"
        >
          <div
            style={{
              padding: "7px 12px",
              borderBottom: "1px solid #24463D",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
            data-cz-id="cz_insb"
          >
            <span
              style={{
                color: "#7E9A90",
                fontSize: 8,
                fontWeight: 800,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_insc"
            >
              {language}
            </span>
            <span style={{ display: "flex", gap: 4 }} data-cz-id="cz_insd">
              <i
                style={{ width: 7, height: 7, borderRadius: 999, background: "#3F6357" }}
                data-cz-id="cz_inse"
              />
              <i
                style={{ width: 7, height: 7, borderRadius: 999, background: "#3F6357" }}
                data-cz-id="cz_insf"
              />
              <i
                style={{ width: 7, height: 7, borderRadius: 999, background: "#3F6357" }}
                data-cz-id="cz_insg"
              />
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              padding: "12px 13px",
              color: "#EAF1EC",
              fontFamily: theme.fonts.mono,
              fontSize: 10,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
            data-cz-id="cz_insh"
          >
            {code}
          </pre>
        </div>
      </div>
    );
  },
});
