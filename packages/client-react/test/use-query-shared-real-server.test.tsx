import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, parseClientMessage, type ClientMessage } from "@ackerdb/core";
import { AckerDBClient, type AckerDBWebSocket, type QueryRef } from "@ackerdb/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
  serve,
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

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-shared-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
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

type Message = { readonly id: bigint; readonly body: string };
const messagesList = { $ref: "messages.list" } as QueryRef<Record<never, never>, Message[]>;

const observed = new Map<string, AckerDBQueryState<Message[]>>();

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
          {id}=fresh:{state.data.map((row) => row.body).join(",")};
        </span>
      );
    case "rejected":
      return <span>{`${id}=error:${state.error.code};`}</span>;
    case "unavailable":
      return (
        <span>
          {id}={state.data === undefined ? `error:${state.error.code}` : `stale:${state.data.map((row) => row.body).join(",")}`};
        </span>
      );
  }
}

let app: App;
beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());

describe("shared useQuery consumers against a real ackerdb server", () => {
  test("two boards share one live subscription; the last one leaving releases it cleanly", async () => {
    const sockets: WebSocket[] = [];
    const frames: ClientMessage[] = [];
    const framesOf = <T extends ClientMessage["t"]>(type: T) =>
      frames.filter((frame): frame is Extract<ClientMessage, { t: T }> => frame.t === type);
    const container = mountPoint();
    const root = createRoot(container);
    const writer = new AckerDBClient({ url: app.base, credential: { kind: "anonymous" } });
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
        return socket as unknown as AckerDBWebSocket;
      },
    };
    const render = (boards: string[]) => {
      root.render(
        <AckerDBProvider config={config}>
          {boards.map((id) => (
            <Board key={id} id={id} />
          ))}
        </AckerDBProvider>,
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
