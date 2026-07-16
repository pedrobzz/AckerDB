import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const SESSION_KEY = "dbzz.savoria.guest-session";

export interface GuestSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly name: string;
  readonly email: string;
}

interface SessionContextValue {
  readonly restored: boolean;
  readonly restoreError: Error | null;
  readonly session: GuestSession | null;
  readonly retryRestore: () => void;
  readonly establish: (session: GuestSession) => Promise<void>;
  readonly clear: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function parseSession(value: string | null): GuestSession | null {
  if (value === null) return null;
  try {
    const candidate = JSON.parse(value) as Partial<GuestSession>;
    if (
      typeof candidate.token !== "string" ||
      typeof candidate.expiresAt !== "number" ||
      typeof candidate.name !== "string" ||
      typeof candidate.email !== "string" ||
      candidate.expiresAt <= Date.now()
    ) {
      return null;
    }
    return candidate as GuestSession;
  } catch {
    return null;
  }
}

export function SessionProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [restored, setRestored] = useState(false);
  const [restoreError, setRestoreError] = useState<Error | null>(null);
  const [session, setSession] = useState<GuestSession | null>(null);

  const restore = useCallback(() => {
    let active = true;
    setRestored(false);
    setRestoreError(null);
    void SecureStore.getItemAsync(SESSION_KEY)
      .then(async (stored) => {
        const next = parseSession(stored);
        if (stored !== null && next === null)
          await SecureStore.deleteItemAsync(SESSION_KEY);
        if (active) setSession(next);
      })
      .catch((error: unknown) => {
        if (active) {
          setRestoreError(
            error instanceof Error
              ? error
              : new Error("Secure login storage is unavailable"),
          );
        }
      })
      .finally(() => {
        if (active) setRestored(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => restore(), [restore]);

  const establish = useCallback(async (next: GuestSession) => {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
    setSession(next);
  }, []);

  const clear = useCallback(async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({
      restored,
      restoreError,
      session,
      retryRestore: restore,
      establish,
      clear,
    }),
    [restored, restoreError, session, restore, establish, clear],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession requires SessionProvider");
  return value;
}
