// Executed as a bare Bun process by use-event-ssr.test.ts: no DOM globals
// exist here. Proves server rendering a useEvent consumer never constructs a
// client, subscribes, invokes callbacks, or emits React warnings.
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { AckerDBProvider, useEvent, type EventRef } from "@ackerdb/client-react";

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

const pings = { $ref: "events.pings" } as EventRef<{ min: number }, { n: number }>;
let deliveries = 0;

function Listener(): ReactNode {
  useEvent(pings, { min: 1 }, () => {
    deliveries++;
  });
  return <output>listening</output>;
}

const element = (
  <StrictMode>
    <AckerDBProvider config={{ url: "http://127.0.0.1:9", credential: { kind: "anonymous" } }}>
      <Listener />
    </AckerDBProvider>
  </StrictMode>
);

const first = renderToString(element);
const second = renderToString(element);
console.error = originalError;
if (first !== second) fail("server render is not deterministic");
if (!first.includes("listening")) fail(`unexpected server markup: ${first}`);
if (socketAttempts !== 0) fail("server render constructed a socket");
if (deliveries !== 0) fail("server render delivered an event");
if (warnings.length !== 0) fail(`server render warned: ${warnings.join(" | ")}`);
console.log(`SSR_EVENT_OK ${first}`);
