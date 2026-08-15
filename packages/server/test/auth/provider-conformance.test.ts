import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createOidcVerifier,
  resolveOidcProvider,
  type OidcProviderConfig,
  type OidcVerifierOptions,
} from "../../src/auth/credentials.ts";
import { AckerDBError, type AckerDBErrorCode } from "../../src/shared/errors.ts";

/**
 * Provider conformance: one token profile per real-world issuer shape the
 * 2026-08 four-provider study measured. Each profile asserts that the shape
 * is expressible as exact configuration and that the full accept/reject
 * matrix holds — including that every dimension left declared stays enforced
 * when another is `"unchecked"`. Together the profiles span the hostile
 * parameter space: bare-origin issuers, missing `aud`, missing `typ`, EdDSA,
 * RFC 9068 token types, and loopback plaintext HTTP.
 */

interface MintOverrides {
  readonly issuer?: string;
  /** `null` mints without an audience; a value overrides the profile's. */
  readonly audience?: string | readonly string[] | null;
  /** `null` mints without a `typ` header; a value overrides the profile's. */
  readonly typ?: string | null;
  readonly expiresInSeconds?: number;
  readonly foreignKey?: boolean;
}

interface ProviderProfile {
  readonly name: string;
  readonly alg: "RS256" | "EdDSA";
  /** The byte-exact `iss` the real provider mints. */
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audiences: readonly string[] | "unchecked";
  readonly tokenType: string;
  readonly subject: string;
  /** `null`: the provider's default tokens carry no audience. */
  readonly audience: string | readonly string[] | null;
  /** `null`: the provider's protected header carries no `typ`. */
  readonly typ: string | null;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly claimNames: readonly string[];
}

const PROFILES: readonly ProviderProfile[] = [
  {
    // Bare-origin issuer with no trailing slash; default session tokens
    // carry no `aud`; 60-second expiry.
    name: "Clerk session token",
    alg: "RS256",
    issuer: "https://smiling-tiger-42.clerk.accounts.dev",
    jwksUri: "https://smiling-tiger-42.clerk.accounts.dev/.well-known/jwks.json",
    audiences: "unchecked",
    tokenType: "JWT",
    subject: "user_2fXGa9qmA1",
    audience: null,
    typ: "JWT",
    claims: { azp: "http://localhost:3000", sid: "sess_2f9qwe" },
    claimNames: ["azp", "sid"],
  },
  {
    // Bare-origin issuer; no `aud`; the `typ` header is undocumented, so the
    // profile declares both dimensions unchecked and mints without `typ`.
    name: "WorkOS AuthKit access token",
    alg: "RS256",
    issuer: "https://api.workos.com",
    jwksUri: "https://api.workos.com/sso/jwks/client_01HXYZABC",
    audiences: "unchecked",
    tokenType: "unchecked",
    subject: "user_01HWORKOS",
    audience: null,
    typ: null,
    claims: { sid: "session_01HSESSION", org_id: "org_01HORG", role: "member" },
    claimNames: ["sid", "org_id", "role"],
  },
  {
    // Trailing-slash issuer, two-element audience array, default "JWT"
    // token profile — the shape that already worked before the relaxations.
    name: "Auth0 access token (JWT profile)",
    alg: "RS256",
    issuer: "https://tenant.auth0.com/",
    jwksUri: "https://tenant.auth0.com/.well-known/jwks.json",
    audiences: ["https://api.example.com"],
    tokenType: "JWT",
    subject: "auth0|65a1b2c3d4",
    audience: ["https://api.example.com", "https://tenant.auth0.com/userinfo"],
    typ: "JWT",
    claims: { azp: "abcDEF123client", scope: "openid profile" },
    claimNames: ["azp", "scope"],
  },
  {
    name: "Auth0 access token (RFC 9068 at+jwt profile)",
    alg: "RS256",
    issuer: "https://tenant.auth0.com/",
    jwksUri: "https://tenant.auth0.com/.well-known/jwks.json",
    audiences: ["https://api.example.com"],
    tokenType: "at+jwt",
    subject: "auth0|65a1b2c3d4",
    audience: ["https://api.example.com"],
    typ: "at+jwt",
    claims: { azp: "abcDEF123client", scope: "openid profile" },
    claimNames: ["azp", "scope"],
  },
  {
    // Self-hosted on loopback plaintext HTTP; EdDSA; the protected header is
    // hardcoded to {alg, kid} with no way to add `typ`.
    name: "BetterAuth JWT",
    alg: "EdDSA",
    issuer: "http://localhost:3010",
    jwksUri: "http://localhost:3010/api/auth/jwks",
    audiences: "unchecked",
    tokenType: "unchecked",
    subject: "hyu8Zt0qJ4mCkX2vB1nGd",
    audience: null,
    typ: null,
    claims: { email: "test@example.com" },
    claimNames: ["email"],
  },
];

interface ProfileFixture {
  readonly options: OidcVerifierOptions;
  readonly networkCalls: () => number;
  mint(overrides?: MintOverrides): Promise<string>;
}

async function profileFixture(profile: ProviderProfile): Promise<ProfileFixture> {
  const { privateKey, publicKey } = await generateKeyPair(profile.alg);
  const foreign = await generateKeyPair(profile.alg);
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: profile.alg,
    kid: "conformance-key",
    use: "sig",
  };
  let calls = 0;
  const provider: OidcProviderConfig = {
    issuer: profile.issuer,
    jwksUri: profile.jwksUri,
    audiences: profile.audiences,
    algorithms: [profile.alg],
    tokenType: profile.tokenType,
    principalKind: "user",
    claimNames: profile.claimNames,
  };
  const options: OidcVerifierOptions = {
    providers: [provider],
    fetch: async (url) => {
      calls += 1;
      expect(url).toBe(new URL(profile.jwksUri).href);
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return {
    options,
    networkCalls: () => calls,
    mint: async (overrides = {}) => {
      const now = Math.floor(Date.now() / 1_000);
      const typ = overrides.typ === undefined ? profile.typ : overrides.typ;
      const token = new SignJWT({ ...profile.claims })
        .setProtectedHeader({
          alg: profile.alg,
          kid: "conformance-key",
          ...(typ === null ? {} : { typ }),
        })
        .setIssuer(overrides.issuer ?? profile.issuer)
        .setSubject(profile.subject)
        .setIssuedAt(now)
        .setExpirationTime(now + (overrides.expiresInSeconds ?? 60));
      const audience = overrides.audience === undefined ? profile.audience : overrides.audience;
      if (audience !== null) token.setAudience(audience as string | string[]);
      return token.sign(overrides.foreignKey ? foreign.privateKey : privateKey);
    },
  };
}

async function expectRejected(promise: Promise<unknown>, code: AckerDBErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AckerDBError);
    expect((error as AckerDBError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe.each(PROFILES.map((profile) => [profile.name, profile] as const))(
  "provider conformance: %s",
  (_name, profile) => {
    test("the shape is expressible and a valid token verifies to its principal", async () => {
      const fixture = await profileFixture(profile);
      const verifier = createOidcVerifier(fixture.options);
      const principal = await verifier.verify(await fixture.mint());
      expect(principal).toMatchObject({
        kind: "user",
        issuer: profile.issuer,
        subject: profile.subject,
        claims: profile.claims,
      });
      expect(principal.expiresAt).toBeGreaterThan(Date.now());
    });

    // The reject matrix reads nothing profile-specific but the signing
    // algorithm, so it runs once per algorithm: each RSA fixture is ~250 ms of
    // keygen for the same three assertions.
    if (profile === PROFILES.find((candidate) => candidate.alg === profile.alg)) {
      test("expired, foreign-key, and unknown-issuer tokens reject unauthenticated", async () => {
        const fixture = await profileFixture(profile);
        const verifier = createOidcVerifier(fixture.options);
        await expectRejected(verifier.verify(await fixture.mint({ expiresInSeconds: -3_600 })), "unauthenticated");
        await expectRejected(verifier.verify(await fixture.mint({ foreignKey: true })), "unauthenticated");
        const beforeUnknownIssuer = fixture.networkCalls();
        await expectRejected(
          verifier.verify(await fixture.mint({ issuer: `${profile.issuer}.attacker.example` })),
          "unauthenticated",
        );
        // An unknown issuer fails at the exact-issuer registry, before any JWKS fetch.
        expect(fixture.networkCalls()).toBe(beforeUnknownIssuer);
      });
    }

    if (profile.audiences !== "unchecked") {
      test("declared audiences stay enforced: missing and wrong aud reject", async () => {
        const fixture = await profileFixture(profile);
        const verifier = createOidcVerifier(fixture.options);
        await expectRejected(verifier.verify(await fixture.mint({ audience: null })), "unauthenticated");
        await expectRejected(
          verifier.verify(await fixture.mint({ audience: "https://other.example" })),
          "unauthenticated",
        );
      });
    } else {
      test("unchecked audiences accept tokens with no aud and with a foreign aud", async () => {
        const fixture = await profileFixture(profile);
        const verifier = createOidcVerifier(fixture.options);
        await verifier.verify(await fixture.mint({ audience: null }));
        await verifier.verify(await fixture.mint({ audience: "https://unrelated.example" }));
      });
    }

    if (profile.tokenType !== "unchecked") {
      test("the declared token type stays enforced: a wrong typ rejects", async () => {
        const fixture = await profileFixture(profile);
        const verifier = createOidcVerifier(fixture.options);
        await expectRejected(
          verifier.verify(await fixture.mint({ typ: profile.tokenType === "JWT" ? "at+jwt" : "JWT" })),
          "unauthenticated",
        );
      });
    } else {
      test("an unchecked token type accepts a missing and an unexpected typ header", async () => {
        const fixture = await profileFixture(profile);
        const verifier = createOidcVerifier(fixture.options);
        await verifier.verify(await fixture.mint({ typ: null }));
        await verifier.verify(await fixture.mint({ typ: "weird+jwt" }));
      });
    }
  },
);

describe("exact issuer contract", () => {
  test("issuer strings are matched byte-exactly, never normalized", async () => {
    const clerk = PROFILES[0]!;
    const fixture = await profileFixture(clerk);
    // A trailing-slash config is registrable but can never match the
    // provider's slashless iss — the mismatch rejects at the registry.
    const slashed = createOidcVerifier({
      ...fixture.options,
      providers: [{ ...fixture.options.providers[0]!, issuer: `${clerk.issuer}/` }],
    });
    await expectRejected(slashed.verify(await fixture.mint()), "unauthenticated");
    expect(fixture.networkCalls()).toBe(0);
    const exact = createOidcVerifier(fixture.options);
    await exact.verify(await fixture.mint());
  });

  test("misdeclared issuers fail loudly at construction", async () => {
    const fixture = await profileFixture(PROFILES[0]!);
    const provider = fixture.options.providers[0]!;
    const build = (issuer: string): void => {
      createOidcVerifier({ ...fixture.options, providers: [{ ...provider, issuer }] });
    };
    expect(() => build("https://issuer.example/?tenant=a")).toThrow(TypeError);
    expect(() => build("https://issuer.example/#fragment")).toThrow(TypeError);
    expect(() => build("https://user:secret@issuer.example")).toThrow(TypeError);
    expect(() => build(" https://issuer.example")).toThrow(TypeError);
    expect(() => build("https://issuer\t.example")).toThrow(TypeError);
    expect(() => build("not a url")).toThrow(TypeError);
    expect(() => build("")).toThrow(TypeError);
  });

  test("an empty audience list stays forbidden; opting out requires the explicit literal", async () => {
    const fixture = await profileFixture(PROFILES[0]!);
    const provider = fixture.options.providers[0]!;
    expect(() =>
      createOidcVerifier({ ...fixture.options, providers: [{ ...provider, audiences: [] }] }),
    ).toThrow(TypeError);
  });

  test("a non-array audience value is rejected, never iterated as characters", async () => {
    const fixture = await profileFixture(PROFILES[0]!);
    const provider = fixture.options.providers[0]!;
    // Unvalidated JSON configuration can supply a plain string; iterating it
    // would silently turn "api" into the allowlist ["a", "p", "i"].
    for (const audiences of ["api", { length: 1, 0: "api" }, new Set(["api"])]) {
      expect(() =>
        createOidcVerifier({
          ...fixture.options,
          providers: [{ ...provider, audiences: audiences as unknown as readonly string[] }],
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      createOidcVerifier({
        ...fixture.options,
        providers: [{ ...provider, algorithms: "RS256" as unknown as readonly ["RS256"] }],
      }),
    ).toThrow(TypeError);
  });
});

describe("private plaintext boundary", () => {
  const base = {
    audiences: "unchecked",
    algorithms: ["RS256"],
    tokenType: "unchecked",
    principalKind: "user",
    claimNames: "none",
  } as const;

  function build(issuer: string, options: { allow?: boolean; jwksUri?: string } = {}): void {
    createOidcVerifier({
      providers: [
        {
          ...base,
          issuer,
          jwksUri: options.jwksUri ?? `${issuer}/jwks`,
          ...(options.allow === undefined ? {} : { allowPrivateNetworkHttp: options.allow }),
        },
      ],
    });
  }

  test("loopback plaintext HTTP needs no declaration", () => {
    build("http://localhost:3010");
    build("http://auth.localhost:3010");
    build("http://127.0.0.1:3010");
    build("http://127.42.0.1:3010");
    build("http://[::1]:3010");
  });

  test("private-network plaintext HTTP requires the explicit declaration", () => {
    const privateHosts = [
      "http://192.168.1.42:3010",
      "http://10.0.0.5:3010",
      "http://172.16.0.9:3010",
      "http://172.31.255.1:3010",
      "http://169.254.10.10:3010",
      "http://[fd12:3456:789a::1]:3010",
      "http://[fe80::1]:3010",
    ];
    for (const issuer of privateHosts) {
      expect(() => build(issuer)).toThrow(TypeError);
      build(issuer, { allow: true });
    }
  });

  test("public plaintext HTTP is rejected even with the declaration", () => {
    for (const allow of [undefined, true]) {
      expect(() => build("http://issuer.example", { allow })).toThrow(TypeError);
      expect(() => build("http://8.8.8.8", { allow })).toThrow(TypeError);
      expect(() => build("http://172.32.0.1", { allow })).toThrow(TypeError);
      expect(() => build("http://mymac.local:3010", { allow })).toThrow(TypeError);
      // The rule covers the JWKS fetch too — the actually security-relevant hop.
      expect(() =>
        build("https://issuer.example", { allow, jwksUri: "http://issuer.example/jwks" }),
      ).toThrow(TypeError);
    }
  });
});

describe("provider presets", () => {
  test("each preset resolves to exactly the recipe's exact configuration", () => {
    expect(
      resolveOidcProvider({
        preset: "clerk",
        issuer: "https://smiling-tiger-42.clerk.accounts.dev",
      }),
    ).toEqual({
      issuer: "https://smiling-tiger-42.clerk.accounts.dev",
      jwksUri: "https://smiling-tiger-42.clerk.accounts.dev/.well-known/jwks.json",
      audiences: "unchecked",
      algorithms: ["RS256"],
      tokenType: "JWT",
      principalKind: "user",
      claimNames: ["azp", "sid"],
    });
    expect(
      resolveOidcProvider({
        preset: "auth0",
        issuer: "https://tenant.auth0.com/",
        audiences: ["https://api.example.com"],
      }),
    ).toEqual({
      issuer: "https://tenant.auth0.com/",
      jwksUri: "https://tenant.auth0.com/.well-known/jwks.json",
      audiences: ["https://api.example.com"],
      algorithms: ["RS256"],
      tokenType: "JWT",
      principalKind: "user",
      claimNames: ["azp", "scope"],
    });
    expect(
      resolveOidcProvider({
        preset: "workos",
        issuer: "https://api.workos.com",
        clientId: "client_01HXYZABC",
      }),
    ).toEqual({
      issuer: "https://api.workos.com",
      jwksUri: "https://api.workos.com/sso/jwks/client_01HXYZABC",
      audiences: "unchecked",
      algorithms: ["RS256"],
      tokenType: "unchecked",
      principalKind: "user",
      claimNames: ["sid", "org_id", "role"],
    });
    expect(
      resolveOidcProvider({
        preset: "betterauth",
        issuer: "http://localhost:3000",
      }),
    ).toEqual({
      issuer: "http://localhost:3000",
      jwksUri: "http://localhost:3000/api/auth/jwks",
      audiences: "unchecked",
      algorithms: ["EdDSA"],
      tokenType: "unchecked",
      principalKind: "user",
      claimNames: ["email"],
    });
  });

  test("a preset entry verifies a real provider-shaped token end to end", async () => {
    const clerk = PROFILES[0]!;
    const fixture = await profileFixture(clerk);
    const verifier = createOidcVerifier({
      ...fixture.options,
      providers: [{ preset: "clerk", issuer: clerk.issuer }],
    });
    const principal = await verifier.verify(await fixture.mint());
    expect(principal).toMatchObject({
      kind: "user",
      issuer: clerk.issuer,
      subject: clerk.subject,
      claims: { azp: clerk.claims.azp, sid: clerk.claims.sid },
    });
    await expectRejected(verifier.verify(await fixture.mint({ foreignKey: true })), "unauthenticated");
  });

  test("presets refuse the fields whose values cannot be defaulted", () => {
    expect(() =>
      resolveOidcProvider({ preset: "auth0", issuer: "https://tenant.auth0.com/" }),
    ).toThrow(TypeError);
    expect(() =>
      resolveOidcProvider({ preset: "workos", issuer: "https://api.workos.com" }),
    ).toThrow(TypeError);
    expect(() =>
      resolveOidcProvider({
        preset: "workos",
        issuer: "https://api.workos.com",
        clientId: "bad/../path",
      }),
    ).toThrow(TypeError);
  });

  test("claim projection is always a declaration: omitted claimNames refuses at construction", async () => {
    const fixture = await profileFixture(PROFILES[0]!);
    const provider = fixture.options.providers[0]! as OidcProviderConfig;
    const { claimNames: _dropped, ...withoutClaimNames } = provider;
    expect(() =>
      createOidcVerifier({
        ...fixture.options,
        providers: [withoutClaimNames as unknown as OidcProviderConfig],
      }),
    ).toThrow(TypeError);
    // The explicit "none" is the empty projection.
    const none = createOidcVerifier({
      ...fixture.options,
      providers: [{ ...provider, claimNames: "none" }],
    });
    const principal = await none.verify(await fixture.mint());
    expect(principal.claims).toEqual({});
  });
});
