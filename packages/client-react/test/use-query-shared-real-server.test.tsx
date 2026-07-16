import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, parseClientMessage, type ClientMessage } from "@dbzz/core";
import { DbzzClient, type DbzzWebSocket, type QueryRef } from "@dbzz/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
  serve,
} from "@dbzz/server";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DbzzProvider, useQuery, type DbzzQueryState } from "@dbzz/client-react";

const schema = defineSchema({
  messages: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
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
  const directory = mkdtempSync(join(tmpdir(), "dbzz-react-shared-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
    messages: {
      list: query({
        access: "public",
        args: {},
        handler: (ctx: Ctx) => ctx.db.messages.scan().collect(),
      }),
      add: mutation({
        access: "public",
        args: { body: dbz.string() },
        handler: (ctx: Ctx, args: Ctx) => ctx.db.messages.insert({ body: args.body }),
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
  throw new Error(`Timed out waiting for ${description} (last render: ${document.body.textContent})`);
}

type Message = { readonly id: bigint; readonly body: string };
const messagesList = { $ref: "messages.list" } as QueryRef<Record<never, never>, Message[]>;

const observed = new Map<string, DbzzQueryState<Message[]>>();

function Board({ id }: { id: string }): ReactNode {
  const state = useQuery(messagesList, {});
  observed.set(id, state);
  switch (state.status) {
    case "disabled":
    case "pending":
      return <span>{`${id}=${state.status};`}</span>;
    case "success":
      return (
        <span>
          {id}={state.stale ? "stale" : "fresh"}:{state.data.map((row) => row.body).join(",")};
        </span>
      );
    case "error":
      return <span>{`${id}=error:${state.error.code};`}</span>;
  }
}

let app: App;
beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());

describe("shared useQuery consumers against a real dbzz server", () => {
  test("two boards share one live subscription; the last one leaving releases it cleanly", async () => {
    const sockets: WebSocket[] = [];
    const frames: ClientMessage[] = [];
    const framesOf = <T extends ClientMessage["t"]>(type: T) =>
      frames.filter((frame): frame is Extract<ClientMessage, { t: T }> => frame.t === type);
    const container = mountPoint();
    const root = createRoot(container);
    const writer = new DbzzClient({ url: app.base, credential: { kind: "anonymous" } });
    const config = {
      url: app.base,
      credential: { kind: "anonymous" as const },
      // Real sockets with the sent frames recorded, so subscription sharing
      // is observable on the actual wire.
      createWebSocket: (url: string) => {
        const socket = new NativeWebSocket(url);
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          frames.push(parseClientMessage(decode(data as string)));
          send(data);
        };
        sockets.push(socket);
        return socket as unknown as DbzzWebSocket;
      },
    };
    const render = (boards: string[]) => {
      root.render(
        <DbzzProvider config={config}>
          {boards.map((id) => (
            <Board key={id} id={id} />
          ))}
        </DbzzProvider>,
      );
    };

    render(["a", "b"]);
    await until(() => container.textContent === "a=fresh:;b=fresh:;", "both boards fresh");
    expect(framesOf("sub")).toHaveLength(1);

    // One live mutation reaches both consumers as the same snapshot object.
    await writer.mutation("messages.add", { body: "hello" });
    await until(
      () => container.textContent === "a=fresh:hello;b=fresh:hello;",
      "the shared live update",
    );
    expect(observed.get("a")).toBe(observed.get("b")!);

    // One board leaving keeps the shared subscription alive for the other.
    render(["a"]);
    expect(framesOf("unsub")).toHaveLength(0);
    await writer.mutation("messages.add", { body: "again" });
    await until(
      () => container.textContent === "a=fresh:hello,again;",
      "the update after one board left",
    );

    // The last board leaving releases the subscription on the wire.
    render([]);
    await until(() => framesOf("unsub").length === 1, "the release unsubscribe");

    // Remounting starts one clean lifetime: a new cursorless subscription
    // that reads current server state.
    render(["c"]);
    await until(
      () => container.textContent === "c=fresh:hello,again;",
      "the clean re-subscription",
    );
    const subs = framesOf("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.cursor).toBeUndefined();

    writer.close();
    root.unmount();
    await until(
      () => sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      "every provider socket to close",
    );
  }, 15_000);
});
