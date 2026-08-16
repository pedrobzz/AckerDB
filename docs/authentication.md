# Authentication and authorization

AckerDB accepts exactly two remote credential forms: explicit anonymous access or
a bearer token verified by a configured `CredentialVerifier`. Authentication
establishes an immutable principal; each function's `access` policy separately
decides whether that principal may perform the operation.

## Credentials and principals

`AckerDBClientOptions.credential` is required. A WebSocket sends that credential
in its `hello` frame and can replace it in-band with
`client.refreshCredential(...)`. HTTP procedures and SSE procedures send the
same credential as an `Authorization` header on every request.

HTTP parsing is intentionally strict:

- no `Authorization` header means `{ kind: "anonymous" }`;
- `Bearer <token>` is accepted with a case-insensitive scheme and exactly one
  non-empty token containing no whitespace or comma; and
- Basic auth, multiple credentials, extra whitespace, and malformed bearer
  values produce `unauthenticated`.

All transports then use `verifyClientCredential`. A bearer credential without
a configured verifier fails closed as `unauthenticated`. A verified user result
is credential evidence, not yet an application principal: AckerDB snapshots that
evidence, then transactionally resolves its exact `(issuer, subject)` through
the Engine-owned identity directory before constructing the user principal.

### Trust boundary

Credentials, token claims, and authorization arguments are untrusted until the
owning boundary has validated them. With the built-in OIDC verifier, AckerDB owns
the exact issuer registry, JWT/JWS verification, selected-claim allowlist, and
expiry check; the configured HTTPS JWKS endpoint is the external trust and
availability dependency. A token's unverified `iss` value can select only an
already configured provider and cannot choose a network destination.

The CLI listener itself is plaintext HTTP/WebSocket on loopback and does not
terminate TLS. A bearer deployment must keep that hop private or place it behind
a trusted TLS terminator; otherwise Authorization headers and WebSocket hello
credentials cross the network without transport encryption. AckerDB derives
anonymous fairness identity from the peer socket and ignores `Forwarded` and
`X-Forwarded-For`, so callers behind one reverse proxy share the proxy's source
group rather than trusting a spoofable header.

CLI-created servers stay on loopback; a programmatic server binds wherever its
`hostname` option names.

`CredentialVerifier` is the extension boundary. A custom verifier—not AckerDB—is
responsible for authenticating the credential, validating issuer/audience and
any deployment-specific claims. It must expose `revocationBound` metadata and
an invalidation subscription. An invalidation-based verifier must advertise a
positive finite `deadlineMs` no greater than the configured
`revocationDeadlineMs`; the Runtime owns the single configured verifier and
validates that declaration before application traffic is activated. Sessions
and remote credential leases enforce expiry and react immediately to matching callbacks,
but AckerDB neither creates nor measures the external invalidation feed or its
upstream propagation latency. Delivering invalidations within the advertised
bound remains the verifier's responsibility. `verifyClientCredential` rejects
invalid evidence and results that expire before or during Identity resolution,
deeply freezes selected claims, and maps unexpected verifier or resolver
failures to retryable `auth_unavailable`. Claims remain current credential
provenance and are never copied into the durable identity directory.
Applications should authorize only from the resulting principal and explicitly
selected claims, never from an unverified token body.

| Principal | Fields and meaning |
| --- | --- |
| `anonymous` | No external identity. Public policies may admit it. |
| `user` | Non-null branded `identity`, plus `issuer`, `subject`, deeply frozen selected `claims`, `expiresAt` in Unix milliseconds, and nullable `tokenId`. `identity` is the durable provider-neutral key for application rows. |
| `workload` | The verified issuer/subject fields, for service-to-service authority and protected operational status. Workloads have no application Identity. |
| `system` | Local runtime authority used by scheduled handlers. A remote session cannot become `system`. |

`ctx.auth`, selected claims, and validated arguments are frozen. After narrowing
`ctx.auth.kind === "user"`, `ctx.auth.identity` is the typed non-null Identity to
store in application ownership columns. Direct nested query and mutation calls
inherit the original principal; a nested call cannot replace it with a more
privileged context.

### Explicit account linking

Applications may opt in to cross-provider continuity by exporting a procedure
that calls `ctx.linkAccount(rawBearerToken)`. The argument is the second
account's raw bearer token, not an `Authorization` header. The capability exists
only on procedure and SSE contexts; query, mutation, and transaction contexts
cannot invoke it.

AckerDB first verifies the token through the Runtime's same configured verifier,
with no writer transaction open. It then enters the canonical writer and
atomically attaches the verified exact `(issuer, subject)` to the current
user's durable Identity. Linking is idempotent when that account already belongs
to the same Identity. An account owned by another Identity returns a generic
conflict without revealing its owner. AckerDB never allocates a new Identity,
auto-links by mutable claims, merges Identities, or rewrites application rows
through this primitive.

### Explicit account unlinking

Applications may opt in to the inverse operation from a procedure or SSE
procedure with `ctx.unlinkAccount({ issuer, subject })`. The current user must
own that exact account, and the same transaction refuses to remove the
Identity's final account. A successful unlink deletes only the directory link:
the durable Identity and every application row owned by it remain unchanged.

After commit, AckerDB publishes an exact-account invalidation through the
Runtime's canonical authentication boundary, so matching sessions and remote
credential leases fail closed; rollback publishes nothing. Authenticating
later with the removed credential follows normal first-login resolution and
may provision a new Identity. This primitive is not full-user deletion,
provider-side revocation, or application-data erasure.

## Application-defined credential verifier

An application can make its own `CredentialVerifier` the CLI server's single
authentication authority by setting a module path in `.ackerdb.config.json`:

```json
{
  "credentialVerifier": "./auth/credential-verifier.ts"
}
```

The path is resolved relative to the application directory. The module must
default-export the verifier object itself—not a factory or promise:

```ts
import type { CredentialVerifier } from "@ackerdb/server";
import { verifyApplicationToken } from "./tokens.ts";

const verifier = {
  revocationBound: { kind: "token-expiration" },
  verify: verifyApplicationToken,
  subscribeInvalidation: () => () => {},
} satisfies CredentialVerifier;

export default verifier;
```

`acker dev` and `acker start` load that default export through the same Runtime
pipeline as the built-in OIDC verifier. `acker codegen` never imports or executes
the verifier module; during `acker start`, codegen finishes before application
modules and the verifier are loaded.

`oidc` and `credentialVerifier` are mutually exclusive because one Runtime has
one credential authority. Programmatic startup follows the same rule and can
inject an already-constructed verifier without a parallel server path:

```ts
import { loadConfig, runCodegen, startApp } from "@ackerdb/cli";
import credentialVerifier from "./auth/credential-verifier.ts";

await startApp(loadConfig("."), {
  prepare: runCodegen,
  credentialVerifier,
});
```

The programmatic `credentialVerifier` option cannot be combined with either
configured source. Application verifiers own token parsing, cryptographic
verification, issuer and audience policy, expiry, selected claims, and any
advertised invalidation feed. AckerDB still validates returned credential evidence,
resolves user `(issuer, subject)` pairs to durable Identities, and enforces the
declared revocation bound before activation.

### Verifier error contract

A verifier's rejection outcome is part of its contract. For an invalid
credential, throw the `unauthenticated()` helper exported from
`@ackerdb/server` (or an `AckerDBError` with code `unauthenticated`): the
presentation rejects immediately and non-retryably. Anything else a verifier
throws — a jose error, a network failure, a plain `Error` — is treated as
verifier *unavailability* and surfaces as retryable `auth_unavailable`, which
clients keep retrying for tens of seconds. A verifier that lets jose's
`JWTExpired` escape unmapped therefore turns every bad token into a long
retry loop instead of an instant rejection:

```ts
import { unauthenticated, type CredentialVerifier } from "@ackerdb/server";
import { jwtVerify } from "jose";

const verifier = {
  revocationBound: { kind: "token-expiration" },
  subscribeInvalidation: () => () => {},
  verify: async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, keySet, verifyOptions);
      return evidenceFrom(payload);
    } catch (cause) {
      throw unauthenticated(cause);
    }
  },
} satisfies CredentialVerifier;
```

Reserve non-`unauthenticated` throws for failures where retrying can
genuinely succeed, such as the verifier's own key service being unreachable.

## Function access policies

Every query, mutation, procedure, SSE procedure, and event subscription must
declare one policy:

| Policy | Result |
| --- | --- |
| `"public"` | Admits anonymous and verified callers. |
| `"authenticated"` | Rejects `anonymous`; admits verified users/workloads and local system work. |
| `"system"` | Admits only the local `system` principal. |
| `(ctx, args) => boolean \| Promise<boolean>` | Admits only the exact result `true`. `false`, any other value, and exceptions fail closed. |

A built-in-policy denial or callback result other than exact `true` gives an
anonymous caller `unauthenticated` and a non-anonymous caller `unauthorized`.
A policy callback that throws is always sanitized to `unauthorized`, regardless
of principal, and its cause is not exposed. Access is checked after argument
validation and before the handler starts. Nested calls run the callee's
validation and policy too.

A function may additionally declare a `scopes` requirement, enforced at this
same funnel immediately after the policy above. The policy decides whether a
caller is admitted at all; the requirement decides what an admitted caller may
reach. See [Scopes and identity credentials](scopes.md) for the vocabulary,
wildcard grants, and the credential capability that issues them.

## External OIDC configuration

The CLI reads OIDC configuration from `.ackerdb.config.json` and passes it to
`createOidcVerifier`. AckerDB is a relying party only: it does not implement login,
passwords, passkeys, token issuance, or OIDC discovery.

A provider entry is either the full field-by-field configuration below or a
**provider preset** — `{ "preset": "clerk" | "auth0" | "workos" |
"betterauth", "issuer": "…", … }` — the provider's published token shape
resolved into exact configuration at startup. Presets never weaken
verification: they fill in only the fields whose values follow from what the
provider mints, refuse the ones that cannot be defaulted (Auth0's API
audience, WorkOS's client ID), accept the same overrides as the full form,
and `resolveOidcProvider` (exported from `@ackerdb/server`) returns the exact
configuration any preset stands for. Per-provider recipes and the resolved
form of each preset live in [Auth providers](auth-providers.md).

```json
{
  "oidc": {
    "providers": [
      {
        "issuer": "https://identity.example.com/",
        "jwksUri": "https://identity.example.com/.well-known/jwks.json",
        "audiences": ["ackerdb-api"],
        "algorithms": ["RS256"],
        "tokenType": "at+jwt",
        "principalKind": "user",
        "requiredClaims": ["iat"],
        "claimNames": ["email", "roles"],
        "maxTokenAgeSeconds": 3600
      },
      {
        "issuer": "https://workloads.example.com/",
        "jwksUri": "https://workloads.example.com/jwks.json",
        "audiences": ["ackerdb-operations"],
        "algorithms": ["ES256"],
        "tokenType": "at+jwt",
        "principalKind": "workload",
        "claimNames": ["scope"]
      }
    ],
    "jwksTimeoutMs": 5000,
    "jwksCooldownMs": 30000,
    "jwksCacheMaxAgeMs": 600000,
    "clockToleranceSeconds": 5
  },
  "statusScope": "ackerdb:status"
}
```

The issuer string is an **exact issuer**: it is validated as a well-formed URL
on a permitted scheme, then stored and matched byte-exactly against the
token's `iss` — never normalized or rewritten. There is exactly one correct
value per provider: whatever that provider actually mints, trailing slash or
not. Issuer strings cannot contain whitespace, control characters,
credentials, fragments, or queries. JWKS URLs cannot contain credentials or
fragments. Providers are an exact registry and duplicate issuers are
rejected. Per-provider recipes with each provider's exact `iss` string live
in [Auth providers](auth-providers.md).

Both URLs obey the **private plaintext boundary**: HTTPS is accepted
everywhere, and plaintext `http:` is permitted by default only on loopback
hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), where it cannot
cross a network at all. Private-network IP literals (RFC 1918, link-local,
IPv6 ULA and link-local) additionally require the provider's explicit
`allowPrivateNetworkHttp: true` — private ranges are attackable networks
(Wi-Fi, corporate LAN, VPN, cloud VPC), and an on-path peer that rewrites a
plaintext JWKS response mints accepted tokens, so crossing them without TLS
is a visible per-provider declaration, never a default. Public hosts and
named non-localhost hosts never accept plaintext, declaration or not, in any
mode.

`audiences` is either a non-empty list of accepted `aud` values or the
explicit literal `"unchecked"`; `tokenType` is either the required JOSE
`typ` header value or `"unchecked"`. This is **unchecked enforcement**: a
verification dimension is always either fully specified or visibly declared
unchecked in the configuration — never silently absent by default. An empty
`audiences` array stays forbidden. Declare `"unchecked"` only when the
provider genuinely does not mint the claim or header (see the recipes);
every dimension left declared stays fully enforced.

An unverified JWT is decoded only to select an already configured issuer. An
unknown issuer fails before any network request. The selected provider then
verifies all of the following with `jose`:

- exact issuer, one configured audience (unless `"unchecked"`), one
  configured asymmetric algorithm, and the configured JOSE `typ` (unless
  `"unchecked"`);
- required `exp` and non-empty `sub`, plus every `requiredClaims` entry;
- optional `maxTokenAgeSeconds` (which requires a valid `iat` through the JOSE
  verification path); and
- `jti` as a string when present.

Claim projection is a declaration like every other dimension: `claimNames`
is required and is either a non-empty list of claims to copy to
`ctx.auth.claims` or the explicit `"none"` for the empty projection. Verified
claims outside the selection are discarded — that stays deliberate claim
minimization, but discarding everything is now a visible choice instead of a
silent default a newcomer discovers when every claim-based policy fails. In
particular, a workload provider used for `GET /status` must select the
`scope` claim.

Supported algorithms are `RS256`, `PS256`, `ES256`, and `EdDSA`. The verifier
does not accept an algorithm merely because the token requests it. `tokenType`
must be a non-empty string of at most 128 characters, and `principalKind` must
be exactly `user` or `workload`.

### Verifier bounds

| Setting | Default | Hard/configuration rule |
| --- | ---: | --- |
| providers | none | 1–32 required |
| `maxTokenBytes` | 16 KiB | cannot exceed 16 KiB |
| `jwksTimeoutMs` | 5,000 ms | cannot exceed 5,000 ms |
| `jwksMaxBytes` | 1 MiB | cannot exceed 1 MiB |
| `jwksCooldownMs` | 30,000 ms | finite and non-negative |
| `jwksCacheMaxAgeMs` | 600,000 ms | positive integer |
| `maxJwksKeys` | 32 | cannot exceed 32 |
| `clockToleranceSeconds` | 5 s | finite and non-negative |

A provider may configure at most 32 audiences, 8 algorithms, and 64 required
or selected claim names. Values are non-empty, unique, and at most 256
characters. JWKS fetches use the one configured URL, disable redirect following,
bound the response bytes and key count, and treat malformed or unavailable key
sets as `auth_unavailable`.

Bad, expired, or cryptographically invalid credentials produce non-retryable
`unauthenticated`. Unexpected verifier/network/key-service failures produce
retryable `auth_unavailable`. Internal causes are not put on the wire.

## Long-lived sessions

A successful WebSocket refresh is an ordered auth transition:

1. new operations and application delivery pause;
2. old-epoch operations are aborted;
3. the credential is fully verified, then queued old-epoch application frames
   are removed;
4. the server increments `authEpoch`, revokes old query streams, and reattaches
   remembered query/event subscriptions under the new principal; and
5. transition/reset/error frames are delivered before the auth acknowledgement
   makes the connection active again.

Passing `{ kind: "anonymous" }` to `refreshCredential` signs out through the
same path. A failed or timed-out refresh closes or auth-blocks the session; the
old principal is never silently restored.

Every accepted bearer presentation — the `welcome` and each `auth`
acknowledgement — carries `credentialTtlMs`, the server's **credential TTL
disclosure**: the remaining validity of the accepted credential as a relative
duration, computed at frame send — or `null` for a credential that does not
expire. It exists so a client can refresh proactively without assuming any
credential format (client-side token parsing would break the format-opaque
`credentialVerifier` contract). Anonymous principals disclose nothing. The
client's [credential source](client-react.md#credential-source) schedules its
proactive re-pull from this disclosure, and arms nothing for `null`: an
[identity credential](scopes.md#identity-credentials) ends by revocation rather
than by the clock, so there is no expiry to get ahead of. The field is still
always present, because a client must never have to read silence as a value.

The server owns a hard timer for `expiresAt` and closes a session that is not
refreshed in time. The built-in OIDC verifier advertises
`{ kind: "token-expiration" }`: cached JWKS key rotation is not token
revocation, and there is no built-in introspection or provider back-channel.

A custom `CredentialVerifier` can instead declare
`{ kind: "invalidation", deadlineMs }` and publish invalidations by issuer and
optionally subject or token ID. `deadlineMs` must be positive and finite and
cannot exceed the Session `revocationDeadlineMs` ceiling (5 seconds by default
and at most); AckerDB rejects a missing, malformed, or over-ceiling advertisement
before the Runtime is activated. Matching connected sessions
begin their reserved fail-closed path immediately when the callback fires. The
advertisement is the verifier's integration contract: the deployment remains
responsible for the invalidation source and for delivering its callback to
AckerDB within the advertised bound.

## HTTP and SSE credential leases

Remote bearer authentication remains live after initial verification. Each
remote HTTP path that verifies a bearer credential owns a credential lease
with an exact expiry timer and a matching invalidation subscription. An
anonymous request allocates neither a verifier listener nor an expiry timer.

For an HTTP procedure, AckerDB holds the lease through Runtime execution,
wire encoding, and handoff of the constructed `Response`. Expiry, a
matching invalidation, or caller cancellation aborts the Runtime signal and
prevents it from accepting a stale result. The lease releases at that encoded
`Response` handoff, not at response-body or network completion.
`ProcedureCtx.abortSignal` exposes the combined request, credential, and
Runtime-shutdown signal so long-running asynchronous work can cooperate;
`SseCtx` inherits the same field.

For SSE, ownership transfers to the response body. The lease remains held
until that body completes, errors, or is canceled, and those same abort sources
fail the Runtime producer closed. The response body itself remains open while
the Runtime owns unacknowledged wire frames: application chunks require a
valid capability/proof acknowledgement, and completion or failure requires a
terminal acknowledgement or finite terminal-grace expiry. The acknowledgement
endpoint deliberately carries no bearer credential and performs no second
identity verification; its unguessable stream/frame capabilities authorize
only byte release, while the original SSE lease continues to own the verified
principal and revocation signal. This proves receiver participation in the
wire exchange, not durable processing of application side effects.

## Operational status authority

`GET /status` is not a user endpoint. It requires a `workload` principal whose
selected string `scope` claim contains the exact configured `statusScope` token
(default `ackerdb:status`, split on spaces). Anonymous callers, user principals,
and workloads without that scope receive an authorization failure. Liveness
and readiness are intentionally unauthenticated; see
[Operations](operations.md#health-and-protected-status).

## Authentication limitations

- AckerDB consumes external JWT access tokens; it does not issue credentials or
  manage browser sessions.
- The built-in OIDC path uses configured issuer/JWKS entries, not discovery,
  introspection, refresh tokens, or logout protocols.
- Built-in revocation is bounded by token expiry. Immediate invalidation needs
  a custom verifier and an external source of truth.
- Authorization is function/event-policy based. AckerDB does not expose a
  general-purpose row-level-security engine for arbitrary client SQL.
