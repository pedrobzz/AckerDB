import { describe, expect, test } from "bun:test";
import type { UserPrincipal, WorkloadPrincipal } from "../src/auth.ts";
import {
  callerFairnessKey,
  transportSource,
} from "../src/caller.ts";

const source = transportSource({ family: "IPv4", address: "127.0.0.1" });

function user(overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  return Object.freeze({
    kind: "user",
    issuer: "https://issuer.example",
    subject: "alice",
    claims: Object.freeze({ role: "member" }),
    expiresAt: 1_000,
    tokenId: "token-one",
    ...overrides,
  });
}

describe("caller fairness identity", () => {
  test("uses only verified principal kind, issuer, and subject", () => {
    const first = callerFairnessKey(user(), source);
    const refreshed = callerFairnessKey(user({
      claims: Object.freeze({ role: "admin", private: "claim-canary" }),
      expiresAt: 9_999,
      tokenId: "token-two-canary",
    }), transportSource({ family: "IPv6", address: "::1" }));
    const workload: WorkloadPrincipal = Object.freeze({
      ...user(),
      kind: "workload",
    });

    expect(refreshed).toBe(first);
    expect(callerFairnessKey(user({ subject: "bob" }), source)).not.toBe(first);
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
});
