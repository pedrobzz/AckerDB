/**
 * `Portable*` is the server engine's W3C-shaped contract. `Native*` is the
 * client contract shared by browser and React Native declarations; it avoids
 * reading DOM globals, which are not available in a React Native program.
 */

export type NativeRTCDataChannelState =
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | (string & {});

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

export interface PortableMediaStream {
  readonly id: string;
  readonly active: boolean;
  addTrack(track: PortableMediaStreamTrack): void;
  getAudioTracks(): PortableMediaStreamTrack[];
  getTracks(): PortableMediaStreamTrack[];
  getVideoTracks(): PortableMediaStreamTrack[];
  removeTrack(track: PortableMediaStreamTrack): void;
}

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

export interface NativeMediaStreamTrack {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly muted: boolean;
  readonly readyState: string;
  enabled: boolean;
  clone(): NativeMediaStreamTrack;
  stop(): void;
}

export interface NativeMediaStream {
  readonly id: string;
  readonly active: boolean;
  addTrack(track: NativeMediaStreamTrack): void;
  getAudioTracks(): NativeMediaStreamTrack[];
  getTracks(): NativeMediaStreamTrack[];
  getVideoTracks(): NativeMediaStreamTrack[];
  removeTrack(track: NativeMediaStreamTrack): void;
}

export interface NativeRTCIceCandidate {
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
  toJSON(): NativeRTCIceCandidateInit;
}

export interface NativeRTCStats {
  readonly id?: string;
  readonly timestamp?: number;
  readonly type: string;
  readonly [property: string]: unknown;
}

/** Browser and supported React Native engines both return a Map-shaped report. */
export type NativeRTCStatsReport = ReadonlyMap<string, NativeRTCStats>;

export interface NativeRTCRtpParameters {
  readonly codecs?: readonly object[];
  readonly headerExtensions?: readonly object[];
  readonly rtcp?: object;
}

export interface NativeRTCRtpSendParameters extends NativeRTCRtpParameters {
  readonly encodings?: NativeRTCRtpEncodingParameters[];
  readonly transactionId?: string;
  degradationPreference?: string | null;
}

export type NativeRTCRtpReceiveParameters = NativeRTCRtpParameters;

export interface NativeRTCRtpEncodingParameters {
  active?: boolean;
  maxBitrate?: number | null;
  maxFramerate?: number | null;
  minBitrate?: number | null;
  priority?: string;
  readonly rid?: string | null;
  scaleResolutionDownBy?: number | null;
  scalabilityMode?: string;
  readonly ssrc?: number;
}

export interface NativeRTCRtpCodecCapability {
  readonly channels?: number;
  readonly clockRate?: number;
  readonly mimeType: string;
  readonly sdpFmtpLine?: string;
}

export type NativeRTCRtpTransceiverDirection =
  | "sendrecv"
  | "sendonly"
  | "recvonly"
  | "inactive"
  | "stopped"
  | (string & {});

export interface NativeRTCRtpSender {
  readonly track: NativeMediaStreamTrack | null;
  getParameters(): NativeRTCRtpSendParameters;
  getStats(): Promise<NativeRTCStatsReport>;
  replaceTrack(track: NativeMediaStreamTrack | null): Promise<void>;
  setParameters(parameters: NativeRTCRtpSendParameters): Promise<void>;
}

export interface NativeRTCRtpReceiver {
  readonly track: NativeMediaStreamTrack | null;
  getParameters(): NativeRTCRtpReceiveParameters;
  getStats(): Promise<NativeRTCStatsReport>;
}

export interface NativeRTCRtpTransceiver {
  readonly receiver: NativeRTCRtpReceiver;
  readonly sender: NativeRTCRtpSender;
  direction: NativeRTCRtpTransceiverDirection;
  readonly currentDirection?: NativeRTCRtpTransceiverDirection | null;
  readonly mid?: string | null;
  setCodecPreferences(codecs: readonly NativeRTCRtpCodecCapability[]): void;
  stop(): void;
}

export interface NativeRTCRtpTransceiverInit {
  readonly direction?: NativeRTCRtpTransceiverDirection;
  readonly streams?: NativeMediaStream[];
  readonly sendEncodings?: NativeRTCRtpEncodingParameters[];
}

export interface NativeRTCTrackEvent {
  readonly receiver: NativeRTCRtpReceiver | null;
  readonly streams: NativeMediaStream[];
  readonly track: NativeMediaStreamTrack | null;
  readonly transceiver: NativeRTCRtpTransceiver;
  readonly type: string;
}

export interface NativeRTCPeerConnectionIceEvent {
  readonly candidate: NativeRTCIceCandidate | null;
  readonly type: string;
}

/** The browser/RN event shape shared by AckerDB's client-facing peer API. */
export interface NativeRTCEvent {
  readonly type: string;
}

/**
 * Deliberately structural: supported native WebRTC packages implement these
 * methods but do not all publish equivalent EventTarget declarations.
 */
export interface NativeRTCEventTarget {
  addEventListener(
    type: string,
    listener: (event: NativeRTCEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: NativeRTCEvent) => unknown,
    options?: unknown,
  ): void;
}

export interface NativeRTCDataChannelMessageEvent extends NativeRTCEvent {
  readonly data: unknown;
}

/** Configuration AckerDB can safely pass to any supported client peer. */
export interface NativeRTCIceServer {
  credential?: string;
  urls: string | string[];
  username?: string;
}

export interface NativeRTCConfiguration {
  bundlePolicy?: "balanced" | "max-bundle" | "max-compat";
  iceCandidatePoolSize?: number;
  iceServers?: NativeRTCIceServer[];
  iceTransportPolicy?: "all" | "relay";
  rtcpMuxPolicy?: "require";
}

/** The client data-channel surface shared by browser and React Native. */
export interface NativeRTCDataChannel {
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
    listener: (event: NativeRTCDataChannelMessageEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: NativeRTCDataChannelMessageEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: string,
    listener: (event: NativeRTCEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: NativeRTCEvent) => unknown,
    options?: unknown,
  ): void;
}

export interface NativeRTCPeerConnection {
  readonly connectionState: NativeRTCPeerConnectionState;
  readonly iceGatheringState: "new" | "gathering" | "complete";
  readonly iceConnectionState: NativeRTCIceConnectionState;
  readonly localDescription: NativeRTCSessionDescriptionInit | null;
  readonly remoteDescription: NativeRTCSessionDescriptionInit | null;
  readonly signalingState: NativeRTCSignalingState;
  addIceCandidate(candidate: NativeRTCIceCandidateInit | null): Promise<void>;
  addTrack(
    track: NativeMediaStreamTrack,
    ...streams: NativeMediaStream[]
  ): NativeRTCRtpSender;
  addTransceiver(
    trackOrKind: NativeMediaStreamTrack | "audio" | "video",
    init?: NativeRTCRtpTransceiverInit,
  ): NativeRTCRtpTransceiver;
  close(): void;
  createAnswer(options?: unknown): Promise<NativeRTCSessionDescriptionInit>;
  createDataChannel(
    label: string,
    options?: NativeRTCDataChannelInit,
  ): NativeRTCDataChannel;
  createOffer(options?: unknown): Promise<NativeRTCSessionDescriptionInit>;
  getReceivers(): NativeRTCRtpReceiver[];
  getSenders(): NativeRTCRtpSender[];
  getStats(
    selector?: NativeMediaStreamTrack | null,
  ): Promise<NativeRTCStatsReport>;
  getTransceivers(): NativeRTCRtpTransceiver[];
  removeTrack(sender: NativeRTCRtpSender): void;
  restartIce(): void;
  setConfiguration(configuration?: NativeRTCConfiguration): void;
  setLocalDescription(
    description?: NativeRTCSessionDescriptionInit,
  ): Promise<void>;
  setRemoteDescription(
    description: NativeRTCSessionDescriptionInit,
  ): Promise<void>;
  addEventListener(
    type: "icecandidate",
    listener: (event: NativeRTCPeerConnectionIceEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: "track",
    listener: (event: NativeRTCTrackEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: "icecandidate",
    listener: (event: NativeRTCPeerConnectionIceEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: "track",
    listener: (event: NativeRTCTrackEvent) => unknown,
    options?: unknown,
  ): void;
  addEventListener(
    type: string,
    listener: (event: NativeRTCEvent) => unknown,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: NativeRTCEvent) => unknown,
    options?: unknown,
  ): void;
}
