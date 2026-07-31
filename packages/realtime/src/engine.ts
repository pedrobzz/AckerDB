import type {
  PortableMediaStreamTrack,
  PortableRTCConfiguration,
  PortableRTCPeerConnection,
} from "@ackerdb/core";
import type {
  Principal,
  RealtimeAudioSource,
  RealtimeAudioSourceOptions,
  RealtimeAudioStream,
  RealtimeAudioStreamOptions,
  RealtimeVideoSource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStream,
  RealtimeVideoStreamOptions,
} from "@ackerdb/server";

/**
 * Internal boundary implemented by AckerDB's bundled libwebrtc engine.
 * Keeping it structural makes the session and signaling state
 * machines independently testable without making engine selection public.
 */
export interface RealtimePeerEngine {
  close(): void;
  createGeneration(maxQueuedBytes: number): RealtimePeerGeneration;
  nativeQueueMetrics(): RealtimeNativeQueueMetrics;
}

/**
 * One bounded native WebRTC lifetime. A realtime session owns one generation,
 * so every peer and media object it creates shares the same byte admission
 * ceiling and is released together.
 */
export interface RealtimePeerGeneration {
  close(): void;
  nativeQueueMetrics(): RealtimeNativeQueueMetrics;
  createPeerConnection(
    configuration?: PortableRTCConfiguration,
    limits?: RealtimePeerLimits,
  ): PortableRTCPeerConnection;
  createAudioStream(
    track: PortableMediaStreamTrack,
    options?: RealtimeAudioStreamOptions,
  ): RealtimeAudioStream;
  createAudioSource(options?: RealtimeAudioSourceOptions): RealtimeAudioSource;
  createVideoStream(
    track: PortableMediaStreamTrack,
    options?: RealtimeVideoStreamOptions,
  ): RealtimeVideoStream;
  createVideoSource(options: RealtimeVideoSourceOptions): RealtimeVideoSource;
}

/** Fixed-cardinality observations from native queue-capacity admission. */
export interface RealtimeNativeQueueMetrics {
  /**
   * Bytes currently admitted against the native queue budget. This includes
   * retained event/send payloads and conservative media queue capacity; it is
   * not a count of currently queued decoded frames.
   */
  readonly reservedBytes: number;
  readonly saturations: number;
}

export interface RealtimePeerLimits {
  readonly maxDataChannels: number;
  readonly maxSenders: number;
  readonly maxTransceivers: number;
}

/** Deployment-owned ICE/TURN configuration, refreshed per peer generation. */
export type RealtimeConfigurationSource = (
  principal: Principal,
  signal: AbortSignal,
  owner: string,
) => PortableRTCConfiguration | Promise<PortableRTCConfiguration>;
