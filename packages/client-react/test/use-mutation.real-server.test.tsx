import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
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
import { StrictMode, useEffect, type ReactNode } from "react";
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
  const registry = new Registry({
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
  });
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS, admin: { telemetry: { enabled: false } } });
  const server = serve({ runtime, port: 0 });
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
      await server.drain();
      engine.close("clean");
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
  test("runs a real mutation through the rendered hook", async () => {
    const mounted = await mount(app);
    const id = mustOk(await within(
      mounted.send()({ channelId: 1n, body: "first" }),
      "first mutation settlement",
    ));
    const rows = mustOk(await app.observer.query(listRef, { channelId: 1n }));
    expect(rows.filter(({ body }) => body === "first")).toEqual([
      { id, channelId: 1n, body: "first" },
    ]);
    mounted.root.unmount();
  });

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

  test("a Strict Mode mount-effect call waits for the client and each lifetime commits exactly once", async () => {
    const settlements: Array<{ kind: "ok"; value: bigint } | { kind: "error"; error: unknown }> =
      [];
    function SendOnMount(): ReactNode {
      const send = useMutation(sendRef);
      useEffect(() => {
        // Issued before the provider's effect constructs the client. Strict
        // Mode runs this effect twice; both queued calls wait through the
        // simulated remount (which closes the first client before either
        // could dispatch) and commit once each on the surviving lifetime.
        send({ channelId: 2n, body: "queued" }).then((result) => {
          settlements.push(
            result.ok
              ? { kind: "ok", value: result.data }
              : { kind: "error", error: result.error },
          );
        });
      }, [send]);
      return null;
    }

    const container = mountPoint();
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <AckerDBProvider
          config={{
            url: app.proxy.url,
            credential: { kind: "anonymous" },
            createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
          }}
        >
          <SendOnMount />
        </AckerDBProvider>
      </StrictMode>,
    );
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    while (settlements.length < 2) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for both mount-effect settlements");
      await Bun.sleep(10);
    }

    // Each of the two Strict Mode effect invocations dispatched its own
    // mutation exactly once — two distinct identities, never a duplicate.
    const requests = mutationRequests(app, "queued");
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(2);

    // Exactly one server effect per call, and the resolutions name the rows.
    const rows = mustOk(await app.observer.query(listRef, { channelId: 2n }));
    const committed = rows.filter(({ body }) => body === "queued");
    expect(committed).toHaveLength(2);
    expect(settlements.map(({ kind }) => kind)).toEqual(["ok", "ok"]);
    const resolved = settlements.flatMap((entry) => (entry.kind === "ok" ? [entry.value] : []));
    expect(new Set(resolved)).toEqual(new Set(committed.map(({ id }) => id)));

    root.unmount();
  });
});
