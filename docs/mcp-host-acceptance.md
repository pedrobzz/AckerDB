# MCP host acceptance

This is the reproducible HITL release gate for AckerDB's two motivating external
hosts. It tests real installed Codex and Claude Code clients against the same
Streamable HTTP endpoint built only from freshly packed `@ackerdb/*` tarballs.
It is intentionally separate from protocol conformance: the gate proves host
configuration and behavior, while conformance proves the protocol surface.

## Run

Install and authenticate both CLIs, then run from the repository root:

```sh
bun run test:mcp:hosts
```

The gate uses `codex` and `claude` from `PATH`. It packs and installs all five
lockstep AckerDB tarballs in a clean temporary consumer, starts its fixture on an
ephemeral loopback port, and creates separate Identity-bound tokens for the two
hosts. The fixture and consumer are deleted after the run. Model access from
the installed hosts is required, so this command is not part of the unattended
`bun run test` gate.

The equivalent protected-host configuration is:

```sh
export ACKERDB_MCP_TOKEN='<ephemeral bearer token>'

codex exec --ignore-user-config --ephemeral --skip-git-repo-check \
  --sandbox read-only --json \
  --config 'mcp_servers.ackerdb.url="http://127.0.0.1:3211/mcp"' \
  --config 'mcp_servers.ackerdb.bearer_token_env_var="ACKERDB_MCP_TOKEN"' \
  --config 'mcp_servers.ackerdb.default_tools_approval_mode="approve"' \
  'Call the AckerDB MCP tool.'

claude 'Call the AckerDB MCP tool.' --print --no-session-persistence \
  --output-format stream-json --verbose --permission-mode bypassPermissions \
  --strict-mcp-config --mcp-config \
  '{"mcpServers":{"ackerdb":{"type":"http","url":"http://127.0.0.1:3211/mcp","headers":{"Authorization":"Bearer ${ACKERDB_MCP_TOKEN}"}}}}'
```

The acceptance script additionally restricts each host to the fixture's exact
MCP tool names. These examples contain placeholders only; the repository never
writes a bearer token, provider credential, host account secret, or generated
host configuration containing a secret.

## Assertions

Each host runs three fresh sessions against one endpoint and its own token:

| Phase | Required evidence |
| --- | --- |
| Anonymous | `initialize` returns the instruction marker; `tools/list` contains only `public_text`; the public call succeeds without a credential. |
| Read scope | Discovery exactly matches the seven public/read/authenticated tools; the model returns the marker available only in initialization instructions; public, authenticated, validated structured, embedded-resource, and resource-link calls succeed. |
| Authority transitions | `admin_only` first succeeds; after an in-run scope reduction it returns HTTP 403; an authenticated call succeeds; after in-run revocation the next authenticated call returns HTTP 401. |

A protocol-transparent loopback recorder observes the exact HTTP/JSON-RPC
traffic without replacing the packaged AckerDB endpoint. It commits the scope and
revocation mutations after checkpoint responses and before the host receives
them. After each host phase, a FIFO fixture marker ensures every preceding
server event has been consumed before server-side counters prove that neither
denied handler executes.
The host output is parsed as JSONL rather than accepted by model prose:

- Codex emits each denial as `item.completed` with
  `item.type: "mcp_tool_call"` and `item.status: "failed"`.
- Claude Code emits each denial as a `tool_result` block with
  `is_error: true`, correlated by `tool_use_id` to the expected MCP `tool_use`.

## Recorded run

The release-candidate run on 2026-07-17 passed against packed `@ackerdb/*` 0.3.0:

| Host | Version | Result |
| --- | --- | --- |
| Codex | `codex-cli 0.144.0` | PASS: public, initialization instructions, least-privilege discovery, authenticated, structured/rich, HTTP 403 scope denial, HTTP 401 revocation |
| Claude Code | `2.1.170 (Claude Code)` | PASS: public, initialization instructions, least-privilege discovery, authenticated, structured/rich, HTTP 403 scope denial, HTTP 401 revocation |

Final output:

```text
✓ codex codex-cli 0.144.0: public, least-privilege, structured/rich, scope, revoke
✓ claude 2.1.170 (Claude Code): public, least-privilege, structured/rich, scope, revoke
Real MCP hosts passed against packed @ackerdb/* 0.3.0; credentials remained environment-backed and ephemeral.
```

## Current host limitations

- Noninteractive Codex cancels MCP calls when the default approval mode still
  requires a prompt. This gate deliberately sets the documented per-server
  `default_tools_approval_mode` to `approve`; it does not disable Codex's
  sandbox or enable unrelated tools.
- Codex 0.144.0 reports AckerDB's HTTP 403 as `Insufficient scope` and HTTP 401 as
  `Auth required` in the failed MCP event.
- Claude Code's `--mcp-config` accepts multiple values. Keep the positional
  prompt before that flag (as above), or it can be parsed as another config
  path. Environment expansion in the Authorization header keeps the token out
  of the command and config JSON.
- This gate needs authenticated external host installations and model access.
  It remains HITL and is not permanent hosted infrastructure.

OAuth, stdio transport, Claude Desktop packaging, and model
quality evaluation remain outside this gate.
