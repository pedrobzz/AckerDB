import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  ANONYMOUS_PRINCIPAL,
  credentialFromAuthorization,
  createOidcVerifier,
  SYSTEM_PRINCIPAL,
  verifyClientCredential,
  type CredentialVerifier,
  type OidcVerifierOptions,
  type UserPrincipal,
} from "../src/auth.ts";
import { dbz, ValidationError } from "../src/dbz.ts";
import { DbzzError, type DbzzErrorCode } from "../src/errors.ts";
import { query } from "../src/functions.ts";
import { invokeFunction } from "../src/invocation.ts";

const ISSUER = "https://issuer.example/";
const JWKS_URI = "https://issuer.example/jwks";
const AUDIENCE = "dbzz-test";

function userPrincipal(subject = "user-1"): UserPrincipal {
  return Object.freeze({
    kind: "user",
    issuer: ISSUER,
    subject,
    claims: Object.freeze(Object.create(null) as Record<string, unknown>),
    expiresAt: Date.now() + 60_000,
    tokenId: null,
  });
}

async function expectDbzzError(promise: Promise<unknown>, code: DbzzErrorCode): Promise<DbzzError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DbzzError);
    expect((error as DbzzError).code).toBe(code);
    return error as DbzzError;
  }
  throw new Error(`expected ${code}`);
}

describe("principals and invocation access", () => {
  test("HTTP authorization uses the same strict credential path", async () => {
    expect(credentialFromAuthorization(null)).toEqual({ kind: "anonymous" });
    expect(credentialFromAuthorization("Bearer token-value")).toEqual({
      kind: "bearer",
      token: "token-value",
    });
    expect(() => credentialFromAuthorization("Basic secret")).toThrow(DbzzError);
    expect(() => credentialFromAuthorization("Bearer one, Bearer two")).toThrow(DbzzError);

    const mutableClaims = { roles: ["reader"] };
    const verifier: CredentialVerifier = {
      revocationBound: { kind: "token-expiration" },
      subscribeInvalidation: () => () => {},
      verify: async () => ({
        kind: "user",
        issuer: ISSUER,
        subject: "subject-1",
        claims: mutableClaims,
        expiresAt: 2_000,
        tokenId: null,
      }),
    };
    const principal = await verifyClientCredential(
      credentialFromAuthorization("bearer token-value"),
      verifier,
      () => 1_000,
    );
    expect(principal.kind).toBe("user");
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(mutableClaims.roles)).toBe(true);
    await expectDbzzError(
      verifyClientCredential({ kind: "bearer", token: "token-value" }, verifier, () => 2_000),
      "unauthenticated",
    );
  });

  test("framework errors cannot encode an invalid structured outcome", () => {
    expect(
      () => new DbzzError("overloaded", "busy", { retryAfterMs: 1 }),
    ).toThrow("retryAfterMs requires retryable");
    expect(
      () => new DbzzError("convergence_unavailable", "committed"),
    ).toThrow("must be committed");
    expect(
      new DbzzError("convergence_unavailable", "committed", { committed: true }).committed,
    ).toBe(true);
  });

  test("the anonymous and system principals are explicit frozen discriminants", () => {
    expect(ANONYMOUS_PRINCIPAL).toEqual({ kind: "anonymous" });
    expect(SYSTEM_PRINCIPAL).toEqual({ kind: "system" });
    expect(Object.isFrozen(ANONYMOUS_PRINCIPAL)).toBe(true);
    expect(Object.isFrozen(SYSTEM_PRINCIPAL)).toBe(true);
  });

  test("registration requires an explicit access policy at runtime", () => {
    expect(() =>
      (query as unknown as (definition: unknown) => unknown)({ args: {}, handler: () => null }),
    ).toThrow("query access must be");
  });

  test("argument validation happens before policy and the handler", async () => {
    let policyCalls = 0;
    let handlerCalls = 0;
    const fn = query({
      args: { value: dbz.string() },
      access: (_ctx, args) => {
        policyCalls += 1;
        return args.value === "allowed";
      },
      handler: (_ctx, args) => {
        handlerCalls += 1;
        return args.value;
      },
    });

    await expect(fn({ auth: ANONYMOUS_PRINCIPAL }, { value: 1 as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(policyCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(await fn({ auth: ANONYMOUS_PRINCIPAL }, { value: "allowed" })).toBe("allowed");
  });

  test("authorization hooks run after policy and before the handler", async () => {
    const order: string[] = [];
    const fn = query({
      args: { value: dbz.string() },
      access: (_ctx, args) => {
        order.push(`policy:${args.value}`);
        return args.value === "allowed";
      },
      handler: (_ctx, args) => {
        order.push(`handler:${args.value}`);
        return args.value;
      },
    });
    const context = { auth: userPrincipal(), db: Object.freeze({}) as never };

    expect(await invokeFunction(fn, context, { value: "allowed" }, {
      onAuthorized: (safeContext, args) => {
        expect(Object.isFrozen(safeContext)).toBe(true);
        expect(Object.isFrozen(args)).toBe(true);
        order.push(`authorized:${args.value}`);
      },
    })).toBe("allowed");
    expect(order).toEqual(["policy:allowed", "authorized:allowed", "handler:allowed"]);

    await expect(invokeFunction(fn, context, { value: "denied" }, {
      onAuthorized: () => order.push("must-not-run"),
    })).rejects.toMatchObject({ code: "unauthorized" });
    expect(order).not.toContain("must-not-run");
  });

  test("builtin policies distinguish unauthenticated from unauthorized", async () => {
    const authenticated = query({
      args: {},
      access: "authenticated",
      handler: (ctx) => ctx.auth.kind,
    });
    const system = query({
      args: {},
      access: "system",
      handler: (ctx) => ctx.auth.kind,
    });

    await expectDbzzError(authenticated({ auth: ANONYMOUS_PRINCIPAL }, {}), "unauthenticated");
    expect(await authenticated({ auth: userPrincipal() }, {})).toBe("user");
    expect(await authenticated({ auth: SYSTEM_PRINCIPAL }, {})).toBe("system");
    await expectDbzzError(system({ auth: ANONYMOUS_PRINCIPAL }, {}), "unauthenticated");
    await expectDbzzError(system({ auth: userPrincipal() }, {}), "unauthorized");
    expect(await system({ auth: SYSTEM_PRINCIPAL }, {})).toBe("system");
  });

  test("callback denial and exceptions fail closed", async () => {
    const denied = query({
      args: {},
      access: () => false,
      handler: () => "unreachable",
    });
    const throws = query({
      args: {},
      access: () => {
        throw new DbzzError("internal", "private policy detail");
      },
      handler: () => "unreachable",
    });

    await expectDbzzError(denied({ auth: ANONYMOUS_PRINCIPAL }, {}), "unauthenticated");
    await expectDbzzError(denied({ auth: userPrincipal() }, {}), "unauthorized");
    const error = await expectDbzzError(throws({ auth: ANONYMOUS_PRINCIPAL }, {}), "unauthorized");
    expect(error.message).toBe("access denied");
  });

  test("nested calls reuse the exact parent principal and re-run callee policy", async () => {
    let calleePolicyCalls = 0;
    const callee = query({
      args: {},
      access: () => {
        calleePolicyCalls += 1;
        return true;
      },
      handler: (ctx) => ctx.auth.kind,
    });
    const samePrincipal = query({
      args: {},
      access: "public",
      handler: (ctx) => callee(ctx, {}),
    });
    const replacedPrincipal = query({
      args: {},
      access: "public",
      handler: () => callee({ auth: { kind: "anonymous" } }, {}),
    });

    expect(await samePrincipal({ auth: ANONYMOUS_PRINCIPAL }, {})).toBe("anonymous");
    expect(calleePolicyCalls).toBe(1);
    await expectDbzzError(replacedPrincipal({ auth: ANONYMOUS_PRINCIPAL }, {}), "unauthorized");
    expect(calleePolicyCalls).toBe(1);
  });
});

interface IssuerFixture {
  readonly options: OidcVerifierOptions;
  readonly networkCalls: () => number;
  token(overrides?: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly claims?: Record<string, unknown>;
    readonly typ?: string;
    readonly notBefore?: number;
    readonly expiresAt?: number | null;
  }): Promise<string>;
}

async function issuerFixture(overrides: Partial<OidcVerifierOptions> = {}): Promise<IssuerFixture> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
  let calls = 0;
  const options: OidcVerifierOptions = {
    providers: [
      {
        issuer: ISSUER,
        jwksUri: JWKS_URI,
        audiences: [AUDIENCE],
        algorithms: ["RS256"],
        tokenType: "at+jwt",
        principalKind: "user",
        requiredClaims: ["client_id"],
        claimNames: ["client_id", "roles"],
      },
    ],
    fetch: async (url) => {
      calls += 1;
      expect(url).toBe(JWKS_URI);
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    ...overrides,
  };

  return {
    options,
    networkCalls: () => calls,
    token: async (tokenOverrides = {}) => {
      const now = Math.floor(Date.now() / 1_000);
      const token = new SignJWT({
        client_id: "client-1",
        roles: ["reader"],
        ...tokenOverrides.claims,
      })
        .setProtectedHeader({
          alg: "RS256",
          kid: "test-key",
          typ: tokenOverrides.typ ?? "at+jwt",
        })
        .setIssuer(tokenOverrides.issuer ?? ISSUER)
        .setAudience(tokenOverrides.audience ?? AUDIENCE)
        .setSubject("subject-1")
        .setIssuedAt(now)
        .setJti("token-1");
      if (tokenOverrides.notBefore !== undefined) token.setNotBefore(tokenOverrides.notBefore);
      if (tokenOverrides.expiresAt !== null) {
        token.setExpirationTime(tokenOverrides.expiresAt ?? now + 60);
      }
      return token.sign(privateKey);
    },
  };
}

describe("createOidcVerifier", () => {
  test("verifies pinned claims, freezes the principal, and reuses the JWKS cache", async () => {
    const fixture = await issuerFixture();
    const verifier = createOidcVerifier(fixture.options);
    const token = await fixture.token();

    const first = await verifier.verify(token);
    const second = await verifier.verify(token);

    expect(first).toMatchObject({
      kind: "user",
      issuer: ISSUER,
      subject: "subject-1",
      tokenId: "token-1",
      claims: { client_id: "client-1", roles: ["reader"] },
    });
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.claims)).toBe(true);
    expect(Object.isFrozen(first.claims.roles)).toBe(true);
    expect(second).toEqual(first);
    expect(fixture.networkCalls()).toBe(1);
    expect(verifier.revocationBound).toEqual({ kind: "token-expiration" });
  });

  test("unknown issuers fail before any network request", async () => {
    const fixture = await issuerFixture();
    const verifier = createOidcVerifier(fixture.options);
    const unknownIssuerToken = await fixture.token({ issuer: "https://attacker.example/" });

    await expectDbzzError(verifier.verify(unknownIssuerToken), "unauthenticated");
    expect(fixture.networkCalls()).toBe(0);
  });

  test("rejects wrong audience, type, future nbf, and missing exp", async () => {
    const fixture = await issuerFixture();
    const verifier = createOidcVerifier(fixture.options);

    const wrongAudience = await fixture.token({ audience: "other-audience" });
    const wrongType = await fixture.token({ typ: "JWT" });
    const futureNbf = await fixture.token({ notBefore: Math.floor(Date.now() / 1_000) + 3_600 });
    const missingExp = await fixture.token({ expiresAt: null });

    await expectDbzzError(verifier.verify(wrongAudience), "unauthenticated");
    await expectDbzzError(verifier.verify(wrongType), "unauthenticated");
    await expectDbzzError(verifier.verify(futureNbf), "unauthenticated");
    await expectDbzzError(verifier.verify(missingExp), "unauthenticated");
  });

  test("rejects oversized credentials before decoding or fetching", async () => {
    const fixture = await issuerFixture();
    const verifier = createOidcVerifier(fixture.options);

    await expectDbzzError(verifier.verify("x".repeat(16 * 1024 + 1)), "unauthenticated");
    expect(fixture.networkCalls()).toBe(0);
  });

  test("maps oversized JWKS documents to retryable auth_unavailable", async () => {
    const fixture = await issuerFixture({
      jwksMaxBytes: 64,
      fetch: async () =>
        new Response(JSON.stringify({ keys: [{ padding: "x".repeat(128) }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const verifier = createOidcVerifier(fixture.options);
    const error = await expectDbzzError(verifier.verify(await fixture.token()), "auth_unavailable");

    expect(error.retryable).toBe(true);
  });

  test("configuration cannot raise the documented hard resource bounds", async () => {
    const fixture = await issuerFixture();
    expect(() => createOidcVerifier({ ...fixture.options, maxTokenBytes: 16 * 1024 + 1 })).toThrow(
      "maxTokenBytes must not exceed",
    );
    expect(() => createOidcVerifier({ ...fixture.options, jwksTimeoutMs: 5_001 })).toThrow(
      "jwksTimeoutMs must not exceed",
    );
    expect(() => createOidcVerifier({ ...fixture.options, jwksMaxBytes: 1024 * 1024 + 1 })).toThrow(
      "jwksMaxBytes must not exceed",
    );
    expect(() => createOidcVerifier({ ...fixture.options, maxJwksKeys: 33 })).toThrow(
      "maxJwksKeys must not exceed",
    );
  });
});
