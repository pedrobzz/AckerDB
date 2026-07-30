import type { PortableMediaStreamTrack } from "@ackerdb/core";

export type RealtimeMediaStreamTrack = PortableMediaStreamTrack;

export interface RealtimeResource {
  close(): void;
}

/**
 * Interleaved signed 16-bit PCM, matching the frame shape used by native
 * WebRTC and the established LiveKit server SDKs.
 */
export interface RealtimeAudioFrame {
  readonly data: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerChannel: number;
}

export interface RealtimeAudioStreamOptions {
  /** Output sample rate. WebRTC's native rate is 48 kHz. */
  readonly sampleRate?: number;
  /** Output channel count. Defaults to mono. */
  readonly channels?: number;
  /**
   * Maximum decoded frames waiting for JavaScript. The default is 10
   * (roughly 100 ms); the oldest frame is dropped when the consumer is slow.
   */
  readonly queueSizeFrames?: number;
}

export interface RealtimeAudioStream
  extends ReadableStream<RealtimeAudioFrame>, RealtimeResource {}

export interface RealtimeAudioSourceOptions {
  readonly label?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  /** Maximum native playout queue in milliseconds. Defaults to 1 second. */
  readonly queueSizeMs?: number;
  readonly echoCancellation?: boolean;
  readonly noiseSuppression?: boolean;
  readonly autoGainControl?: boolean;
}

export interface RealtimeAudioSource extends RealtimeResource {
  readonly track: RealtimeMediaStreamTrack;
  readonly sampleRate: number;
  readonly channels: number;
  /**
   * Estimated seconds of audio still queued for native playout. This mirrors
   * the established LiveKit AudioSource contract.
   */
  readonly queuedDuration: number;
  captureFrame(frame: RealtimeAudioFrame): Promise<void>;
  /** Resolves when queued audio has played or clearQueue()/close() interrupts it. */
  waitForPlayout(): Promise<void>;
  clearQueue(): void;
}

export type RealtimeVideoBufferType = "I420";

/**
 * One tightly packed I420 frame: Y, U, then V planes. I420 is accepted by
 * libwebrtc directly and is the common interchange format in server SDKs.
 */
export interface RealtimeVideoFrame {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly type: RealtimeVideoBufferType;
}

export type RealtimeVideoRotation = 0 | 90 | 180 | 270;

export interface RealtimeVideoFrameEvent {
  readonly frame: RealtimeVideoFrame;
  readonly timestampUs: bigint;
  readonly rotation: RealtimeVideoRotation;
}

export interface RealtimeVideoStreamOptions {
  /**
   * Maximum decoded frames waiting for JavaScript. The default is one; the
   * oldest frame is dropped when the consumer is slow.
   */
  readonly queueSizeFrames?: number;
}

export interface RealtimeVideoStream
  extends ReadableStream<RealtimeVideoFrameEvent>, RealtimeResource {}

export interface RealtimeVideoSourceOptions {
  readonly label?: string;
  readonly width: number;
  readonly height: number;
  readonly screencast?: boolean;
}

export interface RealtimeVideoSource extends RealtimeResource {
  readonly track: RealtimeMediaStreamTrack;
  readonly width: number;
  readonly height: number;
  captureFrame(
    frame: RealtimeVideoFrame,
    options?: {
      readonly timestampUs?: bigint;
      readonly rotation?: RealtimeVideoRotation;
    },
  ): void;
}

export interface RealtimeMedia {
  audioStream(
    track: RealtimeMediaStreamTrack,
    options?: RealtimeAudioStreamOptions,
  ): RealtimeAudioStream;
  audioSource(options?: RealtimeAudioSourceOptions): RealtimeAudioSource;
  videoStream(
    track: RealtimeMediaStreamTrack,
    options?: RealtimeVideoStreamOptions,
  ): RealtimeVideoStream;
  videoSource(options: RealtimeVideoSourceOptions): RealtimeVideoSource;
}
