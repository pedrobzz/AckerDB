import { expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import type {
  NativeMediaStreamTrack,
  NativeRTCIceCandidateInit,
  NativeRTCPeerConnection,
  NativeRTCTrackEvent,
} from "@ackerdb/core";
import { createBundledRealtimeEngine } from "../../../src/native/engine.ts";
import { nativePeerPressure } from "../../../src/native/peer-connection.ts";
import { resolveRealtimeServerNetwork } from "../../../src/network.ts";
import {
  MAX_NATIVE_QUEUE_BYTES,
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
} from "../../../src/resources.ts";

const TIMEOUT_MS = 10_000;
const DEFAULT_GENERATION_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

function resolveLoopbackTestNetwork() {
  const loopback = Object.entries(networkInterfaces()).find(([, entries]) =>
    entries?.some((entry) => entry.internal),
  )?.[0];
  if (loopback === undefined) {
    throw new Error("the native peer test requires a loopback interface");
  }
  return resolveRealtimeServerNetwork({
    interfaces: { include: [loopback] },
    ignoreAdapterTypes: [],
  });
}

function waitFor(
  target: EventTarget,
  type: string,
  ready: () => boolean,
): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      target.removeEventListener(type, listener);
      reject(new Error(`timed out waiting for ${type}`));
    }, TIMEOUT_MS);
    const listener = () => {
      if (!ready()) return;
      clearTimeout(timeout);
      target.removeEventListener(type, listener);
      resolve();
    };
    target.addEventListener(type, listener);
  });
}

function nextTracks(
  peer: NativeRTCPeerConnection,
): Promise<ReadonlyMap<string, NativeMediaStreamTrack>> {
  return new Promise((resolve, reject) => {
    const tracks = new Map<string, NativeMediaStreamTrack>();
    const timeout = setTimeout(() => {
      peer.removeEventListener("track", listener);
      reject(
        new Error(
          `timed out waiting for remote media tracks; received ${
            [...tracks.keys()].join(", ") || "none"
          }; receivers ${peer
            .getReceivers()
            .map((receiver) => receiver.track?.kind ?? "none")
            .join(", ")}`,
        ),
      );
    }, TIMEOUT_MS);
    const listener = (event: NativeRTCTrackEvent) => {
      tracks.set(event.track.kind, event.track);
      if (tracks.size !== 2) return;
      clearTimeout(timeout);
      peer.removeEventListener("track", listener);
      resolve(tracks);
    };
    peer.addEventListener("track", listener);
  });
}

async function timeout<Value>(
  promise: Promise<Value>,
  operation: string,
): Promise<Value> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`timed out waiting for ${operation}`)),
        TIMEOUT_MS,
      );
    }),
  ]);
}

test("bundled libwebrtc exchanges data, PCM audio, and I420 video in Bun", async () => {
  const engine = createBundledRealtimeEngine(resolveLoopbackTestNetwork());
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  const sender = generation.createPeerConnection();
  const receiver = generation.createPeerConnection();
  const senderChannel = sender.createDataChannel("smoke", {
    negotiated: true,
    id: 0,
  });
  const receiverChannel = receiver.createDataChannel("smoke", {
    negotiated: true,
    id: 0,
  });
  const audioSource = generation.createAudioSource({
    sampleRate: 48_000,
    channels: 1,
  });
  const videoSource = generation.createVideoSource({ width: 16, height: 16 });
  let audio: ReturnType<typeof generation.createAudioStream> | undefined;
  let video: ReturnType<typeof generation.createVideoStream> | undefined;
  let interruptedAudio:
    | ReturnType<typeof generation.createAudioStream>
    | undefined;
  try {
    const audioSender = sender.addTrack(audioSource.track);
    const audioParameters = audioSender.getParameters();
    expect(audioParameters.transactionId.length).toBeGreaterThan(0);
    expect(audioParameters.encodings.length).toBe(1);
    audioParameters.encodings[0]!.maxBitrate = 96_000;
    await audioSender.setParameters(audioParameters);
    expect(audioSender.getParameters().encodings[0]?.maxBitrate).toBe(96_000);
    let invalidParameters: unknown;
    try {
      await audioSender.setParameters({
        ...audioSender.getParameters(),
        transactionId: "not-the-native-transaction",
      });
    } catch (error) {
      invalidParameters = error;
    }
    expect(invalidParameters).toBeInstanceOf(DOMException);
    expect((invalidParameters as DOMException).name).toBe(
      "InvalidModificationError",
    );
    const clonedAudio = audioSource.track.clone();
    expect(clonedAudio.id).not.toBe(audioSource.track.id);
    clonedAudio.enabled = false;
    expect(audioSource.track.enabled).toBe(true);
    clonedAudio.stop();
    expect(clonedAudio.readyState).toBe("ended");
    expect(audioSource.track.readyState).toBe("live");
    sender.addTrack(videoSource.track);
    expect(audioSender.track).toBe(audioSource.track);
    expect(sender.getSenders()[0]).toBe(audioSender);
    expect(sender.getSenders().map((candidate) => candidate.track)).toContain(
      audioSource.track,
    );
    const audioTransceiver = sender
      .getTransceivers()
      .find((candidate) => candidate.sender === audioSender);
    expect(audioTransceiver).toBeDefined();
    expect(audioTransceiver!.sender).toBe(audioSender);
    expect(
      sender
        .getTransceivers()
        .find((candidate) => candidate.mid === audioTransceiver!.mid),
    ).toBe(audioTransceiver!);
    const repeatedParameters = audioTransceiver!.sender.getParameters();
    repeatedParameters.encodings[0]!.active = true;
    await audioTransceiver!.sender.setParameters(repeatedParameters);
    const remoteTracks = nextTracks(receiver);

    const senderCandidates: NativeRTCIceCandidateInit[] = [];
    const receiverCandidates: NativeRTCIceCandidateInit[] = [];
    sender.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate !== null) senderCandidates.push(candidate.toJSON());
    });
    receiver.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate !== null) receiverCandidates.push(candidate.toJSON());
    });

    await sender.setLocalDescription(await sender.createOffer());
    expect(sender.localDescription?.sdp).toContain("m=audio");
    expect(sender.localDescription?.sdp).toContain("m=video");
    expect(sender.localDescription?.sdp).toMatch(/a=send(?:recv|only)/);
    await waitFor(
      sender,
      "icegatheringstatechange",
      () => (sender as RTCPeerConnection).iceGatheringState === "complete",
    );
    await receiver.setRemoteDescription(sender.localDescription!);
    for (const candidate of senderCandidates) {
      await receiver.addIceCandidate(candidate);
    }
    await receiver.setLocalDescription(await receiver.createAnswer());
    await waitFor(
      receiver,
      "icegatheringstatechange",
      () => (receiver as RTCPeerConnection).iceGatheringState === "complete",
    );
    await sender.setRemoteDescription(receiver.localDescription!);
    for (const candidate of receiverCandidates) {
      await sender.addIceCandidate(candidate);
    }
    await Promise.all([
      waitFor(
        sender,
        "connectionstatechange",
        () => sender.connectionState === "connected",
      ),
      waitFor(
        receiver,
        "connectionstatechange",
        () => receiver.connectionState === "connected",
      ),
      waitFor(senderChannel, "open", () => senderChannel.readyState === "open"),
      waitFor(
        receiverChannel,
        "open",
        () => receiverChannel.readyState === "open",
      ),
    ]);
    expect(["connected", "completed"]).toContain(sender.iceConnectionState);
    expect(["connected", "completed"]).toContain(receiver.iceConnectionState);
    expect(nativePeerPressure(sender)).toEqual({
      peerEventDrops: 0,
      dataChannelEventDrops: 0,
      terminalReasons: {
        "queue-limit": 0,
        "process-byte-budget": 0,
        "generation-byte-budget": 0,
      },
    });
    expect(
      audioSender
        .getParameters()
        .codecs.some((codec) => codec.mimeType.toLowerCase() === "audio/opus"),
    ).toBe(true);
    expect((await audioSender.getStats()).size).toBeGreaterThan(0);
    const audioReceiver = receiver
      .getReceivers()
      .find((candidate) => candidate.track.kind === "audio");
    expect(audioReceiver).toBeDefined();
    expect(
      audioReceiver!
        .getParameters()
        .codecs.some((codec) => codec.mimeType.toLowerCase() === "audio/opus"),
    ).toBe(true);

    const peerStats = await sender.getStats();
    expect(peerStats.size).toBeGreaterThan(0);
    expect(
      [...peerStats.values()].every(
        (stat) =>
          typeof stat.id === "string" &&
          typeof stat.type === "string" &&
          typeof stat.timestamp === "number",
      ),
    ).toBe(true);
    expect((await sender.getStats(audioSource.track)).size).toBeGreaterThan(0);

    const message = new Promise<ArrayBuffer>((resolve) => {
      receiverChannel.addEventListener(
        "message",
        (event) => {
          resolve((event as MessageEvent<ArrayBuffer>).data);
        },
        { once: true },
      );
    });
    senderChannel.send(new Uint8Array([1, 2, 3]));
    expect(
      new Uint8Array(await timeout(message, "data channel message")),
    ).toEqual(new Uint8Array([1, 2, 3]));

    await audioSource.captureFrame({
      data: new Int16Array(480),
      sampleRate: 48_000,
      channels: 1,
      samplesPerChannel: 480,
    });
    videoSource.captureFrame({
      data: new Uint8Array(16 * 16 + 8 * 8 * 2),
      width: 16,
      height: 16,
      type: "I420",
    });
    const tracks = await remoteTracks;
    audio = generation.createAudioStream(tracks.get("audio")!);
    video = generation.createVideoStream(tracks.get("video")!);
    const audioFrame = audio.getReader().read();
    const videoFrame = video.getReader().read();
    for (let index = 0; index < 10; index++) {
      const data = new Int16Array(480);
      data.fill(index % 2 === 0 ? 4_000 : -4_000);
      await audioSource.captureFrame({
        data,
        sampleRate: 48_000,
        channels: 1,
        samplesPerChannel: 480,
      });
    }
    videoSource.captureFrame({
      data: new Uint8Array(16 * 16 + 8 * 8 * 2),
      width: 16,
      height: 16,
      type: "I420",
    });

    const receivedAudio = await timeout(audioFrame, "decoded audio");
    expect(receivedAudio.done).toBe(false);
    expect(receivedAudio.value?.sampleRate).toBe(48_000);
    expect(receivedAudio.value?.channels).toBe(1);
    expect(receivedAudio.value?.data.length).toBeGreaterThan(0);
    expect((await audioReceiver!.getStats()).size).toBeGreaterThanOrEqual(0);
    const receivedVideo = await timeout(videoFrame, "decoded video");
    expect(receivedVideo.done).toBe(false);
    expect(receivedVideo.value?.frame).toMatchObject({
      width: 16,
      height: 16,
      type: "I420",
    });

    audio.close();
    video.close();
    interruptedAudio = generation.createAudioStream(tracks.get("audio")!);
    const interruptedReader = interruptedAudio.getReader();
    const interruptedRead = interruptedReader.read();
    interruptedAudio.close();
    let closedRead = await timeout(interruptedRead, "audio stream close");
    for (let index = 0; index < 10 && !closedRead.done; index++) {
      closedRead = await timeout(
        interruptedReader.read(),
        "closed audio stream",
      );
    }
    expect(closedRead.done).toBe(true);
    audioSource.track.stop();
    expect(audioSource.track.readyState).toBe("ended");
  } finally {
    interruptedAudio?.close();
    audio?.close();
    video?.close();
    audioSource.close();
    videoSource.close();
    senderChannel.close();
    receiverChannel.close();
    sender.close();
    receiver.close();
    generation.close();
    engine.close();
  }
}, 30_000);

test("a generation byte saturation does not poison another generation", () => {
  const engine = createBundledRealtimeEngine();
  const saturated = engine.createGeneration(1024 * 1024);
  const healthy = engine.createGeneration(DEFAULT_GENERATION_MAX_QUEUED_BYTES);
  let source: ReturnType<typeof saturated.createVideoSource> | undefined;
  let peer: ReturnType<typeof healthy.createPeerConnection> | undefined;
  try {
    source = saturated.createVideoSource({ width: 640, height: 480 });
    expect(() => saturated.createVideoStream(source!.track)).toThrow(
      "native WebRTC queue byte budget is saturated",
    );
    expect(saturated.nativeQueueMetrics().saturations).toBe(1);

    peer = healthy.createPeerConnection();
    expect(healthy.nativeQueueMetrics().saturations).toBe(0);
  } finally {
    peer?.close();
    source?.close();
    saturated.close();
    healthy.close();
    engine.close();
  }
});

test("the process byte budget spans native engine roots", () => {
  const resources = new RealtimeGlobalResourceBudget({
    ...REALTIME_GLOBAL_RESOURCE_DEFAULTS,
    maxQueuedBytes: 1024 * 1024,
  });
  const first = createBundledRealtimeEngine(undefined, resources);
  const second = createBundledRealtimeEngine(undefined, resources);
  const firstGeneration = first.createGeneration(1024 * 1024);
  const secondGeneration = second.createGeneration(1024 * 1024);
  let video: ReturnType<typeof firstGeneration.createVideoSource> | undefined;
  let audio: ReturnType<typeof secondGeneration.createAudioSource> | undefined;
  try {
    video = firstGeneration.createVideoSource({ width: 640, height: 480 });
    expect(() => secondGeneration.createAudioSource()).toThrow(
      "native WebRTC queue byte budget is saturated",
    );
    expect(first.nativeQueueMetrics().reservedBytes).toBeGreaterThan(0);
    expect(second.nativeQueueMetrics().saturations).toBe(1);

    video.close();
    video = undefined;
    audio = secondGeneration.createAudioSource();
    expect(second.nativeQueueMetrics().reservedBytes).toBeGreaterThan(0);
  } finally {
    audio?.close();
    video?.close();
    firstGeneration.close();
    secondGeneration.close();
    first.close();
    second.close();
  }
});

test("native audio sources reject the unbounded zero queue configuration", () => {
  const engine = createBundledRealtimeEngine();
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  try {
    expect(() =>
      generation.createAudioSource({
        sampleRate: 48_000,
        channels: 1,
        queueSizeMs: 0,
      }),
    ).toThrow("queueSizeMs must be a positive multiple of 10");
  } finally {
    generation.close();
    engine.close();
  }
});

test("queue byte limits reject values the native u32 boundary cannot represent", () => {
  expect(
    () =>
      new RealtimeGlobalResourceBudget({
        ...REALTIME_GLOBAL_RESOURCE_DEFAULTS,
        maxQueuedBytes: MAX_NATIVE_QUEUE_BYTES + 1,
      }),
  ).toThrow(
    `resourceLimits.maxQueuedBytes must not exceed ${MAX_NATIVE_QUEUE_BYTES}`,
  );

  const engine = createBundledRealtimeEngine();
  try {
    expect(() => engine.createGeneration(MAX_NATIVE_QUEUE_BYTES + 1)).toThrow(
      `maxQueuedBytes must not exceed ${MAX_NATIVE_QUEUE_BYTES}`,
    );
  } finally {
    engine.close();
  }
});

test("the root preserves native queue observations after its factory closes", () => {
  const engine = createBundledRealtimeEngine();
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  let source: ReturnType<typeof generation.createAudioSource> | undefined;
  try {
    source = generation.createAudioSource();
    const before = engine.nativeQueueMetrics();
    expect(before.reservedBytes).toBeGreaterThan(0);

    engine.close();
    expect(engine.nativeQueueMetrics()).toEqual(before);
  } finally {
    source?.close();
    generation.close();
    engine.close();
  }
});

test("native lifecycle releases wrapped resources and queue permits", async () => {
  const resources = new RealtimeGlobalResourceBudget(
    REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  );
  const engine = createBundledRealtimeEngine(
    resolveRealtimeServerNetwork(),
    resources,
  );
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  let peer: ReturnType<typeof generation.createPeerConnection> | undefined;
  let audioSource: ReturnType<typeof generation.createAudioSource> | undefined;
  let videoSource: ReturnType<typeof generation.createVideoSource> | undefined;
  let audioStream: ReturnType<typeof generation.createAudioStream> | undefined;
  let videoStream: ReturnType<typeof generation.createVideoStream> | undefined;
  try {
    peer = generation.createPeerConnection();
    audioSource = generation.createAudioSource();
    videoSource = generation.createVideoSource({ width: 640, height: 480 });
    audioStream = generation.createAudioStream(audioSource.track);
    videoStream = generation.createVideoStream(videoSource.track);

    expect(resources.snapshot().active.tracks).toBe(2);
    expect(generation.nativeQueueMetrics().reservedBytes).toBeGreaterThan(0);
    expect(engine.nativeQueueMetrics().reservedBytes).toBeGreaterThan(0);
  } finally {
    await audioStream?.cancel();
    await videoStream?.cancel();
    audioSource?.close();
    videoSource?.close();
    peer?.close();

    expect(resources.snapshot().active.tracks).toBe(0);
    expect(engine.nativeQueueMetrics().reservedBytes).toBe(0);
    generation.close();
    engine.close();
  }
});

test("native transceivers accept send encodings and mutable direction", () => {
  const engine = createBundledRealtimeEngine();
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  const peer = generation.createPeerConnection();
  const videoSource = generation.createVideoSource({ width: 16, height: 16 });
  const transceiver = peer.addTransceiver(videoSource.track, {
    direction: "sendonly",
    sendEncodings: [
      {
        active: true,
        maxBitrate: 128_000,
        maxFramerate: 30,
        rid: "primary",
        scaleResolutionDownBy: 1,
      },
    ],
  });

  expect(transceiver.direction).toBe("sendonly");
  transceiver.direction = "inactive";
  expect(transceiver.direction).toBe("inactive");
  const codecs = transceiver.sender.getCapabilities("video")?.codecs ?? [];
  expect(codecs.length).toBeGreaterThan(0);
  transceiver.setCodecPreferences(codecs);

  peer.close();
  videoSource.close();
  generation.close();
  engine.close();
});

test("native peers reject resource growth at their declared boundary", () => {
  const engine = createBundledRealtimeEngine();
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  const source = generation.createVideoSource({ width: 16, height: 16 });
  const peer = generation.createPeerConnection(
    {},
    {
      maxDataChannels: 1,
      maxSenders: 1,
      maxTransceivers: 1,
    },
  );

  peer.createDataChannel("one", { negotiated: true, id: 1 });
  expect(() =>
    peer.createDataChannel("two", { negotiated: true, id: 2 }),
  ).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
  peer.addTrack(source.track);
  expect(() => peer.addTrack(source.track)).toThrow(
    expect.objectContaining({ name: "QuotaExceededError" }),
  );

  const transceiverPeer = generation.createPeerConnection(
    {},
    {
      maxDataChannels: 1,
      maxSenders: 2,
      maxTransceivers: 1,
    },
  );
  transceiverPeer.addTransceiver("video");
  expect(() => transceiverPeer.addTransceiver("audio")).toThrow(
    expect.objectContaining({ name: "QuotaExceededError" }),
  );

  peer.close();
  transceiverPeer.close();
  source.close();
  generation.close();
  engine.close();
});

test("native track clones share one finite runtime budget and release it", () => {
  const resources = new RealtimeGlobalResourceBudget({
    ...REALTIME_GLOBAL_RESOURCE_DEFAULTS,
    maxTracks: 2,
  });
  const engine = createBundledRealtimeEngine(
    resolveRealtimeServerNetwork(),
    resources,
  );
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  const source = generation.createAudioSource();
  const clone = source.track.clone();

  expect(resources.snapshot().active.tracks).toBe(2);
  expect(() => source.track.clone()).toThrow(
    expect.objectContaining({ name: "QuotaExceededError" }),
  );
  expect(resources.snapshot().saturated.tracks).toBe(1);

  clone.stop();
  expect(resources.snapshot().active.tracks).toBe(1);
  source.close();
  expect(resources.snapshot().active.tracks).toBe(0);
  generation.close();
  engine.close();
});

test("native peers honor the deployment UDP range and advertised host mapping", async () => {
  const privateAddress = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
  if (privateAddress === undefined) return;

  const network = resolveRealtimeServerNetwork({
    udpPortRange: { min: 52_000, max: 52_100 },
    advertisedAddressMappings: [
      {
        privateAddress,
        publicAddress: "203.0.113.42",
      },
    ],
  });
  const engine = createBundledRealtimeEngine(network);
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  const peer = generation.createPeerConnection();
  try {
    const candidates: string[][] = [];
    peer.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate !== null) {
        candidates.push(candidate.candidate.split(" "));
      }
    });
    peer.createDataChannel("network", { negotiated: true, id: 0 });
    await peer.setLocalDescription(await peer.createOffer());
    await waitFor(
      peer,
      "icegatheringstatechange",
      () => peer.iceGatheringState === "complete",
    );

    const udpHostCandidates = candidates.filter(
      (fields) =>
        fields[2]?.toLowerCase() === "udp" &&
        fields[6]?.toLowerCase() === "typ" &&
        fields[7]?.toLowerCase() === "host",
    );
    expect(udpHostCandidates.length).toBeGreaterThan(0);
    expect(
      udpHostCandidates.every((fields) => {
        const port = Number(fields[5]);
        return port >= 52_000 && port <= 52_100;
      }),
    ).toBe(true);
    expect(
      udpHostCandidates.some((fields) => fields[4] === "203.0.113.42"),
    ).toBe(true);
    expect(candidates.some((fields) => fields[4] === privateAddress)).toBe(
      false,
    );
  } finally {
    peer.close();
    generation.close();
    engine.close();
  }
});

test("unsupported standard configuration fails explicitly", () => {
  const engine = createBundledRealtimeEngine();
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  expect(() =>
    generation.createPeerConnection({
      bundlePolicy: "max-bundle",
    }),
  ).toThrow(expect.objectContaining({ name: "NotSupportedError" }));
  expect(() =>
    generation.createPeerConnection({
      iceCandidatePoolSize: 1,
    }),
  ).toThrow(expect.objectContaining({ name: "NotSupportedError" }));
  generation.close();
  engine.close();
});

test("native audio playout is observable and interruption-safe", async () => {
  const engine = createBundledRealtimeEngine();
  const generation = engine.createGeneration(
    DEFAULT_GENERATION_MAX_QUEUED_BYTES,
  );
  const source = generation.createAudioSource({
    sampleRate: 48_000,
    channels: 1,
    queueSizeMs: 100,
  });
  const frame = {
    data: new Int16Array(4_800),
    sampleRate: 48_000,
    channels: 1,
    samplesPerChannel: 4_800,
  };

  expect(source.queuedDuration).toBe(0);
  await source.captureFrame(frame);
  expect(source.queuedDuration).toBeGreaterThan(0);
  await timeout(source.waitForPlayout(), "native audio playout");
  expect(source.queuedDuration).toBe(0);

  await expect(
    source.captureFrame({
      data: new Int16Array(479),
      sampleRate: 48_000,
      channels: 1,
      samplesPerChannel: 479,
    }),
  ).rejects.toThrow("audio must contain complete 10 ms frames");
  expect(source.queuedDuration).toBe(0);

  await source.captureFrame(frame);
  const interrupted = source.waitForPlayout();
  source.clearQueue();
  await timeout(interrupted, "interrupted native audio playout");
  expect(source.queuedDuration).toBe(0);
  await Bun.sleep(20);
  expect(source.queuedDuration).toBe(0);

  const longFrame = {
    ...frame,
    data: new Int16Array(9_600),
    samplesPerChannel: 9_600,
  };
  const pendingCapture = source.captureFrame(longFrame);
  await Bun.sleep(10);
  await expect(source.captureFrame(frame)).rejects.toThrow(
    "already has a capture in flight",
  );
  source.clearQueue();
  await timeout(pendingCapture, "capture interrupted at the native queue");
  await timeout(source.waitForPlayout(), "post-capture interruption");
  await Bun.sleep(20);
  expect(source.queuedDuration).toBe(0);

  const closingCapture = source.captureFrame(longFrame);
  await Bun.sleep(10);
  const closingWaiter = source.waitForPlayout();
  source.close();
  source.close();
  await timeout(closingCapture, "capture interrupted by close");
  await timeout(closingWaiter, "playout interrupted by close");
  expect(source.queuedDuration).toBe(0);
  await expect(source.captureFrame(frame)).rejects.toThrow(
    "audio source is closed",
  );
  generation.close();
  engine.close();
}, 10_000);
