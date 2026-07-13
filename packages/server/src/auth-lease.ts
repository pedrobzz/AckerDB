import type { Credential } from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  verifyClientCredential,
  type ClientPrincipal,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type VerifiedPrincipal,
} from "./auth.ts";
import { DbzzError, isDbzzError } from "./errors.ts";

export interface AuthLeaseClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuthLease {
  readonly principal: ClientPrincipal;
  readonly signal: AbortSignal;
  release(): void;
}

export interface AcquireAuthLeaseOptions {
  readonly credential: Credential;
  readonly verifier?: CredentialVerifier;
  readonly signal?: AbortSignal;
  readonly revocationDeadlineMs: number;
  readonly clock?: AuthLeaseClock;
}

const MAX_TIMER_DELAY_MS = 0x7fff_ffff;
export const MAX_REVOCATION_DEADLINE_MS = 5_000;
const NEVER_ABORTED = new AbortController().signal;
const SYSTEM_CLOCK: AuthLeaseClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function verifierUnavailable(cause: unknown): DbzzError {
  return isDbzzError(cause)
    ? cause
    : new DbzzError("auth_unavailable", "credential verification is temporarily unavailable", {
        retryable: true,
        cause,
      });
}

function canceled(reason: unknown): DbzzError {
  return isDbzzError(reason)
    ? reason
    : new DbzzError("unavailable", "operation was canceled", { resource: "operation" });
}

function revoked(): DbzzError {
  return new DbzzError("unauthenticated", "credential revoked");
}

function expired(): DbzzError {
  return new DbzzError("unauthenticated", "credential expired");
}

function matches(principal: VerifiedPrincipal, invalidation: PrincipalInvalidation): boolean {
  return (
    principal.issuer === invalidation.issuer &&
    (invalidation.subject === undefined || principal.subject === invalidation.subject) &&
    (invalidation.tokenId === undefined || principal.tokenId === invalidation.tokenId)
  );
}

export function validateCredentialVerifierRevocation(
  verifier: CredentialVerifier | undefined,
  revocationDeadlineMs: number,
): void {
  if (
    !Number.isSafeInteger(revocationDeadlineMs) ||
    revocationDeadlineMs <= 0 ||
    revocationDeadlineMs > MAX_REVOCATION_DEADLINE_MS
  ) {
    throw new RangeError(
      `revocationDeadlineMs must be an integer from 1 through ${MAX_REVOCATION_DEADLINE_MS}`,
    );
  }
  if (verifier === undefined) return;
  const bound = verifier.revocationBound;
  if (bound?.kind === "token-expiration") return;
  if (bound?.kind !== "invalidation") {
    throw new RangeError("verifier must declare a revocationBound");
  }
  if (!Number.isFinite(bound.deadlineMs) || bound.deadlineMs <= 0) {
    throw new RangeError("verifier invalidation deadlineMs must be a positive finite number");
  }
  if (bound.deadlineMs > revocationDeadlineMs) {
    throw new RangeError("verifier invalidation deadlineMs cannot exceed revocationDeadlineMs");
  }
}

/** Owns credential validity for exactly one HTTP operation or SSE stream. */
export async function acquireAuthLease(options: AcquireAuthLeaseOptions): Promise<AuthLease> {
  const callerSignal = options.signal;
  if (options.credential.kind === "anonymous") {
    return Object.freeze({
      principal: ANONYMOUS_PRINCIPAL,
      signal: callerSignal ?? NEVER_ABORTED,
      release: () => {},
    });
  }

  const clock = options.clock ?? SYSTEM_CLOCK;
  const verifier = options.verifier;
  validateCredentialVerifierRevocation(verifier, options.revocationDeadlineMs);
  if (verifier === undefined) {
    await verifyClientCredential(options.credential, undefined, () => clock.now());
    throw new Error("unreachable credential verification result");
  }

  const controller = new AbortController();
  let principal: VerifiedPrincipal | undefined;
  let expiryTimer: { readonly handle: unknown } | undefined;
  let unsubscribe: (() => void) | undefined;
  let subscriptionSettled = false;
  let callerListening = false;
  let ended = false;
  let acquiring = true;
  let interrupt!: (error: DbzzError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });

  const release = (): void => {
    if (!ended) {
      ended = true;
      if (callerListening) {
        callerListening = false;
        try {
          callerSignal!.removeEventListener("abort", onCallerAbort);
        } catch {
          // The lease no longer owns the caller listener even if a custom signal fails cleanup.
        }
      }
      const timer = expiryTimer;
      expiryTimer = undefined;
      if (timer !== undefined) {
        try {
          clock.clearTimeout(timer.handle);
        } catch {
          // Expiry is already disarmed by lease state; clock cleanup is best effort.
        }
      }
    }
    if (subscriptionSettled && unsubscribe !== undefined) {
      const stop = unsubscribe;
      unsubscribe = undefined;
      try {
        stop();
      } catch {
        // The lease is already inactive; verifier cleanup cannot restore validity.
      }
    }
  };

  const abort = (error: DbzzError): void => {
    if (ended) return;
    controller.abort(error);
    if (acquiring) interrupt(error);
    release();
  };

  function onCallerAbort(): void {
    abort(canceled(callerSignal?.reason));
  }

  const onInvalidation = (invalidation: PrincipalInvalidation): void => {
    if (principal === undefined || matches(principal, invalidation)) abort(revoked());
  };

  const scheduleExpiry = (verified: VerifiedPrincipal): void => {
    try {
      const now = clock.now();
      if (!Number.isFinite(now)) throw new RangeError("auth lease clock must return finite milliseconds");
      const remaining = verified.expiresAt - now;
      if (remaining <= 0) {
        abort(expired());
        return;
      }
      expiryTimer = {
        handle: clock.setTimeout(() => {
          expiryTimer = undefined;
          if (!ended) scheduleExpiry(verified);
        }, Math.min(remaining, MAX_TIMER_DELAY_MS)),
      };
    } catch (error) {
      abort(verifierUnavailable(error));
    }
  };

  try {
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) throw canceled(callerSignal.reason);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      callerListening = true;
      if (callerSignal.aborted) onCallerAbort();
    }
    if (ended) throw controller.signal.reason;

    try {
      const stop = verifier.subscribeInvalidation(onInvalidation);
      if (typeof stop !== "function") throw new TypeError("verifier returned an invalid unsubscribe callback");
      unsubscribe = stop;
      subscriptionSettled = true;
    } catch (error) {
      subscriptionSettled = true;
      if (ended) throw controller.signal.reason;
      throw verifierUnavailable(error);
    }
    if (ended) {
      release();
      throw controller.signal.reason;
    }

    const verified = await Promise.race([
      verifyClientCredential(options.credential, verifier, () => clock.now()),
      interrupted,
    ]);
    acquiring = false;
    if (verified.kind === "anonymous") {
      throw verifierUnavailable(new Error("remote credential resolved to an anonymous principal"));
    }
    if (ended) throw controller.signal.reason;
    principal = verified;
    scheduleExpiry(verified);
    if (ended) throw controller.signal.reason;

    return Object.freeze({ principal: verified, signal: controller.signal, release });
  } catch (error) {
    acquiring = false;
    release();
    throw error;
  }
}
