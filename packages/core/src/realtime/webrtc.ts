type GlobalValue<Name extends PropertyKey> =
  typeof globalThis extends Record<Name, infer Value> ? Value : never;

type GlobalPrototype<Name extends PropertyKey, Fallback> =
  [GlobalValue<Name>] extends [never]
    ? Fallback
    : GlobalValue<Name> extends { readonly prototype: infer Prototype }
      ? Prototype
      : Fallback;

type PeerConnectionConfiguration<Fallback> =
  [GlobalValue<"RTCPeerConnection">] extends [never]
    ? Fallback
    : GlobalValue<"RTCPeerConnection"> extends {
          new(configuration?: infer Configuration): unknown;
        }
      ? Configuration
      : Fallback;

export type NativeRTCDataChannelState =
  | "connecting"
  | "open"
  | "closing"
  | "closed";

export type NativeRTCPeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type NativeRTCSignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "have-local-pranswer"
  | "have-remote-pranswer"
  | "closed";

export type NativeRTCIceConnectionState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed";

export type NativeRTCSdpType =
  | "answer"
  | "offer"
  | "pranswer"
  | "rollback";

export interface NativeRTCSessionDescriptionInit {
  readonly type: NativeRTCSdpType;
  readonly sdp?: string;
}

export interface NativeRTCIceCandidateInit {
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
}

export interface PortableRTCIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
  toJSON(): NativeRTCIceCandidateInit;
}

export type NativeRTCIceCandidate = GlobalPrototype<
  "RTCIceCandidate",
  PortableRTCIceCandidate
>;

export interface PortableMediaStreamTrack {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly muted: boolean;
  readonly readyState: "live" | "ended";
  enabled: boolean;
  clone(): PortableMediaStreamTrack;
  stop(): void;
}

export type NativeMediaStreamTrack = GlobalPrototype<
  "MediaStreamTrack",
  PortableMediaStreamTrack
>;

export interface PortableMediaStream {
  readonly id: string;
  readonly active: boolean;
  addTrack(track: PortableMediaStreamTrack): void;
  getAudioTracks(): PortableMediaStreamTrack[];
  getTracks(): PortableMediaStreamTrack[];
  getVideoTracks(): PortableMediaStreamTrack[];
  removeTrack(track: PortableMediaStreamTrack): void;
}

export type NativeMediaStream = GlobalPrototype<
  "MediaStream",
  PortableMediaStream
>;

export interface PortableRTCRtpSender {
  readonly track: PortableMediaStreamTrack | null;
  getCapabilities(kind: "audio" | "video"): PortableRTCRtpCapabilities | null;
  getParameters(): PortableRTCRtpSendParameters;
  getStats(): Promise<PortableRTCStatsReport>;
  replaceTrack(track: PortableMediaStreamTrack | null): Promise<void>;
  setParameters(parameters: PortableRTCRtpSendParameters): Promise<void>;
}

export interface PortableRTCRtpReceiver {
  readonly track: PortableMediaStreamTrack;
  getCapabilities(kind: "audio" | "video"): PortableRTCRtpCapabilities | null;
  getParameters(): PortableRTCRtpReceiveParameters;
  getStats(): Promise<PortableRTCStatsReport>;
}

export type PortableRTCRtpTransceiverDirection =
  | "sendrecv"
  | "sendonly"
  | "recvonly"
  | "inactive"
  | "stopped";

export interface PortableRTCRtpTransceiver {
  readonly receiver: PortableRTCRtpReceiver;
  readonly sender: PortableRTCRtpSender;
  direction: PortableRTCRtpTransceiverDirection;
  readonly currentDirection?: PortableRTCRtpTransceiverDirection | null;
  readonly mid?: string | null;
  setCodecPreferences(codecs: readonly PortableRTCRtpCodecCapability[]): void;
  stop(): void;
}

export type NativeRTCRtpSender = GlobalPrototype<
  "RTCRtpSender",
  PortableRTCRtpSender
>;

export type NativeRTCRtpReceiver = GlobalPrototype<
  "RTCRtpReceiver",
  PortableRTCRtpReceiver
>;

export type NativeRTCRtpTransceiver = GlobalPrototype<
  "RTCRtpTransceiver",
  PortableRTCRtpTransceiver
>;

export type PortableRTCPriorityType =
  | "very-low"
  | "low"
  | "medium"
  | "high";

export interface PortableRTCRtpEncodingParameters {
  active?: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  priority?: PortableRTCPriorityType;
  readonly rid?: string;
  scaleResolutionDownBy?: number;
  scalabilityMode?: string;
  readonly ssrc?: number;
}

export interface PortableRTCRtpCodecParameters {
  readonly channels?: number;
  readonly clockRate: number;
  readonly mimeType: string;
  readonly payloadType: number;
}

export interface PortableRTCRtpHeaderExtensionParameters {
  readonly encrypted?: boolean;
  readonly id: number;
  readonly uri: string;
}

export interface PortableRTCRtcpParameters {
  readonly cname?: string;
  readonly reducedSize?: boolean;
}

export type PortableRTCDegradationPreference =
  | "balanced"
  | "maintain-framerate"
  | "maintain-resolution";

export interface PortableRTCRtpParameters {
  readonly codecs: readonly PortableRTCRtpCodecParameters[];
  readonly encodings: PortableRTCRtpEncodingParameters[];
  readonly headerExtensions: readonly PortableRTCRtpHeaderExtensionParameters[];
  readonly rtcp: PortableRTCRtcpParameters;
  readonly transactionId: string;
}

export interface PortableRTCRtpSendParameters extends PortableRTCRtpParameters {
  degradationPreference?: PortableRTCDegradationPreference;
}

export type PortableRTCRtpReceiveParameters = PortableRTCRtpParameters;

export interface PortableRTCRtpCodecCapability {
  readonly channels?: number;
  readonly clockRate: number;
  readonly mimeType: string;
  readonly sdpFmtpLine?: string;
}

export interface PortableRTCRtpHeaderExtensionCapability {
  readonly uri: string;
}

export interface PortableRTCRtpCapabilities {
  readonly codecs: readonly PortableRTCRtpCodecCapability[];
  readonly headerExtensions: readonly PortableRTCRtpHeaderExtensionCapability[];
}

export interface PortableRTCRtpTransceiverInit {
  readonly direction?: PortableRTCRtpTransceiverDirection;
  readonly streams?: readonly PortableMediaStream[];
  readonly sendEncodings?: readonly PortableRTCRtpEncodingParameters[];
}

export interface PortableRTCStats {
  readonly id: string;
  readonly timestamp: number;
  readonly type: string;
  readonly [property: string]: unknown;
}

export type PortableRTCStatsReport = ReadonlyMap<string, PortableRTCStats>;

export interface PortableRTCTrackEvent {
  readonly receiver: PortableRTCRtpReceiver;
  readonly streams: readonly PortableMediaStream[];
  readonly track: PortableMediaStreamTrack;
  readonly transceiver: PortableRTCRtpTransceiver;
}

export type NativeRTCTrackEvent = GlobalPrototype<
  "RTCTrackEvent",
  PortableRTCTrackEvent
>;

export interface NativeRTCPeerConnectionIceEvent {
  readonly candidate: NativeRTCIceCandidate | null;
}

export interface PortableRTCPeerConnectionIceEvent {
  readonly candidate: PortableRTCIceCandidate | null;
}

export interface PortableRTCPeerConnectionIceErrorEvent {
  readonly address: string | null;
  readonly errorCode: number;
  readonly errorText: string;
  readonly port: number | null;
  readonly url: string;
}

export interface NativeRTCDataChannelInit {
  readonly id?: number;
  readonly maxPacketLifeTime?: number;
  readonly maxRetransmits?: number;
  readonly negotiated?: boolean;
  readonly ordered?: boolean;
  readonly protocol?: string;
}

export interface PortableRTCDataChannel {
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly id: number | null;
  readonly label: string;
  readonly negotiated: boolean;
  readonly ordered: boolean;
  readonly protocol: string;
  readonly readyState: NativeRTCDataChannelState;
  close(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void;
}

export type NativeRTCDataChannel = GlobalPrototype<
  "RTCDataChannel",
  PortableRTCDataChannel
>;

export interface PortableRTCIceServer {
  readonly credential?: string;
  readonly credentialType?: "password";
  readonly urls: string | readonly string[];
  readonly username?: string;
}

export interface PortableRTCConfiguration {
  readonly bundlePolicy?: "balanced" | "max-bundle" | "max-compat";
  readonly certificates?: readonly unknown[];
  readonly iceCandidatePoolSize?: number;
  readonly iceServers?: readonly PortableRTCIceServer[];
  readonly iceTransportPolicy?: "all" | "relay";
  readonly rtcpMuxPolicy?: "require";
}

export type NativeRTCConfiguration = PeerConnectionConfiguration<
  PortableRTCConfiguration
>;

export interface PortableRTCPeerConnection {
  readonly connectionState: NativeRTCPeerConnectionState;
  readonly currentLocalDescription: NativeRTCSessionDescriptionInit | null;
  readonly currentRemoteDescription: NativeRTCSessionDescriptionInit | null;
  readonly iceGatheringState: "new" | "gathering" | "complete";
  readonly iceConnectionState: NativeRTCIceConnectionState;
  readonly localDescription: NativeRTCSessionDescriptionInit | null;
  readonly remoteDescription: NativeRTCSessionDescriptionInit | null;
  readonly signalingState: NativeRTCSignalingState;
  addIceCandidate(candidate?: NativeRTCIceCandidateInit | null): Promise<void>;
  addTrack(
    track: PortableMediaStreamTrack,
    ...streams: readonly PortableMediaStream[]
  ): PortableRTCRtpSender;
  addTransceiver(
    trackOrKind: PortableMediaStreamTrack | "audio" | "video",
    init?: PortableRTCRtpTransceiverInit,
  ): PortableRTCRtpTransceiver;
  close(): void;
  createAnswer(options?: unknown): Promise<NativeRTCSessionDescriptionInit>;
  createDataChannel(
    label: string,
    options?: NativeRTCDataChannelInit,
  ): PortableRTCDataChannel;
  createOffer(options?: unknown): Promise<NativeRTCSessionDescriptionInit>;
  getConfiguration(): PortableRTCConfiguration;
  getReceivers(): PortableRTCRtpReceiver[];
  getSenders(): PortableRTCRtpSender[];
  getStats(
    selector?: PortableMediaStreamTrack | null,
  ): Promise<PortableRTCStatsReport>;
  getTransceivers(): PortableRTCRtpTransceiver[];
  removeTrack(sender: PortableRTCRtpSender): void;
  restartIce(): void;
  setConfiguration(configuration?: PortableRTCConfiguration): void;
  setLocalDescription(
    description?: NativeRTCSessionDescriptionInit,
  ): Promise<void>;
  setRemoteDescription(
    description: NativeRTCSessionDescriptionInit,
  ): Promise<void>;
  addEventListener(
    type: "icecandidate",
    listener: (event: PortableRTCPeerConnectionIceEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: "icecandidateerror",
    listener: (event: PortableRTCPeerConnectionIceErrorEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: "track",
    listener: (event: PortableRTCTrackEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void;
}

/**
 * The platform's actual W3C peer object when WebRTC globals are available.
 * The fallback is structural typing for server and bare-native programs; it
 * never creates, wraps, or substitutes a runtime peer.
 */
export type NativeRTCPeerConnection = GlobalPrototype<
  "RTCPeerConnection",
  PortableRTCPeerConnection
>;
