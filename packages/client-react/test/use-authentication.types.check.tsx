// Compile-time contract for useAuthentication. This file is typechecked (see
// the package tsconfig) and never executed.
import {
  useAuthentication,
  type Credential,
  type DbzzAuthentication,
  type DbzzAuthenticationState,
  type UseAuthenticationResult,
} from "@dbzz/client-react";
import type { ReactNode } from "react";

function assertNever(value: never): never {
  throw new Error(String(value));
}

// --- state exhaustiveness -----------------------------------------------------

function describeAuthentication(state: DbzzAuthenticationState): string {
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

function missesBlockedPhases(state: DbzzAuthenticationState): string {
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

// --- per-phase payloads -------------------------------------------------------

declare const authenticating: Extract<DbzzAuthenticationState, { phase: "authenticating" }>;
authenticating.credential satisfies "anonymous" | "bearer";
// @ts-expect-error only failure phases carry an error
authenticating.error;
// @ts-expect-error only confirmed phases carry an authentication
authenticating.authentication;

declare const authenticated: Extract<DbzzAuthenticationState, { phase: "authenticated" }>;
authenticated.authentication.authEpoch satisfies number;
authenticated.authentication.principal satisfies string;
// @ts-expect-error a confirmed principal carries no error
authenticated.error;

declare const blocked: Extract<DbzzAuthenticationState, { phase: "refresh-required" }>;
blocked.error.code satisfies string;
blocked.error.retryable satisfies boolean;
// @ts-expect-error a blocked client has no confirmed authentication
blocked.authentication;

// --- operations ---------------------------------------------------------------

function Operations(): ReactNode {
  const { state, refresh, signOut } = useAuthentication();
  const result: UseAuthenticationResult = useAuthentication();
  const observed: DbzzAuthenticationState = state;

  const bearer: Promise<DbzzAuthentication> = refresh({ kind: "bearer", token: "token-a" });
  const anonymous: Promise<DbzzAuthentication> = refresh({ kind: "anonymous" });
  const signedOut: Promise<DbzzAuthentication> = signOut();

  // @ts-expect-error refresh requires a credential
  refresh();
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

export { Operations, describeAuthentication, missesBlockedPhases };
