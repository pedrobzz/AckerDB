// Executed as a bare Bun process by ssr.test.ts: no DOM globals exist here.
// Proves server rendering never constructs a client, touches WebSocket, or
// produces anything but the deterministic non-ready snapshot.
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { AckerDBProvider, useConnectionState } from "@ackerdb/client-react";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (typeof window !== "undefined") fail("window must not exist during this check");
if (typeof document !== "undefined") fail("document must not exist during this check");

let socketAttempts = 0;
(globalThis as { WebSocket: unknown }).WebSocket = class {
  constructor() {
    socketAttempts++;
    throw new Error("server render must not construct sockets");
  }
};

function Badge(): ReactNode {
  const state = useConnectionState();
  return <output>{state.phase}</output>;
}

const element = (
  <StrictMode>
    <AckerDBProvider config={{ url: "http://127.0.0.1:9", credential: { kind: "anonymous" } }}>
      <Badge />
    </AckerDBProvider>
  </StrictMode>
);

const first = renderToString(element);
const second = renderToString(element);
if (first !== second) fail("server render is not deterministic");
if (!first.includes("connecting")) fail(`unexpected server markup: ${first}`);
if (socketAttempts !== 0) fail("server render constructed a socket");
console.log(`SSR_OK ${first}`);
