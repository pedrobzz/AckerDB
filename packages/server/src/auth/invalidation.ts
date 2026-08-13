import type {
  AuthenticatedPrincipal,
  CredentialVerifier,
  ExternalAccount,
  Principal,
  PrincipalInvalidation,
} from "./credentials.ts";
import { VAULT_CREDENTIAL_AUTHORITY } from "./credential-token.ts";

/**
 * Whether one invalidation reaches one authenticated principal — the single
 * answer every holder of a live principal asks, so a WebSocket session and an
 * HTTP lease can never disagree about who a revocation reached.
 *
 * A principal matches on its own account, and on any account its authority is
 * derived from: a credential delegated beneath an external identity carries
 * that identity's accounts, so narrowing the grant upstream terminates the
 * delegated session at once rather than at its next authentication — which,
 * for a vault principal that never expires, would be never.
 *
 * An invalidation naming an exact token is the one that does not travel down
 * the lineage. It names one credential, and a descendant is a different one.
 */
export function invalidationReaches(
  principal: AuthenticatedPrincipal,
  invalidation: PrincipalInvalidation,
): boolean {
  const reaches = (issuer: string, subject: string): boolean =>
    issuer === invalidation.issuer &&
    (invalidation.subject === undefined || subject === invalidation.subject);
  if (
    reaches(principal.issuer, principal.subject) &&
    (invalidation.tokenId === undefined || principal.tokenId === invalidation.tokenId)
  ) {
    return true;
  }
  if (invalidation.tokenId !== undefined || principal.kind !== "user") return false;
  return principal.derivedFrom?.some((account) =>
    reaches(account.issuer, account.subject)) === true;
}

const AUTH_INVALIDATION_SCOPE: unique symbol = Symbol("ackerdb.authInvalidationScope");
export const SUBSCRIBE_AUTH_INVALIDATION: unique symbol = Symbol("ackerdb.subscribeAuthInvalidation");

/** Package-owned identity for one invalidation subscriber. */
export interface AuthInvalidationScope {
  readonly [AUTH_INVALIDATION_SCOPE]: true;
}

export interface AuthInvalidationSubscription {
  /**
   * Absent only for a subscriber that reached an application verifier directly,
   * which the boundary does not own and therefore cannot name.
   */
  readonly scope?: AuthInvalidationScope;
  unsubscribe(): void;
}

export interface AuthInvalidationPublisher {
  publish(account: ExternalAccount): void;
  finish(): void;
}

type InvalidationListener = (invalidation: PrincipalInvalidation) => void;

interface ScopedCredentialVerifier extends CredentialVerifier {
  readonly [SUBSCRIBE_AUTH_INVALIDATION]: (
    listener: InvalidationListener,
  ) => AuthInvalidationSubscription;
}

/** Use the Runtime-owned scoped path when present without expanding the public verifier contract. */
export function subscribeAuthInvalidation(
  verifier: CredentialVerifier,
  listener: InvalidationListener,
): AuthInvalidationSubscription {
  const subscribe = (verifier as Partial<ScopedCredentialVerifier>)[SUBSCRIBE_AUTH_INVALIDATION];
  if (subscribe !== undefined) return subscribe(listener);
  const unsubscribe = verifier.subscribeInvalidation(listener);
  if (typeof unsubscribe !== "function") {
    throw new TypeError("verifier returned an invalid unsubscribe callback");
  }
  return Object.freeze({ unsubscribe });
}

/**
 * Composes provider revocations with Runtime-owned exact-account invalidations.
 *
 * **One registry, so every subscriber is addressable.** A subscriber that the
 * publisher cannot name is a subscriber no origin exclusion can spare, and an
 * unsparable door is exactly where a caller loses the response describing the
 * change it just made. Every subscription therefore mints a scope, whichever
 * door opened it, and `except` covers all of them.
 */
export class AuthInvalidationBoundary {
  readonly verifier: CredentialVerifier | undefined;
  private readonly listeners = new Map<AuthInvalidationScope, InvalidationListener>();
  private readonly source: CredentialVerifier | undefined;

  constructor(source: CredentialVerifier | undefined) {
    this.source = source;
    this.verifier = source === undefined
      ? undefined
      : Object.freeze({
          ...((source as { [VAULT_CREDENTIAL_AUTHORITY]?: boolean })[VAULT_CREDENTIAL_AUTHORITY] === true
            ? { [VAULT_CREDENTIAL_AUTHORITY]: true }
            : {}),
          revocationBound: source.revocationBound,
          verify: (credential: string) => source.verify(credential),
          subscribeInvalidation: (listener: InvalidationListener) =>
            this.subscribe(listener).unsubscribe,
          [SUBSCRIBE_AUTH_INVALIDATION]: (listener: InvalidationListener) =>
            this.subscribe(listener),
        } satisfies ScopedCredentialVerifier);
  }

  /** Publish now to every current subscriber except one package-owned origin. */
  publishAccount(account: ExternalAccount, except?: AuthInvalidationScope): boolean {
    const invalidation = Object.freeze({
      issuer: account.issuer,
      subject: account.subject,
    });
    let excluded = false;
    for (const [scope, listener] of [...this.listeners]) {
      if (scope === except) {
        excluded = true;
        continue;
      }
      this.deliver(listener, invalidation);
    }
    return excluded;
  }

  /**
   * Runtime-owned subscription to account invalidations, present even when no
   * application verifier is configured. It is how a credential revocation or
   * grant change reaches a live lease: the vault has no upstream provider to
   * publish through.
   *
   * It subscribes to the provider too. A delegated credential's authority is
   * bounded by an account further up its lineage, and that account is revoked
   * by the *application's* verifier — an event this boundary never publishes,
   * it only forwards. A subscriber hearing one source and not the other holds
   * a correct predicate over events it never receives, which is the same as
   * having no predicate: the in-flight holder would keep authority its parent
   * has already lost. Both doors, or neither.
   *
   * It differs from the verifier-facing door in one thing only: it exists
   * without a provider. It is otherwise the same subscription, with the same
   * scope, because the MCP endpoint reaches the runtime through here and a
   * revocation it performs itself must be excludable exactly as any other
   * caller's is.
   */
  subscribeDirect(listener: InvalidationListener): AuthInvalidationSubscription & {
    readonly scope: AuthInvalidationScope;
  } {
    return this.subscribe(listener);
  }

  /** Deliver after response handoff only if the exact originating subscription is still active. */
  publishAccountTo(account: ExternalAccount, scope: AuthInvalidationScope): boolean {
    const listener = this.listeners.get(scope);
    if (listener === undefined) return false;
    this.deliver(listener, Object.freeze({ issuer: account.issuer, subject: account.subject }));
    return true;
  }

  /**
   * Defer the originating credential's self-invalidation until response handoff.
   *
   * The exclusion names a *subscription*, and a subscription can be shared: one
   * WebSocket session subscribes once for every operation on it, and one MCP
   * POST holds one lease for its whole batch. So a concurrent operation on that
   * same connection keeps the revoked authority until this one's answer lands.
   * That is the exception's exact width, and it is deliberate. The sharer is by
   * construction the same principal — one connection, one credential — so what
   * it buys is a moment more use of an authority the caller already held and is
   * itself retiring, not a boundary anyone crosses. Narrowing it to the exact
   * operation would mean a subscription per operation on a long-lived session
   * plus a partial termination that keeps a socket open for one more frame, and
   * that is a great deal of machinery for a window bounded by one response.
   */
  publisher(
    principal: Principal,
    originScope?: AuthInvalidationScope,
  ): AuthInvalidationPublisher {
    if (originScope === undefined) {
      return Object.freeze({
        publish: (account: ExternalAccount): void => {
          this.publishAccount(account);
        },
        finish: (): void => {},
      });
    }
    const pending = new Map<string, Map<string, ExternalAccount>>();
    return Object.freeze({
      publish: (account: ExternalAccount): void => {
        const isSelf = principal.kind === "user" &&
          principal.issuer === account.issuer &&
          principal.subject === account.subject;
        if (!this.publishAccount(account, isSelf ? originScope : undefined) || !isSelf) return;
        let subjects = pending.get(account.issuer);
        if (subjects === undefined) pending.set(account.issuer, (subjects = new Map()));
        subjects.set(account.subject, account);
      },
      finish: (): void => {
        for (const subjects of pending.values()) {
          for (const account of subjects.values()) this.publishAccountTo(account, originScope);
        }
        pending.clear();
      },
    });
  }

  private subscribe(
    listener: InvalidationListener,
  ): AuthInvalidationSubscription & { readonly scope: AuthInvalidationScope } {
    const scope = Object.freeze({ [AUTH_INVALIDATION_SCOPE]: true as const });
    this.listeners.set(scope, listener);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = this.source?.subscribeInvalidation(listener);
      if (this.source !== undefined && typeof unsubscribe !== "function") {
        throw new TypeError("verifier returned an invalid unsubscribe callback");
      }
    } catch (error) {
      this.listeners.delete(scope);
      throw error;
    }
    let active = true;
    return Object.freeze({
      scope,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(scope);
        unsubscribe?.();
      },
    });
  }

  private deliver(listener: InvalidationListener, invalidation: PrincipalInvalidation): void {
    try {
      listener(invalidation);
    } catch {
      // One consumer cannot prevent fail-closed delivery to the others.
    }
  }
}
