import { describe, expect, test } from "bun:test";
import { stableEncode, type Identity } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  policyScope,
  type Principal,
  type UserPrincipal,
  type WorkloadPrincipal,
} from "../../src/auth/credentials.ts";

/**
 * A vault-issued Admin Credential: an Identity holding the two wildcard
 * patterns, and the kind of credential whose expiry is "never".
 */
const NEVER_EXPIRES: UserPrincipal = {
  kind: "user",
  issuer: "ackerdb:credentials",
  subject: "cred_1",
  claims: {},
  expiresAt: Number.POSITIVE_INFINITY,
  tokenId: null,
  identity: 1n as Identity,
  scopes: ["*", "_*"],
};

/** A workload verified by an external issuer, with a real expiry. */
const WORKLOAD: WorkloadPrincipal = {
  kind: "workload",
  issuer: "https://idp.example",
  subject: "svc-1",
  claims: { region: "eu" },
  expiresAt: 1_800_000,
  tokenId: "jti-w",
};

const USER: UserPrincipal = {
  kind: "user",
  issuer: "https://idp.example",
  subject: "user-1",
  claims: { email: "a@example.com" },
  expiresAt: 1_800_000,
  tokenId: "jti-1",
  identity: 42n as Identity,
  scopes: ["orders:read"],
};

function fingerprint(principal: Principal): string {
  return stableEncode(policyScope(principal));
}

/** A different value of the same kind, so the field's own type is preserved. */
function somethingElse(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value + 1 : 1;
  if (typeof value === "bigint") return value + 1n;
  if (typeof value === "string") return `${value}-other`;
  if (Array.isArray(value)) return [...value, "other"];
  if (value === null) return "other";
  return { ...(value as object), other: true };
}

describe("the reactive key a principal produces", () => {
  test("a credential whose expiry is never can be keyed at all", () => {
    // The defect this pins: `POSITIVE_INFINITY` is the sanctioned expiry of an
    // identity credential and the encoding refuses non-finite numbers, so
    // keying a principal directly threw on subscribe. Every client holding an
    // identity credential — Studio above all — could open no subscription, and
    // the failure surfaced as an opaque `internal`.
    expect(() => stableEncode(NEVER_EXPIRES)).toThrow(/non-finite/);
    expect(() => fingerprint(NEVER_EXPIRES)).not.toThrow();
  });

  test("every principal kind is keyable", () => {
    for (const principal of [ANONYMOUS_PRINCIPAL, SYSTEM_PRINCIPAL, NEVER_EXPIRES, WORKLOAD, USER]) {
      expect(() => fingerprint(principal)).not.toThrow();
    }
  });

  test("every field a handler can read changes the key", () => {
    // The invariant, and the reason it is this strong: subscribers sharing a
    // key share one evaluation, and that evaluation runs with the whole
    // principal as `ctx.auth`. A field left out of the key is a field a handler
    // may branch on while two principals still receive one answer — so the key
    // has to move whenever anything visible moves, including the two that
    // describe the credential rather than its authority.
    const variants: readonly (readonly [string, Principal])[] = [
      ["identity", { ...USER, identity: 43n as Identity }],
      ["scopes", { ...USER, scopes: ["orders:write"] }],
      ["claims", { ...USER, claims: { email: "b@example.com" } }],
      ["issuer", { ...USER, issuer: "https://other.example" }],
      ["subject", { ...USER, subject: "user-2" }],
      ["expiresAt", { ...USER, expiresAt: USER.expiresAt + 60_000 }],
      ["tokenId", { ...USER, tokenId: "jti-2" }],
      ["derivedFrom", { ...USER, derivedFrom: [{ issuer: "https://idp.example", subject: "root" }] }],
      ["kind", { ...WORKLOAD, issuer: USER.issuer, subject: USER.subject, claims: USER.claims }],
    ];
    for (const [field, principal] of variants) {
      expect(`${field}:${fingerprint(principal)}`).not.toBe(`${field}:${fingerprint(USER)}`);
    }
  });

  test("no field is dropped on the way into the key", () => {
    // Written against the principal's own keys rather than a list, so a field
    // added to `Principal` later cannot quietly stay out of the key: mutating
    // anything the handler receives has to move the fingerprint. The
    // replacement keeps the field's own type, because a string standing in for
    // a number would be testing the encoding rather than the key.
    for (const source of [USER, WORKLOAD, NEVER_EXPIRES] as readonly Principal[]) {
      const baseline = fingerprint(source);
      for (const [field, value] of Object.entries(source)) {
        if (field === "kind") continue;
        const mutated = { ...source, [field]: somethingElse(value) } as Principal;
        expect(`${field}:${fingerprint(mutated)}`).not.toBe(`${field}:${baseline}`);
      }
    }
  });

  test("never is a value of its own, distinct from any expiry a clock produces", () => {
    // The sentinel is a string, so it cannot collide with a finite expiry
    // however large — the encoding keeps the two types apart.
    const enormous: Principal = { ...NEVER_EXPIRES, expiresAt: Number.MAX_SAFE_INTEGER };
    expect(fingerprint(NEVER_EXPIRES)).not.toBe(fingerprint(enormous));
    expect(fingerprint(NEVER_EXPIRES)).toBe(fingerprint({ ...NEVER_EXPIRES }));
  });

  test("the two credentialless kinds are distinct from each other", () => {
    expect(fingerprint(ANONYMOUS_PRINCIPAL)).not.toBe(fingerprint(SYSTEM_PRINCIPAL));
  });
});
