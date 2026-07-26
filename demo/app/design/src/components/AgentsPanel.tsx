import { Icon, component, cz } from "canvazz";
import { InstallSnippet } from "@/components/InstallSnippet";
import { TokenRow } from "@/components/TokenRow";
import { theme } from "@theme";

const claudeSnippet =
  '{\n  "mcpServers": {\n    "savoria": {\n      "type": "http",\n      "url": "http://127.0.0.1:3212/mcp",\n      "headers": { "Authorization": "Bearer ${SAVORIA_MCP_TOKEN}" }\n    }\n  }\n}';

const codexSnippet =
  '[mcp_servers.savoria]\nurl = "http://127.0.0.1:3212/mcp"\nbearer_token_env_var = "SAVORIA_MCP_TOKEN"';

export const AgentsPanel = component({
  id: "AgentsPanel",
  schema: {
    endpoint: cz.string(),
  },
  defaultProps: {
    endpoint: "http://127.0.0.1:3212/mcp",
  },
  render: function AgentsPanel({ endpoint }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }} data-cz-id="cz_ap01">
        <section
          style={{
            padding: 20,
            border: `1px solid ${theme.colors.line}`,
            borderRadius: 17,
            background: theme.colors.warmWhite,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
          data-cz-id="cz_ap02"
        >
          <span
            style={{
              width: 46,
              height: 46,
              borderRadius: 13,
              background: theme.colors.forest950,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_ap03"
          >
            <Icon
              name="point.3.connected.trianglepath.dotted"
              size={20}
              color={theme.colors.warmWhite}
              czId="cz_ap04"
            />
          </span>
          <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_ap05">
            <span
              style={{
                color: theme.colors.ink500,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_ap06"
            >
              Admin MCP endpoint
            </span>
            <div
              style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10 }}
              data-cz-id="cz_ap07"
            >
              <code
                style={{
                  fontFamily: theme.fonts.mono,
                  color: theme.colors.forest900,
                  fontSize: 15,
                  fontWeight: 700,
                }}
                data-cz-id="cz_ap08"
              >
                {endpoint}
              </code>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 8px",
                  borderRadius: 999,
                  background: theme.colors.sage100,
                  color: theme.colors.forest800,
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
                data-cz-id="cz_ap09"
              >
                <i
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: theme.colors.success,
                  }}
                  data-cz-id="cz_ap0a"
                />
                Live
              </span>
            </div>
            <p
              style={{ margin: "6px 0 0", color: theme.colors.ink500, fontSize: 10 }}
              data-cz-id="cz_ap0b"
            >
              Streamable HTTP · bearer-authenticated · least-privilege tool discovery per scope.
            </p>
          </div>
          <button
            style={{
              height: 38,
              padding: "0 14px",
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 11,
              background: theme.colors.warmWhite,
              color: theme.colors.forest800,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 10,
              fontWeight: 800,
              cursor: "pointer",
            }}
            data-cz-id="cz_ap0c"
          >
            <Icon name="doc.on.doc" size={12} color={theme.colors.forest800} czId="cz_ap0d" />
            Copy URL
          </button>
        </section>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          data-cz-id="cz_ap0e"
        >
          <InstallSnippet
            client="Claude Code"
            icon="sparkles"
            filename="~/.claude.json"
            language="json"
            code={claudeSnippet}
            czId="cz_ap0f"
          />
          <InstallSnippet
            client="Codex"
            icon="chevron.left.forwardslash.chevron.right"
            filename="~/.codex/config.toml"
            language="toml"
            code={codexSnippet}
            czId="cz_ap0g"
          />
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1.55fr 0.85fr", gap: 16 }}
          data-cz-id="cz_ap0h"
        >
          <section
            style={{
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 17,
              background: theme.colors.warmWhite,
              overflow: "hidden",
            }}
            data-cz-id="cz_ap0i"
          >
            <div
              style={{
                padding: "16px 16px 14px",
                borderBottom: `1px solid ${theme.colors.line}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
              data-cz-id="cz_ap0j"
            >
              <div data-cz-id="cz_ap0k">
                <h2 style={{ margin: 0, fontSize: 15 }} data-cz-id="cz_ap0l">
                  Owner tokens
                </h2>
                <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_ap0m">
                  4 active · issued by Amelia Morgan
                </span>
              </div>
              <button
                style={{
                  height: 34,
                  padding: "0 13px",
                  border: "none",
                  borderRadius: 10,
                  background: theme.colors.forest900,
                  color: theme.colors.warmWhite,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 10,
                  fontWeight: 750,
                  cursor: "pointer",
                }}
                data-cz-id="cz_ap0n"
              >
                <Icon name="plus" size={12} color={theme.colors.warmWhite} czId="cz_ap0o" />
                New token
              </button>
            </div>
            <div
              style={{
                padding: "9px 16px",
                borderBottom: `1px solid ${theme.colors.line}`,
                display: "grid",
                gridTemplateColumns: "1.5fr 1fr 0.9fr 0.9fr 78px",
                gap: 12,
                color: theme.colors.ink500,
                fontSize: 8,
                fontWeight: 800,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_ap0p"
            >
              <span data-cz-id="cz_ap0q">Name</span>
              <span data-cz-id="cz_ap0r">Scope</span>
              <span data-cz-id="cz_ap0s">Created</span>
              <span data-cz-id="cz_ap0t">Last used</span>
              <span data-cz-id="cz_ap0u" />
            </div>
            <TokenRow
              name="Amelia — Claude Code"
              preview="ackerdb_owner_••••4f2a"
              scope="operate"
              created="Jul 12, 2026"
              lastUsed="2 hours ago"
              czId="cz_ap0v"
            />
            <TokenRow
              name="Kitchen automation"
              preview="ackerdb_owner_••••9c31"
              scope="operate"
              created="Jul 9, 2026"
              lastUsed="18 min ago"
              czId="cz_ap0w"
            />
            <TokenRow
              name="Nightly revenue digest"
              preview="ackerdb_owner_••••be07"
              scope="read"
              created="Jun 30, 2026"
              lastUsed="Yesterday"
              czId="cz_ap0x"
            />
            <TokenRow
              name="Codex — floor ops"
              preview="ackerdb_owner_••••1d5a"
              scope="read"
              created="Jun 24, 2026"
              lastUsed="3 days ago"
              czId="cz_ap0y"
            />
          </section>

          <section
            style={{
              padding: 18,
              border: `1px solid ${theme.colors.line}`,
              borderRadius: 17,
              background: theme.colors.warmWhite,
              display: "flex",
              flexDirection: "column",
              gap: 13,
            }}
            data-cz-id="cz_ap0z"
          >
            <h3 style={{ margin: 0, fontSize: 13 }} data-cz-id="cz_ap10">
              About scopes
            </h3>
            <div
              style={{
                padding: 13,
                borderRadius: 13,
                background: theme.colors.sky100,
              }}
              data-cz-id="cz_ap11"
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  color: theme.colors.sky500,
                  fontSize: 10,
                  fontWeight: 800,
                }}
                data-cz-id="cz_ap12"
              >
                <Icon name="eye.fill" size={12} color={theme.colors.sky500} czId="cz_ap13" />
                Read only
              </span>
              <p
                style={{
                  margin: "6px 0 0",
                  color: theme.colors.ink700,
                  fontSize: 9,
                  lineHeight: 1.5,
                }}
                data-cz-id="cz_ap14"
              >
                Query orders, tables, the kitchen queue, and revenue. Cannot change any state.
              </p>
            </div>
            <div
              style={{
                padding: 13,
                borderRadius: 13,
                background: theme.colors.clay100,
              }}
              data-cz-id="cz_ap15"
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  color: theme.colors.clay500,
                  fontSize: 10,
                  fontWeight: 800,
                }}
                data-cz-id="cz_ap16"
              >
                <Icon
                  name="wrench.and.screwdriver.fill"
                  size={12}
                  color={theme.colors.clay500}
                  czId="cz_ap17"
                />
                Read + operate
              </span>
              <p
                style={{
                  margin: "6px 0 0",
                  color: theme.colors.ink700,
                  fontSize: 9,
                  lineHeight: 1.5,
                }}
                data-cz-id="cz_ap18"
              >
                Also advance kitchen items and cancel orders. Each write asks the host to approve.
              </p>
            </div>
            <div
              style={{
                marginTop: "auto",
                display: "flex",
                gap: 8,
                color: theme.colors.ink500,
                fontSize: 9,
                lineHeight: 1.45,
              }}
              data-cz-id="cz_ap19"
            >
              <Icon name="lock.rotation" size={13} color={theme.colors.ink500} czId="cz_ap1a" />
              Revoking a token fails its next call with HTTP 401. Secrets are shown once at
              creation.
            </div>
          </section>
        </div>
      </div>
    );
  },
});
