import type {
  NativeRTCConfiguration,
  NativeRTCPeerConnection,
  PortableRTCPeerConnection,
} from "@ackerdb/core";
import type { RealtimeRuntimeModule } from "@ackerdb/server";
import type {
  RealtimeConfigurationSource,
  RealtimePeerEngine,
} from "../src/engine.ts";
import { REALTIME_HUB_DEFAULTS, RealtimeHub } from "../src/hub.ts";

export class TestDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "open";
  peer?: TestDataChannel;

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string" || data instanceof Blob) {
      throw new Error("expected binary realtime data");
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

export function testDataChannels(): readonly [
  TestDataChannel,
  TestDataChannel,
] {
  const client = new TestDataChannel();
  const server = new TestDataChannel();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

export class TestPeerConnection extends EventTarget {
  readonly channel = new TestDataChannel();
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly candidates: (RTCIceCandidateInit | null)[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  closed = false;
  offers = 0;
  stallRemoteDescription = false;
  onRemoteDescription: (() => void) | null = null;

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannel {
    if (
      label !== "ackerdb.typed.v1" ||
      options?.negotiated !== true ||
      options.id !== 0 ||
      options.ordered !== true
    ) {
      throw new Error("unexpected AckerDB realtime data channel contract");
    }
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offers++;
    return { type: "offer", sdp: `v=0\r\nserver-${this.offers}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nanswer" };
  }

  async setLocalDescription(
    value: RTCLocalSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-local-offer"
      : "stable";
  }

  async setRemoteDescription(
    value: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescriptions.push(value);
    if (this.stallRemoteDescription) await new Promise(() => {});
    this.remoteDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-remote-offer"
      : "stable";
    this.onRemoteDescription?.();
  }

  async addIceCandidate(
    value?: RTCIceCandidateInit | null,
  ): Promise<void> {
    this.candidates.push(value ?? null);
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map([
      ["transport", {
        id: "transport",
        type: "transport",
        timestamp: 1,
        selectedCandidatePairId: "pair",
      }],
      ["pair", {
        id: "pair",
        type: "candidate-pair",
        timestamp: 1,
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.02,
      }],
      ["local", {
        id: "local",
        type: "local-candidate",
        timestamp: 1,
        candidateType: "host",
        protocol: "udp",
        address: "10.0.0.1",
      }],
      ["remote", {
        id: "remote",
        type: "remote-candidate",
        timestamp: 1,
        candidateType: "srflx",
        protocol: "udp",
        address: "203.0.113.1",
      }],
      ["inbound-audio", {
        id: "inbound-audio",
        type: "inbound-rtp",
        timestamp: 1,
        kind: "audio",
        bytesReceived: 128,
        packetsReceived: 2,
        packetsLost: 1,
        jitter: 0.004,
      }],
      ["outbound-video", {
        id: "outbound-video",
        type: "outbound-rtp",
        timestamp: 1,
        kind: "video",
        bytesSent: 256,
        packetsSent: 3,
        framesEncoded: 1,
        framesDropped: 2,
      }],
    ]) as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function unused(): never {
  throw new Error("unexpected realtime media operation");
}

export function testRealtimeEngine(
  createPeerConnection: (
    configuration?: NativeRTCConfiguration,
  ) => NativeRTCPeerConnection,
): RealtimePeerEngine {
  return {
    close: () => {},
    createPeerConnection: (configuration) =>
      createPeerConnection(
        configuration as NativeRTCConfiguration,
      ) as unknown as PortableRTCPeerConnection,
    createAudioStream: unused,
    createAudioSource: unused,
    createVideoStream: unused,
    createVideoSource: unused,
  };
}

export function testRealtimeRuntime(
  engine: RealtimePeerEngine,
  options: {
    readonly configuration?: RealtimeConfigurationSource;
    readonly authorizationTimeoutMs?: number;
  } = {},
): RealtimeRuntimeModule {
  return {
    create: (host) =>
      new RealtimeHub({
        ...REALTIME_HUB_DEFAULTS,
        definition: host.definition,
        application: host.application,
        engine,
        configuration: options.configuration ?? (() => ({})),
        now: host.now,
        authorizationTimeoutMs: options.authorizationTimeoutMs,
      }),
  };
}
