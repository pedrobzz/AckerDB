# First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools — issue breakdown

> Historical implementation plan; the work it schedules has shipped. The tool
> surface it describes predates the `mcp({ auth, tools })` redesign — a tool is
> an ordinary registered function now, not an `mcpTool` blueprint, and scopes
> live on an `mcpAuth` provider. Do not execute the steps below; the current
> contract is [MCP exposure](../../mcp-exposure.md).

- Parent PRD: `PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools`
- Source PRD: approved local draft published as [GitHub issue #19](https://github.com/pedrobzz/ackerdb/issues/19)
- Date generated: 2026-07-16

| ID | GitHub | Title | Type | Blocked by | User stories |
| --- | --- | --- | --- | --- | --- |
| ISSUE-01 | [#26](https://github.com/pedrobzz/ackerdb/issues/26) | Public transactional MCP over stateless HTTP | AFK | None | 16–18, 25–27, 36–37, 43–44, 46–47, 61–62 |
| ISSUE-02 | [#27](https://github.com/pedrobzz/ackerdb/issues/27) | Multiple named MCP endpoints and deterministic routing | AFK | ISSUE-01 | 19–21 |
| ISSUE-03 | [#28](https://github.com/pedrobzz/ackerdb/issues/28) | Typed structured tools from validator to protocol result | AFK | ISSUE-01 | 28–29, 38–39, 63 |
| ISSUE-04 | [#29](https://github.com/pedrobzz/ackerdb/issues/29) | Lossless AckerDB values at the MCP boundary | AFK | ISSUE-03 | 64–66 |
| ISSUE-05 | [#30](https://github.com/pedrobzz/ackerdb/issues/30) | Host annotations and explicit rich-content results | AFK | ISSUE-01 | 30, 40 |
| ISSUE-06 | [#31](https://github.com/pedrobzz/ackerdb/issues/31) | Identity-bound owner tokens from creation to authenticated call | AFK | ISSUE-01; Identity ISSUE-16 from parent #3 | 1–7, 13, 15 |
| ISSUE-07 | [#32](https://github.com/pedrobzz/ackerdb/issues/32) | Reactive owner token lifecycle | AFK | ISSUE-06 | 8–9, 11–12 |
| ISSUE-08 | [#33](https://github.com/pedrobzz/ackerdb/issues/33) | Exact typed scopes and explicit any/all authorization | AFK | ISSUE-03, ISSUE-06 | 10, 22–24, 31–32 |
| ISSUE-09 | [#34](https://github.com/pedrobzz/ackerdb/issues/34) | Least-privilege discovery and call-time reauthorization | AFK | ISSUE-08 | 33–35, 48 |
| ISSUE-10 | [#35](https://github.com/pedrobzz/ackerdb/issues/35) | Bounded live revocation and scope reduction | AFK | ISSUE-07, ISSUE-09 | 67 |
| ISSUE-11 | [#36](https://github.com/pedrobzz/ackerdb/issues/36) | Explicit system-managed integration tokens | AFK | ISSUE-06 | 14 |
| ISSUE-12 | [#37](https://github.com/pedrobzz/ackerdb/issues/37) | Hardened MCP HTTP security boundary | AFK | ISSUE-09 | 45, 49–50 |
| ISSUE-13 | [#38](https://github.com/pedrobzz/ackerdb/issues/38) | MCP calls under AckerDB runtime ownership | AFK | ISSUE-12 | 68 |
| ISSUE-14 | [#39](https://github.com/pedrobzz/ackerdb/issues/39) | Public zero-hop AI SDK v7 tools | AFK | ISSUE-03, ISSUE-05 | 51–52, 56, 59–60 |
| ISSUE-15 | [#40](https://github.com/pedrobzz/ackerdb/issues/40) | Identity-preserving local delegation | AFK | ISSUE-08, ISSUE-14; Identity ISSUE-16 from parent #3 | 53–55, 57 |
| ISSUE-16 | [#41](https://github.com/pedrobzz/ackerdb/issues/41) | Cancellation through local tools and queued transactions | AFK | ISSUE-13, ISSUE-15 | 58 |
| ISSUE-17 | [#42](https://github.com/pedrobzz/ackerdb/issues/42) | Automated MCP conformance and performance evidence | AFK | ISSUE-01 through ISSUE-16 | 69–70 except real-host acceptance |
| ISSUE-18 | [#43](https://github.com/pedrobzz/ackerdb/issues/43) | Real Codex and Claude Code acceptance | HITL | ISSUE-12, ISSUE-17 | 41–42, 69 |

## ISSUE-01: Public transactional MCP over stateless HTTP

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Deliver the first complete MCP path: an exported, explicitly named schema-bound MCP with one public transactional tool mounted at the default `/mcp` route. A standard client must initialize, list the tool, call it with validated JSON arguments, execute normal AckerDB query/mutation composition, and receive a JSON-RPC result. MCP exports remain server-only and GET/DELETE explicitly reject session semantics.

### Why this slice exists

Every later token, scope, output, and AI adapter needs one real protocol path. This slice crosses declaration, registry, codegen, listener routing, dispatch, transaction context, and HTTP without waiting for authentication.

## Acceptance criteria

- [ ] An explicit MCP declaration and lower-snake-case public tool are discovered from server modules and schema-bind the handler context.
- [ ] The default `/mcp` route supports initialize, initialized notification, ping, `tools/list`, and `tools/call` through bounded standard JSON POST bodies and JSON responses.
- [ ] The public handler receives normal AckerDB principal, abort, and transaction/composition capabilities and can commit a visible database change.
- [ ] Tool input is validated before handler execution and validation/handler failures become safe MCP errors.
- [ ] MCP declarations and tools are omitted from generated client function references.
- [ ] GET and DELETE return explicit method responses and no session ID, SSE stream, or second server is created.
- [ ] Duplicate public tool wire names fail during startup.

### Implementation notes

- Extend the existing registry with a distinct server-only export kind instead of disguising tools as procedures.
- Mount into the existing Bun listener and reuse bounded body parsing; do not use AckerDB's private tagged wire codec.
- Build the shared dispatcher as the only handler execution path from the first slice.

## Blocked by

None — can start immediately.

## User stories addressed

- User stories 16–18, 25–27, 36–37, 43–44, 46–47, 61–62

### Test plan

- Use raw JSON-RPC and the official SDK client to initialize, list, call, ping, and send malformed input.
- Prove a tool transaction commits on success and rolls back on error.
- Compile-check schema-bound arguments/context and generated-client omission.
- Exercise POST size limits and unsupported GET/DELETE.

### Out of scope

- Bearer authentication, multiple MCPs, structured output schemas, rich content, scopes, AI SDK tools, and production HTTP hardening.

## ISSUE-02: Multiple named MCP endpoints and deterministic routing

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Expose two independently named MCP declarations on distinct custom paths with separate instructions and tools. Route and declaration identity must remain stable across export renames, while duplicate names, paths, tool names, and collisions with AckerDB built-ins fail deterministically before serving.

### Why this slice exists

A second endpoint proves that naming and routing are real framework primitives rather than assumptions hidden in the single `/mcp` happy path.

## Acceptance criteria

- [ ] Two MCP declarations initialize independently on distinct configured paths and expose only their own instructions and tools.
- [ ] Each MCP has a required explicit stable name; export or local variable renames do not affect protocol identity.
- [ ] One declaration may omit a path and receive `/mcp`; additional declarations require non-colliding paths.
- [ ] Duplicate MCP names, duplicate paths, duplicate tool wire names, and built-in route collisions fail deterministically at startup.
- [ ] Changing one route path does not change the MCP's stable name or make credentials/configuration refer to another endpoint.

### Implementation notes

- Validate the complete registry after application loading rather than depending on module import order.
- Keep instructions and bounded endpoint metadata inside the AckerDB declaration abstraction.
- Do not infer names from source variables or add MCP-specific code generation.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 19–21

### Test plan

- Initialize two endpoints and compare instructions/tool lists.
- Rename exports in a compile fixture and assert stable declaration identity.
- Cover every collision and invalid-path case with deterministic diagnostics.

### Out of scope

- Tokens, scopes, dynamic endpoint creation, stateful sessions, and route aliases.

## ISSUE-03: Typed structured tools from validator to protocol result

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Deliver one described tool whose AckerDB input and object output validators drive handler inference, runtime validation, JSON Schema 2020-12 discovery, Standard Schema behavior, structured MCP content, and the required canonical JSON text result from one descriptor.

### Why this slice exists

Models and callers can only trust a tool when its advertised schema, runtime behavior, and TypeScript types are the same contract.

## Acceptance criteria

- [ ] AckerDB validators support human descriptions on tool fields and produce honest JSON Schema 2020-12 object schemas.
- [ ] The same validator descriptor provides Standard Schema-compatible validation without depending on AI SDK.
- [ ] Tool handler input/output types are inferred end to end from the declaration.
- [ ] Advertised input and output schemas have object roots and match `tools/list` exactly.
- [ ] A structured handler result is validated before delivery and appears as both `structuredContent` and canonical JSON text.
- [ ] Invalid model input never reaches the handler and invalid handler output becomes an explicit tool error.

### Implementation notes

- Implement one validator conversion boundary shared by MCP and later AI SDK tools.
- Nullable domain results must use a named nullable property inside an object, not a nullable root.
- Keep intentionally opaque JSON honest rather than inventing field guidance.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 28–29, 38–39, 63

### Test plan

- Compare runtime validation, generated JSON Schema, Standard Schema results, discovery output, and handler types for the same validators.
- Exercise valid/invalid input and valid/invalid structured output.
- Compile-fail non-object input/output roots.

### Out of scope

- Non-JSON-native values, rich MCP content, annotations, and model-provider-specific strict-schema limitations.

## ISSUE-04: Lossless AckerDB values at the MCP boundary

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Extend structured tools with canonical protocol conversion for AckerDB values that standard JSON cannot represent directly. Bigint and Identity cross as lossless decimal strings, bytes cross as base64, and validator shapes without one consistent HTTP/local representation are rejected at startup.

### Why this slice exists

Silent precision loss or divergent conversion would make database tools unsafe. This slice proves one lossless contract before local AI execution reuses it.

## Acceptance criteria

- [ ] Bigint and Identity inputs and outputs round-trip as validated decimal strings without precision loss.
- [ ] Byte inputs and outputs round-trip as validated base64 strings.
- [ ] Discovery schemas describe the protocol representation rather than the internal runtime value.
- [ ] HTTP decoding, handler values, output validation, and encoding agree on one conversion.
- [ ] Unsupported or contradictory validator shapes fail during startup with actionable diagnostics.

### Implementation notes

- Keep conversion in the validator/protocol boundary, not scattered through tool handlers.
- Do not use tagged AckerDB wire values in MCP JSON.
- Identity's protocol string does not change its branded runtime representation inside handlers.

## Blocked by

- `ISSUE-03`

## User stories addressed

- User stories 64–66

### Test plan

- Round-trip minimum, maximum, negative, and large bigint values plus representative byte arrays.
- Reject malformed decimal/base64 input.
- Add startup-fail fixtures for every unsupported validator shape.

### Out of scope

- Arbitrary custom codecs, lossy number conversion, and rich binary content blocks.

## ISSUE-05: Host annotations and explicit rich-content results

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Add standard MCP tool annotations and an explicit unstructured result contract for text, images, audio, embedded resources, resource links, metadata, intentional tool errors, and mixed content. Tools without declared structured output must return this contract rather than arbitrary values.

### Why this slice exists

Rich agent results and host approval hints are valuable, but they should not weaken the typed structured-output path or create an unvalidated catch-all.

## Acceptance criteria

- [ ] Tool discovery exposes title and standard read-only, destructive, idempotent, and open-world annotations.
- [ ] A tool without structured output returns only the explicit MCP content-result union.
- [ ] Text, image, audio, embedded-resource, resource-link, metadata, mixed-content, and intentional-error cases serialize correctly.
- [ ] Arbitrary handler return values fail type checking and runtime validation.
- [ ] Annotations remain hints and never replace AckerDB authorization.

### Implementation notes

- Use the stable protocol content types behind AckerDB-owned public types.
- Keep structured and rich-content result modes explicit and mutually understandable.
- Do not expose official SDK result types as the public API.

## Blocked by

- `ISSUE-01`

## User stories addressed

- User stories 30, 40

### Test plan

- List annotated tools and call one fixture for every supported content block.
- Compile-fail arbitrary returns and invalid annotation values.
- Assert intentional tool errors differ from transport/authentication errors.

### Out of scope

- MCP resources, resource subscriptions, prompts, sampling, elicitation, and server-initiated notifications.

## ISSUE-06: Identity-bound owner tokens from creation to authenticated call

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Deliver the first delegated-user path: an externally authenticated owner uses an application mutation to create and list multiple endpoint-bound MCP tokens, copies the one-time secret into an HTTP client, and calls an authenticated tool whose principal contains the same durable AckerDB Identity. Revocation and metadata editing remain later slices.

### Why this slice exists

This proves the central product promise—external agents act as the same application user—while establishing secret-storage and owner-isolation invariants before scopes add complexity.

## Acceptance criteria

- [ ] An externally authenticated user can create multiple named tokens for one named MCP and receives each plaintext secret exactly once.
- [ ] Only a cryptographic digest, public token ID, owner Identity, MCP name, descriptors, and timestamps persist internally.
- [ ] Listing returns owner-scoped descriptors and can never recover plaintext, including through system access.
- [ ] A bearer token authenticates only to its bound MCP and constructs MCP credential provenance with the owning Identity.
- [ ] An authenticated tool sees the same Identity used by ordinary external-user requests.
- [ ] Tokens contain no expiration field and remain valid until revoked.
- [ ] MCP-authenticated principals cannot create, list, update, revoke, or escalate tokens.

### Implementation notes

- Use high-entropy independent secret material with a recognizable prefix and public lookup ID; compare digests in constant time.
- Store tokens in reserved Engine-backed internal state, not application tables or a side database.
- Keep external-user and MCP credential provenance discriminated even when they share Identity.
- Apply bounded token/name/metadata/count limits as service invariants.

## Blocked by

- `ISSUE-01`
- `Identity ISSUE-16 from parent #3`

## User stories addressed

- User stories 1–7, 13, 15

### Test plan

- Create two tokens, restart, authenticate each to the correct endpoint, and assert shared row ownership.
- Inspect storage to prove the secret is absent and list output never reveals it.
- Reject wrong endpoint, malformed/unknown tokens, cross-owner listing, and MCP self-administration.

### Out of scope

- Token updates, revocation, scopes, system-owned administration, OAuth, refresh tokens, and built-in expiration.

## ISSUE-07: Reactive owner token lifecycle

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Complete the owner-managed descriptor lifecycle with reactive listing, name/metadata edits, and revocation by public token ID. Demonstrate that application-defined scheduled logic can call the same revocation primitive without adding framework expiration.

### Why this slice exists

Applications need safe management screens and policy hooks, but secret rotation and authorization changes should remain separate from harmless descriptor edits.

## Acceptance criteria

- [ ] Owner-scoped token listing is reactive across create, rename, bounded metadata update, and revoke.
- [ ] Name/metadata edits preserve the existing secret and do not invalidate active work.
- [ ] Revocation uses the public token ID and immediately rejects new authentication attempts.
- [ ] A normal application mutation or scheduled workflow can invoke revocation according to application policy.
- [ ] No expiration, refresh, recovery, or plaintext-redisplay API is introduced.
- [ ] Cross-owner reads/writes fail even when application code omits its own owner predicate.

### Implementation notes

- Integrate internal token descriptor keys with AckerDB read/write dependency tracking.
- Keep revocation's active-work invalidation for ISSUE-10; this slice guarantees new-request rejection.
- Metadata stays bounded opaque application data and never affects authorization.

## Blocked by

- `ISSUE-06`

## User stories addressed

- User stories 8–9, 11–12

### Test plan

- Subscribe to list descriptors and observe every lifecycle transition.
- Revoke from an application-policy fixture and assert new bearer requests fail.
- Reject cross-owner IDs, oversized metadata, and recovery/redisplay attempts.

### Out of scope

- Token scopes, active-call invalidation, system-managed tokens, automatic schedules, and a framework token UI.

## ISSUE-08: Exact typed scopes and explicit any/all authorization

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Add literal application-defined scopes to MCP declarations, token creation/update, and tool access policies. Scope-enabled declarations expose an inferred value union and validator; policies explicitly choose authenticated, any-of, or all-of semantics; scope-free declarations omit scope-bearing APIs.

### Why this slice exists

Delegation needs least privilege, but inferred CRUD/wildcard behavior and ambiguous arrays would create invisible authority. This slice establishes exact semantics at type and runtime boundaries.

## Acceptance criteria

- [ ] Literal declaration scopes produce exact TypeScript values and a reusable runtime validator.
- [ ] Scope-enabled token creation and transactional updates accept only declared exact values.
- [ ] Tool access supports public, authenticated, explicit any-of, and explicit all-of policies.
- [ ] `.all`, dots, and resource/action-looking names receive no wildcard or parsing behavior.
- [ ] An empty stored scope set grants no scoped authority and null never means full access.
- [ ] Omitting declaration scopes removes scope-valued token and policy APIs at compile time.
- [ ] Invalid scope declarations, policies, token values, and updates fail before authority changes.

### Implementation notes

- Treat scopes as coarse delegated capability; handlers and nested AckerDB functions still enforce row/tenant/business access.
- Do not create default CRUD scopes or a bare scope-array policy.
- Commit scope updates atomically; live invalidation follows in ISSUE-10.

## Blocked by

- `ISSUE-03`
- `ISSUE-06`

## User stories addressed

- User stories 10, 22–24, 31–32

### Test plan

- Compile-pass/fail exact scope unions and scope-free declarations.
- Exercise authenticated, any-of, all-of, empty, and misleading `.all` values.
- Roll back an invalid update and assert the previous grant remains.

### Out of scope

- Filtered discovery, HTTP 401/403 behavior, live invalidation, roles, organizations, and row-level policy.

## ISSUE-09: Least-privilege discovery and call-time reauthorization

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Filter `tools/list` by anonymous/authenticated scope authority and repeat the full access decision on every `tools/call`. Public tools remain discoverable anonymously, bearer callers see only their grant by default, and authentication versus insufficient-authority failures retain distinct HTTP semantics.

### Why this slice exists

A least-privilege tool list improves model behavior, but discovery can be cached. Reauthorizing calls is the security boundary that makes later scope changes and revocation safe.

## Acceptance criteria

- [ ] Anonymous discovery includes only public tools and anonymous calls to protected tools are denied.
- [ ] Authenticated discovery includes authenticated and scoped tools callable by the token's exact grant.
- [ ] Every call repeats endpoint, principal, scope, and application access checks regardless of prior discovery.
- [ ] Missing or invalid bearer credentials receive HTTP 401 where the protocol permits.
- [ ] Valid credentials with insufficient scopes receive HTTP 403 and an appropriate bearer challenge where permitted.
- [ ] Cached tool names cannot bypass a changed grant.

### Implementation notes

- Keep one access evaluator in the shared dispatcher for HTTP and later local tools.
- Avoid leaking protected tool details through anonymous errors.
- The first PAT implementation is custom bearer delegation, not MCP OAuth metadata or consent.

## Blocked by

- `ISSUE-08`

## User stories addressed

- User stories 33–35, 48

### Test plan

- List and call as anonymous, unscoped, any-of, all-of, invalid-token, and insufficient-scope clients.
- Cache a list, change a grant, and prove the old call is denied.
- Assert 401/403 headers and safe JSON-RPC bodies.

### Out of scope

- OAuth authorization server behavior, include-unavailable local tools, and active-call invalidation.

## ISSUE-10: Bounded live revocation and scope reduction

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Publish post-commit credential invalidations for token revocation and scope reduction so new requests observe authority immediately and affected active HTTP work aborts within the configured revocation bound. Rollbacks must never invalidate valid credentials.

### Why this slice exists

Tokens intentionally never expire, so bounded revocation—not time-based expiry—is the lifetime safety mechanism.

## Acceptance criteria

- [ ] Successful revoke and scope-reduction commits publish structured invalidation after commit.
- [ ] New authentication and calls observe the new authority immediately after commit.
- [ ] Affected active calls and queued transactional work abort within the configured invalidation bound.
- [ ] Rolled-back revocation/scope changes emit no invalidation and preserve authority.
- [ ] Name/metadata-only edits do not interrupt active work.
- [ ] Invalidation targets the exact token/MCP authority without cancelling unrelated users or tokens.

### Implementation notes

- Add a structured post-commit invalidation path rather than executing callbacks inside transactions.
- Allow non-expiring MCP principals only through this bounded verifier/invalidation mechanism.
- Reuse Runtime cancellation ownership instead of adding a polling loop per call.

## Blocked by

- `ISSUE-07`
- `ISSUE-09`

## User stories addressed

- User stories 67

### Test plan

- Pause a long tool and queued writer, revoke/reduce its token, and measure bounded abortion.
- Roll back authority changes and assert work continues.
- Run unrelated tokens concurrently and assert isolation.

### Out of scope

- Automatic expiration, refresh tokens, sliding sessions, and local AI cancellation.

## ISSUE-11: Explicit system-managed integration tokens

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Add a deliberately system-authorized API that creates, lists, and revokes MCP tokens for an explicit Identity without impersonating that user. Use it in a backend-only fixture while preserving the same one-time-secret and endpoint-binding rules.

### Why this slice exists

Backend-managed integrations are a valid deployment mode, but folding them into owner APIs would either require impersonation or create a privilege-escalation hole.

## Acceptance criteria

- [ ] Only system/internal authority can administer a token for an explicit Identity.
- [ ] The system API returns plaintext only on creation and otherwise exposes descriptors.
- [ ] Created tokens authenticate as MCP provenance for the specified Identity and bound endpoint.
- [ ] External-user APIs cannot select another Identity and MCP principals cannot invoke the system path.
- [ ] System revocation uses the same token lifecycle and invalidation semantics as owner revocation.

### Implementation notes

- Keep system and owner entry points explicit while sharing the deep token-vault operations.
- Do not add a wrapper whose only purpose is calling another exported function; expose the correct primitive directly.

## Blocked by

- `ISSUE-06`

## User stories addressed

- User stories 14

### Test plan

- Mint for a selected Identity, authenticate, and revoke through system authority.
- Reject external user, workload without system authority, MCP principal, and arbitrary Identity escalation.
- Verify one-time secret handling and absence from public errors.

### Out of scope

- Admin UI, impersonation, bulk migration, organization policy, and provider-account administration.

## ISSUE-12: Hardened MCP HTTP security boundary

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Harden each MCP HTTP exchange with independent authentication/admission, Host validation, Origin policy, native-host compatibility when Origin is absent, and systematic redaction of credentials, arguments, and sensitive results.

### Why this slice exists

A correct tool protocol is not a safe public endpoint until browser/DNS-rebinding boundaries are explicit.

## Acceptance criteria

- [ ] Every POST independently authenticates and enters ingress admission; no session identifier acts as identity or a resource lease.
- [ ] Configured Host validation rejects unexpected hosts and invalid Origin receives HTTP 403.
- [ ] Requests without Origin from native MCP hosts remain usable under Host policy.
- [ ] Bearer secrets, provider credentials, tool arguments, sensitive results, and unbounded values never enter metric labels or public errors.
- [ ] Production deployment requires HTTPS at AckerDB or a trusted terminating proxy.
- [ ] Body, header, and tool-count limits fail safely.

### Implementation notes

- Reuse the existing listener's body reader and admission ownership.
- Make local-development Host/Origin policy explicit without weakening deployed defaults.
- Do not put bearer tokens in URLs, generated code, client bundles, or error messages.

## Blocked by

- `ISSUE-09`

## User stories addressed

- User stories 45, 49–50

### Test plan

- Exercise allowed/denied Host and Origin combinations, absent Origin, oversized bodies/headers, and invalid credentials.
- Capture responses and metrics across success and every failure and scan for secrets, arguments, and results.
- Run concurrent requests to verify independent admission.

### Out of scope

- OAuth protected-resource metadata, browser credential UI, reverse-proxy implementation, and stateful sessions.

## ISSUE-13: MCP calls under AckerDB runtime ownership

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Prove and harden concurrent MCP calls under the existing AckerDB Runtime: per-principal fairness, admission, nested invocation, transaction ownership, cancellation, drain, and shutdown must work without a second listener, conflicting top-level lease, or leaked resource.

### Why this slice exists

MCP is first-class only when it obeys the database runtime's production invariants under load, not merely when individual calls return correct JSON.

## Acceptance criteria

- [ ] Concurrent calls participate in existing global and per-principal admission/fairness limits.
- [ ] Nested query/mutation composition retains principal and instrumentation without acquiring a conflicting second top-level lease.
- [ ] Client disconnect, server drain, and shutdown cancel/settle work through existing Runtime ownership.
- [ ] Transactions commit/rollback normally under contention and queued work respects request cancellation.
- [ ] Repeated exchanges leave no listeners, timers, sessions, dispatch entries, or transaction resources.

### Implementation notes

- Prefer adapting the existing Runtime boundary over adding MCP-specific schedulers or semaphores.
- Exercise one MCP token across parallel calls and several identities for fairness.
- At the release version, compare headline mutation/subscription/CPU metrics with the preceding final Hetzner record.

## Blocked by

- `ISSUE-12`

## User stories addressed

- User stories 68

### Test plan

- Load concurrent public and authenticated tools through admission limits.
- Drain and shut down during queued, transactional, and long-running calls.
- Use resource counters to detect leaks or double leases.
- Run the version-bound Hetzner comparison and interpret material movements
  across the full performance vector in the release handoff.

### Out of scope

- Distributed rate limiting, durable MCP tasks, stateful sessions, and local AI-specific cancellation.

## ISSUE-14: Public zero-hop AI SDK v7 tools

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Expose a named MCP as an object of structurally AI SDK v7-compatible tools inside an SSE procedure. Public tools must execute through the shared dispatcher without HTTP, initialization, bearer tokens, or a production dependency on AI SDK; unavailable tools are omitted by default.

### Why this slice exists

This proves the performance-critical same-process adapter while reusing the exact declaration, validation, result, and error semantics already exercised over HTTP.

## Acceptance criteria

- [ ] A declaration returns tools keyed by wire name with descriptions, Standard Schema input/output validation, execute functions, and result conversion.
- [ ] AI SDK v7 `streamText` consumes the returned object directly in compile and runtime fixtures.
- [ ] Execution enters the shared dispatcher and performs no HTTP, MCP initialize/list exchange, or token lookup.
- [ ] Public structured and rich-content tools preserve the same semantic results as HTTP.
- [ ] Unauthorized/unavailable tools are omitted by default.
- [ ] `@ackerdb/server` has no AI SDK production dependency; the exact supported v7 release is pinned only for integration testing or existing optional AI surfaces.

### Implementation notes

- Use structural compatibility rather than importing AI SDK tool constructors at runtime.
- Keep the existing client-react AI chat transport separate; this adapter supplies server-side tools to generation.
- Instrument local invocation as nested Runtime work.

## Blocked by

- `ISSUE-03`
- `ISSUE-05`

## User stories addressed

- User stories 51–52, 56, 59–60

### Test plan

- Pass tools directly to `streamText` and exercise structured, rich-content, invalid-input, handler-error, and parallel-call paths.
- Assert no network/token-vault activity during local execution.
- Inspect packed server dependencies and compile against the exact v7 version.

### Out of scope

- Authenticated local delegation, include-unavailable mode, cancellation, remote AI SDK MCP clients, and coupling to a model provider.

## ISSUE-15: Identity-preserving local delegation

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Allow server code to grant an explicit subset of declared scopes to zero-hop tools while retaining the parent AckerDB principal and Identity. Anonymous invocations cannot manufacture Identity, existing MCP principals cannot exceed their token grant, and an explicit include-unavailable mode may show denied tool context without enabling execution.

### Why this slice exists

Same-process assistants need delegated authority, not copied bearer credentials. This slice makes the local capability boundary explicit and prevents a scope list from becoming authentication.

## Acceptance criteria

- [ ] External-user local execution retains the parent durable Identity and receives only the server-selected declared scope subset.
- [ ] Anonymous parent principals remain limited to public tools regardless of supplied scope strings.
- [ ] An MCP parent principal cannot gain scopes beyond the intersected token grant.
- [ ] Authorized-only discovery remains default.
- [ ] Include-unavailable exposes descriptions/schemas for denied tools but execute re-enters the dispatcher and returns the real denial.
- [ ] Local and HTTP access policies use the same any/all evaluator and handler authorization.

### Implementation notes

- Never mint, retrieve, store, or validate a bearer token for local execution.
- Treat the local scope set as server-side delegation, not persisted token authority.
- Preserve immutable parent principal and nested invocation instrumentation.

## Blocked by

- `ISSUE-08`
- `ISSUE-14`
- `Identity ISSUE-16 from parent #3`

## User stories addressed

- User stories 53–55, 57

### Test plan

- Run external-user, anonymous, MCP-token, insufficient-any/all, and include-unavailable cases through AI SDK.
- Attempt scope escalation and synthetic Identity injection and assert denial.
- Compare equivalent HTTP and local authorization outcomes.

### Out of scope

- Client-selected scopes, token minting for local tools, autonomous privilege escalation, and OAuth.

## ISSUE-16: Cancellation through local tools and queued transactions

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Combine the AI SDK tool execution signal with the outer AckerDB invocation signal and propagate the child signal through the dispatcher, handler, nested calls, new transactions, and queued writer work. Cancelling generation must promptly stop all owned work without affecting sibling calls.

### Why this slice exists

Zero-hop latency is only useful if cancellation also remains zero-hop and reaches the database work rather than merely stopping UI streaming.

## Acceptance criteria

- [ ] Local tool execution derives one child signal from AI SDK cancellation, parent request cancellation, invalidation, drain, and shutdown.
- [ ] Handlers, nested calls, new transactions, and queued writers observe the child signal promptly.
- [ ] Cancelling one generation does not cancel sibling generations or unrelated token work.
- [ ] Rollback and resource cleanup complete after cancellation with no late commit or result delivery.
- [ ] HTTP tool cancellation continues to use the same dispatcher semantics.

### Implementation notes

- Pass the child signal when transactions are created/enqueued; checking only the outer SSE signal is insufficient.
- Reuse Runtime cancellation primitives and structured reasons.
- Avoid polling or adapter-specific cancellation branches.

## Blocked by

- `ISSUE-13`
- `ISSUE-15`

## User stories addressed

- User stories 58

### Test plan

- Cancel during handler computation, nested query, active transaction, queued writer, and result encoding.
- Race cancellation with commit and assert deterministic ownership/no late delivery.
- Run siblings concurrently and inspect resource cleanup.

### Out of scope

- Resuming cancelled generation, durable tasks, client-side AI transport changes, and automatic retry.

## ISSUE-17: Automated MCP conformance and performance evidence

### Type

AFK

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Turn the complete implementation into reproducible conformance checks and
performance evidence: run official MCP server conformance plus retained raw
JSON cases, pack/install the real lockstep artifacts in clean Bun fixtures,
validate server exports/dependencies, and compare the branch's AckerDB with its
base branch's AckerDB on the protected Hetzner check.

### Why this slice exists

Protocol and performance claims must survive outside unit mocks and source-workspace resolution before real hosts are asked to consume the endpoint.

## Acceptance criteria

- [ ] The targeted stable MCP conformance suite passes for supported capabilities and explicitly documents unsupported optional capabilities.
- [ ] Raw fixtures cover initialize, notification, ping, list, call, malformed JSON-RPC, unsupported methods, auth failures, JSON POST responses, and stateless GET/DELETE.
- [ ] Clean packed consumers resolve the server MCP subpath, generated server types, stable SDK dependency, and Bun runtime.
- [ ] Packed `@ackerdb/server` contains no AI SDK production dependency.
- [ ] All compile, unit, integration, security, cancellation, leak, and package tests run in the normal repository gate.

### Implementation notes

- Target the stable official MCP SDK/protocol available at implementation and keep it behind AckerDB public abstractions.
- Rerun only when it helps resolve measurement ambiguity. Deliberately remove
  the write-once version record first, then retain only its replacement; never
  retain parallel or iteration artifacts.
- Update wiki evidence if conformance or package behavior changes an architectural decision.

## Blocked by

- `ISSUE-01`
- `ISSUE-02`
- `ISSUE-03`
- `ISSUE-04`
- `ISSUE-05`
- `ISSUE-06`
- `ISSUE-07`
- `ISSUE-08`
- `ISSUE-09`
- `ISSUE-10`
- `ISSUE-11`
- `ISSUE-12`
- `ISSUE-13`
- `ISSUE-14`
- `ISSUE-15`
- `ISSUE-16`

## User stories addressed

- User stories 69–70 except real-host acceptance

### Test plan

- Run the official suite and raw fixtures from a clean checkout.
- Pack and install exact lockstep artifacts in an isolated consumer.
- Review the required base/head AckerDB Hetzner artifact for the current pull
  request and record the human reasoning.

### Out of scope

- Real Codex/Claude host acceptance, OAuth capabilities, unsupported MCP features, npm publication, and backward compatibility.

## ISSUE-18: Real Codex and Claude Code acceptance

### Type

HITL

### Parent PRD

`PRD: First-class MCP servers, Identity-bound access tokens, and zero-hop AI tools` ([#19](https://github.com/pedrobzz/ackerdb/issues/19))

## What to build

Connect real current Codex and Claude Code hosts to the packaged Streamable HTTP endpoint with environment-backed bearer credentials. Verify initialize, instructions, filtered discovery, public and authenticated tool calls, structured/rich results, scope denial, and revocation without storing personal secrets in the repository.

### Why this slice exists

Conformance proves the protocol; this release gate proves the exact external hosts that motivate the feature. It is isolated as HITL because installed/authenticated third-party host environments and human-observed tool approval may be required.

## Acceptance criteria

- [ ] Codex connects to the HTTP MCP using an environment-backed bearer token and receives server instructions and callable tools.
- [ ] Claude Code connects to the same endpoint using an environment-expanded Authorization header.
- [ ] Both hosts discover the correct least-privilege tool set and successfully call public, authenticated, structured, and rich-content fixtures.
- [ ] Both hosts surface insufficient-scope and revoked-token behavior without gaining access.
- [ ] No real token, provider credential, host account secret, or generated config containing secrets is committed.
- [ ] The tested host versions, commands/configuration, results, and any host-specific limitations are recorded reproducibly.

### Implementation notes

- Use current documented Streamable HTTP configuration for each host.
- Prefer noninteractive repeatable smoke commands, but retain HITL classification where host login/approval is unavoidable.
- Do not broaden this issue into OAuth or host-specific packaging.

## Blocked by

- `ISSUE-12`
- `ISSUE-17`

## User stories addressed

- User stories 41–42, 69

### Test plan

- Run the same endpoint/token fixtures in both hosts and capture server-side protocol/authorization evidence.
- Revoke during a host session and verify subsequent calls fail.
- Repeat with only public tools and with a deliberately insufficient scope grant.

### Out of scope

- OAuth login, provider-hosted packaging, Claude Desktop-specific packaging, stdio, model-quality evaluation, and permanent external test infrastructure.
