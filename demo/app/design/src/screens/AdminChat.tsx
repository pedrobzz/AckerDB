import { Icon, artboard } from "canvazz";
import { AdminFrame } from "@/components/AdminFrame";
import { ChatFab } from "@/components/ChatFab";
import { ChatSuggestion } from "@/components/ChatSuggestion";
import { ChatWindow } from "@/components/ChatWindow";
import { MetricCard } from "@/components/MetricCard";
import { ToolStepCard } from "@/components/ToolStepCard";
import { WorkspaceCard } from "@/components/WorkspaceCard";
import { theme } from "@theme";

const suggestions = [
  {
    label: "How full are we right now?",
    icon: "person.2.fill",
    tint: theme.colors.forest800,
    tintBackground: theme.colors.sage100,
  },
  {
    label: "What’s stuck in the kitchen?",
    icon: "flame.fill",
    tint: theme.colors.amber500,
    tintBackground: theme.colors.amber100,
  },
  {
    label: "Are we beating tonight’s revenue?",
    icon: "chart.line.uptrend.xyaxis",
    tint: theme.colors.sky500,
    tintBackground: theme.colors.sky100,
  },
  {
    label: "Which tables have waited longest?",
    icon: "clock.fill",
    tint: theme.colors.clay500,
    tintBackground: theme.colors.clay100,
  },
];

export const AdminChatFab = artboard({
  id: "AdminChatFab",
  width: { mode: "fixed", value: 1440 },
  height: { mode: "fixed", value: 960 },
  render: function AdminChatFab() {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }} data-cz-id="cz_cf01">
        <AdminFrame
          active="overview"
          title="Good evening, Amelia"
          subtitle="Here’s what’s happening at Savoria tonight."
          actionLabel="New order"
          showAction={true}
          body={
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }} data-cz-id="cz_cf02">
              <div style={{ display: "flex", gap: 13 }} data-cz-id="cz_cf03">
                <MetricCard
                  label="Open orders"
                  value="8"
                  detail="+2 in the last hour"
                  icon="receipt"
                  color={theme.colors.forest800}
                  background={theme.colors.sage100}
                  czId="cz_cf04"
                />
                <MetricCard
                  label="Occupied tables"
                  value="6 / 12"
                  detail="50% floor capacity"
                  icon="table.furniture"
                  color={theme.colors.clay500}
                  background={theme.colors.clay100}
                  czId="cz_cf05"
                />
                <MetricCard
                  label="Tonight’s sales"
                  value="$3,840"
                  detail="12% above average"
                  icon="chart.line.uptrend.xyaxis"
                  color={theme.colors.sky500}
                  background={theme.colors.sky100}
                  czId="cz_cf06"
                />
                <MetricCard
                  label="Avg. service time"
                  value="24 min"
                  detail="3 min faster today"
                  icon="timer"
                  color={theme.colors.violet500}
                  background={theme.colors.violet100}
                  czId="cz_cf07"
                />
              </div>
              <section
                style={{
                  padding: 22,
                  border: `1px solid ${theme.colors.line}`,
                  borderRadius: 17,
                  background: theme.colors.warmWhite,
                }}
                data-cz-id="cz_cf08"
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 11 }}
                  data-cz-id="cz_cf09"
                >
                  <span
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      background: theme.colors.forest950,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_cf0a"
                  >
                    <Icon name="sparkles" size={17} color={theme.colors.warmWhite} czId="cz_cf0b" />
                  </span>
                  <div data-cz-id="cz_cf0c">
                    <h2 style={{ margin: 0, fontSize: 16 }} data-cz-id="cz_cf0d">
                      Ask the Savoria Assistant
                    </h2>
                    <p
                      style={{ margin: "5px 0 0", color: theme.colors.ink500, fontSize: 11 }}
                      data-cz-id="cz_cf0e"
                    >
                      The floating assistant answers from live data over MCP — tap the button in the
                      bottom-right corner any time.
                    </p>
                  </div>
                </div>
              </section>
            </div>
          }
          czId="cz_cf10"
        />
        <div style={{ position: "absolute", right: 34, bottom: 30 }} data-cz-id="cz_cf11">
          <ChatFab
            label="Ask the assistant"
            icon="sparkles"
            showTooltip={true}
            showDot={true}
            czId="cz_cf12"
          />
        </div>
      </div>
    );
  },
});

export const AdminChatWindowEmpty = artboard({
  id: "AdminChatWindowEmpty",
  width: { mode: "fixed", value: 480 },
  height: { mode: "fixed", value: 700 },
  render: function AdminChatWindowEmpty() {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: 30,
          background: theme.colors.sage100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        data-cz-id="cz_ce01"
      >
        <div style={{ width: 420, height: 620 }} data-cz-id="cz_ce02">
          <ChatWindow
            title="Savoria Assistant"
            subtitle="MCP · read + operate"
            streaming={false}
            placeholder="Ask about tonight’s service…"
            body={
              <div
                style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}
                data-cz-id="cz_ce03"
              >
                <div style={{ paddingTop: 6, textAlign: "center" }} data-cz-id="cz_ce04">
                  <span
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 16,
                      background: theme.colors.forest950,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_ce05"
                  >
                    <Icon name="sparkles" size={24} color={theme.colors.warmWhite} czId="cz_ce06" />
                  </span>
                  <h2
                    style={{
                      margin: "14px 0 0",
                      fontFamily: theme.fonts.display,
                      fontSize: 22,
                      fontWeight: 600,
                    }}
                    data-cz-id="cz_ce07"
                  >
                    Good evening, Amelia
                  </h2>
                  <p
                    style={{
                      margin: "6px auto 0",
                      maxWidth: 280,
                      color: theme.colors.ink500,
                      fontSize: 11,
                      lineHeight: 1.5,
                    }}
                    data-cz-id="cz_ce08"
                  >
                    Ask anything about tonight’s floor, kitchen, and revenue. I read live data over
                    MCP.
                  </p>
                </div>
                <span
                  style={{
                    marginTop: 4,
                    color: theme.colors.ink500,
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                  data-cz-id="cz_ce09"
                >
                  Suggested questions
                </span>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  data-cz-id="cz_ce0a"
                >
                  {suggestions.map((item) => (
                    <ChatSuggestion
                      key={item.label}
                      label={item.label}
                      icon={item.icon}
                      tint={item.tint}
                      tintBackground={item.tintBackground}
                      czId="cz_ce0b"
                    />
                  ))}
                </div>
                <div
                  style={{
                    marginTop: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    color: theme.colors.ink500,
                    fontSize: 9,
                  }}
                  data-cz-id="cz_ce0c"
                >
                  <Icon name="lock.shield" size={12} color={theme.colors.ink500} czId="cz_ce0d" />
                  Answers use read-only MCP tools unless you approve an action.
                </div>
              </div>
            }
            czId="cz_ce10"
          />
        </div>
      </div>
    );
  },
});

export const AdminChatWindowStreaming = artboard({
  id: "AdminChatWindowStreaming",
  width: { mode: "fixed", value: 480 },
  height: { mode: "fixed", value: 900 },
  render: function AdminChatWindowStreaming() {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: 30,
          background: theme.colors.sage100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        data-cz-id="cz_cs01"
      >
        <div style={{ width: 420, height: 820 }} data-cz-id="cz_cs02">
          <ChatWindow
            title="Savoria Assistant"
            subtitle="Streaming · read + operate"
            streaming={true}
            placeholder="Ask a follow-up…"
            body={
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
                data-cz-id="cz_cs03"
              >
                <div style={{ display: "flex", justifyContent: "flex-end" }} data-cz-id="cz_cs04">
                  <div
                    style={{
                      maxWidth: 300,
                      padding: "10px 13px",
                      borderRadius: "14px 14px 4px 14px",
                      background: theme.colors.forest900,
                      color: theme.colors.warmWhite,
                      fontSize: 11,
                      lineHeight: 1.45,
                    }}
                    data-cz-id="cz_cs05"
                  >
                    Which tables have waited longest, and are we on pace for tonight’s revenue?
                  </div>
                </div>

                <div style={{ display: "flex", gap: 9 }} data-cz-id="cz_cs06">
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      flexShrink: 0,
                      borderRadius: 9,
                      background: theme.colors.forest950,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_cs07"
                  >
                    <Icon name="sparkles" size={13} color={theme.colors.warmWhite} czId="cz_cs08" />
                  </span>
                  <p
                    style={{
                      flex: 1,
                      margin: 0,
                      paddingTop: 4,
                      color: theme.colors.ink900,
                      fontSize: 11,
                      lineHeight: 1.55,
                    }}
                    data-cz-id="cz_cs09"
                  >
                    Let me check the kitchen queue and tonight’s open checks.
                  </p>
                </div>

                <ToolStepCard
                  tool="get_kitchen_queue"
                  summary="7 active items · 5 need attention"
                  state="done"
                  expanded={false}
                  input='{ "station": "all" }'
                  output='{ "active": 7, "needsAttention": 5 }'
                  czId="cz_cs0a"
                />

                <ToolStepCard
                  tool="get_orders"
                  summary="8 open checks · $612 in flight"
                  state="done"
                  expanded={true}
                  input='{ "status": "OPEN", "include": ["table", "total"] }'
                  output={
                    '{\n  "count": 8,\n  "openValue": 612,\n  "longestWaitMin": 12,\n  "longestWaitTable": 4\n}'
                  }
                  czId="cz_cs0b"
                />

                <WorkspaceCard
                  cwd="/data"
                  command={
                    "jq '[.orders[] | select(.status==\"PAID\") | .total] | add' orders.json"
                  }
                  output="3840"
                  state="done"
                  czId="cz_cs0c"
                />

                <ToolStepCard
                  tool="get_tables"
                  summary="Checking floor occupancy…"
                  state="running"
                  expanded={false}
                  input='{ "status": "IN USE" }'
                  output=""
                  czId="cz_cs0d"
                />

                <div style={{ display: "flex", gap: 9 }} data-cz-id="cz_cs0e">
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      flexShrink: 0,
                      borderRadius: 9,
                      background: theme.colors.forest950,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    data-cz-id="cz_cs0f"
                  >
                    <Icon name="sparkles" size={13} color={theme.colors.warmWhite} czId="cz_cs0g" />
                  </span>
                  <p
                    style={{
                      flex: 1,
                      margin: 0,
                      paddingTop: 4,
                      color: theme.colors.ink900,
                      fontSize: 11,
                      lineHeight: 1.6,
                    }}
                    data-cz-id="cz_cs0h"
                  >
                    <strong data-cz-id="cz_cs0i">Table 4</strong> (Maya) has the longest open ticket
                    —{" "}
                    <code
                      style={{
                        padding: "1px 5px",
                        borderRadius: 5,
                        background: theme.colors.cream100,
                        fontFamily: theme.fonts.mono,
                        fontSize: 10,
                      }}
                      data-cz-id="cz_cs0j"
                    >
                      Charred Tomatoes
                    </code>{" "}
                    at 12 min. Revenue is tracking 12% above target
                    <span
                      style={{
                        display: "inline-block",
                        width: 2,
                        height: 13,
                        marginLeft: 3,
                        verticalAlign: "text-bottom",
                        background: theme.colors.forest900,
                      }}
                      data-cz-id="cz_cs0k"
                    />
                  </p>
                </div>
              </div>
            }
            czId="cz_cs10"
          />
        </div>
      </div>
    );
  },
});

export const AdminChatWindowMinimized = artboard({
  id: "AdminChatWindowMinimized",
  width: { mode: "fixed", value: 420 },
  height: { mode: "fixed", value: 140 },
  render: function AdminChatWindowMinimized() {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: 20,
          background: theme.colors.sage100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        data-cz-id="cz_cm01"
      >
        <div
          style={{
            width: 344,
            padding: "11px 12px",
            borderRadius: 16,
            background: theme.colors.forest950,
            boxShadow: "0 20px 48px rgba(16, 42, 36, 0.34)",
            display: "flex",
            alignItems: "center",
            gap: 11,
          }}
          data-cz-id="cz_cm02"
        >
          <span
            style={{
              width: 34,
              height: 34,
              flexShrink: 0,
              borderRadius: 11,
              background: "rgba(255,255,255,0.10)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            data-cz-id="cz_cm03"
          >
            <Icon name="sparkles" size={16} color={theme.colors.warmWhite} czId="cz_cm04" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }} data-cz-id="cz_cm05">
            <strong
              style={{ display: "block", color: theme.colors.warmWhite, fontSize: 11 }}
              data-cz-id="cz_cm06"
            >
              Savoria Assistant
            </strong>
            <span
              style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}
              data-cz-id="cz_cm07"
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 999,
                  border: "2px solid rgba(255,255,255,0.18)",
                  borderTopColor: theme.colors.clay500,
                }}
                data-cz-id="cz_cm08"
              />
              <span style={{ color: "#9FB8AE", fontSize: 9 }} data-cz-id="cz_cm09">
                Running{" "}
                <code
                  style={{ fontFamily: theme.fonts.mono, color: "#C9D8D0", fontSize: 9 }}
                  data-cz-id="cz_cm0a"
                >
                  get_tables
                </code>{" "}
                · step 4
              </span>
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
            data-cz-id="cz_cm0b"
          >
            <Icon name="chevron.up" size={13} color="#C9D8D0" czId="cz_cm0c" />
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
            data-cz-id="cz_cm0d"
          >
            <Icon name="xmark" size={13} color="#C9D8D0" czId="cz_cm0e" />
          </button>
        </div>
      </div>
    );
  },
});
