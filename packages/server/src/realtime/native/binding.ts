import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface NativeIceServerBinding {
  readonly urls: string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface NativeRtcConfigurationBinding {
  readonly iceServers?: NativeIceServerBinding[];
  readonly iceTransportPolicy?: string;
  readonly minPort?: number;
  readonly maxPort?: number;
  readonly iceConnectionReceivingTimeoutMs?: number;
  readonly iceBackupCandidatePairPingIntervalMs?: number;
  readonly iceCheckIntervalStrongConnectivityMs?: number;
  readonly iceCheckIntervalWeakConnectivityMs?: number;
  readonly iceCheckMinIntervalMs?: number;
  readonly iceUnwritableTimeoutMs?: number;
  readonly iceInactiveTimeoutMs?: number;
  readonly stunCandidateKeepaliveIntervalMs?: number;
}

export interface NativeSessionDescriptionBinding {
  readonly type: string;
  readonly sdp: string;
}

export interface NativeIceCandidateBinding {
  readonly candidate: string;
  readonly sdpMid: string;
  readonly sdpMLineIndex: number;
}

export interface NativePeerEventBinding {
  readonly kind: string;
  readonly state?: string | null;
  readonly candidate?: NativeIceCandidateBinding | null;
  readonly handle?: number | null;
  readonly address?: string | null;
  readonly port?: number | null;
  readonly url?: string | null;
  readonly errorCode?: number | null;
  readonly errorText?: string | null;
}

export interface NativeDataChannelEventBinding {
  readonly kind: string;
  readonly state?: string | null;
  readonly data?: Uint8Array | null;
  readonly binary?: boolean | null;
}

export interface NativeMediaStreamTrackBinding {
  readonly identity: bigint;
  readonly id: string;
  readonly kind: string;
  enabled: boolean;
  readonly readyState: string;
  stop(): void;
}

export interface NativeMediaStreamBinding {
  readonly id: string;
  getAudioTracks(): NativeMediaStreamTrackBinding[];
  getVideoTracks(): NativeMediaStreamTrackBinding[];
}

export interface NativeRtpSenderBinding {
  readonly identity: bigint;
  readonly track?: NativeMediaStreamTrackBinding | null;
  replaceTrack(track?: NativeMediaStreamTrackBinding): void;
  getParameters(): NativeRtpParametersBinding;
  setParameters(parameters: NativeRtpParametersBinding): void;
  getStats(): Promise<string>;
}

export interface NativeRtpReceiverBinding {
  readonly identity: bigint;
  readonly track?: NativeMediaStreamTrackBinding | null;
  getParameters(): NativeRtpParametersBinding;
  getStats(): Promise<string>;
}

export interface NativeRtpEncodingParametersBinding {
  active?: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  priority?: string;
  readonly rid?: string;
  scaleResolutionDownBy?: number;
  scalabilityMode?: string;
  readonly ssrc?: number;
}

export interface NativeRtpCodecParametersBinding {
  readonly payloadType: number;
  readonly mimeType: string;
  readonly clockRate: number;
  readonly channels?: number;
}

export interface NativeRtpHeaderExtensionParametersBinding {
  readonly uri: string;
  readonly id: number;
  readonly encrypted?: boolean;
}

export interface NativeRtcpParametersBinding {
  readonly cname?: string;
  readonly reducedSize?: boolean;
}

export interface NativeRtpParametersBinding {
  readonly transactionId: string;
  readonly codecs: NativeRtpCodecParametersBinding[];
  readonly headerExtensions: NativeRtpHeaderExtensionParametersBinding[];
  readonly encodings: NativeRtpEncodingParametersBinding[];
  readonly rtcp: NativeRtcpParametersBinding;
  degradationPreference?: string;
}

export interface NativeRtpCodecCapabilityBinding {
  readonly mimeType: string;
  readonly clockRate: number;
  readonly channels?: number;
  readonly sdpFmtpLine?: string;
}

export interface NativeRtpHeaderExtensionCapabilityBinding {
  readonly uri: string;
}

export interface NativeRtpCapabilitiesBinding {
  readonly codecs: NativeRtpCodecCapabilityBinding[];
  readonly headerExtensions: NativeRtpHeaderExtensionCapabilityBinding[];
}

export interface NativeRtpTransceiverBinding {
  readonly identity: bigint;
  readonly mid?: string | null;
  direction: string;
  readonly currentDirection?: string | null;
  readonly sender: NativeRtpSenderBinding;
  readonly receiver: NativeRtpReceiverBinding;
  setCodecPreferences(codecs: NativeRtpCodecCapabilityBinding[]): void;
  stop(): void;
}

export interface NativeTrackEventBinding {
  readonly track: NativeMediaStreamTrackBinding;
  readonly receiver: NativeRtpReceiverBinding;
  readonly transceiver: NativeRtpTransceiverBinding;
  readonly streams: NativeMediaStreamBinding[];
}

export interface NativeDataChannelBinding {
  readonly droppedEvents: bigint;
  readonly id: number;
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  readonly ordered: boolean;
  readonly negotiated: boolean;
  readonly protocol: string;
  send(data: Uint8Array, binary: boolean): void;
  nextEvent(): Promise<NativeDataChannelEventBinding | null | undefined>;
  close(): void;
}

export interface NativePeerConnectionBinding {
  readonly droppedEvents: bigint;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly signalingState: string;
  readonly localDescription?: NativeSessionDescriptionBinding | null;
  readonly remoteDescription?: NativeSessionDescriptionBinding | null;
  readonly currentLocalDescription?: NativeSessionDescriptionBinding | null;
  readonly currentRemoteDescription?: NativeSessionDescriptionBinding | null;
  getConfiguration(): NativeRtcConfigurationBinding;
  setConfiguration(configuration: NativeRtcConfigurationBinding): void;
  createOffer(options?: {
    readonly iceRestart?: boolean;
    readonly offerToReceiveAudio?: boolean;
    readonly offerToReceiveVideo?: boolean;
  }): Promise<NativeSessionDescriptionBinding>;
  createAnswer(): Promise<NativeSessionDescriptionBinding>;
  setLocalDescription(description: NativeSessionDescriptionBinding): Promise<void>;
  setRemoteDescription(description: NativeSessionDescriptionBinding): Promise<void>;
  addIceCandidate(candidate?: NativeIceCandidateBinding): Promise<void>;
  createDataChannel(
    label: string,
    options?: {
      readonly ordered?: boolean;
      readonly maxPacketLifeTime?: number;
      readonly maxRetransmits?: number;
      readonly protocol?: string;
      readonly negotiated?: boolean;
      readonly id?: number;
    },
  ): NativeDataChannelBinding;
  addTrack(
    track: NativeMediaStreamTrackBinding,
    streamIds: string[],
  ): NativeRtpSenderBinding;
  removeTrack(sender: NativeRtpSenderBinding): void;
  addTransceiver(
    track: NativeMediaStreamTrackBinding,
    direction?: string,
    streamIds?: string[],
    sendEncodings?: NativeRtpEncodingParametersBinding[],
  ): NativeRtpTransceiverBinding;
  addTransceiverForKind(
    kind: string,
    direction?: string,
    streamIds?: string[],
    sendEncodings?: NativeRtpEncodingParametersBinding[],
  ): NativeRtpTransceiverBinding;
  getSenders(): NativeRtpSenderBinding[];
  getReceivers(): NativeRtpReceiverBinding[];
  getTransceivers(): NativeRtpTransceiverBinding[];
  getStats(): Promise<string>;
  restartIce(): void;
  nextEvent(): Promise<NativePeerEventBinding | null | undefined>;
  takeTrackEvent(handle: number): NativeTrackEventBinding;
  takeDataChannel(handle: number): NativeDataChannelBinding;
  close(): void;
}

export interface NativeAudioSourceBinding {
  readonly track: NativeMediaStreamTrackBinding;
  readonly sampleRate: number;
  readonly channels: number;
  readonly queuedDuration: number;
  captureFrame(
    data: Int16Array,
    sampleRate: number,
    channels: number,
    samplesPerChannel: number,
  ): Promise<void>;
  waitForPlayout(): Promise<void>;
  clearQueue(): void;
  close(): void;
}

export interface NativeAudioStreamBinding {
  nextFrame(): Promise<
    | {
      readonly data: Int16Array;
      readonly sampleRate: number;
      readonly channels: number;
      readonly samplesPerChannel: number;
    }
    | null
    | undefined
  >;
  close(): void;
}

export interface NativeVideoSourceBinding {
  readonly track: NativeMediaStreamTrackBinding;
  readonly width: number;
  readonly height: number;
  captureFrame(
    data: Uint8Array,
    width: number,
    height: number,
    timestampUs: bigint,
    rotation: number,
  ): void;
  close(): void;
}

export interface NativeVideoStreamBinding {
  nextFrame(): Promise<
    | {
      readonly data: Uint8Array;
      readonly width: number;
      readonly height: number;
      readonly timestampUs: bigint;
      readonly rotation: number;
    }
    | null
    | undefined
  >;
  close(): void;
}

export interface NativeRtcEngineBinding {
  close(): void;
  createPeerConnection(
    configuration?: NativeRtcConfigurationBinding,
  ): NativePeerConnectionBinding;
  createAudioSource(options?: object): NativeAudioSourceBinding;
  createAudioStream(
    track: NativeMediaStreamTrackBinding,
    options?: object,
  ): NativeAudioStreamBinding;
  createVideoSource(options: object): NativeVideoSourceBinding;
  createVideoStream(
    track: NativeMediaStreamTrackBinding,
    options?: object,
  ): NativeVideoStreamBinding;
  cloneTrack(track: NativeMediaStreamTrackBinding): NativeMediaStreamTrackBinding;
  getRtpSenderCapabilities(kind: string): NativeRtpCapabilitiesBinding;
  getRtpReceiverCapabilities(kind: string): NativeRtpCapabilitiesBinding;
}

interface NativeBinding {
  nativeAbiVersion(): number;
  readonly NativeRtcEngine: new (options?: {
    readonly ignoredInterfaces?: string[];
    readonly ignoredAdapterTypes?: string[];
  }) => NativeRtcEngineBinding;
}

let loaded: NativeBinding | undefined;

export function loadNativeBinding(): NativeBinding {
  if (loaded !== undefined) return loaded;
  const target = `${process.platform}-${process.arch}`;
  const url = new URL(
    `../../../native/webrtc/prebuilds/${target}/ackerdb_webrtc.node`,
    import.meta.url,
  );
  try {
    const binding = createRequire(import.meta.url)(
      fileURLToPath(url),
    ) as NativeBinding;
    if (binding.nativeAbiVersion() !== 6) {
      throw new Error("unsupported native WebRTC ABI");
    }
    loaded = binding;
    return binding;
  } catch (cause) {
    throw new Error(
      `AckerDB has no usable WebRTC engine for ${target}. ` +
        "Install a package containing that prebuild or, in a source checkout, " +
        "run `bun run build:webrtc`.",
      { cause },
    );
  }
}
