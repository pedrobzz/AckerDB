import type { Principal } from "../auth/credentials.ts";
import type {
  PortableMediaStreamTrack,
  PortableRTCConfiguration,
  PortableRTCPeerConnection,
} from "@ackerdb/core";
import type {
  RealtimeAudioSource,
  RealtimeAudioSourceOptions,
  RealtimeAudioStream,
  RealtimeAudioStreamOptions,
  RealtimeVideoSource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStream,
  RealtimeVideoStreamOptions,
} from "./media.ts";

/**
 * Internal boundary implemented by AckerDB's bundled LiveKit-libwebrtc
 * engine. Keeping it structural makes the session and signaling state
 * machines independently testable without making engine selection public.
 */
export interface RealtimePeerEngine {
  close(): void;
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

export interface RealtimePeerLimits {
  readonly maxDataChannels: number;
  readonly maxSenders: number;
  readonly maxTransceivers: number;
}

/** Deployment-owned ICE/TURN configuration, refreshed per peer generation. */
export type RealtimeConfigurationSource = (
  principal: Principal,
  signal: AbortSignal,
) => PortableRTCConfiguration | Promise<PortableRTCConfiguration>;
