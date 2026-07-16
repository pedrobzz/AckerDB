import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DbzzProvider, useConnectionState } from "@dbzz/client-react";

function ConnectionBadge(): ReactNode {
  const state = useConnectionState();
  return (
    <main>
      <h1>dbzz react fixture</h1>
      <p>
        connection: <strong id="phase">{state.phase}</strong>
      </p>
      {state.phase === "ready" && <p>principal: {state.authentication.principal}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DbzzProvider config={{ url: "http://127.0.0.1:3211", credential: { kind: "anonymous" } }}>
      <ConnectionBadge />
    </DbzzProvider>
  </StrictMode>,
);
