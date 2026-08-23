import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, testDefinitions } from "ackerdb-test-support/server";
import { NativeWebSocket, mountPoint } from "ackerdb-test-support/dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage } from "@ackerdb/core";
import {
  AckerDBClient,
  anyApi,
  type ClientResult,
  type AckerDBWebSocket,
  type MutationRef,
  type QueryRef,
} from "@ackerdb/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  v,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
} from "@ackerdb/server";
import { StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, useConnectionState, useMutation } from "@ackerdb/client-react";
import { FrameProxy, assertTcpPortReleased } from "../../server/test/support/frame-proxy.ts";
import { within } from "ackerdb-test-support/async";

const WAIT_DEADLINE_MS = 5_000;

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
  }).index(["channelId"]),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

interface MessageRow {
  readonly id: bigint;
  readonly channelId: bigint;
  readonly body: string;
}

const listRef = anyApi.messages.list as QueryRef<{ readonly channelId: bigint }, readonly MessageRow[]>;
const sendRef = anyApi.messages.send as MutationRef<
  { readonly channelId: bigint; readonly body: string },
  bigint
>;

interface App {
  readonly proxy: FrameProxy;
  readonly observer: AckerDBClient;
  close(): Promise<void>;
}

async function createApp(): Promise<App> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-mutation-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const modules = {
    messages: {
      list: query({
        access: "public",
        args: { channelId: v.bigint() },
        handler: async (ctx: Ctx, args: Ctx) =>
          await ctx.db.messages
            .query()
            .where((message: Ctx) => message.channelId.eq(args.channelId))
            .collect(),
      }),
      send: mutation({
        access: "public",
        args: { channelId: v.bigint(), body: v.string() },
        handler: async (ctx: Ctx, args: Ctx) => await ctx.db.messages.insert(args),
      }),
    },
  };
  const running = await startTestServer({
    engine,
    definitions: testDefinitions(modules),
    limits: PRODUCTION_LIMITS,
  });
  const { server } = running;
  const proxy = await FrameProxy.listen({ upstreamPort: server.port });
  const observer = new AckerDBClient({
    url: `http://127.0.0.1:${server.port}`,
    credential: { kind: "anonymous" },
    createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
  });
  return {
    proxy,
    observer,
    async close() {
      const proxyPort = proxy.port;
      const serverPort = server.port;
      observer.close();
      proxy.assertBytePreserving();
      await proxy.close();
      await running.close();
      rmSync(directory, { recursive: true, force: true });
      await assertTcpPortReleased(proxyPort);
      await assertTcpPortReleased(serverPort);
    },
  };
}

type SendMessage = (
  args: { readonly channelId: bigint; readonly body: string },
) => Promise<ClientResult<bigint>>;

function mustOk<Data>(result: ClientResult<Data>): Data {
  if (!result.ok) throw result.error;
  return result.data;
}

interface Mounted {
  readonly root: Root;
  send(): SendMessage;
  phase(): string;
}

const captured: { send?: SendMessage; phase?: string } = {};

function MutationHarness(): ReactNode {
  const send = useMutation(sendRef);
  const state = useConnectionState();
  captured.send = send;
  captured.phase = state.phase;
  return <span>{state.phase}</span>;
}

async function mount(app: App): Promise<Mounted> {
  captured.send = undefined;
  captured.phase = undefined;
  const container = mountPoint();
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <AckerDBProvider
        config={{
          url: app.proxy.url,
          credential: { kind: "anonymous" },
          // An immediate deterministic reconnect: the test proves replay
          // identity, not backoff policy.
          reconnect: { baseDelayMs: 1, maxDelayMs: 1, stableOpenMs: 60_000 },
          random: () => 0,
          createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
        }}
      >
        <MutationHarness />
      </AckerDBProvider>
    </StrictMode>,
  );
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (captured.phase !== "ready") {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the ready provider");
    await Bun.sleep(10);
  }
  return {
    root,
    send() {
      if (!captured.send) throw new Error("No captured mutation callable");
      return captured.send;
    },
    phase() {
      return captured.phase ?? "unmounted";
    },
  };
}

function mutationRequests(app: App, body: string): Extract<ClientMessage, { t: "m" }>[] {
  return app.proxy.clientFrames.flatMap(({ message }) =>
    message.t === "m" && (message.args as { body?: unknown }).body === body ? [message] : [],
  );
}

let app: App;
beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

describe("useMutation against a real ackerdb server", () => {
  test(
    "a connection severed at the response boundary converges with one identifier and one effect",
    async () => {
      const mounted = await mount(app);
      const cut = app.proxy.cutNextServerFrame(
        (message) => message.t === "ok" && message.kind === "mutation",
      );

      let settlements = 0;
      const result = mounted
        .send()({ channelId: 1n, body: "replayed" })
        .then((value) => {
          settlements++;
          return value;
        });
      // The server commits and acknowledges, but the acknowledgment dies with
      // the connection; the client must replay under the original identity.
      await cut;
      const id = mustOk(await within(result, "severed mutation settlement"));

      const requests = mutationRequests(app, "replayed");
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
      expect(new Set(requests.map(({ issuedAt }) => issuedAt)).size).toBe(1);
      const requestId = requests[0]!.mutationRequestId;

      // Exactly one acknowledgment reached the client, and it names the replay.
      const forwardedAcks = app.proxy.serverFrames.filter(
        ({ message, forwardedBytes }) =>
          forwardedBytes !== undefined &&
          message.t === "ok" &&
          message.kind === "mutation" &&
          message.receipt.mutationRequestId === requestId,
      );
      expect(forwardedAcks).toHaveLength(1);
      const ack = forwardedAcks[0]!.message;
      if (ack.t !== "ok" || ack.kind !== "mutation") throw new Error("expected a mutation receipt");
      expect(ack.receipt.replay).toBe("replayed");

      // Exactly one server effect exists for the interrupted mutation.
      const rows = mustOk(await app.observer.query(listRef, { channelId: 1n }));
      expect(rows.filter(({ body }) => body === "replayed")).toEqual([
        { id, channelId: 1n, body: "replayed" },
      ]);
      await Promise.resolve();
      expect(settlements).toBe(1);

      mounted.root.unmount();
    },
    15_000,
  );
});
