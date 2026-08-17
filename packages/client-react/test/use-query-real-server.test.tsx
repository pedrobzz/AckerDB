import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "ackerdb-test-support/dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AckerDBClient, type AckerDBWebSocket, type QueryRef } from "@ackerdb/client";
import {
  AckerDBServer,
  Engine,
  PRODUCTION_LIMITS,
  Runtime,
  v,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
} from "@ackerdb/server";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AckerDBProvider, useQuery, type AckerDBQueryState } from "@ackerdb/client-react";
import { until } from "ackerdb-test-support/async";

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

async function createApp(): Promise<App> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-query-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const modules = {
    messages: {
      list: query({
        access: "public",
        args: {},
        handler: (ctx: Ctx) => ctx.db.messages.query().collect(),
      }),
      add: mutation({
        access: "public",
        args: { body: v.string() },
        handler: (ctx: Ctx, args: Ctx) => ctx.db.messages.insert({ body: args.body }),
      }),
    },
  };
  const server = new AckerDBServer({ limits: PRODUCTION_LIMITS, port: 0 });
  const registry = server.loadFunctionModules(modules);
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS });
  await runtime.start();
  server.activate(runtime);
  return {
    base: `http://127.0.0.1:${server.port}`,
    async close() {
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type Message = { readonly id: bigint; readonly body: string };
const messagesList = { $ref: "api.messages.list" } as QueryRef<Record<never, never>, Message[]>;

let observed: AckerDBQueryState<Message[]> | undefined;

function MessageBoard(): ReactNode {
  const state = useQuery(messagesList, {});
  observed = state;
  switch (state.status) {
    case "disabled":
    case "pending":
      return <span>{state.status}</span>;
    case "success":
      return (
        <span>
          fresh:{state.data.map((row) => row.body).join(",")}
        </span>
      );
    case "rejected":
      return <span>error:{state.error.code}</span>;
    case "unavailable":
      return (
        <span>
          {state.data === undefined ? `error:${state.error.code}` : `stale:${state.data.map((row) => row.body).join(",")}`}
        </span>
      );
  }
}

let app: App;
beforeAll(async () => {
  app = await createApp();
});
afterAll(() => app.close());

describe("useQuery against a real ackerdb server", () => {
  test("delivers live data, keeps it stale across a dropped socket, and resumes fresh", async () => {
    const sockets: WebSocket[] = [];
    const container = mountPoint();
    const root = createRoot(container);
    const writer = new AckerDBClient({ url: app.base, credential: { kind: "anonymous" } });
    root.render(
      <AckerDBProvider
        config={{
          url: app.base,
          credential: { kind: "anonymous" },
          createWebSocket: (url) => {
            const socket = new NativeWebSocket(url);
            sockets.push(socket);
            return socket as unknown as AckerDBWebSocket;
          },
        }}
      >
        <MessageBoard />
      </AckerDBProvider>,
    );
    // The pending -> success transition itself is covered deterministically in
    // use-query.test.tsx; a real server can outrun a polling assertion here.
    await until(() => container.textContent === "fresh:", "the first authoritative delivery");

    // A live mutation from another client reaches the rendered query.
    await writer.mutation("api.messages.add", { body: "hello" });
    await until(() => container.textContent === "fresh:hello", "the live update");
    const delivered = observed!;

    // Dropping the socket demotes the retained rows to stale without losing them.
    sockets.findLast((socket) => socket.readyState === WebSocket.OPEN)!.close();
    await until(() => container.textContent === "stale:hello", "the stale snapshot");
    const stale = observed!;
    if (stale.status !== "unavailable" || delivered.status !== "success") {
      throw new Error("expected retained unavailable data");
    }
    expect(stale.data).toBe(delivered.data);

    // The client reconnects with its cursor and the server's real resume
    // protocol confirms the rows fresh again without redelivery.
    await until(() => container.textContent === "fresh:hello", "the resumed fresh snapshot");

    await writer.mutation("api.messages.add", { body: "again" });
    await until(() => container.textContent === "fresh:hello,again", "the post-resume update");

    writer.close();
    root.unmount();
    await until(
      () => sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      "every provider socket to close",
    );
  }, 15_000);
});
