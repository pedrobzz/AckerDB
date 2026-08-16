import type { Credential } from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  credentialExpired,
  credentialRevoked,
  authenticationUnavailable,
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
import { cancellation, throwIfAborted, type AckerDBError } from "../shared/errors.ts";
import { MAX_TIMER_DELAY_MS } from "../shared/numbers.ts";
import { SYSTEM_CLOCK, type Clock } from "../shared/clock.ts";
import { finiteMillis } from "../shared/clock.ts";

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
  readonly clock?: Clock;
}

export const MAX_REVOCATION_DEADLINE_MS = 5_000;
const NEVER_ABORTED = new AbortController().signal;

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
  const { promise: interrupted, reject: interrupt } = Promise.withResolvers<never>();

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
    abort(cancellation(callerSignal?.reason));
  }

  const onInvalidation = (invalidation: PrincipalInvalidation): void => {
    if (principal === undefined || invalidationReaches(principal, invalidation)) abort(credentialRevoked());
  };

  const scheduleExpiry = (verified: AuthenticatedPrincipal): void => {
    // AckerDB credentials never expire; invalidation revokes them instead.
    if (!Number.isFinite(verified.expiresAt)) return;
    try {
      const remaining = verified.expiresAt - finiteMillis(clock.now(), "auth lease clock");
      if (remaining <= 0) {
        abort(credentialExpired());
        return;
      }
      expiryTimer = {
        handle: clock.setTimeout(() => {
          expiryTimer = undefined;
          if (!ended) scheduleExpiry(verified);
        }, Math.min(remaining, MAX_TIMER_DELAY_MS)),
      };
    } catch (error) {
      abort(authenticationUnavailable(error));
    }
  };

  try {
    if (callerSignal !== undefined) {
      throwIfAborted(callerSignal);
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
      throw authenticationUnavailable(error);
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
      throw authenticationUnavailable(new Error("remote credential resolved to an anonymous principal"));
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
