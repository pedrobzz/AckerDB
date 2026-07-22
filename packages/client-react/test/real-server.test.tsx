import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbzzWebSocket } from "@dbzz/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineTable,
  query,
  reconcile,
  serve,
} from "@dbzz/server";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DbzzProvider, useConnectionState } from "@dbzz/client-react";

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

interface App {
  readonly base: string;
  close(): Promise<void>;
}

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "dbzz-react-real-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
    messages: {
      list: query({
        access: "public",
        args: {},
        handler: (ctx: Ctx) => ctx.db.messages.query().collect(),
      }),
    },
  });
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS, telemetry: false });
  const server = serve({ runtime, port: 0 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    async close() {
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function ConnectionReport(): ReactNode {
  const state = useConnectionState();
  return (
    <span>
      {state.phase}:{state.phase === "ready" ? state.authentication.principal : "-"}
    </span>
  );
}

let app: App;
beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());

describe("DbzzProvider against a real dbzz server", () => {
  test("reaches ready through the provider and closes its socket on unmount", async () => {
    const sockets: WebSocket[] = [];
    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <DbzzProvider
          config={{
            url: app.base,
            credential: { kind: "anonymous" },
            createWebSocket: (url) => {
              const socket = new NativeWebSocket(url);
              sockets.push(socket);
              return socket as unknown as DbzzWebSocket;
            },
          }}
        >
          <ConnectionReport />
        </DbzzProvider>
      </StrictMode>,
    );

    // The pre-ready "connecting:-" snapshot is too transient to poll for once
    // the process is warm (an in-process handshake completes between polls);
    // its deterministic coverage lives in the lifecycle and SSR suites.
    await until(() => container.textContent === "ready:anonymous", "the ready state");
    expect(sockets.filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(1);

    root.unmount();
    await until(
      () => sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      "every provider socket to close",
    );
  });
});
