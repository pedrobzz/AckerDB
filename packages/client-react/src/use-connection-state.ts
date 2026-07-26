import type { AckerDBConnectionState } from "@ackerdb/client";
import { useCallback, useSyncExternalStore } from "react";
import { useProviderClient } from "./provider.tsx";

// Deterministic snapshot for server rendering and for the commit gap before the
// provider's effect constructs the client.
const DETACHED_STATE: AckerDBConnectionState = Object.freeze({ phase: "connecting" });

function getServerSnapshot(): AckerDBConnectionState {
  return DETACHED_STATE;
}

const noSubscription = (): (() => void) => () => {};

/** Exhaustive connection lifecycle for the enclosing provider's client. */
export function useConnectionState(): AckerDBConnectionState {
  const client = useProviderClient("useConnectionState");
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      client ? client.subscribeConnectionState(onStoreChange) : noSubscription(),
    [client],
  );
  const getSnapshot = useCallback(
    () => (client ? client.currentConnectionState : DETACHED_STATE),
    [client],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
