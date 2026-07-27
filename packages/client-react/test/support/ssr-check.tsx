// Executed as a bare Bun process by ssr.test.ts: no DOM globals exist here.
// Proves server rendering never constructs a client, touches WebSocket, or
// produces anything but the deterministic non-ready snapshot.
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { ProcedureRef } from "@ackerdb/client";
import {
  AckerDBProvider,
  skip,
  useConnectionState,
  useQueryProcedure,
} from "@ackerdb/client-react";

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

const echo = { $ref: "tools.echo" } as ProcedureRef<
  { readonly value: string },
  string
>;

function Badge(): ReactNode {
  const connection = useConnectionState();
  const pending = useQueryProcedure(echo, { value: "one" });
  const disabled = useQueryProcedure(echo, skip);
  return <output>{connection.phase}/{pending.status}/{disabled.status}</output>;
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
const normalized = first.replaceAll("<!-- -->", "");
if (!normalized.includes("connecting/pending/disabled")) {
  fail(`unexpected server markup: ${first}`);
}
if (socketAttempts !== 0) fail("server render constructed a socket");
process.stdout.write(`SSR_OK ${normalized}\n`);
