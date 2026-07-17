import {
  DbzzProvider,
  skip,
  useAuthentication,
  useEvent,
  useMutation,
  useQuery,
  type DbzzLiveEvent,
} from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import type { Identity, OrderEvent } from "@demo/dbzz-codegen/types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { ErrorState, LoadingState } from "../components/states";
import { CartProvider } from "./cart";
import { SessionProvider, useSession } from "./session";
import { ToastProvider, useToast } from "./toast";

const DBZZ_URL = process.env.EXPO_PUBLIC_DBZZ_URL ?? "http://127.0.0.1:3212";

export function AppProvider({ children }: { readonly children: ReactNode }) {
  return (
    <SessionProvider>
      <SessionScope>{children}</SessionScope>
    </SessionProvider>
  );
}

function SessionScope({ children }: { readonly children: ReactNode }) {
  const { session } = useSession();
  const scope = session === null ? "anonymous" : "authenticated";
  return (
    <ToastProvider key={scope}>
      <CartProvider>
        <DbzzSession>{children}</DbzzSession>
      </CartProvider>
    </ToastProvider>
  );
}

function DbzzSession({ children }: { readonly children: ReactNode }) {
  const { restored, restoreError, retryRestore, session } = useSession();
  const config = useMemo(
    () => ({
      url: DBZZ_URL,
      credential:
        session === null
          ? ({ kind: "anonymous" } as const)
          : ({ kind: "bearer", token: session.token } as const),
    }),
    [session],
  );

  if (!restored) return <LoadingState label="Restoring your Savoria visit…" />;
  if (restoreError !== null) {
    return (
      <ErrorState
        message={restoreError.message}
        actionLabel="Retry secure storage"
        onAction={retryRestore}
      />
    );
  }
  return (
    <DbzzProvider config={config}>
      <AuthenticatedBootstrap>{children}</AuthenticatedBootstrap>
    </DbzzProvider>
  );
}

function AuthenticatedBootstrap({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { session, clear } = useSession();
  const authentication = useAuthentication();
  const profile = useQuery(api.users.current, session === null ? skip : {});
  const ensureCurrent = useMutation(api.users.ensureCurrent);
  const attempted = useRef(false);
  const [ensureError, setEnsureError] = useState<Error | null>(null);
  const [clearError, setClearError] = useState<Error | null>(null);

  const clearSession = useCallback(async () => {
    setClearError(null);
    try {
      await clear();
    } catch (error) {
      setClearError(
        error instanceof Error
          ? error
          : new Error("Could not clear the saved login"),
      );
    }
  }, [clear]);

  const ensure = useCallback(async () => {
    attempted.current = true;
    setEnsureError(null);
    try {
      await ensureCurrent({});
    } catch (error) {
      setEnsureError(
        error instanceof Error
          ? error
          : new Error("Could not create your guest profile"),
      );
    }
  }, [ensureCurrent]);

  useEffect(() => {
    if (authentication.state.phase === "refresh-required") {
      void clearSession();
    }
  }, [authentication.state.phase, clearSession]);

  useEffect(() => {
    if (
      session !== null &&
      authentication.state.phase === "authenticated" &&
      profile.status === "success" &&
      profile.data === null &&
      !attempted.current
    ) {
      void ensure();
    }
  }, [session, authentication.state.phase, profile, ensure]);

  if (session === null) return children;
  if (clearError !== null) {
    return (
      <ErrorState
        message={clearError.message}
        actionLabel="Try logout again"
        onAction={() => void clearSession()}
      />
    );
  }
  if (ensureError !== null) {
    return (
      <ErrorState
        message={ensureError.message}
        actionLabel="Retry profile setup"
        onAction={() => void ensure()}
      />
    );
  }
  if (authentication.state.phase === "failed") {
    return (
      <ErrorState
        message={authentication.state.error.message}
        actionLabel="Clear login"
        onAction={() => void clearSession()}
      />
    );
  }
  if (
    authentication.state.phase !== "authenticated" ||
    profile.status === "pending" ||
    (profile.status === "success" && profile.data === null)
  ) {
    return <LoadingState label="Opening your live table…" />;
  }
  if (profile.status === "error") {
    return (
      <ErrorState
        message={profile.error.message}
        actionLabel="Log in again"
        onAction={() => void clearSession()}
      />
    );
  }
  if (profile.status !== "success") return <LoadingState />;

  const auth = authentication.state.authentication;
  return (
    <View style={{ flex: 1 }}>
      {auth.principal === "user" ? (
        <OrderEventBridge identity={auth.identity} />
      ) : null}
      {children}
    </View>
  );
}

function OrderEventBridge({ identity }: { readonly identity: Identity }) {
  const toast = useToast();
  useEvent(
    api.events.orderEvents,
    { identity },
    (event: DbzzLiveEvent<OrderEvent>) => {
      if (event.kind === "row") toast.show(event.row.message);
      if (event.kind === "gap")
        toast.show(
          "An order update was missed. The live order below is current.",
        );
    },
    (error) => toast.show(`Live order updates paused: ${error.message}`),
  );
  return null;
}
