# Scopes and wildcards are the one authorization vocabulary

AckerDB had two authorization systems. `access` — `"public" | "authenticated" |
"system" | (ctx, args) => boolean` — decided who may call a function, and a
separate MCP subsystem carried scope descriptors, a token vault, token-bound
principals, and its own revocation registry, for agents alone. Roughly 1,100
lines existed only because an agent's authority was modelled as a thing that is
not a user. An application that wanted permissions for its *own* users had
nothing to build on and wrote a bespoke system inside its access callbacks.

We collapse both into one: **scopes are AckerDB's authorization vocabulary,
carried by every Identity, and an agent is an Identity.**

## The vocabulary

An application declares its scopes once, in `defineApp({ scopes })`. The
framework pre-declares its own under the reserved marker `_`, and an application
may never declare a name carrying it. That single character is what lets `*`
mean "every application scope" and `_*` mean "every framework scope" without
either side enumerating the other. The alternative — two namespaces with two
sets of rules, which is what the MCP subsystem had — needs a translation layer
at every boundary and a decision about which one wins wherever they meet.

The vocabulary is a closed set, so authorization is membership in a known
collection rather than string comparison against a guess. A requirement naming a
scope nobody declared is a startup refusal, not a call that quietly never
passes.

## One funnel

`app/invocation.ts` already compiled `access` once per registered function and
ran it on the single path every entry reaches a handler through — client call,
HTTP, MCP tool, nested server-side call. The scope requirement is enforced
there, immediately after the base policy, and nowhere else. A second checkpoint
would be a second thing to keep in sync with the first, and the first is already
the only one that cannot be bypassed.

`access: "public"` with a scope requirement is a registration error: an
anonymous caller can never hold a scope, so the combination describes a function
nobody can call. `"system"` with one is equally an error, because system
authority is the framework's own and bypasses scopes — a rule that silently
never fires is worse than no rule. Both are refused where they are written.

## Grants carry wildcards; requirements stay concrete

A wildcard is a simple glob, not a pattern language: `ad*` matches every known
scope starting with `ad`, and `*` may appear only as the last character. One
carve-out — a bare `*` does not match a name beginning with the reserved marker.
That is the entire special case, and it is exactly one, because any non-empty
prefix that does not itself begin with `_` already cannot match a name that
does.

The asymmetry is deliberate. A grant is issued once and lives for a long time,
often against a vocabulary that will grow; a wildcard is how a credential minted
today covers a domain declared next month. A requirement is read by whoever
audits the function, and `{ anyOf: ["notes:*"] }` would ask the reader to hold a
vocabulary in their head to know what it admits. So a requirement names exactly
what it needs.

Checking is **expansion, then membership**: expand the holder's patterns against
the currently known vocabulary, then test the requirement's concrete scopes
against the result. This is the same operation at issuance and at use, which is
why child credentials keep the shape they had before wildcards existed — the
subset check at issuance and the intersection at use both compare expanded sets.
Expansion happens once, when a principal is built, so the funnel does a plain
membership test per call rather than re-running glob matching on the hot path.

Because authority is what a grant *expands to*, a pattern matching nothing
grants nothing — the fail-closed answer. A *concrete* entry is held to a
stricter rule and must name a scope that exists: it addresses one exact thing,
so a name nothing answers to is a typo, and a typo that silently produces a
powerless credential is a support ticket rather than an error message.

## There is no administrative flag

An administrative identity is one holding `["*", "_*"]`. The rejected
alternative, an `admin: true` implying every authority, needs a rule at every
check for what implication means, cannot express "almost everything", and makes
issuing a *narrower* agent credential a special case rather than the same
operation with a shorter list. Two patterns cost nothing the machinery does not
already do, and an operator can read a credential's authority off its grant
without knowing which flags the framework honours.

## Agents are users

An identity credential is an Identity: issuing one mints an Identity row, and
the bearer authenticates into an ordinary `user` principal. Fairness keying,
File ownership, analytics attribution, telemetry, and every access callback
therefore work on an agent without knowing it came from a token, and the
`McpPrincipal` special case that each of those sites had to remember is gone
along with the vault, descriptor, context, and invalidation machinery that
served it — about 1,100 lines replaced by one vault and a small tool-access
predicate.

The credential's synthetic external account (`ackerdb:credentials`, subject =
token id) is what makes this cheap: a revocation or grant change is an ordinary
account invalidation on the one generic auth-invalidation path, so live
WebSocket sessions, subscriptions and HTTP leases re-authorize immediately
through the channel they already subscribe to. Shipping enforcement without that
propagation would be a security regression, not a smaller version of the
feature, so it is part of the contract rather than a later optimization.

## Consequences

- One breaking storage change: `_ackerdb_mcp_tokens` is replaced by
  `_ackerdb_credentials` (engine schema 13). There is no compatibility shim;
  0.16.0 databases carrying MCP tokens must reissue them.
- `mcpAuth` and the `mcp({ auth })` field are deleted. A tool entry's `access`
  draws from the application vocabulary like every function requirement.
- A vault-prefixed bearer can never reach an application's `credentialVerifier`:
  the Runtime's composed authority is branded, and verification fails closed
  without that brand.
- A credential is non-expiring by construction. Nothing but invalidation revokes
  it, which is why the lease and session expiry paths now skip a non-finite
  deadline instead of scheduling a timer for it.
- The framework's own vocabulary is empty until the Admin API declares
  `_admin:<domain>:<verb>`. `_*` is still meaningful before then: it is what an
  administrative grant names, and it grows with that list rather than needing to
  be reissued.
