# Auth providers

Per-provider recipes for the built-in `oidc` configuration. AckerDB is a
relying party only — the provider owns sign-in, and AckerDB verifies what it
mints. The contract behind every recipe is in
[Authentication](authentication.md): issuers are matched byte-exactly as
written, and audience/token-type enforcement is either fully specified or
explicitly `"unchecked"`, never silently absent.

Each recipe was derived from a working integration and is regression-tested
by the provider conformance suite, which mints tokens with each provider's
exact shape (issuer form, claim set, `typ` header, algorithm) and asserts the
full accept/reject matrix. Any spec-compliant issuer that publishes JWKS and
mints one of these shapes works the same way; a provider that cannot (opaque
tokens, shared-secret HS256, session cookies) is a
[`credentialVerifier`](authentication.md#application-defined-credential-verifier)
case instead.

On the client, every recipe uses the same wiring: pass the provider SDK's
token getter to the client as a
[credential source](client-react.md#credential-source) and let the client own
the refresh lifecycle.

## Clerk

Clerk mints session tokens with a **bare-origin issuer** (no trailing slash)
and **no `aud` claim**, with `typ: "JWT"` and a 60-second lifetime. Copy the
issuer exactly as it appears in your Clerk instance's JWT — do not add a
slash.

```json
{
  "oidc": {
    "providers": [
      {
        "issuer": "https://your-app.clerk.accounts.dev",
        "jwksUri": "https://your-app.clerk.accounts.dev/.well-known/jwks.json",
        "audiences": "unchecked",
        "algorithms": ["RS256"],
        "tokenType": "JWT",
        "principalKind": "user",
        "claimNames": ["azp", "sid"]
      }
    ]
  }
}
```

Client: `credentialSource` wraps Clerk's `getToken()`; signed out, Clerk
returns `null`, which the source maps to the explicit anonymous credential.
The 60-second tokens make the client's TTL-driven proactive refresh do real
work — expect a source pull roughly every 48 seconds.

Gotchas: a Clerk JWT template can add an `aud` claim if you prefer declared
audiences over `"unchecked"`. Development and production instances mint
different issuers — each is its own provider entry.

## WorkOS AuthKit

AuthKit access tokens carry a **bare-origin issuer** (`https://api.workos.com`,
no slash), **no `aud` claim**, and an undocumented `typ` header — declare
both dimensions `"unchecked"`.

```json
{
  "oidc": {
    "providers": [
      {
        "issuer": "https://api.workos.com",
        "jwksUri": "https://api.workos.com/sso/jwks/client_YOUR_CLIENT_ID",
        "audiences": "unchecked",
        "algorithms": ["RS256"],
        "tokenType": "unchecked",
        "principalKind": "user",
        "claimNames": ["sid", "org_id", "role"]
      }
    ]
  }
}
```

Client: `credentialSource` wraps AuthKit's `useAccessToken()`/`getAccessToken()`.

Gotchas: verify the exact `iss` your tenant mints by decoding one real token —
WorkOS has used both the bare API origin and
`https://api.workos.com/user_management/<client_id>`; the configured string
must equal it byte-for-byte. A WorkOS JWT template may be able to add `aud`.

## Auth0

Auth0 mints a **trailing-slash issuer** (`https://tenant.auth0.com/`) and
always includes `aud`, so the fully-declared configuration works with no
opt-outs. **An API audience is mandatory on the Auth0 side**: a SPA without a
registered API audience receives opaque tokens, not JWTs.

```json
{
  "oidc": {
    "providers": [
      {
        "issuer": "https://your-tenant.auth0.com/",
        "jwksUri": "https://your-tenant.auth0.com/.well-known/jwks.json",
        "audiences": ["https://api.your-app.example"],
        "algorithms": ["RS256"],
        "tokenType": "JWT",
        "principalKind": "user",
        "claimNames": ["azp", "scope"]
      }
    ]
  }
}
```

Client: `credentialSource` wraps `getAccessTokenSilently()` from
`@auth0/auth0-react`.

Gotchas: `tokenType` must match your tenant's access-token profile — the
default profile mints `typ: "JWT"`, the RFC 9068 profile mints
`typ: "at+jwt"`; a mismatch hard-rejects. The trailing slash on the issuer is
mandatory because Auth0 mints it.

## BetterAuth

BetterAuth's JWT plugin signs with **EdDSA** by default and hardcodes the
protected header to `{alg, kid}` — there is no `typ` and no way to configure
one, so `tokenType` must be `"unchecked"`. Self-hosted locally it is a
plaintext HTTP issuer: loopback addresses work with no further declaration,
and reaching it over your machine's LAN IP (testing from a phone) requires
the provider's explicit `allowPrivateNetworkHttp: true` — plaintext across a
private network is an interceptable hop, so it is a visible declaration.

```json
{
  "oidc": {
    "providers": [
      {
        "issuer": "http://localhost:3000",
        "jwksUri": "http://localhost:3000/api/auth/jwks",
        "audiences": "unchecked",
        "algorithms": ["EdDSA"],
        "tokenType": "unchecked",
        "principalKind": "user",
        "claimNames": ["email"]
      }
    ]
  }
}
```

Client: `credentialSource` fetches `/api/auth/token` from the BetterAuth
server with the session cookie and returns the JWT; signed out, it returns
the explicit anonymous credential.

Gotchas: switching BetterAuth to RS256 changes nothing — the alg was never
the incompatibility; the missing `typ` header was. The issuer string must
equal the `iss` BetterAuth mints for your base URL exactly. In production
behind TLS the issuer becomes an ordinary HTTPS URL.

## Adding another provider

Decode one real token from the provider and read three facts: the exact
`iss` string, whether `aud` is present (and what it contains), and the `typ`
header (or its absence). Those three facts fill in the provider entry
directly; the JWKS URL comes from the provider's discovery document. If the
token is not an asymmetrically-signed JWT with a JWKS endpoint, use a
`credentialVerifier` instead. Adding the shape as a conformance profile in
the provider conformance suite makes the integration a regression-tested
claim.
