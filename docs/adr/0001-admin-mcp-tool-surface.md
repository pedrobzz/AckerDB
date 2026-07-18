# Admin MCP tool surface: entity query tools + a bash workspace, no analytics tools

The demo's Admin MCP must answer "anything about the business" for two very
different consumers: a small non-reasoning model (the in-app Admin Chat) and
strong agent hosts (Codex, Claude Code) — over the *same* single endpoint. We
decided the read surface is exactly two shapes: **per-entity query tools**
(`get_tables`, `get_orders`, … — plain filters and limits, one per entity, no
aggregation) and **one bash workspace tool** (a sandboxed just-bash shell whose
files are the live data rendered as JSONL, materialized fresh at call time and
discarded after — never stored, therefore never stale). Mutations are two
dedicated action tools (`advance_kitchen_item`, `cancel_order`) behind the
`operate` scope; reads sit behind `read`.

## Considered options

- **Pre-baked analytics tools** (revenue-per-dish, median-wait, …): rejected —
  it is the most code, and it caps "ask anything" at whatever we anticipated;
  every unanticipated question is a new tool.
- **Bash workspace only**: rejected — least code, but simple lookups then force
  a small model to author jq/awk pipelines it can't reliably write.
- **Broad `get_overview`-style tools**: rejected — too coarse to compose;
  entity-level queries are the primitive both model classes can use directly.

## Consequences

Simple questions resolve through typed tools (safe for small models, and they
exercise dbzz's typed structured MCP output); arbitrary analytics resolve
through pipelines a capable model writes in the workspace. The tool list is a
public contract external agents depend on — additions are cheap, but renaming
or removing tools breaks installed hosts.
