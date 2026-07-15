# Authentication and authorization

DBZZ accepts exactly two remote credential forms: explicit anonymous access or
a bearer token verified by a configured `CredentialVerifier`. Authentication
establishes an immutable principal; each function's `access` policy separately
decides whether that principal may perform the operation.

## Credentials and principals

`DbzzClientOptions.credential` is required. A WebSocket sends that credential
in its Protocol 2 `hello` frame and can replace it in-band with
`client.refreshCredential(...)`. HTTP procedures and SSE procedures send the
same credential as an `Authorization` header on every request.

HTTP parsing is intentionally strict:

- no `Authorization` header means `{ kind: "anonymous" }`;
- `Bearer <token>` is accepted with a case-insensitive scheme and exactly one
  non-empty token containing no whitespace or comma; and
- Basic auth, multiple credentials, extra whitespace, and malformed bearer
  values produce `unauthenticated`.

All transports then use `verifyClientCredential`. A bearer credential without
a configured verifier fails closed as `unauthenticated`.

### Trust boundary

Credentials, token claims, and authorization arguments are untrusted until the
owning boundary has validated them. With the built-in OIDC verifier, DBZZ owns
the exact issuer registry, JWT/JWS verification, selected-claim allowlist, and
expiry check; the configured HTTPS JWKS endpoint is the external trust and
availability dependency. A token's unverified `iss` value can select only an
already configured provider and cannot choose a network destination.

The CLI listener itself is plaintext HTTP/WebSocket on loopback and does not
terminate TLS. A bearer deployment must keep that hop private or place it behind
a trusted TLS terminator; otherwise Authorization headers and WebSocket hello
credentials cross the network without transport encryption. DBZZ derives
anonymous fairness identity from the peer socket and ignores `Forwarded` and
`X-Forwarded-For`, so callers behind one reverse proxy share the proxy's source
group rather than trusting a spoofable header.

`CredentialVerifier` is the extension boundary. A custom verifier—not DBZZ—is
responsible for authenticating the credential, validating issuer/audience and
any deployment-specific claims. It must expose `revocationBound` metadata and
an invalidation subscription. An invalidation-based verifier must advertise a
positive finite `deadlineMs` no greater than the configured
`revocationDeadlineMs`; Session and `DbzzServer` construction validate that
declaration before a session or HTTP listener opens. Sessions and remote
credential leases enforce expiry and react immediately to matching callbacks,
but DBZZ neither creates nor measures the external invalidation feed or its
upstream propagation latency. Delivering invalidations within the advertised
bound remains the verifier's responsibility. `verifyClientCredential` still
rejects an invalid principal shape or expired result, freezes the returned
principal and claims, and maps unexpected verifier failures to retryable
`auth_unavailable`. Applications should authorize only from the resulting
principal and explicitly selected claims, never from an unverified token body.

| Principal | Fields and meaning |
| --- | --- |
| `anonymous` | No external identity. Public policies may admit it. |
| `user` | `issuer`, `subject`, deeply frozen selected `claims`, `expiresAt` in Unix milliseconds, and nullable `tokenId`. |
| `workload` | The same verified fields, for service-to-service authority and protected operational status. |
| `system` | Local runtime authority used by scheduled handlers. A remote session cannot become `system`. |

`ctx.auth`, selected claims, and validated arguments are frozen. Direct nested
query and mutation calls inherit the original principal; a nested call cannot
replace it with a more privileged context.

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

## External OIDC configuration

The CLI reads OIDC configuration from `.zdb.config.json` and passes it to
`createOidcVerifier`. DBZZ is a relying party only: it does not implement login,
passwords, passkeys, token issuance, or OIDC discovery.

```json
{
  "oidc": {
    "providers": [
      {
        "issuer": "https://identity.example.com/",
        "jwksUri": "https://identity.example.com/.well-known/jwks.json",
        "audiences": ["dbzz-api"],
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
        "audiences": ["dbzz-operations"],
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
  "statusScope": "dbzz:status"
}
```

The issuer string must already equal the canonical HTTPS URL produced by
`new URL(issuer).href`; for a bare origin this includes the trailing slash.
Issuer URLs cannot contain credentials, fragments, or queries. JWKS URLs must
also be HTTPS and cannot contain credentials or fragments. Providers are an
exact registry and duplicate issuers are rejected.

An unverified JWT is decoded only to select an already configured issuer. An
unknown issuer fails before any network request. The selected provider then
verifies all of the following with `jose`:

- exact issuer, one configured audience, one configured asymmetric algorithm,
  and the configured JOSE `typ`;
- required `exp` and non-empty `sub`, plus every `requiredClaims` entry;
- optional `maxTokenAgeSeconds` (which requires a valid `iat` through the JOSE
  verification path); and
- `jti` as a string when present.

Only names in `claimNames` are copied to `ctx.auth.claims`. Omitting
`claimNames` produces an empty claims object even though the token was fully
verified. In particular, a workload provider used for `GET /status` must select
the `scope` claim.

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

The server owns a hard timer for `expiresAt` and closes a session that is not
refreshed in time. The built-in OIDC verifier advertises
`{ kind: "token-expiration" }`: cached JWKS key rotation is not token
revocation, and there is no built-in introspection or provider back-channel.

A custom `CredentialVerifier` can instead declare
`{ kind: "invalidation", deadlineMs }` and publish invalidations by issuer and
optionally subject or token ID. `deadlineMs` must be positive and finite and
cannot exceed the Session `revocationDeadlineMs` ceiling (5 seconds by default
and at most); DBZZ rejects a missing, malformed, or over-ceiling advertisement
before a session or `DbzzServer` listener opens. Matching connected sessions
begin their reserved fail-closed path immediately when the callback fires. The
advertisement is the verifier's integration contract: the deployment remains
responsible for the invalidation source and for delivering its callback to
DBZZ within the advertised bound.

## HTTP and SSE credential leases

Remote bearer authentication remains live after initial verification. Each
remote HTTP path that verifies a bearer credential owns a credential lease
with an exact expiry timer and a matching invalidation subscription. An
anonymous request allocates neither a verifier listener nor an expiry timer.

For an HTTP procedure, DBZZ holds the lease through Runtime execution,
Protocol 2 encoding, and handoff of the constructed `Response`. Expiry, a
matching invalidation, or caller cancellation aborts the Runtime signal and
prevents it from accepting a stale result. The lease releases at that encoded
`Response` handoff, not at response-body or network completion.
`ProcedureCtx.abortSignal` exposes the combined request, credential, and
Runtime-shutdown signal so long-running asynchronous work can cooperate;
`SseCtx` inherits the same field.

For SSE, ownership transfers to the response body. The lease remains held
until that body completes, errors, or is canceled, and those same abort sources
fail the Runtime producer closed. The response body itself remains open while
the Runtime owns unacknowledged Protocol 2 frames: application chunks require a
valid capability/proof acknowledgement, and completion or failure requires a
terminal acknowledgement or finite terminal-grace expiry. The acknowledgement
endpoint deliberately carries no bearer credential and performs no second
identity verification; its unguessable stream/frame capabilities authorize
only byte release, while the original SSE lease continues to own the verified
principal and revocation signal. This proves receiver participation in the
Protocol 2 exchange, not durable processing of application side effects.

## Authentication telemetry

When telemetry is enabled, credential verification for an HTTP procedure or
SSE call emits a sanitized `auth` span. A parsed call carries the same
request/function trace through Runtime: an HTTP procedure keeps it through the
encoded `Response` handoff, while SSE keeps it through the Runtime producer's
acknowledged terminal path or terminal-grace force close. Malformed calls or
credential failures before Runtime still close their own pre-Runtime trace and
emit one sanitized failure event. HTTP response handoff does not claim network
receipt; SSE delivery observations classify valid receiver acknowledgement,
cancellation, and terminal timeout without capturing the capability or chunk.

WebSocket hello, bearer refresh, and anonymous sign-out verification use
separate lifecycle traces. Their connection correlation is a hash of the client
session ID, and their request correlation is `hello` or the auth attempt ID.
Telemetry never records credentials, authorization headers, principals/claims,
arguments, results, stream chunks, or verifier error messages/causes. Disabled
telemetry attaches no auth observer or trace state. See
[Telemetry](telemetry.md#credential-verification-correlation) for the exact
stages, ownership, and limitations.

## Operational status authority

`GET /status` is not a user endpoint. It requires a `workload` principal whose
selected string `scope` claim contains the exact configured `statusScope` token
(default `dbzz:status`, split on spaces). Anonymous callers, user principals,
and workloads without that scope receive an authorization failure. Liveness
and readiness are intentionally unauthenticated; see
[Operations](operations.md#health-and-protected-status).

## Authentication limitations

- DBZZ consumes external JWT access tokens; it does not issue credentials or
  manage browser sessions.
- The built-in OIDC path uses configured issuer/JWKS entries, not discovery,
  introspection, refresh tokens, or logout protocols.
- Built-in revocation is bounded by token expiry. Immediate invalidation needs
  a custom verifier and an external source of truth.
- Authorization is function/event-policy based. DBZZ does not expose a
  general-purpose row-level-security engine for arbitrary client SQL.
