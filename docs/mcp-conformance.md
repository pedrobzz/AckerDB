# MCP release gates

DBZZ tests its Streamable HTTP MCP server with both raw protocol fixtures and
the official MCP conformance runner. These are release gates for the
capabilities DBZZ implements; they are not a claim that DBZZ implements every
optional MCP capability. Application authoring is documented in
[MCP and AI integration](ai-integration.md).

## Official conformance

The repository pins `@modelcontextprotocol/conformance` to `0.1.16`. Run the
targeted server scenarios with:

```sh
bun run test:mcp:conformance
```

The gate starts a real DBZZ runtime and HTTP listener, then invokes the
official CLI against it. It runs these stable scenarios:

| Scenario | DBZZ capability exercised |
| --- | --- |
| `server-initialize` | Initialization, negotiated protocol version, server metadata, and capabilities |
| `ping` | Stateless request/response health check |
| `tools-list` | Tool names, descriptions, and input schemas |
| `tools-call-simple-text` | Text content result |
| `tools-call-image` | Image content result |
| `tools-call-audio` | Audio content result |
| `tools-call-embedded-resource` | Embedded resource content result |
| `tools-call-mixed-content` | Mixed text, image, and resource result |
| `tools-call-error` | Intentional safe tool error |
| `dns-rebinding-protection` | Rejected foreign Host/Origin and accepted loopback Host/Origin |

The runner's complete active suite is deliberately not used as a substitute
for capability selection. DBZZ currently exposes tools, not MCP resources,
prompts, completion, logging, sampling, elicitation, progress notifications,
subscriptions, or stateful SSE streams. Those optional scenarios are therefore
outside this gate. The runner's `json-schema-2020-12` fixture also requires a
specific hard-coded tool with reusable `$defs`/`$ref`; DBZZ emits honest
2020-12 object schemas from its validator surface, but does not add an
arbitrary-schema escape hatch solely for that fixture.

## Raw protocol and security cases

`packages/server/test/mcp.test.ts` retains the wire-level cases that the
targeted official scenarios do not cover together: initialize, initialized
notification, ping, `tools/list`, `tools/call`, malformed JSON, unsupported
JSON-RPC methods, JSON POST responses, and stateless GET/DELETE rejection.
Authentication, authorization, token lifecycle, revocation, cancellation,
and HTTP boundary cases live beside it in the other `mcp-*.test.ts` files.
They run as part of `bun run test`.

## Packed consumer

```sh
bun run test:mcp:package
```

This gate packs all five lockstep `@dbzz/*` packages and installs the tarballs
in a temporary consumer. It verifies:

- every installed DBZZ package has the same exact version and packed internal
  dependencies contain literal versions rather than `workspace:` specifiers;
- `@dbzz/server/mcp` resolves and executes under Bun;
- packaged `dbz codegen` emits schema-bound `createMcp` and `mcpTool` builders,
  and endpoint tool names, inputs, outputs, and scope subsets compile exactly in
  the clean consumer;
- `@dbzz/server` pins `@modelcontextprotocol/sdk` to `1.29.0`, the consumer
  resolves that version, and the server has no production dependency on `ai`
  or `@ai-sdk/*`.

The temporary consumer uses package-manager overrides only to point
transitive `@dbzz/*` versions at the five local tarballs because this project
does not publish them to npm. The packed manifests themselves remain unchanged
and are asserted after installation.

## Real host acceptance

The optional HITL gate connects the packed endpoint to the real current Codex
and Claude Code CLIs:

```sh
bun run test:mcp:hosts
```

It requires both hosts to be installed and authenticated locally, so it is not
part of `bun run test`. The script creates fresh bearer tokens inside a
temporary packed consumer, passes them to each host only through an environment
variable, and removes the consumer when the run ends. It covers initialization
instructions, anonymous public access, least-privilege discovery,
authenticated/structured/rich calls, a live scope reduction, and live
revocation. See [the reproducible host record](mcp-host-acceptance.md) for the
exact versions, configuration, assertions, and current host limitations.

## Comparative performance

Runtime MCP changes are benchmarked only when they enter a release version:

```sh
# Dispatch from a background worker after bun run bump.
bun run bench:hetzner
```

DBZZ, Convex, and SpacetimeDB run on the Hetzner host with the same workload.
The single version-bound release record compares DBZZ with the preceding
version. It is evidence for human or agent interpretation of the full
performance vector, never an automated approval or release veto. See [the
benchmark contract](../bench/README.md) for the complete procedure.
