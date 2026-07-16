// Executed as a bare Bun process by use-authentication-ssr.test.ts: no DOM
// globals exist here. Proves server rendering a useAuthentication consumer
// never constructs a client or socket and produces the deterministic
// pre-client snapshot for the configured credential kind.
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { DbzzProvider, useAuthentication } from "@dbzz/client-react";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (typeof window !== "undefined") fail("window must not exist during this check");

let socketAttempts = 0;
(globalThis as { WebSocket: unknown }).WebSocket = class {
  constructor() {
    socketAttempts++;
    throw new Error("server render must not construct sockets");
  }
};

const warnings: string[] = [];
const originalError = console.error;
console.error = (...parts: unknown[]) => {
  warnings.push(parts.map(String).join(" "));
};

function Badge(): ReactNode {
  const { state } = useAuthentication();
  return (
    <output>
      {state.phase}:{state.phase === "authenticating" ? state.credential : "-"}
    </output>
  );
}

function page(credential: { kind: "anonymous" } | { kind: "bearer"; token: string }): ReactNode {
  return (
    <StrictMode>
      <DbzzProvider config={{ url: "http://127.0.0.1:9", credential }}>
        <Badge />
      </DbzzProvider>
    </StrictMode>
  );
}

// The snapshot names the credential kind the client would present, so a
// bearer-configured tree never renders as an anonymous one.
const bearer = renderToString(page({ kind: "bearer", token: "token-a" }));
const bearerAgain = renderToString(page({ kind: "bearer", token: "token-a" }));
const anonymous = renderToString(page({ kind: "anonymous" }));
console.error = originalError;
if (bearer !== bearerAgain) fail("server render is not deterministic");
if (!bearer.includes("authenticating") || !bearer.includes("bearer")) {
  fail(`unexpected bearer markup: ${bearer}`);
}
if (!anonymous.includes("authenticating") || !anonymous.includes("anonymous")) {
  fail(`unexpected anonymous markup: ${anonymous}`);
}
if (socketAttempts !== 0) fail("server render constructed a socket");
if (warnings.length !== 0) fail(`server render warned: ${warnings.join(" | ")}`);
console.log(`SSR_AUTHENTICATION_OK ${bearer} ${anonymous}`);
