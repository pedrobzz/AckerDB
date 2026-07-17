import {
  DbzzProvider,
  useAuthentication,
  useConnectionState,
  useEvent,
  useMutation,
} from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { AlertTriangle, ChefHat, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ToastProvider, useToast } from "../components/toast.tsx";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#102A24" },
      { title: "Savoria Restaurant OS" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <DbzzProvider
        config={{
          url: import.meta.env.VITE_DBZZ_URL ?? "http://127.0.0.1:3212",
          credential: {
            kind: "bearer",
            token:
              import.meta.env.VITE_DBZZ_STAFF_TOKEN ?? "savoria-demo-staff",
          },
        }}
      >
        <ToastProvider>
          <AdminBootstrap />
        </ToastProvider>
      </DbzzProvider>
    </RootDocument>
  );
}

function AdminBootstrap() {
  const authentication = useAuthentication();
  const connection = useConnectionState();
  const initialize = useMutation(api.setup.initialize);
  const [setup, setSetup] = useState<"idle" | "pending" | "ready" | "error">(
    "idle",
  );
  const [setupError, setSetupError] = useState<string | null>(null);
  const setupStarted = useRef(false);
  const setupGeneration = useRef(0);

  useEffect(() => {
    if (
      authentication.state.phase !== "authenticated" ||
      connection.phase !== "ready"
    ) {
      setupStarted.current = false;
      setupGeneration.current += 1;
      setSetup("idle");
      return;
    }

    if (setupStarted.current) return;

    setupStarted.current = true;
    const generation = ++setupGeneration.current;
    setSetup("pending");
    setSetupError(null);
    void initialize({}).then(
      () => {
        if (setupGeneration.current === generation) setSetup("ready");
      },
      (error: unknown) => {
        if (setupGeneration.current !== generation) return;
        setSetupError(
          error instanceof Error ? error.message : "Restaurant setup failed",
        );
        setSetup("error");
      },
    );
  }, [authentication.state.phase, connection.phase]);

  if (
    authentication.state.phase === "refresh-required" ||
    authentication.state.phase === "failed" ||
    authentication.state.phase === "unauthenticated" ||
    setup === "error"
  ) {
    const authError =
      authentication.state.phase === "refresh-required" ||
      authentication.state.phase === "failed"
        ? authentication.state.error.message
        : null;
    return (
      <FullPageState
        icon={<AlertTriangle aria-hidden="true" />}
        title="Staff access unavailable"
        detail={
          setupError ??
          authError ??
          "This credential is not authorized for the restaurant admin."
        }
        tone="danger"
      />
    );
  }

  if (authentication.state.phase === "closed") {
    return (
      <FullPageState
        icon={<AlertTriangle aria-hidden="true" />}
        title="Connection closed"
        detail="Reload the admin panel to reconnect."
        tone="danger"
      />
    );
  }

  if (
    authentication.state.phase === "authenticating" ||
    setup === "idle" ||
    setup === "pending"
  ) {
    return (
      <FullPageState
        icon={<LoaderCircle className="spin" aria-hidden="true" />}
        title="Opening Savoria"
        detail="Connecting the floor, kitchen, and live order service…"
      />
    );
  }

  return (
    <>
      <StaffReminderEvents />
      <Outlet />
    </>
  );
}

function StaffReminderEvents() {
  const toast = useToast();
  useEvent(
    api.events.staffEvents,
    {},
    (event) => {
      if (event.kind === "row") {
        toast.warning(
          event.row.message,
          `Table ${event.row.tableNumber} · Kitchen reminder`,
        );
      } else if (event.kind === "gap") {
        toast.info(
          "Some transient reminders were missed. The live kitchen queue is authoritative.",
        );
      }
    },
    (error) => toast.error(error.message, "Reminder stream unavailable"),
  );
  return null;
}

function FullPageState({
  icon,
  title,
  detail,
  tone = "default",
}: Readonly<{
  icon: ReactNode;
  title: string;
  detail: string;
  tone?: "default" | "danger";
}>) {
  return (
    <main className="full-page-state">
      <section className={`state-card state-card--${tone}`} aria-live="polite">
        <div className="state-card__brand" aria-hidden="true">
          <ChefHat />
        </div>
        <div className="state-card__icon">{icon}</div>
        <h1>{title}</h1>
        <p>{detail}</p>
      </section>
    </main>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
