import {
  AckerDBClientError,
  type AckerDBAuthentication,
  type AckerDBAuthenticationState,
} from "@ackerdb/client";
import type { Credential } from "@ackerdb/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useProviderClient, useProviderCredentialKind } from "./provider.tsx";

/**
 * The complete React authentication surface: observable state plus the two
 * protocol-supported operations. `refresh` presents a new credential through
 * the base client's `refreshCredential`; on a credential-source provider it
 * takes no argument and re-invokes the source immediately — the "sign-in just
 * happened" path. `signOut` resolves only when the server actually confirmed
 * the anonymous principal: on a fixed-credential provider it presents the
 * anonymous credential (the protocol's sign-out), and on a credential-source
 * provider it re-invokes the source and rejects with `conflict` when the
 * source still produces a signed-in credential — sign out of the identity
 * SDK first; the source owns what "signed out" produces, and this operation
 * never claims a sign-out it cannot perform. Both resolve with the
 * server-confirmed authentication and reject with the exact
 * `AckerDBClientError`.
 */
export interface UseAuthenticationResult {
  readonly state: AckerDBAuthenticationState;
  readonly refresh: (credential?: Credential) => Promise<AckerDBAuthentication>;
  readonly signOut: () => Promise<AckerDBAuthentication>;
}

// Deterministic snapshots for server rendering and for the commit gap before
// the provider's effect constructs the client: the configured credential is
// about to be presented, which is exactly what "authenticating" means.
const DETACHED_STATES: Readonly<
  Record<Credential["kind"] | "source", AckerDBAuthenticationState>
> = Object.freeze({
  anonymous: Object.freeze({ phase: "authenticating" as const, credential: "anonymous" as const }),
  bearer: Object.freeze({ phase: "authenticating" as const, credential: "bearer" as const }),
  source: Object.freeze({ phase: "authenticating" as const, credential: "source" as const }),
});

const ANONYMOUS_CREDENTIAL: Credential = Object.freeze({ kind: "anonymous" });

const noSubscription = (): (() => void) => () => {};

// Rejection for an operation that races the provider's commit-phase client
// construction (or runs during server rendering): no client exists, so no
// credential was presented and nothing reached the network.
function detachedOperation(): Promise<never> {
  return Promise.reject(
    new AckerDBClientError({
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
    (credential?: Credential): Promise<AckerDBAuthentication> => {
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
  const signOut = useCallback((): Promise<AckerDBAuthentication> => {
    if (credentialKind !== "source") return refresh(ANONYMOUS_CREDENTIAL);
    return refresh().then((authentication) => {
      if (authentication.principal === "anonymous") return authentication;
      // Honest by construction: this operation never resolves "signed out"
      // while the server still confirms a signed-in principal.
      throw new AckerDBClientError({
        code: "conflict",
        message:
          "the credential source still produces a signed-in credential; sign out of the identity provider first",
        retryable: false,
        resource: "connection",
      });
    });
  }, [credentialKind, refresh]);

  return useMemo(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
}
