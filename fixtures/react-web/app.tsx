import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AckerDBProvider, useConnectionState } from "@ackerdb/client-react";

function ConnectionBadge(): ReactNode {
  const state = useConnectionState();
  return (
    <main>
      <h1>AckerDB React fixture</h1>
      <p>
        connection: <strong id="phase">{state.phase}</strong>
      </p>
      {state.phase === "ready" && <p>principal: {state.authentication.principal}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AckerDBProvider config={{ url: "http://127.0.0.1:3211", credential: { kind: "anonymous" } }}>
      <ConnectionBadge />
    </AckerDBProvider>
  </StrictMode>,
);
