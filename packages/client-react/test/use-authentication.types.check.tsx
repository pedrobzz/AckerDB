// Compile-time contract for useAuthentication. This file is typechecked (see
// the package tsconfig) and never executed.
import {
  useAuthentication,
  type Credential,
  type AckerDBAuthentication,
  type AckerDBAuthenticationState,
  type Identity,
  type UseAuthenticationResult,
} from "@ackerdb/client-react";
import type { ReactNode } from "react";

function assertNever(value: never): never {
  throw new Error(String(value));
}

// --- state exhaustiveness -----------------------------------------------------

function describeAuthentication(state: AckerDBAuthenticationState): string {
  switch (state.phase) {
    case "authenticating":
      return state.credential;
    case "unauthenticated":
      return `anonymous@${state.authentication.authEpoch}`;
    case "authenticated":
      return `${state.authentication.principal}@${state.authentication.authEpoch}`;
    case "refresh-required":
      return state.error.code;
    case "failed":
      return state.error.message;
    case "closed":
      return "closed";
    default:
      return assertNever(state);
  }
}

function missesBlockedPhases(state: AckerDBAuthenticationState): string {
  switch (state.phase) {
    case "authenticating":
    case "unauthenticated":
    case "authenticated":
    case "closed":
      return state.phase;
    default:
      // @ts-expect-error refresh-required and failed make this non-exhaustive
      return assertNever(state);
  }
}

function describeConfirmed(authentication: AckerDBAuthentication): string {
  switch (authentication.principal) {
    case "anonymous":
      // @ts-expect-error anonymous state cannot carry a user Identity
      void authentication.identity;
      // @ts-expect-error anonymous state has no credential provenance
      void authentication.provenance;
      return "anonymous";
    case "user": {
      const identity: Identity = authentication.identity;
      const issuer: string = authentication.provenance.issuer;
      const subject: string = authentication.provenance.subject;
      // @ts-expect-error accepted client state never exposes bearer credentials
      void authentication.token;
      // @ts-expect-error selected provider claims stay server-side
      void authentication.claims;
      // @ts-expect-error token identifiers stay server-side
      void authentication.tokenId;
      return `${identity}:${issuer}:${subject}`;
    }
    case "workload":
      // @ts-expect-error workload principals structurally have no user Identity
      void authentication.identity;
      return `${authentication.provenance.issuer}:${authentication.provenance.subject}`;
    default:
      return assertNever(authentication);
  }
}

// @ts-expect-error system principals are local-only and cannot enter client state
const systemAuthentication: AckerDBAuthentication = { authEpoch: 0, principal: "system" };
void systemAuthentication;

// --- per-phase payloads -------------------------------------------------------

declare const authenticating: Extract<AckerDBAuthenticationState, { phase: "authenticating" }>;
authenticating.credential satisfies "anonymous" | "bearer" | "source";
// @ts-expect-error only failure phases carry an error
authenticating.error;
// @ts-expect-error only confirmed phases carry an authentication
authenticating.authentication;

declare const authenticated: Extract<AckerDBAuthenticationState, { phase: "authenticated" }>;
authenticated.authentication.authEpoch satisfies number;
authenticated.authentication.principal satisfies "user" | "workload";
// @ts-expect-error an authenticated phase can never carry the anonymous descriptor
authenticated.authentication satisfies Extract<AckerDBAuthentication, { principal: "anonymous" }>;
// @ts-expect-error a confirmed principal carries no error
authenticated.error;

declare const unauthenticated: Extract<AckerDBAuthenticationState, { phase: "unauthenticated" }>;
unauthenticated.authentication.principal satisfies "anonymous";
// @ts-expect-error an anonymous phase never exposes user Identity
void unauthenticated.authentication.identity;
// @ts-expect-error an anonymous phase never exposes credential provenance
void unauthenticated.authentication.provenance;

declare const blocked: Extract<AckerDBAuthenticationState, { phase: "refresh-required" }>;
blocked.error.code satisfies string;
blocked.error.retryable satisfies boolean;
// @ts-expect-error a blocked client has no confirmed authentication
blocked.authentication;

// --- operations ---------------------------------------------------------------

function Operations(): ReactNode {
  const { state, refresh, signOut } = useAuthentication();
  const result: UseAuthenticationResult = useAuthentication();
  const observed: AckerDBAuthenticationState = state;

  const bearer: Promise<AckerDBAuthentication> = refresh({ kind: "bearer", token: "token-a" });
  const anonymous: Promise<AckerDBAuthentication> = refresh({ kind: "anonymous" });
  const signedOut: Promise<AckerDBAuthentication> = signOut();

  // The credential-source form: refresh() re-invokes the provider's source.
  const viaSource: Promise<AckerDBAuthentication> = refresh();
  void viaSource;
  // @ts-expect-error bearer credentials carry a token
  refresh({ kind: "bearer" });
  // @ts-expect-error only the two protocol credential kinds exist
  refresh({ kind: "cookie" });
  // @ts-expect-error sign-out takes no credential; use refresh to switch identities
  signOut({ kind: "anonymous" });

  const credential: Credential = { kind: "anonymous" };
  void [observed, result, bearer, anonymous, signedOut, credential];
  return null;
}

export { Operations, describeAuthentication, describeConfirmed, missesBlockedPhases };
