import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createOidcVerifier,
  verifyClientCredential,
  type CredentialVerifier,
  type OidcProviderConfig,
  type UserPrincipal,
} from "../src/auth.ts";
import { Engine } from "../src/engine.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime } from "../src/runtime.ts";
import { defineSchema } from "../src/schema.ts";

interface ProviderFixture {
  readonly name: string;
  readonly issuer: string;
  readonly audience: string;
  readonly tokenType: string;
  readonly shapeClaims: Readonly<Record<string, unknown>>;
}

const PROVIDERS = [
  {
    name: "clerk",
    issuer: "https://clerk.identity.test/",
    audience: "dbzz-clerk",
    tokenType: "JWT",
    shapeClaims: { azp: "web", org_id: "org_1", authentication_method: "email" },
  },
  {
    name: "better-auth",
    issuer: "https://better-auth.identity.test/",
    audience: "dbzz-better-auth",
    tokenType: "JWT",
    shapeClaims: { role: "member", session_id: "session_1" },
  },
  {
    name: "auth0",
    issuer: "https://tenant.auth0.identity.test/",
    audience: "dbzz-auth0",
    tokenType: "JWT",
    shapeClaims: { permissions: ["orders:read"] },
  },
  {
    name: "workos",
    issuer: "https://workos.identity.test/",
    audience: "dbzz-workos",
    tokenType: "JWT",
    shapeClaims: { organization_id: "org_1", role: "member" },
  },
  {
    name: "keycloak",
    issuer: "https://keycloak.identity.test/realms/dbzz",
    audience: "dbzz-keycloak",
    tokenType: "JWT",
    shapeClaims: { preferred_username: "shared", realm_access: { roles: ["member"] } },
  },
  {
    name: "custom-oidc",
    issuer: "https://custom.identity.test/",
    audience: "dbzz-custom",
    tokenType: "at+jwt",
    shapeClaims: { tenant: "tenant_1", entitlements: ["orders"] },
  },
] as const satisfies readonly ProviderFixture[];

type ProviderName = (typeof PROVIDERS)[number]["name"];

const SHARED_MUTABLE_CLAIMS = Object.freeze({
  email: "shared@example.test",
  phone: "+15550000000",
  name: "Shared Person",
  nickname: "shared",
});

const schema = defineSchema({});
const directories: string[] = [];
const instances = new Map<Runtime, Engine>();

function open(path: string): { readonly engine: Engine; readonly runtime: Runtime } {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry({}),
    telemetry: false,
  });
  instances.set(runtime, engine);
  return { engine, runtime };
}

async function close(runtime: Runtime, engine: Engine): Promise<void> {
  await runtime.drain();
  instances.delete(runtime);
  engine.close("clean");
}

afterEach(async () => {
  await Promise.all([...instances].map(async ([runtime, engine]) => {
    await runtime.drain().catch(() => {});
    try {
      engine.close("clean");
    } catch {
      // The assertion failure remains primary; test cleanup is best effort.
    }
  }));
  instances.clear();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

interface TokenOptions {
  readonly subject?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly algorithm?: "RS256" | "PS256";
  readonly tokenType?: string;
  readonly expiresAt?: number;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly omitRequiredClaim?: boolean;
}

interface OidcHarness {
  readonly verifier: CredentialVerifier;
  token(providerName: ProviderName, options?: TokenOptions): Promise<string>;
}

function providerNamed(name: ProviderName): (typeof PROVIDERS)[number] {
  const provider = PROVIDERS.find((candidate) => candidate.name === name);
  if (provider === undefined) throw new Error(`unknown test provider ${name}`);
  return provider;
}

async function oidcHarness(): Promise<OidcHarness> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const { privateKey: ps256PrivateKey } = await generateKeyPair("PS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "RS256",
    kid: "provider-matrix-key",
    use: "sig",
  };
  const jwksUris = new Set(PROVIDERS.map(({ issuer }) => new URL("jwks", issuer).href));
  const providers: OidcProviderConfig[] = PROVIDERS.map((provider) => ({
    issuer: provider.issuer,
    jwksUri: new URL("jwks", provider.issuer),
    audiences: [provider.audience],
    algorithms: ["RS256"],
    tokenType: provider.tokenType,
    principalKind: "user",
    requiredClaims: ["provider_marker"],
    claimNames: [
      "provider_marker",
      ...Object.keys(SHARED_MUTABLE_CLAIMS),
      ...Object.keys(provider.shapeClaims),
    ],
  }));
  const verifier = createOidcVerifier({
    providers,
    fetch: async (url) => {
      if (!jwksUris.has(url)) throw new Error(`unexpected JWKS URL ${url}`);
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  let tokenSequence = 0;

  return {
    verifier,
    token: async (providerName, options = {}) => {
      const provider = providerNamed(providerName);
      const now = Math.floor(Date.now() / 1_000);
      const payload: Record<string, unknown> = {
        ...SHARED_MUTABLE_CLAIMS,
        ...provider.shapeClaims,
        provider_marker: provider.name,
        ...options.claims,
      };
      if (options.omitRequiredClaim === true) delete payload.provider_marker;
      const algorithm = options.algorithm ?? "RS256";
      return new SignJWT(payload)
        .setProtectedHeader({
          alg: algorithm,
          kid: "provider-matrix-key",
          typ: options.tokenType ?? provider.tokenType,
        })
        .setIssuer(options.issuer ?? provider.issuer)
        .setAudience(options.audience ?? provider.audience)
        .setSubject(options.subject ?? "shared-subject")
        .setIssuedAt(now)
        .setJti(`token-${++tokenSequence}`)
        .setExpirationTime(options.expiresAt ?? now + 60)
        .sign(algorithm === "RS256" ? privateKey : ps256PrivateKey);
    },
  };
}

async function authenticate(
  runtime: Runtime,
  harness: OidcHarness,
  token: string,
): Promise<UserPrincipal> {
  const principal = await verifyClientCredential(
    { kind: "bearer", token },
    harness.verifier,
    (account) => runtime.resolveIdentity(account),
  );
  if (principal.kind !== "user") throw new Error("expected a user principal");
  return principal;
}

function accountKey(issuer: string, subject: string): string {
  return `${issuer}\0${subject}`;
}

describe("provider-neutral exact-account Identity", () => {
  test("rejects unverified issuer, audience, algorithm, type, expiry, and claims before allocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-provider-validation-"));
    directories.push(directory);
    const { engine, runtime } = open(join(directory, "data.db"));
    const harness = await oidcHarness();
    const now = Math.floor(Date.now() / 1_000);
    const invalidTokens = await Promise.all([
      harness.token("clerk", { issuer: "https://unknown.identity.test/" }),
      harness.token("better-auth", { audience: "wrong-audience" }),
      harness.token("auth0", { algorithm: "PS256" }),
      harness.token("workos", { tokenType: "at+jwt" }),
      harness.token("keycloak", { expiresAt: now - 60 }),
      harness.token("custom-oidc", { omitRequiredClaim: true }),
    ]);

    for (const token of invalidTokens) {
      await expect(authenticate(runtime, harness, token)).rejects.toMatchObject({
        code: "unauthenticated",
      });
    }
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _dbz_identities").get())
      .toEqual({ count: 0n });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _dbz_identity_accounts").get())
      .toEqual({ count: 0n });
  });

  test("converges exact accounts while preserving collisions, claims, restart durability, and non-reuse", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-provider-matrix-"));
    directories.push(directory);
    const path = join(directory, "data.db");
    const harness = await oidcHarness();
    const first = open(path);
    const attempts = [
      ...Array.from({ length: 12 }, (_, index) => ({
        provider: "clerk" as const,
        subject: "shared-subject",
        claims: {
          authentication_method: index % 2 === 0 ? "email" : "oauth_google",
        },
      })),
      ...PROVIDERS.filter(({ name }) => name !== "clerk").map(({ name }) => ({
        provider: name,
        subject: "shared-subject",
        claims: {},
      })),
      { provider: "custom-oidc" as const, subject: "different-subject", claims: {} },
    ];
    const principals = await Promise.all(attempts.map(async (attempt) => authenticate(
      first.runtime,
      harness,
      await harness.token(attempt.provider, {
        subject: attempt.subject,
        claims: attempt.claims,
      }),
    )));
    const identitiesByAccount = new Map<string, UserPrincipal["identity"]>();
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;
      const principal = principals[index]!;
      const provider = providerNamed(attempt.provider);
      expect(principal).toMatchObject({
        issuer: provider.issuer,
        subject: attempt.subject,
        claims: SHARED_MUTABLE_CLAIMS,
      });
      const key = accountKey(provider.issuer, attempt.subject);
      const existing = identitiesByAccount.get(key);
      if (existing === undefined) identitiesByAccount.set(key, principal.identity);
      else expect(principal.identity).toBe(existing);
    }

    expect(identitiesByAccount.size).toBe(PROVIDERS.length + 1);
    expect(new Set(identitiesByAccount.values()).size).toBe(identitiesByAccount.size);
    expect(engineCount(first.engine, "_dbz_identities")).toBe(BigInt(identitiesByAccount.size));
    expect(engineCount(first.engine, "_dbz_identity_accounts")).toBe(BigInt(identitiesByAccount.size));

    await close(first.runtime, first.engine);
    const second = open(path);
    for (const provider of PROVIDERS) {
      const principal = await authenticate(
        second.runtime,
        harness,
        await harness.token(provider.name, {
          subject: "shared-subject",
          claims: {
            email: `refreshed-${provider.name}@example.test`,
            phone: `+1555${provider.name.length.toString().padStart(7, "0")}`,
            name: `Refreshed ${provider.name}`,
            nickname: `refreshed-${provider.name}`,
          },
        }),
      );
      expect(principal.identity).toBe(
        identitiesByAccount.get(accountKey(provider.issuer, "shared-subject"))!,
      );
    }
    const differentSubject = await authenticate(
      second.runtime,
      harness,
      await harness.token("custom-oidc", { subject: "different-subject" }),
    );
    expect(differentSubject.identity).toBe(identitiesByAccount.get(accountKey(
      providerNamed("custom-oidc").issuer,
      "different-subject",
    ))!);

    const retired = await authenticate(
      second.runtime,
      harness,
      await harness.token("keycloak", { subject: "retired-subject" }),
    );
    second.engine.writer.exec("BEGIN IMMEDIATE");
    second.engine.writer
      .query("DELETE FROM _dbz_identity_accounts WHERE issuer = ? AND subject = ?")
      .run(providerNamed("keycloak").issuer, "retired-subject");
    second.engine.writer
      .query("DELETE FROM _dbz_identities WHERE identity = ?")
      .run(retired.identity);
    second.engine.writer.exec("COMMIT");
    await close(second.runtime, second.engine);

    const third = open(path);
    const replacement = await authenticate(
      third.runtime,
      harness,
      await harness.token("better-auth", { subject: "replacement-subject" }),
    );
    expect((replacement.identity as bigint) > (retired.identity as bigint)).toBe(true);
    for (const [key, identity] of identitiesByAccount) {
      const separator = key.indexOf("\0");
      expect(third.engine.identityForAccount(
        third.engine.reader,
        key.slice(0, separator),
        key.slice(separator + 1),
      )).toBe(identity);
    }
  });
});

function engineCount(engine: Engine, table: "_dbz_identities" | "_dbz_identity_accounts"): bigint {
  return (engine.writer.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: bigint })
    .count;
}
