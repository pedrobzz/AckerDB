import { expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import type {
  NativeMediaStreamTrack,
  NativeRTCIceCandidateInit,
  NativeRTCPeerConnection,
  NativeRTCTrackEvent,
} from "@ackerdb/core";
import { createBundledRealtimeEngine } from "../../../src/realtime/native/engine.ts";
import { nativePeerPressure } from "../../../src/realtime/native/peer-connection.ts";
import { resolveRealtimeServerNetwork } from "../../../src/realtime/network.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
} from "../../../src/realtime/resources.ts";

const TIMEOUT_MS = 10_000;

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
      reject(new Error(
        `timed out waiting for remote media tracks; received ${[
          ...tracks.keys(),
        ].join(", ") || "none"}; receivers ${
          peer.getReceivers().map((receiver) => receiver.track?.kind ?? "none").join(", ")
        }`,
      ));
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
  const engine = createBundledRealtimeEngine();
  const sender = engine.createPeerConnection();
  const receiver = engine.createPeerConnection();
  const senderChannel = sender.createDataChannel("smoke", {
    negotiated: true,
    id: 0,
  });
  const receiverChannel = receiver.createDataChannel("smoke", {
    negotiated: true,
    id: 0,
  });
  const audioSource = engine.createAudioSource({
    sampleRate: 48_000,
    channels: 1,
    queueSizeMs: 0,
  });
  const videoSource = engine.createVideoSource({ width: 16, height: 16 });
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
  const audioTransceiver = sender.getTransceivers().find(
    (candidate) => candidate.sender === audioSender,
  );
  expect(audioTransceiver).toBeDefined();
  expect(audioTransceiver!.sender).toBe(audioSender);
  expect(sender.getTransceivers().find(
    (candidate) => candidate.mid === audioTransceiver!.mid,
  )).toBe(audioTransceiver!);
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
    waitFor(receiverChannel, "open", () => receiverChannel.readyState === "open"),
  ]);
  expect(["connected", "completed"]).toContain(sender.iceConnectionState);
  expect(["connected", "completed"]).toContain(receiver.iceConnectionState);
  expect(nativePeerPressure(sender)).toEqual({
    peerEventDrops: 0,
    dataChannelEventDrops: 0,
  });
  expect(audioSender.getParameters().codecs.some(
    (codec) => codec.mimeType.toLowerCase() === "audio/opus",
  )).toBe(true);
  expect((await audioSender.getStats()).size).toBeGreaterThan(0);
  const audioReceiver = receiver.getReceivers().find(
    (candidate) => candidate.track.kind === "audio",
  );
  expect(audioReceiver).toBeDefined();
  expect(audioReceiver!.getParameters().codecs.some(
    (codec) => codec.mimeType.toLowerCase() === "audio/opus",
  )).toBe(true);

  const peerStats = await sender.getStats();
  expect(peerStats.size).toBeGreaterThan(0);
  expect([...peerStats.values()].every((stat) =>
    typeof stat.id === "string" &&
    typeof stat.type === "string" &&
    typeof stat.timestamp === "number"
  )).toBe(true);
  expect((await sender.getStats(audioSource.track)).size).toBeGreaterThan(0);

  const message = new Promise<ArrayBuffer>((resolve) => {
    receiverChannel.addEventListener("message", (event) => {
      resolve((event as MessageEvent<ArrayBuffer>).data);
    }, { once: true });
  });
  senderChannel.send(new Uint8Array([1, 2, 3]));
  expect(new Uint8Array(await timeout(message, "data channel message"))).toEqual(
    new Uint8Array([1, 2, 3]),
  );

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
  const audio = engine.createAudioStream(tracks.get("audio")!);
  const video = engine.createVideoStream(tracks.get("video")!);
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
  const interruptedAudio = engine.createAudioStream(tracks.get("audio")!);
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
  audioSource.close();
  videoSource.close();
  senderChannel.close();
  receiverChannel.close();
  sender.close();
  receiver.close();
}, 30_000);

test("native transceivers accept send encodings and mutable direction", () => {
  const engine = createBundledRealtimeEngine();
  const peer = engine.createPeerConnection();
  const videoSource = engine.createVideoSource({ width: 16, height: 16 });
  const transceiver = peer.addTransceiver(videoSource.track, {
    direction: "sendonly",
    sendEncodings: [{
      active: true,
      maxBitrate: 128_000,
      maxFramerate: 30,
      rid: "primary",
      scaleResolutionDownBy: 1,
    }],
  });

  expect(transceiver.direction).toBe("sendonly");
  transceiver.direction = "inactive";
  expect(transceiver.direction).toBe("inactive");
  const codecs = transceiver.sender.getCapabilities("video")?.codecs ?? [];
  expect(codecs.length).toBeGreaterThan(0);
  transceiver.setCodecPreferences(codecs);

  peer.close();
  videoSource.close();
});

test("native peers reject resource growth at their declared boundary", () => {
  const engine = createBundledRealtimeEngine();
  const source = engine.createVideoSource({ width: 16, height: 16 });
  const peer = engine.createPeerConnection({}, {
    maxDataChannels: 1,
    maxSenders: 1,
    maxTransceivers: 1,
  });

  peer.createDataChannel("one", { negotiated: true, id: 1 });
  expect(() =>
    peer.createDataChannel("two", { negotiated: true, id: 2 })
  ).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
  peer.addTrack(source.track);
  expect(() => peer.addTrack(source.track)).toThrow(
    expect.objectContaining({ name: "QuotaExceededError" }),
  );

  const transceiverPeer = engine.createPeerConnection({}, {
    maxDataChannels: 1,
    maxSenders: 2,
    maxTransceivers: 1,
  });
  transceiverPeer.addTransceiver("video");
  expect(() => transceiverPeer.addTransceiver("audio")).toThrow(
    expect.objectContaining({ name: "QuotaExceededError" }),
  );

  peer.close();
  transceiverPeer.close();
  source.close();
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
  const source = engine.createAudioSource();
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
});

test("native peers honor the deployment UDP range and advertised host mapping", async () => {
  const privateAddress = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal)
    ?.address;
  if (privateAddress === undefined) return;

  const network = resolveRealtimeServerNetwork({
    udpPortRange: { min: 52_000, max: 52_100 },
    advertisedAddressMappings: [{
      privateAddress,
      publicAddress: "203.0.113.42",
    }],
  });
  const engine = createBundledRealtimeEngine(network);
  const peer = engine.createPeerConnection();
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
  expect(udpHostCandidates.every((fields) => {
    const port = Number(fields[5]);
    return port >= 52_000 && port <= 52_100;
  })).toBe(true);
  expect(udpHostCandidates.some((fields) => fields[4] === "203.0.113.42"))
    .toBe(true);
  expect(candidates.some((fields) => fields[4] === privateAddress)).toBe(false);

  peer.close();
});

test("unsupported standard configuration fails explicitly", () => {
  const engine = createBundledRealtimeEngine();
  expect(() =>
    engine.createPeerConnection({
      bundlePolicy: "max-bundle",
    })
  ).toThrow(expect.objectContaining({ name: "NotSupportedError" }));
  expect(() =>
    engine.createPeerConnection({
      iceCandidatePoolSize: 1,
    })
  ).toThrow(expect.objectContaining({ name: "NotSupportedError" }));
});

test("native audio playout is observable and interruption-safe", async () => {
  const engine = createBundledRealtimeEngine();
  const source = engine.createAudioSource({
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

  await source.captureFrame(frame);
  const interrupted = source.waitForPlayout();
  source.clearQueue();
  await timeout(interrupted, "interrupted native audio playout");
  expect(source.queuedDuration).toBe(0);

  const longFrame = {
    ...frame,
    data: new Int16Array(9_600),
    samplesPerChannel: 9_600,
  };
  const pendingCapture = source.captureFrame(longFrame);
  await Bun.sleep(10);
  await expect(source.captureFrame(frame)).rejects.toThrow(
    "already has a captureFrame() call in flight",
  );
  source.clearQueue();
  await timeout(pendingCapture, "capture interrupted at the native queue");
  await timeout(source.waitForPlayout(), "post-capture interruption");
  expect(source.queuedDuration).toBe(0);

  source.close();
}, 10_000);
