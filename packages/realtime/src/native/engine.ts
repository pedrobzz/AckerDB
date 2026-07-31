import type {
  PortableMediaStreamTrack,
  PortableRTCConfiguration,
  PortableRTCPeerConnection,
} from "@ackerdb/core";
import type {
  RealtimePeerEngine,
  RealtimePeerGeneration,
  RealtimeNativeQueueMetrics,
  RealtimePeerLimits,
} from "../engine.ts";
import type {
  RealtimeAudioSource,
  RealtimeAudioSourceOptions,
  RealtimeAudioStream,
  RealtimeAudioStreamOptions,
  RealtimeVideoSource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStream,
  RealtimeVideoStreamOptions,
} from "@ackerdb/server";
import {
  resolveRealtimeServerNetwork,
  type ResolvedRealtimeServerNetwork,
} from "../network.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
  nativeQueueBytes,
} from "../resources.ts";
import {
  loadNativeBinding,
  type NativeGenerationBudgetBinding,
  type NativeRtcEngineBinding,
} from "./binding.ts";
import { NativeMediaFactory } from "./media.ts";
import {
  createServerPeerConnection,
  NativeTrackOwner,
  normalizeConfiguration,
  ServerMediaStreamTrack,
} from "./peer-connection.ts";

class BundledRealtimeEngine implements RealtimePeerEngine {
  private readonly native: NativeRtcEngineBinding;
  private readonly owner;
  private closed = false;
  private lastNativeQueueMetrics: RealtimeNativeQueueMetrics = nativeQueueMetrics(
    0n,
    0n,
  );

  constructor(
    private readonly network: ResolvedRealtimeServerNetwork,
    resources: RealtimeGlobalResourceBudget,
  ) {
    this.native = new (loadNativeBinding().NativeRtcEngine)({
      ignoredInterfaces: [...network.ignoredInterfaces],
      ignoredAdapterTypes: [...network.ignoredAdapterTypes],
      maxQueuedBytes: resources.limits.maxQueuedBytes,
    });
    this.owner = new NativeTrackOwner(this.native, resources);
  }

  close(): void {
    if (this.closed) return;
    this.lastNativeQueueMetrics = this.readNativeQueueMetrics();
    this.closed = true;
    this.native.close();
  }

  nativeQueueMetrics(): RealtimeNativeQueueMetrics {
    if (!this.closed) this.lastNativeQueueMetrics = this.readNativeQueueMetrics();
    return this.lastNativeQueueMetrics;
  }

  createGeneration(maxQueuedBytes: number): RealtimePeerGeneration {
    return new BundledRealtimeGeneration(
      this.native,
      this.native.createGenerationBudget(
        nativeQueueBytes(maxQueuedBytes, "maxQueuedBytes"),
      ),
      this.owner,
      this.network,
    );
  }

  private readNativeQueueMetrics(): RealtimeNativeQueueMetrics {
    return nativeQueueMetrics(
      this.native.reservedBytes,
      this.native.queueSaturations,
    );
  }
}

class BundledRealtimeGeneration implements RealtimePeerGeneration {
  private readonly media: NativeMediaFactory;

  constructor(
    private readonly native: NativeRtcEngineBinding,
    private readonly budget: NativeGenerationBudgetBinding,
    private readonly owner: NativeTrackOwner,
    private readonly network: ResolvedRealtimeServerNetwork,
  ) {
    this.media = new NativeMediaFactory(native, budget, owner);
  }

  close(): void {
    this.budget.close();
  }

  nativeQueueMetrics(): RealtimeNativeQueueMetrics {
    return nativeQueueMetrics(
      this.budget.reservedBytes,
      this.budget.saturations,
    );
  }

  createPeerConnection(
    configuration: PortableRTCConfiguration = {},
    limits: RealtimePeerLimits = {
      maxDataChannels: 16,
      maxSenders: 32,
      maxTransceivers: 32,
    },
  ): PortableRTCPeerConnection {
    return createServerPeerConnection(
      this.native.createPeerConnection(normalizeConfiguration(
        configuration,
        this.network.nativeConfiguration,
      ), this.budget),
      this.owner,
      limits,
      this.network.addressMappings,
      this.network.nativeConfiguration,
    );
  }

  createAudioStream(
    track: PortableMediaStreamTrack,
    options?: RealtimeAudioStreamOptions,
  ): RealtimeAudioStream {
    return this.media.audioStream(this.track(track), options);
  }

  createAudioSource(
    options?: RealtimeAudioSourceOptions,
  ): RealtimeAudioSource {
    return this.media.audioSource(options);
  }

  createVideoStream(
    track: PortableMediaStreamTrack,
    options?: RealtimeVideoStreamOptions,
  ): RealtimeVideoStream {
    return this.media.videoStream(this.track(track), options);
  }

  createVideoSource(
    options: RealtimeVideoSourceOptions,
  ): RealtimeVideoSource {
    return this.media.videoSource(options);
  }

  private track(track: PortableMediaStreamTrack): ServerMediaStreamTrack {
    if (!(track instanceof ServerMediaStreamTrack)) {
      throw new TypeError("track belongs to a different WebRTC engine");
    }
    if (!track.belongsTo(this.owner)) {
      throw new TypeError("track belongs to a different WebRTC engine");
    }
    return track;
  }
}

export function createBundledRealtimeEngine(
  network: ResolvedRealtimeServerNetwork = resolveRealtimeServerNetwork(),
  resources = new RealtimeGlobalResourceBudget(
    REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  ),
): RealtimePeerEngine {
  return new BundledRealtimeEngine(network, resources);
}

function nativeQueueMetrics(reservedBytes: bigint, saturations: bigint) {
  return Object.freeze({
    reservedBytes: boundedBigInt(reservedBytes),
    saturations: boundedBigInt(saturations),
  });
}

function boundedBigInt(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(Number.MAX_SAFE_INTEGER)
    : value);
}
