import { describe, expect, test } from "bun:test";
import type { Credential } from "@dbzz/core";
import {
  acquireAuthLease,
  assertCredentialVerifier,
  MAX_REVOCATION_DEADLINE_MS,
  validateCredentialVerifierRevocation,
  type AuthLeaseClock,
} from "../src/auth-lease.ts";
import {
  ANONYMOUS_PRINCIPAL,
  type AuthenticatedPrincipal,
  type CredentialVerifier,
  type IdentityResolver,
  type PrincipalInvalidation,
  type RevocationBound,
  type VerifiedCredential,
} from "../src/auth.ts";
import { DbzzError } from "../src/errors.ts";

const BEARER: Credential = Object.freeze({ kind: "bearer", token: "credential" });
const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function user(expiresAt: number): VerifiedCredential {
  return {
    kind: "user",
    issuer: "https://issuer.example",
    subject: "user-1",
    claims: { role: "member" },
    expiresAt,
    tokenId: "token-1",
  };
}

async function dbzzRejection(promise: Promise<unknown>): Promise<DbzzError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DbzzError);
  return caught as DbzzError;
}

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

class ManualClock implements AuthLeaseClock {
  nowMs: number;
  clearCalls = 0;
  readonly delays: number[] = [];
  private nextId = 0;
  private readonly timers = new Map<number, Timer>();

  constructor(nowMs = 0) {
    this.nowMs = nowMs;
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.delays.push(delayMs);
    this.timers.set(id, { id, at: this.nowMs + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.clearCalls++;
    this.timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (next === undefined) break;
      this.timers.delete(next.id);
      this.nowMs = next.at;
      next.callback();
    }
    this.nowMs = target;
  }
}

type AbortListener =
  | ((event: { readonly type: "abort" }) => void)
  | { handleEvent(event: { readonly type: "abort" }): void };

class TrackingSignal {
  aborted = false;
  reason: unknown;
  addCalls = 0;
  removeCalls = 0;
  private readonly listeners = new Set<AbortListener>();

  readonly signal = this as unknown as AbortSignal;

  addEventListener(_type: string, listener: AbortListener | null): void {
    if (listener === null) return;
    this.addCalls++;
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: AbortListener | null): void {
    if (listener === null) return;
    this.removeCalls++;
    this.listeners.delete(listener);
  }

  abort(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") listener({ type: "abort" });
      else listener.handleEvent({ type: "abort" });
    }
  }
}

type Verification = VerifiedCredential | Error | Promise<VerifiedCredential>;

class FakeVerifier implements CredentialVerifier {
  readonly events: string[] = [];
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  verification: Verification;
  private listener: ((invalidation: PrincipalInvalidation) => void) | undefined;

  constructor(
    verification: Verification,
    readonly revocationBound: RevocationBound = { kind: "invalidation", deadlineMs: 1_000 },
  ) {
    this.verification = verification;
  }

  async verify(credential: string): Promise<VerifiedCredential> {
    this.events.push(`verify:${credential}`);
    const verification = this.verification;
    if (verification instanceof Error) throw verification;
    return verification;
  }

  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void {
    this.events.push("subscribe");
    this.subscribeCalls++;
    this.listener = listener;
    return () => {
      this.events.push("unsubscribe");
      this.unsubscribeCalls++;
      this.listener = undefined;
    };
  }

  emit(invalidation: PrincipalInvalidation): void {
    this.listener?.(invalidation);
  }
}

function options(
  verifier: CredentialVerifier,
  clock: AuthLeaseClock,
  signal?: AbortSignal,
) {
  const resolveIdentity: IdentityResolver = async () => 1n as Awaited<ReturnType<IdentityResolver>>;
  return {
    credential: BEARER,
    verifier,
    clock,
    resolveIdentity,
    revocationDeadlineMs: MAX_REVOCATION_DEADLINE_MS,
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("auth lease", () => {
  test("anonymous credentials reuse only the caller signal and allocate no verifier resources", async () => {
    const caller = new TrackingSignal();
    const verifier = new FakeVerifier(user(1_000));
    const lease = await acquireAuthLease({
      ...options(verifier, new ManualClock(), caller.signal),
      credential: { kind: "anonymous" },
    });

    expect(lease.principal).toBe(ANONYMOUS_PRINCIPAL);
    expect(lease.signal).toBe(caller.signal);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(verifier.events).toEqual([]);
    expect(caller.addCalls).toBe(0);
    lease.release();
    lease.release();
    caller.abort("disconnected");
    expect(lease.signal.aborted).toBe(true);
  });

  test("validates missing, malformed, and excessive verifier guarantees", async () => {
    expect(() => assertCredentialVerifier({}, 5_000)).toThrow(
      "credential verifier must implement verify(credential)",
    );

    const missing = new FakeVerifier(user(1_000)) as CredentialVerifier & { revocationBound?: RevocationBound };
    Object.defineProperty(missing, "revocationBound", { value: undefined });
    expect(() => validateCredentialVerifierRevocation(missing, 5_000))
      .toThrow("verifier must declare a revocationBound");

    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const malformed = new FakeVerifier(
        user(1_000),
        { kind: "invalidation", deadlineMs } as RevocationBound,
      );
      expect(() => validateCredentialVerifierRevocation(malformed, 5_000))
        .toThrow("verifier invalidation deadlineMs must be a positive finite number");
    }

    for (const configured of [0, -1, 1.5, 5_001]) {
      expect(() => validateCredentialVerifierRevocation(undefined, configured))
        .toThrow("revocationDeadlineMs must be an integer from 1 through 5000");
    }

    const excessive = new FakeVerifier(user(1_000), { kind: "invalidation", deadlineMs: 5_001 });
    expect(() => validateCredentialVerifierRevocation(excessive, 5_000))
      .toThrow("verifier invalidation deadlineMs cannot exceed revocationDeadlineMs");
    await expect(acquireAuthLease(options(excessive, new ManualClock()))).rejects.toThrow(
      "verifier invalidation deadlineMs cannot exceed revocationDeadlineMs",
    );
    expect(excessive.events).toEqual([]);

    expect(() => validateCredentialVerifierRevocation(
      new FakeVerifier(user(1_000), { kind: "token-expiration" }),
      5_000,
    )).not.toThrow();
  });

  test("subscribes before verification and releases every owned resource exactly once", async () => {
    const clock = new ManualClock(100);
    const caller = new TrackingSignal();
    const verifier = new FakeVerifier(user(1_000));
    const lease = await acquireAuthLease(options(verifier, clock, caller.signal));

    expect(verifier.events).toEqual(["subscribe", "verify:credential"]);
    expect(caller.addCalls).toBe(1);
    expect(clock.delays).toEqual([900]);
    expect(clock.pendingTimers).toBe(1);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.principal)).toBe(true);
    expect(Object.isFrozen((lease.principal as AuthenticatedPrincipal).claims)).toBe(true);

    lease.release();
    lease.release();
    expect(verifier.unsubscribeCalls).toBe(1);
    expect(caller.removeCalls).toBe(1);
    expect(clock.clearCalls).toBe(1);
    expect(clock.pendingTimers).toBe(0);
    verifier.emit({ issuer: "https://issuer.example" });
    caller.abort("late cancellation");
    expect(lease.signal.aborted).toBe(false);
  });

  test("any invalidation racing verification fails closed and cleans the pending lease", async () => {
    const pendingVerification = deferred<VerifiedCredential>();
    const clock = new ManualClock();
    const verifier = new FakeVerifier(pendingVerification.promise);
    const pendingLease = acquireAuthLease(options(verifier, clock));
    expect(verifier.events).toEqual(["subscribe", "verify:credential"]);

    verifier.emit({ issuer: "unrelated-before-principal-is-known" });
    const error = await dbzzRejection(pendingLease);
    expect(error).toMatchObject({ code: "unauthenticated", message: "credential revoked" });
    expect(error.cause).toBeUndefined();
    expect(verifier.unsubscribeCalls).toBe(1);
    expect(clock.pendingTimers).toBe(0);

    pendingVerification.resolve(user(1_000));
    await Promise.resolve();
  });

  test("ignores unrelated invalidations and aborts on a matching issuer, subject, and token", async () => {
    const clock = new ManualClock();
    const verifier = new FakeVerifier(user(1_000));
    const lease = await acquireAuthLease(options(verifier, clock));

    verifier.emit({ issuer: "https://other.example" });
    verifier.emit({ issuer: "https://issuer.example", subject: "user-2" });
    verifier.emit({ issuer: "https://issuer.example", tokenId: "token-2" });
    expect(lease.signal.aborted).toBe(false);

    verifier.emit({
      issuer: "https://issuer.example",
      subject: "user-1",
      tokenId: "token-1",
    });
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ code: "unauthenticated", message: "credential revoked" });
    expect(verifier.unsubscribeCalls).toBe(1);
    expect(clock.clearCalls).toBe(1);
    lease.release();
    expect(verifier.unsubscribeCalls).toBe(1);
  });

  test("expires at the verified timestamp and releases naturally fired timers", async () => {
    const clock = new ManualClock(100);
    const verifier = new FakeVerifier(user(1_000));
    const lease = await acquireAuthLease(options(verifier, clock));

    clock.advance(899);
    expect(lease.signal.aborted).toBe(false);
    clock.advance(1);
    expect(lease.signal.reason).toMatchObject({
      code: "unauthenticated",
      message: "credential expired",
    });
    expect(verifier.unsubscribeCalls).toBe(1);
    expect(clock.pendingTimers).toBe(0);
    expect(clock.clearCalls).toBe(0);
  });

  test("chunks platform timer limits without expiring before expiresAt", async () => {
    const clock = new ManualClock(10);
    const verifier = new FakeVerifier(user(10 + MAX_TIMER_DELAY_MS + 10));
    const lease = await acquireAuthLease(options(verifier, clock));

    expect(clock.delays).toEqual([MAX_TIMER_DELAY_MS]);
    clock.advance(MAX_TIMER_DELAY_MS);
    expect(lease.signal.aborted).toBe(false);
    expect(clock.delays).toEqual([MAX_TIMER_DELAY_MS, 10]);
    clock.advance(9);
    expect(lease.signal.aborted).toBe(false);
    clock.advance(1);
    expect(lease.signal.reason).toMatchObject({ code: "unauthenticated", message: "credential expired" });
  });

  test("sanitizes caller cancellation and removes all lease ownership", async () => {
    const clock = new ManualClock();
    const caller = new TrackingSignal();
    const verifier = new FakeVerifier(user(1_000));
    const lease = await acquireAuthLease(options(verifier, clock, caller.signal));

    caller.abort("raw cancellation detail");
    expect(lease.signal.reason).toMatchObject({
      code: "unavailable",
      message: "operation was canceled",
      resource: "operation",
    });
    expect(String(lease.signal.reason)).not.toContain("raw cancellation detail");
    expect(verifier.unsubscribeCalls).toBe(1);
    expect(caller.removeCalls).toBe(1);
    expect(clock.clearCalls).toBe(1);
  });

  test("preserves credential verification error mapping and cleans failures", async () => {
    const unavailableVerifier = new FakeVerifier(new Error("private verifier failure"));
    const unavailable = await dbzzRejection(acquireAuthLease(options(unavailableVerifier, new ManualClock())));
    expect(unavailable).toMatchObject({
      code: "auth_unavailable",
      message: "credential verification is temporarily unavailable",
      retryable: true,
    });
    expect(unavailableVerifier.unsubscribeCalls).toBe(1);

    const denied = new DbzzError("unauthenticated", "invalid credential");
    const deniedVerifier = new FakeVerifier(denied);
    expect(await dbzzRejection(acquireAuthLease(options(deniedVerifier, new ManualClock())))).toBe(denied);
    expect(deniedVerifier.unsubscribeCalls).toBe(1);

    const expiredVerifier = new FakeVerifier(user(100));
    const expiredAtAcquisition = await dbzzRejection(
      acquireAuthLease(options(expiredVerifier, new ManualClock(100))),
    );
    expect(expiredAtAcquisition).toMatchObject({ code: "unauthenticated", message: "invalid credential" });
    expect(expiredVerifier.unsubscribeCalls).toBe(1);
  });
});
