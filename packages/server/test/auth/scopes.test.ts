import { describe, expect, test } from "bun:test";
import type { Identity } from "@ackerdb/core";
import {
  checkRequirementAgainstVocabulary,
  enforceScopeRequirement,
  isScopeAuthorized,
  isScopeGrant,
  normalizeScopeRequirement,
  principalScopes,
  RESERVED_SCOPE_PREFIXES,
  validateScopeVocabulary,
} from "../../src/auth/access-policy.ts";
import {
  effectiveChildScopes,
  issueChildScopes,
} from "../../src/auth/child-credentials.ts";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  verifyClientCredential,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { acquireAuthLease } from "../../src/auth/lease.ts";
import type { PrincipalInvalidation } from "../../src/auth/credentials.ts";
import { AckerDBError } from "../../src/shared/errors.ts";

function user(scopes: readonly string[] = []): UserPrincipal {
  return Object.freeze({
    kind: "user",
    identity: 7n as Identity,
    scopes: Object.freeze([...scopes]),
    issuer: "https://issuer.example/",
    subject: "user-7",
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: null,
  });
}

describe("scope vocabulary", () => {
  test("accepts a bounded unique vocabulary and freezes it", () => {
    const scopes = validateScopeVocabulary(["notes:read", "notes:write"]);
    expect(scopes).toEqual(["notes:read", "notes:write"]);
    expect(Object.isFrozen(scopes)).toBe(true);
  });

  test("rejects empty, non-array, oversized, and duplicate vocabularies", () => {
    expect(() => validateScopeVocabulary([])).toThrow(TypeError);
    expect(() => validateScopeVocabulary("notes:read")).toThrow(TypeError);
    expect(() => validateScopeVocabulary(["a", "a"])).toThrow(/duplicate/);
    expect(() => validateScopeVocabulary([""])).toThrow(TypeError);
    expect(() => validateScopeVocabulary([42])).toThrow(TypeError);
    expect(() => validateScopeVocabulary(["x".repeat(257)])).toThrow(/UTF-8/);
    expect(() =>
      validateScopeVocabulary(Array.from({ length: 129 }, (_, i) => `s:${i}`)),
    ).toThrow(/at most/);
  });

  test("rejects every reserved framework namespace", () => {
    expect(RESERVED_SCOPE_PREFIXES).toEqual(["studio:", "internal:"]);
    for (const prefix of RESERVED_SCOPE_PREFIXES) {
      expect(() => validateScopeVocabulary([`${prefix}anything`])).toThrow(/reserved/);
    }
    expect(() => validateScopeVocabulary(["studio:logs:read"])).toThrow(/reserved/);
    expect(() => validateScopeVocabulary(["internal:run"])).toThrow(/reserved/);
  });
});

describe("scope requirements", () => {
  test("normalizes exactly one of anyOf or allOf", () => {
    expect(normalizeScopeRequirement({ anyOf: ["a"] }, "scopes")).toEqual({
      kind: "anyOf",
      scopes: ["a"],
    });
    expect(normalizeScopeRequirement({ allOf: ["a", "b"] }, "scopes")).toEqual({
      kind: "allOf",
      scopes: ["a", "b"],
    });
    expect(() => normalizeScopeRequirement({}, "scopes")).toThrow(TypeError);
    expect(() => normalizeScopeRequirement({ anyOf: ["a"], allOf: ["b"] }, "scopes"))
      .toThrow(/exactly one/);
    expect(() => normalizeScopeRequirement({ anyOf: [] }, "scopes")).toThrow(TypeError);
    expect(() => normalizeScopeRequirement({ anyOf: ["a", "a"] }, "scopes")).toThrow(TypeError);
    expect(() => normalizeScopeRequirement(["a"], "scopes")).toThrow(TypeError);
  });

  test("anyOf passes on one held scope; allOf requires every scope", () => {
    const anyOf = normalizeScopeRequirement({ anyOf: ["a", "b"] }, "scopes");
    const allOf = normalizeScopeRequirement({ allOf: ["a", "b"] }, "scopes");
    expect(isScopeAuthorized(anyOf, ["b"])).toBe(true);
    expect(isScopeAuthorized(anyOf, ["c"])).toBe(false);
    expect(isScopeAuthorized(allOf, ["a", "b", "c"])).toBe(true);
    expect(isScopeAuthorized(allOf, ["a"])).toBe(false);
  });

  test("cross-checks requirements against the declared vocabulary", () => {
    const requirement = normalizeScopeRequirement({ anyOf: ["notes:read"] }, "scopes");
    expect(() =>
      checkRequirementAgainstVocabulary(requirement, ["notes:read"], "query notes.list"),
    ).not.toThrow();
    expect(() =>
      checkRequirementAgainstVocabulary(requirement, ["other:read"], "query notes.list"),
    ).toThrow(/undeclared scope "notes:read"/);
  });
});

describe("scope enforcement", () => {
  const requirement = normalizeScopeRequirement({ anyOf: ["notes:read"] }, "scopes");

  test("system bypasses scopes; anonymous fails unauthenticated", () => {
    expect(() => enforceScopeRequirement(requirement, SYSTEM_PRINCIPAL)).not.toThrow();
    try {
      enforceScopeRequirement(requirement, ANONYMOUS_PRINCIPAL);
      throw new Error("unreachable");
    } catch (error) {
      expect((error as AckerDBError).code).toBe("unauthenticated");
    }
  });

  test("a user passes with the grant and fails unauthorized without it", () => {
    expect(() => enforceScopeRequirement(requirement, user(["notes:read"]))).not.toThrow();
    try {
      enforceScopeRequirement(requirement, user(["notes:write"]));
      throw new Error("unreachable");
    } catch (error) {
      expect((error as AckerDBError).code).toBe("unauthorized");
    }
  });

  test("principalScopes reads the grant off scope-bearing principals only", () => {
    expect(principalScopes(user(["a"]))).toEqual(["a"]);
    expect(principalScopes(ANONYMOUS_PRINCIPAL)).toEqual([]);
    expect(principalScopes(SYSTEM_PRINCIPAL)).toEqual([]);
  });

  test("isScopeGrant validates structure, bounds, and uniqueness", () => {
    expect(isScopeGrant([])).toBe(true);
    expect(isScopeGrant(["a", "b"])).toBe(true);
    expect(isScopeGrant(["a", "a"])).toBe(false);
    expect(isScopeGrant("a")).toBe(false);
    expect(isScopeGrant([""])).toBe(false);
  });
});

describe("child credentials", () => {
  test("issuance rejects any scope the issuing identity does not hold", () => {
    expect(issueChildScopes(["a", "b"], ["b"])).toEqual(["b"]);
    try {
      issueChildScopes(["a"], ["a", "b"]);
      throw new Error("unreachable");
    } catch (error) {
      expect((error as AckerDBError).code).toBe("unauthorized");
      expect((error as AckerDBError).message).toContain('"b"');
    }
  });

  test("issuance validates the requested grant shape", () => {
    try {
      issueChildScopes(["a"], ["a", "a"]);
      throw new Error("unreachable");
    } catch (error) {
      expect((error as AckerDBError).code).toBe("validation");
    }
  });

  test("use-time grant is stored scopes intersected with parent-current scopes", () => {
    expect(effectiveChildScopes(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(effectiveChildScopes(["a", "b"], [])).toEqual([]);
    // Standalone identity: its own scopes on both sides are the identity function.
    expect(effectiveChildScopes(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("credential scope resolution", () => {
  const verifier = {
    revocationBound: { kind: "token-expiration" as const },
    subscribeInvalidation: () => () => {},
    verify: async () => ({
      kind: "user" as const,
      issuer: "https://issuer.example/",
      subject: "user-7",
      claims: {},
      expiresAt: Date.now() + 60_000,
      tokenId: null,
    }),
  };
  const bearer = { kind: "bearer" as const, token: "token" };
  const resolveIdentity = async () => 7n as Identity;

  test("an absent resolver yields the empty grant", async () => {
    const principal = await verifyClientCredential(bearer, verifier, resolveIdentity);
    expect(principal.kind).toBe("user");
    expect((principal as UserPrincipal).scopes).toEqual([]);
  });

  test("a configured resolver's grant rides the principal", async () => {
    const principal = await verifyClientCredential(
      bearer,
      verifier,
      resolveIdentity,
      Date.now,
      (identity, account) => {
        expect(identity).toBe(7n as Identity);
        expect(account).toEqual({ issuer: "https://issuer.example/", subject: "user-7" });
        return ["notes:read"];
      },
    );
    expect((principal as UserPrincipal).scopes).toEqual(["notes:read"]);
  });

  test("an invalid resolver result fails closed as auth_unavailable", async () => {
    await expect(verifyClientCredential(
      bearer,
      verifier,
      resolveIdentity,
      Date.now,
      () => ["a", "a"],
    )).rejects.toMatchObject({ code: "auth_unavailable" });
  });

  test("a lease carries the resolved grant and fails closed on account invalidation", async () => {
    let listener: ((invalidation: PrincipalInvalidation) => void) | undefined;
    const invalidatingVerifier = {
      ...verifier,
      revocationBound: { kind: "invalidation" as const, deadlineMs: 1_000 },
      subscribeInvalidation: (l: (invalidation: PrincipalInvalidation) => void) => {
        listener = l;
        return () => {};
      },
    };
    const lease = await acquireAuthLease({
      credential: bearer,
      verifier: invalidatingVerifier,
      resolveIdentity,
      resolveScopes: () => ["notes:read"],
      revocationDeadlineMs: 1_000,
    });
    expect((lease.principal as UserPrincipal).scopes).toEqual(["notes:read"]);
    // A grant change published through the generic auth-invalidation path
    // cancels the lease; the next verification re-reads the resolver.
    listener!({ issuer: "https://issuer.example/", subject: "user-7" });
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  test("a resolver rejection fails closed as auth_unavailable", async () => {
    await expect(verifyClientCredential(
      bearer,
      verifier,
      resolveIdentity,
      Date.now,
      () => {
        throw new Error("grants store offline");
      },
    )).rejects.toMatchObject({ code: "auth_unavailable" });
  });
});
