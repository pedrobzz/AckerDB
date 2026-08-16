import type { Credential } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  verifyClientCredential,
  type AuthenticatedPrincipal,
  type ClientPrincipal,
  type CredentialVerifier,
  type IdentityResolver,
  type PrincipalInvalidation,
  type ScopeResolver,
} from "./credentials.ts";
import {
  invalidationReaches,
  subscribeAuthInvalidation,
  type AuthInvalidationScope,
} from "./invalidation.ts";
import { AckerDBError, isAckerDBError } from "../shared/errors.ts";

export interface AuthLeaseClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuthLease {
  readonly principal: ClientPrincipal;
  readonly signal: AbortSignal;
  /** Package-owned origin used to defer only this one-shot lease's local invalidation. */
  readonly invalidationScope?: AuthInvalidationScope;
  release(): void;
}

export interface AcquireAuthLeaseOptions {
  readonly credential: Credential;
  readonly verifier?: CredentialVerifier;
  readonly resolveIdentity: IdentityResolver;
  readonly resolveScopes?: ScopeResolver;
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

function verifierUnavailable(cause: unknown): AckerDBError {
  return isAckerDBError(cause)
    ? cause
    : new AckerDBError("auth_unavailable", "credential verification is temporarily unavailable", {
        retryable: true,
        cause,
      });
}

function canceled(reason: unknown): AckerDBError {
  return isAckerDBError(reason)
    ? reason
    : new AckerDBError("unavailable", "operation was canceled", { resource: "operation" });
}

function revoked(): AckerDBError {
  return new AckerDBError("unauthenticated", "credential revoked");
}

function expired(): AckerDBError {
  return new AckerDBError("unauthenticated", "credential expired");
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

/** Validate an untrusted application verifier before any Runtime owns it. */
export function assertCredentialVerifier(
  value: unknown,
  revocationDeadlineMs: number,
  label = "credential verifier",
): asserts value is CredentialVerifier {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be a CredentialVerifier object`);
  }
  const verifier = value as Partial<CredentialVerifier>;
  if (typeof verifier.verify !== "function") {
    throw new TypeError(`${label} must implement verify(credential)`);
  }
  if (typeof verifier.subscribeInvalidation !== "function") {
    throw new TypeError(`${label} must implement subscribeInvalidation(listener)`);
  }
  if (typeof verifier.revocationBound !== "object" || verifier.revocationBound === null) {
    throw new TypeError(`${label} must declare revocationBound`);
  }
  validateCredentialVerifierRevocation(verifier as CredentialVerifier, revocationDeadlineMs);
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
    await verifyClientCredential(
      options.credential,
      undefined,
      options.resolveIdentity,
      () => clock.now(),
      options.resolveScopes,
    );
    throw new Error("unreachable credential verification result");
  }

  const controller = new AbortController();
  let principal: AuthenticatedPrincipal | undefined;
  let invalidationScope: AuthInvalidationScope | undefined;
  let expiryTimer: { readonly handle: unknown } | undefined;
  let unsubscribe: (() => void) | undefined;
  let subscriptionSettled = false;
  let callerListening = false;
  let ended = false;
  let acquiring = true;
  let interrupt!: (error: AckerDBError) => void;
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

  const abort = (error: AckerDBError): void => {
    if (ended) return;
    controller.abort(error);
    if (acquiring) interrupt(error);
    release();
  };

  function onCallerAbort(): void {
    abort(canceled(callerSignal?.reason));
  }

  const onInvalidation = (invalidation: PrincipalInvalidation): void => {
    if (principal === undefined || invalidationReaches(principal, invalidation)) abort(revoked());
  };

  const scheduleExpiry = (verified: AuthenticatedPrincipal): void => {
    // AckerDB credentials never expire; invalidation revokes them instead.
    if (!Number.isFinite(verified.expiresAt)) return;
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
      const subscription = subscribeAuthInvalidation(verifier, onInvalidation);
      unsubscribe = subscription.unsubscribe;
      invalidationScope = subscription.scope;
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
      verifyClientCredential(
        options.credential,
        verifier,
        (account) => options.resolveIdentity(account, controller.signal),
        () => clock.now(),
        options.resolveScopes,
      ),
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

    return Object.freeze({
      principal: verified,
      signal: controller.signal,
      ...(invalidationScope === undefined ? {} : { invalidationScope }),
      release,
    });
  } catch (error) {
    acquiring = false;
    release();
    throw error;
  }
}
