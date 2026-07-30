import { describe, expect, test } from "bun:test";
import {
  Ok,
  RealtimeDataPlane,
  REALTIME_PROTOCOL_VERSION,
  type PortableMediaStreamTrack,
  type PortableRTCConfiguration,
  type PortableRTCDataChannel,
  type PortableRTCPeerConnection,
  type RealtimeDataPlaneIncomingStream,
} from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { invokeRegisteredHandler } from "../../src/app/invocation.ts";
import type { ProcedureCtx } from "../../src/app/functions.ts";
import { realtime } from "../../src/realtime/definition.ts";
import {
  RealtimeServerSession,
  type RealtimeServerSessionAdapter,
  type RealtimeServerSessionLimits,
  type RealtimeServerSessionOptions,
} from "../../src/realtime/session.ts";
import type { RealtimePeerEngine } from "../../src/realtime/engine.ts";
import type {
  RealtimeAudioSource,
  RealtimeAudioStream,
  RealtimeVideoSource,
  RealtimeVideoStream,
} from "../../src/realtime/media.ts";
import { v } from "../../src/validation/v.ts";
import { testRealtimeEngine } from "./support.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
} from "../../src/realtime/resources.ts";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "open";
  peer?: FakeDataChannel;

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string" || data instanceof Blob) {
      throw new Error("expected binary data");
    }
    const view = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const packet = view.slice();
    queueMicrotask(() => {
      this.peer?.dispatchEvent(new MessageEvent("message", {
        data: packet.buffer,
      }));
    });
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  closed = false;
  offers = 0;

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offers++;
    return { type: "offer", sdp: `v=0\r\nserver-${this.offers}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nserver-answer" };
  }

  async setLocalDescription(value: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-local-offer"
      : "stable";
  }

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-remote-offer"
      : "stable";
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function dataChannels(): readonly [FakeDataChannel, FakeDataChannel] {
  const client = new FakeDataChannel();
  const server = new FakeDataChannel();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

function procedure(signal: AbortSignal): ProcedureCtx {
  return Object.freeze({
    auth: ANONYMOUS_PRINCIPAL,
    abortSignal: signal,
    timestamp: 1,
    tx: async () => Ok(undefined),
    linkAccount: async () => {},
    unlinkAccount: async () => {},
  }) as ProcedureCtx;
}

const SESSION_LIMITS = Object.freeze({
  maxBufferedAmount: 64 * 1024,
  maxConcurrentStreams: 4,
  maxIncomingBufferedBytes: 64 * 1024,
  defaultStreamMaxBytes: 1024,
  maxInFlightHandlers: 8,
  streamIdleMs: 30_000,
  maxAuxiliaryPeers: 2,
  maxDecodedStreams: 4,
  maxMediaSources: 4,
}) satisfies RealtimeServerSessionLimits;

function sessionAdapter(
  failed: RealtimeServerSessionAdapter["failed"] = () => {},
): RealtimeServerSessionAdapter {
  return {
    createContext: (signal) => ({
      value: procedure(signal),
      release: () => {},
    }),
    invoke: (owner, context, work) =>
      invokeRegisteredHandler(owner, context as never, work).then(
        (value) => value as never,
      ),
    failed,
  };
}

function createSession(
  options: Omit<RealtimeServerSessionOptions, "adapter" | "limits"> & {
    readonly adapter?: RealtimeServerSessionAdapter;
    readonly limits?: Partial<RealtimeServerSessionLimits>;
  },
): Promise<RealtimeServerSession> {
  return RealtimeServerSession.create({
    ...options,
    adapter: options.adapter ?? sessionAdapter(),
    limits: {
      ...SESSION_LIMITS,
      ...options.limits,
    },
  });
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe("RealtimeServerSession", () => {
  test("owns auxiliary peers and lazily-created media resources", async () => {
    const [, serverChannel] = dataChannels();
    const clientPeer = new FakePeerConnection();
    const upstreamPeer = new FakePeerConnection();
    const track = {} as PortableMediaStreamTrack;
    const closed: string[] = [];
    const audioStream = Object.assign(new ReadableStream(), {
      close: () => closed.push("audio-stream"),
    }) as RealtimeAudioStream;
    const videoStream = Object.assign(new ReadableStream(), {
      close: () => closed.push("video-stream"),
    }) as RealtimeVideoStream;
    const audioSource = {
      track,
      sampleRate: 48_000,
      channels: 1,
      queuedDuration: 0,
      captureFrame: async () => {},
      clearQueue: () => {},
      waitForPlayout: async () => {},
      close: () => closed.push("audio-source"),
    } satisfies RealtimeAudioSource;
    const videoSource = {
      track,
      width: 640,
      height: 480,
      captureFrame: () => {},
      close: () => closed.push("video-source"),
    } satisfies RealtimeVideoSource;
    let configuration: PortableRTCConfiguration | undefined;
    const engine: RealtimePeerEngine = {
      close: () => {},
      createPeerConnection: (value) => {
        configuration = value;
        return upstreamPeer as unknown as PortableRTCPeerConnection;
      },
      createAudioStream: () => audioStream,
      createAudioSource: () => audioSource,
      createVideoStream: () => videoStream,
      createVideoSource: () => videoSource,
    };
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: (ctx) => {
        expect(ctx.createPeerConnection({
          iceServers: [{ urls: "stun:provider.example.test" }],
        })).toBe(upstreamPeer as unknown as PortableRTCPeerConnection);
        expect(ctx.media.audioStream(track)).toBe(audioStream);
        expect(ctx.media.audioSource()).toBe(audioSource);
        expect(ctx.media.videoStream(track)).toBe(videoStream);
        expect(ctx.media.videoSource({ width: 640, height: 480 })).toBe(
          videoSource,
        );
      },
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: clientPeer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine,
    });

    expect(configuration).toEqual({
      iceServers: [{ urls: "stun:provider.example.test" }],
    });
    session.close();
    expect(upstreamPeer.closed).toBe(true);
    expect(clientPeer.closed).toBe(true);
    expect(closed).toEqual([
      "video-source",
      "video-stream",
      "audio-source",
      "audio-stream",
    ]);
  });

  test("rejects generation-owned native resources before exceeding their budgets", async () => {
    const [, serverChannel] = dataChannels();
    const clientPeer = new FakePeerConnection();
    const track = {} as PortableMediaStreamTrack;
    const created = {
      peers: 0,
      decodedStreams: 0,
      mediaSources: 0,
    };
    const errors: unknown[] = [];
    const pressure: string[] = [];
    const resource = () => Object.assign(new ReadableStream(), {
      close: () => {},
    });
    const engine: RealtimePeerEngine = {
      close: () => {},
      createPeerConnection: () => {
        created.peers++;
        return new FakePeerConnection() as unknown as PortableRTCPeerConnection;
      },
      createAudioStream: () => {
        created.decodedStreams++;
        return resource() as RealtimeAudioStream;
      },
      createVideoStream: () => {
        created.decodedStreams++;
        return resource() as RealtimeVideoStream;
      },
      createAudioSource: () => {
        created.mediaSources++;
        return {
          track,
          sampleRate: 48_000,
          channels: 1,
          queuedDuration: 0,
          captureFrame: async () => {},
          clearQueue: () => {},
          waitForPlayout: async () => {},
          close: () => {},
        };
      },
      createVideoSource: () => {
        created.mediaSources++;
        return {
          track,
          width: 640,
          height: 480,
          captureFrame: () => {},
          close: () => {},
        };
      },
    };
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: (ctx) => {
        ctx.createPeerConnection();
        try {
          ctx.createPeerConnection();
        } catch (error) {
          errors.push(error);
        }
        ctx.media.audioStream(track);
        try {
          ctx.media.videoStream(track);
        } catch (error) {
          errors.push(error);
        }
        ctx.media.audioSource();
        try {
          ctx.media.videoSource({ width: 640, height: 480 });
        } catch (error) {
          errors.push(error);
        }
      },
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: clientPeer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine,
      observePressure: (value) => pressure.push(value),
      limits: {
        maxAuxiliaryPeers: 1,
        maxDecodedStreams: 1,
        maxMediaSources: 1,
      },
    });

    expect(created).toEqual({
      peers: 1,
      decodedStreams: 1,
      mediaSources: 1,
    });
    expect(errors).toHaveLength(3);
    expect(pressure).toEqual([
      "resource-saturation",
      "resource-saturation",
      "resource-saturation",
    ]);
    for (const error of errors) {
      expect(error).toMatchObject({
        code: "overloaded",
        resource: "connection",
      });
    }

    session.close();
  });

  test("returns native resource capacity immediately on explicit close", async () => {
    const [, serverChannel] = dataChannels();
    const clientPeer = new FakePeerConnection();
    const track = {} as PortableMediaStreamTrack;
    const closed = {
      peers: 0,
      decodedStreams: 0,
      mediaSources: 0,
    };
    const resources = new RealtimeGlobalResourceBudget({
      ...REALTIME_GLOBAL_RESOURCE_DEFAULTS,
      maxAuxiliaryPeers: 1,
      maxDecodedStreams: 1,
      maxMediaSources: 1,
    });
    const engine: RealtimePeerEngine = {
      close: () => {},
      createPeerConnection: () => {
        const peer = new FakePeerConnection();
        peer.addEventListener("closed", () => closed.peers++);
        const close = peer.close.bind(peer);
        peer.close = () => {
          if (peer.closed) return;
          close();
          peer.dispatchEvent(new Event("closed"));
        };
        return peer as unknown as PortableRTCPeerConnection;
      },
      createAudioStream: () =>
        Object.assign(new ReadableStream(), {
          close: () => {
            closed.decodedStreams++;
          },
        }) as RealtimeAudioStream,
      createVideoStream: () => {
        throw new Error("unexpected video stream");
      },
      createAudioSource: () => ({
        track,
        sampleRate: 48_000,
        channels: 1,
        queuedDuration: 0,
        captureFrame: async () => {},
        clearQueue: () => {},
        waitForPlayout: async () => {},
        close: () => {
          closed.mediaSources++;
        },
      }),
      createVideoSource: () => {
        throw new Error("unexpected video source");
      },
    };
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: (ctx) => {
        ctx.createPeerConnection().close();
        ctx.createPeerConnection();
        ctx.media.audioStream(track).close();
        ctx.media.audioStream(track);
        ctx.media.audioSource().close();
        ctx.media.audioSource();
      },
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: clientPeer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine,
      resourceBudget: resources,
      limits: {
        maxAuxiliaryPeers: 1,
        maxDecodedStreams: 1,
        maxMediaSources: 1,
      },
    });

    expect(closed).toEqual({
      peers: 1,
      decodedStreams: 1,
      mediaSources: 1,
    });
    expect(resources.snapshot().active).toMatchObject({
      auxiliaryPeers: 1,
      decodedStreams: 1,
      mediaSources: 1,
    });

    session.close();
    expect(closed).toEqual({
      peers: 2,
      decodedStreams: 2,
      mediaSources: 2,
    });
    expect(resources.snapshot().active).toMatchObject({
      auxiliaryPeers: 0,
      decodedStreams: 0,
      mediaSources: 0,
    });
  });

  test("exposes the native peer and dispatches typed events without serializing listeners", async () => {
    const [clientChannel, serverChannel] = dataChannels();
    const peer = new FakePeerConnection();
    const order: string[] = [];
    const clientEvents: unknown[] = [];
    const failures: unknown[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let serverSend!: (text: string) => boolean;

    const definition = realtime({
      args: { assistantId: v.bigint() },
      clientEvents: {
        prompt: v.object({ text: v.string() }),
      },
      serverEvents: {
        transcript: v.object({ text: v.string() }),
      },
      access: "public",
      authorize: () => ({ voice: "alloy" }),
      handler: (ctx) => {
        expect(ctx.peerConnection).toBe(
          peer as unknown as PortableRTCPeerConnection,
        );
        expect(ctx.state).toEqual({ voice: "alloy" });
        ctx.on("prompt", async ({ text }) => {
          order.push(`first:start:${text}`);
          await firstGate;
          order.push(`first:end:${text}`);
        });
        ctx.on("prompt", ({ text }) => {
          order.push(`second:${text}`);
        });
        serverSend = (text) => ctx.send("transcript", { text });
      },
    });
    const adapter: RealtimeServerSessionAdapter = {
      createContext: (signal) => ({
        value: procedure(signal),
        release: () => {},
      }),
      invoke: (owner, context, work) =>
        invokeRegisteredHandler(owner, context as never, work).then(
          (value) => value as never,
        ),
      failed: (error) => failures.push(error),
    };
    const client = new RealtimeDataPlane({
      channel: clientChannel as unknown as RTCDataChannel,
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: (event, payload) => clientEvents.push({ event, payload }),
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const session = await createSession({
      definition,
      args: { assistantId: 1n },
      state: { voice: "alloy" },
      peerConnection: peer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ),
      adapter,
      limits: {
        defaultStreamMaxBytes: 1024 * 1024,
      },
    });

    expect(client.send("prompt", { text: "hello" })).toBe(true);
    await turns();
    expect(order).toEqual(["first:start:hello", "second:hello"]);
    releaseFirst();
    await turns();
    expect(order).toEqual([
      "first:start:hello",
      "second:hello",
      "first:end:hello",
    ]);

    expect(serverSend("ready")).toBe(true);
    await turns();
    expect(clientEvents).toEqual([{
      event: "transcript",
      payload: { text: "ready" },
    }]);
    expect(failures).toEqual([]);
    session.close();
    client.close();
    expect(peer.closed).toBe(true);
  });

  test("owns work triggered by an external provider callback", async () => {
    const [, serverChannel] = dataChannels();
    const peer = new FakePeerConnection();
    const failures: unknown[] = [];
    const invocations: string[] = [];
    let run!: (work: () => unknown) => void;
    let resolveWork!: () => void;
    const workFinished = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: (ctx) => {
        run = ctx.run;
      },
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: peer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ),
      adapter: {
        ...sessionAdapter((error) => failures.push(error)),
        invoke: async (owner, context, work) => {
          invocations.push("invoke");
          return invokeRegisteredHandler(owner, context as never, work).then(
            (value) => value as never,
          );
        },
      },
    });

    run(async () => {
      await Promise.resolve();
      resolveWork();
    });
    await workFinished;
    expect(invocations).toEqual(["invoke", "invoke"]);
    expect(failures).toEqual([]);

    session.close();
  });

  test("closes the session when external provider work fails", async () => {
    const [, serverChannel] = dataChannels();
    const peer = new FakePeerConnection();
    const failure = new Error("provider callback failed");
    let run!: (work: () => unknown) => void;
    let reported!: unknown;
    let reportFailure!: () => void;
    const failed = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: (ctx) => {
        run = ctx.run;
      },
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: peer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ),
      adapter: sessionAdapter((error) => {
          reported = error;
          reportFailure();
      }),
    });

    run(() => {
      throw failure;
    });
    await failed;
    expect(reported).toBe(failure);
    expect(session.abortSignal.aborted).toBe(true);
    expect(peer.closed).toBe(true);
  });

  test("validates stream metadata and exposes a bounded standard readable", async () => {
    const [clientChannel, serverChannel] = dataChannels();
    const failures: unknown[] = [];
    let received!: Uint8Array;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      clientStreams: {
        photo: {
          metadata: v.object({ contentType: v.literal("image/jpeg") }),
          maxBytes: 32,
        },
      },
      access: "public",
      handler: (ctx) => {
        ctx.onStream("photo", async ({ metadata, readable }) => {
          expect(metadata.contentType).toBe("image/jpeg");
          received = new Uint8Array(await new Response(readable).arrayBuffer());
          finish();
        });
      },
    });
    const adapter: RealtimeServerSessionAdapter = {
      createContext: (signal) => ({
        value: procedure(signal),
        release: () => {},
      }),
      invoke: (owner, context, work) =>
        invokeRegisteredHandler(owner, context as never, work).then(
          (value) => value as never,
        ),
      failed: (error) => failures.push(error),
    };
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection:
        new FakePeerConnection() as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ),
      adapter,
    });
    const client = new RealtimeDataPlane({
      channel: clientChannel as unknown as RTCDataChannel,
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: (
        _stream,
        _metadata,
        _size,
      ): { maxBytes: number; accept(input: RealtimeDataPlaneIncomingStream): void } | undefined =>
        undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const output = client.openStream(
      "photo",
      { contentType: "image/jpeg" },
      32,
      4,
    );
    const writer = output.writable.getWriter();
    await writer.write(new Uint8Array([1, 2, 3, 4]));
    await writer.close();
    await finished;
    expect(received).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(failures).toEqual([]);
    session.close();
    client.close();
  });

  test("perfect-negotiates native changes over the internal data channel", async () => {
    const [clientChannel, serverChannel] = dataChannels();
    const peer = new FakePeerConnection();
    const failures: unknown[] = [];
    let client!: RealtimeDataPlane;
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: () => {},
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: peer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ),
      adapter: sessionAdapter((error) => failures.push(error)),
    });
    client = new RealtimeDataPlane({
      channel: clientChannel as unknown as RTCDataChannel,
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: async (frame) => {
        if (frame.t !== "signal_description" || frame.description.type !== "offer") {
          return;
        }
        await client.sendSignal({
          v: REALTIME_PROTOCOL_VERSION,
          t: "signal_description",
          description: { type: "answer", sdp: "v=0\r\nclient-answer" },
        });
      },
      onFatalError: (error) => failures.push(error),
    });

    session.initialNegotiationComplete();
    peer.dispatchEvent(new Event("negotiationneeded"));
    await turns(8);
    expect(peer.offers).toBe(1);
    expect(peer.remoteDescription).toMatchObject({
      type: "answer",
      sdp: "v=0\r\nclient-answer",
    });
    expect(failures).toEqual([]);

    session.close();
    client.close();
  });

  test("does not renegotiate handler mutations already included in the initial answer", async () => {
    const [, serverChannel] = dataChannels();
    const peer = new FakePeerConnection();
    const failures: unknown[] = [];
    const definition = realtime({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      handler: () => {},
    });
    const session = await createSession({
      definition,
      args: {},
      state: undefined,
      peerConnection: peer as unknown as PortableRTCPeerConnection,
      dataChannel: serverChannel as unknown as PortableRTCDataChannel,
      engine: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ),
      adapter: sessionAdapter((error) => failures.push(error)),
    });

    peer.dispatchEvent(new Event("negotiationneeded"));
    session.initialNegotiationComplete();
    await turns(8);

    expect(peer.offers).toBe(0);
    expect(failures).toEqual([]);
    session.close();
  });
});
