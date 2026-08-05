# External identity providers are exact configuration; enforcement opt-outs are explicit

AckerDB verifies external identity and never issues it. A four-provider
integration study (Clerk, WorkOS AuthKit, Auth0, BetterAuth, against
published 0.15.0) showed the OIDC verification machinery cryptographically
sound while its configuration rejected three of the four providers outright.
Every rejection was configuration strictness, not cryptography: the issuer
had to round-trip WHATWG URL canonicalization (forcing a trailing slash
Clerk and WorkOS never mint), `audiences` was mandatory while their default
tokens carry no `aud` claim, `tokenType` was mandatory while BetterAuth's
protected header has no `typ` and cannot be given one, and HTTPS-only URLs
made every locally self-hosted issuer unregisterable. Each provider was
rescued by a hand-written `credentialVerifier` doing what the built-in path
should have done from configuration alone.

We keep the strictness and relocate it: **the configuration is exact, and
every relaxation is a visible declaration.**

The issuer becomes an exact string. It is validated as a well-formed URL on
a permitted scheme with no whitespace, credentials, fragment, or query, then
stored and matched byte-exactly against the token's `iss` — never
normalized. Canonicalization was solving the wrong problem: the registry
match was always byte-exact, so rewriting the configured string could only
manufacture mismatches with what real providers mint. There is exactly one
correct configuration value per provider — whatever it actually mints — and
the whitespace/control-character rejection keeps the silent-mismatch class
loud at startup. The accepted consequence: a wrong-slash configuration now
fails at verification rather than construction; the per-provider recipes
state each exact `iss` string.

`audiences` and `tokenType` accept the literal `"unchecked"`. The rejected
alternative — making the fields optional with absence meaning unenforced —
reads identically in a config diff whether the author chose it or forgot it.
A required field whose opt-out is a screaming literal keeps the decision
reviewable: every dimension is either fully specified or visibly declared
unchecked, and everything left declared stays enforced. An empty audience
list remains forbidden because an empty list silently meaning "no check" is
the same forgotten-or-chosen ambiguity.

Plaintext HTTP is governed by a topological rule plus an explicit
declaration, not a mode switch. Loopback hosts accept plaintext by default —
that traffic cannot cross a network at all, and it covers the legitimate
same-host sidecar in production. Private-network IP literals accept
plaintext only under the provider's `allowPrivateNetworkHttp: true`: RFC
1918 does not mean trusted — Wi-Fi, corporate LANs, VPNs, and cloud VPCs are
attackable, and an on-path peer that rewrites a plaintext JWKS response
mints accepted tokens — so crossing a private network without TLS is the
same kind of visible, reviewable declaration as `"unchecked"`. Public hosts
never accept plaintext, declaration or not. The rejected alternative, a
dev-mode-only allowance, couples a security property to a lifecycle flag
instead of stating the invariant; adversarial review of the first cut
demonstrated that treating private ranges as implicitly safe was the same
mistake in topological clothing. Named non-localhost hosts require HTTPS
because their resolution cannot be judged at configuration time.

Finally, the server discloses credential TTL — `credentialTtlMs`, a relative
duration on every accepted bearer `welcome`/`auth` frame — because the
client owning proactive refresh is part of the same contract. The rejected
alternative, client-side token parsing, would weld a JWT assumption into the
client while the `credentialVerifier` contract deliberately keeps
credentials format-opaque; disclosure lets any credential format refresh
proactively, and anonymous principals disclose nothing.

Provider compatibility is enforced by construction: a conformance suite
mints tokens in each studied provider's exact shape — bare-origin issuers,
missing `aud`, missing `typ`, EdDSA, RFC 9068 `at+jwt`, loopback plaintext —
and asserts both acceptance and the full rejection matrix, so "provider X
works" is a regression-tested claim and a new provider is one token profile.
Schemes that are not JWKS-published asymmetric JWTs remain
`credentialVerifier` territory by design; credential issuance remains
deliberately out of scope.
