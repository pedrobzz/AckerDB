# Auth providers

Per-provider recipes for the built-in `oidc` configuration. AckerDB is a
relying party only — the provider owns sign-in, and AckerDB verifies what it
mints. The contract behind every recipe is in
[Authentication](authentication.md): issuers are matched byte-exactly as
written, and audience/token-type enforcement is either fully specified or
explicitly `"unchecked"`, never silently absent.

Each studied provider has a **preset**: the provider's published token shape,
resolved into exact configuration at startup. A preset never weakens
verification — it fills in only the fields whose values follow from what the
provider mints, refuses the ones that cannot be defaulted (Auth0's API
audience, WorkOS's client ID), and `resolveOidcProvider` from
`@ackerdb/server` shows exactly what any preset resolves to. The full
field-by-field form remains the escape hatch for any other issuer.

## Quickstart: Clerk, zero to authenticated query

Everything on one page. Prerequisites: a Clerk application and a working
AckerDB app (`acker dev`).

**1. Server — `.ackerdb.config.json`.** Decode one Clerk session token (or
open your instance's JWT settings) and copy its `iss` exactly — no added
slash:

```json
{
  "oidc": {
    "providers": [
      { "preset": "clerk", "issuer": "https://your-app.clerk.accounts.dev" }
    ]
  }
}
```

**2. A protected query** in `functions/`:

```ts
export const me = query({
  access: "authenticated",
  args: {},
  handler: (ctx) => ({ identity: ctx.auth.identity.toString() }),
});
```

**3. Client — wrap the provider once.** Clerk owns sign-in; the credential
source hands its token to AckerDB and the client owns refresh from there:

```tsx
import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import { AckerDBProvider } from "@ackerdb/client-react";

function AckerDBWithClerk({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  return (
    <AckerDBProvider
      config={{
        url: "http://127.0.0.1:3211",
        credentialSource: async () => {
          const token = await getToken();
          return token === null ? { kind: "anonymous" } : { kind: "bearer", token };
        },
      }}
    >
      {children}
    </AckerDBProvider>
  );
}

export function Root() {
  return (
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_KEY}>
      <AckerDBWithClerk>
        <App />
      </AckerDBWithClerk>
    </ClerkProvider>
  );
}
```

**4. Sign-in, the query, and sign-out** — after Clerk's sign-in completes,
call `refresh()`; sign out of Clerk first, then `signOut()` (it rejects if
the source still produces a signed-in credential, so it can never lie):

```tsx
import { useAuthentication, useQuery } from "@ackerdb/client-react";
import { useClerk } from "@clerk/clerk-react";
import { api } from "./_generated/api";

function Me() {
  const { state, refresh, signOut } = useAuthentication();
  const clerk = useClerk();
  const me = useQuery(api.users.me, {});
  if (state.phase !== "authenticated") return <SignInButton onDone={() => void refresh()} />;
  return (
    <div>
      {me.status === "success" ? `Identity ${me.data.identity}` : "…"}
      <button onClick={() => clerk.signOut().then(() => signOut())}>Sign out</button>
    </div>
  );
}
```

That is the whole integration: one preset line on the server, one callback on
the client. Queries rejected while signed out re-demand automatically after
sign-in, and the client refreshes Clerk's 60-second tokens ahead of expiry on
its own.

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
{ "preset": "clerk", "issuer": "https://your-app.clerk.accounts.dev" }
```

which resolves to exactly:

```json
{
  "issuer": "https://your-app.clerk.accounts.dev",
  "jwksUri": "https://your-app.clerk.accounts.dev/.well-known/jwks.json",
  "audiences": "unchecked",
  "algorithms": ["RS256"],
  "tokenType": "JWT",
  "principalKind": "user",
  "claimNames": ["azp", "sid"]
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
{ "preset": "workos", "issuer": "https://api.workos.com", "clientId": "client_YOUR_CLIENT_ID" }
```

which resolves to exactly:

```json
{
  "issuer": "https://api.workos.com",
  "jwksUri": "https://api.workos.com/sso/jwks/client_YOUR_CLIENT_ID",
  "audiences": "unchecked",
  "algorithms": ["RS256"],
  "tokenType": "unchecked",
  "principalKind": "user",
  "claimNames": ["sid", "org_id", "role"]
}
```

`clientId` is required — the AuthKit JWKS URL is per-client and cannot be
derived from the issuer.

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
{ "preset": "auth0", "issuer": "https://your-tenant.auth0.com/", "audiences": ["https://api.your-app.example"] }
```

which resolves to exactly:

```json
{
  "issuer": "https://your-tenant.auth0.com/",
  "jwksUri": "https://your-tenant.auth0.com/.well-known/jwks.json",
  "audiences": ["https://api.your-app.example"],
  "algorithms": ["RS256"],
  "tokenType": "JWT",
  "principalKind": "user",
  "claimNames": ["azp", "scope"]
}
```

`audiences` is required — the preset refuses to default a value that only
your Auth0 API registration can supply.

Client: `credentialSource` wraps `getAccessTokenSilently()` from
`@auth0/auth0-react`.

Gotchas: `tokenType` must match your tenant's access-token profile — the
default profile mints `typ: "JWT"`, the RFC 9068 profile mints
`typ: "at+jwt"`; a mismatch hard-rejects. The trailing slash on the issuer is
mandatory because Auth0 mints it.

## BetterAuth

BetterAuth's JWT support signs with **EdDSA** by default and hardcodes the
protected header to `{alg, kid}` — there is no `typ` and no way to configure
one, so `tokenType` must be `"unchecked"`. Self-hosted locally it is a
plaintext HTTP issuer: loopback addresses work with no further declaration,
and reaching it over your machine's LAN IP (testing from a phone) requires
the provider's explicit `allowPrivateNetworkHttp: true` — plaintext across a
private network is an interceptable hop, so it is a visible declaration.

```json
{ "preset": "betterauth", "issuer": "http://localhost:3000" }
```

which resolves to exactly:

```json
{
  "issuer": "http://localhost:3000",
  "jwksUri": "http://localhost:3000/api/auth/jwks",
  "audiences": "unchecked",
  "algorithms": ["EdDSA"],
  "tokenType": "unchecked",
  "principalKind": "user",
  "claimNames": ["email"]
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
header (or its absence). Those three facts fill in a full provider entry
directly; the JWKS URL comes from the provider's discovery document.
Remember `claimNames`: either the claims your policies read or the explicit
`"none"` — verified claims outside the selection are discarded. If the token
is not an asymmetrically-signed JWT with a JWKS endpoint, use a
`credentialVerifier` instead. Adding the shape as a conformance profile in
the provider conformance suite makes the integration a regression-tested
claim — and once it exists, a preset for it is a dozen lines in
`resolveOidcProvider`.
