/**
 * Runtime ownership of identity-credential authentication.
 *
 * Composes the application's credential verifier with the Engine-backed vault:
 * a vault-prefixed bearer authenticates here, everything else delegates to the
 * configured verifier. Vault credentials resolve to their own Identity and to
 * an expanded grant narrowed by every ancestor's current grant, and their
 * revocations and grant changes arrive as account invalidations on the one
 * generic auth-invalidation path — the same channel every session and lease
 * already subscribes to.
 */
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import type { Identity } from "@ackerdb/core";
import {
  unauthenticated,
  type CredentialVerifier,
  type ExternalAccount,
  type PrincipalInvalidation,
  type ScopeResolver,
  type UserPrincipal,
  type VerifiedCredential,
} from "../../auth/credentials.ts";
import {
  CREDENTIAL_ISSUER,
  hasCredentialTokenPrefix,
  parseCredentialToken,
  VAULT_CREDENTIAL_AUTHORITY,
  type ParsedCredentialToken,
} from "../../auth/credential-token.ts";
import { credentialVaultOwner } from "../../auth/credential-vault.ts";
import { expandScopeGrant } from "../../auth/scopes.ts";
import type { Engine } from "../../database/engine.ts";
import { externalAccountFairnessKey } from "../caller.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";

/** Owns one exact non-expiring credential from verification through HTTP completion. */
export interface CredentialLease {
  readonly principal: UserPrincipal;
  readonly signal: AbortSignal;
  release(): void;
}

export interface RuntimeCredentialsOptions {
  readonly engine: Engine;
  /** Lazy: the read executor is constructed after this owner. */
  readonly reads: () => RuntimeReadExecutor;
  readonly now: () => number;
  readonly assertReady: () => void;
  readonly operationSignal: (signal?: AbortSignal) => AbortSignal;
  readonly appVerifier?: CredentialVerifier;
  readonly resolveAppScopes?: ScopeResolver;
  /** Application scopes plus the framework's: what every grant expands against. */
  readonly vocabulary: readonly string[];
  /** Boundary-published account invalidations; present without an app verifier. */
  readonly subscribeInvalidation: (
    listener: (invalidation: PrincipalInvalidation) => void,
  ) => () => void;
  readonly revocationDeadlineMs: number;
}

const EMPTY_SCOPES: readonly string[] = Object.freeze([]);

export class RuntimeCredentials {
  /** The one verifier the Runtime owns: vault credentials plus the app verifier. */
  readonly verifier: CredentialVerifier;

  constructor(private readonly options: RuntimeCredentialsOptions) {
    const source = options.appVerifier;
    this.verifier = Object.freeze({
      [VAULT_CREDENTIAL_AUTHORITY]: true,
      revocationBound: source?.revocationBound ??
        Object.freeze({
          kind: "invalidation" as const,
          deadlineMs: options.revocationDeadlineMs,
        }),
      verify: (credential: string) => this.verify(credential, source),
      subscribeInvalidation: source === undefined
        ? () => () => {}
        : (listener: (invalidation: PrincipalInvalidation) => void) =>
            source.subscribeInvalidation(listener),
    });
  }

  /**
   * The generic scope resolution every transport uses: vault accounts read the
   * credential's effective grant; every other Identity asks the application
   * resolver. Both answers arrive expanded, so a principal's grant is always
   * concrete vocabulary members.
   */
  readonly resolveScopes: ScopeResolver = async (identity, account) => {
    if (account === null || account.issuer !== CREDENTIAL_ISSUER) {
      return expandScopeGrant(
        await this.resolveIdentityGrant(identity),
        this.options.vocabulary,
      );
    }
    return this.options.reads().submit(
      (connection) => this.options.engine[credentialVaultOwner].effectiveScopes(
        connection,
        identity,
        this.options.vocabulary,
        (ancestor) => this.resolveIdentityGrant(ancestor),
      ),
      {
        operation: "procedure",
        bytes: 1,
        fairnessKey: externalAccountFairnessKey(account),
        signal: this.options.operationSignal(),
      },
      false,
    );
  };

  /** Resolve a verified vault account to its Identity; fails closed when revoked. */
  async identityFor(account: ExternalAccount, signal?: AbortSignal): Promise<Identity> {
    this.options.assertReady();
    const identity = await this.options.reads().submit(
      (connection) => this.options.engine[credentialVaultOwner].identityForToken(
        connection,
        account.subject,
      ),
      {
        operation: "procedure",
        bytes: 1,
        fairnessKey: externalAccountFairnessKey(account),
        signal: this.options.operationSignal(signal),
      },
      false,
    );
    if (identity === null) throw unauthenticated();
    return identity;
  }

  /** Authenticate one parsed credential into its full first-class principal. */
  async authenticate(
    parsed: ParsedCredentialToken,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<UserPrincipal> {
    this.options.assertReady();
    const operationSignal = this.options.operationSignal(signal);
    const principal = await this.options.reads().submit(
      async (connection) => {
        const vault = this.options.engine[credentialVaultOwner];
        const credential = vault.authenticate(connection, parsed);
        const scopes = await vault.effectiveScopes(
          connection,
          credential.identity,
          this.options.vocabulary,
          (ancestor) => this.resolveIdentityGrant(ancestor),
        );
        return Object.freeze({
          kind: "user" as const,
          identity: credential.identity,
          scopes,
          issuer: CREDENTIAL_ISSUER,
          subject: credential.tokenId,
          claims: Object.freeze({}),
          expiresAt: Number.POSITIVE_INFINITY,
          tokenId: credential.tokenId,
        });
      },
      {
        operation: "procedure",
        bytes: parsed.bytes,
        fairnessKey,
        signal: operationSignal,
      },
      false,
    );
    throwIfAborted(operationSignal);
    return principal;
  }

  /** Own credential validity for exactly one stateless HTTP operation. */
  async acquireLease(
    parsed: ParsedCredentialToken,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<CredentialLease> {
    this.options.assertReady();
    const controller = new AbortController();
    const unsubscribe = this.options.subscribeInvalidation((invalidation) => {
      if (
        invalidation.issuer === CREDENTIAL_ISSUER &&
        (invalidation.subject === undefined || invalidation.subject === parsed.id) &&
        !controller.signal.aborted
      ) {
        controller.abort(new AckerDBError("unauthenticated", "credential revoked"));
      }
    });
    const leaseSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    try {
      const principal = await this.authenticate(parsed, fairnessKey, leaseSignal);
      throwIfAborted(leaseSignal);
      let active = true;
      return Object.freeze({
        principal,
        signal: leaseSignal,
        release: () => {
          if (!active) return;
          active = false;
          unsubscribe();
        },
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async resolveIdentityGrant(identity: Identity): Promise<readonly string[]> {
    const resolve = this.options.resolveAppScopes;
    if (resolve === undefined) return EMPTY_SCOPES;
    return resolve(identity, null);
  }

  private async verify(
    credential: string,
    source: CredentialVerifier | undefined,
  ): Promise<VerifiedCredential> {
    const parsed = parseCredentialToken(credential);
    if (parsed === null) {
      // The prefix claims the vault, so the vault answers — malformed included.
      // Delegating a reserved-prefix bearer would let a permissive application
      // verifier authenticate a string the vault has already refused.
      if (source === undefined || hasCredentialTokenPrefix(credential)) {
        throw unauthenticated();
      }
      return source.verify(credential);
    }
    this.options.assertReady();
    const account: ExternalAccount = { issuer: CREDENTIAL_ISSUER, subject: parsed.id };
    const authenticated = await this.options.reads().submit(
      (connection) => this.options.engine[credentialVaultOwner].authenticate(connection, parsed),
      {
        operation: "procedure",
        bytes: parsed.bytes,
        fairnessKey: externalAccountFairnessKey(account),
        signal: this.options.operationSignal(),
      },
      false,
    );
    return Object.freeze({
      kind: "user",
      issuer: CREDENTIAL_ISSUER,
      subject: authenticated.tokenId,
      claims: Object.freeze({}),
      expiresAt: Number.POSITIVE_INFINITY,
      tokenId: authenticated.tokenId,
    });
  }
}
