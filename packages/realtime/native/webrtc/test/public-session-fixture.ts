import {
  anyApi,
  type NativeMediaStreamTrack,
  type NativeRTCConfiguration,
  type NativeRTCPeerConnection,
  type PortableMediaStreamTrack,
  type PortableRTCConfiguration,
  type PortableRTCPeerConnection,
  type RealtimeRef,
} from "@ackerdb/core";
import { AckerDBClient } from "@ackerdb/client";
import { createRealtimeRuntime } from "@ackerdb/realtime";
import {
  Engine,
  Registry,
  Runtime,
  defineSchema,
  defineTable,
  procedure,
  realtime,
  reconcile,
  serve,
  v,
  type ProcedureBuilder,
  type RealtimeBuilder,
} from "@ackerdb/server";

export const PUBLIC_SESSION_TIMEOUT_MS = 15_000;
const PUBLIC_SESSION_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

interface PublicSessionAudioSource {
  readonly track: PortableMediaStreamTrack;
  captureFrame(frame: {
    readonly data: Int16Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samplesPerChannel: number;
  }): Promise<void>;
  close(): void;
}

export interface PublicSessionEngine {
  createGeneration(maxQueuedBytes: number): PublicSessionGeneration;
  close(): void;
}

export interface PublicSessionGeneration {
  createPeerConnection(
    configuration?: PortableRTCConfiguration,
  ): PortableRTCPeerConnection;
  createAudioSource(options: {
    readonly sampleRate: number;
    readonly channels: number;
    readonly queueSizeMs: number;
  }): PublicSessionAudioSource;
  close(): void;
}

type AssistantRef = RealtimeRef<
  Record<string, never>,
  { readonly invoke: { readonly value: string } },
  { readonly completed: { readonly id: bigint; readonly value: string } },
  Record<never, never>,
  Record<never, never>,
  never
>;

function deadline<Value>(
  promise: Promise<Value>,
  description: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      PUBLIC_SESSION_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function eventually(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  await deadline((async () => {
    while (!predicate()) await Bun.sleep(5);
  })(), description);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function verifyPublicRealtimeSession(
  createEngine: () => PublicSessionEngine,
): Promise<void> {
  const schema = defineSchema({
    calls: defineTable({
      id: v.primaryKey(),
      value: v.string(),
    }),
  });
  const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
  const typedRealtime = realtime as RealtimeBuilder<typeof schema>;
  const echo = typedProcedure({
    args: { value: v.string() },
    access: "public",
    handler: async (ctx, { value }) => {
      const response = await fetch(
        `data:text/plain,${encodeURIComponent(value)}`,
        { signal: ctx.abortSignal },
      );
      return response.text();
    },
  });

  const trackReceived = Promise.withResolvers<NativeMediaStreamTrack>();
  const assistant = typedRealtime({
    args: {},
    clientEvents: {
      invoke: v.object({ value: v.string() }),
    },
    serverEvents: {
      completed: v.object({ id: v.bigint(), value: v.string() }),
    },
    access: "public",
    handler: (ctx) => {
      ctx.peerConnection.addEventListener("track", (event) => {
        trackReceived.resolve(event.track as NativeMediaStreamTrack);
      }, { once: true });
      ctx.on("invoke", async ({ value }) => {
        const echoed = await echo(ctx, { value });
        const inserted = await ctx.tx((tx) =>
          tx.db.calls.insert({ value: echoed.data })
        );
        assert(ctx.send("completed", {
          id: inserted.data,
          value: echoed.data,
        }), "typed realtime response was backpressured");
      });
    },
  });

  const database = new Engine(schema, ":memory:");
  reconcile(database);
  const runtime = new Runtime({
    engine: database,
    registry: new Registry({
      assistant: { live: assistant },
      procedures: { echo },
    }),
    telemetry: false,
    // Same-host peers can advertise RFC1918 host candidates. This is an
    // explicit isolated-LAN test topology; production keeps the default deny
    // policy and continues to reject loopback and sensitive addresses.
    realtime: createRealtimeRuntime({
      network: { allowPrivateCandidateAddresses: true },
    }),
  });
  const server = serve({ runtime, port: 0 });
  const engine = createEngine();
  const generation = engine.createGeneration(PUBLIC_SESSION_MAX_QUEUED_BYTES);
  const audio = generation.createAudioSource({
    sampleRate: 48_000,
    channels: 1,
    queueSizeMs: 100,
  });
  const completed = Promise.withResolvers<{
    readonly id: bigint;
    readonly value: string;
  }>();
  const client = new AckerDBClient({
    url: `http://127.0.0.1:${server.port}`,
    credential: { kind: "anonymous" },
    createWebSocket: () => {
      throw new Error("realtime must not open the application WebSocket");
    },
    createPeerConnection: (configuration: NativeRTCConfiguration) =>
      generation.createPeerConnection(
        configuration as PortableRTCConfiguration,
      ) as unknown as NativeRTCPeerConnection,
  });
  const session = client.realtime(
    anyApi.assistant.live as AssistantRef,
    {},
    {
      on: {
        peerConnection(peer) {
          peer.addTrack(audio.track as NativeMediaStreamTrack);
        },
        event: {
          completed: (event) => completed.resolve(event),
        },
      },
    },
  );
  let released = false;

  try {
    await eventually(
      () => session.currentState.phase === "connected",
      "public realtime connection",
    );
    assert(
      session.send("invoke", { value: "native-public-session" }),
      "typed realtime request was backpressured",
    );
    const result = await deadline(completed.promise, "typed server event");
    assert(
      result.id === 1n && result.value === "native-public-session",
      "typed realtime result was incorrect",
    );

    for (let index = 0; index < 5; index++) {
      const data = new Int16Array(480);
      data.fill(index % 2 === 0 ? 3_000 : -3_000);
      await audio.captureFrame({
        data,
        sampleRate: 48_000,
        channels: 1,
        samplesPerChannel: 480,
      });
    }
    assert(
      (await deadline(trackReceived.promise, "server audio track")).kind ===
        "audio",
      "public realtime session did not negotiate audio",
    );
    assert(
      runtime.status().realtime?.activeSessions === 1,
      "runtime did not retain exactly one public realtime session",
    );
    session.release();
    released = true;
    await eventually(() => {
      const realtime = runtime.status().realtime;
      return realtime?.activeSessions === 0 &&
        realtime.reservedSessions === 0 &&
        Object.values(realtime.resources.active).every((count) => count === 0);
    }, "public realtime cleanup");
  } finally {
    if (!released) session.release();
    client.close();
    audio.close();
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    generation.close();
    engine.close();
    database.close("clean");
  }
}
