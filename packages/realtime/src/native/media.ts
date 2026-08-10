import type {
  PortableMediaStreamTrack,
} from "@ackerdb/core";
import type {
  RealtimeAudioFrame,
  RealtimeAudioSource,
  RealtimeAudioSourceOptions,
  RealtimeAudioStream,
  RealtimeAudioStreamOptions,
  RealtimeVideoFrame,
  RealtimeVideoSource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStream,
  RealtimeVideoStreamOptions,
} from "@ackerdb/server";
import type {
  NativeAudioSourceBinding,
  NativeAudioStreamBinding,
  NativeGenerationBudgetBinding,
  NativeRtcEngineBinding,
  NativeVideoSourceBinding,
  NativeVideoStreamBinding,
} from "./binding.ts";
import {
  NativeTrackOwner,
  type NativeTrackScope,
  type ServerMediaStreamTrack,
} from "./peer-connection.ts";

const decodedStreamDropReaders = new WeakMap<object, () => bigint>();

/** Package-internal native media pressure snapshot for runtime status. */
export function nativeDecodedStreamDrops(resource: object): number | undefined {
  const read = decodedStreamDropReaders.get(resource);
  return read === undefined ? undefined : Number(read());
}

class NativeReadableStream<Value> extends ReadableStream<Value> {
  private readonly closeNative: () => void;
  private closed = false;

  constructor(
    next: () => Promise<Value | null | undefined>,
    close: () => void,
    droppedFrames?: () => bigint,
  ) {
    let finish = close;
    super(
      {
        pull: async (controller) => {
          const value = await next();
          if (value == null) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        cancel: () => finish(),
      },
      { highWaterMark: 0 },
    );
    this.closeNative = close;
    finish = () => this.close();
    if (droppedFrames !== undefined) {
      decodedStreamDropReaders.set(this, droppedFrames);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeNative();
  }
}

class ServerAudioSource implements RealtimeAudioSource {
  readonly track: PortableMediaStreamTrack;

  constructor(
    private readonly native: NativeAudioSourceBinding,
    owner: NativeTrackOwner,
    private readonly scope: NativeTrackScope,
  ) {
    this.track = owner.wrapTrack(native.track, scope);
  }

  get sampleRate(): number {
    return this.native.sampleRate;
  }

  get channels(): number {
    return this.native.channels;
  }

  get queuedDuration(): number {
    return this.native.queuedDuration;
  }

  captureFrame(frame: RealtimeAudioFrame): Promise<void> {
    return this.native.captureFrame(
      frame.data,
      frame.sampleRate,
      frame.channels,
      frame.samplesPerChannel,
    );
  }

  clearQueue(): void {
    this.native.clearQueue();
  }

  waitForPlayout(): Promise<void> {
    return this.native.waitForPlayout();
  }

  close(): void {
    this.native.close();
    this.scope.close();
  }
}

class ServerVideoSource implements RealtimeVideoSource {
  readonly track: PortableMediaStreamTrack;
  private closed = false;

  constructor(
    private readonly native: NativeVideoSourceBinding,
    owner: NativeTrackOwner,
    private readonly scope: NativeTrackScope,
  ) {
    this.track = owner.wrapTrack(native.track, scope);
  }

  get width(): number {
    return this.native.width;
  }

  get height(): number {
    return this.native.height;
  }

  captureFrame(
    frame: RealtimeVideoFrame,
    options: {
      readonly timestampUs?: bigint;
      readonly rotation?: 0 | 90 | 180 | 270;
    } = {},
  ): void {
    if (frame.type !== "I420") {
      throw new TypeError(`unsupported video buffer type "${frame.type}"`);
    }
    this.native.captureFrame(
      frame.data,
      frame.width,
      frame.height,
      options.timestampUs ?? 0n,
      options.rotation ?? 0,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.native.close();
    this.scope.close();
  }
}

export class NativeMediaFactory {
  constructor(
    private readonly native: NativeRtcEngineBinding,
    private readonly generation: NativeGenerationBudgetBinding,
    private readonly owner: NativeTrackOwner,
  ) {}

  audioSource(options: RealtimeAudioSourceOptions = {}): RealtimeAudioSource {
    const native = this.native.createAudioSource({
      label: options.label,
      sampleRate: options.sampleRate,
      channels: options.channels,
      queueSizeMs: options.queueSizeMs,
      echoCancellation: options.echoCancellation,
      noiseSuppression: options.noiseSuppression,
      autoGainControl: options.autoGainControl,
    }, this.generation);
    const scope = this.owner.createScope();
    try {
      return new ServerAudioSource(native, this.owner, scope);
    } catch (error) {
      native.close();
      scope.close();
      throw error;
    }
  }

  audioStream(
    track: ServerMediaStreamTrack,
    options: RealtimeAudioStreamOptions = {},
  ): RealtimeAudioStream {
    const native: NativeAudioStreamBinding = this.native.createAudioStream(
      track.native,
      {
        sampleRate: options.sampleRate,
        channels: options.channels,
        queueSizeFrames: options.queueSizeFrames,
      },
      this.generation,
    );
    return new NativeReadableStream(
      () => native.nextFrame(),
      () => native.close(),
      () => native.droppedFrames,
    ) as RealtimeAudioStream;
  }

  videoSource(options: RealtimeVideoSourceOptions): RealtimeVideoSource {
    const native = this.native.createVideoSource({
      label: options.label,
      width: options.width,
      height: options.height,
      screencast: options.screencast,
    }, this.generation);
    const scope = this.owner.createScope();
    try {
      return new ServerVideoSource(native, this.owner, scope);
    } catch (error) {
      native.close();
      scope.close();
      throw error;
    }
  }

  videoStream(
    track: ServerMediaStreamTrack,
    options: RealtimeVideoStreamOptions = {},
  ): RealtimeVideoStream {
    const native: NativeVideoStreamBinding = this.native.createVideoStream(
      track.native,
      { queueSizeFrames: options.queueSizeFrames },
      this.generation,
    );
    return new NativeReadableStream(
      async () => {
        const event = await native.nextFrame();
        return event == null
          ? undefined
          : {
            frame: {
              data: event.data,
              width: event.width,
              height: event.height,
              type: "I420" as const,
            },
            timestampUs: event.timestampUs,
            rotation: event.rotation as 0 | 90 | 180 | 270,
          };
      },
      () => native.close(),
      () => native.droppedFrames,
    ) as RealtimeVideoStream;
  }
}
