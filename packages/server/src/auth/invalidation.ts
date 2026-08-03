import type {
  CredentialVerifier,
  ExternalAccount,
  Principal,
  PrincipalInvalidation,
} from "./credentials.ts";

const AUTH_INVALIDATION_SCOPE: unique symbol = Symbol("ackerdb.authInvalidationScope");
export const SUBSCRIBE_AUTH_INVALIDATION: unique symbol = Symbol("ackerdb.subscribeAuthInvalidation");

/** Package-owned identity for one invalidation subscriber. */
export interface AuthInvalidationScope {
  readonly [AUTH_INVALIDATION_SCOPE]: true;
}

export interface AuthInvalidationSubscription {
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

/** Composes provider revocations with Runtime-owned exact-account invalidations. */
export class AuthInvalidationBoundary {
  readonly verifier: CredentialVerifier | undefined;
  private readonly listeners = new Map<AuthInvalidationScope, InvalidationListener>();

  constructor(source: CredentialVerifier | undefined) {
    this.verifier = source === undefined
      ? undefined
      : Object.freeze({
          revocationBound: source.revocationBound,
          verify: (credential: string) => source.verify(credential),
          subscribeInvalidation: (listener: InvalidationListener) =>
            this.subscribe(source, listener).unsubscribe,
          [SUBSCRIBE_AUTH_INVALIDATION]: (listener: InvalidationListener) =>
            this.subscribe(source, listener),
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

  /** Deliver after response handoff only if the exact originating subscription is still active. */
  publishAccountTo(account: ExternalAccount, scope: AuthInvalidationScope): boolean {
    const listener = this.listeners.get(scope);
    if (listener === undefined) return false;
    this.deliver(listener, Object.freeze({ issuer: account.issuer, subject: account.subject }));
    return true;
  }

  /** Defer the originating credential's self-invalidation until response handoff. */
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
    source: CredentialVerifier,
    listener: InvalidationListener,
  ): AuthInvalidationSubscription & { readonly scope: AuthInvalidationScope } {
    const scope = Object.freeze({ [AUTH_INVALIDATION_SCOPE]: true as const });
    this.listeners.set(scope, listener);
    let unsubscribe: () => void;
    try {
      unsubscribe = source.subscribeInvalidation(listener);
      if (typeof unsubscribe !== "function") {
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
        unsubscribe();
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
