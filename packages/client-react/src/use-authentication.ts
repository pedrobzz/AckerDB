import {
  DbzzClientError,
  type DbzzAuthentication,
  type DbzzAuthenticationState,
} from "@dbzz/client";
import type { Credential } from "@dbzz/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useProviderClient, useProviderCredentialKind } from "./provider.tsx";

/**
 * The complete React authentication surface: observable state plus the two
 * protocol-supported operations. `refresh` presents a new credential through
 * the base client's `refreshCredential`; `signOut` presents the anonymous
 * credential, which the dbzz server classifies as a sign-out — it retires the
 * current auth epoch and transitions the session to the anonymous principal.
 * Both resolve with the server-confirmed authentication and reject with the
 * exact `DbzzClientError`.
 */
export interface UseAuthenticationResult {
  readonly state: DbzzAuthenticationState;
  readonly refresh: (credential: Credential) => Promise<DbzzAuthentication>;
  readonly signOut: () => Promise<DbzzAuthentication>;
}

// Deterministic snapshots for server rendering and for the commit gap before
// the provider's effect constructs the client: the configured credential is
// about to be presented, which is exactly what "authenticating" means.
const DETACHED_STATES: Readonly<Record<Credential["kind"], DbzzAuthenticationState>> =
  Object.freeze({
    anonymous: Object.freeze({ phase: "authenticating" as const, credential: "anonymous" as const }),
    bearer: Object.freeze({ phase: "authenticating" as const, credential: "bearer" as const }),
  });

const ANONYMOUS_CREDENTIAL: Credential = Object.freeze({ kind: "anonymous" });

const noSubscription = (): (() => void) => () => {};

// Rejection for an operation that races the provider's commit-phase client
// construction (or runs during server rendering): no client exists, so no
// credential was presented and nothing reached the network.
function detachedOperation(): Promise<never> {
  return Promise.reject(
    new DbzzClientError({
      code: "unavailable",
      message: "the provider has not constructed its client yet",
      retryable: false,
      resource: "connection",
    }),
  );
}

/**
 * Observable authentication state and typed refresh/sign-out operations for
 * the enclosing provider's client. State transitions are the base client's
 * own and stay coherent with `useConnectionState` — both snapshots are
 * published from the same client transition. Operation identities are stable
 * for a provider lifetime; the hook never initiates authentication itself, so
 * Strict Mode remounts and rerenders cannot duplicate refresh attempts.
 */
export function useAuthentication(): UseAuthenticationResult {
  const client = useProviderClient("useAuthentication");
  const credentialKind = useProviderCredentialKind("useAuthentication");
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      client ? client.subscribeAuthenticationState(onStoreChange) : noSubscription(),
    [client],
  );
  const getSnapshot = useCallback(
    () => (client ? client.currentAuthenticationState : DETACHED_STATES[credentialKind]),
    [client, credentialKind],
  );
  const getServerSnapshot = useCallback(
    () => DETACHED_STATES[credentialKind],
    [credentialKind],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const refresh = useCallback(
    (credential: Credential): Promise<DbzzAuthentication> => {
      if (client === null) return detachedOperation();
      // A closed or permanently failed client rejects synchronously with the
      // exact error; a React operation surfaces it as the rejection instead.
      try {
        return client.refreshCredential(credential);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    [client],
  );
  const signOut = useCallback(() => refresh(ANONYMOUS_CREDENTIAL), [refresh]);

  return useMemo(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
}
