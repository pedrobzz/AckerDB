import { describe, expect, test } from "bun:test";
import type { Identity } from "@ackerdb/core";
import {
  checkRequirementAgainstVocabulary,
  enforceScopeRequirement,
  expandScopeGrant,
  FRAMEWORK_SCOPES,
  isScopeAuthorized,
  isScopeGrant,
  isScopePattern,
  knownScopeVocabulary,
  normalizeScopeRequirement,
  principalScopes,
  validateScopeVocabulary,
} from "../../src/auth/scopes.ts";
import {
  effectiveChildScopes,
  issueChildScopes,
} from "../../src/auth/child-credentials.ts";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  verifyClientCredential,
  type PrincipalInvalidation,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { acquireAuthLease } from "../../src/auth/lease.ts";
import { AckerDBError } from "../../src/shared/errors.ts";

/** An application vocabulary plus a stand-in framework half, as the runtime sees it. */
const VOCABULARY = Object.freeze([
  "admin:read",
  "admin:write",
  "notes:read",
  "notes:write",
  "_admin:logs:read",
  "_admin:jobs:write",
]);

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

  test("an application may never declare a framework scope or a pattern", () => {
    expect(() => validateScopeVocabulary(["_admin:logs:read"])).toThrow(/framework/);
    expect(() => validateScopeVocabulary(["_"])).toThrow(/framework/);
    expect(() => validateScopeVocabulary(["notes:*"])).toThrow(/wildcard/);
    expect(() => validateScopeVocabulary(["*"])).toThrow(/wildcard/);
  });

  test("the known vocabulary is the application's plus the framework's", () => {
    expect(knownScopeVocabulary(undefined)).toEqual(FRAMEWORK_SCOPES);
    expect(knownScopeVocabulary(["notes:read"])).toEqual(["notes:read", ...FRAMEWORK_SCOPES]);
  });
});

describe("grant patterns", () => {
  test("a pattern is a name, optionally ending in one wildcard", () => {
    expect(isScopePattern("notes:read")).toBe(true);
    expect(isScopePattern("notes:*")).toBe(true);
    expect(isScopePattern("*")).toBe(true);
    expect(isScopePattern("_*")).toBe(true);
    expect(isScopePattern("*:read")).toBe(false);
    expect(isScopePattern("no*es:*")).toBe(false);
    expect(isScopePattern("")).toBe(false);
  });

  test("a grant is bounded and unique", () => {
    expect(isScopeGrant([])).toBe(true);
    expect(isScopeGrant(["a", "b*"])).toBe(true);
    expect(isScopeGrant(["a", "a"])).toBe(false);
    expect(isScopeGrant("a")).toBe(false);
    expect(isScopeGrant([""])).toBe(false);
    expect(isScopeGrant(Array.from({ length: 129 }, (_, i) => `s:${i}`))).toBe(false);
  });
});

describe("expansion", () => {
  test("a concrete grant expands to itself, in vocabulary order", () => {
    expect(expandScopeGrant(["notes:write", "notes:read"], VOCABULARY))
      .toEqual(["notes:read", "notes:write"]);
  });

  test("a prefix wildcard matches every known scope starting with it", () => {
    expect(expandScopeGrant(["ad*"], VOCABULARY)).toEqual(["admin:read", "admin:write"]);
    expect(expandScopeGrant(["notes:*"], VOCABULARY)).toEqual(["notes:read", "notes:write"]);
  });

  test("a bare * is every application scope and no framework scope", () => {
    expect(expandScopeGrant(["*"], VOCABULARY))
      .toEqual(["admin:read", "admin:write", "notes:read", "notes:write"]);
  });

  test("the framework half is reached only through a marked pattern", () => {
    expect(expandScopeGrant(["_*"], VOCABULARY))
      .toEqual(["_admin:logs:read", "_admin:jobs:write"]);
    expect(expandScopeGrant(["_admin:logs:*"], VOCABULARY)).toEqual(["_admin:logs:read"]);
    // An administrative identity is one holding both halves — nothing else.
    expect(expandScopeGrant(["*", "_*"], VOCABULARY)).toEqual([...VOCABULARY]);
  });

  test("a pattern matching nothing grants nothing", () => {
    expect(expandScopeGrant(["billing:*"], VOCABULARY)).toEqual([]);
    expect(expandScopeGrant(["notes:archive"], VOCABULARY)).toEqual([]);
    expect(expandScopeGrant([], VOCABULARY)).toEqual([]);
    expect(expandScopeGrant(["*"], [])).toEqual([]);
  });

  test("expanding against the current vocabulary covers scopes minted later", () => {
    const minted = ["notes:*"];
    expect(expandScopeGrant(minted, ["notes:read"])).toEqual(["notes:read"]);
    expect(expandScopeGrant(minted, ["notes:read", "notes:archive"]))
      .toEqual(["notes:read", "notes:archive"]);
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

  test("a requirement stays concrete: a wildcard is a declaration error", () => {
    expect(() => normalizeScopeRequirement({ anyOf: ["notes:*"] }, "scopes")).toThrow(/concrete/);
    expect(() => normalizeScopeRequirement({ allOf: ["*"] }, "scopes")).toThrow(/concrete/);
  });

  test("anyOf passes on one held scope; allOf requires every scope", () => {
    const anyOf = normalizeScopeRequirement({ anyOf: ["a", "b"] }, "scopes");
    const allOf = normalizeScopeRequirement({ allOf: ["a", "b"] }, "scopes");
    expect(isScopeAuthorized(anyOf, ["b"])).toBe(true);
    expect(isScopeAuthorized(anyOf, ["c"])).toBe(false);
    expect(isScopeAuthorized(allOf, ["a", "b", "c"])).toBe(true);
    expect(isScopeAuthorized(allOf, ["a"])).toBe(false);
  });

  test("cross-checks requirements against the known vocabulary", () => {
    const requirement = normalizeScopeRequirement({ anyOf: ["notes:read"] }, "scopes");
    expect(() =>
      checkRequirementAgainstVocabulary(requirement, VOCABULARY, "query notes.list"),
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

  test("an administrative grant expands to every requirement it meets", () => {
    const grant = expandScopeGrant(["*", "_*"], VOCABULARY);
    for (const scope of VOCABULARY) {
      expect(isScopeAuthorized(
        normalizeScopeRequirement({ allOf: [scope] }, "scopes"),
        grant,
      )).toBe(true);
    }
  });

  test("principalScopes reads the grant off scope-bearing principals only", () => {
    expect(principalScopes(user(["a"]))).toEqual(["a"]);
    expect(principalScopes(ANONYMOUS_PRINCIPAL)).toEqual([]);
    expect(principalScopes(SYSTEM_PRINCIPAL)).toEqual([]);
  });
});

describe("child credentials", () => {
  test("issuance rejects any scope the issuing identity does not hold", () => {
    const parent = expandScopeGrant(["notes:*"], VOCABULARY);
    expect(issueChildScopes(parent, ["notes:read"], VOCABULARY)).toEqual(["notes:read"]);
    try {
      issueChildScopes(parent, ["admin:read"], VOCABULARY);
      throw new Error("unreachable");
    } catch (error) {
      expect((error as AckerDBError).code).toBe("unauthorized");
      expect((error as AckerDBError).message).toContain('"admin:read"');
    }
  });

  test("a wildcard delegates only what the issuer's own expansion covers", () => {
    const parent = expandScopeGrant(["notes:*"], VOCABULARY);
    expect(issueChildScopes(parent, ["notes:*"], VOCABULARY)).toEqual(["notes:*"]);
    // `*` reaches beyond the issuer, so it cannot be delegated by this parent.
    expect(() => issueChildScopes(parent, ["*"], VOCABULARY)).toThrow(AckerDBError);
  });

  test("issuance validates the requested grant shape", () => {
    try {
      issueChildScopes(["a"], ["a", "a"], VOCABULARY);
      throw new Error("unreachable");
    } catch (error) {
      expect((error as AckerDBError).code).toBe("validation");
    }
  });

  test("use-time grant is the child's expansion intersected with the parent's", () => {
    expect(effectiveChildScopes(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(effectiveChildScopes(["a", "b"], [])).toEqual([]);
    // Standalone identity: its own scopes on both sides are the identity function.
    expect(effectiveChildScopes(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("a child wildcard issued before a scope existed stays bounded by its parent", () => {
    const grown = [...VOCABULARY, "notes:archive"];
    // The child banked `notes:*` when only `notes:read`/`notes:write` existed.
    const child = expandScopeGrant(["notes:*"], grown);
    expect(child).toContain("notes:archive");
    // A parent holding the same pattern grows with it; one holding literals does not.
    expect(effectiveChildScopes(child, expandScopeGrant(["notes:*"], grown)))
      .toContain("notes:archive");
    expect(effectiveChildScopes(child, expandScopeGrant(["notes:read"], grown)))
      .toEqual(["notes:read"]);
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
