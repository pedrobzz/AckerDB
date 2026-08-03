import { describe, expect, test } from "bun:test";
import { noopLogger } from "ackerdb-test-support/telemetry";
import {
  ANONYMOUS_PRINCIPAL,
  realtime,
  v,
  type ProcedureCtx,
  type RealtimeAudioSource,
  type RealtimeAudioStream,
  type RealtimeServerSessionAdapter,
  type RealtimeVideoSource,
  type RealtimeVideoStream,
} from "@ackerdb/server";
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
import { invokeRegisteredHandler } from "../../server/src/app/invocation.ts";
import {
  RealtimeServerSession,
  type RealtimeServerSessionLimits,
  type RealtimeServerSessionOptions,
} from "../src/session.ts";
import type { RealtimePeerGeneration } from "../src/engine.ts";
import {
  REMOTE_CANDIDATE_POLICY_DEFAULTS,
  RemoteCandidatePolicy,
} from "../src/remote-candidate-policy.ts";
import {
  TestPeerConnection as FakePeerConnection,
  testDataChannels as dataChannels,
  testRealtimeEngine,
} from "./support.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
} from "../src/resources.ts";

function procedure(signal: AbortSignal): ProcedureCtx {
  return Object.freeze({
    auth: ANONYMOUS_PRINCIPAL,
    abortSignal: signal,
    log: noopLogger,
    timestamp: 1,
    tx: async () => Ok(undefined),
    linkAccount: async () => {},
    unlinkAccount: async () => {},
  }) as ProcedureCtx;
}

const SESSION_LIMITS = Object.freeze({
  maxQueuedBytes: 32 * 1024 * 1024,
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
  options: Omit<
    RealtimeServerSessionOptions,
    "adapter" | "limits" | "remoteCandidates"
  > & {
    readonly adapter?: RealtimeServerSessionAdapter;
    readonly limits?: Partial<RealtimeServerSessionLimits>;
    readonly remoteCandidates?: RemoteCandidatePolicy;
  },
): Promise<RealtimeServerSession> {
  return RealtimeServerSession.create({
    ...options,
    remoteCandidates: options.remoteCandidates ?? new RemoteCandidatePolicy(
      REMOTE_CANDIDATE_POLICY_DEFAULTS,
    ),
    adapter: options.adapter ?? sessionAdapter(),
    limits: {
      ...SESSION_LIMITS,
      ...options.limits,
      maxQueuedBytes: options.limits?.maxQueuedBytes ??
        SESSION_LIMITS.maxQueuedBytes,
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
    const generation: RealtimePeerGeneration = {
      close: () => {},
      nativeQueueMetrics: () => ({ reservedBytes: 0, saturations: 0 }),
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
      generation,
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
    const generation: RealtimePeerGeneration = {
      close: () => {},
      nativeQueueMetrics: () => ({ reservedBytes: 0, saturations: 0 }),
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
      generation,
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
    const generation: RealtimePeerGeneration = {
      close: () => {},
      nativeQueueMetrics: () => ({ reservedBytes: 0, saturations: 0 }),
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
      generation,
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
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

  test("keeps the server impolite through a colliding offer and its candidates", async () => {
    const [clientChannel, serverChannel] = dataChannels();
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
      adapter: sessionAdapter((error) => failures.push(error)),
    });
    const client = new RealtimeDataPlane({
      channel: clientChannel as unknown as RTCDataChannel,
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });
    const candidate = {
      candidate: "candidate:1 1 UDP 1 8.8.8.8 9 typ host",
    };

    session.initialNegotiationComplete();
    peer.dispatchEvent(new Event("negotiationneeded"));
    await turns(8);
    expect(peer.signalingState).toBe("have-local-offer");

    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp: "v=0\r\nignored-client-offer" },
    });
    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_candidate",
      candidate,
    });
    await turns(8);
    expect(peer.remoteDescriptions).toEqual([]);
    expect(peer.candidates).toEqual([]);

    peer.signalingState = "stable";
    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp: "v=0\r\naccepted-client-offer" },
    });
    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_candidate",
      candidate,
    });
    await turns(8);
    expect(peer.remoteDescriptions).toEqual([{
      type: "offer",
      sdp: "v=0\r\naccepted-client-offer",
    }]);
    expect(peer.candidates).toEqual([candidate]);
    expect(failures).toEqual([]);

    session.close();
    client.close();
  });

  test("filters in-band host candidates and fails closed on a prohibited non-host destination", async () => {
    const [clientChannel, serverChannel] = dataChannels();
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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
      remoteCandidates: new RemoteCandidatePolicy({
        maxCandidates: 8,
        maxBytes: 8 * 1024,
        allowPrivateAddresses: false,
      }),
      adapter: sessionAdapter((error) => failures.push(error)),
    });
    const client = new RealtimeDataPlane({
      channel: clientChannel as unknown as RTCDataChannel,
      localPrefix: "c",
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      streamIdleMs: 30_000,
      onEvent: () => {},
      onIncomingStream: () => undefined,
      onSessionError: () => {},
      onSignal: () => {},
      onFatalError: (error) => failures.push(error),
    });

    session.initialNegotiationComplete();
    const accepted = {
      candidate: "candidate:1 1 UDP 1 8.8.8.8 9 typ host",
    };
    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_candidate",
      candidate: accepted,
    });
    await turns(8);
    expect(peer.candidates).toEqual([accepted]);

    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_candidate",
      candidate: {
        candidate: "candidate:1 1 UDP 1 browser-opaque-id.local 9 typ host",
      },
    });
    await turns(8);
    expect(peer.candidates).toEqual([accepted]);
    expect(peer.closed).toBe(false);

    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_description",
      description: {
        type: "offer",
        sdp: [
          "v=0",
          "a=candidate:1 1 UDP 1 192.168.1.2 9 typ host",
          "a=candidate:1 1 UDP 1 8.8.8.8 9 typ relay",
          "",
        ].join("\r\n"),
      },
    });
    await turns(8);

    expect(peer.candidates).toEqual([accepted]);
    expect(peer.remoteDescriptions).toEqual([{
      type: "offer",
      sdp: "v=0\r\na=candidate:1 1 UDP 1 8.8.8.8 9 typ relay\r\n",
    }]);
    expect(peer.closed).toBe(false);

    await client.sendSignal({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_candidate",
      candidate: {
        candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ srflx",
      },
    });
    await turns(8);

    expect(peer.closed).toBe(true);
    expect(failures).toMatchObject([{ code: "malformed" }]);

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
      generation: testRealtimeEngine(
        () => new FakePeerConnection() as unknown as RTCPeerConnection,
      ).createGeneration(SESSION_LIMITS.maxQueuedBytes),
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
