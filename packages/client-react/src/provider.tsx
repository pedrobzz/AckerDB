import { AckerDBClient, type AckerDBClientOptions } from "@ackerdb/client";
import type { Credential } from "@ackerdb/core";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/** Immutable configuration for one provider-owned client lifetime. */
export type AckerDBProviderConfig = AckerDBClientOptions;

export interface AckerDBProviderProps {
  readonly config: AckerDBProviderConfig;
  readonly children?: ReactNode;
}

interface AckerDBContextValue {
  readonly client: AckerDBClient | null;
  /** The rendering configuration's credential kind, known before the client exists. */
  readonly credential: Credential["kind"];
}

const AckerDBContext = createContext<AckerDBContextValue | null>(null);

// Value identity for the immutable configuration surface: equal values continue
// the current lifetime, different values close the old client and start a new
// one. Injected capabilities (clock, random, createWebSocket, fetch, lifecycle)
// are captured when a lifetime starts and do not participate in identity.
function lifetimeKey(config: AckerDBProviderConfig): string {
  const limits = config.limits;
  const reconnect = config.reconnect;
  return JSON.stringify([
    config.url,
    config.credential.kind,
    config.credential.kind === "bearer" ? config.credential.token : "",
    config.clientSessionId ?? null,
    limits
      ? [
          limits.maxPendingItems,
          limits.maxPendingBytes,
          limits.maxQueryAgeMs,
          limits.maxMutationAgeMs,
          limits.maxFrameBytes,
          limits.maxSseBufferBytes,
          limits.maxSseAckAgeMs,
        ]
      : null,
    reconnect
      ? [
          reconnect.baseDelayMs,
          reconnect.maxDelayMs,
          reconnect.stableOpenMs,
          reconnect.disconnectedGraceMs,
          reconnect.iceRestartTimeoutMs,
          reconnect.realtimeSetupTimeoutMs,
        ]
      : null,
  ]);
}

/**
 * Constructs, owns, and closes exactly one AckerDBClient per immutable
 * configuration lifetime. The client is created in a commit-phase effect, so
 * server rendering never constructs it or touches runtime globals.
 */
interface AckerDBLifetime {
  readonly key: string;
  readonly client: AckerDBClient;
}

export function AckerDBProvider({ config, children }: AckerDBProviderProps): ReactElement {
  const key = lifetimeKey(config);
  const [lifetime, setLifetime] = useState<AckerDBLifetime | null>(null);

  useEffect(() => {
    const instance = new AckerDBClient(config);
    instance.connect();
    setLifetime({ key, client: instance });
    return () => {
      setLifetime((current) => (current !== null && current.client === instance ? null : current));
      instance.close();
    };
    // The key covers every configured value; capability functions are captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The stored client is exposed only while its key matches the rendering
  // configuration, so no committed render can pair a new configuration with
  // the previous lifetime's state.
  const client = lifetime !== null && lifetime.key === key ? lifetime.client : null;
  const credential = config.credential.kind;
  const value = useMemo<AckerDBContextValue>(() => ({ client, credential }), [client, credential]);
  return <AckerDBContext.Provider value={value}>{children}</AckerDBContext.Provider>;
}

/** Module-internal: the context (and any client access) is never exported publicly. */
export function useProviderClient(hook: string): AckerDBClient | null {
  const value = useContext(AckerDBContext);
  if (value === null) throw new Error(`${hook} requires a <AckerDBProvider> ancestor`);
  return value.client;
}

/** Module-internal: the configured credential kind for deterministic pre-client snapshots. */
export function useProviderCredentialKind(hook: string): Credential["kind"] {
  const value = useContext(AckerDBContext);
  if (value === null) throw new Error(`${hook} requires a <AckerDBProvider> ancestor`);
  return value.credential;
}
