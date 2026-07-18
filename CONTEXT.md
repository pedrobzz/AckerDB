# CONTEXT

Glossary of domain terms. Definitions only — no implementation details.

## Framework runtime

**Execution root** — The execution context a runtime subsystem owns and runs
its work under when that work is performed on its own behalf rather than a
caller's — e.g. the reactive system re-evaluating subscriptions for
subscribers. Work a caller triggers never carries the caller's context into
another subsystem's execution root; anything that must cross a scheduling
boundary crosses explicitly.

**Subscriber-facing work** — Runtime work that executes application code on
behalf of a subscriber (re-running a subscribed query, matching an event
listener). Always runs under the reactive system's execution root, under the
subscriber's own principal — never under the identity or context of whoever
triggered it.

## Demo app (Savoria restaurant)

**Admin MCP** — The demo backend's single MCP endpoint. Isolated and staff-only:
it exposes the restaurant's business data and exactly two staff actions. Both
the in-app Admin Chat and external agent hosts (Codex, Claude Code) consume the
*same* Admin MCP with the same capability surface; what a caller may do is
decided by the authority attached to its credential, never by which consumer it
is. A future guest/mobile MCP would be a separate named endpoint, not an
extension of this one.

**Admin Chat** — The staff-facing conversational assistant embedded in the
Admin Panel. Answers open-ended questions about the live business (occupancy,
kitchen queue, revenue, waiting times) and can perform the two staff actions.
All of its data access goes through the Admin MCP's tools — it has no private
side-channel to the database.

**Action tool** — One of exactly two mutating tools on the Admin MCP: advance a
kitchen item's status, and cancel an open order. Every other tool is read-only.

**Entity query tool** — A typed read-only tool exposing one entity collection
through simple query-shaped arguments (filters, limits) — e.g. dishes, tables,
orders. Deliberately basic: it answers direct lookups, never analytics. Exists
so a small model can answer simple questions without composing pipelines.

**Bash workspace** — The Admin MCP's open-ended read tool: a sandboxed shell
whose files are the restaurant's live data rendered as JSONL, materialized
fresh at call time and discarded afterwards (never stored, therefore never
stale). Exists so a capable model can answer arbitrary analytical questions
the entity query tools never anticipated.

**Owner token** — An identity-bound bearer credential a staff member issues to
let an external agent host call the Admin MCP. Its scopes decide read-only vs
read+mutate. The secret is revealed exactly once at issuance.

**`read` / `operate`** — The Admin MCP's only two scopes. `read` grants every
read-only tool (entity query tools and the bash workspace); `operate` grants
the two action tools. The in-app Admin Chat always holds both; an owner token
holds whatever was chosen at issuance.

**Agents page** — The Admin Panel section where staff connect external agents:
it shows the Admin MCP's endpoint and install configuration and manages owner
tokens (issue, scope, revoke).
