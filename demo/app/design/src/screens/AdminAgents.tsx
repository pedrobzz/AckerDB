import { Icon, artboard } from "canvazz";
import { AdminFrame } from "@/components/AdminFrame";
import { AgentsPanel } from "@/components/AgentsPanel";
import { theme } from "@theme";

export const AdminAgents = artboard({
  id: "AdminAgents",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminAgents() {
    return (
      <AdminFrame
        active="agents"
        title="Agents"
        subtitle="Connect Claude Code and Codex to Savoria over MCP."
        actionLabel="Create token"
        showAction={true}
        body={<AgentsPanel endpoint="http://127.0.0.1:3212/mcp" czId="cz_ag01" />}
        czId="cz_ag02"
      />
    );
  },
});

export const AdminAgentsCreateToken = artboard({
  id: "AdminAgentsCreateToken",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminAgentsCreateToken() {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }} data-cz-id="cz_ag10">
        <AdminFrame
          active="agents"
          title="Agents"
          subtitle="Connect Claude Code and Codex to Savoria over MCP."
          actionLabel="Create token"
          showAction={true}
          body={<AgentsPanel endpoint="http://127.0.0.1:3212/mcp" czId="cz_ag11" />}
          czId="cz_ag12"
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(16,42,36,0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          data-cz-id="cz_ag13"
        >
          <div
            style={{
              width: 452,
              padding: 22,
              borderRadius: 20,
              background: theme.colors.warmWhite,
              boxShadow: "0 30px 80px rgba(16, 42, 36, 0.30)",
              fontFamily: theme.fonts.primary,
            }}
            data-cz-id="cz_ag14"
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
              data-cz-id="cz_ag15"
            >
              <div data-cz-id="cz_ag16">
                <h2
                  style={{ margin: 0, fontFamily: theme.fonts.display, fontSize: 22 }}
                  data-cz-id="cz_ag17"
                >
                  Create owner token
                </h2>
                <p
                  style={{ margin: "5px 0 0", color: theme.colors.ink500, fontSize: 10 }}
                  data-cz-id="cz_ag18"
                >
                  Name it and choose what an agent may do with it.
                </p>
              </div>
              <button
                style={{
                  width: 32,
                  height: 32,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 10,
                  background: theme.colors.warmWhite,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
                data-cz-id="cz_ag19"
              >
                <Icon name="xmark" size={13} color={theme.colors.ink700} czId="cz_ag1a" />
              </button>
            </div>

            <label
              style={{
                display: "block",
                margin: "18px 0 7px",
                color: theme.colors.ink700,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_ag1b"
            >
              Token name
            </label>
            <div
              style={{
                height: 44,
                padding: "0 13px",
                border: `1px solid ${theme.colors.forest900}`,
                borderRadius: 12,
                background: theme.colors.warmWhite,
                display: "flex",
                alignItems: "center",
                color: theme.colors.ink900,
                fontSize: 12,
              }}
              data-cz-id="cz_ag1c"
            >
              Kitchen automation
            </div>

            <span
              style={{
                display: "block",
                margin: "18px 0 8px",
                color: theme.colors.ink700,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_ag1d"
            >
              What can it do?
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }} data-cz-id="cz_ag1e">
              <div
                style={{
                  padding: 13,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 13,
                  background: theme.colors.warmWhite,
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                }}
                data-cz-id="cz_ag1f"
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: theme.colors.sky100,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_ag1g"
                >
                  <Icon name="eye.fill" size={14} color={theme.colors.sky500} czId="cz_ag1h" />
                </span>
                <div style={{ flex: 1 }} data-cz-id="cz_ag1i">
                  <strong style={{ display: "block", fontSize: 11 }} data-cz-id="cz_ag1j">
                    Read only
                  </strong>
                  <span style={{ color: theme.colors.ink500, fontSize: 9 }} data-cz-id="cz_ag1k">
                    Query live data. No writes.
                  </span>
                </div>
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    border: `2px solid ${theme.colors.line}`,
                  }}
                  data-cz-id="cz_ag1l"
                />
              </div>
              <div
                style={{
                  padding: 13,
                  border: `1.5px solid ${theme.colors.forest900}`,
                  borderRadius: 13,
                  background: theme.colors.sage100,
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                }}
                data-cz-id="cz_ag1m"
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: theme.colors.clay100,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_ag1n"
                >
                  <Icon
                    name="wrench.and.screwdriver.fill"
                    size={14}
                    color={theme.colors.clay500}
                    czId="cz_ag1o"
                  />
                </span>
                <div style={{ flex: 1 }} data-cz-id="cz_ag1p">
                  <strong style={{ display: "block", fontSize: 11 }} data-cz-id="cz_ag1q">
                    Read + operate
                  </strong>
                  <span style={{ color: theme.colors.ink700, fontSize: 9 }} data-cz-id="cz_ag1r">
                    Advance kitchen items and cancel orders, with per-action approval.
                  </span>
                </div>
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: theme.colors.forest900,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  data-cz-id="cz_ag1s"
                >
                  <Icon name="checkmark" size={11} color={theme.colors.warmWhite} czId="cz_ag1t" />
                </span>
              </div>
            </div>

            <div style={{ marginTop: 20, display: "flex", gap: 10 }} data-cz-id="cz_ag1u">
              <button
                style={{
                  flex: 1,
                  height: 44,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 12,
                  background: theme.colors.warmWhite,
                  color: theme.colors.ink700,
                  fontSize: 11,
                  fontWeight: 750,
                  cursor: "pointer",
                }}
                data-cz-id="cz_ag1v"
              >
                Cancel
              </button>
              <button
                style={{
                  flex: 1.6,
                  height: 44,
                  border: "none",
                  borderRadius: 12,
                  background: theme.colors.forest900,
                  color: theme.colors.warmWhite,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  fontSize: 11,
                  fontWeight: 750,
                  cursor: "pointer",
                }}
                data-cz-id="cz_ag1w"
              >
                <Icon name="key.fill" size={13} color={theme.colors.warmWhite} czId="cz_ag1x" />
                Create token
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
});

export const AdminAgentsSecretReveal = artboard({
  id: "AdminAgentsSecretReveal",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminAgentsSecretReveal() {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }} data-cz-id="cz_ag20">
        <AdminFrame
          active="agents"
          title="Agents"
          subtitle="Connect Claude Code and Codex to Savoria over MCP."
          actionLabel="Create token"
          showAction={true}
          body={<AgentsPanel endpoint="http://127.0.0.1:3212/mcp" czId="cz_ag21" />}
          czId="cz_ag22"
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(16,42,36,0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          data-cz-id="cz_ag23"
        >
          <div
            style={{
              width: 476,
              padding: 22,
              borderRadius: 20,
              background: theme.colors.warmWhite,
              boxShadow: "0 30px 80px rgba(16, 42, 36, 0.30)",
              fontFamily: theme.fonts.primary,
            }}
            data-cz-id="cz_ag24"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 13 }} data-cz-id="cz_ag25">
              <span
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 13,
                  background: theme.colors.sage100,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                data-cz-id="cz_ag26"
              >
                <Icon
                  name="checkmark.seal.fill"
                  size={20}
                  color={theme.colors.forest800}
                  czId="cz_ag27"
                />
              </span>
              <div style={{ flex: 1 }} data-cz-id="cz_ag28">
                <h2
                  style={{ margin: 0, fontFamily: theme.fonts.display, fontSize: 21 }}
                  data-cz-id="cz_ag29"
                >
                  Owner token created
                </h2>
                <p
                  style={{ margin: "4px 0 0", color: theme.colors.ink500, fontSize: 10 }}
                  data-cz-id="cz_ag2a"
                >
                  “Kitchen automation” · Read + operate
                </p>
              </div>
            </div>

            <div
              style={{
                marginTop: 18,
                padding: "12px 13px",
                borderRadius: 13,
                background: theme.colors.amber100,
                display: "flex",
                gap: 10,
              }}
              data-cz-id="cz_ag2b"
            >
              <Icon
                name="exclamationmark.triangle.fill"
                size={15}
                color={theme.colors.amber500}
                czId="cz_ag2c"
              />
              <div data-cz-id="cz_ag2d">
                <strong
                  style={{ display: "block", color: theme.colors.amber500, fontSize: 10 }}
                  data-cz-id="cz_ag2e"
                >
                  Copy this secret now
                </strong>
                <span
                  style={{
                    display: "block",
                    marginTop: 3,
                    color: theme.colors.ink700,
                    fontSize: 9,
                    lineHeight: 1.5,
                  }}
                  data-cz-id="cz_ag2f"
                >
                  Savoria stores only a hash. It cannot be shown again — if you lose it, revoke this
                  token and create a new one.
                </span>
              </div>
            </div>

            <span
              style={{
                display: "block",
                margin: "16px 0 7px",
                color: theme.colors.ink700,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
              data-cz-id="cz_ag2g"
            >
              Secret token
            </span>
            <div
              style={{
                padding: "13px 14px",
                borderRadius: 13,
                background: theme.colors.forest950,
                border: "1px solid #24463D",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
              data-cz-id="cz_ag2h"
            >
              <code
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: "#EAF1EC",
                  fontFamily: theme.fonts.mono,
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
                data-cz-id="cz_ag2i"
              >
                dbzz_owner_f2a9c7e41b0d8836a5140f7c9e2b6d33
              </code>
              <button
                style={{
                  height: 36,
                  padding: "0 13px",
                  border: "none",
                  borderRadius: 10,
                  background: theme.colors.clay500,
                  color: theme.colors.warmWhite,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 10,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
                data-cz-id="cz_ag2j"
              >
                <Icon
                  name="doc.on.doc.fill"
                  size={12}
                  color={theme.colors.warmWhite}
                  czId="cz_ag2k"
                />
                Copy
              </button>
            </div>
            <div
              style={{
                marginTop: 9,
                display: "flex",
                alignItems: "center",
                gap: 7,
                color: theme.colors.ink500,
                fontSize: 9,
              }}
              data-cz-id="cz_ag2l"
            >
              <Icon name="terminal" size={12} color={theme.colors.ink500} czId="cz_ag2m" />
              Set it as{" "}
              <code
                style={{ fontFamily: theme.fonts.mono, color: theme.colors.forest800, fontSize: 9 }}
                data-cz-id="cz_ag2n"
              >
                SAVORIA_MCP_TOKEN
              </code>{" "}
              for the install snippet above.
            </div>

            <button
              style={{
                marginTop: 20,
                width: "100%",
                height: 44,
                border: "none",
                borderRadius: 12,
                background: theme.colors.forest900,
                color: theme.colors.warmWhite,
                fontSize: 11,
                fontWeight: 750,
                cursor: "pointer",
              }}
              data-cz-id="cz_ag2o"
            >
              I’ve stored it — done
            </button>
          </div>
        </div>
      </div>
    );
  },
});
