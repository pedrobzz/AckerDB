import { describe, expect, test } from "bun:test";
import type { UserPrincipal, WorkloadPrincipal } from "../../src/auth/credentials.ts";
import {
  callerFairnessKey,
  externalAccountFairnessKey,
  transportSource,
} from "../../src/runtime/caller.ts";

const source = transportSource({ family: "IPv4", address: "127.0.0.1" });

function user(
  identity = 1n as UserPrincipal["identity"],
  overrides: Partial<Omit<UserPrincipal, "identity">> = {},
): UserPrincipal {
  return Object.freeze({
    kind: "user",
    identity,
    issuer: "https://issuer.example",
    subject: "alice",
    claims: Object.freeze({ role: "member" }),
    expiresAt: 1_000,
    tokenId: "token-one",
    ...overrides,
  });
}

describe("caller fairness identity", () => {
  test("uses durable Identity for users and exact issuer/subject for workloads", () => {
    const first = callerFairnessKey(user(), source);
    const refreshed = callerFairnessKey(user(1n as UserPrincipal["identity"], {
      claims: Object.freeze({ role: "admin", private: "claim-canary" }),
      expiresAt: 9_999,
      tokenId: "token-two-canary",
      issuer: "https://refreshed.example",
      subject: "linked-account",
    }), transportSource({ family: "IPv6", address: "::1" }));
    const workload: WorkloadPrincipal = Object.freeze({
      kind: "workload",
      issuer: "https://issuer.example",
      subject: "alice",
      claims: Object.freeze({ role: "member" }),
      expiresAt: 1_000,
      tokenId: "token-one",
    });

    expect(refreshed).toBe(first);
    expect(callerFairnessKey(user(2n as UserPrincipal["identity"]), source)).not.toBe(first);
    expect(callerFairnessKey(workload, source)).not.toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("issuer");
    expect(first).not.toContain("token");
  });

  test("groups anonymous work by actual source family and address", () => {
    const anonymous = Object.freeze({ kind: "anonymous" } as const);
    const first = callerFairnessKey(anonymous, source);

    expect(callerFairnessKey(
      anonymous,
      transportSource({ family: "IPv4", address: "127.0.0.1" }),
    )).toBe(first);
    expect(callerFairnessKey(
      anonymous,
      transportSource({ family: "IPv4", address: "127.0.0.2" }),
    )).not.toBe(first);
    expect(callerFairnessKey(
      anonymous,
      transportSource({ family: "IPv6", address: "127.0.0.1" }),
    )).not.toBe(first);
  });

  test("groups pre-Identity work by exact verified external account", () => {
    const first = externalAccountFairnessKey({
      issuer: "https://issuer.example",
      subject: "alice",
    });
    expect(externalAccountFairnessKey({
      issuer: "https://issuer.example",
      subject: "alice",
    })).toBe(first);
    expect(externalAccountFairnessKey({
      issuer: "https://other.example",
      subject: "alice",
    })).not.toBe(first);
    expect(externalAccountFairnessKey({
      issuer: "https://issuer.example",
      subject: "bob",
    })).not.toBe(first);
  });
});
