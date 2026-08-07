/**
 * Fail-closed descendant propagation: an external-account invalidation must
 * revoke live credential descendants within the declared revocation bound
 * even when the descendant lookup cannot run — a saturated read queue or a
 * failing read publishes a conservative issuer-wide credential invalidation
 * instead of leaving non-expiring descendants authorized indefinitely.
 */
import { describe, expect, test } from "bun:test";
import { CREDENTIAL_ISSUER } from "../../src/auth/credential-token.ts";
import type { PrincipalInvalidation } from "../../src/auth/credentials.ts";
import {
  RuntimeCredentials,
  type RuntimeCredentialsOptions,
} from "../../src/runtime/credentials/runtime.ts";

const DEADLINE_MS = 40;

interface Propagation {
  readonly emit: (invalidation: PrincipalInvalidation) => void;
  readonly exact: string[];
  readonly issuerWide: string[];
}

function propagation(submit: () => Promise<unknown>): Propagation {
  const exact: string[] = [];
  const issuerWide: string[] = [];
  let emit: ((invalidation: PrincipalInvalidation) => void) | undefined;
  const options: RuntimeCredentialsOptions = {
    engine: {} as never,
    reads: () => ({ submit }) as never,
    now: Date.now,
    assertReady: () => {},
    operationSignal: (signal) => signal ?? new AbortController().signal,
    subscribeInvalidation: () => () => {},
    publishAccountInvalidation: (account) => void exact.push(account.subject),
    publishIssuerInvalidation: (issuer) => void issuerWide.push(issuer),
    revocationDeadlineMs: DEADLINE_MS,
  };
  new RuntimeCredentials(options).propagateExternalInvalidations((listener) => {
    emit = listener;
    return () => {};
  });
  return { emit: emit!, exact, issuerWide };
}

async function eventually(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  return check();
}

describe("credential descendant propagation fails closed", () => {
  test("a failing descendant read publishes an issuer-wide credential invalidation", async () => {
    const { emit, exact, issuerWide } = propagation(
      () => Promise.reject(new Error("admission refused")),
    );
    emit({ issuer: "https://issuer.example", subject: "alice" });
    expect(await eventually(() => issuerWide.length === 1, DEADLINE_MS)).toBe(true);
    expect(issuerWide).toEqual([CREDENTIAL_ISSUER]);
    expect(exact).toEqual([]);
  });

  test("a stalled descendant read fails closed within the revocation bound", async () => {
    const { emit, issuerWide } = propagation(() => new Promise(() => {}));
    emit({ issuer: "https://issuer.example", subject: "alice" });
    // A saturated queue can hold the lookup far past the auth contract's
    // deadline; conservative revocation must not wait for it.
    expect(await eventually(() => issuerWide.length === 1, DEADLINE_MS * 3)).toBe(true);
    expect(issuerWide).toEqual([CREDENTIAL_ISSUER]);
  });

  test("a successful lookup publishes exact descendants and no conservative fallback", async () => {
    const { emit, exact, issuerWide } = propagation(
      () => Promise.resolve(["token-child", "token-grandchild"]),
    );
    emit({ issuer: "https://issuer.example", subject: "alice" });
    expect(await eventually(() => exact.length === 2, DEADLINE_MS)).toBe(true);
    expect(exact).toEqual(["token-child", "token-grandchild"]);
    // The cleared deadline never fires a late conservative invalidation.
    await new Promise<void>((resolve) => setTimeout(resolve, DEADLINE_MS * 2));
    expect(issuerWide).toEqual([]);
  });
});
